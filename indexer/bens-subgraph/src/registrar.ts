import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import { NameRegistered, NameRenewed, Transfer } from "../generated/BaseRegistrar/BaseRegistrar";
import { NameTransferred, Registration } from "../generated/schema";
import { ZERO_ADDRESS, domain, nodeFromLabelhash, account } from "./helpers";

function idToLabelhash(id: BigInt): Bytes {
  const bytes = Bytes.fromUint8Array(id); bytes.reverse();
  const padded = new Uint8Array(32); const offset = 32 - bytes.length;
  for (let i = 0; i < bytes.length; i++) padded[offset + i] = bytes[i];
  return Bytes.fromUint8Array(padded);
}

export function handleRegistrarTransfer(event: Transfer): void {
  const labelhash = idToLabelhash(event.params.tokenId);
  const target = domain(nodeFromLabelhash(labelhash), event.block.timestamp);
  target.labelhash = labelhash; target.tokenId = event.params.tokenId;
  const newOwner = account(event.params.to);
  if (event.params.to.equals(ZERO_ADDRESS)) target.unset("registrant");
  else target.registrant = newOwner.id;
  target.save();
  const registration = Registration.load(target.id);
  if (registration != null) {
    registration.registrant = newOwner.id;
    registration.save();
    const record = new NameTransferred(event.transaction.hash.toHexString() + "-" + event.logIndex.toString());
    record.registration = registration.id;
    record.newOwner = newOwner.id;
    record.blockNumber = event.block.number.toI32();
    record.transactionID = event.transaction.hash;
    record.save();
  }
}
export function handleBaseNameRegistered(event: NameRegistered): void {
  const labelhash = idToLabelhash(event.params.id);
  const target = domain(nodeFromLabelhash(labelhash), event.block.timestamp);
  target.labelhash = labelhash; target.tokenId = event.params.id; target.registrant = account(event.params.owner).id; target.expiryDate = event.params.expires; target.save();
}
export function handleBaseNameRenewed(event: NameRenewed): void {
  const target = domain(nodeFromLabelhash(idToLabelhash(event.params.id)), event.block.timestamp);
  target.expiryDate = event.params.expires; target.save();
}

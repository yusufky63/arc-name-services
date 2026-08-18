import { Address, BigInt, ByteArray, Bytes, crypto, dataSource, ethereum } from "@graphprotocol/graph-ts";
import { Account, Domain, Resolver } from "../generated/schema";

export const ZERO_ADDRESS = Address.fromString("0x0000000000000000000000000000000000000000");

export function eventId(event: ethereum.Event): string {
  return event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
}

export function account(address: Address): Account {
  const id = address.toHexString();
  let entity = Account.load(id);
  if (entity == null) {
    entity = new Account(id);
    entity.save();
  }
  return entity;
}

export function domain(node: Bytes, timestamp: BigInt): Domain {
  const id = node.toHexString();
  let entity = Domain.load(id);
  if (entity == null) {
    entity = new Domain(id);
    entity.owner = account(ZERO_ADDRESS).id;
    entity.subdomainCount = 0;
    entity.isMigrated = false;
    entity.createdAt = timestamp;
    entity.storedOffchain = false;
    entity.resolvedWithWildcard = false;
    entity.save();
  }
  return entity;
}

export function resolverFor(domainId: string, resolverAddress: Address): Resolver {
  const id = resolverAddress.toHexString() + "-" + domainId;
  let entity = Resolver.load(id);
  if (entity == null) {
    entity = new Resolver(id);
    entity.domain = domainId;
    entity.address = resolverAddress;
    entity.texts = [];
    entity.coinTypes = [];
    entity.save();
  }
  return entity;
}

export function baseNode(): Bytes { return dataSource.context().getBytes("baseNode"); }
export function suffix(): string { return dataSource.context().getString("suffix"); }

export function nodeFromLabelhash(labelhash: Bytes): Bytes {
  return Bytes.fromByteArray(crypto.keccak256(baseNode().concat(labelhash)));
}

export function tokenIdFromLabelhash(labelhash: Bytes): BigInt {
  const copy = Bytes.fromHexString(labelhash.toHexString());
  copy.reverse();
  return BigInt.fromUnsignedBytes(copy);
}

/** Persists plaintext only when label, labelhash and base-node parity all hold. */
export function saveHumanName(entity: Domain, emitted: string, labelhash: Bytes): bool {
  const expectedSuffix = suffix();
  const label = emitted.endsWith("." + expectedSuffix)
    ? emitted.slice(0, emitted.length - expectedSuffix.length - 1)
    : emitted;
  if (
    label.includes(".") || label.includes("。") || label.includes("．") || label.includes("｡") ||
    !crypto.keccak256(ByteArray.fromUTF8(label)).equals(labelhash)
  ) return false;
  if (entity.id != nodeFromLabelhash(labelhash).toHexString()) return false;
  entity.labelName = label;
  entity.labelhash = labelhash;
  entity.name = label + "." + expectedSuffix;
  entity.tokenId = tokenIdFromLabelhash(labelhash);
  return true;
}

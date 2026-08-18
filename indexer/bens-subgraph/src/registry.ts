import { Bytes, crypto } from "@graphprotocol/graph-ts";
import { NewOwner as NewOwnerEvent, NewResolver as NewResolverEvent, NewTTL as NewTTLEvent, Transfer as TransferEvent } from "../generated/Registry/Registry";
import { NewOwner, NewResolver, NewTTL, Transfer } from "../generated/schema";
import { ZERO_ADDRESS, account, domain, eventId, resolverFor } from "./helpers";

export function handleRegistryTransfer(event: TransferEvent): void {
  const target = domain(event.params.node, event.block.timestamp);
  const owner = account(event.params.owner);
  target.owner = owner.id;
  target.save();
  const record = new Transfer(eventId(event));
  record.domain = target.id; record.owner = owner.id; record.blockNumber = event.block.number.toI32(); record.transactionID = event.transaction.hash; record.save();
}

export function handleNewOwner(event: NewOwnerEvent): void {
  const parent = domain(event.params.node, event.block.timestamp);
  const childNode = Bytes.fromByteArray(crypto.keccak256(event.params.node.concat(event.params.label)));
  const child = domain(childNode, event.block.timestamp);
  if (child.parent == null) {
    parent.subdomainCount += 1;
    parent.save();
  }
  child.parent = parent.id;
  const owner = account(event.params.owner); child.owner = owner.id; child.save();
  const record = new NewOwner(eventId(event));
  record.parentDomain = parent.id; record.domain = child.id; record.owner = owner.id; record.blockNumber = event.block.number.toI32(); record.transactionID = event.transaction.hash; record.save();
}

export function handleNewResolver(event: NewResolverEvent): void {
  const target = domain(event.params.node, event.block.timestamp);
  // A resolver switch invalidates all address data cached from the old resolver.
  target.unset("resolvedAddress");
  if (event.params.resolver.equals(ZERO_ADDRESS)) {
    target.unset("resolver");
  } else {
    const resolver = resolverFor(target.id, event.params.resolver);
    target.resolver = resolver.id;
    const record = new NewResolver(eventId(event));
    record.domain = target.id;
    record.resolver = resolver.id;
    record.blockNumber = event.block.number.toI32();
    record.transactionID = event.transaction.hash;
    record.save();
  }
  target.save();
}

export function handleNewTTL(event: NewTTLEvent): void {
  const target = domain(event.params.node, event.block.timestamp);
  target.ttl = event.params.ttl; target.save();
  const record = new NewTTL(eventId(event));
  record.domain = target.id; record.ttl = event.params.ttl; record.blockNumber = event.block.number.toI32(); record.transactionID = event.transaction.hash; record.save();
}

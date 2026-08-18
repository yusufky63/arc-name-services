import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { AddrChanged as AddrEvent, AddressChanged as AddressEvent, ContenthashChanged as ContentEvent, NameChanged as NameEvent, TextChanged as TextEvent } from "../generated/PublicResolver/PublicResolver";
import { AddrChanged, ContenthashChanged, InterfaceChanged, MulticoinAddrChanged, NameChanged, TextChanged, VersionChanged } from "../generated/schema";
import { InterfaceChanged as InterfaceEvent, VersionChanged as VersionEvent } from "../generated/PublicResolver/PublicResolver";
import { ZERO_ADDRESS, account, domain, eventId, resolverFor } from "./helpers";

export function handleAddrChanged(event: AddrEvent): void {
  const target = domain(event.params.node, event.block.timestamp); const resolver = resolverFor(target.id, event.address); const resolved = account(event.params.a);
  if (event.params.a.equals(ZERO_ADDRESS)) {
    resolver.unset("addr"); target.unset("resolvedAddress");
  } else {
    resolver.addr = resolved.id; target.resolvedAddress = resolved.id;
  }
  resolver.save(); target.resolver = resolver.id; target.save();
  const record = new AddrChanged(eventId(event)); record.resolver = resolver.id; record.addr = resolved.id; record.blockNumber = event.block.number.toI32(); record.transactionID = event.transaction.hash; record.save();
}
export function handleAddressChanged(event: AddressEvent): void {
  const target = domain(event.params.node, event.block.timestamp);
  const resolver = resolverFor(target.id, event.address);
  const coinTypes = resolver.coinTypes;
  if (coinTypes != null && !coinTypes.includes(event.params.coinType)) {
    coinTypes.push(event.params.coinType);
    resolver.coinTypes = coinTypes;
    resolver.save();
  }
  const record = new MulticoinAddrChanged(eventId(event)); record.resolver = resolver.id; record.coinType = event.params.coinType; record.addr = event.params.newAddress; record.blockNumber = event.block.number.toI32(); record.transactionID = event.transaction.hash; record.save();
}
export function handleTextChanged(event: TextEvent): void {
  const target = domain(event.params.node, event.block.timestamp); const resolver = resolverFor(target.id, event.address); const keys = resolver.texts;
  if (keys != null && !keys.includes(event.params.key)) keys.push(event.params.key); resolver.texts = keys; resolver.save();
  const record = new TextChanged(eventId(event)); record.resolver = resolver.id; record.key = event.params.key; record.value = event.params.value; record.blockNumber = event.block.number.toI32(); record.transactionID = event.transaction.hash; record.save();
}
export function handleNameChanged(event: NameEvent): void {
  const target = domain(event.params.node, event.block.timestamp); const resolver = resolverFor(target.id, event.address); const record = new NameChanged(eventId(event)); record.resolver = resolver.id; record.name = event.params.name; record.blockNumber = event.block.number.toI32(); record.transactionID = event.transaction.hash; record.save();
}
export function handleContenthashChanged(event: ContentEvent): void {
  const target = domain(event.params.node, event.block.timestamp); const resolver = resolverFor(target.id, event.address); resolver.contentHash = event.params.hash; resolver.save();
  const record = new ContenthashChanged(eventId(event)); record.resolver = resolver.id; record.hash = event.params.hash; record.blockNumber = event.block.number.toI32(); record.transactionID = event.transaction.hash; record.save();
}
export function handleVersionChanged(event: VersionEvent): void {
  const target = domain(event.params.node, event.block.timestamp);
  const resolver = resolverFor(target.id, event.address);
  resolver.texts = [];
  resolver.coinTypes = [];
  resolver.unset("addr");
  resolver.unset("contentHash");
  resolver.save();
  target.unset("resolvedAddress");
  target.save();
  const record = new VersionChanged(eventId(event)); record.resolver = resolver.id; record.version = event.params.newVersion; record.blockNumber = event.block.number.toI32(); record.transactionID = event.transaction.hash; record.save();
}
export function handleInterfaceChanged(event: InterfaceEvent): void {
  const target = domain(event.params.node, event.block.timestamp); const resolver = resolverFor(target.id, event.address);
  const record = new InterfaceChanged(eventId(event)); record.resolver = resolver.id; record.interfaceID = event.params.interfaceID; record.implementer = event.params.implementer; record.blockNumber = event.block.number.toI32(); record.transactionID = event.transaction.hash; record.save();
}

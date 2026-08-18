import { BigInt } from "@graphprotocol/graph-ts";
import { NameRegistered as RegisteredEvent, NameRenewed as RenewedEvent } from "../generated/Controller/Controller";
import { NameRegistered, NameRenewed, Registration } from "../generated/schema";
import { account, domain, eventId, nodeFromLabelhash, saveHumanName } from "./helpers";

export function handleControllerNameRegistered(event: RegisteredEvent): void {
  const target = domain(nodeFromLabelhash(event.params.label), event.block.timestamp);
  saveHumanName(target, event.params.name, event.params.label);
  const registrant = account(event.params.owner);
  target.registrant = registrant.id; target.expiryDate = event.params.expires;
  const id = eventId(event);
  let registration = Registration.load(target.id);
  if (registration == null) registration = new Registration(target.id);
  registration.domain = target.id; registration.registrant = registrant.id; registration.registrationDate = event.block.timestamp;
  registration.expiryDate = event.params.expires; registration.cost = event.params.baseCost.plus(event.params.premium);
  registration.labelName = target.labelName; registration.save();
  target.save();
  const record = new NameRegistered(id);
  record.registration = registration.id; record.registrant = registrant.id; record.expiryDate = event.params.expires;
  record.blockNumber = event.block.number.toI32(); record.transactionID = event.transaction.hash; record.save();
}

export function handleControllerNameRenewed(event: RenewedEvent): void {
  const target = domain(nodeFromLabelhash(event.params.label), event.block.timestamp);
  saveHumanName(target, event.params.name, event.params.label);
  target.expiryDate = event.params.expires;
  const registration = Registration.load(target.id);
  if (registration != null) {
    registration.expiryDate = event.params.expires; registration.save();
    const record = new NameRenewed(eventId(event));
    record.registration = registration.id; record.expiryDate = event.params.expires;
    record.blockNumber = event.block.number.toI32(); record.transactionID = event.transaction.hash; record.save();
  }
  target.save();
}

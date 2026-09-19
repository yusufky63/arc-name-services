import React from "react";
import { BRAND } from "../lib/brand";

export function NameRegistrationCta({
  label,
  registrationEnabled,
  nameAvailable,
  liveRegistrationHref,
  listingPrice,
}: {
  label: string;
  registrationEnabled: boolean;
  nameAvailable?: boolean | undefined;
  liveRegistrationHref?: string | undefined;
  listingPrice?: string | null | undefined;
}) {
  const fullName = `${label}${BRAND.suffix}`;

  if (listingPrice) {
    return (
      <div className="name-route-hero__registration">
        <a
          className="name-route-hero__registration-cta name-route-hero__registration-cta--market"
          href="#management"
        >
          <span>Buy {fullName} · {listingPrice}</span>
          <span aria-hidden="true">&darr;</span>
        </a>
      </div>
    );
  }

  if (nameAvailable !== true) return null;

  const href = registrationEnabled ? "#registration" : liveRegistrationHref;
  if (!href) return null;

  return (
    <div className="name-route-hero__registration">
      <a
        className="name-route-hero__registration-cta"
        href={href}
      >
        <span>Register {fullName}</span>
        <span aria-hidden="true">&darr;</span>
      </a>
    </div>
  );
}

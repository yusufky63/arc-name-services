import React from "react";
import { BRAND } from "../lib/brand";

export function NameRegistrationCta({
  label,
  registrationEnabled,
  nameAvailable,
  liveRegistrationHref,
}: {
  label: string;
  registrationEnabled: boolean;
  nameAvailable?: boolean | undefined;
  liveRegistrationHref?: string | undefined;
}) {
  if (nameAvailable !== true) return null;

  const fullName = `${label}${BRAND.suffix}`;
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

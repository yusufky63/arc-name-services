import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NameRegistrationCta } from "./name-registration-cta";

describe("name registration hero CTA", () => {
  it("links an available name to the semantic registration section", () => {
    const html = renderToStaticMarkup(
      <NameRegistrationCta
        label="atlas"
        registrationEnabled
        nameAvailable
      />,
    );

    expect(html).toContain('href="#registration"');
    expect(html).toContain("Register atlas.contour");
    expect(html).toContain('aria-hidden="true"');
  });

  it("fails closed while availability is unknown", () => {
    const html = renderToStaticMarkup(
      <NameRegistrationCta
        label="atlas"
        registrationEnabled
      />,
    );

    expect(html).toBe("");
  });

  it("routes a read-only surface to the canonical live registration page", () => {
    const html = renderToStaticMarkup(
      <NameRegistrationCta
        label="atlas"
        registrationEnabled={false}
        nameAvailable
        liveRegistrationHref="https://contour-arc.vercel.app/name/atlas#registration"
      />,
    );

    expect(html).toContain(
      'href="https://contour-arc.vercel.app/name/atlas#registration"',
    );
    expect(html).toContain("Register atlas.contour");
  });

  it("fails closed when registration and the canonical live route are unavailable", () => {
    expect(renderToStaticMarkup(
      <NameRegistrationCta
        label="atlas"
        registrationEnabled={false}
        nameAvailable
      />,
    )).toBe("");
  });

  it("does not offer registration for an unavailable name", () => {
    expect(renderToStaticMarkup(
      <NameRegistrationCta
        label="atlas"
        registrationEnabled
        nameAvailable={false}
        liveRegistrationHref="https://contour-arc.vercel.app/name/atlas#registration"
      />,
    )).toBe("");
  });
});

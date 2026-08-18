export const BRAND = {
  name: "Contour",
  protocolName: "Contour Name Protocol",
  suffix: ".contour",
  tagline: "A stable coordinate for an agentic economy.",
  disclaimer:
    "Contour is an independent application built on Arc Testnet and is not sponsored or endorsed by Circle. Arc is a trademark of Circle Internet Group, Inc. and/or its affiliates.",
} as const;

export const PRODUCT_DEFAULTS = {
  annualPriceUsdc: 0.5,
  gracePeriodDays: 90,
  permitTtlSeconds: 180,
  maxRegistrationYears: 5,
  minRegistrationYears: 1,
  annualPriceByCodePointLength: {
    1: 5,
    2: 2.5,
    3: 1,
  },
} as const;

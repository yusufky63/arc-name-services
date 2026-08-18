import { BRAND, PRODUCT_DEFAULTS } from "./brand";
import { normalizeLabel } from "@contour/normalization";

export function cleanLabel(input: string): string {
  return normalizeLabel(input).normalized;
}

export function displayName(label: string): string {
  return `${cleanLabel(label)}${BRAND.suffix}`;
}

export function labelPrice(label: string, years = 1): number {
  const clean = cleanLabel(label);
  const codePointLength = Array.from(clean).length;
  const annualPrice =
    PRODUCT_DEFAULTS.annualPriceByCodePointLength[
      codePointLength as keyof typeof PRODUCT_DEFAULTS.annualPriceByCodePointLength
    ] ?? PRODUCT_DEFAULTS.annualPriceUsdc;
  return annualPrice * years;
}

export function isPlausibleLabel(label: string): boolean {
  try {
    const clean = cleanLabel(label);
    return clean.length > 0;
  } catch {
    return false;
  }
}

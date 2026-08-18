export function normalizeOperatorPrivateKey(value, field = "PRIVATE_KEY") {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const normalized = /^[0-9a-fA-F]{64}$/.test(trimmed) ? `0x${trimmed}` : trimmed;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`${field} is missing or malformed`);
  }
  return normalized;
}


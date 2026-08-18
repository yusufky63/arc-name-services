import { createHmac, timingSafeEqual } from "node:crypto";

type HeaderValue = string | string[] | undefined;

function one(headers: Record<string, HeaderValue>, name: string): string {
  const value = headers[name];
  if (typeof value !== "string") throw new Error(`missing ${name}`);
  return value;
}

function safeEqualText(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function safeEqualHex(actual: string, expected: string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(actual) || !/^[0-9a-fA-F]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function validateServiceBearer(
  headers: Record<string, HeaderValue>,
  expectedToken: string,
): void {
  const authorization = one(headers, "authorization");
  if (!authorization.startsWith("Bearer ") || !safeEqualText(authorization.slice(7), expectedToken)) {
    throw new Error("invalid service bearer");
  }
}

export function validateIssuerBoundary(
  headers: Record<string, HeaderValue>,
  method: string,
  path: string,
  serviceBearerToken: string,
  clientKeyHmacSecret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): string {
  validateServiceBearer(headers, serviceBearerToken);
  const clientKey = one(headers, "x-contour-client-key");
  const timestampText = one(headers, "x-contour-client-timestamp");
  const signature = one(headers, "x-contour-client-signature");
  if (!/^[0-9a-fA-F]{64}$/.test(clientKey) || !/^[0-9]{10}$/.test(timestampText)) {
    throw new Error("invalid client identity envelope");
  }
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > 60) {
    throw new Error("stale client identity envelope");
  }
  const expected = createHmac("sha256", clientKeyHmacSecret)
    .update(`contour-issuer-boundary/v1\n${timestampText}\n${method.toUpperCase()}\n${path}\n${clientKey}`)
    .digest("hex");
  if (!safeEqualHex(signature, expected)) throw new Error("invalid client identity signature");
  return clientKey.toLowerCase();
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large.");
    this.name = "RequestBodyTooLargeError";
  }
}

type BoundedBodySource = {
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
};

export async function readSmallBody(
  source: BoundedBodySource,
  maxLength = 4_096,
): Promise<Uint8Array> {
  const declaredLength = source.headers.get("content-length");
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    (declaredLength.length > 12 || Number(declaredLength) > maxLength)
  ) {
    throw new RequestBodyTooLargeError();
  }
  const reader = source.body?.getReader();
  if (!reader) throw new SyntaxError("JSON body required.");
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxLength) {
      await reader.cancel();
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readSmallJsonObject(
  source: BoundedBodySource,
  maxLength = 4_096,
): Promise<Record<string, unknown>> {
  const body = await readSmallBody(source, maxLength);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("JSON object required.");
  }
  return value as Record<string, unknown>;
}

function isBoundedDecimal(value: unknown, maxDigits: number, max: bigint): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxDigits ||
    !DECIMAL.test(value)
  ) {
    return false;
  }
  return BigInt(value) <= max;
}

export function isUint256Decimal(value: unknown): value is string {
  return isBoundedDecimal(value, 78, UINT256_MAX);
}

export function isPositiveUint256Decimal(value: unknown): value is string {
  return isUint256Decimal(value) && value !== "0";
}

export function isUint64Decimal(value: unknown): value is string {
  return isBoundedDecimal(value, 20, UINT64_MAX);
}

export function isPositiveUint64Decimal(value: unknown): value is string {
  return isUint64Decimal(value) && value !== "0";
}

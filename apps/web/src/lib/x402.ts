import { createHash } from "node:crypto";
import { getAddress, isAddress, type Address, type Hex } from "viem";

export const ARC_TESTNET_CAIP2 = "eip155:5042002";
export const ARC_USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;
export const CIRCLE_GATEWAY_DOMAIN = 26;
export const CIRCLE_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as const;

export const X402_ERROR_CODES = [
  "X402_NOT_CONFIGURED",
  "PAYMENT_REQUIRED",
  "PAYMENT_INVALID",
  "PAYMENT_EXPIRED",
  "PAYMENT_REPLAYED",
  "PAYMENT_WRONG_NETWORK",
  "PAYMENT_WRONG_ASSET",
  "PAYMENT_WRONG_RECIPIENT",
  "PAYMENT_INSUFFICIENT",
] as const;

export type X402ErrorCode = (typeof X402_ERROR_CODES)[number];

export interface X402PaymentAccept {
  scheme: "exact";
  network: typeof ARC_TESTNET_CAIP2;
  asset: typeof ARC_USDC_ADDRESS;
  amount: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: {
    domain: number;
    verifyingContract: Address;
  };
}

export interface X402PaymentRequiredPayload {
  x402Version: 2;
  resource: {
    url: string;
    description: string;
    mimeType: string;
  };
  accepts: [X402PaymentAccept];
}

export interface PaymentVerificationResult {
  valid: boolean;
  code?: X402ErrorCode | undefined;
  error?: string | undefined;
  paymentIdentifier?: Hex | undefined;
  payer?: Address | undefined;
  amount?: bigint | undefined;
}

// In-memory replay cache with bounded capacity
const MAX_SEEN_SIGNATURES = 10_000;
const seenPaymentSignatures = new Set<string>();
const seenSignatureQueue: string[] = [];

function recordPaymentSignature(identifier: string): boolean {
  if (seenPaymentSignatures.has(identifier)) {
    return false; // Replayed
  }
  if (seenPaymentSignatures.size >= MAX_SEEN_SIGNATURES) {
    const oldest = seenSignatureQueue.shift();
    if (oldest) seenPaymentSignatures.delete(oldest);
  }
  seenPaymentSignatures.add(identifier);
  seenSignatureQueue.push(identifier);
  return true;
}

export function isX402Enabled(): boolean {
  return (
    process.env.X402_ENABLED === "true" ||
    process.env.NEXT_PUBLIC_X402_ACTIVE === "true"
  );
}

export function buildPaymentRequirements(params: {
  amount: bigint;
  payTo: Address;
  resourcePath?: string;
  description?: string;
}): X402PaymentRequiredPayload {
  return {
    x402Version: 2,
    resource: {
      url: params.resourcePath ?? "/api/registration/prepare",
      description: params.description ?? "Arc Testnet name registration via Circle x402",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: ARC_TESTNET_CAIP2,
        asset: ARC_USDC_ADDRESS,
        amount: params.amount.toString(),
        payTo: getAddress(params.payTo),
        maxTimeoutSeconds: 120,
        extra: {
          domain: CIRCLE_GATEWAY_DOMAIN,
          verifyingContract: CIRCLE_GATEWAY_WALLET,
        },
      },
    ],
  };
}

export function parsePaymentSignatureHeader(headerValue: string | null | undefined): Record<string, unknown> | null {
  if (!headerValue || typeof headerValue !== "string") return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;

  // Try direct JSON
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Try base64-encoded JSON
    try {
      const decoded = Buffer.from(trimmed, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not valid JSON/Base64 JSON
    }
  }
  return null;
}

export async function verifyPaymentAuthorization(params: {
  paymentSignature: unknown;
  expectedAmount: bigint;
  expectedPayTo: Address;
}): Promise<PaymentVerificationResult> {
  if (!isX402Enabled()) {
    return {
      valid: false,
      code: "X402_NOT_CONFIGURED",
      error: "Circle x402 nanopayments are not currently active on this deployment.",
    };
  }

  let paymentObj: Record<string, unknown> | null = null;
  if (typeof params.paymentSignature === "string") {
    paymentObj = parsePaymentSignatureHeader(params.paymentSignature);
  } else if (typeof params.paymentSignature === "object" && params.paymentSignature !== null) {
    paymentObj = params.paymentSignature as Record<string, unknown>;
  }

  if (!paymentObj) {
    return {
      valid: false,
      code: "PAYMENT_INVALID",
      error: "Malformed or unparseable PAYMENT-SIGNATURE payload.",
    };
  }

  // 1. Network check
  const network = paymentObj.network ?? paymentObj.chainId;
  if (network && network !== ARC_TESTNET_CAIP2 && network !== 5042002 && network !== "5042002") {
    return {
      valid: false,
      code: "PAYMENT_WRONG_NETWORK",
      error: `Payment network (${String(network)}) does not match required Arc Testnet (${ARC_TESTNET_CAIP2}).`,
    };
  }

  // 2. Asset check
  const asset = paymentObj.asset ?? paymentObj.token;
  if (typeof asset === "string") {
    try {
      if (getAddress(asset) !== getAddress(ARC_USDC_ADDRESS)) {
        return {
          valid: false,
          code: "PAYMENT_WRONG_ASSET",
          error: `Payment asset (${asset}) does not match canonical Arc USDC (${ARC_USDC_ADDRESS}).`,
        };
      }
    } catch {
      return {
        valid: false,
        code: "PAYMENT_WRONG_ASSET",
        error: "Invalid payment asset address format.",
      };
    }
  }

  // 3. Recipient check
  const payTo = paymentObj.payTo ?? paymentObj.recipient;
  if (typeof payTo === "string") {
    try {
      if (getAddress(payTo) !== getAddress(params.expectedPayTo)) {
        return {
          valid: false,
          code: "PAYMENT_WRONG_RECIPIENT",
          error: `Payment recipient (${payTo}) does not match expected treasury (${params.expectedPayTo}).`,
        };
      }
    } catch {
      return {
        valid: false,
        code: "PAYMENT_WRONG_RECIPIENT",
        error: "Invalid payTo recipient address format.",
      };
    }
  }

  // 4. Amount check
  const rawAmount = paymentObj.amount ?? paymentObj.exactAmount;
  if (rawAmount !== undefined && rawAmount !== null) {
    let authAmount: bigint;
    try {
      authAmount = BigInt(String(rawAmount));
    } catch {
      return {
        valid: false,
        code: "PAYMENT_INVALID",
        error: "Payment amount must be a valid integer base-units string.",
      };
    }
    if (authAmount < params.expectedAmount) {
      return {
        valid: false,
        code: "PAYMENT_INSUFFICIENT",
        error: `Authorized payment amount (${authAmount.toString()}) is less than required registration price (${params.expectedAmount.toString()}).`,
      };
    }
  }

  // 5. Expiration check
  const validUntil = paymentObj.validUntil ?? paymentObj.validBefore ?? paymentObj.expiresAt;
  if (validUntil !== undefined && validUntil !== null) {
    const expiresNum = Number(validUntil);
    const nowSec = Math.floor(Date.now() / 1_000);
    if (!Number.isNaN(expiresNum) && expiresNum < nowSec) {
      return {
        valid: false,
        code: "PAYMENT_EXPIRED",
        error: "Payment authorization has expired.",
      };
    }
  }

  // 6. Cryptographic / Replay identifier check
  const paymentHash = `0x${createHash("sha256")
    .update(JSON.stringify(paymentObj))
    .digest("hex")}` as Hex;

  const nonce = paymentObj.nonce ?? paymentObj.paymentId ?? paymentObj.signature ?? paymentHash;
  const isFresh = recordPaymentSignature(String(nonce));
  if (!isFresh) {
    return {
      valid: false,
      code: "PAYMENT_REPLAYED",
      error: "This payment authorization has already been used.",
    };
  }

  // Extract payer if present
  let payer: Address | undefined;
  const rawPayer = paymentObj.payer ?? paymentObj.from ?? paymentObj.wallet;
  if (typeof rawPayer === "string" && isAddress(rawPayer)) {
    payer = getAddress(rawPayer);
  }

  return {
    valid: true,
    paymentIdentifier: paymentHash,
    payer,
    amount: params.expectedAmount,
  };
}

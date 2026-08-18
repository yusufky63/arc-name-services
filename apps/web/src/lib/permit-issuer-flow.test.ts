import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAddress,
  verifyMessage,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DeploymentManifest } from "@contour/config";
import { resolverDataHash } from "@contour/sdk";
import deploymentManifest from "../../../../deployments/5042002.json";

const { createPublicClientMock } = vi.hoisted(() => ({
  createPublicClientMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return { ...actual, createPublicClient: createPublicClientMock };
});

import {
  createRegistrationChallenge,
  issueDirectRegistrationPermit,
  issueRegistrationPermit,
  validateRegistrationChallengeEnvelope,
  type RegistrationIntent,
  type StatelessWalletChallenge,
} from "./permit-issuer";

const ORIGIN = "https://names.example.test";
const ISSUER_URL = `${ORIGIN}/api/registration/issuer/`;
const NOW = 1_768_435_200;
const EXPECTED_AMOUNT = 500_000n;
const signerPrivateKey = `0x${"11".repeat(32)}` as Hex;
const requesterPrivateKey = `0x${"22".repeat(32)}` as Hex;
const signerAccount = privateKeyToAccount(signerPrivateKey);
const requesterAccount = privateKeyToAccount(requesterPrivateKey);

type ArcState = {
  nonce: bigint;
  available: boolean;
  allowance: bigint;
  registrationsPaused: boolean;
  registrarControllerEnabled?: boolean;
};

function activeFixture(): DeploymentManifest {
  const value = structuredClone(deploymentManifest) as unknown as DeploymentManifest;
  value.state = "active";
  value.permitIssuer.active = true;
  value.permitIssuer.url = ISSUER_URL;
  value.permitIssuer.signerAddress = signerAccount.address;
  value.permitIssuer.policyVersion = "1";
  return value;
}

function intentFor(requester: Address = requesterAccount.address): RegistrationIntent {
  return {
    requestId: "request-flow-0001",
    rawLabel: "alpha",
    normalizationAccepted: true,
    requester,
    recipient: requester,
    payer: requester,
    authorizedExecutor: requester,
    durationYears: 1,
    resolverDataHash: resolverDataHash([]),
    referrer: zeroAddress,
  };
}

function installArcClient(state: ArcState) {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case "permitSigner":
        return signerAccount.address;
      case "signerPolicyVersion":
        return 1n;
      case "registrationsPaused":
        return state.registrationsPaused;
      case "controllers":
        return state.registrarControllerEnabled ?? true;
      case "quote":
        return EXPECTED_AMOUNT;
      case "nonces":
        return state.nonce;
      case "available":
        return state.available;
      case "allowance":
        return state.allowance;
      default:
        throw new Error(`unexpected readContract call: ${functionName}`);
    }
  });
  const verifyMessageMock = vi.fn(
    async (input: { address: Address; message: string; signature: Hex }) =>
      verifyMessage(input),
  );
  const client = {
    getChainId: vi.fn(async () => deploymentManifest.chain.id),
    getBlockNumber: vi.fn(async () => 53_272_967n),
    readContract,
    verifyMessage: verifyMessageMock,
  };
  createPublicClientMock.mockImplementation(() => client);
  return { client, readContract, verifyMessageMock };
}

async function signedChallenge(
  manifest: DeploymentManifest,
  intent: RegistrationIntent,
): Promise<{ challenge: StatelessWalletChallenge; signature: Hex }> {
  const challenge = await createRegistrationChallenge({ manifest, intent, origin: ORIGIN });
  const signature = await requesterAccount.signMessage({ message: challenge.message });
  return { challenge, signature };
}

function issueInput(
  manifest: DeploymentManifest,
  intent: RegistrationIntent,
  challenge: StatelessWalletChallenge,
  signature: Hex,
) {
  return {
    manifest,
    intent,
    origin: ORIGIN,
    challengeId: challenge.id,
    challengeMessage: challenge.message,
    challengeProof: challenge.proof,
    challengeSignature: signature,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1_000);
  vi.stubEnv("REGISTRATION_CHALLENGE_SECRET", "fixture-challenge-secret-with-32-characters");
  vi.stubEnv("REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY", signerPrivateKey);
  vi.stubEnv("REGISTRATION_PERMIT_TTL_SECONDS", "180");
  createPublicClientMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("integrated stateless issuer flow", () => {
  it("issues a wallet-bound permit directly from current Arc state without a wallet signature", async () => {
    const manifest = activeFixture();
    const intent = intentFor();
    const state: ArcState = {
      nonce: 5n,
      available: true,
      allowance: EXPECTED_AMOUNT,
      registrationsPaused: false,
    };
    const { verifyMessageMock } = installArcClient(state);
    vi.stubEnv("REGISTRATION_CHALLENGE_SECRET", "");

    const issued = await issueDirectRegistrationPermit({ manifest, intent, origin: ORIGIN });

    expect(manifest.activationEvidence.productLive).toBe(false);
    expect(issued.permit).toMatchObject({
      requester: requesterAccount.address,
      recipient: requesterAccount.address,
      payer: requesterAccount.address,
      authorizedExecutor: requesterAccount.address,
      nonce: 5n,
      issuedAt: BigInt(NOW),
      validAfter: BigInt(NOW - 5),
      validUntil: BigInt(NOW + 180),
    });
    expect(issued.signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(verifyMessageMock).not.toHaveBeenCalled();
  });

  it("keeps direct issuance closed while the on-chain registration policy is paused", async () => {
    const manifest = activeFixture();
    const { verifyMessageMock } = installArcClient({
      nonce: 0n,
      available: true,
      allowance: EXPECTED_AMOUNT,
      registrationsPaused: true,
    });

    await expect(issueDirectRegistrationPermit({
      manifest,
      intent: intentFor(),
      origin: ORIGIN,
    })).rejects.toMatchObject({ code: "ISSUER_NOT_READY", status: 503 });
    expect(verifyMessageMock).not.toHaveBeenCalled();
  });

  it("keeps issuance closed when the registrar no longer authorizes the controller", async () => {
    const manifest = activeFixture();
    installArcClient({
      nonce: 0n,
      available: true,
      allowance: EXPECTED_AMOUNT,
      registrationsPaused: false,
      registrarControllerEnabled: false,
    });

    await expect(issueDirectRegistrationPermit({
      manifest,
      intent: intentFor(),
      origin: ORIGIN,
    })).rejects.toMatchObject({ code: "ISSUER_NOT_READY", status: 503 });
  });

  it("accepts a fresh envelope and rejects expired or HMAC-tampered challenges", async () => {
    const manifest = activeFixture();
    const state: ArcState = {
      nonce: 0n,
      available: true,
      allowance: EXPECTED_AMOUNT,
      registrationsPaused: false,
    };
    installArcClient(state);
    const { challenge } = await signedChallenge(manifest, intentFor());

    const fresh = validateRegistrationChallengeEnvelope({
      id: challenge.id,
      message: challenge.message,
      proof: challenge.proof,
      now: NOW + 119,
    });
    expect(fresh.expiresAt).toBe(NOW + 120);

    expect(() => validateRegistrationChallengeEnvelope({
      id: challenge.id,
      message: challenge.message,
      proof: challenge.proof,
      now: NOW + 120,
    })).toThrowError(expect.objectContaining({ code: "CHALLENGE_EXPIRED", status: 409 }));

    expect(() => validateRegistrationChallengeEnvelope({
      id: challenge.id,
      message: challenge.message.replace("Name: alpha.contour", "Name: beta.contour"),
      proof: challenge.proof,
      now: NOW,
    })).toThrowError(expect.objectContaining({ code: "INVALID_CHALLENGE", status: 422 }));
  });

  it("returns the same permit payload for a same-state signed-challenge retry", async () => {
    const manifest = activeFixture();
    const intent = intentFor();
    const state: ArcState = {
      nonce: 7n,
      available: true,
      allowance: EXPECTED_AMOUNT,
      registrationsPaused: false,
    };
    installArcClient(state);
    const { challenge, signature } = await signedChallenge(manifest, intent);

    const first = await issueRegistrationPermit(issueInput(manifest, intent, challenge, signature));
    const retried = await issueRegistrationPermit(issueInput(manifest, intent, challenge, signature));

    expect(retried.permit).toEqual(first.permit);
    expect(retried.signature).toBe(first.signature);
  });

  it("derives a different permit ID when the current controller nonce changes", async () => {
    const manifest = activeFixture();
    const intent = intentFor();
    const state: ArcState = {
      nonce: 3n,
      available: true,
      allowance: EXPECTED_AMOUNT,
      registrationsPaused: false,
    };
    installArcClient(state);
    const { challenge, signature } = await signedChallenge(manifest, intent);

    const first = await issueRegistrationPermit(issueInput(manifest, intent, challenge, signature));
    state.nonce = 4n;
    const next = await issueRegistrationPermit(issueInput(manifest, intent, challenge, signature));

    expect(first.permit.nonce).toBe(3n);
    expect(next.permit.nonce).toBe(4n);
    expect(next.permit.permitId).not.toBe(first.permit.permitId);
  });

  it("rejects a name that becomes unavailable after challenge creation", async () => {
    const manifest = activeFixture();
    const intent = intentFor();
    const state: ArcState = {
      nonce: 0n,
      available: true,
      allowance: EXPECTED_AMOUNT,
      registrationsPaused: false,
    };
    installArcClient(state);
    const { challenge, signature } = await signedChallenge(manifest, intent);
    state.available = false;

    await expect(issueRegistrationPermit(issueInput(manifest, intent, challenge, signature)))
      .rejects.toMatchObject({ code: "NAME_UNAVAILABLE", status: 409 });
  });

  it("rejects issuance when the payer allowance is below the fresh quote", async () => {
    const manifest = activeFixture();
    const intent = intentFor();
    const state: ArcState = {
      nonce: 0n,
      available: true,
      allowance: EXPECTED_AMOUNT - 1n,
      registrationsPaused: false,
    };
    installArcClient(state);
    const { challenge, signature } = await signedChallenge(manifest, intent);

    await expect(issueRegistrationPermit(issueInput(manifest, intent, challenge, signature)))
      .rejects.toMatchObject({ code: "USDC_AUTHORIZATION_REQUIRED", status: 409 });
  });

  it("rejects an alias origin before making an Arc RPC call", async () => {
    const manifest = activeFixture();
    const state: ArcState = {
      nonce: 0n,
      available: true,
      allowance: EXPECTED_AMOUNT,
      registrationsPaused: false,
    };
    installArcClient(state);

    await expect(createRegistrationChallenge({
      manifest,
      intent: intentFor(),
      origin: "https://preview.example.test",
    })).rejects.toMatchObject({ code: "ISSUER_ORIGIN_MISMATCH", status: 503 });
    expect(createPublicClientMock).not.toHaveBeenCalled();
  });

  it("rejects a recipient that differs from the connected wallet before Arc RPC", async () => {
    const manifest = activeFixture();
    const intent = {
      ...intentFor(),
      recipient: getAddress("0x1000000000000000000000000000000000000002"),
    };

    await expect(createRegistrationChallenge({ manifest, intent, origin: ORIGIN }))
      .rejects.toThrow(/wallet-bound registration parties/i);
    expect(createPublicClientMock).not.toHaveBeenCalled();
  });

  it("delegates a bounded smart-account signature to the Arc public client", async () => {
    const manifest = activeFixture();
    const smartAccount = getAddress("0x1000000000000000000000000000000000000001");
    const intent = intentFor(smartAccount);
    const state: ArcState = {
      nonce: 2n,
      available: true,
      allowance: EXPECTED_AMOUNT,
      registrationsPaused: false,
    };
    const { verifyMessageMock } = installArcClient(state);
    verifyMessageMock.mockResolvedValueOnce(true);
    const challenge = await createRegistrationChallenge({ manifest, intent, origin: ORIGIN });
    const contractSignature = `0x${"ab".repeat(96)}` as Hex;

    const issued = await issueRegistrationPermit(
      issueInput(manifest, intent, challenge, contractSignature),
    );

    expect(issued.permit.requester).toBe(smartAccount);
    expect(verifyMessageMock).toHaveBeenCalledWith({
      address: smartAccount,
      message: challenge.message,
      signature: contractSignature,
    });
  });
});

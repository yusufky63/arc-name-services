import { afterEach, describe, expect, it, vi } from "vitest";
import { registrarVersionOf } from "@contour/config";
import { getDeploymentManifest } from "@/lib/manifest";
import type { AdminSnapshot } from "@/lib/admin-protocol";

vi.mock("@/lib/use-wallet-session", () => ({
  useWalletSession: vi.fn(),
}));

vi.mock("./admin-action-dialog", () => ({
  AdminActionDialog: vi.fn(),
}));

import {
  adminSnapshotMatchesSelectedRelease,
  assertIssuerPreparedForOpening,
  marketplaceOpeningValidationError,
  registrarControllerAction,
  registrationOpeningValidationError,
} from "./admin-controls";

function openingSnapshot(): AdminSnapshot {
  const manifest = getDeploymentManifest();
  const controller = manifest.contracts.controller.address;
  const signer = manifest.permitIssuer.signerAddress;
  const policyVersion = manifest.permitIssuer.policyVersion;
  const releaseId = manifest.releaseId;
  if (!controller || !signer || policyVersion === null || !releaseId) {
    throw new Error("The admin opening test requires a canonical controller, permit signer, and policy version.");
  }

  return {
    productLive: false,
    releaseId,
    releaseKey: "canonical",
    registrarVersion: registrarVersionOf(manifest),
    canonical: true,
    controller: {
      address: controller,
      permitSigner: signer,
      pendingPermitSigner: null,
      signerPolicyVersion: BigInt(policyVersion),
      registrationsPaused: true,
    },
    registrar: {
      canonicalControllerEnabled: true,
    },
  } as AdminSnapshot;
}

function issuerHealth(snapshot: AdminSnapshot, overrides: Record<string, unknown> = {}) {
  const manifest = getDeploymentManifest();
  const signer = snapshot.controller.permitSigner;
  return {
    ok: false,
    productLive: false,
    chainId: manifest.chain.id,
    controller: snapshot.controller.address,
    releaseId: snapshot.releaseId,
    signerReady: true,
    signerAddress: signer,
    configuredSignerAddress: signer,
    localSignerAddress: signer,
    policyVersion: snapshot.controller.signerPolicyVersion.toString(),
    onchainPolicyVersion: snapshot.controller.signerPolicyVersion.toString(),
    registrationsPaused: snapshot.controller.registrationsPaused,
    registrarControllerEnabled: snapshot.registrar.canonicalControllerEnabled,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin registration reopening", () => {
  it("rejects a recovery snapshot that completes after the selected release changes", async () => {
    const recovered = openingSnapshot();
    let selectedReleaseId: string = recovered.releaseId;
    let applied: AdminSnapshot | null = null;
    let finishRecovery: ((snapshot: AdminSnapshot) => void) | undefined;
    const recovery = new Promise<AdminSnapshot>((resolve) => {
      finishRecovery = resolve;
    }).then((snapshot) => {
      if (adminSnapshotMatchesSelectedRelease(snapshot, selectedReleaseId)) {
        applied = snapshot;
      }
    });

    selectedReleaseId = `0x${"ff".repeat(32)}`;
    finishRecovery?.(recovered);
    await recovery;

    expect(applied).toBeNull();
  });

  it("treats productLive=false as release evidence instead of an execution blocker", () => {
    expect(registrationOpeningValidationError(openingSnapshot())).toBeNull();
  });

  it("permanently blocks retained V1 registration reopening while preserving marketplace recovery", async () => {
    const retained = {
      ...openingSnapshot(),
      releaseKey: "legacy",
      registrarVersion: "v1",
      canonical: false,
    } as AdminSnapshot;
    expect(registrationOpeningValidationError(retained)).toMatch(
      /retained v1 registration cannot be reopened/i,
    );
    expect(marketplaceOpeningValidationError(retained)).toBeNull();
    await expect(assertIssuerPreparedForOpening(retained)).rejects.toThrow(
      /retained v1 registration is permanently closed/i,
    );
  });

  it("accepts a healthy matching issuer while registration is paused and productLive=false", async () => {
    const snapshot = openingSnapshot();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify(issuerHealth(snapshot)),
      {
        status: 503,
        headers: { "content-type": "application/json" },
      },
    )));

    await expect(assertIssuerPreparedForOpening(snapshot)).resolves.toBeUndefined();
  });

  it("still rejects issuer signer drift", async () => {
    const snapshot = openingSnapshot();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify(issuerHealth(snapshot, {
        localSignerAddress: "0x0000000000000000000000000000000000000001",
      })),
      {
        status: 503,
        headers: { "content-type": "application/json" },
      },
    )));

    await expect(assertIssuerPreparedForOpening(snapshot)).rejects.toThrow(
      "local issuer health, signer, policy version, and live controller state",
    );
  });

  it("pauses registration before disabling the canonical registrar controller", () => {
    const action = registrarControllerAction(openingSnapshot());
    expect(action.steps.map((step) => step.plan.target)).toEqual(["controller", "registrar"]);
    expect(action.steps.every((step) => step.plan.releaseId === action.releaseId)).toBe(true);
    expect(action.finalVerify?.({
      ...openingSnapshot(),
      controller: { ...openingSnapshot().controller, registrationsPaused: true },
      registrar: { ...openingSnapshot().registrar, canonicalControllerEnabled: false },
    })).toBe(true);
  });

  it("can re-enable the registrar without silently reopening registration", () => {
    const snapshot = openingSnapshot();
    snapshot.registrar.canonicalControllerEnabled = false;
    const action = registrarControllerAction(snapshot);
    expect(action.steps.map((step) => step.plan.target)).toEqual(["registrar"]);
    expect(action.successMessage).toMatch(/remains under its separate pause/i);
  });
});

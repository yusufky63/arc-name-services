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

  it("blocks admin execution while the mainnet deployment is only configured", () => {
    expect(() => registrationOpeningValidationError(openingSnapshot())).toThrow(
      /controller is not active/i,
    );
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

  it("does not probe issuer health before the mainnet release is active", async () => {
    const snapshot = openingSnapshot();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify(issuerHealth(snapshot)),
      {
        status: 503,
        headers: { "content-type": "application/json" },
      },
    )));

    await expect(assertIssuerPreparedForOpening(snapshot)).rejects.toThrow(
      /controller is not active/i,
    );
  });

  it("keeps signer checks behind the active-release boundary", async () => {
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
      /controller is not active/i,
    );
  });

  it("does not prepare registrar changes for a configured release", () => {
    expect(() => registrarControllerAction(openingSnapshot())).toThrow(
      /controller is not active/i,
    );
  });

  it("does not prepare registrar re-enabling before activation", () => {
    const snapshot = openingSnapshot();
    snapshot.registrar.canonicalControllerEnabled = false;
    expect(() => registrarControllerAction(snapshot)).toThrow(
      /controller is not active/i,
    );
  });
});

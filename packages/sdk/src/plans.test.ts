import { decodeFunctionData, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import deployment from "../../../deployments/5042002.json" with { type: "json" };
import verifiedDeployment from "../../../deployments/5042002.verified.json" with { type: "json" };
import {
  CANONICAL_NFT_METADATA_BASE_URI,
  EXPECTED_RESOLVER_CAPABILITIES,
  parseDeploymentManifest,
} from "@contour/config";
import { deriveNameIdentity } from "@contour/normalization";
import {
  prepareApprovalPlan,
  prepareAddressPlan,
  prepareBuyPlan,
  prepareCancelListingPlan,
  prepareClaimProceedsPlan,
  prepareClaimReferralPlan,
  prepareInvalidateListingPlan,
  prepareListingPlan,
  prepareMarketplaceApprovalPlan,
  prepareMarketplaceTokenApprovalPlan,
  prepareMarketplaceTokenApprovalRevokePlan,
  prepareMarketplaceTokenApprovalRevocationPlan,
  preparePrimaryNamePlan,
  prepareRegistrationPlan,
  prepareTransferPlan,
  resolverDataHash,
} from "./plans.js";
import { baseRegistrarAbi, marketplaceAbi, publicResolverAbi, reverseRegistrarAbi } from "./abis.js";
import { assertPermitWindow, type RegistrationPermit } from "./permit.js";

function activeManifest(productLive = true) {
  const value = structuredClone(deployment) as any;
  value.state = "active";
  value.releaseId = `0x${"99".repeat(32)}`;
  value.resolverCapabilities = { ...EXPECTED_RESOLVER_CAPABILITIES };
  let index = 1;
  for (const contract of Object.values(value.contracts) as any[]) {
    contract.address = `0x${index.toString(16).padStart(40, "0")}`;
    contract.deploymentBlock = 100 + index;
    contract.transactionHash = `0x${index.toString(16).padStart(64, "0")}`;
    contract.runtimeCodeHash = `0x${(index + 10).toString(16).padStart(64, "0")}`;
    contract.abiUrl = `https://example.com/contract-${index}.json`;
    contract.abiSha256 = `0x${(index + 20).toString(16).padStart(64, "0")}`;
    contract.sourceVerified = true;
    contract.sourceVerificationUrl = `https://testnet.arcscan.app/api/v2/smart-contracts/${contract.address}`;
    contract.sourceVerificationSha256 = `0x${(index + 30).toString(16).padStart(64, "0")}`;
    index += 1;
  }
  value.activationEvidence.productLive = productLive;
  value.activationEvidence.verifiedAtBlock = 200;
  let artifactIndex = 40;
  for (const [key, artifact] of Object.entries(value.activationEvidence.artifacts) as Array<[string, any]>) {
    artifact.url = `https://example.com/evidence/${key}.json`;
    artifact.sha256 = `0x${artifactIndex.toString(16).padStart(64, "0")}`;
    artifactIndex += 1;
  }
  if (!productLive) {
    value.activationEvidence.artifacts.fundedEndToEnd = { url: null, sha256: null };
    value.activationEvidence.artifacts.operationsDrill = { url: null, sha256: null };
  }
  value.activationEvidence.governance = {
    account: "0xd100000000000000000000000000000000000001",
  };
  value.activationEvidence.controllerPolicy = {
    permitSigner: "0xd100000000000000000000000000000000000001",
    signerPolicyVersion: "1",
    referralBps: 500,
    registrationsPaused: false,
  };
  value.activationEvidence.marketplacePolicy = { feeBps: 250, paused: false };
  value.permitIssuer = {
    url: "https://issuer.example.com",
    signerAddress: "0xd100000000000000000000000000000000000001",
    publicKey: null,
    policyVersion: "1",
    active: true,
  };
  value.registrarVersion = "v2";
  value.nftMetadata = {
    metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI,
  };
  value.legacyReleases = [{
    registrarVersion: "v1",
    releaseId: deployment.releaseId,
    verifiedAtBlock: deployment.activationEvidence.verifiedAtBlock,
    contracts: Object.fromEntries(
      Object.entries(deployment.contracts).map(([key, contract]: [string, any]) => [
        key,
        {
          address: contract.address,
          deploymentBlock: contract.deploymentBlock,
          runtimeCodeHash: contract.runtimeCodeHash,
        },
      ]),
    ),
    controllerPolicy: { registrationsPaused: true },
    marketplacePolicy: { paused: false },
  }];
  return parseDeploymentManifest(value);
}

function pausedCandidate(surface: "registration" | "marketplace") {
  const value = structuredClone(activeManifest(false)) as any;
  if (surface === "registration") {
    value.activationEvidence.controllerPolicy.registrationsPaused = true;
  } else {
    value.activationEvidence.marketplacePolicy.paused = true;
  }
  return parseDeploymentManifest(value);
}

describe("unsigned plans", () => {
  it("never emits native value for ERC-20 authorization", () => {
    const manifest = activeManifest();
    const result = prepareApprovalPlan(manifest, 1_000_000n);
    expect(result.value).toBe(0n);
    expect(result.chainId).toBe(5_042_002);
    expect(result.releaseId).toBe(manifest.releaseId);
    expect(result.to).toBe("0x3600000000000000000000000000000000000000");
  });

  it("cannot emit an approval from a non-active manifest", () => {
    const verified = parseDeploymentManifest(structuredClone(verifiedDeployment));
    expect(() => prepareApprovalPlan(verified, 1_000_000n)).toThrow(/active/);
  });

  it("keeps the private candidate execution path open before the public product-live gate", () => {
    const candidate = activeManifest(false);
    expect(candidate.activationEvidence.productLive).toBe(false);
    expect(prepareApprovalPlan(candidate, 1_000_000n).value).toBe(0n);
  });

  it("builds registration calldata only for an active canonical V2 release", () => {
    const manifest = activeManifest(false);
    const account = "0x1111111111111111111111111111111111111111";
    const identity = deriveNameIdentity("atlas", manifest.namespace.suffix!);
    const permit: RegistrationPermit = {
      chainId: 5_042_002n,
      controller: manifest.contracts.controller.address!,
      releaseId: manifest.releaseId!,
      normalizationProfileHash: manifest.normalization.profileHash,
      normalizedLabelHash: identity.labelhash,
      namehash: identity.namehash,
      requester: account,
      recipient: account,
      payer: account,
      authorizedExecutor: account,
      durationYears: 1n,
      resolverDataHash: resolverDataHash([]),
      referrer: zeroAddress,
      settlementAsset: manifest.settlement.erc20Address,
      expectedAmount: 25_000_000n,
      expectedReferralBps: 500n,
      permitId: `0x${"12".repeat(32)}`,
      nonce: 7n,
      issuedAt: 1_000n,
      validAfter: 995n,
      validUntil: 1_200n,
    };
    const result = prepareRegistrationPlan({
      manifest,
      rawLabel: "atlas",
      normalizationAccepted: false,
      permit,
      signature: `0x${"11".repeat(65)}`,
    });
    expect(result.releaseId).toBe(manifest.releaseId);
    expect(result.to).toBe(manifest.contracts.controller.address);
    expect(result.value).toBe(0n);
  });

  it("builds guarded marketplace plans with zero native value", () => {
    const manifest = activeManifest();
    const plans = [
      prepareMarketplaceApprovalPlan(manifest, 2_000_000n),
      prepareMarketplaceTokenApprovalPlan(manifest, 7n),
      prepareMarketplaceTokenApprovalRevokePlan(manifest, 7n),
      prepareListingPlan(manifest, 7n, 2_000_000n, 2_000_000_000n),
      prepareBuyPlan(manifest, 7n, 2_000_000n, 250),
      prepareCancelListingPlan(manifest, 7n),
      prepareInvalidateListingPlan(manifest, 7n),
      prepareClaimProceedsPlan(manifest),
      prepareClaimReferralPlan(manifest),
    ];
    expect(plans.every((item) => item.value === 0n)).toBe(true);
    expect(plans.every((item) => item.chainId === 5_042_002)).toBe(true);
    expect(plans.every((item) => item.releaseId === manifest.releaseId)).toBe(true);
  });

  it("preserves manifest pause gates while keeping cancellation and claims open", () => {
    const registrationPaused = pausedCandidate("registration");
    expect(() => prepareRegistrationPlan({
      manifest: registrationPaused,
      rawLabel: "alice",
      normalizationAccepted: true,
      permit: {} as RegistrationPermit,
      signature: "0x",
    })).toThrow(/registration is not active/);

    const marketPaused = pausedCandidate("marketplace");
    expect(() => prepareMarketplaceApprovalPlan(marketPaused, 1n)).toThrow(/paused/);
    expect(() => prepareMarketplaceTokenApprovalPlan(marketPaused, 7n)).toThrow(/paused/);
    expect(() => prepareListingPlan(marketPaused, 7n, 1n, 2_000_000_000n)).toThrow(/paused/);
    expect(() => prepareBuyPlan(marketPaused, 7n, 1n, 250)).toThrow(/paused/);
    expect(prepareMarketplaceTokenApprovalRevokePlan(marketPaused, 7n).kind).toBe("approval");
    expect(prepareCancelListingPlan(marketPaused, 7n).kind).toBe("market");
    expect(prepareInvalidateListingPlan(marketPaused, 7n).kind).toBe("market");
    expect(prepareClaimProceedsPlan(marketPaused).kind).toBe("market");
  });

  it("never prepares a new registration against a legacy V1 manifest", () => {
    const value = structuredClone(activeManifest()) as any;
    value.registrarVersion = "v1";
    delete value.nftMetadata;
    delete value.legacyReleases;
    const legacy = parseDeploymentManifest(value);
    expect(() => prepareRegistrationPlan({
      manifest: legacy,
      rawLabel: "alice",
      normalizationAccepted: true,
      permit: {} as RegistrationPermit,
      signature: "0x",
    })).toThrow(/registration is not active/);
  });

  it("builds paused-safe marketplace approval revocation and stale-listing cleanup plans", () => {
    const manifest = pausedCandidate("marketplace");
    const revoke = prepareMarketplaceTokenApprovalRevocationPlan(manifest, 7n);
    expect(revoke.to).toBe(manifest.contracts.baseRegistrar.address);
    expect(revoke.value).toBe(0n);
    expect(decodeFunctionData({ abi: baseRegistrarAbi, data: revoke.data })).toEqual({
      functionName: "approve",
      args: [zeroAddress, 7n],
    });

    const invalidate = prepareInvalidateListingPlan(manifest, 7n);
    expect(invalidate.to).toBe(manifest.contracts.marketplace.address);
    expect(invalidate.value).toBe(0n);
    expect(decodeFunctionData({ abi: marketplaceAbi, data: invalidate.data })).toEqual({
      functionName: "invalidateListing",
      args: [7n],
    });

    expect(() => prepareMarketplaceTokenApprovalRevokePlan(manifest, -1n)).toThrow(/unsigned/);
    expect(() => prepareInvalidateListingPlan(manifest, -1n)).toThrow(/unsigned/);
  });

  it("rejects invalid market price and fee guards", () => {
    const manifest = activeManifest();
    expect(() => prepareBuyPlan(manifest, 1n, 0n, 100)).toThrow(/guard/);
    expect(() => prepareBuyPlan(manifest, 1n, 1n, 1_001)).toThrow(/guard/);
    expect(() => prepareListingPlan(manifest, 1n, 0n, 2_000_000_000n)).toThrow(/terms/);
  });

  it("builds a guarded ERC-721 safe transfer plan", () => {
    const manifest = activeManifest();
    const from = "0x1000000000000000000000000000000000000001";
    const to = "0x2000000000000000000000000000000000000002";
    const result = prepareTransferPlan(manifest, from, to, 7n);
    expect(result.kind).toBe("transfer");
    expect(result.to).toBe(manifest.contracts.baseRegistrar.address);
    expect(result.value).toBe(0n);
    expect(decodeFunctionData({ abi: baseRegistrarAbi, data: result.data })).toEqual({
      functionName: "safeTransferFrom",
      args: [from, to, 7n],
    });

    expect(() => prepareTransferPlan(manifest, from, zeroAddress, 1n)).toThrow(/non-zero/);
    expect(() => prepareTransferPlan(manifest, from, from, 1n)).toThrow(/differ/);
    expect(() => prepareTransferPlan(manifest, from, to, -1n)).toThrow(/unsigned/);
  });

  it("builds and validates a canonical address-record plan", () => {
    const manifest = activeManifest();
    const node = `0x${"12".repeat(32)}` as const;
    const address = "0x1000000000000000000000000000000000000001";
    const result = prepareAddressPlan(manifest, node, address);
    expect(result.kind).toBe("profile");
    expect(result.to).toBe(manifest.contracts.publicResolver.address);
    expect(result.value).toBe(0n);
    expect(decodeFunctionData({ abi: publicResolverAbi, data: result.data })).toEqual({
      functionName: "setAddr",
      args: [node, address],
    });

    const zeroNode = `0x${"00".repeat(32)}` as const;
    expect(() => prepareAddressPlan(manifest, "0x12", address)).toThrow(/bytes32/);
    expect(() => prepareAddressPlan(manifest, zeroNode, address)).toThrow(/non-zero bytes32/);
    expect(() => prepareAddressPlan(manifest, node, zeroAddress)).toThrow(/non-zero/);
  });

  it("builds and validates a normalized primary-name plan", () => {
    const manifest = activeManifest();
    const result = preparePrimaryNamePlan(manifest, "alice.contour");
    expect(result.kind).toBe("profile");
    expect(result.to).toBe(manifest.contracts.reverseRegistrar.address);
    expect(result.value).toBe(0n);
    expect(decodeFunctionData({ abi: reverseRegistrarAbi, data: result.data })).toEqual({
      functionName: "setName",
      args: ["alice.contour"],
    });
    expect(result.description).toMatch(/forward-confirmed primary name/);

    expect(() => preparePrimaryNamePlan(manifest, "alice.eth")).toThrow(/configured \.contour suffix/);
    expect(() => preparePrimaryNamePlan(manifest, "Alice.contour")).toThrow(/normalized/);
    expect(() => preparePrimaryNamePlan(manifest, "nested.alice.contour")).toThrow(/one label/);
  });
});

describe("permit window parity", () => {
  const permit = {
    chainId: 5_042_002n,
    validAfter: 995n,
    issuedAt: 1_000n,
    validUntil: 1_200n,
  } as RegistrationPermit;

  it("accepts at most five seconds of skew and a 300-second total window", () => {
    expect(() => assertPermitWindow(permit, 1_000n)).not.toThrow();
  });

  it("rejects excess clock skew and excess total validity", () => {
    expect(() => assertPermitWindow({ ...permit, validAfter: 994n }, 1_000n)).toThrow(/skew/);
    expect(() => assertPermitWindow({ ...permit, validUntil: 1_296n }, 1_000n)).toThrow(/300/);
  });
});

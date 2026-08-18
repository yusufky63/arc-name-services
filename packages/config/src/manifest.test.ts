import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, parseAbiParameters, sha256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CANONICAL_NFT_METADATA_BASE_URI,
  CANONICAL_NORMALIZATION,
  EXPECTED_RESOLVER_CAPABILITIES,
  assertV2LegacyManifestParity,
  deploymentManifestDigest,
  parseDeploymentManifest,
  promotionExecutionTargetDigest,
  promotionSubjectDigest,
  registrarVersionOf,
  requireActivatedContract,
  requireDeployedContract,
} from "./manifest.js";
import {
  assertPromotionAttestation,
  assertProductLivePromotionAttestation,
  createPromotionAttestation,
  promotionVerificationMode,
} from "./attestation.js";
import {
  assertAllowedPromotionUrl,
  assertApprovedContractRuntimeHash,
  assertArcScanSourceResponse,
  assertExclusiveControllerHistory,
  assertIssuerHealthAuthorization,
  assertIssuerHealthPayload,
  assertPrivateCandidateOrigin,
  assertPrivateCandidateIngressChallenge,
  assertPublicPromotionResolution,
  assertRegistrarMetadataState,
  issuerHealthUrl,
  promotionPassMessage,
  requiredContractAbiFunctions,
  verifySignedPassEnvelope,
  verifyDeploymentPromotion,
  verifyFundedGovernanceAccount,
} from "./promotion.js";

const draft: any = {
  schemaVersion: "1.1.0",
  state: "draft",
  releaseId: null,
  testnet: true,
  chain: {
    id: 5042002,
    caip2: "eip155:5042002",
    rpcUrl: "https://rpc.testnet.arc.network",
    websocketUrl: "wss://rpc.testnet.arc.network",
    explorerUrl: "https://testnet.arcscan.app",
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
    confirmations: 1,
  },
  settlement: {
    symbol: "USDC",
    erc20Address: "0x3600000000000000000000000000000000000000",
    applicationDecimals: 6,
    nativeInterfaceDecimals: 18,
    sharedUnderlyingBalance: true,
  },
  namespace: { brand: null, suffix: null, baseNode: null },
  normalization: { ...CANONICAL_NORMALIZATION },
  contracts: Object.fromEntries(
    ["registry", "baseRegistrar", "controller", "publicResolver", "reverseRegistrar", "universalResolver", "marketplace"].map((key) => [
      key,
      {
        address: null,
        deploymentBlock: null,
        transactionHash: null,
        runtimeCodeHash: null,
        abiUrl: null,
        abiSha256: null,
        sourceVerified: false,
        sourceVerificationUrl: null,
        sourceVerificationSha256: null,
      },
    ]),
  ),
  activationEvidence: {
    productLive: false,
    verifiedAtBlock: null,
    artifacts: {
      deploymentReceipts: { url: null, sha256: null },
      constructorWiring: { url: null, sha256: null },
      governanceRoles: { url: null, sha256: null },
      treasuryControls: { url: null, sha256: null },
      signerPolicy: { url: null, sha256: null },
      releaseAttestation: { url: null, sha256: null },
      fundedEndToEnd: { url: null, sha256: null },
      operationsDrill: { url: null, sha256: null },
    },
    governance: { account: null },
    controllerPolicy: {
      permitSigner: null,
      signerPolicyVersion: null,
      referralBps: null,
      registrationsPaused: null,
    },
    marketplacePolicy: { feeBps: null, paused: null },
  },
  permitIssuer: { url: null, signerAddress: null, publicKey: null, policyVersion: null, active: false },
  resolverCapabilities: Object.fromEntries(Object.keys(EXPECTED_RESOLVER_CAPABILITIES).map((key) => [key, false])),
  discovery: { manifestUrl: null, agentManifestUrl: null, mcpUrl: null, openApiUrl: null },
  bens: { protocolConfigured: false, subgraphSynced: false, apiUrl: null, subgraphUrl: null, hostedArcscanActive: false },
  x402: { active: false, network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000", scheme: "exact", facilitatorUrl: null },
};

function activated() {
  const value = structuredClone(draft);
  value.state = "active";
  value.releaseId = `0x${"99".repeat(32)}`;
  value.namespace = {
    brand: "Contour Name Protocol",
    suffix: "contour",
    baseNode: "0xb0622ac8c513b1e04f26418271b595fae314dbed2e3dea63916fc45cde7c5bbe",
  };
  value.resolverCapabilities = { ...EXPECTED_RESOLVER_CAPABILITIES };
  let index = 1;
  for (const deployment of Object.values(value.contracts) as any[]) {
    deployment.address = `0x${index.toString(16).padStart(40, "0")}`;
    deployment.deploymentBlock = 100 + index;
    deployment.transactionHash = `0x${index.toString(16).padStart(64, "0")}`;
    deployment.runtimeCodeHash = `0x${(index + 10).toString(16).padStart(64, "0")}`;
    deployment.abiUrl = `https://example.com/contract-${index}.json`;
    deployment.abiSha256 = `0x${(index + 20).toString(16).padStart(64, "0")}`;
    deployment.sourceVerified = true;
    deployment.sourceVerificationUrl = `https://testnet.arcscan.app/api/v2/smart-contracts/${deployment.address}`;
    deployment.sourceVerificationSha256 = `0x${(index + 30).toString(16).padStart(64, "0")}`;
    index += 1;
  }
  value.activationEvidence.productLive = true;
  value.activationEvidence.verifiedAtBlock = 200;
  let artifactIndex = 40;
  for (const [key, artifact] of Object.entries(value.activationEvidence.artifacts) as Array<[string, any]>) {
    artifact.url = `https://example.com/evidence/${key}.json`;
    artifact.sha256 = `0x${artifactIndex.toString(16).padStart(64, "0")}`;
    artifactIndex += 1;
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
  return value;
}

function legacyReferenceFixture() {
  return {
    registrarVersion: "v1",
    releaseId: `0x${"88".repeat(32)}`,
    verifiedAtBlock: 100,
    contracts: Object.fromEntries(
      Object.keys(draft.contracts).map((key, index) => [
        key,
        {
          address: `0x${(index + 50).toString(16).padStart(40, "0")}`,
          deploymentBlock: 50 + index,
          runtimeCodeHash: `0x${(index + 80).toString(16).padStart(64, "0")}`,
        },
      ]),
    ),
    controllerPolicy: { registrationsPaused: true },
    marketplacePolicy: { paused: false },
  };
}

function retainedLegacyManifest() {
  const legacy = activated();
  const reference = legacyReferenceFixture();
  legacy.releaseId = reference.releaseId;
  legacy.activationEvidence.productLive = false;
  legacy.activationEvidence.verifiedAtBlock = reference.verifiedAtBlock;
  legacy.activationEvidence.controllerPolicy.registrationsPaused = true;
  legacy.activationEvidence.marketplacePolicy.paused = false;
  for (const [key, contract] of Object.entries(reference.contracts) as Array<[string, any]>) {
    legacy.contracts[key] = {
      ...legacy.contracts[key],
      ...contract,
      sourceVerificationUrl:
        `https://testnet.arcscan.app/api/v2/smart-contracts/${contract.address}`,
    };
  }
  return legacy;
}

describe("deployment manifest", () => {
  it("accepts a fully null draft", () => expect(parseDeploymentManifest(draft).state).toBe("draft"));
  it("keeps field-less legacy manifests on V1 and binds V2 metadata exactly", () => {
    const legacy = parseDeploymentManifest(structuredClone(draft));
    expect(registrarVersionOf(legacy)).toBe("v1");

    const v2 = structuredClone(draft);
    v2.registrarVersion = "v2";
    v2.nftMetadata = { metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI };
    v2.legacyReleases = [legacyReferenceFixture()];
    const parsedV2 = parseDeploymentManifest(v2);
    expect(registrarVersionOf(parsedV2)).toBe("v2");
    expect(parsedV2.nftMetadata?.metadataBaseURI).toBe(CANONICAL_NFT_METADATA_BASE_URI);
    expect(requiredContractAbiFunctions(parsedV2, "baseRegistrar")).toEqual(expect.arrayContaining([
      "metadataBaseURI()",
      "supportsInterface(bytes4)",
      "tokenURI(uint256)",
    ]));
    expect(requiredContractAbiFunctions(legacy, "baseRegistrar")).not.toContain("tokenURI(uint256)");
    expect(() => assertRegistrarMetadataState(
      parsedV2,
      CANONICAL_NFT_METADATA_BASE_URI,
      true,
    )).not.toThrow();
    expect(() => assertRegistrarMetadataState(parsedV2, "https://evil.example/metadata/", true))
      .toThrow(/base URI mismatch/);
    expect(() => assertRegistrarMetadataState(
      parsedV2,
      CANONICAL_NFT_METADATA_BASE_URI,
      false,
    )).toThrow(/ERC-721 Metadata/);

    const missing = structuredClone(v2);
    delete missing.nftMetadata;
    expect(() => parseDeploymentManifest(missing)).toThrow(/requires nftMetadata/);
    const wrong = structuredClone(v2);
    wrong.nftMetadata.metadataBaseURI = "https://metadata.example/api/";
    expect(() => parseDeploymentManifest(wrong)).toThrow(/must equal/);
    const unsafeV1 = structuredClone(draft);
    unsafeV1.registrarVersion = "v1";
    unsafeV1.nftMetadata = { metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI };
    expect(() => parseDeploymentManifest(unsafeV1)).toThrow(/V1 registrar/);

    const missingLegacy = structuredClone(v2);
    delete missingLegacy.legacyReleases;
    expect(() => parseDeploymentManifest(missingLegacy)).toThrow(/exactly one legacy V1/);
    const emptyLegacy = structuredClone(v2);
    emptyLegacy.legacyReleases = [];
    expect(() => parseDeploymentManifest(emptyLegacy)).toThrow(/exactly one legacy V1/);
    const multipleLegacy = structuredClone(v2);
    multipleLegacy.legacyReleases = [
      legacyReferenceFixture(),
      {
        ...legacyReferenceFixture(),
        releaseId: `0x${"87".repeat(32)}`,
      },
    ];
    expect(() => parseDeploymentManifest(multipleLegacy)).toThrow(/exactly one legacy V1/);
  });
  it("validates immutable legacy V1 release references for a V2 cutover", () => {
    const v2 = activated();
    v2.registrarVersion = "v2";
    v2.nftMetadata = { metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI };
    v2.legacyReleases = [legacyReferenceFixture()];
    expect(() => parseDeploymentManifest(v2)).not.toThrow();

    const marketplaceClosed = structuredClone(v2);
    marketplaceClosed.legacyReleases[0].marketplacePolicy.paused = true;
    expect(() => parseDeploymentManifest(marketplaceClosed)).toThrow(/marketplacePolicy.paused/);

    const reusedCurrentContract = structuredClone(v2);
    reusedCurrentContract.legacyReleases[0].contracts.registry.address =
      reusedCurrentContract.contracts.registry.address;
    expect(() => parseDeploymentManifest(reusedCurrentContract)).toThrow(/current V2/);

    const digest = promotionSubjectDigest(parseDeploymentManifest(v2));
    const changedLegacy = structuredClone(v2);
    changedLegacy.legacyReleases[0].contracts.marketplace.runtimeCodeHash = `0x${"77".repeat(32)}`;
    expect(promotionSubjectDigest(parseDeploymentManifest(changedLegacy))).not.toBe(digest);
  });
  it("requires the complete retained V1 manifest to match the V2 reference and cutover policy", () => {
    const canonical = activated();
    canonical.registrarVersion = "v2";
    canonical.nftMetadata = { metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI };
    canonical.legacyReleases = [legacyReferenceFixture()];
    const parsedCanonical = parseDeploymentManifest(canonical);
    const parsedLegacy = parseDeploymentManifest(retainedLegacyManifest());

    expect(assertV2LegacyManifestParity(parsedCanonical, parsedLegacy))
      .toEqual(parsedCanonical.legacyReleases![0]);

    const registrationOpen = retainedLegacyManifest();
    registrationOpen.activationEvidence.controllerPolicy.registrationsPaused = false;
    expect(() => assertV2LegacyManifestParity(
      parsedCanonical,
      parseDeploymentManifest(registrationOpen),
    )).toThrow(/registration policy must be paused/);

    const changedRuntime = retainedLegacyManifest();
    changedRuntime.contracts.marketplace.runtimeCodeHash = `0x${"77".repeat(32)}`;
    expect(() => assertV2LegacyManifestParity(
      parsedCanonical,
      parseDeploymentManifest(changedRuntime),
    )).toThrow(/marketplace identity/);
  });
  it("rejects partial deployment activation", () => {
    const partial = structuredClone(draft) as unknown as { contracts: Record<string, { address: string | null }> };
    partial.contracts.registry!.address = "0x1111111111111111111111111111111111111111";
    expect(() => parseDeploymentManifest(partial)).toThrow(/activate together/);
  });
  it("rejects the wrong chain", () => {
    const wrong = structuredClone(draft);
    wrong.chain.id = 84532;
    expect(() => parseDeploymentManifest(wrong)).toThrow(/Arc Testnet/);
  });
  it("rejects an unknown activation state", () => {
    const unknown = structuredClone(draft);
    unknown.state = "production";
    expect(() => parseDeploymentManifest(unknown)).toThrow(/state must be/);
  });
  it("accepts a structurally complete active record for subsequent live verification", () => {
    expect(parseDeploymentManifest(activated()).state).toBe("active");
    const missing = activated();
    missing.contracts.controller!.sourceVerified = false;
    expect(() => parseDeploymentManifest(missing)).toThrow(/runtime-code, source-verification and ABI evidence/);
  });
  it("rejects legacy active fixtures that merely self-assert source verification", () => {
    const incomplete = activated();
    incomplete.contracts.controller.runtimeCodeHash = null;
    incomplete.contracts.controller.sourceVerificationUrl = null;
    incomplete.contracts.controller.sourceVerificationSha256 = null;
    expect(() => parseDeploymentManifest(incomplete)).toThrow(/runtime-code/);
  });
  it("requires immutable promotion artifacts and a single governance account", () => {
    const missingArtifact = activated();
    missingArtifact.activationEvidence.artifacts.governanceRoles = { url: null, sha256: null };
    expect(() => parseDeploymentManifest(missingArtifact)).toThrow(/governanceRoles/);

    const missingGovernance = activated();
    missingGovernance.activationEvidence.governance.account = null;
    expect(() => parseDeploymentManifest(missingGovernance)).toThrow(/single governance account/);

    const splitSigner = activated();
    splitSigner.activationEvidence.controllerPolicy.permitSigner = "0xa100000000000000000000000000000000000001";
    splitSigner.permitIssuer.signerAddress = "0xa100000000000000000000000000000000000001";
    expect(() => parseDeploymentManifest(splitSigner)).toThrow(/single Arc Testnet governance account/);
  });
  it("requires the normative Release 1 issuer before active promotion", () => {
    const inactiveIssuer = activated();
    inactiveIssuer.permitIssuer.active = false;
    expect(() => parseDeploymentManifest(inactiveIssuer)).toThrow(/dedicated permit issuer/);
  });
  it("requires truthful stateless local-signer health for promotion", () => {
    const live = parseDeploymentManifest(activated());
    const controller = live.contracts.controller.address!;
    const signer = live.permitIssuer.signerAddress!;
    const health = {
      ok: true,
      productLive: true,
      chainId: 5_042_002,
      controller,
      releaseId: live.releaseId,
      normalizationProfileHash: live.normalization.profileHash,
      signerAddress: signer,
      configuredSignerAddress: signer,
      localSignerAddress: signer,
      signerReady: true,
      signerKind: "local-private-key",
      storage: "stateless",
      coordinationScope: "onchain-finality",
      durable: false,
      policyVersion: live.permitIssuer.policyVersion,
      onchainPolicyVersion: live.permitIssuer.policyVersion,
      registrationsPaused: false,
    };
    expect(() => assertIssuerHealthPayload(health, live, controller)).not.toThrow();
    expect(() => assertIssuerHealthPayload({ ...health, localSignerAddress: "0x1111111111111111111111111111111111111111" }, live, controller))
      .toThrow(/issuer health/);
    expect(() => assertIssuerHealthPayload({ ...health, storage: "memory" }, live, controller))
      .toThrow(/issuer health/);
    expect(() => assertIssuerHealthPayload({ ...health, signerReady: false }, live, controller))
      .toThrow(/issuer health/);
    const candidateSourceHealth = {
      ...health,
      productLive: false,
    };
    expect(() => assertIssuerHealthPayload(
      candidateSourceHealth,
      live,
      controller,
      "authenticated-private-candidate-source",
    )).not.toThrow();
    expect(() => assertIssuerHealthPayload(
      health,
      live,
      controller,
      "authenticated-private-candidate-source",
    )).toThrow(/issuer health/);
  });
  it("supports a private active candidate without fabricating funded or operations evidence", () => {
    const candidate = activated();
    candidate.activationEvidence.productLive = false;
    candidate.activationEvidence.artifacts.fundedEndToEnd = { url: null, sha256: null };
    candidate.activationEvidence.artifacts.operationsDrill = { url: null, sha256: null };
    expect(parseDeploymentManifest(candidate).activationEvidence.productLive).toBe(false);

    candidate.activationEvidence.productLive = true;
    expect(() => parseDeploymentManifest(candidate)).toThrow(/fundedEndToEnd|operationsDrill/);
  });
  it("allows both pause controls during private bootstrap but never in product-live", () => {
    const candidate = activated();
    candidate.activationEvidence.productLive = false;
    candidate.activationEvidence.artifacts.fundedEndToEnd = { url: null, sha256: null };
    candidate.activationEvidence.artifacts.operationsDrill = { url: null, sha256: null };
    candidate.activationEvidence.controllerPolicy.registrationsPaused = true;
    candidate.activationEvidence.marketplacePolicy.paused = true;
    expect(() => parseDeploymentManifest(candidate)).not.toThrow();

    const registrationPausedLive = activated();
    registrationPausedLive.activationEvidence.controllerPolicy.registrationsPaused = true;
    expect(() => parseDeploymentManifest(registrationPausedLive)).toThrow(/product-live.*paused/i);

    const marketplacePausedLive = activated();
    marketplacePausedLive.activationEvidence.marketplacePolicy.paused = true;
    expect(() => parseDeploymentManifest(marketplacePausedLive)).toThrow(/product-live.*paused/i);
  });
  it("uses a digest-bound bootstrap attestation only for an explicit private candidate", () => {
    const candidateValue = activated();
    candidateValue.activationEvidence.productLive = false;
    candidateValue.activationEvidence.artifacts.fundedEndToEnd = { url: null, sha256: null };
    candidateValue.activationEvidence.artifacts.operationsDrill = { url: null, sha256: null };
    const candidate = parseDeploymentManifest(candidateValue);
    const bootstrap = createPromotionAttestation(candidate, null);

    expect(promotionVerificationMode(candidate, true)).toBe("bootstrap");
    expect(promotionVerificationMode(candidate, false)).toBe("live");
    expect(promotionVerificationMode(parseDeploymentManifest(activated()), false)).toBe("attested-live");
    expect(() => assertPromotionAttestation(bootstrap, candidate, false)).not.toThrow();
    expect(() => assertPromotionAttestation(bootstrap, candidate, true)).toThrow(/live verification/);

    const changed = structuredClone(candidateValue);
    changed.activationEvidence.marketplacePolicy.feeBps += 1;
    expect(() => assertPromotionAttestation(
      bootstrap,
      parseDeploymentManifest(changed),
      false,
    )).toThrow(/digest mismatch/);

    expect(() => promotionVerificationMode(parseDeploymentManifest(activated()), true))
      .toThrow(/private candidate bootstrap/);
    expect(() => promotionVerificationMode(parseDeploymentManifest({ ...draft }), true))
      .toThrow(/private candidate bootstrap/);
  });
  it("keeps bootstrap/live attestation phase metadata internally consistent", () => {
    const live = parseDeploymentManifest(activated());
    const bootstrap = createPromotionAttestation(live, null);
    expect(() => assertPromotionAttestation(
      { ...bootstrap, checkedAtBlock: "201" },
      live,
      false,
    )).toThrow(/same verification phase/);
    expect(() => assertPromotionAttestation(
      { ...bootstrap, liveVerified: true, checkedAtBlock: "1" },
      live,
      true,
    )).toThrow(/cannot precede/);
  });
  it("requires an active product-live manifest for product runtime attestations", () => {
    const live = parseDeploymentManifest(activated());
    const liveAttestation = createPromotionAttestation(live, "201");
    expect(() => assertProductLivePromotionAttestation(liveAttestation, live)).not.toThrow();

    const candidateValue = activated();
    candidateValue.activationEvidence.productLive = false;
    candidateValue.activationEvidence.artifacts.fundedEndToEnd = { url: null, sha256: null };
    candidateValue.activationEvidence.artifacts.operationsDrill = { url: null, sha256: null };
    const candidate = parseDeploymentManifest(candidateValue);
    expect(() => assertProductLivePromotionAttestation(
      createPromotionAttestation(candidate, "201"),
      candidate,
    )).toThrow(/active product-live/);

    const verifiedValue = structuredClone(candidateValue);
    verifiedValue.state = "verified";
    verifiedValue.permitIssuer.active = false;
    const verified = parseDeploymentManifest(verifiedValue);
    expect(() => assertProductLivePromotionAttestation(
      createPromotionAttestation(verified, "201"),
      verified,
    )).toThrow(/active product-live/);

    expect(() => assertProductLivePromotionAttestation(
      createPromotionAttestation(live, null),
      live,
    )).toThrow(/live verification/);
  });
  it("binds baseNode to the suffix", () => {
    const mismatched = activated();
    mismatched.namespace.baseNode = `0x${"12".repeat(32)}`;
    expect(() => parseDeploymentManifest(mismatched)).toThrow(/baseNode/);
  });
  it("binds active releases to the pinned normalization profile", () => {
    const mismatched = activated();
    mismatched.normalization.profileHash = `0x${"12".repeat(32)}`;
    expect(() => parseDeploymentManifest(mismatched)).toThrow(/canonical pinned profile/);
  });
  it("binds verified capability claims to the implemented resolver", () => {
    const mismatched = activated();
    mismatched.resolverCapabilities.addr = false;
    expect(() => parseDeploymentManifest(mismatched)).toThrow(/verified resolver surface/);
  });
  it("refuses execution targets until the release is active", () => {
    const configured = activated();
    configured.state = "configured";
    configured.activationEvidence.productLive = false;
    for (const deployment of Object.values(configured.contracts) as any[]) {
      deployment.sourceVerified = false;
      deployment.abiUrl = null;
      deployment.abiSha256 = null;
    }
    configured.permitIssuer.active = false;
    const parsed = parseDeploymentManifest(configured);
    expect(() => requireActivatedContract(parsed, "controller")).toThrow(/not active/);
  });
  it("allows source-verified configured deployments for read-only calls", () => {
    const configured = activated();
    configured.state = "configured";
    configured.activationEvidence.productLive = false;
    configured.activationEvidence.verifiedAtBlock = null;
    for (const artifact of Object.values(configured.activationEvidence.artifacts) as any[]) {
      artifact.url = null;
      artifact.sha256 = null;
    }
    configured.permitIssuer.active = false;

    const parsed = parseDeploymentManifest(configured);
    expect(requireDeployedContract(parsed, "controller")).toBe(
      parsed.contracts.controller.address,
    );
    expect(() => requireActivatedContract(parsed, "controller")).toThrow(/not active/);
  });
  it("refuses draft and unverified configured deployments for read-only calls", () => {
    const parsedDraft = parseDeploymentManifest(structuredClone(draft));
    expect(() => requireDeployedContract(parsedDraft, "controller")).toThrow(
      /not a source-verified deployment/,
    );

    const configured = activated();
    configured.state = "configured";
    configured.activationEvidence.productLive = false;
    configured.activationEvidence.verifiedAtBlock = null;
    configured.contracts.controller.sourceVerified = false;
    for (const artifact of Object.values(configured.activationEvidence.artifacts) as any[]) {
      artifact.url = null;
      artifact.sha256 = null;
    }
    configured.permitIssuer.active = false;
    const parsedConfigured = parseDeploymentManifest(configured);
    expect(() => requireDeployedContract(parsedConfigured, "controller")).toThrow(
      /not a source-verified deployment/,
    );
  });
  it("allows active x402 with a valid facilitator URL and requires facilitator URL", () => {
    const valid = activated();
    valid.x402.active = true;
    valid.x402.facilitatorUrl = "https://gateway.circle.com";
    expect(parseDeploymentManifest(valid).x402.active).toBe(true);

    const missingUrl = activated();
    missingUrl.x402.active = true;
    missingUrl.x402.facilitatorUrl = null;
    expect(() => parseDeploymentManifest(missingUrl)).toThrow(/requires a facilitator URL/);
  });
  it("rejects a non-string x402 asset with a validation error", () => {
    const malformed = structuredClone(draft);
    malformed.x402.asset = 42;
    expect(() => parseDeploymentManifest(malformed)).toThrow(/x402 Arc network, asset or scheme mismatch/);
  });
  it("rejects a zero permit signer", () => {
    const unsafe = activated();
    unsafe.permitIssuer.signerAddress = "0x0000000000000000000000000000000000000000";
    unsafe.activationEvidence.controllerPolicy.permitSigner = "0x0000000000000000000000000000000000000000";
    expect(() => parseDeploymentManifest(unsafe)).toThrow(/non-zero|zero address/);
  });
  it("requires seven distinct protocol contract addresses", () => {
    const unsafe = activated();
    unsafe.contracts.controller.address = unsafe.contracts.registry.address;
    expect(() => parseDeploymentManifest(unsafe)).toThrow(/reuses/);
  });
  it("refuses BENS activation before the protocol release is active", () => {
    const premature = structuredClone(draft);
    premature.bens.protocolConfigured = true;
    premature.bens.apiUrl = "https://bens.example.com";
    premature.bens.subgraphUrl = "https://graph.example.com";
    expect(() => parseDeploymentManifest(premature)).toThrow(/BENS/);
  });
  it("refuses live promotion checks for a draft before touching RPC", async () => {
    await expect(verifyDeploymentPromotion(draft)).rejects.toThrow(/structurally verified/);
  });
  it("fails live promotion on an RPC chain mismatch before fetching evidence", async () => {
    const publicClient = {
      getChainId: async () => 1,
      getBlockNumber: async () => 200n,
    };
    await expect(verifyDeploymentPromotion(activated(), { publicClient: publicClient as never }))
      .rejects.toThrow(/RPC returned chain 1/);
  });
  it("keeps legacy issuer credentials bounded without requiring them for public health", async () => {
    const authorization = `Basic ${btoa(`user:${"p".repeat(32)}`)}`;
    const publicClient = {
      getChainId: async () => 1,
      getBlockNumber: async () => 200n,
    };
    expect(assertIssuerHealthAuthorization(undefined)).toBeUndefined();
    expect(assertIssuerHealthAuthorization(authorization)).toBe(authorization);
    expect(() => assertIssuerHealthAuthorization("Basic dXNlcjpwYXNzd29yZA=="))
      .toThrow(/bounded Basic/);
    expect(() => assertIssuerHealthAuthorization("Bearer secret")).toThrow(/bounded Basic/);
    expect(() => assertIssuerHealthAuthorization("Basic abc\r\nX-Leak: yes"))
      .toThrow(/bounded Basic/);

    await expect(verifyDeploymentPromotion(activated(), {
      issuerHealthAuthorization: authorization,
      publicClient: publicClient as never,
    })).rejects.toThrow(/requires an explicit private candidate origin/);

    await expect(verifyDeploymentPromotion(activated(), {
      allowAuthenticatedPrivateCandidateSource: true,
      publicClient: publicClient as never,
    })).rejects.toThrow(/requires bounded Basic credentials/);

    await expect(verifyDeploymentPromotion(activated(), {
      issuerHealthAuthorization: authorization,
      allowAuthenticatedPrivateCandidateSource: true,
      publicClient: publicClient as never,
    })).rejects.toThrow(/requires an explicit private candidate origin/);

    await expect(verifyDeploymentPromotion(activated(), {
      issuerHealthAuthorization: authorization,
      privateCandidateOrigin: "https://candidate.example",
      allowedFetchHosts: ["candidate.example"],
      allowAuthenticatedPrivateCandidateSource: true,
      publicClient: publicClient as never,
    })).rejects.toThrow(/RPC returned chain 1/);

    await expect(verifyDeploymentPromotion(activated(), {
      privateCandidateOrigin: "https://candidate.example",
      allowedFetchHosts: ["candidate.example"],
      publicClient: publicClient as never,
    })).rejects.toThrow(/requires bounded Basic credentials/);

    const candidateValue = activated();
    candidateValue.activationEvidence.productLive = false;
    candidateValue.activationEvidence.artifacts.fundedEndToEnd = { url: null, sha256: null };
    candidateValue.activationEvidence.artifacts.operationsDrill = { url: null, sha256: null };
    const candidate = parseDeploymentManifest(candidateValue);
    await expect(verifyDeploymentPromotion(candidate, { publicClient: publicClient as never }))
      .rejects.toThrow(/RPC returned chain 1/);
    await expect(verifyDeploymentPromotion(candidate, {
      issuerHealthAuthorization: authorization,
      publicClient: publicClient as never,
    })).rejects.toThrow(/requires an explicit private candidate origin/);

    const candidateOrigin = assertPrivateCandidateOrigin(
      "https://candidate.example/",
      ["candidate.example"],
    );
    const candidateWithCanonicalIssuer = parseDeploymentManifest({
      ...candidateValue,
      permitIssuer: {
        ...candidateValue.permitIssuer,
        url: "https://contour.example.com/api/registration/issuer/",
      },
    });
    expect(candidateOrigin?.origin).toBe("https://candidate.example");
    expect(issuerHealthUrl(candidateWithCanonicalIssuer, candidateOrigin).href)
      .toBe("https://candidate.example/api/registration/issuer/healthz");
    expect(issuerHealthUrl(candidateWithCanonicalIssuer).href)
      .toBe("https://contour.example.com/api/registration/issuer/healthz");
    expect(() => assertPrivateCandidateOrigin(
      "https://candidate.example/private",
      ["candidate.example"],
    )).toThrow(/must not contain a path/);
    expect(() => assertPrivateCandidateOrigin(
      "https://candidate.example/?token=secret",
      ["candidate.example"],
    )).toThrow(/must not contain a path, query or fragment/);
    expect(() => assertPrivateCandidateOrigin(
      "http://candidate.example",
      ["candidate.example"],
    )).toThrow(/not safe/);
    expect(() => assertPrivateCandidateOrigin(
      "https://user:password@candidate.example",
      ["candidate.example"],
    )).toThrow(/not safe/);
    expect(() => assertPrivateCandidateOrigin(
      "https://unlisted.example",
      ["candidate.example"],
    )).toThrow(/operator-allowlisted/);

    expect(() => assertPrivateCandidateIngressChallenge(new Response(null, {
      status: 401,
      headers: {
        "cache-control": "no-store, max-age=0",
        "www-authenticate": 'Basic realm="Contour private candidate"',
      },
    }))).not.toThrow();
    expect(() => assertPrivateCandidateIngressChallenge(new Response(null, { status: 200 })))
      .toThrow(/reject unauthenticated requests/);
    expect(() => assertPrivateCandidateIngressChallenge(new Response(null, {
      status: 401,
      headers: { "www-authenticate": 'Basic realm="Contour private candidate"' },
    }))).toThrow(/reject unauthenticated requests/);
  });
  it("rejects any hidden registrar controller even if it is later disabled", () => {
    const canonical = "0x1111111111111111111111111111111111111111";
    const hidden = "0x2222222222222222222222222222222222222222";
    expect(() => assertExclusiveControllerHistory([
      { controller: canonical, enabled: true },
      { controller: hidden, enabled: true },
      { controller: hidden, enabled: false },
    ], canonical)).toThrow(/non-canonical registrar controller/);
    expect(() => assertExclusiveControllerHistory([
      { controller: canonical, enabled: true },
    ], canonical)).not.toThrow();
  });
  it("allows promotion fetches only to explicit public HTTPS hosts", () => {
    expect(() => assertAllowedPromotionUrl("https://evidence.example.com/a.json", ["evidence.example.com"]))
      .not.toThrow();
    expect(() => assertAllowedPromotionUrl("https://unlisted.example.com/a.json", ["evidence.example.com"]))
      .toThrow(/operator-allowlisted/);
    expect(() => assertAllowedPromotionUrl("https://127.0.0.1/a.json", ["127.0.0.1"]))
      .toThrow(/not safe|invalid evidence hostname/);
  });
  it("rejects DNS rebinding to mapped, multicast and documentation IPv6 space", async () => {
    const url = new URL("https://evidence.example.com/a.json");
    for (const rebound of ["::ffff:127.0.0.1", "ff02::1", "2001:db8::1"]) {
      await expect(assertPublicPromotionResolution(url, async () => [rebound]))
        .rejects.toThrow(/public addresses/);
    }
  });
  it("requires the single governance address to be a funded EOA", async () => {
    const account = "0x1111111111111111111111111111111111111111";
    const blockNumber = 123n;
    const fundedEoa = {
      getCode: async (request: { blockNumber?: bigint }) => {
        expect(request.blockNumber).toBe(blockNumber);
        return "0x" as const;
      },
      getBalance: async (request: { blockNumber?: bigint }) => {
        expect(request.blockNumber).toBe(blockNumber);
        return 1n;
      },
    };
    await expect(verifyFundedGovernanceAccount(fundedEoa as never, account, blockNumber)).resolves.toBe(1n);
    await expect(verifyFundedGovernanceAccount({
      getCode: async () => "0x6000",
      getBalance: async () => 1n,
    } as never, account, blockNumber)).rejects.toThrow(/EOA/);
    await expect(verifyFundedGovernanceAccount({
      getCode: async () => "0x",
      getBalance: async () => 0n,
    } as never, account, blockNumber)).rejects.toThrow(/positive/);
  });
  it("requires every protocol runtime hash to match an independent reviewed build", () => {
    const hash = `0x${"12".repeat(32)}` as const;
    expect(() => assertApprovedContractRuntimeHash("controller", hash, { controller: hash })).not.toThrow();
    expect(() => assertApprovedContractRuntimeHash("controller", hash, {})).toThrow(/reproducible build/);
    expect(() => assertApprovedContractRuntimeHash("controller", hash, {
      controller: `0x${"13".repeat(32)}`,
    })).toThrow(/reproducible build/);
  });
  it("parses ArcScan source verification semantics instead of trusting a self-claim", () => {
    const live = parseDeploymentManifest(activated());
    const deployedBytecode = "0x6000" as const;
    live.contracts.registry.runtimeCodeHash = keccak256(deployedBytecode);
    const response = {
      file_path: "src/ArcNameRegistry.sol",
      creation_status: "success",
      source_code: "contract ArcNameRegistry {}",
      deployed_bytecode: deployedBytecode,
      optimization_enabled: true,
      is_verified: true,
      compiler_settings: {
        evmVersion: "cancun",
        metadata: { appendCBOR: false, bytecodeHash: "none" },
        optimizer: { enabled: true, runs: 10_000 },
        viaIR: false,
      },
      optimization_runs: 10_000,
      compiler_version: "v0.8.24+commit.e11b9ed9",
      name: "ArcNameRegistry",
      language: "solidity",
      evm_version: "cancun",
      constructor_args: encodeAbiParameters(
        parseAbiParameters("address"),
        [live.activationEvidence.governance.account!],
      ),
    };
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    expect(() => assertArcScanSourceResponse(encode(response), live, "registry")).not.toThrow();
    expect(() => assertArcScanSourceResponse(encode({ ...response, is_verified: false }), live, "registry"))
      .toThrow(/semantics/);
    expect(() => assertArcScanSourceResponse(encode({
      ...response,
      constructor_args: `0x${"00".repeat(32)}`,
    }), live, "registry")).toThrow(/constructor arguments/);
    expect(() => assertArcScanSourceResponse(encode({
      ...response,
      deployed_bytecode: "0x6001",
    }), live, "registry")).toThrow(/deployed bytecode/);
  });
  it("binds V2 ArcScan identity and four-argument metadata constructor", () => {
    const value = activated();
    value.registrarVersion = "v2";
    value.nftMetadata = { metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI };
    value.legacyReleases = [legacyReferenceFixture()];
    const live = parseDeploymentManifest(value);
    const deployedBytecode = "0x6002" as const;
    live.contracts.baseRegistrar.runtimeCodeHash = keccak256(deployedBytecode);
    const response = {
      file_path: "src/ArcBaseRegistrarV2.sol",
      creation_status: "success",
      source_code: "contract ArcBaseRegistrarV2 {}",
      deployed_bytecode: deployedBytecode,
      optimization_enabled: true,
      is_verified: true,
      compiler_settings: {
        evmVersion: "cancun",
        metadata: { appendCBOR: false, bytecodeHash: "none" },
        optimizer: { enabled: true, runs: 10_000 },
        viaIR: false,
      },
      optimization_runs: 10_000,
      compiler_version: "v0.8.24+commit.e11b9ed9",
      name: "ArcBaseRegistrarV2",
      language: "solidity",
      evm_version: "cancun",
      constructor_args: encodeAbiParameters(
        parseAbiParameters("address, bytes32, address, string"),
        [
          live.contracts.registry.address!,
          live.namespace.baseNode!,
          live.activationEvidence.governance.account!,
          CANONICAL_NFT_METADATA_BASE_URI,
        ],
      ),
    };
    const encode = (input: unknown) => new TextEncoder().encode(JSON.stringify(input));
    expect(() => assertArcScanSourceResponse(
      encode(response),
      live,
      "baseRegistrar",
    )).not.toThrow();
    expect(() => assertArcScanSourceResponse(
      encode({ ...response, name: "ArcBaseRegistrar" }),
      live,
      "baseRegistrar",
    )).toThrow(/semantics/);
    expect(() => assertArcScanSourceResponse(
      encode({
        ...response,
        constructor_args: encodeAbiParameters(
          parseAbiParameters("address, bytes32, address, string"),
          [
            live.contracts.registry.address!,
            live.namespace.baseNode!,
            live.activationEvidence.governance.account!,
            "https://metadata.example/api/",
          ],
        ),
      }),
      live,
      "baseRegistrar",
    )).toThrow(/constructor arguments/);
  });
  it("signs a non-circular promotion subject while binding all release-critical fields", async () => {
    const live = parseDeploymentManifest(activated());
    const originalSubject = promotionSubjectDigest(live);
    const relocated = structuredClone(live);
    relocated.activationEvidence.artifacts.fundedEndToEnd = {
      url: "https://evidence.example.com/new-funded.json",
      sha256: `0x${"77".repeat(32)}`,
    };
    relocated.activationEvidence.artifacts.operationsDrill = {
      url: "https://evidence.example.com/new-ops.json",
      sha256: `0x${"78".repeat(32)}`,
    };
    expect(promotionSubjectDigest(relocated)).toBe(originalSubject);
    relocated.contracts.controller.runtimeCodeHash = `0x${"79".repeat(32)}`;
    expect(promotionSubjectDigest(relocated)).not.toBe(originalSubject);

    const reviewer = privateKeyToAccount(`0x${"02".repeat(32)}`);
    const seller = "0xa100000000000000000000000000000000000001";
    const buyer = "0xb100000000000000000000000000000000000001";
    const transactionTargets = {
      registrationUsdcApproval: live.settlement.erc20Address,
      registration: live.contracts.controller.address!,
      sellerNftApproval: live.contracts.baseRegistrar.address!,
      firstListing: live.contracts.marketplace.address!,
      firstCancellation: live.contracts.marketplace.address!,
      secondListing: live.contracts.marketplace.address!,
      buyerUsdcApproval: live.settlement.erc20Address,
      purchase: live.contracts.marketplace.address!,
      sellerClaimProceeds: live.contracts.marketplace.address!,
      buyerNftApproval: live.contracts.baseRegistrar.address!,
      buyerRelisting: live.contracts.marketplace.address!,
      buyerDirectTransfer: live.contracts.baseRegistrar.address!,
      listingInvalidation: live.contracts.marketplace.address!,
    } as const;
    const transactions = Object.entries(transactionTargets).map(([id, to], index) => ({
      id,
      hash: `0x${(index + 500).toString(16).padStart(64, "0")}` as const,
      blockNumber: 201 + index,
      from: id === "buyerUsdcApproval" || id === "purchase" || id === "buyerNftApproval" || id === "buyerRelisting" ||
        id === "buyerDirectTransfer" || id === "listingInvalidation" ? buyer : seller,
      to,
    }));
    const assertionIds = [
      "registrationPermitConsumed", "registrationNonceIncremented", "registrationSettlementExact",
      "registrarOwner", "registryOwner", "resolverAddress", "marketplacePurchase",
      "sellerProceedsClaimed", "marketplaceLiability", "marketplaceSolvent", "staleListingInvalidated",
    ];
    const registrationPredecessor = structuredClone(live);
    registrationPredecessor.activationEvidence.productLive = false;
    registrationPredecessor.activationEvidence.verifiedAtBlock = 180;
    registrationPredecessor.activationEvidence.marketplacePolicy.paused = true;
    registrationPredecessor.activationEvidence.artifacts.fundedEndToEnd = { url: null, sha256: null };
    registrationPredecessor.activationEvidence.artifacts.operationsDrill = { url: null, sha256: null };
    const registrationActivationSmoke = {
      schemaVersion: "1.0.0" as const,
      artifact: "registrationActivationSmoke" as const,
      candidateManifestSha256: deploymentManifestDigest(registrationPredecessor),
      candidateVerifiedAtBlock: 180,
      evidenceBlock: 190,
      evidenceBlockHash: `0x${"81".repeat(32)}` as const,
      registrant: buyer,
      registrationTransactionHash: `0x${"82".repeat(32)}` as const,
      reportSha256: `0x${"83".repeat(32)}` as const,
    };
    const report = {
      schemaVersion: "1.0.0" as const,
      artifact: "fundedEndToEnd" as const,
      verdict: "PASS" as const,
      chainId: 5_042_002 as const,
      releaseId: live.releaseId!,
      promotionSubjectSha256: originalSubject,
      verifiedAtBlock: live.activationEvidence.verifiedAtBlock!,
      evidenceBlock: 220,
      generatedAt: "2026-07-17T12:00:00.000Z",
      registrationActivationSmoke,
      transactions,
      assertions: assertionIds.map((id) => ({
        id,
        verdict: "PASS" as const,
        source: "rpc" as const,
        expected: "verified",
        actual: "verified",
      })),
      redactions: {
        privateKeys: false as const,
        challengeSecrets: false as const,
        walletSignatures: false as const,
        permitSignatures: false as const,
      },
    };
    const reportBytes = new TextEncoder().encode(JSON.stringify(report));
    const unsigned = {
      schemaVersion: "1.1.0" as const,
      artifact: "fundedEndToEnd" as const,
      verdict: "PASS" as const,
      chainId: 5_042_002 as const,
      releaseId: live.releaseId!,
      promotionSubjectSha256: originalSubject,
      verifiedAtBlock: live.activationEvidence.verifiedAtBlock!,
      evidenceBlock: report.evidenceBlock,
      runReportUrl: "https://evidence.example.com/runs/funded.json",
      runReportSha256: sha256(reportBytes),
      reviewer: reviewer.address,
    };
    const signature = await reviewer.signMessage({ message: promotionPassMessage(unsigned) });
    const bytes = new TextEncoder().encode(JSON.stringify({ ...unsigned, signature }));
    const publicClient = {
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
        expect(blockNumber).toBe(BigInt(registrationActivationSmoke.evidenceBlock));
        return {
          number: blockNumber,
          hash: registrationActivationSmoke.evidenceBlockHash,
        };
      },
      getTransactionReceipt: async ({ hash }: { hash: string }) => {
        if (hash === registrationActivationSmoke.registrationTransactionHash) {
          return {
            status: "success" as const,
            blockNumber: 185n,
            from: registrationActivationSmoke.registrant,
            to: live.contracts.controller.address!,
          };
        }
        const transaction = transactions.find((candidate) => candidate.hash === hash)!;
        return {
          status: "success" as const,
          blockNumber: BigInt(transaction.blockNumber),
          from: transaction.from,
          to: transaction.to,
        };
      },
    };
    const fetcher = async (input: string | URL | Request) => {
      expect(String(input)).toBe(unsigned.runReportUrl);
      return new Response(reportBytes, { status: 200 });
    };
    const verifyResignedReport = async (
      candidateReport: unknown,
      candidateClient: typeof publicClient = publicClient,
    ) => {
      const candidateReportBytes = new TextEncoder().encode(JSON.stringify(candidateReport));
      const candidateUnsigned = {
        ...unsigned,
        runReportSha256: sha256(candidateReportBytes),
      };
      const candidateSignature = await reviewer.signMessage({
        message: promotionPassMessage(candidateUnsigned),
      });
      return verifySignedPassEnvelope(
        new TextEncoder().encode(JSON.stringify({ ...candidateUnsigned, signature: candidateSignature })),
        "fundedEndToEnd",
        live,
        BigInt(candidateUnsigned.evidenceBlock),
        [reviewer.address],
        {
          publicClient: candidateClient as never,
          fetcher: (async () => new Response(candidateReportBytes, { status: 200 })) as typeof fetch,
          allowedFetchHosts: ["evidence.example.com"],
        },
      );
    };
    await expect(verifySignedPassEnvelope(
      bytes,
      "fundedEndToEnd",
      live,
      BigInt(unsigned.evidenceBlock),
      [reviewer.address],
      {
        publicClient: publicClient as never,
        fetcher: fetcher as typeof fetch,
        allowedFetchHosts: ["evidence.example.com"],
      },
    )).resolves.toBe(reviewer.address);

    const missingSmokeBinding = structuredClone(report) as Partial<typeof report>;
    delete missingSmokeBinding.registrationActivationSmoke;
    await expect(verifyResignedReport(missingSmokeBinding)).rejects.toThrow(/unexpected fields/);

    const wrongPredecessor = structuredClone(report);
    wrongPredecessor.registrationActivationSmoke.candidateManifestSha256 = `0x${"84".repeat(32)}`;
    await expect(verifyResignedReport(wrongPredecessor)).rejects.toThrow(/predecessor digest mismatch/);

    const zeroSmokeReportHash = structuredClone(report);
    zeroSmokeReportHash.registrationActivationSmoke.reportSha256 = `0x${"00".repeat(32)}`;
    await expect(verifyResignedReport(zeroSmokeReportHash)).rejects.toThrow(/binding is invalid/);

    const outOfInterval = structuredClone(report);
    outOfInterval.registrationActivationSmoke.evidenceBlock = report.verifiedAtBlock;
    await expect(verifyResignedReport(outOfInterval)).rejects.toThrow(/binding is invalid/);

    const wrongSmokeSenderClient = {
      ...publicClient,
      getTransactionReceipt: async (input: { hash: string }) => {
        const receipt = await publicClient.getTransactionReceipt(input);
        return input.hash === registrationActivationSmoke.registrationTransactionHash
          ? { ...receipt, from: seller }
          : receipt;
      },
    };
    await expect(verifyResignedReport(report, wrongSmokeSenderClient)).rejects.toThrow(/receipt mismatch/);

    const wrongEvidenceBlockClient = {
      ...publicClient,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        number: blockNumber,
        hash: `0x${"85".repeat(32)}` as const,
      }),
    };
    await expect(verifyResignedReport(report, wrongEvidenceBlockClient)).rejects.toThrow(/evidence block mismatch/);

    const incompleteReport = structuredClone(report);
    incompleteReport.transactions.pop();
    const incompleteBytes = new TextEncoder().encode(JSON.stringify(incompleteReport));
    await expect(verifySignedPassEnvelope(
      bytes,
      "fundedEndToEnd",
      live,
      BigInt(unsigned.evidenceBlock),
      [reviewer.address],
      {
        publicClient: publicClient as never,
        fetcher: (async () => new Response(incompleteBytes, { status: 200 })) as typeof fetch,
        allowedFetchHosts: ["evidence.example.com"],
      },
    )).rejects.toThrow(/SHA-256 mismatch/);
  });

  it("gives market-open candidates and later product-live targets one public-intent execution identity", () => {
    const target = parseDeploymentManifest(activated());
    const candidateValue = structuredClone(target);
    candidateValue.activationEvidence.productLive = false;
    candidateValue.activationEvidence.verifiedAtBlock = target.activationEvidence.verifiedAtBlock! - 1;
    candidateValue.activationEvidence.artifacts.fundedEndToEnd = { url: null, sha256: null };
    candidateValue.activationEvidence.artifacts.operationsDrill = { url: null, sha256: null };
    const candidate = parseDeploymentManifest(candidateValue);

    expect(promotionExecutionTargetDigest(candidate)).toBe(promotionExecutionTargetDigest(target));
    expect(promotionSubjectDigest(candidate)).not.toBe(promotionSubjectDigest(target));

    const reorderedTarget = Object.fromEntries(Object.entries(target).reverse()) as unknown as typeof target;
    expect(promotionExecutionTargetDigest(reorderedTarget)).toBe(promotionExecutionTargetDigest(target));

    const changedPolicy = structuredClone(target);
    changedPolicy.activationEvidence.marketplacePolicy.feeBps! += 1;
    expect(promotionExecutionTargetDigest(changedPolicy)).not.toBe(promotionExecutionTargetDigest(target));

    const changedContract = structuredClone(target);
    changedContract.contracts.controller.runtimeCodeHash = `0x${"ab".repeat(32)}`;
    expect(promotionExecutionTargetDigest(changedContract)).not.toBe(promotionExecutionTargetDigest(target));
  });
  it("re-fetches the operations report and binds it to the exact drill receipts", async () => {
    const live = parseDeploymentManifest(activated());
    const reviewer = privateKeyToAccount(`0x${"03".repeat(32)}`);
    const transactionTargets = {
      controllerPause: live.contracts.controller.address!,
      controllerUnpause: live.contracts.controller.address!,
      marketplacePause: live.contracts.marketplace.address!,
      marketplaceUnpause: live.contracts.marketplace.address!,
    } as const;
    const transactions = Object.entries(transactionTargets).map(([id, to], index) => ({
      id,
      hash: `0x${(index + 800).toString(16).padStart(64, "0")}` as const,
      blockNumber: 210 + index,
      from: live.activationEvidence.governance.account!,
      to,
    }));
    const promotionSubjectSha256 = promotionSubjectDigest(live);
    const evidenceBlock = 213;
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const assertions = [
      "registrationReadinessClosed", "registrationReadinessRecovered",
      "marketplaceReadinessClosed", "marketplaceReadinessRecovered", "rollbackRepaused",
    ].map((id) => ({
      id,
      verdict: "PASS" as const,
      source: "rpc" as const,
      expected: "verified",
      actual: "verified",
    }));
    const makeSignedArtifact = async (reportTransactions = transactions) => {
      const report = {
        schemaVersion: "1.0.0" as const,
        artifact: "operationsDrill" as const,
        verdict: "PASS" as const,
        chainId: 5_042_002 as const,
        releaseId: live.releaseId!,
        promotionSubjectSha256,
        verifiedAtBlock: live.activationEvidence.verifiedAtBlock!,
        evidenceBlock,
        generatedAt: "2026-07-17T12:01:00.000Z",
        transactions: reportTransactions,
        assertions,
        redactions: {
          privateKeys: false as const,
          challengeSecrets: false as const,
          walletSignatures: false as const,
          permitSignatures: false as const,
        },
      };
      const reportBytes = encode(report);
      const unsigned = {
        schemaVersion: "1.1.0" as const,
        artifact: "operationsDrill" as const,
        verdict: "PASS" as const,
        chainId: 5_042_002 as const,
        releaseId: live.releaseId!,
        promotionSubjectSha256,
        verifiedAtBlock: live.activationEvidence.verifiedAtBlock!,
        evidenceBlock,
        runReportUrl: "https://evidence.example.com/runs/operations.json",
        runReportSha256: sha256(reportBytes),
        reviewer: reviewer.address,
      };
      const signature = await reviewer.signMessage({ message: promotionPassMessage(unsigned) });
      return { envelopeBytes: encode({ ...unsigned, signature }), reportBytes };
    };
    const publicClient = {
      getTransactionReceipt: async ({ hash }: { hash: string }) => {
        const transaction = transactions.find((candidate) => candidate.hash === hash);
        if (!transaction) throw new Error("missing receipt");
        return {
          status: "success" as const,
          blockNumber: BigInt(transaction.blockNumber),
          from: transaction.from,
          to: transaction.to,
        };
      },
    };
    const valid = await makeSignedArtifact();
    await expect(verifySignedPassEnvelope(
      valid.envelopeBytes,
      "operationsDrill",
      live,
      BigInt(evidenceBlock),
      [reviewer.address],
      {
        publicClient: publicClient as never,
        fetcher: (async () => new Response(valid.reportBytes, { status: 200 })) as typeof fetch,
        allowedFetchHosts: ["evidence.example.com"],
      },
    )).resolves.toBe(reviewer.address);

    const replayed = await makeSignedArtifact(
      transactions.map((transaction, index) => index === 0
        ? { ...transaction, hash: `0x${"aa".repeat(32)}` }
        : transaction),
    );
    await expect(verifySignedPassEnvelope(
      replayed.envelopeBytes,
      "operationsDrill",
      live,
      BigInt(evidenceBlock),
      [reviewer.address],
      {
        publicClient: publicClient as never,
        fetcher: (async () => new Response(replayed.reportBytes, { status: 200 })) as typeof fetch,
        allowedFetchHosts: ["evidence.example.com"],
      },
    )).rejects.toThrow(/receipt is unavailable/);
  });
});

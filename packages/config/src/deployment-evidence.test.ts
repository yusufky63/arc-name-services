import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  concatHex,
  encodeDeployData,
  encodeFunctionData,
  keccak256,
  parseAbi,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  ARC_DEPLOYMENT_BASE_NODE,
  ARC_DEPLOYMENT_NORMALIZATION_PROFILE_HASH,
  ARC_DEPLOYMENT_REVERSE_NODE,
  ARC_DEPLOYMENT_USDC,
  deploymentArtifactPaths,
  deploymentContractDefinitions,
  prepareConfiguredDeploymentManifest,
  prepareDeploymentEvidence,
  renderPublicDeploymentEnv,
} from "./deployment-evidence.js";
import {
  CANONICAL_NFT_METADATA_BASE_URI,
  type ActivationArtifactKey,
  type ContractKey,
  type DeploymentManifest,
  type RegistrarVersion,
} from "./manifest.js";

const ABIS: Record<ContractKey, Abi> = {
  registry: parseAbi([
    "constructor(address rootOwner)",
    "function setSubnodeOwner(bytes32 node, bytes32 label, address newOwner) returns (bytes32)",
    "function setOwner(bytes32 node, address newOwner)",
  ]),
  baseRegistrar: parseAbi([
    "constructor(address registry_, bytes32 baseNode_, address initialOwner)",
    "function setController(address controller, bool enabled)",
    "function transferOwnership(address newOwner)",
  ]),
  controller: parseAbi([
    "constructor(address registrar_, address settlementAsset_, address publicResolver_, address initialOwner, address permitSigner_, address treasury_, bytes32 releaseId_, bytes32 normalizationProfileHash_, uint16 referralBps_)",
    "function setRegistrationsPaused(bool paused)",
    "function transferOwnership(address newOwner)",
  ]),
  publicResolver: parseAbi(["constructor(address registry_)"]),
  reverseRegistrar: parseAbi([
    "constructor(address registry_, address defaultResolver_, address registrar_, bytes32 reverseNode_, bytes32 baseNode_, string suffix_)",
  ]),
  universalResolver: parseAbi(["constructor(address registry_, address reverseRegistrar_)"]),
  marketplace: parseAbi([
    "constructor(address registrar_, address settlementAsset_, address initialOwner, address treasury_, uint16 feeBps_)",
    "function setPaused(bool paused)",
    "function transferOwnership(address newOwner)",
  ]),
};
const V2_BASE_REGISTRAR_ABI = parseAbi([
  "constructor(address registry_, bytes32 baseNode_, address initialOwner, string initialMetadataBaseURI)",
  "function setController(address controller, bool enabled)",
  "function transferOwnership(address newOwner)",
  "function metadataBaseURI() view returns (string)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function tokenURI(uint256 tokenId) view returns (string)",
]);

const ADDRESSES = {
  deployer: "0x1000000000000000000000000000000000000001",
  registry: "0x2000000000000000000000000000000000000001",
  baseRegistrar: "0x2000000000000000000000000000000000000002",
  controller: "0x2000000000000000000000000000000000000003",
  publicResolver: "0x2000000000000000000000000000000000000004",
  reverseRegistrar: "0x2000000000000000000000000000000000000005",
  universalResolver: "0x2000000000000000000000000000000000000006",
  marketplace: "0x2000000000000000000000000000000000000007",
  governanceAccount: "0x1000000000000000000000000000000000000001",
} satisfies Record<string, Address>;

const RELEASE_ID = `0x${"99".repeat(32)}` as Hex;
const ZERO_NODE = `0x${"00".repeat(32)}` as Hex;
const CONTOUR_LABEL = keccak256(stringToHex("contour"));
const REVERSE_LABEL = keccak256(stringToHex("reverse"));
const ADDR_LABEL = keccak256(stringToHex("addr"));
const REVERSE_ROOT = keccak256(concatHex([ZERO_NODE, REVERSE_LABEL]));

type SyntheticArtifact = {
  abi: Abi;
  bytecode: { object: Hex; linkReferences: Record<string, never> };
  deployedBytecode: {
    object: Hex;
    linkReferences: Record<string, never>;
    immutableReferences: Record<string, Array<{ start: number; length: number }>>;
  };
  metadata: Record<string, unknown>;
};

function syntheticArtifacts(
  registrarVersion: RegistrarVersion = "v1",
): Record<ContractKey, SyntheticArtifact> {
  const result = {} as Record<ContractKey, SyntheticArtifact>;
  const definitions = deploymentContractDefinitions(registrarVersion);
  for (const [index, definition] of definitions.entries()) {
    const immutableReferences = Object.fromEntries(definition.immutableNames.map((_, immutableIndex) => [
      String(1_000 + immutableIndex),
      [{ start: immutableIndex * 32, length: 32 }],
    ]));
    const runtimeLength = Math.max(1, definition.immutableNames.length) * 32;
    result[definition.key] = {
      abi: definition.key === "baseRegistrar" && registrarVersion === "v2"
        ? V2_BASE_REGISTRAR_ABI
        : ABIS[definition.key],
      bytecode: {
        object: `0x60${(index + 1).toString(16).padStart(2, "0")}` as Hex,
        linkReferences: {},
      },
      deployedBytecode: {
        object: `0x${"00".repeat(runtimeLength)}` as Hex,
        linkReferences: {},
        immutableReferences,
      },
      metadata: {
        compiler: { version: "0.8.24+commit.e11b9ed9" },
        settings: {
          optimizer: { enabled: true, runs: 10_000 },
          metadata: { bytecodeHash: "none", appendCBOR: false },
          compilationTarget: { [`src/${definition.sourceName}`]: definition.contractName },
        },
        sources: {
          [`src/${definition.sourceName}`]: {
            keccak256: `0x${(index + 1).toString(16).padStart(64, "0")}`,
          },
        },
      },
    };
  }
  return result;
}

const encodeDeployment = encodeDeployData as unknown as (parameters: {
  abi: Abi;
  bytecode: Hex;
  args: readonly unknown[];
}) => Hex;
const encodeCall = encodeFunctionData as unknown as (parameters: {
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}) => Hex;

function transactionHash(index: number): Hex {
  return `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex;
}

function fixture(registrarVersion: RegistrarVersion = "v1") {
  const definitions = deploymentContractDefinitions(registrarVersion);
  const artifacts = syntheticArtifacts(registrarVersion);
  const transactions: Array<Record<string, unknown>> = [];
  const receipts: Array<Record<string, unknown>> = [];

  function pushCreate(key: ContractKey, args: readonly unknown[]): void {
    const definition = definitions.find((item) => item.key === key)!;
    const index = transactions.length;
    const hash = transactionHash(index);
    const contractAddress = ADDRESSES[key];
    transactions.push({
      hash,
      transactionType: "CREATE",
      contractName: definition.contractName,
      contractAddress,
      transaction: {
        from: ADDRESSES.deployer,
        value: "0x0",
        chainId: "0x4cef52",
        input: encodeDeployment({ abi: artifacts[key].abi, bytecode: artifacts[key].bytecode.object, args }),
      },
    });
    receipts.push({
      transactionHash: hash,
      status: "0x1",
      blockNumber: `0x${(100 + index).toString(16)}`,
      contractAddress,
    });
  }

  function pushCall(key: ContractKey, target: Address, functionName: string, args: readonly unknown[]): void {
    const index = transactions.length;
    const hash = transactionHash(index);
    transactions.push({
      hash,
      transactionType: "CALL",
      transaction: {
        from: ADDRESSES.deployer,
        to: target,
        value: "0x0",
        chainId: "0x4cef52",
        input: encodeCall({ abi: artifacts[key].abi, functionName, args }),
      },
    });
    receipts.push({
      transactionHash: hash,
      status: "0x1",
      blockNumber: `0x${(100 + index).toString(16)}`,
      contractAddress: null,
    });
  }

  pushCreate("registry", [ADDRESSES.deployer]);
  pushCreate(
    "baseRegistrar",
    registrarVersion === "v2"
      ? [
          ADDRESSES.registry,
          ARC_DEPLOYMENT_BASE_NODE,
          ADDRESSES.deployer,
          CANONICAL_NFT_METADATA_BASE_URI,
        ]
      : [ADDRESSES.registry, ARC_DEPLOYMENT_BASE_NODE, ADDRESSES.deployer],
  );
  pushCreate("publicResolver", [ADDRESSES.registry]);
  pushCreate("controller", [
    ADDRESSES.baseRegistrar,
    ARC_DEPLOYMENT_USDC,
    ADDRESSES.publicResolver,
    ADDRESSES.deployer,
    ADDRESSES.governanceAccount,
    ADDRESSES.governanceAccount,
    RELEASE_ID,
    ARC_DEPLOYMENT_NORMALIZATION_PROFILE_HASH,
    500,
  ]);
  pushCall("registry", ADDRESSES.registry, "setSubnodeOwner", [
    ZERO_NODE, CONTOUR_LABEL, ADDRESSES.baseRegistrar,
  ]);
  pushCall("baseRegistrar", ADDRESSES.baseRegistrar, "setController", [ADDRESSES.controller, true]);
  pushCall("registry", ADDRESSES.registry, "setSubnodeOwner", [
    ZERO_NODE, REVERSE_LABEL, ADDRESSES.deployer,
  ]);
  pushCreate("reverseRegistrar", [
    ADDRESSES.registry,
    ADDRESSES.publicResolver,
    ADDRESSES.baseRegistrar,
    ARC_DEPLOYMENT_REVERSE_NODE,
    ARC_DEPLOYMENT_BASE_NODE,
    "contour",
  ]);
  pushCall("registry", ADDRESSES.registry, "setSubnodeOwner", [
    REVERSE_ROOT, ADDR_LABEL, ADDRESSES.reverseRegistrar,
  ]);
  pushCreate("universalResolver", [ADDRESSES.registry, ADDRESSES.reverseRegistrar]);
  pushCreate("marketplace", [
    ADDRESSES.baseRegistrar,
    ARC_DEPLOYMENT_USDC,
    ADDRESSES.deployer,
    ADDRESSES.governanceAccount,
    250,
  ]);
  pushCall("controller", ADDRESSES.controller, "setRegistrationsPaused", [true]);
  pushCall("marketplace", ADDRESSES.marketplace, "setPaused", [true]);
  pushCall("registry", ADDRESSES.registry, "setOwner", [REVERSE_ROOT, ADDRESSES.governanceAccount]);
  pushCall("registry", ADDRESSES.registry, "setOwner", [ZERO_NODE, ADDRESSES.governanceAccount]);

  return { broadcast: { transactions, receipts, pending: [] }, artifacts };
}

function draftTemplate(registrarVersion: RegistrarVersion = "v1"): DeploymentManifest {
  const template = JSON.parse(readFileSync(
    new URL("../../../deployments/5042002.json", import.meta.url),
    "utf8",
  )) as DeploymentManifest;
  template.schemaVersion = "1.1.0";
  template.state = "draft";
  template.releaseId = null;
  if (registrarVersion === "v2") {
    template.registrarVersion = "v2";
    template.nftMetadata = { metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI };
    template.legacyReleases = [];
  } else {
    delete template.registrarVersion;
    delete template.nftMetadata;
    delete template.legacyReleases;
  }
  for (const key of Object.keys(template.contracts) as ContractKey[]) {
    template.contracts[key] = {
      address: null,
      deploymentBlock: null,
      transactionHash: null,
      runtimeCodeHash: null,
      abiUrl: null,
      abiSha256: null,
      sourceVerified: false,
      sourceVerificationUrl: null,
      sourceVerificationSha256: null,
    };
  }
  const artifacts = {} as DeploymentManifest["activationEvidence"]["artifacts"];
  for (const key of Object.keys(template.activationEvidence.artifacts) as ActivationArtifactKey[]) {
    artifacts[key] = { url: null, sha256: null };
  }
  template.activationEvidence = {
    productLive: false,
    verifiedAtBlock: null,
    artifacts,
    governance: { account: null },
    controllerPolicy: {
      permitSigner: null,
      signerPolicyVersion: null,
      referralBps: null,
      registrationsPaused: null,
    },
    marketplacePolicy: { feeBps: null, paused: null },
  };
  template.permitIssuer = {
    url: null,
    signerAddress: null,
    publicKey: null,
    policyVersion: null,
    active: false,
  };
  return template;
}

describe("offline deployment evidence", () => {
  it("validates the complete sequence and prepares fail-closed public outputs", () => {
    const input = fixture();
    const evidence = prepareDeploymentEvidence(input.broadcast, input.artifacts);
    expect(evidence.wiring.validated).toBe(true);
    expect(evidence.config.releaseId).toBe(RELEASE_ID);
    expect(evidence.contracts.controller.address.toLowerCase()).toBe(ADDRESSES.controller.toLowerCase());
    expect(evidence.contracts.controller.runtimeCodeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(evidence.contracts.controller.runtimeCodeHash).not.toBe(
      keccak256(input.artifacts.controller.deployedBytecode.object),
    );

    const draft = draftTemplate();
    const draftWithUnknownFields = {
      ...draft,
      accidentalSecret: "must-not-propagate",
      chain: { ...draft.chain, accidentalSecret: "must-not-propagate" },
    };
    const manifest = prepareConfiguredDeploymentManifest(draftWithUnknownFields, evidence);
    expect(manifest.state).toBe("configured");
    expect(manifest.activationEvidence.productLive).toBe(false);
    expect(manifest.activationEvidence.controllerPolicy.registrationsPaused).toBe(true);
    expect(manifest.contracts.registry.sourceVerified).toBe(false);
    expect(manifest.contracts.registry.abiUrl).toBeNull();
    expect(manifest).not.toHaveProperty("accidentalSecret");
    expect(manifest.chain).not.toHaveProperty("accidentalSecret");

    expect(prepareConfiguredDeploymentManifest(manifest, evidence)).toEqual(manifest);

    const publicEnv = renderPublicDeploymentEnv(evidence);
    expect(publicEnv).toContain(`ARC_NAME_REGISTRY_ADDRESS=${ADDRESSES.registry}`);
    expect(publicEnv).toContain(`ARC_GOVERNANCE_ACCOUNT=${ADDRESSES.governanceAccount}`);
    expect(publicEnv).toContain("PUBLIC deployment metadata");
    expect(publicEnv).not.toMatch(/PRIVATE_KEY|MNEMONIC|API_TOKEN|SECRET=/);
  });

  it("uses an explicit V2 registrar artifact and propagates exact NFT metadata identity", () => {
    const input = fixture("v2");
    const evidence = prepareDeploymentEvidence(
      input.broadcast,
      input.artifacts,
      { registrarVersion: "v2" },
    );
    expect(evidence.config).toMatchObject({
      registrarVersion: "v2",
      metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI,
    });
    expect(evidence.contracts.baseRegistrar.contractName).toBe("ArcBaseRegistrarV2");
    expect(evidence.wiring.sequence[1]).toBe("CREATE ArcBaseRegistrarV2");
    expect(deploymentArtifactPaths("v2").baseRegistrar)
      .toBe("ArcBaseRegistrarV2.sol/ArcBaseRegistrarV2.json");

    const v2Template = draftTemplate("v2");
    expect(() => prepareConfiguredDeploymentManifest(v2Template, evidence))
      .toThrow(/exactly one legacy V1|exactly one retained V1/);
    v2Template.legacyReleases = [{
      registrarVersion: "v1",
      releaseId: `0x${"88".repeat(32)}`,
      verifiedAtBlock: 90,
      contracts: Object.fromEntries(
        Object.keys(v2Template.contracts).map((key, index) => [
          key,
          {
            address: `0x${(index + 80).toString(16).padStart(40, "0")}`,
            deploymentBlock: 70 + index,
            runtimeCodeHash: `0x${(index + 90).toString(16).padStart(64, "0")}`,
          },
        ]),
      ) as NonNullable<DeploymentManifest["legacyReleases"]>[number]["contracts"],
      controllerPolicy: { registrationsPaused: true },
      marketplacePolicy: { paused: false },
    }];
    const manifest = prepareConfiguredDeploymentManifest(v2Template, evidence);
    expect(manifest.registrarVersion).toBe("v2");
    expect(manifest.nftMetadata).toEqual({
      metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI,
    });
    expect(manifest.legacyReleases).toEqual(v2Template.legacyReleases);
    expect(renderPublicDeploymentEnv(evidence)).toContain("ARC_REGISTRAR_VERSION=v2");
    expect(renderPublicDeploymentEnv(evidence)).toContain(
      `ARC_NFT_METADATA_BASE_URI=${CANONICAL_NFT_METADATA_BASE_URI}`,
    );

    expect(() => prepareDeploymentEvidence(input.broadcast, input.artifacts))
      .toThrow(/ArcBaseRegistrar constructor ABI|compilation target|expected CREATE/);
    expect(() => prepareConfiguredDeploymentManifest(draftTemplate(), evidence))
      .toThrow(/registrarVersion/);

    const tampered = fixture("v2");
    const transaction = tampered.broadcast.transactions[1]!.transaction as Record<string, unknown>;
    transaction.input = encodeDeployment({
      abi: tampered.artifacts.baseRegistrar.abi,
      bytecode: tampered.artifacts.baseRegistrar.bytecode.object,
      args: [
        ADDRESSES.registry,
        ARC_DEPLOYMENT_BASE_NODE,
        ADDRESSES.deployer,
        "https://metadata.example/api/",
      ],
    });
    expect(() => prepareDeploymentEvidence(
      tampered.broadcast,
      tampered.artifacts,
      { registrarVersion: "v2" },
    )).toThrow(/ArcBaseRegistrarV2 constructor argument 4/);
  });

  it("rejects a changed wiring call", () => {
    const input = fixture();
    const transaction = input.broadcast.transactions[5]!.transaction as Record<string, unknown>;
    transaction.input = encodeCall({
      abi: input.artifacts.baseRegistrar.abi,
      functionName: "setController",
      args: [ADDRESSES.controller, false],
    });
    expect(() => prepareDeploymentEvidence(input.broadcast, input.artifacts))
      .toThrow(/transaction 6 setController argument 2/);
  });

  it("rejects the retired 18-transaction multisig handoff sequence", () => {
    const input = fixture();
    input.broadcast.transactions.push(
      structuredClone(input.broadcast.transactions[input.broadcast.transactions.length - 1]!),
    );
    input.broadcast.receipts.push(
      structuredClone(input.broadcast.receipts[input.broadcast.receipts.length - 1]!),
    );
    expect(() => prepareDeploymentEvidence(input.broadcast, input.artifacts))
      .toThrow(/exactly 15 transactions/);
  });

  it("joins reordered receipts to transactions by case-insensitive transaction hash", () => {
    const input = fixture();
    input.broadcast.receipts.reverse();
    for (const receipt of input.broadcast.receipts) {
      receipt.transactionHash = String(receipt.transactionHash).toUpperCase().replace(/^0X/, "0x");
    }
    const evidence = prepareDeploymentEvidence(input.broadcast, input.artifacts);
    expect(evidence.contracts.baseRegistrar.address).toBe(ADDRESSES.baseRegistrar);
    expect(evidence.contracts.marketplace.address).toBe(ADDRESSES.marketplace);
  });

  it("rejects missing, duplicate and extra receipt identities", () => {
    const missing = fixture();
    missing.broadcast.receipts.pop();
    expect(() => prepareDeploymentEvidence(missing.broadcast, missing.artifacts))
      .toThrow(/one receipt/);

    const duplicate = fixture();
    duplicate.broadcast.receipts[1]!.transactionHash = duplicate.broadcast.receipts[0]!.transactionHash;
    expect(() => prepareDeploymentEvidence(duplicate.broadcast, duplicate.artifacts))
      .toThrow(/transaction hashes must be unique/);

    const extra = fixture();
    extra.broadcast.receipts.push({
      ...structuredClone(extra.broadcast.receipts[0]!),
      transactionHash: `0x${"ff".repeat(32)}`,
    });
    expect(() => prepareDeploymentEvidence(extra.broadcast, extra.artifacts))
      .toThrow(/one receipt/);
  });

  it("rejects failed receipts and incompatible immutable layouts", () => {
    const failed = fixture();
    failed.broadcast.receipts[3]!.status = "0x0";
    expect(() => prepareDeploymentEvidence(failed.broadcast, failed.artifacts))
      .toThrow(/transaction 4 did not succeed/);

    const incompatible = fixture();
    incompatible.artifacts.controller.deployedBytecode.immutableReferences = {};
    expect(() => prepareDeploymentEvidence(incompatible.broadcast, incompatible.artifacts))
      .toThrow(/immutable reference count/);
  });

  it("rejects a configured candidate that diverges from its receipt", () => {
    const input = fixture();
    const evidence = prepareDeploymentEvidence(input.broadcast, input.artifacts);
    const manifest = prepareConfiguredDeploymentManifest(draftTemplate(), evidence);
    manifest.contracts.controller.runtimeCodeHash = `0x${"aa".repeat(32)}`;
    expect(() => prepareConfiguredDeploymentManifest(manifest, evidence))
      .toThrow(/controller runtime code hash does not match/);
  });

  it("strips untrusted contract verification metadata but keeps live gates closed", () => {
    const input = fixture();
    const evidence = prepareDeploymentEvidence(input.broadcast, input.artifacts);
    const enriched = prepareConfiguredDeploymentManifest(draftTemplate(), evidence);
    for (const key of Object.keys(enriched.contracts) as ContractKey[]) {
      const deployment = enriched.contracts[key] as unknown as Record<string, unknown>;
      deployment.abiUrl = `untrusted://${key}/abi`;
      deployment.abiSha256 = "not-an-offline-proof";
      deployment.sourceVerified = "external-claim";
      deployment.sourceVerificationUrl = { provider: "untrusted" };
      deployment.sourceVerificationSha256 = 66;
    }
    const stripped = prepareConfiguredDeploymentManifest(enriched, evidence);
    for (const key of Object.keys(stripped.contracts) as ContractKey[]) {
      expect(stripped.contracts[key]).toMatchObject({
        abiUrl: null,
        abiSha256: null,
        sourceVerified: false,
        sourceVerificationUrl: null,
        sourceVerificationSha256: null,
      });
    }

    const prematurelyVerified = prepareConfiguredDeploymentManifest(draftTemplate(), evidence);
    prematurelyVerified.activationEvidence.verifiedAtBlock = 999;
    expect(() => prepareConfiguredDeploymentManifest(prematurelyVerified, evidence))
      .toThrow(/must remain unverified/);

    const activatedEvidence = prepareConfiguredDeploymentManifest(draftTemplate(), evidence);
    activatedEvidence.activationEvidence.artifacts.deploymentReceipts = {
      url: "https://evidence.example/deployment-receipts.json",
      sha256: `0x${"77".repeat(32)}`,
    };
    expect(() => prepareConfiguredDeploymentManifest(activatedEvidence, evidence))
      .toThrow(/contains activation artifacts/);
  });
});

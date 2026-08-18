import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  concatHex,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  stringToHex,
  zeroAddress,
  zeroHash,
} from "viem";

import { parseConfiguredChainStateArguments } from "./lib/configured-chain-state-cli.mjs";
import {
  main,
  parseV1CutoverManifestArguments,
  prepareV1CutoverManifest,
} from "./prepare-v1-cutover-manifest.mjs";

const HASH = (byte) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
const SOURCE_PATH = resolve("deployments", "5042002.candidate-market-open.json");
const BLOCK_HASH = HASH(0xa1);
const TRANSACTION_HASH = HASH(0xa2);
const REVERSE_NODE =
  "0x91d1777781884d03a6757a803996e38de2a42967fb37eeaca72729271025a9e2";
const REVERSE_ROOT = keccak256(
  concatHex([zeroHash, keccak256(stringToHex("reverse"))]),
);
const controllerAdminAbi = parseAbi([
  "function setRegistrationsPaused(bool paused)",
]);

async function sourceFixture() {
  return JSON.parse(await readFile(SOURCE_PATH, "utf8"));
}

function fixtureContext(source) {
  const cutoverBlock = BigInt(source.activationEvidence.verifiedAtBlock + 10);
  const contracts = Object.fromEntries(
    Object.entries(source.contracts).map(([key, value]) => [
      key,
      { ...value, address: getAddress(value.address) },
    ]),
  );
  const governance = getAddress(source.activationEvidence.governance.account);
  const settlement = getAddress(source.settlement.erc20Address);
  const codes = new Map();
  const hashes = new Map();
  Object.entries(contracts).forEach(([key, value], index) => {
    const code = `0x60${(index + 1).toString(16).padStart(2, "0")}`;
    codes.set(value.address.toLowerCase(), code);
    hashes.set(code, value.runtimeCodeHash);
  });
  codes.set(governance.toLowerCase(), "0x");
  codes.set(settlement.toLowerCase(), "0x6000");

  const stateFor = (spec) => {
    const address = getAddress(spec.address);
    const name = spec.functionName;
    if (name === "owner" && address === contracts.registry.address) {
      const node = spec.args[0].toLowerCase();
      if (node === zeroHash) return governance;
      if (node === source.namespace.baseNode.toLowerCase()) return contracts.baseRegistrar.address;
      if (node === REVERSE_ROOT.toLowerCase()) return governance;
      if (node === REVERSE_NODE.toLowerCase()) return contracts.reverseRegistrar.address;
    }
    if (name === "owner") return governance;
    if (name === "pendingOwner") return zeroAddress;
    if (name === "registry") return contracts.registry.address;
    if (name === "baseNode") return source.namespace.baseNode;
    if (name === "controllers") return true;
    if (name === "registrar") {
      if (address === contracts.controller.address) return contracts.baseRegistrar.address;
      if (address === contracts.reverseRegistrar.address) return contracts.baseRegistrar.address;
      if (address === contracts.marketplace.address) return contracts.baseRegistrar.address;
    }
    if (name === "settlementAsset") return settlement;
    if (name === "publicResolver") return contracts.publicResolver.address;
    if (name === "releaseId") return source.releaseId;
    if (name === "normalizationProfileHash") return source.normalization.profileHash;
    if (name === "permitSigner") {
      return getAddress(source.activationEvidence.controllerPolicy.permitSigner);
    }
    if (name === "pendingPermitSigner") return zeroAddress;
    if (name === "pendingPermitSignerValidAfter") return 0n;
    if (name === "signerPolicyVersion") {
      return BigInt(source.activationEvidence.controllerPolicy.signerPolicyVersion);
    }
    if (name === "treasury") return governance;
    if (name === "referralBps") {
      return BigInt(source.activationEvidence.controllerPolicy.referralBps);
    }
    if (name === "registrationsPaused") return true;
    if (name === "defaultResolver") return contracts.publicResolver.address;
    if (name === "reverseNode") return REVERSE_NODE;
    if (name === "suffix") return source.namespace.suffix;
    if (name === "reverseRegistrar") return contracts.reverseRegistrar.address;
    if (name === "feeBps") {
      return BigInt(source.activationEvidence.marketplacePolicy.feeBps);
    }
    if (name === "paused") return false;
    if (name === "decimals") return BigInt(source.settlement.applicationDecimals);
    throw new Error(`unhandled mock read ${address} ${name}`);
  };

  const makeClient = ({
    receipt = {},
    transaction = {},
    block = {},
    code = {},
    state = {},
  } = {}) => ({
    getChainId: async () => 5_042_002,
    getBlockNumber: async () => cutoverBlock,
    getBlock: async () => ({
      number: cutoverBlock,
      hash: BLOCK_HASH,
      ...block,
    }),
    getTransactionReceipt: async () => ({
      transactionHash: TRANSACTION_HASH,
      blockHash: BLOCK_HASH,
      blockNumber: cutoverBlock,
      status: "success",
      to: contracts.controller.address,
      from: governance,
      ...receipt,
    }),
    getTransaction: async () => ({
      hash: TRANSACTION_HASH,
      blockHash: BLOCK_HASH,
      blockNumber: cutoverBlock,
      to: contracts.controller.address,
      from: governance,
      input: encodeFunctionData({
        abi: controllerAdminAbi,
        functionName: "setRegistrationsPaused",
        args: [true],
      }),
      value: 0n,
      ...transaction,
    }),
    getCode: async ({ address }) => {
      const normalized = getAddress(address).toLowerCase();
      if (Object.hasOwn(code, normalized)) return code[normalized];
      return codes.get(normalized);
    },
    multicall: async ({ contracts: calls }) => calls.map((spec) => {
      const key = `${getAddress(spec.address).toLowerCase()}:${spec.functionName}`;
      return Object.hasOwn(state, key) ? state[key] : stateFor(spec);
    }),
  });
  return {
    cutoverBlock,
    contracts,
    governance,
    makeClient,
    runtimeCodeHasher: (code) => hashes.get(code) ?? HASH(0xff),
  };
}

test("configured-state CLI accepts an explicit manifest without changing the default", () => {
  const defaults = parseConfiguredChainStateArguments([]);
  assert.equal(defaults.manifestPath, resolve("deployments", "5042002.json"));
  assert.equal(defaults.outputPath, null);
  const selected = parseConfiguredChainStateArguments([
    "--output",
    "snapshot.json",
    "--manifest",
    "candidate.json",
  ]);
  assert.equal(selected.manifestPath, resolve("candidate.json"));
  assert.equal(selected.outputPath, resolve("snapshot.json"));
  assert.throws(
    () => parseConfiguredChainStateArguments(["--manifest", "a", "--manifest", "b"]),
    /duplicate/,
  );
});

test("cutover CLI requires an exact receipt transaction, block and create-new output", () => {
  const parsed = parseV1CutoverManifestArguments([
    "--manifest",
    "v1.json",
    "--pause-transaction",
    TRANSACTION_HASH,
    "--cutover-block",
    "123",
    "--cutover-block-hash",
    BLOCK_HASH,
    "--output",
    "v1-cutover.json",
  ]);
  assert.equal(parsed.cutoverBlock, 123n);
  assert.equal(parsed.pauseTransactionHash, TRANSACTION_HASH);
  assert.throws(
    () => parseV1CutoverManifestArguments([
      "--manifest",
      "same.json",
      "--pause-transaction",
      TRANSACTION_HASH,
      "--cutover-block",
      "123",
      "--cutover-block-hash",
      BLOCK_HASH,
      "--output",
      "same.json",
    ]),
    /output must differ/,
  );
});

test("builds a paused retained V1 manifest only after exact receipt, runtime and wiring parity", async () => {
  const source = await sourceFixture();
  const fixture = fixtureContext(source);
  const result = await prepareV1CutoverManifest({
    sourceValue: source,
    pauseTransactionHash: TRANSACTION_HASH,
    cutoverBlock: fixture.cutoverBlock,
    cutoverBlockHash: BLOCK_HASH,
    client: fixture.makeClient(),
    runtimeCodeHasher: fixture.runtimeCodeHasher,
  });
  assert.equal(result.verification.verdict, "PASS");
  assert.equal(
    result.manifest.activationEvidence.verifiedAtBlock,
    Number(fixture.cutoverBlock),
  );
  assert.equal(
    result.manifest.activationEvidence.controllerPolicy.registrationsPaused,
    true,
  );
  assert.equal(result.manifest.activationEvidence.marketplacePolicy.paused, false);
});

test("fails closed on receipt, runtime, release or retained-market drift", async (context) => {
  const source = await sourceFixture();
  const fixture = fixtureContext(source);
  const base = {
    sourceValue: source,
    pauseTransactionHash: TRANSACTION_HASH,
    cutoverBlock: fixture.cutoverBlock,
    cutoverBlockHash: BLOCK_HASH,
    runtimeCodeHasher: fixture.runtimeCodeHasher,
  };
  const cases = [
    {
      name: "wrong receipt target",
      client: fixture.makeClient({ receipt: { to: fixture.contracts.marketplace.address } }),
      message: /pause receipt target mismatch/,
    },
    {
      name: "reverted receipt",
      client: fixture.makeClient({ receipt: { status: "reverted" } }),
      message: /receipt is not successful/,
    },
    {
      name: "runtime mismatch",
      client: fixture.makeClient({
        code: { [fixture.contracts.registry.address.toLowerCase()]: "0x60ff" },
      }),
      message: /registry runtime code hash mismatch/,
    },
    {
      name: "controller release drift",
      client: fixture.makeClient({
        state: {
          [`${fixture.contracts.controller.address.toLowerCase()}:releaseId`]: HASH(0xee),
        },
      }),
      message: /controller release ID mismatch/,
    },
    {
      name: "retained market closed",
      client: fixture.makeClient({
        state: {
          [`${fixture.contracts.marketplace.address.toLowerCase()}:paused`]: true,
        },
      }),
      message: /retained V1 marketplace is paused/,
    },
  ];
  for (const entry of cases) {
    await context.test(entry.name, async () => {
      await assert.rejects(
        prepareV1CutoverManifest({ ...base, client: entry.client }),
        entry.message,
      );
    });
  }
});

test("CLI writes a new snapshot and refuses to overwrite it", async () => {
  const source = await sourceFixture();
  const fixture = fixtureContext(source);
  const temporary = await mkdtemp(join(tmpdir(), "contour-v1-cutover-manifest-"));
  try {
    const sourcePath = join(temporary, "source.json");
    const outputPath = join(temporary, "cutover.json");
    await writeFile(sourcePath, `${JSON.stringify(source, null, 2)}\n`, "utf8");
    const argv = [
      "--manifest",
      sourcePath,
      "--pause-transaction",
      TRANSACTION_HASH,
      "--cutover-block",
      fixture.cutoverBlock.toString(),
      "--cutover-block-hash",
      BLOCK_HASH,
      "--output",
      outputPath,
    ];
    await main(argv, {
      client: fixture.makeClient(),
      runtimeCodeHasher: fixture.runtimeCodeHasher,
      environment: {},
      stdout: { write() {} },
    });
    const output = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(output.activationEvidence.controllerPolicy.registrationsPaused, true);
    await assert.rejects(
      main(argv, {
        client: fixture.makeClient(),
        runtimeCodeHasher: fixture.runtimeCodeHasher,
        environment: {},
        stdout: { write() {} },
      }),
      /EEXIST|file already exists/i,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

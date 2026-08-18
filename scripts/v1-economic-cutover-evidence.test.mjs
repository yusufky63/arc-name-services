import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAbiItem,
  getAddress,
  keccak256,
  toBytes,
  zeroAddress,
} from "viem";
import {
  ECONOMIC_ERC20_ABI,
  V1_CONTROLLER_ECONOMIC_ABI,
  V1_MARKETPLACE_ECONOMIC_ABI,
  V1_REGISTRAR_ECONOMIC_ABI,
  captureV1EconomicCutoverEvidence,
  deterministicEconomicCutoverJson,
} from "./lib/v1-economic-cutover-evidence.mjs";
import {
  main,
  parseV1EconomicCutoverArgs,
} from "./capture-v1-economic-cutover.mjs";

const CUTOVER_BLOCK = 120n;
const CUTOVER_TIMESTAMP = 500n;
const HASH = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const ADDRESS = (value) =>
  getAddress(`0x${BigInt(value).toString(16).padStart(40, "0")}`);
const BLOCK_HASH = (block) => HASH(10_000n + BigInt(block));
const RELEASE_ID = HASH(700);
const BASE_NODE = HASH(701);
const ASSET = ADDRESS(900);
const REFERRER_A = ADDRESS(901);
const REFERRER_B = ADDRESS(902);
const SELLER_A = ADDRESS(903);
const SELLER_B = ADDRESS(904);
const SELLER_C = ADDRESS(905);
const BUYER_A = ADDRESS(906);
const BUYER_B = ADDRESS(907);

const ROLES = [
  "registry",
  "baseRegistrar",
  "controller",
  "publicResolver",
  "reverseRegistrar",
  "universalResolver",
  "marketplace",
];

function eventLog({
  abi,
  address,
  eventName,
  args,
  blockNumber,
  transaction,
  transactionIndex = 0,
  logIndex,
}) {
  const item = getAbiItem({ abi, name: eventName });
  const nonIndexed = item.inputs.filter((input) => !input.indexed);
  return {
    address,
    blockHash: BLOCK_HASH(blockNumber),
    blockNumber: BigInt(blockNumber),
    data: encodeAbiParameters(
      nonIndexed,
      nonIndexed.map((input) => args[input.name]),
    ),
    logIndex,
    removed: false,
    topics: encodeEventTopics({ abi, eventName, args }),
    transactionHash: HASH(transaction),
    transactionIndex,
  };
}

function registeredNameEvents({
  manifest,
  name,
  owner,
  blockNumber,
  transaction,
  baseLogIndex = 0,
  referral,
}) {
  const label = keccak256(toBytes(name));
  const tokenId = BigInt(label);
  const registrar = manifest.contracts.baseRegistrar.address;
  const controller = manifest.contracts.controller.address;
  const controllerLogs = [];
  if (referral) {
    controllerLogs.push(eventLog({
      abi: V1_CONTROLLER_ECONOMIC_ABI,
      address: controller,
      eventName: "ReferralAccrued",
      args: { referrer: referral.account, amount: referral.amount },
      blockNumber,
      transaction,
      logIndex: baseLogIndex,
    }));
  }
  const registrarLogs = [
    eventLog({
      abi: V1_REGISTRAR_ECONOMIC_ABI,
      address: registrar,
      eventName: "Transfer",
      args: { from: zeroAddress, to: owner, tokenId },
      blockNumber,
      transaction,
      logIndex: baseLogIndex + 1,
    }),
    eventLog({
      abi: V1_REGISTRAR_ECONOMIC_ABI,
      address: registrar,
      eventName: "NameRegistered",
      args: { id: tokenId, owner, expires: 1_000n },
      blockNumber,
      transaction,
      logIndex: baseLogIndex + 2,
    }),
  ];
  controllerLogs.push(eventLog({
    abi: V1_CONTROLLER_ECONOMIC_ABI,
    address: controller,
    eventName: "NameRegistered",
    args: {
      name,
      label,
      owner,
      baseCost: 100n,
      premium: 0n,
      expires: 1_000n,
    },
    blockNumber,
    transaction,
    logIndex: baseLogIndex + 3,
  }));
  return { controllerLogs, label, registrarLogs, tokenId };
}

function manifestFixture() {
  const contracts = {};
  const runtimeCodes = {};
  for (const [index, role] of ROLES.entries()) {
    const code = `0x60${(index + 1).toString(16).padStart(2, "0")}00`;
    runtimeCodes[role] = code;
    contracts[role] = {
      address: ADDRESS(index + 10),
      deploymentBlock: 100,
      runtimeCodeHash: keccak256(code),
      sourceVerified: true,
    };
  }
  return {
    manifest: {
      schemaVersion: "1.1.0",
      state: "active",
      releaseId: RELEASE_ID,
      testnet: true,
      chain: {
        id: 5_042_002,
        rpcUrl: "https://rpc.testnet.arc.network",
      },
      settlement: { erc20Address: ASSET },
      namespace: { suffix: "contour", baseNode: BASE_NODE },
      contracts,
      activationEvidence: {
        verifiedAtBlock: Number(CUTOVER_BLOCK),
        controllerPolicy: { registrationsPaused: true },
        marketplacePolicy: { paused: false },
      },
    },
    runtimeCodes,
  };
}

function buildFixture(options = {}) {
  const { manifest, runtimeCodes } = manifestFixture();
  const aa = registeredNameEvents({
    manifest,
    name: "aa",
    owner: SELLER_A,
    blockNumber: 101,
    transaction: 1,
    referral: { account: REFERRER_A, amount: 10n },
  });
  const sold = registeredNameEvents({
    manifest,
    name: "sold",
    owner: SELLER_B,
    blockNumber: 102,
    transaction: 2,
  });
  const claimed = registeredNameEvents({
    manifest,
    name: "claimed",
    owner: SELLER_C,
    blockNumber: 103,
    transaction: 3,
    referral: { account: REFERRER_B, amount: 20n },
  });

  const controllerLogs = [
    ...aa.controllerLogs,
    ...sold.controllerLogs,
    ...claimed.controllerLogs,
    eventLog({
      abi: V1_CONTROLLER_ECONOMIC_ABI,
      address: manifest.contracts.controller.address,
      eventName: "ReferralClaimed",
      args: { referrer: REFERRER_B, amount: 20n },
      blockNumber: 110,
      transaction: 10,
      logIndex: 0,
    }),
    eventLog({
      abi: V1_CONTROLLER_ECONOMIC_ABI,
      address: manifest.contracts.controller.address,
      eventName: "RegistrationPauseChanged",
      args: { paused: true },
      blockNumber: CUTOVER_BLOCK,
      transaction: 20,
      logIndex: 0,
    }),
  ];
  const registrarLogs = [
    ...aa.registrarLogs,
    ...sold.registrarLogs,
    ...claimed.registrarLogs,
  ];
  const marketplace = manifest.contracts.marketplace.address;
  const marketplaceLogs = [
    eventLog({
      abi: V1_MARKETPLACE_ECONOMIC_ABI,
      address: marketplace,
      eventName: "Listed",
      args: {
        tokenId: sold.tokenId,
        seller: SELLER_B,
        price: 100n,
        validUntil: 900n,
      },
      blockNumber: 105,
      transaction: 5,
      logIndex: 0,
    }),
    eventLog({
      abi: V1_MARKETPLACE_ECONOMIC_ABI,
      address: marketplace,
      eventName: "Purchased",
      args: {
        tokenId: sold.tokenId,
        seller: SELLER_B,
        buyer: BUYER_A,
        price: 100n,
        fee: 5n,
      },
      blockNumber: 106,
      transaction: 6,
      logIndex: 0,
    }),
    eventLog({
      abi: V1_MARKETPLACE_ECONOMIC_ABI,
      address: marketplace,
      eventName: "Listed",
      args: {
        tokenId: claimed.tokenId,
        seller: SELLER_C,
        price: 200n,
        validUntil: 900n,
      },
      blockNumber: 107,
      transaction: 7,
      logIndex: 0,
    }),
    eventLog({
      abi: V1_MARKETPLACE_ECONOMIC_ABI,
      address: marketplace,
      eventName: "Purchased",
      args: {
        tokenId: claimed.tokenId,
        seller: SELLER_C,
        buyer: BUYER_B,
        price: 200n,
        fee: 10n,
      },
      blockNumber: 108,
      transaction: 8,
      logIndex: 0,
    }),
    eventLog({
      abi: V1_MARKETPLACE_ECONOMIC_ABI,
      address: marketplace,
      eventName: "ProceedsClaimed",
      args: { seller: SELLER_C, amount: 190n },
      blockNumber: 109,
      transaction: 9,
      logIndex: 0,
    }),
    eventLog({
      abi: V1_MARKETPLACE_ECONOMIC_ABI,
      address: marketplace,
      eventName: "Listed",
      args: {
        tokenId: aa.tokenId,
        seller: SELLER_A,
        price: 50n,
        validUntil: 900n,
      },
      blockNumber: 111,
      transaction: 11,
      logIndex: 0,
    }),
  ];
  registrarLogs.push(
    eventLog({
      abi: V1_REGISTRAR_ECONOMIC_ABI,
      address: manifest.contracts.baseRegistrar.address,
      eventName: "Transfer",
      args: { from: SELLER_B, to: BUYER_A, tokenId: sold.tokenId },
      blockNumber: 106,
      transaction: 6,
      logIndex: 1,
    }),
    eventLog({
      abi: V1_REGISTRAR_ECONOMIC_ABI,
      address: manifest.contracts.baseRegistrar.address,
      eventName: "Transfer",
      args: { from: SELLER_C, to: BUYER_B, tokenId: claimed.tokenId },
      blockNumber: 108,
      transaction: 8,
      logIndex: 1,
    }),
  );

  const allLogs = [...controllerLogs, ...registrarLogs, ...marketplaceLogs];
  const logsByAddress = new Map();
  for (const log of allLogs) {
    const key = log.address.toLowerCase();
    logsByAddress.set(key, [...(logsByAddress.get(key) ?? []), log]);
  }

  const rawListings = new Map([
    [aa.tokenId.toString(), {
      seller: SELLER_A,
      price: 50n,
      validUntil: 900n,
    }],
  ]);
  const owners = new Map([
    [aa.tokenId.toString(), SELLER_A],
    [sold.tokenId.toString(), BUYER_A],
    [claimed.tokenId.toString(), BUYER_B],
  ]);
  const referralCredits = new Map([
    [REFERRER_A.toLowerCase(), options.referrerAAmount ?? 10n],
    [REFERRER_B.toLowerCase(), 0n],
  ]);
  const proceeds = new Map([
    [SELLER_A.toLowerCase(), 0n],
    [SELLER_B.toLowerCase(), 95n],
    [SELLER_C.toLowerCase(), 0n],
  ]);
  const coreState = {
    controllerBalance: options.controllerBalance ?? 20n,
    controllerPaused: options.controllerPaused ?? true,
    controllerSurplus: options.controllerSurplus ?? 10n,
    marketBalance: options.marketBalance ?? 100n,
    marketPaused: options.marketPaused ?? false,
    marketSurplus: options.marketSurplus ?? 5n,
    totalReferralLiability: options.totalReferralLiability ?? 10n,
    totalSellerLiability: options.totalSellerLiability ?? 95n,
  };
  const requestSelectors = [];
  const logRequests = [];
  const blockCalls = new Map();

  const resultForCall = (to, functionName, args) => {
    const normalized = to.toLowerCase();
    if (normalized === manifest.contracts.controller.address.toLowerCase()) {
      if (functionName === "registrationsPaused") return coreState.controllerPaused;
      if (functionName === "registrar") return manifest.contracts.baseRegistrar.address;
      if (functionName === "settlementAsset") return ASSET;
      if (functionName === "releaseId") return RELEASE_ID;
      if (functionName === "totalReferralLiability") {
        return coreState.totalReferralLiability;
      }
      if (functionName === "surplus") return coreState.controllerSurplus;
      if (functionName === "referralCredits") {
        return referralCredits.get(getAddress(args[0]).toLowerCase()) ?? 0n;
      }
    }
    if (normalized === manifest.contracts.marketplace.address.toLowerCase()) {
      if (functionName === "paused") return coreState.marketPaused;
      if (functionName === "registrar") return manifest.contracts.baseRegistrar.address;
      if (functionName === "settlementAsset") return ASSET;
      if (functionName === "totalSellerLiability") return coreState.totalSellerLiability;
      if (functionName === "surplus") return coreState.marketSurplus;
      if (functionName === "proceeds") {
        return proceeds.get(getAddress(args[0]).toLowerCase()) ?? 0n;
      }
      if (functionName === "rawListingOf") {
        return rawListings.get(BigInt(args[0]).toString()) ?? {
          seller: zeroAddress,
          price: 0n,
          validUntil: 0n,
        };
      }
      if (functionName === "listingOf") {
        if (options.liveAa === false) {
          return { seller: zeroAddress, price: 0n, validUntil: 0n };
        }
        return rawListings.get(BigInt(args[0]).toString()) ?? {
          seller: zeroAddress,
          price: 0n,
          validUntil: 0n,
        };
      }
    }
    if (normalized === manifest.contracts.baseRegistrar.address.toLowerCase()) {
      if (functionName === "baseNode") return BASE_NODE;
      const tokenKey = BigInt(args[0]).toString();
      if (functionName === "ownerOf") return owners.get(tokenKey);
      if (functionName === "nameExpires") return 1_000n;
      if (functionName === "isActive") return true;
      if (functionName === "inGracePeriod") return false;
      if (functionName === "available") return false;
    }
    if (normalized === ASSET.toLowerCase() && functionName === "balanceOf") {
      const account = getAddress(args[0]);
      if (account === manifest.contracts.controller.address) {
        return coreState.controllerBalance;
      }
      if (account === manifest.contracts.marketplace.address) {
        return coreState.marketBalance;
      }
    }
    throw new Error(`unhandled call ${to}:${functionName}`);
  };

  const abiFor = (to) => {
    const normalized = to.toLowerCase();
    if (normalized === manifest.contracts.controller.address.toLowerCase()) {
      return V1_CONTROLLER_ECONOMIC_ABI;
    }
    if (normalized === manifest.contracts.marketplace.address.toLowerCase()) {
      return V1_MARKETPLACE_ECONOMIC_ABI;
    }
    if (normalized === manifest.contracts.baseRegistrar.address.toLowerCase()) {
      return V1_REGISTRAR_ECONOMIC_ABI;
    }
    if (normalized === ASSET.toLowerCase()) return ECONOMIC_ERC20_ABI;
    throw new Error(`unhandled ABI target ${to}`);
  };

  const client = {
    getChainId: async () => 5_042_002,
    getBlock: async ({ blockNumber }) => {
      const key = blockNumber.toString();
      const count = (blockCalls.get(key) ?? 0) + 1;
      blockCalls.set(key, count);
      const hash = options.reorgCutover && blockNumber === CUTOVER_BLOCK && count > 1
        ? HASH(999_999)
        : BLOCK_HASH(blockNumber);
      return {
        hash,
        number: blockNumber,
        timestamp: blockNumber === CUTOVER_BLOCK
          ? CUTOVER_TIMESTAMP
          : BigInt(blockNumber),
      };
    },
    getLogs: async ({ address, fromBlock, toBlock }) => {
      logRequests.push({ address, fromBlock, toBlock });
      if (options.logError) throw new Error("historical range unavailable");
      return (logsByAddress.get(address.toLowerCase()) ?? []).filter(
        (log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock,
      );
    },
    request: async ({ method, params }) => {
      const selector = params[1];
      assert.deepEqual(selector, {
        blockHash: BLOCK_HASH(CUTOVER_BLOCK),
        requireCanonical: true,
      });
      requestSelectors.push({ method, selector });
      if (method === "eth_getCode") {
        const address = getAddress(params[0]);
        const role = ROLES.find(
          (candidate) => manifest.contracts[candidate].address === address,
        );
        if (!role) throw new Error("unknown runtime address");
        return runtimeCodes[role];
      }
      const call = params[0];
      const abi = abiFor(call.to);
      const decoded = decodeFunctionData({ abi, data: call.data });
      const result = resultForCall(
        call.to,
        decoded.functionName,
        decoded.args ?? [],
      );
      return encodeFunctionResult({
        abi,
        functionName: decoded.functionName,
        result,
      });
    },
  };

  return {
    client,
    logRequests,
    manifest,
    requestSelectors,
  };
}

async function captureFixture(options = {}) {
  const fixture = buildFixture(options);
  const report = await captureV1EconomicCutoverEvidence({
    manifest: fixture.manifest,
    cutoverBlock: CUTOVER_BLOCK,
    client: fixture.client,
    requiredLiveListings: ["aa.contour"],
    chunkSize: 5n,
  });
  return { ...fixture, report };
}

test("captures a deterministic, block-hash pinned and fully reconciled V1 economic checkpoint", async () => {
  const { report, logRequests, requestSelectors } = await captureFixture();
  assert.equal(report.verdict, "PASS");
  assert.deepEqual(report.policy, {
    marketplacePaused: false,
    registrationsPaused: true,
  });
  assert.deepEqual(report.liabilities.controller, {
    accounts: [
      { account: REFERRER_A, amount: "10" },
      { account: REFERRER_B, amount: "0" },
    ],
    accountSum: "10",
    balance: "20",
    settlementAsset: ASSET,
    surplus: "10",
    totalLiability: "10",
  });
  assert.equal(report.liabilities.marketplace.accountSum, "95");
  assert.equal(report.liabilities.marketplace.totalLiability, "95");
  assert.equal(report.names.length, 3);
  const aa = report.names.find((name) => name.fullName === "aa.contour");
  assert.equal(aa.lifecycle, "active");
  assert.deepEqual(aa.liveListing, {
    price: "50",
    seller: SELLER_A,
    validUntil: "900",
  });
  assert.ok(logRequests.length > 3);
  assert.ok(logRequests.every(
    ({ fromBlock, toBlock }) => toBlock - fromBlock + 1n <= 5n,
  ));
  assert.ok(requestSelectors.length > 20);
  const json = deterministicEconomicCutoverJson(report);
  assert.equal(json, deterministicEconomicCutoverJson(JSON.parse(json)));
  assert.doesNotMatch(
    json,
    /"(?:(?:private_)?key|password|credential|secret|mnemonic)"\s*:/i,
  );
});

test("fails when a discovered liability account or the aggregate total is not event-complete", async (context) => {
  await context.test("account mismatch", async () => {
    const fixture = buildFixture({ referrerAAmount: 11n });
    await assert.rejects(
      captureV1EconomicCutoverEvidence({
        manifest: fixture.manifest,
        cutoverBlock: CUTOVER_BLOCK,
        client: fixture.client,
      }),
      /referral credit account .* complete event fold/,
    );
  });
  await context.test("aggregate mismatch", async () => {
    const fixture = buildFixture({ totalReferralLiability: 11n });
    await assert.rejects(
      captureV1EconomicCutoverEvidence({
        manifest: fixture.manifest,
        cutoverBlock: CUTOVER_BLOCK,
        client: fixture.client,
      }),
      /sum of all discovered referral credits/,
    );
  });
});

test("fails independently for controller or marketplace insolvency", async (context) => {
  await context.test("controller", async () => {
    const fixture = buildFixture({
      controllerBalance: 9n,
      controllerSurplus: 0n,
    });
    await assert.rejects(
      captureV1EconomicCutoverEvidence({
        manifest: fixture.manifest,
        cutoverBlock: CUTOVER_BLOCK,
        client: fixture.client,
      }),
      /controller is insolvent/,
    );
  });
  await context.test("marketplace", async () => {
    const fixture = buildFixture({
      marketBalance: 94n,
      marketSurplus: 0n,
    });
    await assert.rejects(
      captureV1EconomicCutoverEvidence({
        manifest: fixture.manifest,
        cutoverBlock: CUTOVER_BLOCK,
        client: fixture.client,
      }),
      /marketplace is insolvent/,
    );
  });
});

test("rejects the wrong on-chain cutover pause policy", async (context) => {
  await context.test("registration open", async () => {
    const fixture = buildFixture({ controllerPaused: false });
    await assert.rejects(
      captureV1EconomicCutoverEvidence({
        manifest: fixture.manifest,
        cutoverBlock: CUTOVER_BLOCK,
        client: fixture.client,
      }),
      /registrationsPaused is not true/,
    );
  });
  await context.test("market closed", async () => {
    const fixture = buildFixture({ marketPaused: true });
    await assert.rejects(
      captureV1EconomicCutoverEvidence({
        manifest: fixture.manifest,
        cutoverBlock: CUTOVER_BLOCK,
        client: fixture.client,
      }),
      /marketplace paused is not false/,
    );
  });
});

test("rejects a missing required live listing and a cutover-block reorg", async (context) => {
  await context.test("missing aa.contour", async () => {
    const fixture = buildFixture({ liveAa: false });
    await assert.rejects(
      captureV1EconomicCutoverEvidence({
        manifest: fixture.manifest,
        cutoverBlock: CUTOVER_BLOCK,
        client: fixture.client,
        requiredLiveListings: ["aa.contour"],
      }),
      /required live listing is missing: aa\.contour/,
    );
  });
  await context.test("reorg", async () => {
    const fixture = buildFixture({ reorgCutover: true });
    await assert.rejects(
      captureV1EconomicCutoverEvidence({
        manifest: fixture.manifest,
        cutoverBlock: CUTOVER_BLOCK,
        client: fixture.client,
      }),
      /reorganized/,
    );
  });
});

test("fails closed when historical RPC logs are unavailable instead of using an incomplete fallback", async () => {
  const fixture = buildFixture({ logError: true });
  await assert.rejects(
    captureV1EconomicCutoverEvidence({
      manifest: fixture.manifest,
      cutoverBlock: CUTOVER_BLOCK,
      client: fixture.client,
    }),
    /Blockscout fallback is not available/,
  );
});

test("CLI arguments are explicit and output is canonical with no-overwrite semantics", async (context) => {
  assert.throws(
    () => parseV1EconomicCutoverArgs(["--manifest", "v1.json"]),
    /--manifest, --cutover-block and --output are required/,
  );
  assert.throws(
    () => parseV1EconomicCutoverArgs([
      "--manifest",
      "v1.json",
      "--cutover-block",
      "0",
      "--output",
      "evidence.json",
    ]),
    /positive decimal integer/,
  );

  const temporary = await mkdtemp(join(tmpdir(), "contour-v1-economic-cutover-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const output = join(temporary, "economic-cutover.json");
  const stdout = { value: "", write(value) { this.value += value; } };
  const firstFixture = buildFixture();
  const argv = [
    "--manifest",
    join(temporary, "unused-manifest.json"),
    "--cutover-block",
    CUTOVER_BLOCK.toString(),
    "--output",
    output,
    "--require-live-listing",
    "aa.contour",
  ];
  const first = await main(argv, {
    client: firstFixture.client,
    environment: {},
    manifest: firstFixture.manifest,
    stdout,
  });
  const bytes = await readFile(output, "utf8");
  assert.equal(bytes, deterministicEconomicCutoverJson(first.report));
  assert.match(stdout.value, /"verdict": "PASS"/);

  const secondFixture = buildFixture();
  await assert.rejects(
    main(argv, {
      client: secondFixture.client,
      environment: {},
      manifest: secondFixture.manifest,
      stdout: { write() {} },
    }),
    /EEXIST/,
  );
});

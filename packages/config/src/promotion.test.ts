import {
  encodeAbiParameters,
  keccak256,
  namehash,
  parseAbiItem,
  parseAbiParameters,
  sha256,
  toEventSelector,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import { ARC_TESTNET_EXPLORER_URL } from "./chain.js";
import {
  readControllerHistoryInChunks,
  requiredPromotionRunAssertionIds,
  V2_FUNDED_METADATA_ASSERTION_IDS,
  verifyLegacyReleaseAtBlock,
  verifyIndexedControllerHistory,
  type ControllerHistoryBlockRange,
  type IndexedControllerHistoryVerificationOptions,
} from "./promotion.js";
import type {
  ContractKey,
  DeploymentManifest,
  LegacyReleaseReference,
} from "./manifest.js";

const CONTROLLER_CHANGED = parseAbiItem(
  "event ControllerChanged(address indexed controller, bool enabled)",
);
const CONTROLLER_CHANGED_TOPIC = toEventSelector(CONTROLLER_CHANGED);
const REGISTRAR = "0x1000000000000000000000000000000000000001" as Address;
const CONTROLLER = "0x2000000000000000000000000000000000000002" as Address;
const GOVERNANCE = "0x3000000000000000000000000000000000000003" as Address;

type ExplorerRow = {
  address: Address;
  topics: [Hex, Hex, null, null];
  data: Hex;
  blockNumber: string;
  transactionHash: Hex;
  transactionIndex: string;
  logIndex: string;
};

function hash(index: number): Hex {
  return `0x${index.toString(16).padStart(64, "0")}` as Hex;
}

function explorerRow(index: number, overrides: Partial<ExplorerRow> = {}): ExplorerRow {
  const blockNumber = 100 + index;
  return {
    address: REGISTRAR,
    topics: [
      CONTROLLER_CHANGED_TOPIC,
      encodeAbiParameters(parseAbiParameters("address"), [CONTROLLER]),
      null,
      null,
    ],
    data: encodeAbiParameters(parseAbiParameters("bool"), [true]),
    blockNumber: `0x${blockNumber.toString(16)}`,
    transactionHash: hash(20_000 + index),
    transactionIndex: "0x0",
    logIndex: "0x0",
    ...overrides,
  };
}

function rowQuantity(value: string): bigint {
  return BigInt(value);
}

function canonicalBlockHash(row: ExplorerRow): Hex {
  return hash(10_000 + Number(rowQuantity(row.blockNumber)));
}

function receiptFor(
  row: ExplorerRow,
  registrar: Address = REGISTRAR,
  governance: Address = GOVERNANCE,
) {
  const blockNumber = rowQuantity(row.blockNumber);
  const blockHash = canonicalBlockHash(row);
  const transactionIndex = Number(rowQuantity(row.transactionIndex));
  const logIndex = Number(rowQuantity(row.logIndex));
  return {
    status: "success" as const,
    blockNumber,
    blockHash,
    transactionHash: row.transactionHash,
    transactionIndex,
    from: governance,
    to: registrar,
    logs: [{
      address: row.address,
      blockHash,
      blockNumber,
      data: row.data,
      logIndex,
      removed: false,
      topics: [row.topics[0], row.topics[1]],
      transactionHash: row.transactionHash,
      transactionIndex,
    }],
  };
}

function indexedClient(
  rows: readonly ExplorerRow[],
  options: {
    currentEnabled?: boolean;
    registrar?: Address;
    governance?: Address;
    mutateReceipt?: (receipt: ReturnType<typeof receiptFor>) => ReturnType<typeof receiptFor>;
    mutateBlock?: (block: { number: bigint; hash: Hex }) => { number: bigint; hash: Hex };
  } = {},
): IndexedControllerHistoryVerificationOptions["client"] {
  const byTransaction = new Map(rows.map((row) => [row.transactionHash.toLowerCase(), row]));
  const byBlock = new Map(rows.map((row) => [rowQuantity(row.blockNumber).toString(), row]));
  return {
    getTransactionReceipt: vi.fn(async ({ hash: transactionHash }: { hash: Hex }) => {
      const row = byTransaction.get(transactionHash.toLowerCase());
      if (!row) throw new Error("missing receipt fixture");
      const receipt = receiptFor(
        row,
        options.registrar ?? REGISTRAR,
        options.governance ?? GOVERNANCE,
      );
      return (options.mutateReceipt ? options.mutateReceipt(receipt) : receipt) as never;
    }),
    getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
      const row = byBlock.get(blockNumber.toString());
      if (!row) throw new Error("missing block fixture");
      const block = { number: blockNumber, hash: canonicalBlockHash(row) };
      return (options.mutateBlock ? options.mutateBlock(block) : block) as never;
    }),
    readContract: vi.fn(async () => options.currentEnabled ?? true) as never,
  } as IndexedControllerHistoryVerificationOptions["client"];
}

function arcScanFetch(
  pages: readonly (readonly ExplorerRow[])[],
  requested: URL[] = [],
): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requested.push(url);
    const page = Number(url.searchParams.get("page"));
    const result = pages[page - 1] ?? [];
    return new Response(JSON.stringify({
      status: result.length > 0 ? "1" : "0",
      message: result.length > 0 ? "OK" : "No logs found",
      result,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function verificationOptions(
  rows: readonly ExplorerRow[],
  fetcher: typeof fetch,
  client = indexedClient(rows),
): IndexedControllerHistoryVerificationOptions {
  return {
    client,
    fetcher,
    explorerUrl: ARC_TESTNET_EXPLORER_URL,
    registrar: REGISTRAR,
    canonicalController: CONTROLLER,
    governanceAccount: GOVERNANCE,
    fromBlock: 100n,
    toBlock: 10_000n,
  };
}

describe("promotion run assertion coverage", () => {
  it("requires collectible metadata evidence only for V2 funded acceptance", () => {
    const legacy = requiredPromotionRunAssertionIds({}, "fundedEndToEnd");
    const v2 = requiredPromotionRunAssertionIds(
      { registrarVersion: "v2" },
      "fundedEndToEnd",
    );

    expect(legacy).not.toEqual(expect.arrayContaining([...V2_FUNDED_METADATA_ASSERTION_IDS]));
    expect(v2.slice(-V2_FUNDED_METADATA_ASSERTION_IDS.length)).toEqual(
      V2_FUNDED_METADATA_ASSERTION_IDS,
    );
    expect(new Set(v2).size).toBe(v2.length);
    expect(requiredPromotionRunAssertionIds(
      { registrarVersion: "v2" },
      "operationsDrill",
    )).not.toEqual(expect.arrayContaining([...V2_FUNDED_METADATA_ASSERTION_IDS]));
  });
});

describe("retained V1 promotion proof", () => {
  const blockNumber = 900n;
  const roles = [
    "registry",
    "baseRegistrar",
    "controller",
    "publicResolver",
    "reverseRegistrar",
    "universalResolver",
    "marketplace",
  ] as const satisfies readonly ContractKey[];
  const bytecodes = Object.fromEntries(
    roles.map((role, index) => [role, `0x60${(index + 1).toString(16).padStart(2, "0")}00`]),
  ) as Record<ContractKey, Hex>;
  const contracts = Object.fromEntries(
    roles.map((role, index) => [
      role,
      {
        address: `0x${(index + 10).toString(16).padStart(40, "0")}` as Address,
        deploymentBlock: 100 + index,
        runtimeCodeHash: keccak256(bytecodes[role]),
      },
    ]),
  ) as LegacyReleaseReference["contracts"];
  const reference: LegacyReleaseReference = {
    registrarVersion: "v1",
    releaseId: hash(700),
    verifiedAtBlock: 800,
    contracts,
    controllerPolicy: { registrationsPaused: true },
    marketplacePolicy: { paused: false },
  };
  const manifest = {
    registrarVersion: "v2",
    namespace: {
      suffix: "contour",
      baseNode: namehash("contour"),
    },
    settlement: {
      erc20Address: "0x3600000000000000000000000000000000000000",
    },
    normalization: {
      profileHash: hash(701),
    },
  } as DeploymentManifest;

  function legacyClient(overrides: {
    registrationsPaused?: boolean;
    marketplacePaused?: boolean;
    releaseId?: Hex;
    runtimeRole?: ContractKey;
  } = {}) {
    const observedBlocks: bigint[] = [];
    const getCode = vi.fn(async ({ address, blockNumber: pinnedBlock }: {
      address: Address;
      blockNumber?: bigint;
    }) => {
      observedBlocks.push(pinnedBlock!);
      const role = roles.find(
        (candidate) =>
          contracts[candidate].address.toLowerCase() === address.toLowerCase(),
      )!;
      if (role === overrides.runtimeRole) return "0x6000" as Hex;
      return bytecodes[role];
    });
    const readContract = vi.fn(async ({
      address,
      functionName,
      blockNumber: pinnedBlock,
    }: {
      address: Address;
      functionName: string;
      blockNumber?: bigint;
    }) => {
      observedBlocks.push(pinnedBlock!);
      const normalized = address.toLowerCase();
      if (normalized === contracts.baseRegistrar.address.toLowerCase()) {
        if (functionName === "registry") return contracts.registry.address;
        if (functionName === "baseNode") return manifest.namespace.baseNode;
      }
      if (normalized === contracts.controller.address.toLowerCase()) {
        if (functionName === "registrar") return contracts.baseRegistrar.address;
        if (functionName === "settlementAsset") return manifest.settlement.erc20Address;
        if (functionName === "publicResolver") return contracts.publicResolver.address;
        if (functionName === "baseNode") return manifest.namespace.baseNode;
        if (functionName === "releaseId") return overrides.releaseId ?? reference.releaseId;
        if (functionName === "normalizationProfileHash") {
          return manifest.normalization.profileHash;
        }
        if (functionName === "registrationsPaused") {
          return overrides.registrationsPaused ?? true;
        }
      }
      if (normalized === contracts.publicResolver.address.toLowerCase()) {
        if (functionName === "registry") return contracts.registry.address;
      }
      if (normalized === contracts.reverseRegistrar.address.toLowerCase()) {
        if (functionName === "registry") return contracts.registry.address;
        if (functionName === "defaultResolver") return contracts.publicResolver.address;
        if (functionName === "registrar") return contracts.baseRegistrar.address;
        if (functionName === "reverseNode") return namehash("addr.reverse");
        if (functionName === "baseNode") return manifest.namespace.baseNode;
        if (functionName === "suffix") return manifest.namespace.suffix;
      }
      if (normalized === contracts.universalResolver.address.toLowerCase()) {
        if (functionName === "registry") return contracts.registry.address;
        if (functionName === "reverseRegistrar") return contracts.reverseRegistrar.address;
      }
      if (normalized === contracts.marketplace.address.toLowerCase()) {
        if (functionName === "registrar") return contracts.baseRegistrar.address;
        if (functionName === "settlementAsset") return manifest.settlement.erc20Address;
        if (functionName === "paused") return overrides.marketplacePaused ?? false;
      }
      throw new Error(`unexpected legacy read ${address}:${functionName}`);
    });
    return {
      client: { getCode, readContract },
      observedBlocks,
    };
  }

  it("pins all seven runtime hashes, immutable wiring, and cutover policy to one current block", async () => {
    const fixture = legacyClient();
    const report = await verifyLegacyReleaseAtBlock(
      fixture.client as never,
      manifest,
      reference,
      blockNumber,
    );

    expect(report).toMatchObject({
      releaseId: reference.releaseId,
      referenceVerifiedAtBlock: "800",
      verificationBlock: "900",
      registrationsPaused: true,
      marketplacePaused: false,
    });
    expect(Object.keys(report.contracts)).toEqual(roles);
    expect(fixture.observedBlocks).toHaveLength(28);
    expect(new Set(fixture.observedBlocks)).toEqual(new Set([blockNumber]));
  });

  it("rejects stale runtime identity, registration overlap, and a closed legacy market", async () => {
    await expect(verifyLegacyReleaseAtBlock(
      legacyClient({ runtimeRole: "marketplace" }).client as never,
      manifest,
      reference,
      blockNumber,
    )).rejects.toThrow(/legacy marketplace runtime code hash mismatch/);
    await expect(verifyLegacyReleaseAtBlock(
      legacyClient({ registrationsPaused: false }).client as never,
      manifest,
      reference,
      blockNumber,
    )).rejects.toThrow(/registrations must be paused/);
    await expect(verifyLegacyReleaseAtBlock(
      legacyClient({ marketplacePaused: true }).client as never,
      manifest,
      reference,
      blockNumber,
    )).rejects.toThrow(/marketplace must remain unpaused/);
  });

  it("rejects an unconfirmed reference block or a different on-chain release identity", async () => {
    await expect(verifyLegacyReleaseAtBlock(
      legacyClient().client as never,
      manifest,
      reference,
      799n,
    )).rejects.toThrow(/ahead of the pinned current block/);
    await expect(verifyLegacyReleaseAtBlock(
      legacyClient({ releaseId: hash(999) }).client as never,
      manifest,
      reference,
      blockNumber,
    )).rejects.toThrow(/release ID mismatch/);
  });
});

describe("registrar controller history log ranges", () => {
  it("queries ordered inclusive ranges of at most 1,000 blocks without gaps or duplicates", async () => {
    const calls: ControllerHistoryBlockRange[] = [];
    const values = await readControllerHistoryInChunks(12_345n, 15_345n, async (range) => {
      calls.push(range);
      return [`${range.fromBlock}-${range.toBlock}`];
    });

    expect(calls).toEqual([
      { fromBlock: 12_345n, toBlock: 13_344n },
      { fromBlock: 13_345n, toBlock: 14_344n },
      { fromBlock: 14_345n, toBlock: 15_344n },
      { fromBlock: 15_345n, toBlock: 15_345n },
    ]);
    expect(values).toEqual(["12345-13344", "13345-14344", "14345-15344", "15345-15345"]);
    expect(calls.every(({ fromBlock, toBlock }) => toBlock - fromBlock + 1n <= 1_000n)).toBe(true);
    expect(calls.reduce((count, range) => count + range.toBlock - range.fromBlock + 1n, 0n))
      .toBe(3_001n);
    for (let index = 1; index < calls.length; index += 1) {
      expect(calls[index]!.fromBlock).toBe(calls[index - 1]!.toBlock + 1n);
    }
    expect(calls.at(-1)!.toBlock).toBe(15_345n);
  });

  it("stops at the first RPC error and rejects invalid ranges before querying", async () => {
    const calls: ControllerHistoryBlockRange[] = [];
    const rpcError = new Error("Arc RPC rejected eth_getLogs");

    await expect(readControllerHistoryInChunks(1n, 2_500n, async (range) => {
      calls.push(range);
      if (calls.length === 2) throw rpcError;
      return [];
    })).rejects.toBe(rpcError);
    expect(calls).toEqual([
      { fromBlock: 1n, toBlock: 1_000n },
      { fromBlock: 1_001n, toBlock: 2_000n },
    ]);

    let queried = false;
    await expect(readControllerHistoryInChunks(2n, 1n, async () => {
      queried = true;
      return [];
    })).rejects.toThrow(/block range is invalid/);
    expect(queried).toBe(false);
  });
});

describe("indexed registrar controller history verification", () => {
  it("paginates the exact range and RPC-verifies receipts, logs, blocks and current state", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => explorerRow(index));
    const requested: URL[] = [];
    const report = await verifyIndexedControllerHistory(
      verificationOptions(rows, arcScanFetch([rows.slice(0, 100), rows.slice(100)], requested)),
    );

    expect(requested).toHaveLength(2);
    for (const [index, url] of requested.entries()) {
      expect(url.origin).toBe(ARC_TESTNET_EXPLORER_URL);
      expect(url.pathname).toBe("/api");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        module: "logs",
        action: "getLogs",
        fromBlock: "100",
        toBlock: "10000",
        address: REGISTRAR,
        topic0: CONTROLLER_CHANGED_TOPIC,
        page: String(index + 1),
        offset: "100",
        sort: "asc",
      });
    }
    const digestInput = rows.map((row) => [
      rowQuantity(row.blockNumber).toString(),
      rowQuantity(row.transactionIndex).toString(),
      rowQuantity(row.logIndex).toString(),
      canonicalBlockHash(row).toLowerCase(),
      row.transactionHash.toLowerCase(),
      CONTROLLER.toLowerCase(),
      "1",
    ].join(":")).join("\n");
    expect(report).toEqual({
      source: "arcscan-index-canonical-rpc",
      eventCount: 101,
      eventDigest: sha256(new TextEncoder().encode(digestInput)),
      firstBlock: "100",
      lastBlock: "200",
    });
  });

  it("accepts the live ArcScan four-topic row shape without an explorer block hash", async () => {
    const liveRegistrar = "0x0DF136b94f99CAfcC010723b51f8D8EC10A0B907" as Address;
    const liveController = "0xFbA7618c929075728b82c69B0B2A8C8d98e4B6A3" as Address;
    const liveGovernance = "0x78de409a6306550882328E2a67160471368387FF" as Address;
    const row: ExplorerRow = {
      address: liveRegistrar,
      topics: [
        CONTROLLER_CHANGED_TOPIC,
        encodeAbiParameters(parseAbiParameters("address"), [liveController]),
        null,
        null,
      ],
      data: encodeAbiParameters(parseAbiParameters("bool"), [true]),
      blockNumber: "0x31c55c8",
      transactionHash: "0x89dfe2b84b2488bfd695972b8230c3c169c0a2041df612b96c9d26d5a1b12aa4",
      transactionIndex: "0xc",
      logIndex: "0x11",
    };
    expect(Object.hasOwn(row, "blockHash")).toBe(false);
    const report = await verifyIndexedControllerHistory({
      client: indexedClient([row], { registrar: liveRegistrar, governance: liveGovernance }),
      fetcher: arcScanFetch([[row]]),
      explorerUrl: ARC_TESTNET_EXPLORER_URL,
      registrar: liveRegistrar,
      canonicalController: liveController,
      governanceAccount: liveGovernance,
      fromBlock: 52_188_614n,
      toBlock: 52_190_647n,
    });
    expect(report.eventCount).toBe(1);
    expect(report.firstBlock).toBe("52188616");
    expect(report.lastBlock).toBe("52188616");
  });

  it("rejects missing, internally-gapped and non-null extra ArcScan topics", async () => {
    const base = explorerRow(0);
    const malformedTopics: ExplorerRow["topics"][] = [
      [CONTROLLER_CHANGED_TOPIC] as unknown as ExplorerRow["topics"],
      [CONTROLLER_CHANGED_TOPIC, null, null, null] as unknown as ExplorerRow["topics"],
      [CONTROLLER_CHANGED_TOPIC, base.topics[1], hash(1), null] as unknown as ExplorerRow["topics"],
      [CONTROLLER_CHANGED_TOPIC, base.topics[1], null, null, null] as unknown as ExplorerRow["topics"],
    ];
    for (const topics of malformedTopics) {
      const row = explorerRow(0, { topics });
      await expect(verifyIndexedControllerHistory(
        verificationOptions([row], arcScanFetch([[row]])),
      )).rejects.toThrow(/row topics are malformed/);
    }
  });

  it("fails closed for an empty or ambiguous ArcScan history", async () => {
    await expect(verifyIndexedControllerHistory(
      verificationOptions([], arcScanFetch([[]])),
    )).rejects.toThrow(/controller history is empty/);

    const ambiguous = vi.fn(async () => new Response(JSON.stringify({
      status: "0",
      message: "NOTOK",
      result: [],
    }))) as unknown as typeof fetch;
    await expect(verifyIndexedControllerHistory(
      verificationOptions([], ambiguous),
    )).rejects.toThrow(/ambiguous status semantics/);
  });

  it("fails closed when pagination has no bounded terminal page", async () => {
    const rows = Array.from({ length: 5_000 }, (_, index) => explorerRow(index));
    const pages = Array.from({ length: 50 }, (_, page) => rows.slice(page * 100, page * 100 + 100));
    await expect(verifyIndexedControllerHistory(
      verificationOptions(rows, arcScanFetch(pages)),
    )).rejects.toThrow(/pagination exceeded its safety bound/);
  });

  it("rejects duplicates across pages before trusting ArcScan completeness", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => explorerRow(index));
    await expect(verifyIndexedControllerHistory(
      verificationOptions(rows, arcScanFetch([rows, [rows.at(-1)!]])),
    )).rejects.toThrow(/duplicate event/);
  });

  it("rejects out-of-range and non-decodable event rows", async () => {
    const outside = explorerRow(0, { blockNumber: "0x63" });
    await expect(verifyIndexedControllerHistory(
      verificationOptions([outside], arcScanFetch([[outside]])),
    )).rejects.toThrow(/outside the pinned block range/);

    const malformed = explorerRow(0, {
      data: `0x${"00".repeat(31)}02` as Hex,
    });
    await expect(verifyIndexedControllerHistory(
      verificationOptions([malformed], arcScanFetch([[malformed]])),
    )).rejects.toThrow(/strictly decode as ControllerChanged/);
  });

  it("rejects canonical RPC receipt, log, block and governance cross-binding mismatches", async () => {
    const row = explorerRow(0);
    const receiptMismatch = indexedClient([row], {
      mutateReceipt: (receipt) => ({ ...receipt, blockNumber: receipt.blockNumber + 1n }),
    });
    await expect(verifyIndexedControllerHistory(
      verificationOptions([row], arcScanFetch([[row]]), receiptMismatch),
    )).rejects.toThrow(/transaction receipt mismatch/);

    const logMismatch = indexedClient([row], {
      mutateReceipt: (receipt) => ({
        ...receipt,
        logs: [{ ...receipt.logs[0]!, data: `0x${"00".repeat(32)}` as Hex }],
      }),
    });
    await expect(verifyIndexedControllerHistory(
      verificationOptions([row], arcScanFetch([[row]]), logMismatch),
    )).rejects.toThrow(/receipt log mismatch/);

    const blockMismatch = indexedClient([row], {
      mutateBlock: (block) => ({ ...block, hash: hash(999_999) }),
    });
    await expect(verifyIndexedControllerHistory(
      verificationOptions([row], arcScanFetch([[row]]), blockMismatch),
    )).rejects.toThrow(/block hash mismatch/);

    const senderMismatch = indexedClient([row], {
      mutateReceipt: (receipt) => ({
        ...receipt,
        from: "0x4000000000000000000000000000000000000004" as Address,
      }),
    });
    await expect(verifyIndexedControllerHistory(
      verificationOptions([row], arcScanFetch([[row]]), senderMismatch),
    )).rejects.toThrow(/receipt sender mismatch/);
  });

  it("rejects a history or pinned state that does not enable only the canonical controller", async () => {
    const nonCanonical = "0x4000000000000000000000000000000000000004" as Address;
    const wrongInitial = explorerRow(0, {
      topics: [
        CONTROLLER_CHANGED_TOPIC,
        encodeAbiParameters(parseAbiParameters("address"), [nonCanonical]),
        null,
        null,
      ],
    });
    await expect(verifyIndexedControllerHistory(
      verificationOptions([wrongInitial], arcScanFetch([[wrongInitial]])),
    )).rejects.toThrow(/initial registrar controller event/);

    const row = explorerRow(0);
    await expect(verifyIndexedControllerHistory(
      verificationOptions([row], arcScanFetch([[row]]), indexedClient([row], { currentEnabled: false })),
    )).rejects.toThrow(/not enabled at the pinned latest block/);
  });
});

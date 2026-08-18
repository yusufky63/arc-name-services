import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  isHex,
  keccak256,
  padHex,
  parseAbiItem,
  stringToHex,
  toHex,
  toEventSelector,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  ARC_TESTNET_CHAIN_ID,
  registrarVersionOf,
  requireDeployedContract,
  type DeploymentManifest,
} from "@contour/config";
import { deriveNameIdentity } from "@contour/normalization";
import {
  baseRegistrarAbi,
  controllerAbi,
  marketplaceAbi,
  type NameRecord,
} from "@contour/sdk";
import {
  getReadableReleaseManifest,
  getReadableReleaseManifests,
  readableReleaseKey,
} from "./manifest";
import { arcTestnet } from "./network";
import type {
  AccountSnapshot,
  LiveMarketListing,
  MarketSnapshot,
  OwnedName,
} from "./market-data";
import {
  InvalidNftLabelHintError,
  InvalidNftReleaseIdError,
  MAX_NFT_LABEL_HINT_CODE_UNITS,
  type NameNftSnapshot,
} from "./nft-metadata";
import { rateLimitedArcHttp, resolveCanonicalArcRpcUrl } from "./arc-rpc";
import { getSharedProtocolClient } from "./protocol-client";

const LISTED_EVENT = parseAbiItem(
  "event Listed(uint256 indexed tokenId, address indexed seller, uint256 price, uint64 validUntil)",
);
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);
const NAME_REGISTERED_EVENT = parseAbiItem(
  "event NameRegistered(string name, bytes32 indexed label, address indexed owner, uint256 baseCost, uint256 premium, uint256 expires)",
);

const EXPLORER_LOG_RESULT_LIMIT = 1_000;
const MAX_STATE_CANDIDATES = 200;
const MAX_CONCURRENT_SNAPSHOT_READS = 8;
const LABEL_CACHE_MS = 15_000;
const SNAPSHOT_CACHE_MS = 60_000;
const CONFIRMED_HEAD_CACHE_MS = 5_000;
const NFT_SNAPSHOT_CACHE_MS = 30_000;

type ProtocolPublicClient = ReturnType<typeof createPublicClient>;

let protocolClient: ProtocolPublicClient | null = null;
const labelCache = new Map<
  string,
  { expiresAt: number; promise: Promise<Map<bigint, string>> }
>();
let marketSnapshotCache:
  | { expiresAt: number; promise: Promise<MarketSnapshot> }
  | null = null;
let protocolChainAssertion: Promise<void> | null = null;
let confirmedHeadCache:
  | { expiresAt: number; promise: Promise<bigint> }
  | null = null;
const accountSnapshotCache = new Map<
  string,
  { expiresAt: number; promise: Promise<AccountSnapshot> }
>();
const nftSnapshotCache = new Map<
  string,
  { expiresAt: number; promise: Promise<NameNftSnapshot | null> }
>();

export function invalidateMarketSnapshot() {
  marketSnapshotCache = null;
  confirmedHeadCache = null;
}

export function invalidateAccountSnapshot(owner: Address) {
  accountSnapshotCache.delete(getAddress(owner).toLowerCase());
  confirmedHeadCache = null;
}

export function invalidateNameDiscovery() {
  labelCache.clear();
  nftSnapshotCache.clear();
  confirmedHeadCache = null;
}
let activeSnapshotReads = 0;
const snapshotReadWaiters: Array<() => void> = [];
async function boundedSnapshotRead<T>(read: () => Promise<T>): Promise<T> {
  if (activeSnapshotReads >= MAX_CONCURRENT_SNAPSHOT_READS) {
    await new Promise<void>((resolve) => snapshotReadWaiters.push(resolve));
  } else {
    activeSnapshotReads += 1;
  }
  try {
    return await read();
  } finally {
    const next = snapshotReadWaiters.shift();
    if (next) next();
    else activeSnapshotReads -= 1;
  }
}

function readableManifests(): readonly DeploymentManifest[] {
  const manifests = getReadableReleaseManifests();
  if (manifests.length === 0) {
    throw new Error("The source-verified name deployment is not readable.");
  }
  return manifests;
}

function marketReadableManifests(): readonly DeploymentManifest[] {
  const manifests = readableManifests().filter(
    (manifest) => manifest.contracts.marketplace.address !== null,
  );
  if (manifests.length === 0) {
    throw new Error("The source-verified marketplace deployment is not readable.");
  }
  return manifests;
}

function releaseIdOf(manifest: DeploymentManifest): Hex {
  if (manifest.releaseId === null) {
    throw new Error("A readable release must publish a release ID.");
  }
  return manifest.releaseId;
}

function releaseIdentity(manifest: DeploymentManifest) {
  const releaseId = releaseIdOf(manifest);
  const key = readableReleaseKey(releaseId);
  if (!key) throw new Error("The release is not part of the readable Contour set.");
  return {
    releaseId,
    releaseKey: key,
  } as const;
}

export class CrossReleaseNameConflictError extends Error {
  constructor() {
    super("The name is protected by more than one Contour release.");
    this.name = "CrossReleaseNameConflictError";
  }
}

export function getProtocolPublicClient(): ProtocolPublicClient {
  const manifest = readableManifests()[0]!;
  if (!protocolClient) {
    const rpcUrl = resolveCanonicalArcRpcUrl(process.env.ARC_RPC_URL, manifest.chain.rpcUrl);
    protocolClient = createPublicClient({
      batch: { multicall: { wait: 25 } },
      chain: arcTestnet,
      transport: rateLimitedArcHttp(rpcUrl),
    });
  }
  return protocolClient;
}

export async function assertArcProtocolClient(
  client: Pick<PublicClient, "getChainId">,
): Promise<void> {
  const chainId = await client.getChainId();
  if (chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error(
      `Arc RPC chain mismatch: expected ${ARC_TESTNET_CHAIN_ID}, received ${chainId}`,
    );
  }
}

function assertSharedArcProtocolClient(client: ProtocolPublicClient): Promise<void> {
  if (!protocolChainAssertion) {
    const assertion = assertArcProtocolClient(client);
    protocolChainAssertion = assertion.catch((error) => {
      protocolChainAssertion = null;
      throw error;
    });
  }
  return protocolChainAssertion;
}

function deploymentBlock(
  manifest: DeploymentManifest,
  contract: keyof DeploymentManifest["contracts"],
): bigint {
  const block = manifest.contracts[contract].deploymentBlock;
  if (block === null) throw new Error(`${contract} deployment block is not verified.`);
  return BigInt(block);
}

async function confirmedHead(
  client: ProtocolPublicClient,
  manifest: DeploymentManifest,
): Promise<bigint> {
  if (confirmedHeadCache && confirmedHeadCache.expiresAt > Date.now()) {
    return confirmedHeadCache.promise;
  }
  const promise = (async () => {
    // A block-number read is non-contract metadata and may safely overlap the
    // cached chain assertion. No contract state is read until this gate passes.
    const [, latest] = await Promise.all([
      assertSharedArcProtocolClient(client),
      client.getBlockNumber({ cacheTime: 0 }),
    ]);
    const depth = BigInt(Math.max(1, manifest.chain.confirmations));
    if (latest + 1n < depth) throw new Error("Arc RPC has not reached a confirmed block.");
    return latest - depth + 1n;
  })();
  confirmedHeadCache = {
    expiresAt: Date.now() + CONFIRMED_HEAD_CACHE_MS,
    promise,
  };
  promise.catch(() => {
    if (confirmedHeadCache?.promise === promise) confirmedHeadCache = null;
  });
  return promise;
}

function selectedReadableManifests(
  releaseId?: string,
): readonly DeploymentManifest[] {
  if (releaseId === undefined) return readableManifests();
  const manifest = getReadableReleaseManifest(releaseId);
  if (!manifest) throw new Error("The requested Contour release is not readable.");
  return [manifest];
}

export type ReleaseNameRecord = NameRecord & {
  releaseKey: "canonical" | "legacy";
};

export async function readNameAcrossReleases(
  label: string,
  releaseId?: string,
): Promise<ReleaseNameRecord> {
  const manifests = selectedReadableManifests(releaseId);
  const client = getProtocolPublicClient();
  const head = await confirmedHead(client, readableManifests()[0]!);
  const records = await Promise.all(
    manifests.map(async (manifest) => ({
      ...await getSharedProtocolClient(manifest).names.name(label, {
        blockNumber: head,
      }),
      releaseKey: releaseIdentity(manifest).releaseKey,
    })),
  );
  if (releaseId !== undefined) return records[0]!;
  const protectedRecords = records.filter((record) => !record.available);
  if (protectedRecords.length > 1) throw new CrossReleaseNameConflictError();
  return protectedRecords[0] ?? records[0]!;
}

export async function readReverseAcrossReleases(
  account: Address,
  releaseId?: string,
): Promise<{
  releaseId: Hex;
  releaseKey: "canonical" | "legacy";
  name: string | null;
  forwardConfirmed: boolean;
}> {
  const manifests = selectedReadableManifests(releaseId);
  const client = getProtocolPublicClient();
  const head = await confirmedHead(client, readableManifests()[0]!);
  const results = await Promise.all(
    manifests.map(async (manifest) => ({
      ...await getSharedProtocolClient(manifest).names.reverse(account, {
        blockNumber: head,
      }),
      releaseKey: releaseIdentity(manifest).releaseKey,
    })),
  );
  return results.find((result) => result.name !== null) ?? results[0]!;
}

type ExplorerLog = {
  blockNumber: bigint;
  data: Hex;
  topics: [Hex, ...Hex[]];
};

async function explorerEventLogs(
  manifest: DeploymentManifest,
  address: Address,
  topic0: Hex,
  fromBlock: bigint,
  toBlock: bigint,
  indexedTopic?: { index: 1 | 2 | 3; value: Hex },
): Promise<ExplorerLog[]> {
  const endpoint = new URL("/api", manifest.chain.explorerUrl);
  endpoint.searchParams.set("module", "logs");
  endpoint.searchParams.set("action", "getLogs");
  endpoint.searchParams.set("fromBlock", fromBlock.toString());
  endpoint.searchParams.set("toBlock", toBlock.toString());
  endpoint.searchParams.set("address", address);
  endpoint.searchParams.set("topic0", topic0);
  if (indexedTopic) {
    endpoint.searchParams.set(`topic${indexedTopic.index}`, indexedTopic.value);
    endpoint.searchParams.set(`topic0_${indexedTopic.index}_opr`, "and");
  }

  const response = await fetch(endpoint, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`ArcScan log discovery failed with HTTP ${response.status}.`);
  }
  const payload = await response.json() as {
    status?: unknown;
    message?: unknown;
    result?: unknown;
  };
  if (!Array.isArray(payload.result)) {
    throw new Error("ArcScan log discovery returned an invalid envelope.");
  }
  if (payload.result.length >= EXPLORER_LOG_RESULT_LIMIT) {
    throw new Error("ArcScan event discovery reached its public result bound.");
  }
  if (payload.status !== "1" && payload.result.length > 0) {
    throw new Error("ArcScan log discovery returned a failed result.");
  }

  const logs: ExplorerLog[] = [];
  for (const item of payload.result) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const topics = Array.isArray(candidate.topics)
      ? candidate.topics.filter((topic): topic is Hex => typeof topic === "string" && isHex(topic))
      : [];
    if (topics.length === 0 || !isHex(candidate.data)) continue;
    let blockNumber: bigint;
    try {
      blockNumber = BigInt(String(candidate.blockNumber));
    } catch {
      continue;
    }
    if (blockNumber < fromBlock || blockNumber > toBlock) continue;
    logs.push({
      blockNumber,
      data: candidate.data,
      topics: topics as [Hex, ...Hex[]],
    });
  }
  return logs;
}

function verifiedRegisteredLabel(
  log: ExplorerLog,
  suffix: string,
): { tokenId: bigint; label: string } | null {
  let decoded: ReturnType<typeof decodeEventLog<typeof NAME_REGISTERED_EVENT[]>>;
  try {
    decoded = decodeEventLog({
      abi: [NAME_REGISTERED_EVENT],
      data: log.data,
      topics: log.topics,
      strict: true,
    });
  } catch {
    return null;
  }
  const labelHash = decoded.args.label;
  const normalizedLabel = decoded.args.name;
  if (!labelHash || typeof normalizedLabel !== "string") return null;
  try {
    const identity = deriveNameIdentity(normalizedLabel, suffix);
    if (
      identity.changed ||
      identity.labelhash.toLowerCase() !== labelHash.toLowerCase() ||
      keccak256(stringToHex(normalizedLabel)).toLowerCase() !==
        labelHash.toLowerCase()
    ) {
      return null;
    }
    return { tokenId: identity.tokenId, label: identity.normalized };
  } catch {
    return null;
  }
}

async function registeredLabels(
  manifest: DeploymentManifest,
  head: bigint,
): Promise<Map<bigint, string>> {
  const key = `${releaseIdOf(manifest).toLowerCase()}:${head}`;
  const cached = labelCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = (async () => {
    const labels = new Map<bigint, string>();
    const address = requireDeployedContract(manifest, "controller");
    const suffix = manifest.namespace.suffix;
    if (!suffix) throw new Error("The deployed namespace suffix is missing.");
    const from = deploymentBlock(manifest, "controller");
    if (from > head) return labels;
    const logs = await explorerEventLogs(
      manifest,
      address,
      toEventSelector(NAME_REGISTERED_EVENT),
      from,
      head,
    );
    for (const log of logs) {
      const verified = verifiedRegisteredLabel(log, suffix);
      if (verified) labels.set(verified.tokenId, verified.label);
    }
    return labels;
  })();
  labelCache.set(key, { expiresAt: Date.now() + LABEL_CACHE_MS, promise });
  promise.catch(() => {
    if (labelCache.get(key)?.promise === promise) labelCache.delete(key);
  });
  return promise;
}

async function registeredLabel(
  manifest: DeploymentManifest,
  head: bigint,
  tokenId: bigint,
): Promise<string | undefined> {
  const suffix = manifest.namespace.suffix;
  if (!suffix) throw new Error("The deployed namespace suffix is missing.");
  const address = requireDeployedContract(manifest, "controller");
  const from = deploymentBlock(manifest, "controller");
  if (from > head) return undefined;
  const logs = await explorerEventLogs(
    manifest,
    address,
    toEventSelector(NAME_REGISTERED_EVENT),
    from,
    head,
    { index: 1, value: toHex(tokenId, { size: 32 }) },
  );
  for (const log of logs) {
    const verified = verifiedRegisteredLabel(log, suffix);
    if (verified?.tokenId === tokenId) return verified.label;
  }
  return undefined;
}

async function listedTokenIds(
  manifest: DeploymentManifest,
  head: bigint,
): Promise<Set<bigint>> {
  const result = new Set<bigint>();
  const address = requireDeployedContract(manifest, "marketplace");
  const from = deploymentBlock(manifest, "marketplace");
  if (from > head) return result;
  const logs = await explorerEventLogs(
    manifest,
    address,
    toEventSelector(LISTED_EVENT),
    from,
    head,
  );
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: [LISTED_EVENT],
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (decoded.args.tokenId !== undefined) result.add(decoded.args.tokenId);
    } catch {
      // Malformed explorer rows never become marketplace candidates.
    }
  }
  return result;
}

async function ownerTokenIds(
  manifest: DeploymentManifest,
  owner: Address,
  head: bigint,
): Promise<Set<bigint>> {
  const result = new Set<bigint>();
  const address = requireDeployedContract(manifest, "baseRegistrar");
  const from = deploymentBlock(manifest, "baseRegistrar");
  if (from > head) return result;
  // Candidate discovery is one indexed ArcScan request instead of a serial
  // deployment-to-head eth_getLogs scan. Explorer rows are never trusted as
  // ownership: every candidate is re-read at the pinned confirmed RPC block.
  const logs = await explorerEventLogs(
    manifest,
    address,
    toEventSelector(TRANSFER_EVENT),
    from,
    head,
    { index: 2, value: padHex(owner, { size: 32 }) },
  );
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: [TRANSFER_EVENT],
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (
        decoded.args.to !== undefined &&
        getAddress(decoded.args.to) === getAddress(owner) &&
        decoded.args.tokenId !== undefined
      ) {
        result.add(decoded.args.tokenId);
      }
    } catch {
      // Malformed or falsely indexed explorer rows cannot become candidates.
    }
  }
  return result;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      const value = values[index];
      if (value !== undefined) output[index] = await transform(value);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => worker()),
  );
  return output;
}

function liveListingFromState(
  manifest: DeploymentManifest,
  tokenId: bigint,
  label: string,
  listing: readonly [Address, bigint, bigint],
  owner: Address,
  expiry: bigint,
  active: boolean,
  feeBps: number,
  marketPaused: boolean,
): LiveMarketListing | null {
  const [seller, price, validUntil] = listing;
  if (
    seller === zeroAddress ||
    price === 0n ||
    validUntil === 0n ||
    !active ||
    getAddress(owner) !== getAddress(seller) ||
    validUntil > expiry
  ) {
    return null;
  }
  const release = releaseIdentity(manifest);
  return {
    ...release,
    tokenId: tokenId.toString(),
    label,
    name: `${label}.${manifest.namespace.suffix}`,
    seller: getAddress(seller),
    price: price.toString(),
    validUntil: validUntil.toString(),
    expiry: expiry.toString(),
    feeBps,
    marketPaused,
  };
}

async function listingAt(
  client: ProtocolPublicClient,
  manifest: DeploymentManifest,
  tokenId: bigint,
  label: string,
  head: bigint,
  feeBps: number,
  marketPaused: boolean,
): Promise<LiveMarketListing | null> {
  const market = requireDeployedContract(manifest, "marketplace");
  const registrar = requireDeployedContract(manifest, "baseRegistrar");
  const [listingResult, ownerResult, expiryResult, activeResult] = await Promise.allSettled([
    client.readContract({
      address: market,
      abi: marketplaceAbi,
      functionName: "listingOf",
      args: [tokenId],
      blockNumber: head,
    }),
    client.readContract({
      address: registrar,
      abi: baseRegistrarAbi,
      functionName: "ownerOf",
      args: [tokenId],
      blockNumber: head,
    }),
    client.readContract({
      address: registrar,
      abi: baseRegistrarAbi,
      functionName: "nameExpires",
      args: [tokenId],
      blockNumber: head,
    }),
    client.readContract({
      address: registrar,
      abi: baseRegistrarAbi,
      functionName: "isActive",
      args: [tokenId],
      blockNumber: head,
    }),
  ]);
  if (
    listingResult.status !== "fulfilled" ||
    ownerResult.status !== "fulfilled" ||
    expiryResult.status !== "fulfilled" ||
    activeResult.status !== "fulfilled"
  ) {
    return null;
  }
  return liveListingFromState(
    manifest,
    tokenId,
    label,
    listingResult.value,
    ownerResult.value,
    expiryResult.value,
    activeResult.value,
    feeBps,
    marketPaused,
  );
}

async function marketPolicy(
  client: ProtocolPublicClient,
  manifest: DeploymentManifest,
  head: bigint,
) {
  const address = requireDeployedContract(manifest, "marketplace");
  const [feeBps, paused] = await Promise.all([
    client.readContract({
      address,
      abi: marketplaceAbi,
      functionName: "feeBps",
      blockNumber: head,
    }),
    client.readContract({
      address,
      abi: marketplaceAbi,
      functionName: "paused",
      blockNumber: head,
    }),
  ]);
  return { feeBps, paused };
}

async function readMarketSnapshotUncached(): Promise<MarketSnapshot> {
  const manifests = marketReadableManifests();
  const client = getProtocolPublicClient();
  const head = await confirmedHead(client, manifests[0]!);
  const [block, releaseListings] = await Promise.all([
    client.getBlock({ blockNumber: head }),
    Promise.all(manifests.map(async (manifest) => {
      const [tokens, policy] = await Promise.all([
        listedTokenIds(manifest, head),
        marketPolicy(client, manifest, head),
      ]);
      const labels = tokens.size > 0
        ? await registeredLabels(manifest, head)
        : new Map<bigint, string>();
      const known = [...tokens].filter((tokenId) => labels.has(tokenId));
      if (known.length > MAX_STATE_CANDIDATES) {
        throw new Error("Marketplace candidates exceed the direct RPC safety bound.");
      }
      return (
        await mapWithConcurrency(known, 8, async (tokenId) =>
          listingAt(
            client,
            manifest,
            tokenId,
            labels.get(tokenId) ?? "",
            head,
            policy.feeBps,
            policy.paused,
          ),
        )
      ).filter((item): item is LiveMarketListing => item !== null);
    })),
  ]);
  const listings = releaseListings.flat();
  if (listings.length > MAX_STATE_CANDIDATES) {
    throw new Error("Marketplace candidates exceed the direct RPC safety bound.");
  }
  listings.sort((left, right) => {
      if (left.releaseKey !== right.releaseKey) {
        return left.releaseKey === "canonical" ? -1 : 1;
      }
      const priceOrder = BigInt(left.price) - BigInt(right.price);
      return priceOrder === 0n ? left.name.localeCompare(right.name) : priceOrder < 0n ? -1 : 1;
    });
  return {
    chainId: ARC_TESTNET_CHAIN_ID,
    asOfBlock: head.toString(),
    asOfTimestamp: block.timestamp.toString(),
    listings,
  };
}

export function readMarketSnapshot(): Promise<MarketSnapshot> {
  if (marketSnapshotCache && marketSnapshotCache.expiresAt > Date.now()) {
    return marketSnapshotCache.promise;
  }
  const promise = boundedSnapshotRead(readMarketSnapshotUncached);
  marketSnapshotCache = { expiresAt: Date.now() + SNAPSHOT_CACHE_MS, promise };
  promise.catch(() => {
    if (marketSnapshotCache?.promise === promise) marketSnapshotCache = null;
  });
  return promise;
}

async function readAccountSnapshotUncached(ownerInput: Address): Promise<AccountSnapshot> {
  const manifests = marketReadableManifests();
  const owner = getAddress(ownerInput);
  const client = getProtocolPublicClient();
  const head = await confirmedHead(client, manifests[0]!);
  const block = await client.getBlock({ blockNumber: head });
  const releaseSnapshots = await Promise.all(
    manifests.map(async (manifest) => {
      const controller = requireDeployedContract(manifest, "controller");
      const marketplace = requireDeployedContract(manifest, "marketplace");
      const registrar = requireDeployedContract(manifest, "baseRegistrar");
      const [labels, tokens, policy, referralCredits, sellerProceeds] =
        await Promise.all([
          registeredLabels(manifest, head),
          ownerTokenIds(manifest, owner, head),
          marketPolicy(client, manifest, head),
          client.readContract({
            address: controller,
            abi: controllerAbi,
            functionName: "referralCredits",
            args: [owner],
            blockNumber: head,
          }),
          client.readContract({
            address: marketplace,
            abi: marketplaceAbi,
            functionName: "proceeds",
            args: [owner],
            blockNumber: head,
          }),
        ]);
      if (tokens.size > MAX_STATE_CANDIDATES) {
        throw new Error("Account candidates exceed the direct RPC safety bound.");
      }
      const names = (
        await mapWithConcurrency(
          [...tokens],
          8,
          async (tokenId): Promise<OwnedName | null> => {
            const label = labels.get(tokenId);
            if (!label) return null;
            const [
              ownerResult,
              expiryResult,
              activeResult,
              graceResult,
              listingResult,
            ] = await Promise.allSettled([
              client.readContract({
                address: registrar,
                abi: baseRegistrarAbi,
                functionName: "ownerOf",
                args: [tokenId],
                blockNumber: head,
              }),
              client.readContract({
                address: registrar,
                abi: baseRegistrarAbi,
                functionName: "nameExpires",
                args: [tokenId],
                blockNumber: head,
              }),
              client.readContract({
                address: registrar,
                abi: baseRegistrarAbi,
                functionName: "isActive",
                args: [tokenId],
                blockNumber: head,
              }),
              client.readContract({
                address: registrar,
                abi: baseRegistrarAbi,
                functionName: "inGracePeriod",
                args: [tokenId],
                blockNumber: head,
              }),
              client.readContract({
                address: marketplace,
                abi: marketplaceAbi,
                functionName: "listingOf",
                args: [tokenId],
                blockNumber: head,
              }),
            ]);
            if (
              ownerResult.status !== "fulfilled" ||
              expiryResult.status !== "fulfilled" ||
              activeResult.status !== "fulfilled" ||
              graceResult.status !== "fulfilled" ||
              getAddress(ownerResult.value) !== owner
            ) {
              return null;
            }
            const listing =
              activeResult.value && listingResult.status === "fulfilled"
                ? liveListingFromState(
                    manifest,
                    tokenId,
                    label,
                    listingResult.value,
                    ownerResult.value,
                    expiryResult.value,
                    activeResult.value,
                    policy.feeBps,
                    policy.paused,
                  )
                : null;
            const lifecycle = activeResult.value
              ? "active"
              : graceResult.value ||
                  (expiryResult.value >= block.timestamp &&
                    expiryResult.value !== 0n)
                ? "grace"
                : "expired";
            return {
              ...releaseIdentity(manifest),
              tokenId: tokenId.toString(),
              label,
              name: `${label}.${manifest.namespace.suffix}`,
              expiry: expiryResult.value.toString(),
              lifecycle,
              listing,
            };
          },
        )
      ).filter((item): item is OwnedName => item !== null);
      return {
        ...releaseIdentity(manifest),
        referralCredits,
        sellerProceeds,
        marketPaused: policy.paused,
        names,
      };
    }),
  );
  const timestamp = block.timestamp;
  const names = releaseSnapshots.flatMap((snapshot) => snapshot.names);
  if (names.length > MAX_STATE_CANDIDATES) {
    throw new Error("Account candidates exceed the direct RPC safety bound.");
  }
  names.sort((left, right) => {
    if (left.releaseKey !== right.releaseKey) {
      return left.releaseKey === "canonical" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
  const releases = releaseSnapshots.map((snapshot) => ({
    releaseId: snapshot.releaseId,
    releaseKey: snapshot.releaseKey,
    referralCredits: snapshot.referralCredits.toString(),
    sellerProceeds: snapshot.sellerProceeds.toString(),
    marketPaused: snapshot.marketPaused,
  }));
  return {
    chainId: ARC_TESTNET_CHAIN_ID,
    asOfBlock: head.toString(),
    asOfTimestamp: timestamp.toString(),
    owner,
    referralCredits: releaseSnapshots
      .reduce((total, snapshot) => total + snapshot.referralCredits, 0n)
      .toString(),
    sellerProceeds: releaseSnapshots
      .reduce((total, snapshot) => total + snapshot.sellerProceeds, 0n)
      .toString(),
    marketPaused: releaseSnapshots.every((snapshot) => snapshot.marketPaused),
    releases,
    names,
  };
}

export function readAccountSnapshot(ownerInput: Address): Promise<AccountSnapshot> {
  const owner = getAddress(ownerInput);
  const key = owner.toLowerCase();
  const now = Date.now();
  const cached = accountSnapshotCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  for (const [cachedOwner, value] of accountSnapshotCache) {
    if (value.expiresAt <= now) accountSnapshotCache.delete(cachedOwner);
  }
  if (accountSnapshotCache.size >= 128) {
    const oldest = accountSnapshotCache.keys().next().value as string | undefined;
    if (oldest) accountSnapshotCache.delete(oldest);
  }
  const promise = boundedSnapshotRead(() => readAccountSnapshotUncached(owner));
  accountSnapshotCache.set(key, { expiresAt: now + SNAPSHOT_CACHE_MS, promise });
  promise.catch(() => {
    if (accountSnapshotCache.get(key)?.promise === promise) accountSnapshotCache.delete(key);
  });
  return promise;
}

function verifiedNftLabelHint(
  tokenId: bigint,
  labelHint: string,
  suffix: string,
): string {
  if (labelHint.length > MAX_NFT_LABEL_HINT_CODE_UNITS) {
    throw new InvalidNftLabelHintError();
  }
  try {
    const identity = deriveNameIdentity(labelHint, suffix);
    if (identity.changed || identity.tokenId !== tokenId) {
      throw new InvalidNftLabelHintError();
    }
    return identity.normalized;
  } catch (error) {
    if (error instanceof InvalidNftLabelHintError) throw error;
    throw new InvalidNftLabelHintError({ cause: error });
  }
}

async function readNftSnapshotUncached(
  tokenId: bigint,
  labelHint?: string,
  releaseId?: string,
): Promise<NameNftSnapshot | null> {
  const manifests = releaseId === undefined
    ? readableManifests()
    : [getReadableReleaseManifest(releaseId)].filter(
        (manifest): manifest is DeploymentManifest => manifest !== null,
      );
  if (manifests.length === 0) throw new InvalidNftReleaseIdError();
  const releaseInputs = manifests.map((manifest) => {
    const suffix = manifest.namespace.suffix;
    if (!suffix) throw new Error("The deployed namespace suffix is missing.");
    return {
      manifest,
      suffix,
      verifiedHint:
        labelHint === undefined
          ? undefined
          : verifiedNftLabelHint(tokenId, labelHint, suffix),
    };
  });
  const client = getProtocolPublicClient();
  const head = await confirmedHead(client, manifests[0]!);
  const block = await client.getBlock({ blockNumber: head });
  for (const { manifest, suffix, verifiedHint } of releaseInputs) {
    const label = verifiedHint ??
      await registeredLabel(manifest, head, tokenId);
    if (!label) continue;

    const registrarAddress = requireDeployedContract(manifest, "baseRegistrar");
    const [ownerResult, expiryResult, activeResult, graceResult] =
      await Promise.allSettled([
        client.readContract({
          address: registrarAddress,
          abi: baseRegistrarAbi,
          functionName: "ownerOf",
          args: [tokenId],
          blockNumber: head,
        }),
        client.readContract({
          address: registrarAddress,
          abi: baseRegistrarAbi,
          functionName: "nameExpires",
          args: [tokenId],
          blockNumber: head,
        }),
        client.readContract({
          address: registrarAddress,
          abi: baseRegistrarAbi,
          functionName: "isActive",
          args: [tokenId],
          blockNumber: head,
        }),
        client.readContract({
          address: registrarAddress,
          abi: baseRegistrarAbi,
          functionName: "inGracePeriod",
          args: [tokenId],
          blockNumber: head,
        }),
      ]);
    if (expiryResult.status === "rejected") throw expiryResult.reason;
    if (expiryResult.value === 0n) continue;
    if (ownerResult.status === "rejected") throw ownerResult.reason;
    if (activeResult.status === "rejected") throw activeResult.reason;
    if (graceResult.status === "rejected") throw graceResult.reason;

    return {
      ...releaseIdentity(manifest),
      registrarVersion: registrarVersionOf(manifest),
      chainId: manifest.chain.id,
      chainName: arcTestnet.name,
      explorerUrl: manifest.chain.explorerUrl,
      registrarAddress,
      suffix,
      tokenId: tokenId.toString(),
      label,
      name: `${label}.${suffix}`,
      owner: getAddress(ownerResult.value),
      expiry: expiryResult.value.toString(),
      lifecycle: activeResult.value
        ? "active"
        : graceResult.value
          ? "grace"
          : "expired",
      asOfBlock: head.toString(),
      asOfTimestamp: block.timestamp.toString(),
    };
  }
  return null;
}

export function readNftSnapshot(
  tokenId: bigint,
  labelHint?: string,
  releaseId?: string,
): Promise<NameNftSnapshot | null> {
  const key = `${releaseId?.toLowerCase() ?? "auto"}:${tokenId}:${labelHint ?? ""}`;
  const now = Date.now();
  const cached = nftSnapshotCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  for (const [cachedTokenId, value] of nftSnapshotCache) {
    if (value.expiresAt <= now) nftSnapshotCache.delete(cachedTokenId);
  }
  if (nftSnapshotCache.size >= 128) {
    const oldest = nftSnapshotCache.keys().next().value as string | undefined;
    if (oldest) nftSnapshotCache.delete(oldest);
  }
  const promise = boundedSnapshotRead(() =>
    readNftSnapshotUncached(tokenId, labelHint, releaseId),
  );
  nftSnapshotCache.set(key, { expiresAt: now + NFT_SNAPSHOT_CACHE_MS, promise });
  void promise.then(
    (snapshot) => {
      if (
        snapshot === null &&
        nftSnapshotCache.get(key)?.promise === promise
      ) {
        nftSnapshotCache.delete(key);
      }
    },
    () => {
      if (nftSnapshotCache.get(key)?.promise === promise) {
        nftSnapshotCache.delete(key);
      }
    },
  );
  return promise;
}

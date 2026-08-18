import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  toBytes,
  toEventSelector,
  zeroAddress,
} from "viem";

export const V1_ECONOMIC_CUTOVER_SCHEMA_VERSION = "1.0.0";
export const MAX_SAFE_LOG_BLOCK_SPAN = 1_000n;
const LOG_RESPONSE_SPLIT_THRESHOLD = 900;
const ARC_TESTNET_CHAIN_ID = 5_042_002;
const GRACE_PERIOD_SECONDS = 90n * 24n * 60n * 60n;
const CONTRACT_ROLES = Object.freeze([
  "registry",
  "baseRegistrar",
  "controller",
  "publicResolver",
  "reverseRegistrar",
  "universalResolver",
  "marketplace",
]);

export const V1_CONTROLLER_ECONOMIC_ABI = parseAbi([
  "function registrar() view returns (address)",
  "function settlementAsset() view returns (address)",
  "function releaseId() view returns (bytes32)",
  "function registrationsPaused() view returns (bool)",
  "function referralCredits(address referrer) view returns (uint256)",
  "function totalReferralLiability() view returns (uint256)",
  "function surplus() view returns (uint256)",
  "event NameRegistered(string name, bytes32 indexed label, address indexed owner, uint256 baseCost, uint256 premium, uint256 expires)",
  "event NameRenewed(string name, bytes32 indexed label, uint256 cost, uint256 expires)",
  "event ReferralAccrued(address indexed referrer, uint256 amount)",
  "event ReferralClaimed(address indexed referrer, uint256 amount)",
  "event TreasuryWithdrawal(address indexed treasury, uint256 amount)",
  "event RegistrationPauseChanged(bool paused)",
]);

export const V1_REGISTRAR_ECONOMIC_ABI = parseAbi([
  "function baseNode() view returns (bytes32)",
  "function ownerOf(uint256 id) view returns (address)",
  "function nameExpires(uint256 id) view returns (uint256)",
  "function isActive(uint256 id) view returns (bool)",
  "function inGracePeriod(uint256 id) view returns (bool)",
  "function available(uint256 id) view returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event NameRegistered(uint256 indexed id, address indexed owner, uint256 expires)",
  "event NameRenewed(uint256 indexed id, uint256 expires)",
]);

export const V1_MARKETPLACE_ECONOMIC_ABI = parseAbi([
  "function registrar() view returns (address)",
  "function settlementAsset() view returns (address)",
  "function paused() view returns (bool)",
  "function rawListingOf(uint256 tokenId) view returns ((address seller, uint256 price, uint64 validUntil))",
  "function listingOf(uint256 tokenId) view returns ((address seller, uint256 price, uint64 validUntil))",
  "function proceeds(address seller) view returns (uint256)",
  "function totalSellerLiability() view returns (uint256)",
  "function surplus() view returns (uint256)",
  "event Listed(uint256 indexed tokenId, address indexed seller, uint256 price, uint64 validUntil)",
  "event ListingCancelled(uint256 indexed tokenId, address indexed seller)",
  "event ListingInvalidated(uint256 indexed tokenId, address indexed formerSeller)",
  "event Purchased(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price, uint256 fee)",
  "event ProceedsClaimed(address indexed seller, uint256 amount)",
  "event FeeWithdrawal(address indexed treasury, uint256 amount)",
  "event PauseChanged(bool paused)",
]);

export const ECONOMIC_ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);

function fail(message) {
  throw new Error(`V1 economic cutover refused: ${message}`);
}

function isHex32(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isNonZeroHex32(value) {
  return isHex32(value) && !/^0x0{64}$/i.test(value);
}

function isNonZeroAddress(value) {
  return typeof value === "string"
    && isAddress(value)
    && getAddress(value) !== zeroAddress;
}

function bigintValue(value, field) {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  fail(`${field} must be a non-negative integer`);
}

function addressValue(value, field) {
  if (typeof value !== "string" || !isAddress(value)) fail(`${field} is not an address`);
  return getAddress(value);
}

function hex32Value(value, field) {
  if (!isHex32(value)) fail(`${field} is not bytes32`);
  return value.toLowerCase();
}

function decimal(value) {
  return bigintValue(value, "decimal value").toString();
}

function sameAddress(left, right) {
  return getAddress(left) === getAddress(right);
}

function sameHex(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function sortedObject(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sortedObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedObject(value[key])]),
  );
}

export function deterministicEconomicCutoverJson(value) {
  return `${JSON.stringify(sortedObject(value), null, 2)}\n`;
}

function normalizedManifestContracts(manifest) {
  const contracts = {};
  const addresses = new Set();
  for (const role of CONTRACT_ROLES) {
    const deployment = manifest?.contracts?.[role];
    if (
      !deployment ||
      !isNonZeroAddress(deployment.address) ||
      !Number.isSafeInteger(deployment.deploymentBlock) ||
      deployment.deploymentBlock <= 0 ||
      !isNonZeroHex32(deployment.runtimeCodeHash)
    ) {
      fail(`manifest ${role} deployment identity is incomplete`);
    }
    const contractAddress = getAddress(deployment.address);
    if (addresses.has(contractAddress.toLowerCase())) {
      fail(`manifest ${role} reuses a protocol contract address`);
    }
    addresses.add(contractAddress.toLowerCase());
    contracts[role] = {
      address: contractAddress,
      deploymentBlock: BigInt(deployment.deploymentBlock),
      runtimeCodeHash: deployment.runtimeCodeHash.toLowerCase(),
    };
  }
  return contracts;
}

export function assertV1EconomicCutoverInput(manifest, cutoverBlock) {
  const blockNumber = bigintValue(cutoverBlock, "cutover block");
  if (blockNumber <= 0n || blockNumber > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("cutover block must be a positive safe integer");
  }
  if ((manifest?.registrarVersion ?? "v1") !== "v1") {
    fail("manifest must be the retained V1 release");
  }
  if (
    manifest?.state !== "active" ||
    manifest?.chain?.id !== ARC_TESTNET_CHAIN_ID ||
    !isNonZeroHex32(manifest?.releaseId) ||
    !isNonZeroAddress(manifest?.settlement?.erc20Address) ||
    typeof manifest?.namespace?.suffix !== "string" ||
    manifest.namespace.suffix.length === 0 ||
    !isNonZeroHex32(manifest?.namespace?.baseNode)
  ) {
    fail("manifest is not a complete active Arc V1 release");
  }
  if (
    !Number.isSafeInteger(manifest?.activationEvidence?.verifiedAtBlock) ||
    BigInt(manifest.activationEvidence.verifiedAtBlock) !== blockNumber
  ) {
    fail("manifest verification block must equal the explicit economic cutover block");
  }
  if (manifest.activationEvidence.controllerPolicy?.registrationsPaused !== true) {
    fail("manifest must record registrationsPaused=true at cutover");
  }
  if (manifest.activationEvidence.marketplacePolicy?.paused !== false) {
    fail("manifest must record marketplace paused=false at cutover");
  }
  const contracts = normalizedManifestContracts(manifest);
  const latestDeployment = Object.values(contracts).reduce(
    (latest, contract) =>
      contract.deploymentBlock > latest ? contract.deploymentBlock : latest,
    0n,
  );
  if (blockNumber < latestDeployment) fail("cutover block predates a V1 contract deployment");
  return {
    blockNumber,
    releaseId: manifest.releaseId.toLowerCase(),
    namespaceSuffix: manifest.namespace.suffix,
    baseNode: manifest.namespace.baseNode.toLowerCase(),
    settlementAsset: getAddress(manifest.settlement.erc20Address),
    contracts,
  };
}

async function readCanonicalBlock(client, blockNumber, field) {
  let block;
  try {
    block = await client.getBlock({ blockNumber });
  } catch {
    fail(`${field} block is unavailable from the canonical RPC`);
  }
  if (
    !block ||
    !isNonZeroHex32(block.hash) ||
    bigintValue(block.number, `${field}.number`) !== blockNumber
  ) {
    fail(`${field} block identity is incomplete`);
  }
  return {
    number: blockNumber,
    hash: block.hash.toLowerCase(),
    timestamp: bigintValue(block.timestamp, `${field}.timestamp`),
  };
}

async function requestAtBlockHash(client, method, params, field) {
  try {
    return await client.request({ method, params });
  } catch {
    fail(
      `${field} historical block-hash RPC request failed; refusing an incomplete snapshot`,
    );
  }
}

async function readContractAtBlockHash(
  client,
  blockHash,
  address,
  abi,
  functionName,
  args = [],
) {
  const data = encodeFunctionData({ abi, functionName, args });
  const result = await requestAtBlockHash(
    client,
    "eth_call",
    [
      { to: address, data },
      { blockHash, requireCanonical: true },
    ],
    `${address}.${functionName}`,
  );
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]*$/.test(result)) {
    fail(`${address}.${functionName} returned malformed call data`);
  }
  try {
    return decodeFunctionResult({ abi, functionName, data: result });
  } catch {
    fail(`${address}.${functionName} result could not be decoded`);
  }
}

async function readRuntimeAtBlockHash(client, blockHash, address, field) {
  const code = await requestAtBlockHash(
    client,
    "eth_getCode",
    [address, { blockHash, requireCanonical: true }],
    `${field} runtime`,
  );
  if (typeof code !== "string" || !/^0x[0-9a-fA-F]+$/.test(code) || code === "0x") {
    fail(`${field} runtime code is missing at cutover`);
  }
  return code;
}

function logOrder(left, right) {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }
  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex - right.transactionIndex;
  }
  return left.logIndex - right.logIndex;
}

function validatedLog(log, address, fromBlock, toBlock, field) {
  if (
    !log ||
    typeof log.address !== "string" ||
    !isAddress(log.address) ||
    !sameAddress(log.address, address) ||
    typeof log.blockNumber !== "bigint" ||
    log.blockNumber < fromBlock ||
    log.blockNumber > toBlock ||
    !isNonZeroHex32(log.blockHash) ||
    !isNonZeroHex32(log.transactionHash) ||
    !Number.isSafeInteger(log.transactionIndex) ||
    log.transactionIndex < 0 ||
    !Number.isSafeInteger(log.logIndex) ||
    log.logIndex < 0 ||
    log.removed === true ||
    !Array.isArray(log.topics) ||
    log.topics.length === 0 ||
    typeof log.data !== "string"
  ) {
    fail(`${field} RPC returned a malformed or non-canonical log`);
  }
  return {
    ...log,
    address: getAddress(log.address),
    blockHash: log.blockHash.toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(),
  };
}

async function queryLogRangeComplete(
  client,
  address,
  fromBlock,
  toBlock,
  field,
) {
  let logs;
  try {
    logs = await client.getLogs({ address, fromBlock, toBlock });
  } catch {
    fail(
      `${field} historical RPC log query failed for ${fromBlock}-${toBlock}; `
      + "Blockscout fallback is not available, so completeness cannot be proven",
    );
  }
  if (!Array.isArray(logs)) fail(`${field} historical RPC log result is not an array`);
  if (logs.length >= LOG_RESPONSE_SPLIT_THRESHOLD) {
    if (fromBlock === toBlock) {
      fail(`${field} one-block log result may be provider-truncated`);
    }
    const midpoint = fromBlock + (toBlock - fromBlock) / 2n;
    const [left, right] = await Promise.all([
      queryLogRangeComplete(client, address, fromBlock, midpoint, field),
      queryLogRangeComplete(client, address, midpoint + 1n, toBlock, field),
    ]);
    return [...left, ...right];
  }
  return logs.map((log) => validatedLog(log, address, fromBlock, toBlock, field));
}

export async function readCompleteEconomicLogs({
  client,
  address,
  deploymentBlock,
  cutoverBlock,
  field,
  chunkSize = MAX_SAFE_LOG_BLOCK_SPAN,
}) {
  const start = bigintValue(deploymentBlock, `${field} deployment block`);
  const end = bigintValue(cutoverBlock, "cutover block");
  const span = bigintValue(chunkSize, "log chunk size");
  if (span <= 0n || span > MAX_SAFE_LOG_BLOCK_SPAN) {
    fail(`log chunk size must be between 1 and ${MAX_SAFE_LOG_BLOCK_SPAN}`);
  }
  if (start > end) fail(`${field} deployment block is after cutover`);
  const logs = [];
  for (let fromBlock = start; fromBlock <= end; fromBlock += span) {
    const toBlock = fromBlock + span - 1n > end ? end : fromBlock + span - 1n;
    logs.push(
      ...(await queryLogRangeComplete(
        client,
        address,
        fromBlock,
        toBlock,
        field,
      )),
    );
  }
  logs.sort(logOrder);
  const identifiers = new Set();
  for (const log of logs) {
    const identifier =
      `${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
    if (identifiers.has(identifier)) fail(`${field} RPC returned a duplicate log`);
    identifiers.add(identifier);
  }
  return logs;
}

function eventDecoder(abi) {
  const byTopic = new Map();
  for (const item of abi) {
    if (item.type === "event") byTopic.set(toEventSelector(item).toLowerCase(), item);
  }
  return (log, field) => {
    const item = byTopic.get(log.topics[0].toLowerCase());
    if (!item) return null;
    try {
      const decoded = decodeEventLog({
        abi: [item],
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      return {
        eventName: decoded.eventName,
        args: decoded.args,
        log,
      };
    } catch {
      fail(`${field} relevant event could not be strictly decoded`);
    }
  };
}

const decodeControllerEvent = eventDecoder(V1_CONTROLLER_ECONOMIC_ABI);
const decodeRegistrarEvent = eventDecoder(V1_REGISTRAR_ECONOMIC_ABI);
const decodeMarketplaceEvent = eventDecoder(V1_MARKETPLACE_ECONOMIC_ABI);

function eventPosition(event) {
  return {
    blockHash: event.log.blockHash,
    blockNumber: event.log.blockNumber.toString(),
    logIndex: event.log.logIndex,
    transactionHash: event.log.transactionHash,
    transactionIndex: event.log.transactionIndex,
    type: event.eventName,
  };
}

function mapAmount(map, account) {
  return map.get(account.toLowerCase()) ?? 0n;
}

function setMapAmount(map, account, amount) {
  map.set(account.toLowerCase(), amount);
}

function normalizedListing(value, field) {
  const seller = addressValue(value?.seller ?? value?.[0], `${field}.seller`);
  const price = bigintValue(value?.price ?? value?.[1], `${field}.price`);
  const validUntil = bigintValue(
    value?.validUntil ?? value?.[2],
    `${field}.validUntil`,
  );
  return { seller, price, validUntil };
}

function listingOutput(listing) {
  return {
    price: listing.price.toString(),
    seller: listing.seller,
    validUntil: listing.validUntil.toString(),
  };
}

function isEmptyListing(listing) {
  return listing.seller === zeroAddress
    && listing.price === 0n
    && listing.validUntil === 0n;
}

function sameListing(left, right) {
  return sameAddress(left.seller, right.seller)
    && left.price === right.price
    && left.validUntil === right.validUntil;
}

function controllerEventState(logs) {
  const output = [];
  const referralBalances = new Map();
  const referrers = new Set();
  const registrations = [];
  const renewals = [];
  let pauseState = false;
  for (const log of logs) {
    const event = decodeControllerEvent(log, "controller");
    if (!event) continue;
    const position = eventPosition(event);
    switch (event.eventName) {
      case "NameRegistered": {
        const name = event.args.name;
        const label = hex32Value(event.args.label, "controller NameRegistered.label");
        if (typeof name !== "string" || keccak256(toBytes(name)).toLowerCase() !== label) {
          fail("controller NameRegistered label string/hash mismatch");
        }
        const value = {
          ...position,
          baseCost: decimal(event.args.baseCost),
          expires: decimal(event.args.expires),
          label,
          name,
          owner: addressValue(event.args.owner, "controller NameRegistered.owner"),
          premium: decimal(event.args.premium),
          tokenId: BigInt(label).toString(),
        };
        registrations.push(value);
        output.push(value);
        break;
      }
      case "NameRenewed": {
        const name = event.args.name;
        const label = hex32Value(event.args.label, "controller NameRenewed.label");
        if (typeof name !== "string" || keccak256(toBytes(name)).toLowerCase() !== label) {
          fail("controller NameRenewed label string/hash mismatch");
        }
        const value = {
          ...position,
          cost: decimal(event.args.cost),
          expires: decimal(event.args.expires),
          label,
          name,
          tokenId: BigInt(label).toString(),
        };
        renewals.push(value);
        output.push(value);
        break;
      }
      case "ReferralAccrued": {
        const referrer = addressValue(
          event.args.referrer,
          "controller ReferralAccrued.referrer",
        );
        const amount = bigintValue(event.args.amount, "ReferralAccrued.amount");
        referrers.add(referrer);
        setMapAmount(
          referralBalances,
          referrer,
          mapAmount(referralBalances, referrer) + amount,
        );
        output.push({ ...position, amount: amount.toString(), referrer });
        break;
      }
      case "ReferralClaimed": {
        const referrer = addressValue(
          event.args.referrer,
          "controller ReferralClaimed.referrer",
        );
        const amount = bigintValue(event.args.amount, "ReferralClaimed.amount");
        const expected = mapAmount(referralBalances, referrer);
        if (amount !== expected) {
          fail("ReferralClaimed does not clear the event-derived account credit");
        }
        referrers.add(referrer);
        setMapAmount(referralBalances, referrer, 0n);
        output.push({ ...position, amount: amount.toString(), referrer });
        break;
      }
      case "TreasuryWithdrawal":
        output.push({
          ...position,
          amount: decimal(event.args.amount),
          treasury: addressValue(
            event.args.treasury,
            "controller TreasuryWithdrawal.treasury",
          ),
        });
        break;
      case "RegistrationPauseChanged":
        if (typeof event.args.paused !== "boolean") {
          fail("RegistrationPauseChanged.paused is not boolean");
        }
        pauseState = event.args.paused;
        output.push({ ...position, paused: pauseState });
        break;
      default:
        fail(`unsupported controller economic event ${event.eventName}`);
    }
  }
  return {
    events: output,
    pauseState,
    referralBalances,
    referrers,
    registrations,
    renewals,
  };
}

function registrarEventState(logs) {
  const output = [];
  const registrations = [];
  const renewals = [];
  const transfers = [];
  const ownerByToken = new Map();
  const tokenIds = new Set();
  for (const log of logs) {
    const event = decodeRegistrarEvent(log, "base registrar");
    if (!event) continue;
    const position = eventPosition(event);
    const tokenId = bigintValue(
      event.args.id ?? event.args.tokenId,
      `registrar ${event.eventName}.tokenId`,
    );
    const tokenKey = tokenId.toString();
    tokenIds.add(tokenKey);
    if (event.eventName === "Transfer") {
      const from = addressValue(event.args.from, "registrar Transfer.from");
      const to = addressValue(event.args.to, "registrar Transfer.to");
      const current = ownerByToken.get(tokenKey) ?? zeroAddress;
      if (!sameAddress(from, current)) {
        fail("registrar Transfer history does not form a complete ownership chain");
      }
      ownerByToken.set(tokenKey, to);
      const value = { ...position, from, to, tokenId: tokenKey };
      transfers.push(value);
      output.push(value);
      continue;
    }
    if (event.eventName === "NameRegistered") {
      const value = {
        ...position,
        expires: decimal(event.args.expires),
        owner: addressValue(event.args.owner, "registrar NameRegistered.owner"),
        tokenId: tokenKey,
      };
      registrations.push(value);
      output.push(value);
      continue;
    }
    if (event.eventName === "NameRenewed") {
      const value = {
        ...position,
        expires: decimal(event.args.expires),
        tokenId: tokenKey,
      };
      renewals.push(value);
      output.push(value);
      continue;
    }
    fail(`unsupported registrar economic event ${event.eventName}`);
  }
  return {
    events: output,
    ownerByToken,
    registrations,
    renewals,
    tokenIds,
    transfers,
  };
}

function marketplaceEventState(logs) {
  const output = [];
  const listings = new Map();
  const proceedsBalances = new Map();
  const sellers = new Set();
  const tokenIds = new Set();
  let pauseState = false;
  for (const log of logs) {
    const event = decodeMarketplaceEvent(log, "marketplace");
    if (!event) continue;
    const position = eventPosition(event);
    if (event.eventName === "PauseChanged") {
      if (typeof event.args.paused !== "boolean") {
        fail("PauseChanged.paused is not boolean");
      }
      pauseState = event.args.paused;
      output.push({ ...position, paused: pauseState });
      continue;
    }
    if (event.eventName === "FeeWithdrawal") {
      output.push({
        ...position,
        amount: decimal(event.args.amount),
        treasury: addressValue(
          event.args.treasury,
          "marketplace FeeWithdrawal.treasury",
        ),
      });
      continue;
    }
    if (event.eventName === "ProceedsClaimed") {
      const seller = addressValue(
        event.args.seller,
        "marketplace ProceedsClaimed.seller",
      );
      const amount = bigintValue(event.args.amount, "ProceedsClaimed.amount");
      const expected = mapAmount(proceedsBalances, seller);
      if (amount !== expected) {
        fail("ProceedsClaimed does not clear the event-derived seller proceeds");
      }
      sellers.add(seller);
      setMapAmount(proceedsBalances, seller, 0n);
      output.push({ ...position, amount: amount.toString(), seller });
      continue;
    }

    const tokenId = bigintValue(
      event.args.tokenId,
      `marketplace ${event.eventName}.tokenId`,
    );
    const tokenKey = tokenId.toString();
    tokenIds.add(tokenKey);
    if (event.eventName === "Listed") {
      const seller = addressValue(event.args.seller, "marketplace Listed.seller");
      const listing = {
        seller,
        price: bigintValue(event.args.price, "Listed.price"),
        validUntil: bigintValue(event.args.validUntil, "Listed.validUntil"),
      };
      if (listing.price === 0n || listing.validUntil === 0n) {
        fail("Listed event contains an empty listing");
      }
      listings.set(tokenKey, listing);
      sellers.add(seller);
      output.push({ ...position, ...listingOutput(listing), tokenId: tokenKey });
      continue;
    }
    if (
      event.eventName === "ListingCancelled" ||
      event.eventName === "ListingInvalidated"
    ) {
      const seller = addressValue(
        event.args.seller ?? event.args.formerSeller,
        `marketplace ${event.eventName}.seller`,
      );
      const current = listings.get(tokenKey);
      if (!current || !sameAddress(current.seller, seller)) {
        fail(`${event.eventName} does not match the event-derived raw listing`);
      }
      listings.delete(tokenKey);
      sellers.add(seller);
      output.push({ ...position, seller, tokenId: tokenKey });
      continue;
    }
    if (event.eventName === "Purchased") {
      const seller = addressValue(event.args.seller, "marketplace Purchased.seller");
      const buyer = addressValue(event.args.buyer, "marketplace Purchased.buyer");
      const price = bigintValue(event.args.price, "Purchased.price");
      const fee = bigintValue(event.args.fee, "Purchased.fee");
      const current = listings.get(tokenKey);
      if (
        !current ||
        !sameAddress(current.seller, seller) ||
        current.price !== price ||
        fee > price
      ) {
        fail("Purchased does not match the event-derived raw listing");
      }
      listings.delete(tokenKey);
      const sellerProceeds = price - fee;
      sellers.add(seller);
      setMapAmount(
        proceedsBalances,
        seller,
        mapAmount(proceedsBalances, seller) + sellerProceeds,
      );
      output.push({
        ...position,
        buyer,
        fee: fee.toString(),
        price: price.toString(),
        seller,
        sellerProceeds: sellerProceeds.toString(),
        tokenId: tokenKey,
      });
      continue;
    }
    fail(`unsupported marketplace economic event ${event.eventName}`);
  }
  return {
    events: output,
    listings,
    pauseState,
    proceedsBalances,
    sellers,
    tokenIds,
  };
}

function transactionTokenKey(event) {
  return `${event.transactionHash}:${event.tokenId}`;
}

function assertRegistrationEventParity(controllerState, registrarState) {
  const controllerRegistrations = new Map();
  for (const event of controllerState.registrations) {
    const key = transactionTokenKey(event);
    if (controllerRegistrations.has(key)) {
      fail("duplicate controller NameRegistered event for one transaction/token");
    }
    controllerRegistrations.set(key, event);
  }
  const registrarRegistrations = new Map();
  for (const event of registrarState.registrations) {
    const key = transactionTokenKey(event);
    if (registrarRegistrations.has(key)) {
      fail("duplicate registrar NameRegistered event for one transaction/token");
    }
    registrarRegistrations.set(key, event);
  }
  if (
    controllerRegistrations.size !== registrarRegistrations.size ||
    [...controllerRegistrations.keys()].some((key) => !registrarRegistrations.has(key))
  ) {
    fail("controller and registrar NameRegistered histories are incomplete or divergent");
  }
  for (const [key, controllerEvent] of controllerRegistrations) {
    const registrarEvent = registrarRegistrations.get(key);
    if (
      registrarEvent.expires !== controllerEvent.expires ||
      !sameAddress(registrarEvent.owner, controllerEvent.owner)
    ) {
      fail("controller and registrar NameRegistered event payloads diverge");
    }
    const mint = registrarState.transfers.find(
      (transfer) =>
        transactionTokenKey(transfer) === key &&
        sameAddress(transfer.from, zeroAddress) &&
        sameAddress(transfer.to, registrarEvent.owner),
    );
    if (!mint) fail("registrar registration transaction is missing its mint Transfer");
  }

  const controllerRenewals = new Map(
    controllerState.renewals.map((event) => [transactionTokenKey(event), event]),
  );
  const registrarRenewals = new Map(
    registrarState.renewals.map((event) => [transactionTokenKey(event), event]),
  );
  if (
    controllerRenewals.size !== registrarRenewals.size ||
    [...controllerRenewals.keys()].some((key) => !registrarRenewals.has(key))
  ) {
    fail("controller and registrar NameRenewed histories are incomplete or divergent");
  }
  for (const [key, controllerEvent] of controllerRenewals) {
    if (registrarRenewals.get(key).expires !== controllerEvent.expires) {
      fail("controller and registrar NameRenewed event payloads diverge");
    }
  }
}

function labelDirectory(controllerState) {
  const labels = new Map();
  for (const event of [
    ...controllerState.registrations,
    ...controllerState.renewals,
  ]) {
    const existing = labels.get(event.tokenId);
    if (
      existing &&
      (existing.name !== event.name || existing.label !== event.label)
    ) {
      fail("one tokenId resolves to multiple controller label identities");
    }
    labels.set(event.tokenId, { label: event.label, name: event.name });
  }
  return labels;
}

function latestExpiryByToken(registrarState) {
  const latest = new Map();
  for (const event of [...registrarState.registrations, ...registrarState.renewals].sort(
    (left, right) => {
      const order = BigInt(left.blockNumber) === BigInt(right.blockNumber)
        ? left.transactionIndex === right.transactionIndex
          ? left.logIndex - right.logIndex
          : left.transactionIndex - right.transactionIndex
        : BigInt(left.blockNumber) < BigInt(right.blockNumber) ? -1 : 1;
      return order;
    },
  )) {
    latest.set(event.tokenId, BigInt(event.expires));
  }
  return latest;
}

async function verifyEventBlockHashes(client, cutoverBlock, logsBySource) {
  const expected = new Map([[cutoverBlock.number.toString(), cutoverBlock.hash]]);
  for (const logs of Object.values(logsBySource)) {
    for (const log of logs) {
      const key = log.blockNumber.toString();
      const existing = expected.get(key);
      if (existing && existing !== log.blockHash) {
        fail("RPC logs disagree on a canonical event block hash");
      }
      expected.set(key, log.blockHash);
    }
  }
  for (const [number, hash] of [...expected.entries()].sort(
    ([left], [right]) => BigInt(left) < BigInt(right) ? -1 : 1,
  )) {
    const block = await readCanonicalBlock(client, BigInt(number), "event");
    if (block.hash !== hash) fail("event history or cutover block was reorganized");
  }
}

function normalizeRequiredListings(values, suffix) {
  if (!Array.isArray(values)) fail("required live listings must be an array");
  const normalized = [];
  const suffixText = `.${suffix}`;
  for (const value of values) {
    if (
      typeof value !== "string" ||
      value.length <= suffixText.length ||
      !value.endsWith(suffixText) ||
      value.slice(0, -suffixText.length).includes(".")
    ) {
      fail(`required live listing must be one exact <label>.${suffix} name`);
    }
    normalized.push(value);
  }
  return [...new Set(normalized)].sort();
}

async function verifyRuntimeIdentity(client, blockHash, contracts) {
  const output = {};
  for (const role of CONTRACT_ROLES) {
    const contract = contracts[role];
    const code = await readRuntimeAtBlockHash(
      client,
      blockHash,
      contract.address,
      role,
    );
    const runtimeCodeHash = keccak256(code).toLowerCase();
    if (runtimeCodeHash !== contract.runtimeCodeHash) {
      fail(`${role} runtime code hash does not match the V1 manifest`);
    }
    output[role] = {
      address: contract.address,
      deploymentBlock: contract.deploymentBlock.toString(),
      runtimeCodeHash,
    };
  }
  return output;
}

async function readCoreState(client, blockHash, input) {
  const controller = input.contracts.controller.address;
  const registrar = input.contracts.baseRegistrar.address;
  const marketplace = input.contracts.marketplace.address;
  const asset = input.settlementAsset;
  const [
    registrationsPaused,
    controllerRegistrar,
    controllerAsset,
    controllerReleaseId,
    totalReferralLiability,
    controllerSurplus,
    marketplacePaused,
    marketplaceRegistrar,
    marketplaceAsset,
    totalSellerLiability,
    marketplaceSurplus,
    registrarBaseNode,
    controllerBalance,
    marketplaceBalance,
  ] = await Promise.all([
    readContractAtBlockHash(
      client,
      blockHash,
      controller,
      V1_CONTROLLER_ECONOMIC_ABI,
      "registrationsPaused",
    ),
    readContractAtBlockHash(
      client,
      blockHash,
      controller,
      V1_CONTROLLER_ECONOMIC_ABI,
      "registrar",
    ),
    readContractAtBlockHash(
      client,
      blockHash,
      controller,
      V1_CONTROLLER_ECONOMIC_ABI,
      "settlementAsset",
    ),
    readContractAtBlockHash(
      client,
      blockHash,
      controller,
      V1_CONTROLLER_ECONOMIC_ABI,
      "releaseId",
    ),
    readContractAtBlockHash(
      client,
      blockHash,
      controller,
      V1_CONTROLLER_ECONOMIC_ABI,
      "totalReferralLiability",
    ),
    readContractAtBlockHash(
      client,
      blockHash,
      controller,
      V1_CONTROLLER_ECONOMIC_ABI,
      "surplus",
    ),
    readContractAtBlockHash(
      client,
      blockHash,
      marketplace,
      V1_MARKETPLACE_ECONOMIC_ABI,
      "paused",
    ),
    readContractAtBlockHash(
      client,
      blockHash,
      marketplace,
      V1_MARKETPLACE_ECONOMIC_ABI,
      "registrar",
    ),
    readContractAtBlockHash(
      client,
      blockHash,
      marketplace,
      V1_MARKETPLACE_ECONOMIC_ABI,
      "settlementAsset",
    ),
    readContractAtBlockHash(
      client,
      blockHash,
      marketplace,
      V1_MARKETPLACE_ECONOMIC_ABI,
      "totalSellerLiability",
    ),
    readContractAtBlockHash(
      client,
      blockHash,
      marketplace,
      V1_MARKETPLACE_ECONOMIC_ABI,
      "surplus",
    ),
    readContractAtBlockHash(
      client,
      blockHash,
      registrar,
      V1_REGISTRAR_ECONOMIC_ABI,
      "baseNode",
    ),
    readContractAtBlockHash(
      client,
      blockHash,
      asset,
      ECONOMIC_ERC20_ABI,
      "balanceOf",
      [controller],
    ),
    readContractAtBlockHash(
      client,
      blockHash,
      asset,
      ECONOMIC_ERC20_ABI,
      "balanceOf",
      [marketplace],
    ),
  ]);
  if (registrationsPaused !== true) {
    fail("V1 registrationsPaused is not true at the cutover block");
  }
  if (marketplacePaused !== false) {
    fail("V1 marketplace paused is not false at the cutover block");
  }
  if (
    !sameAddress(controllerRegistrar, registrar) ||
    !sameAddress(marketplaceRegistrar, registrar) ||
    !sameAddress(controllerAsset, asset) ||
    !sameAddress(marketplaceAsset, asset) ||
    !sameHex(controllerReleaseId, input.releaseId) ||
    !sameHex(registrarBaseNode, input.baseNode)
  ) {
    fail("V1 immutable economic identity does not match the manifest");
  }
  return {
    controllerBalance: bigintValue(controllerBalance, "controller USDC balance"),
    controllerSurplus: bigintValue(controllerSurplus, "controller surplus"),
    marketplaceBalance: bigintValue(marketplaceBalance, "marketplace USDC balance"),
    marketplaceSurplus: bigintValue(marketplaceSurplus, "marketplace surplus"),
    registrationsPaused,
    marketplacePaused,
    totalReferralLiability: bigintValue(
      totalReferralLiability,
      "total referral liability",
    ),
    totalSellerLiability: bigintValue(
      totalSellerLiability,
      "total seller liability",
    ),
  };
}

async function readLiabilityAccounts({
  client,
  blockHash,
  contract,
  abi,
  functionName,
  accounts,
  eventBalances,
  field,
}) {
  const output = [];
  let sum = 0n;
  for (const account of [...accounts].sort((left, right) =>
    left.toLowerCase().localeCompare(right.toLowerCase())
  )) {
    const amount = bigintValue(
      await readContractAtBlockHash(
        client,
        blockHash,
        contract,
        abi,
        functionName,
        [account],
      ),
      `${field} ${account}`,
    );
    const eventAmount = mapAmount(eventBalances, account);
    if (amount !== eventAmount) {
      fail(`${field} account ${account} does not match the complete event fold`);
    }
    sum += amount;
    output.push({ account, amount: amount.toString() });
  }
  return { accounts: output, sum };
}

async function readNameSnapshots({
  client,
  block,
  input,
  registrarState,
  marketplaceState,
  controllerState,
  requiredLiveListings,
}) {
  const registrar = input.contracts.baseRegistrar.address;
  const marketplace = input.contracts.marketplace.address;
  const labels = labelDirectory(controllerState);
  const latestExpiry = latestExpiryByToken(registrarState);
  const tokenIds = new Set([
    ...registrarState.tokenIds,
    ...marketplaceState.tokenIds,
  ]);
  for (const tokenId of marketplaceState.tokenIds) {
    if (!registrarState.tokenIds.has(tokenId)) {
      fail("marketplace history references a token absent from registrar history");
    }
  }
  const snapshots = [];
  for (const tokenKey of [...tokenIds].sort((left, right) =>
    BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0
  )) {
    const tokenId = BigInt(tokenKey);
    const identity = labels.get(tokenKey);
    if (!identity) {
      fail("registrar token history has no complete controller label identity");
    }
    const [
      owner,
      expiry,
      active,
      grace,
      available,
      rawListingValue,
      liveListingValue,
    ] = await Promise.all([
      readContractAtBlockHash(
        client,
        block.hash,
        registrar,
        V1_REGISTRAR_ECONOMIC_ABI,
        "ownerOf",
        [tokenId],
      ),
      readContractAtBlockHash(
        client,
        block.hash,
        registrar,
        V1_REGISTRAR_ECONOMIC_ABI,
        "nameExpires",
        [tokenId],
      ),
      readContractAtBlockHash(
        client,
        block.hash,
        registrar,
        V1_REGISTRAR_ECONOMIC_ABI,
        "isActive",
        [tokenId],
      ),
      readContractAtBlockHash(
        client,
        block.hash,
        registrar,
        V1_REGISTRAR_ECONOMIC_ABI,
        "inGracePeriod",
        [tokenId],
      ),
      readContractAtBlockHash(
        client,
        block.hash,
        registrar,
        V1_REGISTRAR_ECONOMIC_ABI,
        "available",
        [tokenId],
      ),
      readContractAtBlockHash(
        client,
        block.hash,
        marketplace,
        V1_MARKETPLACE_ECONOMIC_ABI,
        "rawListingOf",
        [tokenId],
      ),
      readContractAtBlockHash(
        client,
        block.hash,
        marketplace,
        V1_MARKETPLACE_ECONOMIC_ABI,
        "listingOf",
        [tokenId],
      ),
    ]);
    const ownerAddress = addressValue(owner, `ownerOf(${tokenKey})`);
    const expiryValue = bigintValue(expiry, `nameExpires(${tokenKey})`);
    const expectedOwner = registrarState.ownerByToken.get(tokenKey);
    if (!expectedOwner || !sameAddress(ownerAddress, expectedOwner)) {
      fail(`ownerOf(${tokenKey}) does not match the complete Transfer history`);
    }
    if (latestExpiry.get(tokenKey) !== expiryValue) {
      fail(`nameExpires(${tokenKey}) does not match registration/renewal history`);
    }
    const expectedLifecycle = expiryValue === 0n ||
      block.timestamp > expiryValue + GRACE_PERIOD_SECONDS
      ? "available"
      : block.timestamp <= expiryValue
        ? "active"
        : "grace";
    if (
      typeof active !== "boolean" ||
      typeof grace !== "boolean" ||
      typeof available !== "boolean" ||
      active !== (expectedLifecycle === "active") ||
      grace !== (expectedLifecycle === "grace") ||
      available !== (expectedLifecycle === "available")
    ) {
      fail(`token ${tokenKey} lifecycle reads are internally inconsistent`);
    }

    const rawListing = normalizedListing(
      rawListingValue,
      `rawListingOf(${tokenKey})`,
    );
    const liveListing = normalizedListing(
      liveListingValue,
      `listingOf(${tokenKey})`,
    );
    const expectedRaw = marketplaceState.listings.get(tokenKey) ?? {
      seller: zeroAddress,
      price: 0n,
      validUntil: 0n,
    };
    if (!sameListing(rawListing, expectedRaw)) {
      fail(`rawListingOf(${tokenKey}) does not match complete listing history`);
    }
    if (!isEmptyListing(liveListing)) {
      if (
        !sameListing(liveListing, rawListing) ||
        expectedLifecycle !== "active" ||
        !sameAddress(liveListing.seller, ownerAddress)
      ) {
        fail(`listingOf(${tokenKey}) is not a valid live listing`);
      }
    }
    snapshots.push({
      expiry: expiryValue.toString(),
      fullName: `${identity.name}.${input.namespaceSuffix}`,
      label: identity.name,
      labelHash: identity.label,
      lifecycle: expectedLifecycle,
      liveListing: listingOutput(liveListing),
      owner: ownerAddress,
      rawListing: listingOutput(rawListing),
      tokenId: tokenKey,
    });
  }

  for (const required of requiredLiveListings) {
    const snapshot = snapshots.find((candidate) => candidate.fullName === required);
    if (!snapshot || snapshot.liveListing.seller === zeroAddress) {
      fail(`required live listing is missing: ${required}`);
    }
  }
  return snapshots;
}

export async function captureV1EconomicCutoverEvidence({
  manifest,
  cutoverBlock,
  client,
  requiredLiveListings = [],
  chunkSize = MAX_SAFE_LOG_BLOCK_SPAN,
}) {
  if (!client) fail("canonical RPC client is required");
  const input = assertV1EconomicCutoverInput(manifest, cutoverBlock);
  const chainId = await client.getChainId().catch(() => null);
  if (chainId !== ARC_TESTNET_CHAIN_ID) fail("RPC is not Arc Testnet");
  const block = await readCanonicalBlock(client, input.blockNumber, "cutover");
  const normalizedRequiredListings = normalizeRequiredListings(
    requiredLiveListings,
    input.namespaceSuffix,
  );

  const runtimeContracts = await verifyRuntimeIdentity(
    client,
    block.hash,
    input.contracts,
  );
  const [controllerLogs, registrarLogs, marketplaceLogs] = await Promise.all([
    readCompleteEconomicLogs({
      client,
      address: input.contracts.controller.address,
      deploymentBlock: input.contracts.controller.deploymentBlock,
      cutoverBlock: input.blockNumber,
      field: "controller",
      chunkSize,
    }),
    readCompleteEconomicLogs({
      client,
      address: input.contracts.baseRegistrar.address,
      deploymentBlock: input.contracts.baseRegistrar.deploymentBlock,
      cutoverBlock: input.blockNumber,
      field: "base registrar",
      chunkSize,
    }),
    readCompleteEconomicLogs({
      client,
      address: input.contracts.marketplace.address,
      deploymentBlock: input.contracts.marketplace.deploymentBlock,
      cutoverBlock: input.blockNumber,
      field: "marketplace",
      chunkSize,
    }),
  ]);

  const controllerState = controllerEventState(controllerLogs);
  const registrarState = registrarEventState(registrarLogs);
  const marketplaceState = marketplaceEventState(marketplaceLogs);
  assertRegistrationEventParity(controllerState, registrarState);
  if (controllerState.pauseState !== true) {
    fail("controller pause event history does not end at registrationsPaused=true");
  }
  if (marketplaceState.pauseState !== false) {
    fail("marketplace pause event history does not end at paused=false");
  }

  const core = await readCoreState(client, block.hash, input);
  const [referralAccounts, sellerAccounts, names] = await Promise.all([
    readLiabilityAccounts({
      client,
      blockHash: block.hash,
      contract: input.contracts.controller.address,
      abi: V1_CONTROLLER_ECONOMIC_ABI,
      functionName: "referralCredits",
      accounts: controllerState.referrers,
      eventBalances: controllerState.referralBalances,
      field: "referral credit",
    }),
    readLiabilityAccounts({
      client,
      blockHash: block.hash,
      contract: input.contracts.marketplace.address,
      abi: V1_MARKETPLACE_ECONOMIC_ABI,
      functionName: "proceeds",
      accounts: marketplaceState.sellers,
      eventBalances: marketplaceState.proceedsBalances,
      field: "seller proceeds",
    }),
    readNameSnapshots({
      client,
      block,
      input,
      registrarState,
      marketplaceState,
      controllerState,
      requiredLiveListings: normalizedRequiredListings,
    }),
  ]);

  if (referralAccounts.sum !== core.totalReferralLiability) {
    fail("sum of all discovered referral credits does not equal totalReferralLiability");
  }
  if (sellerAccounts.sum !== core.totalSellerLiability) {
    fail("sum of all discovered seller proceeds does not equal totalSellerLiability");
  }
  if (
    core.controllerBalance < core.totalReferralLiability ||
    core.controllerSurplus !==
      core.controllerBalance - core.totalReferralLiability
  ) {
    fail("controller is insolvent or reports an inconsistent surplus");
  }
  if (
    core.marketplaceBalance < core.totalSellerLiability ||
    core.marketplaceSurplus !==
      core.marketplaceBalance - core.totalSellerLiability
  ) {
    fail("marketplace is insolvent or reports an inconsistent surplus");
  }

  await verifyEventBlockHashes(client, block, {
    controller: controllerLogs,
    marketplace: marketplaceLogs,
    registrar: registrarLogs,
  });

  return {
    artifact: "v1EconomicCutover",
    chainId: ARC_TESTNET_CHAIN_ID,
    checks: {
      allAccountSumsMatchTotals: true,
      allEventBlocksCanonical: true,
      allNamesReconciled: true,
      allRuntimeHashesMatchManifest: true,
      controllerSolvent: true,
      marketplaceSolvent: true,
      policyMatchesCutover: true,
      requiredLiveListingsPresent: true,
    },
    contracts: runtimeContracts,
    cutover: {
      blockHash: block.hash,
      blockNumber: block.number.toString(),
      timestamp: block.timestamp.toString(),
    },
    events: {
      controller: controllerState.events,
      marketplace: marketplaceState.events,
      registrar: registrarState.events,
    },
    liabilities: {
      controller: {
        accounts: referralAccounts.accounts,
        accountSum: referralAccounts.sum.toString(),
        balance: core.controllerBalance.toString(),
        settlementAsset: input.settlementAsset,
        surplus: core.controllerSurplus.toString(),
        totalLiability: core.totalReferralLiability.toString(),
      },
      marketplace: {
        accounts: sellerAccounts.accounts,
        accountSum: sellerAccounts.sum.toString(),
        balance: core.marketplaceBalance.toString(),
        settlementAsset: input.settlementAsset,
        surplus: core.marketplaceSurplus.toString(),
        totalLiability: core.totalSellerLiability.toString(),
      },
    },
    names,
    policy: {
      marketplacePaused: core.marketplacePaused,
      registrationsPaused: core.registrationsPaused,
    },
    releaseId: input.releaseId,
    requiredLiveListings: normalizedRequiredListings,
    schemaVersion: V1_ECONOMIC_CUTOVER_SCHEMA_VERSION,
    verdict: "PASS",
  };
}

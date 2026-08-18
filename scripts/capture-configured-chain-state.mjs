#!/usr/bin/env node

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { rateLimitedArcHttp } from "./lib/arc-rpc-transport.mjs";
import { parseConfiguredChainStateArguments } from "./lib/configured-chain-state-cli.mjs";

const require = createRequire(new URL("../packages/config/package.json", import.meta.url));
const {
  concatHex,
  createPublicClient,
  getAddress,
  keccak256,
  parseAbi,
  stringToHex,
  zeroHash,
} = require("viem");

const {
  manifestPath: MANIFEST_PATH,
  outputPath: OUTPUT_PATH,
} = parseConfiguredChainStateArguments(process.argv.slice(2));
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const RPC_URL = "https://rpc.testnet.arc.network";
if (manifest.chain.rpcUrl !== RPC_URL || (process.env.ARC_RPC_URL?.trim() || RPC_URL) !== RPC_URL) {
  throw new Error(`ARC_RPC_URL must exactly equal ${RPC_URL}`);
}
const CHAIN_ID = 5_042_002;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const addresses = {
  governanceAccount: manifest.activationEvidence.governance.account,
  registry: manifest.contracts.registry.address,
  baseRegistrar: manifest.contracts.baseRegistrar.address,
  controller: manifest.contracts.controller.address,
  publicResolver: manifest.contracts.publicResolver.address,
  reverseRegistrar: manifest.contracts.reverseRegistrar.address,
  universalResolver: manifest.contracts.universalResolver.address,
  marketplace: manifest.contracts.marketplace.address,
};
for (const [role, value] of Object.entries(addresses)) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`deployment manifest ${role} address is not configured`);
  }
}
const ownedAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
]);
const registryAbi = parseAbi(["function owner(bytes32 node) view returns (address)"]);
const registrarAbi = parseAbi([
  "function registry() view returns (address)",
  "function controllers(address) view returns (bool)",
]);
const controllerAbi = parseAbi([
  "function registrar() view returns (address)",
  "function settlementAsset() view returns (address)",
  "function publicResolver() view returns (address)",
  "function registrationsPaused() view returns (bool)",
  "function permitSigner() view returns (address)",
  "function treasury() view returns (address)",
  "function referralBps() view returns (uint16)",
  "function releaseId() view returns (bytes32)",
]);
const resolverAbi = parseAbi(["function registry() view returns (address)"]);
const reverseAbi = parseAbi([
  "function registry() view returns (address)",
  "function defaultResolver() view returns (address)",
  "function registrar() view returns (address)",
  "function reverseNode() view returns (bytes32)",
  "function baseNode() view returns (bytes32)",
  "function suffix() view returns (string)",
]);
const universalAbi = parseAbi([
  "function registry() view returns (address)",
  "function reverseRegistrar() view returns (address)",
]);
const marketplaceAbi = parseAbi([
  "function registrar() view returns (address)",
  "function settlementAsset() view returns (address)",
  "function paused() view returns (bool)",
  "function treasury() view returns (address)",
  "function feeBps() view returns (uint16)",
]);
const multicallAbi = parseAbi([
  "function getBlockNumber() view returns (uint256)",
  "function getChainId() view returns (uint256)",
]);

const baseNode =
  "0xb0622ac8c513b1e04f26418271b595fae314dbed2e3dea63916fc45cde7c5bbe";
const reverseNode =
  "0x91d1777781884d03a6757a803996e38de2a42967fb37eeaca72729271025a9e2";
const reverseRoot = keccak256(concatHex([zeroHash, keccak256(stringToHex("reverse"))]));

function spec(key, address, abi, functionName, args = []) {
  return { key, address, abi, functionName, args };
}

const calls = [
  spec("captureBlock", MULTICALL3, multicallAbi, "getBlockNumber"),
  spec("captureChainId", MULTICALL3, multicallAbi, "getChainId"),
  spec("registrarOwner", addresses.baseRegistrar, ownedAbi, "owner"),
  spec("registrarPendingOwner", addresses.baseRegistrar, ownedAbi, "pendingOwner"),
  spec("controllerOwner", addresses.controller, ownedAbi, "owner"),
  spec("controllerPendingOwner", addresses.controller, ownedAbi, "pendingOwner"),
  spec("marketplaceOwner", addresses.marketplace, ownedAbi, "owner"),
  spec("marketplacePendingOwner", addresses.marketplace, ownedAbi, "pendingOwner"),
  spec("registryRootOwner", addresses.registry, registryAbi, "owner", [zeroHash]),
  spec("registryBaseOwner", addresses.registry, registryAbi, "owner", [baseNode]),
  spec("registryReverseRootOwner", addresses.registry, registryAbi, "owner", [reverseRoot]),
  spec("registryReverseOwner", addresses.registry, registryAbi, "owner", [reverseNode]),
  spec("registrarRegistry", addresses.baseRegistrar, registrarAbi, "registry"),
  spec("registrarControllerEnabled", addresses.baseRegistrar, registrarAbi, "controllers", [addresses.controller]),
  spec("controllerRegistrar", addresses.controller, controllerAbi, "registrar"),
  spec("controllerSettlementAsset", addresses.controller, controllerAbi, "settlementAsset"),
  spec("controllerPublicResolver", addresses.controller, controllerAbi, "publicResolver"),
  spec("controllerPaused", addresses.controller, controllerAbi, "registrationsPaused"),
  spec("controllerPermitSigner", addresses.controller, controllerAbi, "permitSigner"),
  spec("controllerTreasury", addresses.controller, controllerAbi, "treasury"),
  spec("controllerReferralBps", addresses.controller, controllerAbi, "referralBps"),
  spec("controllerReleaseId", addresses.controller, controllerAbi, "releaseId"),
  spec("resolverRegistry", addresses.publicResolver, resolverAbi, "registry"),
  spec("reverseRegistry", addresses.reverseRegistrar, reverseAbi, "registry"),
  spec("reverseDefaultResolver", addresses.reverseRegistrar, reverseAbi, "defaultResolver"),
  spec("reverseBaseRegistrar", addresses.reverseRegistrar, reverseAbi, "registrar"),
  spec("reverseNode", addresses.reverseRegistrar, reverseAbi, "reverseNode"),
  spec("reverseBaseNode", addresses.reverseRegistrar, reverseAbi, "baseNode"),
  spec("reverseSuffix", addresses.reverseRegistrar, reverseAbi, "suffix"),
  spec("universalRegistry", addresses.universalResolver, universalAbi, "registry"),
  spec("universalReverseRegistrar", addresses.universalResolver, universalAbi, "reverseRegistrar"),
  spec("marketplaceRegistrar", addresses.marketplace, marketplaceAbi, "registrar"),
  spec("marketplaceSettlementAsset", addresses.marketplace, marketplaceAbi, "settlementAsset"),
  spec("marketplacePaused", addresses.marketplace, marketplaceAbi, "paused"),
  spec("marketplaceTreasury", addresses.marketplace, marketplaceAbi, "treasury"),
  spec("marketplaceFeeBps", addresses.marketplace, marketplaceAbi, "feeBps"),
];

function address(value) {
  return getAddress(value);
}

async function main() {
  const client = createPublicClient({
    chain: {
      id: CHAIN_ID,
      name: "Arc Testnet",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [RPC_URL] } },
    },
    transport: rateLimitedArcHttp(RPC_URL),
    batch: { multicall: true },
  });
  const results = await client.multicall({
    multicallAddress: MULTICALL3,
    contracts: calls.map(({ key: _key, ...contract }) => contract),
    allowFailure: false,
  });
  const state = Object.fromEntries(calls.map(({ key }, index) => [key, results[index]]));
  if (Number(state.captureChainId) !== CHAIN_ID) throw new Error("Arc chain ID mismatch");
  const captureBlock = BigInt(state.captureBlock);
  const [governanceCode, governanceBalance] = await Promise.all([
    client.getCode({ address: addresses.governanceAccount, blockNumber: captureBlock }),
    client.getBalance({ address: addresses.governanceAccount, blockNumber: captureBlock }),
  ]);
  const report = {
    schemaVersion: "1.1.0",
    capturedFrom: RPC_URL,
    chainId: CHAIN_ID,
    captureBlock: Number(captureBlock),
    releaseId: state.controllerReleaseId,
    governance: {
      account: address(addresses.governanceAccount),
      accountType: governanceCode && governanceCode !== "0x" ? "CONTRACT" : "EOA",
      runtimeCode: governanceCode ?? "0x",
      nativeBalanceWei: governanceBalance.toString(),
    },
    roles: {
      registrar: { owner: address(state.registrarOwner), pendingOwner: address(state.registrarPendingOwner) },
      controller: { owner: address(state.controllerOwner), pendingOwner: address(state.controllerPendingOwner) },
      marketplace: { owner: address(state.marketplaceOwner), pendingOwner: address(state.marketplacePendingOwner) },
      registry: {
        rootOwner: address(state.registryRootOwner),
        baseOwner: address(state.registryBaseOwner),
        reverseRootOwner: address(state.registryReverseRootOwner),
        reverseOwner: address(state.registryReverseOwner),
      },
    },
    policy: {
      controller: {
        paused: state.controllerPaused,
        permitSigner: address(state.controllerPermitSigner),
        treasury: address(state.controllerTreasury),
        referralBps: Number(state.controllerReferralBps),
      },
      marketplace: {
        paused: state.marketplacePaused,
        treasury: address(state.marketplaceTreasury),
        feeBps: Number(state.marketplaceFeeBps),
      },
    },
    wiring: {
      registrarRegistry: address(state.registrarRegistry),
      registrarControllerEnabled: state.registrarControllerEnabled,
      controllerRegistrar: address(state.controllerRegistrar),
      controllerSettlementAsset: address(state.controllerSettlementAsset),
      controllerPublicResolver: address(state.controllerPublicResolver),
      resolverRegistry: address(state.resolverRegistry),
      reverseRegistry: address(state.reverseRegistry),
      reverseDefaultResolver: address(state.reverseDefaultResolver),
      reverseBaseRegistrar: address(state.reverseBaseRegistrar),
      reverseNode: state.reverseNode,
      reverseBaseNode: state.reverseBaseNode,
      reverseSuffix: state.reverseSuffix,
      universalRegistry: address(state.universalRegistry),
      universalReverseRegistrar: address(state.universalReverseRegistrar),
      marketplaceRegistrar: address(state.marketplaceRegistrar),
      marketplaceSettlementAsset: address(state.marketplaceSettlementAsset),
    },
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (OUTPUT_PATH) {
    await writeFile(OUTPUT_PATH, json, { encoding: "utf8", flag: "wx", mode: 0o600 });
    process.stdout.write(`Captured Arc chain state at block ${report.captureBlock}.\n`);
  } else {
    process.stdout.write(json);
  }
}

main().catch((error) => {
  process.stderr.write(`configured chain-state capture failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

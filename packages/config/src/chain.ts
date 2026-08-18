import { defineChain } from "viem";

export const ARC_TESTNET_CHAIN_ID = 5_042_002 as const;
export const ARC_TESTNET_CAIP2 = "eip155:5042002" as const;
export const ARC_TESTNET_RPC_URL = "https://rpc.testnet.arc.network" as const;
export const ARC_TESTNET_EXPLORER_URL = "https://testnet.arcscan.app" as const;
export const ARC_TESTNET_FAUCET_URL = "https://faucet.circle.com" as const;
export const ARC_TESTNET_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/**
 * Runtime Arc chain definition. It is deliberately local so third-party fallback
 * endpoints and WebSocket URLs from upstream chain presets cannot enter a bundle.
 */
export const ARC_TESTNET = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [ARC_TESTNET_RPC_URL],
    },
  },
  blockExplorers: {
    default: {
      name: "ArcScan",
      url: ARC_TESTNET_EXPLORER_URL,
      apiUrl: `${ARC_TESTNET_EXPLORER_URL}/api`,
    },
  },
  contracts: {
    multicall3: {
      address: ARC_TESTNET_MULTICALL3,
      blockCreated: 0,
    },
  },
  testnet: true,
});

export const ARC_USDC = Object.freeze({
  symbol: "USDC",
  name: "USDC",
  erc20Address: "0x3600000000000000000000000000000000000000",
  applicationDecimals: 6,
  nativeInterfaceDecimals: 18,
  sharedUnderlyingBalance: true,
} as const);

export const ARC_FINALITY = Object.freeze({
  deterministicAfterInclusion: true,
  receiptRequired: true,
  confirmations: 1,
} as const);

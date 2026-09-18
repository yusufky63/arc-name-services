import { defineChain } from "viem";

export const ARC_MAINNET_CHAIN_ID = 5_042 as const;
export const ARC_MAINNET_CAIP2 = "eip155:5042" as const;
export const ARC_MAINNET_RPC_URL = "https://rpc.mainnet.arc.io" as const;
export const ARC_MAINNET_EXPLORER_URL = "https://explorer.arc.io" as const;
export const ARC_MAINNET_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

/**
 * Runtime Arc chain definition. It is deliberately local so third-party fallback
 * endpoints and WebSocket URLs from upstream chain presets cannot enter a bundle.
 */
export const ARC_MAINNET = defineChain({
  id: ARC_MAINNET_CHAIN_ID,
  name: "Arc",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [ARC_MAINNET_RPC_URL],
    },
  },
  blockExplorers: {
    default: {
      name: "Arc Explorer",
      url: ARC_MAINNET_EXPLORER_URL,
      apiUrl: `${ARC_MAINNET_EXPLORER_URL}/api`,
    },
  },
  contracts: {
    multicall3: {
      address: ARC_MAINNET_MULTICALL3,
      blockCreated: 0,
    },
  },
});

/** @deprecated Use the Arc Mainnet exports above. */
export const ARC_TESTNET_CHAIN_ID = ARC_MAINNET_CHAIN_ID;
/** @deprecated Use the Arc Mainnet exports above. */
export const ARC_TESTNET_CAIP2 = ARC_MAINNET_CAIP2;
/** @deprecated Use the Arc Mainnet exports above. */
export const ARC_TESTNET_RPC_URL = ARC_MAINNET_RPC_URL;
/** @deprecated Use the Arc Mainnet exports above. */
export const ARC_TESTNET_EXPLORER_URL = ARC_MAINNET_EXPLORER_URL;
/** @deprecated Arc Mainnet has no faucet. */
export const ARC_TESTNET_FAUCET_URL = "https://docs.arc.io/app-kit/bridge/overview" as const;
/** @deprecated Use the Arc Mainnet exports above. */
export const ARC_TESTNET_MULTICALL3 = ARC_MAINNET_MULTICALL3;
/** @deprecated Use ARC_MAINNET. */
export const ARC_TESTNET = ARC_MAINNET;

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

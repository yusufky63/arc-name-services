import {
  ARC_TESTNET as arcTestnet,
  ARC_TESTNET_CAIP2,
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_EXPLORER_URL,
  ARC_TESTNET_FAUCET_URL,
  ARC_TESTNET_RPC_URL,
  ARC_USDC,
} from "@contour/config";
import { toHex } from "viem";

export { arcTestnet };

export const ARC_TESTNET = {
  ...arcTestnet,
  caip2: ARC_TESTNET_CAIP2,
  rpcUrl: ARC_TESTNET_RPC_URL,
  explorerUrl: ARC_TESTNET_EXPLORER_URL,
  faucetUrl: ARC_TESTNET_FAUCET_URL,
  usdc: {
    name: ARC_USDC.name,
    symbol: ARC_USDC.symbol,
    address: ARC_USDC.erc20Address,
    applicationDecimals: ARC_USDC.applicationDecimals,
    nativeDecimals: ARC_USDC.nativeInterfaceDecimals,
  },
} as const;

export const ARC_CHAIN_HEX = toHex(ARC_TESTNET_CHAIN_ID);

export const ARC_ADD_CHAIN_PARAMS = {
  chainId: ARC_CHAIN_HEX,
  chainName: arcTestnet.name,
  nativeCurrency: arcTestnet.nativeCurrency,
  rpcUrls: [...arcTestnet.rpcUrls.default.http],
  blockExplorerUrls: arcTestnet.blockExplorers?.default
    ? [arcTestnet.blockExplorers.default.url]
    : [ARC_TESTNET.explorerUrl],
} as const;

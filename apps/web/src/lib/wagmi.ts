import { createConfig, http } from "wagmi";
import { coinbaseWallet, injected } from "wagmi/connectors";
import { ARC_TESTNET } from "@/lib/network";

export const wagmiConfig = createConfig({
  chains: [ARC_TESTNET],
  connectors: [
    injected({ shimDisconnect: true }),
    coinbaseWallet({
      appName: "Contour",
      appLogoUrl: null,
      preference: { options: "all", telemetry: false },
    }),
  ],
  multiInjectedProviderDiscovery: true,
  ssr: true,
  transports: {
    [ARC_TESTNET.id]: http(ARC_TESTNET.rpcUrl, {
      batch: true,
      retryCount: 2,
      retryDelay: 350,
    }),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

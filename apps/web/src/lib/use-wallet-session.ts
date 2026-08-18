"use client";

import { useWalletManager } from "@/components/wallet-manager";

export function useWalletSession() {
  return useWalletManager();
}

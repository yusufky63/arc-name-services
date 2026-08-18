import { createContext, createElement, useContext, type PropsWithChildren } from "react";
import type { ArcNameClient } from "@contour/sdk";

const ArcNameClientContext = createContext<ArcNameClient | null>(null);

export function ArcNameProvider({ client, children }: PropsWithChildren<{ client: ArcNameClient }>) {
  return createElement(ArcNameClientContext.Provider, { value: client }, children);
}

export function useArcNameClient(): ArcNameClient {
  const client = useContext(ArcNameClientContext);
  if (!client) throw new Error("useArcNameClient must be used inside ArcNameProvider");
  return client;
}

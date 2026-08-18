import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { useArcNameClient } from "./context.js";

export function useArcName(label: string | null) {
  const client = useArcNameClient();
  return useQuery({
    queryKey: ["arc-name", client.manifest.releaseId, label],
    queryFn: () => client.name(label!),
    enabled: label !== null && label.length > 0 && client.manifest.state !== "draft",
    staleTime: 5_000,
    retry: 1,
  });
}

export function useArcReverse(account: Address | null) {
  const client = useArcNameClient();
  return useQuery({
    queryKey: ["arc-reverse", client.manifest.releaseId, account],
    queryFn: () => client.reverse(account!),
    enabled: account !== null && client.manifest.state !== "draft",
    staleTime: 15_000,
    retry: 1,
  });
}

export function useRegistrationQuote(label: string | null, durationYears: bigint | null) {
  const client = useArcNameClient();
  return useQuery({
    queryKey: ["arc-registration-quote", client.manifest.releaseId, label, durationYears?.toString()],
    queryFn: () => client.quote(label!, durationYears!),
    enabled: label !== null && label.length > 0 && durationYears !== null && durationYears > 0n && client.manifest.state !== "draft",
    staleTime: 3_000,
    retry: 0,
  });
}

export function useArcListing(tokenId: bigint | null) {
  const client = useArcNameClient();
  return useQuery({
    queryKey: ["arc-listing", client.manifest.releaseId, tokenId?.toString()],
    queryFn: () => client.listing(tokenId!),
    enabled: tokenId !== null && client.manifest.state !== "draft",
    staleTime: 5_000,
    retry: 1,
  });
}

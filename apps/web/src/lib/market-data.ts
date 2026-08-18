export type ReleaseKey = "canonical" | "legacy";

export type LiveMarketListing = {
  releaseId: `0x${string}`;
  releaseKey: ReleaseKey;
  tokenId: string;
  label: string;
  name: string;
  seller: `0x${string}`;
  price: string;
  validUntil: string;
  expiry: string;
  feeBps: number;
  marketPaused: boolean;
};

export type MarketSnapshot = {
  chainId: 5_042_002;
  asOfBlock: string;
  asOfTimestamp: string;
  listings: LiveMarketListing[];
};

export type OwnedName = {
  releaseId: `0x${string}`;
  releaseKey: ReleaseKey;
  tokenId: string;
  label: string;
  name: string;
  expiry: string;
  lifecycle: "active" | "grace" | "expired";
  listing: LiveMarketListing | null;
};

export type AccountReleaseBalance = {
  releaseId: `0x${string}`;
  releaseKey: ReleaseKey;
  referralCredits: string;
  sellerProceeds: string;
  marketPaused: boolean;
};

export type AccountSnapshot = {
  chainId: 5_042_002;
  asOfBlock: string;
  asOfTimestamp: string;
  owner: `0x${string}`;
  referralCredits: string;
  sellerProceeds: string;
  marketPaused: boolean;
  releases: AccountReleaseBalance[];
  names: OwnedName[];
};

import {
  getAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type ContractFunctionParameters,
  type Hex,
  type PublicClient,
} from "viem";
import {
  ARC_TESTNET_MULTICALL3,
  ARC_TESTNET_CHAIN_ID,
  assertDeploymentManifest,
  requireDeployedContract,
  type DeploymentManifest,
} from "@contour/config";
import { deriveNameIdentity, NORMALIZATION_PROFILE } from "@contour/normalization";
import {
  baseRegistrarAbi,
  controllerAbi,
  erc20Abi,
  marketplaceAbi,
  publicResolverAbi,
  reverseRegistrarAbi,
  registryAbi,
} from "./abis.js";

export interface NameRecord {
  /** Exact deployment release used for every contract read in this record. */
  releaseId: Hex;
  name: string;
  node: Hex;
  tokenId: bigint;
  registryOwner: Address;
  registrant: Address | null;
  resolver: Address | null;
  resolvedAddress: Address | null;
  contentHash: Hex | null;
  expiry: bigint | null;
  available: boolean;
}

export interface NameQuoteSnapshot {
  /** Exact deployment release used for both the record and quote batch. */
  releaseId: Hex;
  record: NameRecord;
  quote: bigint | null;
  blockTimestamp: bigint | null;
}

export interface ReleaseReadOptions {
  /** Optional Arc block pin shared across canonical and legacy release reads. */
  blockNumber?: bigint;
}

const multicall3TimestampAbi = parseAbi([
  "function getCurrentBlockTimestamp() view returns (uint256)",
]);

export class ArcNameClient {
  readonly publicClient: PublicClient;
  readonly manifest: DeploymentManifest;
  private chainAssertion: Promise<void> | null = null;

  constructor(publicClient: PublicClient, manifest: DeploymentManifest) {
    assertDeploymentManifest(manifest);
    if (manifest.normalization.profileHash.toLowerCase() !== NORMALIZATION_PROFILE.profileHash) {
      throw new Error("SDK normalization profile does not match deployment manifest");
    }
    if (manifest.normalization.corpusHash.toLowerCase() !== NORMALIZATION_PROFILE.corpusHash) {
      throw new Error("SDK normalization corpus does not match deployment manifest");
    }
    this.publicClient = publicClient;
    this.manifest = manifest;
  }

  /** Proves this transport is serving Arc Testnet before any contract read. */
  async assertChain(): Promise<void> {
    if (!this.chainAssertion) {
      const assertion = this.publicClient.getChainId().then((chainId) => {
        if (chainId !== ARC_TESTNET_CHAIN_ID) {
          throw new Error(`Arc RPC chain mismatch: expected ${ARC_TESTNET_CHAIN_ID}, received ${chainId}`);
        }
      });
      this.chainAssertion = assertion.catch((error) => {
        this.chainAssertion = null;
        throw error;
      });
    }
    return this.chainAssertion;
  }

  get suffix(): string {
    const suffix = this.manifest.namespace.suffix;
    if (!suffix) throw new Error("namespace suffix is not configured");
    return suffix;
  }

  get releaseId(): Hex {
    const releaseId = this.manifest.releaseId;
    if (!releaseId) throw new Error("deployment release is not configured");
    return releaseId;
  }

  async quote(label: string, durationYears: bigint): Promise<bigint> {
    await this.assertChain();
    if (durationYears <= 0n) throw new Error("durationYears must be positive");
    const identity = deriveNameIdentity(label, this.suffix);
    return this.publicClient.readContract({
      address: requireDeployedContract(this.manifest, "controller"),
      abi: controllerAbi,
      functionName: "quote",
      args: [identity.normalized, durationYears],
    });
  }

  async allowance(owner: Address, spender?: Address): Promise<bigint> {
    await this.assertChain();
    return this.publicClient.readContract({
      address: this.manifest.settlement.erc20Address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [getAddress(owner), spender ?? requireDeployedContract(this.manifest, "controller")],
    });
  }

  private async readNameSnapshot(
    label: string,
    durationYears?: bigint,
    options: ReleaseReadOptions = {},
  ): Promise<NameQuoteSnapshot> {
    await this.assertChain();
    if (durationYears !== undefined && durationYears <= 0n) {
      throw new Error("durationYears must be positive");
    }
    const identity = deriveNameIdentity(label, this.suffix);
    const registry = requireDeployedContract(this.manifest, "registry");
    const registrar = requireDeployedContract(this.manifest, "baseRegistrar");
    const publicResolver = requireDeployedContract(this.manifest, "publicResolver");
    const contracts: ContractFunctionParameters[] = [
      { address: registry, abi: registryAbi, functionName: "owner", args: [identity.namehash] },
      { address: registry, abi: registryAbi, functionName: "resolver", args: [identity.namehash] },
      { address: registrar, abi: baseRegistrarAbi, functionName: "available", args: [identity.tokenId] },
      { address: registrar, abi: baseRegistrarAbi, functionName: "nameExpires", args: [identity.tokenId] },
      // ownerOf intentionally shares the same atomic Multicall read. It may
      // revert for an available token, which is why this batch is fallible.
      { address: registrar, abi: baseRegistrarAbi, functionName: "ownerOf", args: [identity.tokenId] },
      // The canonical resolver is by far the common path. Reading it in the
      // first batch removes another RPC round trip while results are accepted
      // only when the registry actually points at this exact deployment.
      { address: publicResolver, abi: publicResolverAbi, functionName: "addr", args: [identity.namehash] },
      { address: publicResolver, abi: publicResolverAbi, functionName: "contenthash", args: [identity.namehash] },
    ];
    if (durationYears !== undefined) {
      contracts.push(
        {
          address: requireDeployedContract(this.manifest, "controller"),
          abi: controllerAbi,
          functionName: "quote",
          args: [identity.normalized, durationYears],
        },
        {
          address: ARC_TESTNET_MULTICALL3,
          abi: multicall3TimestampAbi,
          functionName: "getCurrentBlockTimestamp",
        },
      );
    }
    const results = await this.publicClient.multicall({
      allowFailure: true,
      contracts,
      ...(options.blockNumber !== undefined ? { blockNumber: options.blockNumber } : {}),
    });
    const required = <T>(index: number, field: string): T => {
      const result = results[index];
      if (!result || result.status !== "success") {
        throw new Error(`Arc name ${field} read failed`);
      }
      return result.result as T;
    };
    const registryOwner = required<Address>(0, "registry owner");
    const resolver = required<Address>(1, "resolver");
    const available = required<boolean>(2, "availability");
    const expiry = required<bigint>(3, "expiry");
    const registrant = available ? null : required<Address>(4, "registrant");
    let resolvedAddress: Address | null = null;
    let contentHash: Hex | null = null;
    if (resolver !== zeroAddress) {
      if (getAddress(resolver) === getAddress(publicResolver)) {
        const resolved = results[5];
        const content = results[6];
        if (resolved?.status === "success" && resolved.result !== zeroAddress) {
          resolvedAddress = resolved.result as Address;
        }
        if (content?.status === "success" && content.result !== "0x") {
          contentHash = content.result as Hex;
        }
      } else {
        const [resolved, content] = await Promise.allSettled([
          this.publicClient.readContract({
            address: resolver,
            abi: publicResolverAbi,
            functionName: "addr",
            args: [identity.namehash],
            ...(options.blockNumber !== undefined ? { blockNumber: options.blockNumber } : {}),
          }),
          this.publicClient.readContract({
            address: resolver,
            abi: publicResolverAbi,
            functionName: "contenthash",
            args: [identity.namehash],
            ...(options.blockNumber !== undefined ? { blockNumber: options.blockNumber } : {}),
          }),
        ]);
        if (resolved.status === "fulfilled" && resolved.value !== zeroAddress) resolvedAddress = resolved.value;
        if (content.status === "fulfilled" && content.value !== "0x") contentHash = content.value;
      }
    }
    const optional = <T>(index: number): T | null => {
      const result = results[index];
      return result?.status === "success" ? result.result as T : null;
    };
    return {
      record: {
        releaseId: this.releaseId,
        name: identity.name,
        node: identity.namehash,
        tokenId: identity.tokenId,
        registryOwner,
        registrant,
        resolver: resolver === zeroAddress ? null : resolver,
        resolvedAddress,
        contentHash,
        expiry: expiry === 0n ? null : expiry,
        available,
      },
      releaseId: this.releaseId,
      quote: durationYears === undefined ? null : optional<bigint>(7),
      blockTimestamp: durationYears === undefined ? null : optional<bigint>(8),
    };
  }

  async name(label: string, options: ReleaseReadOptions = {}): Promise<NameRecord> {
    return (await this.readNameSnapshot(label, undefined, options)).record;
  }

  /** Reads the complete name record, annual quote, and the atomic Arc block
   * timestamp in one Multicall request. Auxiliary quote/timestamp failures do
   * not discard an otherwise authoritative name record. */
  async nameWithQuote(
    label: string,
    durationYears: bigint,
    options: ReleaseReadOptions = {},
  ): Promise<NameQuoteSnapshot> {
    return this.readNameSnapshot(label, durationYears, options);
  }

  async reverse(account: Address, options: ReleaseReadOptions = {}): Promise<{
    releaseId: Hex;
    name: string | null;
    forwardConfirmed: boolean;
  }> {
    await this.assertChain();
    // The on-chain reverse registrar validates single-label suffix shape,
    // registrar ACTIVE lifecycle and forward addr equality before returning.
    const effectiveName = await this.publicClient.readContract({
      address: requireDeployedContract(this.manifest, "reverseRegistrar"),
      abi: reverseRegistrarAbi,
      functionName: "name",
      args: [getAddress(account)],
      ...(options.blockNumber !== undefined ? { blockNumber: options.blockNumber } : {}),
    });
    return effectiveName.length === 0
      ? { releaseId: this.releaseId, name: null, forwardConfirmed: false }
      : { releaseId: this.releaseId, name: effectiveName, forwardConfirmed: true };
  }

  async listing(tokenId: bigint) {
    await this.assertChain();
    const [listing, feeBps] = await Promise.all([
      this.publicClient.readContract({
        address: requireDeployedContract(this.manifest, "marketplace"),
        abi: marketplaceAbi,
        functionName: "listingOf",
        args: [tokenId],
      }),
      this.publicClient.readContract({
        address: requireDeployedContract(this.manifest, "marketplace"),
        abi: marketplaceAbi,
        functionName: "feeBps",
      }),
    ]);
    return {
      releaseId: this.releaseId,
      seller: listing[0],
      price: listing[1],
      validUntil: listing[2],
      feeBps,
    };
  }
}

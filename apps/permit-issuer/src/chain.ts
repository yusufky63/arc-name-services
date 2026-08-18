import { createPublicClient, decodeFunctionData, getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { ARC_TESTNET, requireActivatedContract, type DeploymentManifest } from "@contour/config";
import { baseRegistrarAbi, controllerAbi, erc20Abi, registryAbi } from "@contour/sdk";
import type { ChainPolicyReader } from "./service.js";
import { rateLimitedArcHttp } from "./arc-rpc.js";

const issuerControllerAbi = [
  ...controllerAbi,
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "requester", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "permitSigner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "signerPolicyVersion", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "registrationsPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

export function createChainPolicyReader(manifest: DeploymentManifest, rpcUrl: string): ChainPolicyReader {
  const client = createPublicClient({
    chain: ARC_TESTNET,
    transport: rateLimitedArcHttp(rpcUrl),
    batch: { multicall: { wait: 25 } },
  });
  const address = requireActivatedContract(manifest, "controller");
  const registrar = requireActivatedContract(manifest, "baseRegistrar");
  const registry = requireActivatedContract(manifest, "registry");
  return {
    quote: (normalizedLabel, durationYears) => client.readContract({ address, abi: issuerControllerAbi, functionName: "quote", args: [normalizedLabel, durationYears] }),
    nonce: (requester: Address) => client.readContract({ address, abi: issuerControllerAbi, functionName: "nonces", args: [requester] }),
    available: (tokenId) => client.readContract({ address: registrar, abi: baseRegistrarAbi, functionName: "available", args: [tokenId] }),
    allowance: (payer) => client.readContract({ address: manifest.settlement.erc20Address, abi: erc20Abi, functionName: "allowance", args: [payer, address] }),
    referralBps: () => client.readContract({ address, abi: issuerControllerAbi, functionName: "referralBps" }).then((value) => BigInt(value)),
    health: async () => {
      const [chainId, permitSigner, signerPolicyVersion, registrationsPaused] = await Promise.all([
        client.getChainId(),
        client.readContract({ address, abi: issuerControllerAbi, functionName: "permitSigner" }),
        client.readContract({ address, abi: issuerControllerAbi, functionName: "signerPolicyVersion" }),
        client.readContract({ address, abi: issuerControllerAbi, functionName: "registrationsPaused" }),
      ]);
      return { chainId, permitSigner, signerPolicyVersion: BigInt(signerPolicyVersion), registrationsPaused };
    },
    expiryProof: async (permit) => {
      const block = await client.getBlock();
      if (block.number === null) throw new Error("latest Arc block is not finalized enough for expiry proof");
      const [usedPermit, requesterNonce, available] = await Promise.all([
        client.readContract({ address, abi: issuerControllerAbi, functionName: "usedPermit", args: [permit.permitId], blockNumber: block.number }),
        client.readContract({ address, abi: issuerControllerAbi, functionName: "nonces", args: [permit.requester], blockNumber: block.number }),
        client.readContract({ address: registrar, abi: baseRegistrarAbi, functionName: "available", args: [BigInt(permit.normalizedLabelHash)], blockNumber: block.number }),
      ]);
      return {
        blockTimestamp: block.timestamp,
        usedPermit,
        requesterNonce: BigInt(requesterNonce),
        available,
      };
    },
    inspectSubmission: async (txHash: Hex) => {
      let transaction;
      try { transaction = await client.getTransaction({ hash: txHash }); }
      catch (error) {
        if (error instanceof Error && /not.?found/i.test(error.name + error.message)) return { state: "unknown" as const };
        throw error;
      }
      if (!transaction.to) return { state: "unknown" as const };
      let decoded;
      try { decoded = decodeFunctionData({ abi: issuerControllerAbi, data: transaction.input }); }
      catch { return { state: "unknown" as const }; }
      if (decoded.functionName !== "register" || !decoded.args) return { state: "unknown" as const };
      const permit = decoded.args[1] as unknown as {
        permitId: Hex; requester: Address; authorizedExecutor: Address; recipient: Address;
        normalizedLabelHash: Hex; namehash: Hex; nonce: bigint;
      };
      const common = {
        transactionFrom: getAddress(transaction.from),
        transactionTo: getAddress(transaction.to),
        permitId: permit.permitId,
        requester: getAddress(permit.requester),
        labelHash: permit.normalizedLabelHash,
      };
      if (getAddress(transaction.to) !== getAddress(address) || getAddress(transaction.from) !== getAddress(permit.authorizedExecutor)) {
        return { state: "invalid" as const, ...common };
      }
      let receipt;
      try { receipt = await client.getTransactionReceipt({ hash: txHash }); }
      catch (error) {
        if (error instanceof Error && /not.?found/i.test(error.name + error.message)) return { state: "pending" as const, ...common };
        throw error;
      }
      if (receipt.status === "reverted") return { state: "reverted" as const, ...common };

      const consumedTopic = keccak256(stringToHex("PermitConsumed(bytes32,address,uint256)"));
      const registeredTopic = keccak256(stringToHex("NameRegistered(string,bytes32,address,uint256,uint256,uint256)"));
      const topicAddress = (topic: Hex | undefined) => topic ? getAddress(`0x${topic.slice(-40)}`) : null;
      const controllerLogs = receipt.logs.filter((log) => getAddress(log.address) === getAddress(address));
      const consumed = controllerLogs.filter((log) =>
        log.topics[0]?.toLowerCase() === consumedTopic.toLowerCase() &&
        log.topics[1]?.toLowerCase() === permit.permitId.toLowerCase() &&
        topicAddress(log.topics[2]) === getAddress(permit.requester) &&
        log.topics[3] !== undefined && BigInt(log.topics[3]) === permit.nonce,
      );
      const registered = controllerLogs.filter((log) =>
        log.topics[0]?.toLowerCase() === registeredTopic.toLowerCase() &&
        log.topics[1]?.toLowerCase() === permit.normalizedLabelHash.toLowerCase() &&
        topicAddress(log.topics[2]) === getAddress(permit.recipient),
      );
      const tokenId = BigInt(permit.normalizedLabelHash);
      try {
        const [registrant, registryOwner, expiry, used, requesterNonce, block] = await Promise.all([
          client.readContract({ address: registrar, abi: baseRegistrarAbi, functionName: "ownerOf", args: [tokenId], blockNumber: receipt.blockNumber }),
          client.readContract({ address: registry, abi: registryAbi, functionName: "owner", args: [permit.namehash], blockNumber: receipt.blockNumber }),
          client.readContract({ address: registrar, abi: baseRegistrarAbi, functionName: "nameExpires", args: [tokenId], blockNumber: receipt.blockNumber }),
          client.readContract({ address, abi: issuerControllerAbi, functionName: "usedPermit", args: [permit.permitId], blockNumber: receipt.blockNumber }),
          client.readContract({ address, abi: issuerControllerAbi, functionName: "nonces", args: [permit.requester], blockNumber: receipt.blockNumber }),
          client.getBlock({ blockNumber: receipt.blockNumber }),
        ]);
        const valid = consumed.length === 1 && registered.length === 1 && used === true &&
          BigInt(requesterNonce) > permit.nonce && getAddress(registrant) === getAddress(permit.recipient) &&
          getAddress(registryOwner) === getAddress(permit.recipient) && BigInt(expiry) > block.timestamp;
        return { state: valid ? "success" as const : "invalid" as const, ...common, tokenId };
      } catch {
        return { state: "invalid" as const, ...common, tokenId };
      }
    },
  };
}

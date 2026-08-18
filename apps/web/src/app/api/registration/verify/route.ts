import { NextRequest, NextResponse } from "next/server";
import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  isAddress,
  isHex,
  zeroAddress,
  type Hex,
} from "viem";
import { requireActivatedContract } from "@contour/config";
import { deriveNameIdentity } from "@contour/normalization";
import { baseRegistrarAbi, controllerAbi, registryAbi } from "@contour/sdk";
import { readSmallJsonObject, RequestBodyTooLargeError } from "@/lib/api-validation";
import { getDeploymentManifest, protocolCapabilities } from "@/lib/manifest";
import { ApiAdmissionError, withApiAdmission } from "@/lib/api-admission";
import { rateLimitedArcHttp } from "@/lib/arc-rpc";
import { arcTestnet } from "@/lib/network";
import {
  invalidateAccountSnapshot,
  invalidateNameDiscovery,
} from "@/lib/protocol-read-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type VerifyBody = {
  transactionHash?: unknown;
  rawLabel?: unknown;
  recipient?: unknown;
  requester?: unknown;
  permitId?: unknown;
};

export async function POST(request: NextRequest) {
  if (!protocolCapabilities.registration) {
    return NextResponse.json({ verified: false, error: "Registration is not active." }, { status: 503 });
  }

  let body: VerifyBody;
  try {
    body = (await readSmallJsonObject(request, 16_384)) as VerifyBody;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json(
        { verified: false, error: "Request body is too large." },
        { status: 413 },
      );
    }
    return NextResponse.json({ verified: false, error: "Invalid JSON request." }, { status: 400 });
  }
  if (
    typeof body.transactionHash !== "string" ||
    !isHex(body.transactionHash) ||
    body.transactionHash.length !== 66 ||
    typeof body.permitId !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(body.permitId) ||
    typeof body.rawLabel !== "string" ||
    body.rawLabel.length === 0 ||
    body.rawLabel.length > 256 ||
    typeof body.recipient !== "string" ||
    !isAddress(body.recipient) ||
    typeof body.requester !== "string" ||
    !isAddress(body.requester)
  ) {
    return NextResponse.json({ verified: false, error: "Invalid verification request." }, { status: 400 });
  }
  if (getAddress(body.recipient) === zeroAddress || getAddress(body.requester) === zeroAddress) {
    return NextResponse.json({ verified: false, error: "Verification parties cannot use the zero address." }, { status: 400 });
  }

  try {
    return await withApiAdmission("registration:verify", 8, async () => {
      const deployment = getDeploymentManifest();
    const suffix = deployment.namespace.suffix;
    if (!suffix) throw new Error("suffix missing");
    const identity = deriveNameIdentity(body.rawLabel as string, suffix);
    const recipient = getAddress(body.recipient as string);
    const requester = getAddress(body.requester as string);
    const controller = requireActivatedContract(deployment, "controller");
    const registrar = requireActivatedContract(deployment, "baseRegistrar");
    const registry = requireActivatedContract(deployment, "registry");
    const client = createPublicClient({
      batch: { multicall: { wait: 25 } },
      chain: arcTestnet,
      transport: rateLimitedArcHttp(deployment.chain.rpcUrl),
    });
      const [chainId, receipt] = await Promise.all([
      client.getChainId(),
      client.getTransactionReceipt({ hash: body.transactionHash as Hex }),
    ]);
      if (
      chainId !== deployment.chain.id ||
      receipt.status !== "success" ||
      !receipt.to ||
      getAddress(receipt.to) !== getAddress(controller) ||
      getAddress(receipt.from) !== requester
      ) {
        throw new Error("receipt did not confirm the expected controller");
      }

      const [receiptBlock, latestBlockNumber] = await Promise.all([
        client.getBlock({ blockNumber: receipt.blockNumber }),
        client.getBlockNumber(),
      ]);
      const confirmations = latestBlockNumber >= receipt.blockNumber
        ? latestBlockNumber - receipt.blockNumber + 1n
        : 0n;
      if (confirmations < BigInt(Math.max(1, deployment.chain.confirmations))) {
        throw new Error("receipt has not reached the Arc finality policy");
      }

      let registeredExpiry: bigint | null = null;
      const registrationLog = receipt.logs.find((log) => {
      if (getAddress(log.address) !== getAddress(controller)) return false;
      try {
        const event = decodeEventLog({ abi: controllerAbi, data: log.data, topics: log.topics });
        if (event.eventName !== "NameRegistered") return false;
        const matches = (
          event.args.name === identity.normalized &&
          event.args.label.toLowerCase() === identity.labelhash.toLowerCase() &&
          getAddress(event.args.owner) === recipient &&
          event.args.expires > receiptBlock.timestamp
        );
        if (matches) registeredExpiry = event.args.expires;
        return matches;
      } catch {
        return false;
      }
      });
      if (!registrationLog) throw new Error("expected NameRegistered event missing");

      const permitLog = receipt.logs.find((log) => {
      if (getAddress(log.address) !== getAddress(controller)) return false;
      try {
        const event = decodeEventLog({ abi: controllerAbi, data: log.data, topics: log.topics });
        if (event.eventName !== "PermitConsumed") return false;
        return (
          event.args.permitId.toLowerCase() === (body.permitId as string).toLowerCase() &&
          getAddress(event.args.requester) === requester
        );
      } catch {
        return false;
      }
      });
      if (!permitLog) throw new Error("expected PermitConsumed event missing");

      const [tokenOwner, registryOwner, registrarExpiry, usedPermit] = await Promise.all([
      client.readContract({
        address: registrar,
        abi: baseRegistrarAbi,
        functionName: "ownerOf",
        args: [identity.tokenId],
        blockNumber: receipt.blockNumber,
      }),
      client.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "owner",
        args: [identity.namehash],
        blockNumber: receipt.blockNumber,
      }),
      client.readContract({
        address: registrar,
        abi: baseRegistrarAbi,
        functionName: "nameExpires",
        args: [identity.tokenId],
        blockNumber: receipt.blockNumber,
      }),
      client.readContract({
        address: controller,
        abi: controllerAbi,
        functionName: "usedPermit",
        args: [body.permitId as Hex],
        blockNumber: receipt.blockNumber,
      }),
    ]);
      if (
      getAddress(tokenOwner) !== recipient ||
      getAddress(registryOwner) !== recipient ||
      registeredExpiry === null ||
      registrarExpiry < registeredExpiry ||
      !usedPermit
      ) {
        throw new Error("post-registration state mismatch");
      }

      invalidateAccountSnapshot(recipient);
      invalidateNameDiscovery();

      return NextResponse.json({
      verified: true,
      // The integrated issuer is stateless. A matching Arc receipt, events and
      // current ownership are the complete and authoritative finalization.
      issuerReconciled: true,
      transactionHash: receipt.transactionHash,
      confirmedAtBlock: receipt.blockNumber.toString(),
      confirmations: confirmations.toString(),
      tokenId: identity.tokenId.toString(),
      owner: recipient,
      });
    });
  } catch (error) {
    if (error instanceof ApiAdmissionError) {
      return NextResponse.json(
        { verified: false, error: "The registration service is busy. Retry shortly." },
        { status: 503, headers: { "retry-after": "2" } },
      );
    }
    return NextResponse.json(
      { verified: false, error: "The receipt could not be verified against Arc state." },
      { status: 409 },
    );
  }
}

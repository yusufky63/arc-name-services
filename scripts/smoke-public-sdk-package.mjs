import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "npm", "sdk");
const npmCacheRoot = join(root, ".npm-cache");
const deploymentManifestPath = join(root, "deployments", "5042002.json");
const deploymentManifestBytes = await readFile(deploymentManifestPath);
const deploymentManifestValue = JSON.parse(deploymentManifestBytes.toString("utf8"));
const deploymentManifestSha256 =
  `0x${createHash("sha256").update(deploymentManifestBytes).digest("hex")}`;
const deploymentReleaseId = deploymentManifestValue.releaseId;
if (!/^0x[0-9a-fA-F]{64}$/.test(deploymentReleaseId ?? "")) {
  throw new Error("The canonical deployment manifest must contain one exact release ID.");
}
const temporaryRoot = resolve(tmpdir());
const consumerRoot = await mkdtemp(join(temporaryRoot, "contour-sdk-smoke-"));
const installFromRegistry = process.argv.includes("--registry");
const verifyLiveDocs = process.argv.includes("--live-docs");

if (!consumerRoot.startsWith(`${temporaryRoot}${sep}`)) {
  throw new Error(`Refusing to use unexpected smoke directory: ${consumerRoot}`);
}

function run(command, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        npm_config_cache: npmCacheRoot,
      },
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

try {
  let packageSpecifier;
  if (installFromRegistry) {
    const packageManifest = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    );
    packageSpecifier = `${packageManifest.name}@${packageManifest.version}`;
  } else {
    await run("npm", ["pack", "--pack-destination", consumerRoot], packageRoot);
    const tarballs = (await readdir(consumerRoot)).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      throw new Error(`Expected one SDK tarball, found ${tarballs.length}`);
    }
    packageSpecifier = `./${tarballs[0]}`;
  }

  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(consumerRoot, "deployment-manifest.json"),
    deploymentManifestBytes,
    "utf8",
  );
  await run(
    "npm",
    [
      "install",
      packageSpecifier,
      "viem@2.55.2",
      "typescript@5.9.3",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    consumerRoot,
  );

  const liveManifestCheck = verifyLiveDocs
    ? [
        "const liveManifest = await fetchDeploymentManifest(",
        '  "https://contour-arc.vercel.app/deployment-manifest.json",',
        "  {",
        `    expectedManifestSha256: "${deploymentManifestSha256}",`,
        `    expectedReleaseId: "${deploymentReleaseId}",`,
        "  },",
        ");",
        'if (liveManifest.state !== "active") throw new Error("live manifest is not active");',
      ]
    : [];

  await writeFile(
    join(consumerRoot, "smoke.mjs"),
    [
      'import { readFile } from "node:fs/promises";',
      'import { decodeFunctionData, getAddress, zeroAddress } from "viem";',
      'import { ARC_TESTNET, ArcNameClient, controllerAbi, deriveNameIdentity, erc20Abi, fetchDeploymentManifest, marketplaceAbi, normalizeLabel, parseDeploymentManifest, prepareApprovalPlan, prepareBuyPlan, prepareListingPlan, prepareRegistrationPlan, resolverDataHash } from "contour-sdk";',
      'import { ARC_TESTNET as CONFIG_ARC_TESTNET } from "contour-sdk/config";',
      'import { normalizeLabel as normalizeFromSubpath } from "contour-sdk/normalization";',
      'if (ARC_TESTNET.id !== 5_042_002) throw new Error("unexpected Arc chain id");',
      'if (CONFIG_ARC_TESTNET.id !== ARC_TESTNET.id) throw new Error("config subpath export mismatch");',
      'if (normalizeLabel("Atlas").normalized !== "atlas") throw new Error("normalization failed");',
      'if (normalizeFromSubpath("Atlas").normalized !== "atlas") throw new Error("normalization subpath export failed");',
      'if (typeof ArcNameClient !== "function") throw new Error("ArcNameClient export is missing");',
      'if (typeof fetchDeploymentManifest !== "function") throw new Error("manifest fetch export is missing");',
      'if (typeof prepareBuyPlan !== "function") throw new Error("transaction plan export is missing");',
      'const manifest = parseDeploymentManifest(JSON.parse(await readFile(new URL("./deployment-manifest.json", import.meta.url), "utf8")));',
      'const identity = deriveNameIdentity("atlas", manifest.namespace.suffix);',
      'const account = getAddress("0x1111111111111111111111111111111111111111");',
      'const expectedAmount = 25_000_000n;',
      'const permit = {',
      '  chainId: BigInt(ARC_TESTNET.id),',
      '  controller: manifest.contracts.controller.address,',
      '  releaseId: manifest.releaseId,',
      '  normalizationProfileHash: manifest.normalization.profileHash,',
      '  normalizedLabelHash: identity.labelhash,',
      '  namehash: identity.namehash,',
      '  requester: account, recipient: account, payer: account, authorizedExecutor: account,',
      '  durationYears: 1n,',
      '  resolverDataHash: resolverDataHash([]),',
      '  referrer: zeroAddress,',
      '  settlementAsset: manifest.settlement.erc20Address,',
      '  expectedAmount,',
      '  expectedReferralBps: BigInt(manifest.activationEvidence.controllerPolicy.referralBps),',
      '  permitId: "0x1212121212121212121212121212121212121212121212121212121212121212",',
      '  nonce: 7n, issuedAt: 1_000n, validAfter: 995n, validUntil: 1_200n,',
      '};',
      'const approval = prepareApprovalPlan(manifest, expectedAmount);',
      'const registrationInput = {',
      '  manifest, rawLabel: "atlas", normalizationAccepted: false, permit,',
      `  signature: "0x${"11".repeat(65)}",`,
      '};',
      'let registration = null;',
      'if (manifest.registrarVersion === "v2") {',
      '  registration = prepareRegistrationPlan(registrationInput);',
      '} else {',
      '  let rejectedLegacyRegistration = false;',
      '  try { prepareRegistrationPlan(registrationInput); } catch { rejectedLegacyRegistration = true; }',
      '  if (!rejectedLegacyRegistration) throw new Error("legacy V1 registration plan was not rejected");',
      '}',
      'const listing = prepareListingPlan(manifest, 7n, expectedAmount, 2_000_000_000n);',
      'const purchase = prepareBuyPlan(manifest, 7n, expectedAmount, 250);',
      'const plans = registration === null ? [approval, listing, purchase] : [approval, registration, listing, purchase];',
      'for (const plan of plans) {',
      '  if (plan.chainId !== ARC_TESTNET.id) throw new Error("plan chain mismatch");',
      '  if (plan.value !== 0n) throw new Error("plan must never send native value");',
      '  if (!/^0x[0-9a-f]+$/i.test(plan.data) || plan.data === "0x") throw new Error("plan calldata is missing");',
      '}',
      'if (approval.to !== getAddress(manifest.settlement.erc20Address)) throw new Error("approval target mismatch");',
      'const approvalCall = decodeFunctionData({ abi: erc20Abi, data: approval.data });',
      'if (approvalCall.functionName !== "approve" || approvalCall.args[0] !== getAddress(manifest.contracts.controller.address) || approvalCall.args[1] !== expectedAmount) throw new Error("approval calldata mismatch");',
      'if (registration !== null) {',
      '  if (registration.to !== getAddress(manifest.contracts.controller.address)) throw new Error("registration target mismatch");',
      '  const registrationCall = decodeFunctionData({ abi: controllerAbi, data: registration.data });',
      '  if (registrationCall.functionName !== "register" || registrationCall.args[0] !== "atlas") throw new Error("registration calldata mismatch");',
      '}',
      'if (listing.to !== getAddress(manifest.contracts.marketplace.address)) throw new Error("listing target mismatch");',
      'const listingCall = decodeFunctionData({ abi: marketplaceAbi, data: listing.data });',
      'if (listingCall.functionName !== "list" || listingCall.args[0] !== 7n || listingCall.args[1] !== expectedAmount || listingCall.args[2] !== 2_000_000_000n) throw new Error("listing calldata mismatch");',
      'if (purchase.to !== getAddress(manifest.contracts.marketplace.address)) throw new Error("purchase target mismatch");',
      'const purchaseCall = decodeFunctionData({ abi: marketplaceAbi, data: purchase.data });',
      'if (purchaseCall.functionName !== "buy" || purchaseCall.args[0] !== 7n || purchaseCall.args[1] !== expectedAmount || purchaseCall.args[2] !== 250) throw new Error("purchase calldata mismatch");',
      ...liveManifestCheck,
      `console.log("Public SDK runtime smoke passed (${installFromRegistry ? "npm registry" : "local tarball"}).");`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(consumerRoot, "smoke.ts"),
    [
      'import { createPublicClient, http } from "viem";',
      'import { ARC_TESTNET, ArcNameClient, fetchDeploymentManifest, normalizeLabel, prepareBuyPlan, type DeploymentManifest, type UnsignedTransactionPlan } from "contour-sdk";',
      'import { ARC_TESTNET as CONFIG_ARC_TESTNET, type DeploymentManifest as ConfigDeploymentManifest } from "contour-sdk/config";',
      'import { normalizeLabel as normalizeFromSubpath } from "contour-sdk/normalization";',
      "const chainId: number = ARC_TESTNET.id;",
      'const normalized: string = normalizeLabel("Atlas").normalized;',
      'const normalizedFromSubpath: string = normalizeFromSubpath("Atlas").normalized;',
      "const configChainId: number = CONFIG_ARC_TESTNET.id;",
      "const manifestPromise: Promise<DeploymentManifest> = fetchDeploymentManifest(",
      '  "https://contour-arc.vercel.app/deployment-manifest.json",',
      "  {",
      `    expectedManifestSha256: "${deploymentManifestSha256}",`,
      `    expectedReleaseId: "${deploymentReleaseId}",`,
      "  },",
      ");",
      "declare const manifest: DeploymentManifest & ConfigDeploymentManifest;",
      "const rpc = createPublicClient({ chain: ARC_TESTNET, transport: http(manifest.chain.rpcUrl) });",
      "new ArcNameClient(rpc, manifest);",
      "const purchase: UnsignedTransactionPlan = prepareBuyPlan(manifest, 7n, 25_000_000n, 250);",
      "void chainId;",
      "void normalized;",
      "void normalizedFromSubpath;",
      "void configChainId;",
      "void manifestPromise;",
      "void purchase;",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(consumerRoot, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true }, include: ["smoke.ts"] }, null, 2)}\n`,
    "utf8",
  );

  await run("node", ["smoke.mjs"], consumerRoot);
  await run("npx", ["--no-install", "tsc", "-p", "tsconfig.json"], consumerRoot);
  console.log(
    `Public SDK TypeScript consumer smoke passed (${installFromRegistry ? "npm registry" : "local tarball"}).`,
  );
} finally {
  await rm(consumerRoot, { recursive: true, force: true });
}

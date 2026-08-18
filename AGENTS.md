# AI & Developer Operations Guide — Contour Name Protocol

This document defines critical operational, architectural, and build rules for AI agents and human developers modifying the Contour Name Protocol codebase.

---

## 1. Monorepo Build Pipeline & CI Rules
- The repository is a PNPM monorepo consisting of packages and apps.
- Compiled output directories (/dist) are gitignored. Always run `pnpm packages:build` before running typecheck, tests, or web applications.
- `apps/web` prebuild script MUST always execute `pnpm --dir ../.. packages:build` to guarantee all workspace packages are built before Next.js builds on Vercel/CI.

---

## 2. No Version Hardcoding on Core Execution Paths
- The canonical deployed suite on Arc Testnet (Chain ID: 5042002) is the source-verified Canonical V1 suite.
- NEVER gate user-facing execution functions (such as `prepareRegistrationPlan`, `prepareApprovalPlan`, or `prepareMarketplaceApprovalPlan` in `@contour/sdk`) with hardcoded registrar version checks (e.g. `registrarVersionOf(manifest) !== "v2"`).
- Always bind execution readiness to real on-chain/manifest truth:
  - Registration is active when: `manifest.state === "active" && manifest.permitIssuer.active && manifest.activationEvidence.controllerPolicy.registrationsPaused === false`.
  - Marketplace is active when: `manifest.state === "active" && manifest.activationEvidence.marketplacePolicy.paused === false`.

---

## 3. Manifest Modification & Promotion Attestation Sync
- The canonical manifest is located at `deployments/5042002.json`.
- The promotion attestation is located at `deployments/5042002.promotion.json`.
- Whenever `deployments/5042002.json` is modified (e.g. updating x402 parameters, URLs, or policy values), you MUST update `manifestSha256` in `deployments/5042002.promotion.json` to match `deploymentManifestDigest(manifest)` (`@contour/config`).
- If `x402.active` is `true`, it requires `x402.facilitatorUrl` to be non-null and `manifest.state === "active"`.

---

## 4. Mandatory Pre-Deployment Verification
Before pushing changes to `main` (which triggers live Vercel deployments), execute the complete verification matrix:
1. `pnpm typecheck` — Must pass with 0 errors (`exactOptionalPropertyTypes: true`).
2. `pnpm lint` — Must pass with 0 errors / 0 warnings (`--max-warnings=0`).
3. `pnpm test:workspace` — All workspace tests must pass.
4. `pnpm test:scripts` — All 154+ verification and evidence scripts must pass.
5. `node scripts/production-e2e.mjs` — Production E2E suite must pass all 6 stages.
6. `pnpm build` — Full Next.js production build and Foundry contract size checks must succeed.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

test("template has no block-zero or fake hex deployment address", async () => {
  const yaml = await readFile(new URL("../subgraph.template.yaml", import.meta.url), "utf8");
  assert.doesNotMatch(yaml, /startBlock:\s*0\b/);
  assert.doesNotMatch(yaml, /0x(?:[0-9a-fA-F]){40}/);
  for (const key of ["registryAddress", "baseRegistrarAddress", "controllerAddress", "publicResolverAddress"]) {
    assert.match(yaml, new RegExp(`\\{\\{${key}\\}\\}`));
  }
});

test("BENS owner and registrant remain separate", async () => {
  const schema = await readFile(new URL("../schema.graphql", import.meta.url), "utf8");
  assert.match(schema, /type Domain @entity\(immutable: false\) \{[\s\S]*?id:\s*ID!/);
  assert.match(schema, /owner:\s*Account!/);
  assert.match(schema, /registrant:\s*Account/);
  assert.match(schema, /resolvedAddress:\s*Account/);
  assert.match(schema, /cost:\s*BigInt\b/);
  assert.match(schema, /subdomainCount:\s*Int!/);
  assert.match(schema, /isMigrated:\s*Boolean!/);
  assert.match(schema, /storedOffchain:\s*Boolean!/);
  assert.match(schema, /resolvedWithWildcard:\s*Boolean!/);
  assert.match(schema, /labelName:\s*String/);
  assert.match(schema, /coinTypes:\s*\[BigInt!\]/);
  assert.match(schema, /type AddrChanged[\s\S]*?addr:\s*Account!/);
  assert.match(schema, /type MulticoinAddrChanged[\s\S]*?addr:\s*Bytes!/);
  assert.match(schema, /type NewOwner[\s\S]*?parentDomain:\s*Domain!/);
  assert.doesNotMatch(schema, /blockNumber:\s*BigInt!/);
});

test("zero-address and resolver-version changes clear stale state", async () => {
  const registry = await readFile(new URL("../src/registry.ts", import.meta.url), "utf8");
  const registrar = await readFile(new URL("../src/registrar.ts", import.meta.url), "utf8");
  const resolver = await readFile(new URL("../src/resolver.ts", import.meta.url), "utf8");
  assert.match(registry, /target\.unset\("resolvedAddress"\)/);
  assert.match(registry, /target\.unset\("resolver"\)/);
  assert.match(registrar, /target\.unset\("registrant"\)/);
  assert.match(registrar, /registration\.registrant = newOwner\.id/);
  assert.match(registrar, /new NameTransferred/);
  assert.match(resolver, /resolver\.unset\("addr"\)/);
  assert.match(resolver, /resolver\.unset\("contentHash"\)/);
  assert.match(resolver, /resolver\.coinTypes = \[\]/);
  assert.match(resolver, /target\.unset\("resolvedAddress"\)/);
});

test("human labels reject every ENS dot separator and pin the canonical corpus", async () => {
  const helpers = await readFile(new URL("../src/helpers.ts", import.meta.url), "utf8");
  for (const separator of [".", "。", "．", "｡"]) {
    assert.match(helpers, new RegExp(`label\\.includes\\(\\"${separator.replace(".", "\\.")}\\"\\)`));
  }
  const corpus = await readFile(
    new URL("../../../packages/normalization/fixtures/corpus.canonical.json", import.meta.url),
  );
  const canonical = corpus.at(-1) === 10 ? corpus.subarray(0, -1) : corpus;
  assert.equal(
    `0x${createHash("sha256").update(canonical).digest("hex")}`,
    "0xd25e274d718f468f1edbded13a5319a404d9e2dff39ded6ecf78ef88ea37cf60",
  );
});

test("activated render requires config parsing and a product-live promotion attestation", async () => {
  const renderer = await readFile(new URL("./render-manifest.mjs", import.meta.url), "utf8");
  assert.match(renderer, /parseDeploymentManifest/);
  assert.match(renderer, /assertProductLivePromotionAttestation\(attestation, manifest\)/);
});

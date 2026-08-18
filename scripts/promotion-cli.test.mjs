import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePromotionCliArguments,
  promotionVerifierOptions,
} from "./promotion-cli.mjs";

const PROMOTION_ENVIRONMENT_KEYS = [
  "ARC_RPC_URL",
  "PROMOTION_ALLOWED_FETCH_HOSTS",
  "PROMOTION_APPROVED_CONTRACT_RUNTIME_HASHES",
  "PROMOTION_REVIEWER_ADDRESSES",
  "PROMOTION_CANDIDATE_INGRESS_USERNAME",
  "PROMOTION_CANDIDATE_INGRESS_PASSWORD",
  "PROMOTION_AUTHENTICATED_CANDIDATE_SOURCE",
];

function withCleanPromotionEnvironment(run) {
  const previous = Object.fromEntries(
    PROMOTION_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of PROMOTION_ENVIRONMENT_KEYS) delete process.env[key];
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("parses an explicit candidate origin without changing positional paths", () => {
  assert.deepEqual(parsePromotionCliArguments([
    "deployments/candidate.json",
    "deployments/candidate.promotion.json",
    "--candidate-origin",
    "https://unaliased-candidate.vercel.app",
  ]), {
    manifestArgument: "deployments/candidate.json",
    attestationArgument: "deployments/candidate.promotion.json",
    candidateOrigin: "https://unaliased-candidate.vercel.app",
  });
});

test("rejects ambiguous or malformed candidate-origin CLI syntax", () => {
  assert.throws(
    () => parsePromotionCliArguments(["--candidate-origin"]),
    /requires an exact HTTPS origin/,
  );
  assert.throws(
    () => parsePromotionCliArguments([
      "--candidate-origin",
      "https://one.example",
      "--candidate-origin",
      "https://two.example",
    ]),
    /only once/,
  );
  assert.throws(
    () => parsePromotionCliArguments(["--candidate-url", "https://candidate.example"]),
    /unknown promotion verification option/,
  );
  assert.throws(
    () => parsePromotionCliArguments(["one.json", "two.json", "three.json"]),
    /at most a manifest and attestation path/,
  );
});

test("threads only the explicit candidate origin into verifier options", () => {
  withCleanPromotionEnvironment(() => {
    const options = promotionVerifierOptions({
      chain: { rpcUrl: "https://rpc.testnet.arc.network" },
    }, {
      candidateOrigin: "https://unaliased-candidate.vercel.app",
    });
    assert.equal(
      options.privateCandidateOrigin,
      "https://unaliased-candidate.vercel.app",
    );
    assert.equal(options.issuerHealthAuthorization, undefined);
  });
});

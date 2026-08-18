export const CANDIDATE_RELEASE_ENVIRONMENT_KEYS = Object.freeze([
  "PRIVATE_CANDIDATE_MODE",
  "PRIVATE_CANDIDATE_INGRESS_USERNAME",
  "PRIVATE_CANDIDATE_INGRESS_PASSWORD",
  "PROMOTION_CANDIDATE_INGRESS_USERNAME",
  "PROMOTION_CANDIDATE_INGRESS_PASSWORD",
  "PROMOTION_AUTHENTICATED_CANDIDATE_SOURCE",
] as const);

export function candidateReleaseEnvironmentPresent(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return CANDIDATE_RELEASE_ENVIRONMENT_KEYS.some(
    (key) => typeof environment[key] === "string" && environment[key]!.length > 0,
  );
}

export class ApiAdmissionError extends Error {
  constructor(message = "The service is busy. Retry shortly.") {
    super(message);
    this.name = "ApiAdmissionError";
  }
}

type AdmissionState = { active: number; limit: number };

const admission = new Map<string, AdmissionState>();

/**
 * Process-local backpressure for public routes that amplify one request into
 * multiple RPC, challenge-verification, or signer calls. It intentionally queues nothing:
 * overload fails quickly so serverless instances cannot accumulate work.
 */
export async function withApiAdmission<T>(
  scope: string,
  limit: number,
  operation: () => Promise<T>,
): Promise<T> {
  const current = admission.get(scope) ?? { active: 0, limit };
  current.limit = limit;
  admission.set(scope, current);
  if (current.active >= current.limit) throw new ApiAdmissionError();
  current.active += 1;
  try {
    return await operation();
  } finally {
    current.active -= 1;
  }
}

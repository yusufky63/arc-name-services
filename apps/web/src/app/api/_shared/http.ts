import { NextResponse } from "next/server";

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "Accept, Content-Type",
  "access-control-max-age": "86400",
  "cross-origin-resource-policy": "cross-origin",
} as const;

export const READ_CACHE_HEADERS = {
  "cache-control": "public, s-maxage=15, stale-while-revalidate=60",
} as const;

export const ARTIFACT_CACHE_HEADERS = {
  "cache-control": "public, s-maxage=300, stale-while-revalidate=3600",
} as const;

export function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return NextResponse.json(value, {
    ...init,
    headers: {
      ...CORS_HEADERS,
      ...READ_CACHE_HEADERS,
      ...init.headers,
    },
  });
}

export function textResponse(
  value: string,
  contentType: string,
  init: ResponseInit = {},
) {
  return new NextResponse(value, {
    ...init,
    headers: {
      ...CORS_HEADERS,
      ...ARTIFACT_CACHE_HEADERS,
      "content-type": contentType,
      ...init.headers,
    },
  });
}

export function apiError(
  status: number,
  code: string,
  message: string,
  context: unknown = null,
  details?: Record<string, unknown>,
) {
  return jsonResponse(
    {
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
      context,
    },
    {
      status,
      headers: { "cache-control": "private, no-store" },
    },
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}


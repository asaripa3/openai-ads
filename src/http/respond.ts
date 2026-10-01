import { NextResponse } from "next/server";
import { ZodError } from "zod";
import type { Diagnostic } from "@/domain/diagnostics";

/**
 * One envelope for the whole surface. A UI, a partner backend and an agent all
 * need the same thing from a failure: a stable code, a path, and a readable
 * message. A bare string would force every caller to parse prose.
 */

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function fail(status: number, code: string, message: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error: { code, message, ...extra } }, { status });
}

/** Zod issues become diagnostics, so callers see one shape. */
export function zodToDiagnostics(error: ZodError): Diagnostic[] {
  return error.issues.map((issue) => ({
    code: `invalid_${issue.code}`,
    severity: "blocker" as const,
    path: `/${issue.path.join("/")}`,
    message: issue.message,
  }));
}

export function missingApiKey(): NextResponse {
  return fail(
    503,
    "ads_api_key_missing",
    "OPENAI_ADS_API_KEY is not set, so this service cannot reach api.ads.openai.com. Compile and validate still work without it; execution does not.",
    { hint: "Create a key in Ads Manager > Settings, then set OPENAI_ADS_API_KEY (vercel env add OPENAI_ADS_API_KEY)." },
  );
}

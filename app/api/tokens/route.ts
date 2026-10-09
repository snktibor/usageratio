import { apiError, json, readJsonBody, requireSameOrigin, requireSession, withApiHandler } from "@/lib/api";
import { hasSudo } from "@/lib/auth";
import { demoReadOnly } from "@/lib/demo/mode";
import {
  createToken,
  labelProblem,
  listTokens,
  MAX_LABEL_LENGTH,
  MAX_TOKENS,
  MIN_LABEL_LENGTH,
  TOKEN_SCOPES,
  type TokenScope,
} from "@/lib/tokens";
import { parseId } from "@/lib/validation";

/**
 * /api/tokens — per-machine API tokens, an alternative to the one shared
 * USAGE_API_TOKEN that can be individually revoked (lib/tokens.ts). Behind
 * the dashboard's session; POST also needs a fresh sudo grant, since the
 * plaintext it returns is never shown again.
 *
 *   GET  → { "tokens": [{ "id", "label", "machineId", "scope", "createdAt", "lastUsedAt", "revokedAt" }] }
 *          (never the token itself, nor its hash)
 *
 *   POST { "label": "…", "machineId"?: "…", "scope"?: "ingest" | "read" | "official" } → { "id", "token" } (201)
 *          `token` is shown here once and never stored; `machineId`, when
 *          given, restricts POST /api/usage reports to that one machine
 *          (403 machine_mismatch otherwise). `scope` defaults to "ingest";
 *          a "read" token (the menu bar app's) only reads GET /api/status
 *          and GET /api/usage, and takes no `machineId`.
 *
 * 200/201 ok · 400 invalid body · 401 no session · 403 foreign origin, demo
 * mode, or no sudo grant (POST) · 413/415 bad body (POST) ·
 * 422 too_many_tokens once MAX_TOKENS is reached, with its `limit` ·
 * 503 Redis down
 */

const MAX_BODY_BYTES = 1024;

function parseCreateBody(
  value: unknown,
): { label: string; machineId: string | null; scope: TokenScope } | { errors: string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { errors: ["body must be a JSON object"] };
  }
  const body = value as Record<string, unknown>;
  const errors: string[] = [];

  let label = "";
  if (typeof body.label !== "string") {
    errors.push("label must be a string");
  } else {
    label = body.label.trim();
    const problem = labelProblem(label);
    if (problem) errors.push(`label must be ${MIN_LABEL_LENGTH}-${MAX_LABEL_LENGTH} characters`);
  }

  let machineId: string | null = null;
  if (body.machineId !== undefined && body.machineId !== null) {
    machineId = parseId(body.machineId, "machineId", errors);
  }

  let scope: TokenScope = "ingest";
  if (body.scope !== undefined) {
    if (TOKEN_SCOPES.includes(body.scope as TokenScope)) scope = body.scope as TokenScope;
    else errors.push(`scope must be one of ${TOKEN_SCOPES.join(", ")}`);
  }
  if (scope !== "ingest" && machineId !== null) errors.push(`a ${scope} token cannot be bound to a machine`);

  return errors.length > 0 ? { errors } : { label, machineId, scope };
}

export const GET = withApiHandler("api/tokens", async () => {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const tokens = await listTokens();
  return json(
    {
      tokens: tokens.map((token) => ({
        id: token.id,
        label: token.label,
        machineId: token.machineId,
        scope: token.scope,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
        revokedAt: token.revokedAt,
      })),
    },
    200,
  );
});

export const POST = withApiHandler("api/tokens", async ({ request }) => {
  const origin = requireSameOrigin(request);
  if (origin) return origin;
  const readOnly = demoReadOnly();
  if (readOnly) return readOnly;
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;
  if (!(await hasSudo())) return apiError("sudo_required", 403);

  const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
  if (!body.ok) return body.response;
  const parsed = parseCreateBody(body.value);
  if ("errors" in parsed) return apiError("invalid_payload", 400, { details: parsed.errors });

  const result = await createToken(parsed.label, parsed.machineId, new Date(), parsed.scope);
  if (!result.ok) return apiError("too_many_tokens", 422, { limit: MAX_TOKENS });
  return json({ id: result.id, token: result.token }, 201);
});

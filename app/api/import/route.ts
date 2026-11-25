import {
  IMPORT_MAX_BODY_BYTES,
  IMPORT_MAX_INFLATED_BYTES,
  importIntoNewWorkspace,
  planImport,
  workspaceIsEmpty,
  writeImport,
} from "@/lib/account-import";
import {
  apiError,
  json,
  rateLimited,
  readJsonBody,
  requireSameOrigin,
  requireTenantSession,
  requireUserSession,
  withApiHandler,
} from "@/lib/api";
import { hasSudo } from "@/lib/auth";
import { currentTime } from "@/lib/clock";
import { demoReadOnly } from "@/lib/demo/mode";
import { machineCounting, workspaceQuotas } from "@/lib/quotas";
import { isMultiTenant } from "@/lib/registration";
import { clientIp } from "@/lib/request-context";
import { registrationRules } from "@/lib/route-limits";

/**
 * POST /api/import — one workspace of an account export (GET /api/account/export) loaded back
 * (lib/account-import.ts), so its usage can be seen again.
 *
 *   body: { "format": "usageratio-account-export", "version": 1,
 *           "workspace": { "name", "keys": { … } } }   (one entry of the export's `workspaces`, its `data.keys`)
 *   Content-Encoding: gzip is accepted (up to 64 MB inflated); 4 MB as sent.
 *
 * Multi-tenant mode: a new workspace "<name> (import)", owned by the signed-in user; counts as a
 * new workspace (the owned-workspaces quota, the sign-up rate limits). A single-user instance:
 * loads into the instance itself, only while it holds no usage yet, behind the PIN and sudo.
 *
 * 201 { "ok": true, "tenantId", "imported": { providers, groups, machines, reports, cycles },
 *       "skipped": [key names not imported] }
 * 400 invalid_json / invalid_payload (with details) · 401 no session · 403 foreign origin,
 * sudo_required (single-user), demo_read_only · 409 workspace_not_empty (single-user) ·
 * 422 too_many_workspaces / too_many_machines / too_many_providers / too_many_groups (with limit) ·
 * 413 payload_too_large · 415 not JSON, or an encoding other than gzip · 429 rate limited ·
 * 503 Redis down
 */

export const POST = withApiHandler("api/import", async ({ request }) => {
  const demo = demoReadOnly();
  if (demo) return demo;
  const foreign = requireSameOrigin(request);
  if (foreign) return foreign;
  const now = currentTime();
  const multi = isMultiTenant();
  const user = multi ? await requireUserSession() : null;
  if (user instanceof Response) return user;
  const tenant = multi ? null : await requireTenantSession();
  if (tenant instanceof Response) return tenant;
  if (tenant && !(await hasSudo())) return apiError("sudo_required", 403);

  const body = await readJsonBody(request, {
    maxBytes: IMPORT_MAX_BODY_BYTES,
    maxInflatedBytes: IMPORT_MAX_INFLATED_BYTES,
  });
  if (!body.ok) return body.response;
  const planned = planImport(body.value, now, workspaceQuotas(), machineCounting());
  if (!planned.ok) {
    if (planned.reason === "invalid_payload") return apiError("invalid_payload", 400, { details: planned.errors });
    return apiError(planned.reason, 422, { limit: planned.limit });
  }
  const { plan } = planned;
  const result = { imported: plan.counts, skipped: plan.skipped };

  if (user) {
    const limited = await rateLimited(registrationRules(await clientIp(), now));
    if (limited) return limited;
    const created = await importIntoNewWorkspace(user.userId, plan, now);
    if (!created.ok) return apiError(created.reason, 422, { limit: created.limit });
    return json({ ok: true, tenantId: created.tenantId, ...result }, 201);
  }

  const store = tenant!.store;
  if (!(await workspaceIsEmpty(store))) return apiError("workspace_not_empty", 409);
  await writeImport(store, plan);
  return json({ ok: true, tenantId: store.tenantId, ...result }, 201);
});

import { json, requireSession, withApiHandler } from "@/lib/api";
import { sessionTag } from "@/lib/auth";
import { loadAuditTrail } from "@/lib/token-vault";

/**
 * GET /api/api-token/audit — who saved or fetched the API token, newest first,
 * for the settings panel's audit popup. Behind the dashboard's PIN session.
 *
 *   → { "entries": [{ "at": ms, "action": "created" | "updated" | "revealed",
 *                     "browser": "Chrome 140", "os": "macOS", "userAgent": "…",
 *                     "ip": "…", "session": "1a2b3c4d" }],
 *       "currentSession": "1a2b3c4d" }
 *
 * 200 ok · 401 no session · 503 Redis down
 */
export const GET = withApiHandler("api/api-token/audit", async () => {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;
  return json({ entries: await loadAuditTrail(), currentSession: await sessionTag() }, 200);
});

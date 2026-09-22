import { isAuthenticated, sessionTag } from "@/lib/auth";
import { json, storageFailure as failure } from "@/lib/http";
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
export async function GET(): Promise<Response> {
  try {
    if (!(await isAuthenticated())) return json({ error: "unauthorized" }, 401);
    return json({ entries: await loadAuditTrail(), currentSession: await sessionTag() }, 200);
  } catch (error) {
    return failure(error, "The API token audit");
  }
}

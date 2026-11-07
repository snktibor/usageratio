/**
 * The stale-tab guard's header (shared by the server guard in lib/api.ts and
 * the browser side in components/tenant-guard.tsx). The active workspace
 * belongs to the session, so switching it in one tab switches every tab; a
 * form still open in another tab names the workspace it was rendered for, and
 * the server refuses the change (412 tenant_changed) when that is no longer
 * the session's. The header can only make a request fail, never pick a
 * workspace.
 */
export const TENANT_HEADER = "x-usageratio-tenant";

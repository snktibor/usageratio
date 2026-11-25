/**
 * Names of the preference cookies the browser writes and the server reads.
 * A plain module on purpose: a constant exported from a "use client" file
 * reaches Server Components as a client reference, not as its value.
 */

/** The dashboard's last-selected provider (components/dashboard-view.tsx writes it, app/[locale]/(dashboard)/page.tsx reads it). */
export const PROVIDER_COOKIE = "usageratio_provider";

/** "1": the dashboard's hand-entry card is folded to its header (components/dashboard-view.tsx writes it). */
export const OFFICIAL_COLLAPSED_COOKIE = "usageratio_official_collapsed";

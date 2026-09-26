import type { InstallRoute, SetupOs } from "@/lib/setup";

/** The client's last choices, so returning to the page skips picking them again. */
const SETUP_PREFS_COOKIE = "usageratio-setup";

export interface SetupPrefs {
  os?: string;
  route?: string;
  group?: string;
  machine?: string;
}

export function readSetupPrefs(): SetupPrefs | null {
  try {
    const match = document.cookie.match(new RegExp(`(?:^|; )${SETUP_PREFS_COOKIE}=([^;]*)`));
    return match?.[1] ? (JSON.parse(decodeURIComponent(match[1])) as SetupPrefs) : null;
  } catch {
    return null; // Cookies are optional; the defaults still work for this page view.
  }
}

export function writeSetupPrefs(prefs: { os: SetupOs; route: InstallRoute; group: string; machine: string }) {
  try {
    const oneYear = 60 * 60 * 24 * 365;
    // biome-ignore lint/suspicious/noDocumentCookie: a plain preference cookie; the Cookie Store API is not available everywhere yet
    document.cookie = `${SETUP_PREFS_COOKIE}=${encodeURIComponent(JSON.stringify(prefs))}; path=/; max-age=${oneYear}; samesite=lax`;
  } catch {
    // Cookies are optional; the selection still works for this page view.
  }
}

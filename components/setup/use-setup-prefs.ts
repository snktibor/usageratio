import type { InstallRoute, SetupOs } from "@/lib/setup";

/** The client's last choices, so returning to the page skips picking them again. */
const SETUP_PREFS_COOKIE = "usageratio-setup";

export interface SetupPrefs {
  os?: string;
  route?: string;
  group?: string;
  machine?: string;
  /** The cost-estimate opt-in; cookies written before it was saved lack it. */
  cost?: boolean;
}

/** The saved choices in a `document.cookie` string; null when there are none, or they do not parse. */
export function parseSetupPrefs(cookies: string): SetupPrefs | null {
  try {
    const match = cookies.match(new RegExp(`(?:^|; )${SETUP_PREFS_COOKIE}=([^;]*)`));
    return match?.[1] ? (JSON.parse(decodeURIComponent(match[1])) as SetupPrefs) : null;
  } catch {
    return null;
  }
}

/** The `document.cookie` assignment that saves `prefs` for a year. */
export function setupPrefsCookie(prefs: {
  os: SetupOs;
  route: InstallRoute;
  group: string;
  machine: string;
  cost: boolean;
}): string {
  const oneYear = 60 * 60 * 24 * 365;
  return `${SETUP_PREFS_COOKIE}=${encodeURIComponent(JSON.stringify(prefs))}; path=/; max-age=${oneYear}; samesite=lax`;
}

export function readSetupPrefs(): SetupPrefs | null {
  try {
    return parseSetupPrefs(document.cookie);
  } catch {
    return null; // Cookies are optional; the defaults still work for this page view.
  }
}

export function writeSetupPrefs(prefs: Parameters<typeof setupPrefsCookie>[0]) {
  try {
    // biome-ignore lint/suspicious/noDocumentCookie: a plain preference cookie; the Cookie Store API is not available everywhere yet
    document.cookie = setupPrefsCookie(prefs);
  } catch {
    // Cookies are optional; the selection still works for this page view.
  }
}

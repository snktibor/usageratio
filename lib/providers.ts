export const MAX_PROVIDERS = 20;

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Display labels for known provider ids, including a couple of aliases
 * (`anthropic`, `google`) that never come out of the client's provider
 * registry (clients/shared/ccusage-providers.cjs) but may still show up from
 * an older report or a manual --providers override. Every id that registry
 * can return needs an entry here; tests/client-parser.test.ts checks that.
 */
export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Claude",
  claude: "Claude",
  deepseek: "DeepSeek",
  gemini: "Gemini",
  google: "Gemini",
  kimi: "Kimi",
  meta: "Meta",
  mistral: "Mistral",
  openai: "OpenAI",
  qwen: "Qwen",
  xai: "xAI",
};

/** Provider/account id used in payload objects and Redis keys. */
export function normalizeProviderId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return id.length >= 1 && id.length <= 64 && PROVIDER_ID_PATTERN.test(id) ? id : null;
}

export function providerLabel(providerId: string): string {
  const known = PROVIDER_LABELS[providerId];
  if (known) return known;
  return providerId
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Stable union: first appearance wins, invalid/duplicate ids are skipped; empty when nothing is known. */
export function mergeProviderIds(...sources: Iterable<string>[]): string[] {
  const result: string[] = [];
  for (const source of sources) {
    for (const value of source) {
      const id = normalizeProviderId(value);
      if (id && !result.includes(id)) result.push(id);
      if (result.length === MAX_PROVIDERS) return result;
    }
  }
  return result;
}

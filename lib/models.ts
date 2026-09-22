/**
 * Models within a provider: "claude-opus-4-5-20251101", "deepseek-chat". The
 * clients send each model's tokens next to the provider total (see
 * clients/shared/ccusage-providers.cjs); the dashboard charts them one by one.
 */

/** A report lists at most this many models per provider, and this many overall. */
export const MAX_MODELS_PER_PROVIDER = 20;
export const MAX_MODELS_PER_REPORT = 60;

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** A model id as it arrives in a report and is stored. */
export function normalizeModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return id.length >= 1 && id.length <= 64 && MODEL_ID_PATTERN.test(id) ? id : null;
}

/**
 * What the dashboard charts a model under: the stored id without a trailing
 * snapshot date, so "claude-sonnet-4-5-20250929" and a later dated build of
 * the same model are one line of history.
 */
export function modelKey(modelId: string): string {
  return modelId.replace(/-\d{8}$/, "");
}

const WORD_LABELS: Record<string, string> = {
  deepseek: "DeepSeek",
  gpt: "GPT",
  openai: "OpenAI",
  xai: "xAI",
};

/** "claude-opus-4-5" → "Claude Opus 4.5", "deepseek-chat" → "DeepSeek Chat". */
export function modelLabel(key: string): string {
  const words: string[] = [];
  for (const part of key.split("-").filter(Boolean)) {
    const previous = words[words.length - 1];
    // Version numbers come dash-separated in model ids: "4-5" is 4.5.
    if (/^\d{1,2}$/.test(part) && previous !== undefined && /\d$/.test(previous)) {
      words[words.length - 1] = `${previous}.${part}`;
    } else {
      words.push(WORD_LABELS[part] ?? part.charAt(0).toUpperCase() + part.slice(1));
    }
  }
  return words.join(" ") || key;
}

/** Every model key the reports' splits name, in alphabetical order. */
export function modelKeysIn(events: { models?: Record<string, number> }[]): string[] {
  const keys = new Set<string>();
  for (const event of events) {
    for (const modelId of Object.keys(event.models ?? {})) keys.add(modelKey(modelId));
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

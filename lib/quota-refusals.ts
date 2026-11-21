import { createTranslator, type Messages } from "next-intl";
import { routing } from "@/i18n/routing";
import type { Translator } from "@/lib/i18n";
import { toStringRecord } from "@/lib/redis";
import type { TenantStore } from "@/lib/tenant";
import type { StoreReportRefusal } from "@/lib/usage-store";

/**
 * What the quotas (lib/quotas.ts) refused of the reports, kept so the
 * workspace sees it: a machine whose report is refused for a full workspace
 * logs the reason on its own side, and the settings page shows the latest
 * refusal of each kind (multi-tenant mode), so the owner learns why a new
 * machine, provider or group never showed up. One entry per kind, the newest;
 * the key expires QUOTA_REFUSAL_DAYS after the latest write, so it fades once
 * the cause is gone.
 */

export const QUOTA_REFUSAL_DAYS = 7;

const REFUSAL_CODES: readonly StoreReportRefusal[] = ["too_many_machines", "too_many_providers", "too_many_groups"];

export interface QuotaRefusal {
  code: StoreReportRefusal;
  /** When the latest refused report arrived (ms). */
  at: number;
  limit: number;
  machineId: string;
  groupId: string;
}

/** Records one refused report: the newest of its kind replaces the one before. */
export async function recordQuotaRefusal(store: TenantStore, refusal: QuotaRefusal): Promise<void> {
  const tx = store.redis.multi();
  tx.hset(store.keys.quotaRefusals, {
    [refusal.code]: JSON.stringify({ at: refusal.at, limit: refusal.limit, m: refusal.machineId, g: refusal.groupId }),
  });
  tx.expire(store.keys.quotaRefusals, QUOTA_REFUSAL_DAYS * 86_400);
  await tx.exec();
}

function parseRefusal(code: StoreReportRefusal, raw: string | undefined): QuotaRefusal | null {
  if (raw === undefined) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const { at, limit, m, g } = value;
    if (typeof at !== "number" || typeof limit !== "number" || typeof m !== "string" || typeof g !== "string") {
      return null;
    }
    return { code, at, limit, machineId: m, groupId: g };
  } catch {
    return null;
  }
}

/** The latest refusal of each kind from the last QUOTA_REFUSAL_DAYS, newest first. */
export async function loadQuotaRefusals(store: TenantStore, now: Date): Promise<QuotaRefusal[]> {
  const stored = toStringRecord(await store.redis.hgetall(store.keys.quotaRefusals));
  const since = now.getTime() - QUOTA_REFUSAL_DAYS * 86_400_000;
  return REFUSAL_CODES.map((code) => parseRefusal(code, stored[code]))
    .filter((refusal): refusal is QuotaRefusal => refusal !== null && refusal.at >= since)
    .sort((a, b) => b.at - a.at);
}

/**
 * The readable sentence a report's client logs next to the code (the clients
 * print `message` when the body has one). The clients send no locale, so it is
 * the default one's, unless the request names another (`?locale=`).
 */
export async function quotaRefusalMessage(code: StoreReportRefusal, limit: number, request: Request): Promise<string> {
  const requested = new URL(request.url).searchParams.get("locale");
  const locale = routing.locales.find((candidate) => candidate === requested) ?? routing.defaultLocale;
  // Read directly, not through next-intl's request config: a route handler has no request locale.
  const messages = (await import(`../messages/${locale}.json`)).default as Messages;
  const t: Translator<"Quota"> = createTranslator({ locale, messages, namespace: "Quota" });
  return t(`report_${code}`, { limit });
}

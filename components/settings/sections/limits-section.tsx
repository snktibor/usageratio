"use client";

import { useTranslations } from "next-intl";
import { StatusLine } from "@/components/status-line";
import { When } from "@/components/ui/when";
import type { QuotaRefusal } from "@/lib/quota-refusals";
import type { WorkspaceQuotaUse } from "@/lib/quota-use";
import type { QuotaUse } from "@/lib/quotas";

/** What the settings page knows of the workspace's quotas (multi-tenant mode): their use, and what they refused lately. */
export interface SettingsQuota {
  use: WorkspaceQuotaUse;
  refusals: QuotaRefusal[];
}

const ROWS = ["machines", "providers", "groups", "tokens", "members", "pendingInvites"] as const;

/**
 * The workspace's limits (lib/quotas.ts): how much of each it uses, and the
 * reports a full one refused in the last days (lib/quota-refusals.ts), so a
 * machine that never showed up has its reason on this page, not only in its
 * own log. Nothing is ever deleted to make room: the owner chooses what goes.
 */
export function LimitsSection({ titleId, quota }: { titleId: string; quota: SettingsQuota }) {
  const t = useTranslations("Quota");
  const rows = ROWS.flatMap((key) => {
    const use: QuotaUse | null = quota.use[key];
    return use ? [{ key, use }] : [];
  });

  return (
    <section aria-labelledby={`${titleId}-limits`}>
      <h3 id={`${titleId}-limits`} className="font-medium">
        {t("limits_heading")}
      </h3>
      <p className="mt-1 text-sm text-ink-3">{t("limits_explanation")}</p>
      <dl className="mt-4 grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm">
        {rows.map(({ key, use }) => {
          const full = use.used >= use.limit;
          return (
            <div key={key} className="contents">
              <dt className="text-ink-2">{t(`limits_row_${key}`)}</dt>
              <dd className={`text-right tabular-nums ${full ? "font-medium text-warning" : "text-ink"}`}>
                {full
                  ? t("limits_use_full", { used: use.used, limit: use.limit })
                  : t("limits_use", { used: use.used, limit: use.limit })}
              </dd>
            </div>
          );
        })}
      </dl>
      {quota.refusals.length > 0 && (
        <div className="mt-5 space-y-2" role="status">
          {quota.refusals.map((refusal) => (
            <StatusLine key={refusal.code} tone="warning">
              {t(`refused_${refusal.code}`, {
                machine: refusal.machineId,
                group: refusal.groupId,
                limit: refusal.limit,
              })}{" "}
              <span className="text-ink-3">
                (<When ms={refusal.at} />)
              </span>
            </StatusLine>
          ))}
        </div>
      )}
    </section>
  );
}

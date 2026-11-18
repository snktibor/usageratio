"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { AUDIT_LIMIT } from "@/lib/api-token";
import { formatTimestamp } from "@/lib/format";
import type { ManageAuditEntry, ManageSubject } from "@/lib/manage-audit";

type Load =
  | { phase: "loading" }
  | { phase: "failed"; expired: boolean }
  | { phase: "ready"; entries: ManageAuditEntry[]; currentSession: string | null };

/** What an entry is about, as data: `id`, `provider:machine`, and `→ target` for a merge. */
function subjectText({ id, providerId, target }: ManageSubject): string {
  const named = providerId ? `${providerId}:${id}` : id;
  return target ? `${named} → ${providerId ? `${providerId}:${target}` : target}` : named;
}

/**
 * The history of destructive actions (deleted and merged groups, providers and machines, restarts),
 * newest first, in a closed `<details>`: it is fetched when it is first opened. The owner's only
 * (GET /api/manage/audit), so the section leaves it out for a member.
 */
export function ManageHistory({ timeZone }: { timeZone: string }) {
  const locale = useLocale();
  const t = useTranslations("Settings");
  const [opened, setOpened] = useState(false);
  const [load, setLoad] = useState<Load>({ phase: "loading" });

  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    fetch("/api/manage/audit", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw response.status;
        const payload = (await response.json()) as { entries: ManageAuditEntry[]; currentSession: string | null };
        if (!cancelled) setLoad({ phase: "ready", ...payload });
      })
      .catch((status: unknown) => {
        if (!cancelled) setLoad({ phase: "failed", expired: status === 401 });
      });
    return () => {
      cancelled = true;
    };
  }, [opened]);

  return (
    <div className="mt-6 border-t border-hairline pt-4">
      <h4 className="text-sm font-medium">{t("manage_history_heading")}</h4>
      <details
        className="mt-2"
        onToggle={(event) => {
          if (event.currentTarget.open) setOpened(true);
        }}
      >
        <summary className="cursor-pointer text-sm text-ink-2">{t("manage_history_show")}</summary>
        {/* Nothing until it is opened: a hidden "loading" line would read as a page still loading. */}
        {!opened ? null : load.phase === "loading" ? (
          <p className="mt-3 text-sm text-ink-3">{t("loading_status")}</p>
        ) : load.phase === "failed" ? (
          <p className="mt-3 text-sm text-ink-2">
            {load.expired ? t("audit_session_expired") : t("audit_store_unavailable")}
          </p>
        ) : (
          <>
            <p className="mt-3 text-sm text-ink-3">
              {t("manage_history_explanation", { limit: AUDIT_LIMIT, timeZone })}
            </p>
            {load.entries.length === 0 ? (
              <p className="mt-3 text-sm text-ink-3">{t("manage_history_empty")}</p>
            ) : (
              // biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics once list-style is none
              <ol role="list" className="mt-3 divide-y divide-hairline border-y border-hairline">
                {load.entries.map((entry, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed newest-first snapshot; two entries can share `at`
                  <li key={`${entry.at}-${index}`} className="py-2.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <time dateTime={new Date(entry.at).toISOString()} className="text-sm tabular-nums">
                        {formatTimestamp(entry.at, timeZone, locale)}
                      </time>
                      <span className="rounded-full border border-ink-3 px-2.5 py-0.5 text-xs text-ink">
                        {t(`manage_history_action_${entry.action}`)}
                      </span>
                    </div>
                    <p className="mt-1 font-mono text-xs text-ink wrap-anywhere">{subjectText(entry.subject)}</p>
                    {entry.affected && (
                      <p className="mt-0.5 text-sm text-ink-3">
                        {t("manage_history_counts", {
                          events: entry.affected.events,
                          machines: entry.affected.machines,
                        })}
                      </p>
                    )}
                    {entry.by && <p className="mt-0.5 text-sm text-ink-2">{t("audit_by", { login: entry.by })}</p>}
                    <p className="mt-0.5 text-sm text-ink-2">
                      {entry.browser ?? (entry.userAgent ? t("audit_unknown_browser") : t("audit_unknown_client"))}
                      {entry.os && ` · ${entry.os}`}
                      {entry.session !== null && entry.session === load.currentSession && (
                        <span className="text-ink-3"> · {t("audit_current_browser")}</span>
                      )}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </details>
    </div>
  );
}

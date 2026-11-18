"use client";

import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useId, useState } from "react";
import { FIELD } from "@/components/ui/classes";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatAgo } from "@/lib/format";
import type { DeleteImpact } from "@/lib/manage-store";

export type DeleteImpactState = { phase: "loading" } | { phase: "failed" } | { phase: "ready"; impact: DeleteImpact };

/**
 * Asks the server what a forced delete would remove (`DELETE …?dryRun=1`),
 * once per `url`. `null` asks for nothing and stays loading.
 */
export function useDeleteImpact(url: string | null): DeleteImpactState {
  const [answer, setAnswer] = useState<{ url: string; state: DeleteImpactState } | null>(null);

  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    const settle = (state: DeleteImpactState) => {
      if (!controller.signal.aborted) setAnswer({ url, state });
    };
    fetch(url, { method: "DELETE", signal: controller.signal })
      .then(async (response) => {
        const payload = response.ok ? ((await response.json()) as { impact?: DeleteImpact }) : null;
        settle(payload?.impact ? { phase: "ready", impact: payload.impact } : { phase: "failed" });
      })
      .catch(() => settle({ phase: "failed" }));
    return () => controller.abort();
  }, [url]);

  return url !== null && answer?.url === url ? answer.state : { phase: "loading" };
}

/**
 * The confirmation for a delete that removes stored reports: the confirm
 * button stays disabled until the group's or provider's exact name is typed
 * (ids are case-sensitive), and an impact line says what goes with it.
 */
export function ForceDeleteDialog({
  kind,
  name,
  title,
  body,
  impact,
  onCancel,
  onConfirm,
}: {
  kind: "group" | "provider";
  name: string;
  title: ReactNode;
  body: ReactNode;
  impact: DeleteImpactState;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations("Settings");
  const tWidgets = useTranslations("Widgets");
  const locale = useLocale();
  const [typed, setTyped] = useState("");
  const labelId = useId();

  function impactLine(): string {
    if (impact.phase === "loading") return t("force_delete_impact_loading");
    if (impact.phase === "failed") return t("force_delete_impact_failed");
    const { events, machines, lastReportAt } = impact.impact;
    if (events === 0 || lastReportAt === null) return t("force_delete_impact_empty", { machines });
    return t("force_delete_impact", {
      events,
      machines,
      ago: formatAgo(lastReportAt, Date.now(), locale, tWidgets("now")),
    });
  }

  const recentMachines = impact.phase === "ready" ? impact.impact.recentMachines : 0;

  return (
    <ConfirmDialog
      title={title}
      body={body}
      cancelLabel={t("cancel")}
      confirmLabel={() => t("delete")}
      danger
      confirmDisabled={typed !== name}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <div className="space-y-3 text-sm">
        <p id={labelId} className="text-ink-2">
          {t.rich("force_delete_type_label", {
            name,
            code: (chunks) => <code className="wrap-anywhere font-mono text-ink">{chunks}</code>,
          })}
        </p>
        <input
          type="text"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            // Enter must neither confirm nor submit a surrounding form: only the button deletes.
            if (event.key === "Enter") event.preventDefault();
          }}
          autoComplete="off"
          spellCheck={false}
          aria-label={t("force_delete_type_aria")}
          aria-describedby={labelId}
          className={`w-full font-mono ${FIELD}`}
        />
        <p className="text-ink-3" aria-live="polite">
          {impactLine()}
        </p>
        {recentMachines > 0 && (
          <p role="note" className="text-critical">
            {kind === "group"
              ? t("force_delete_recent_group", { count: recentMachines })
              : t("force_delete_recent_provider", { count: recentMachines })}
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}

"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { type ResetProblem, sendReset } from "@/components/reset-requests";
import { StatusLine } from "@/components/status-line";
import { FIELD, PRIMARY_BUTTON, QUIET_BUTTON } from "@/components/ui/classes";
import type { Entry } from "@/components/use-official-entry";
import { Link, useRouter } from "@/i18n/routing";
import type { ResetMode } from "@/lib/config";
import { fromWallClockInput, wallClockInput } from "@/lib/cycle";
import type { DashboardModel, DashboardReset } from "@/lib/dashboard";
import { formatCycleMoment, formatPercent } from "@/lib/format";
import { parseOfficialPercent } from "@/lib/ground-truth";
import { beforeFromRaw, MINUTE_MS } from "@/lib/resets";

/** Why the form was not sent, or the server refused it. */
type FormProblem = ResetProblem | "invalid_moment" | "invalid_before";

/** The open form: a new reset (`id` null), or one of the list's. */
interface ResetForm {
  id: string | null;
  /** The edited reset's kind; null for a new one. */
  kind: ResetMode | null;
  /** The `datetime-local` field, as typed. */
  when: string;
  /** "Used before the reset", as typed. */
  before: string;
  /** False while `before` is still the stored figure: it then follows the moment. */
  beforeTouched: boolean;
}

/** The stored official figure as a before-figure, if it was read before `atMs`; empty otherwise. */
function storedBefore(entry: Entry, atMs: number | null): string {
  if (atMs === null || entry.enteredAt === null || entry.enteredAt > atMs) return "";
  const before = beforeFromRaw(entry.raw);
  return before === null ? "" : String(before);
}

/**
 * The current cycle's usage resets, under the official field (lib/resets.ts,
 * /api/resets): "There was a reset…" records one, each row edits its own and
 * deletes it, or reverts it when the menu bar app detected it. A saved change
 * reloads the page: the segments move, and a restart-type reset starts a new
 * cycle.
 */
export function ResetPanel({
  providerId,
  providerLabel,
  model,
  resetMode,
  entry,
}: {
  providerId: string;
  providerLabel: string;
  model: DashboardModel;
  resetMode: ResetMode;
  /** The official field as it stands: what "used before the reset" starts from. */
  entry: Entry;
}) {
  const locale = useLocale();
  const t = useTranslations("Widgets");
  const router = useRouter();
  const [form, setForm] = useState<ResetForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const { timeZone } = model;

  const send = async (method: "POST" | "PUT" | "DELETE", body: Record<string, unknown>) => {
    setBusy(true);
    setProblem(null);
    const result = await sendReset(method, body);
    setBusy(false);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setForm(null);
    router.refresh();
  };

  const openNew = () => {
    const atMs = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    setProblem(null);
    setForm({
      id: null,
      kind: null,
      when: wallClockInput(atMs, timeZone),
      before: storedBefore(entry, atMs),
      beforeTouched: false,
    });
  };

  const openEdit = (reset: DashboardReset) => {
    setProblem(null);
    setForm({
      id: reset.id,
      kind: reset.kind,
      when: wallClockInput(reset.atMs, timeZone),
      before: reset.before === null ? "" : String(reset.before),
      beforeTouched: true,
    });
  };

  const changeWhen = (when: string) =>
    setForm(
      (current) =>
        current && {
          ...current,
          when,
          before: current.beforeTouched ? current.before : storedBefore(entry, fromWallClockInput(when, timeZone)),
        },
    );

  const save = () => {
    if (!form) return;
    const atMs = fromWallClockInput(form.when, timeZone);
    if (atMs === null) {
      setProblem("invalid_moment");
      return;
    }
    const parsed = parseOfficialPercent(form.before);
    if (parsed.invalid) {
      setProblem("invalid_before");
      return;
    }
    const before = parsed.percent;
    void (form.id === null
      ? send("POST", { providerId, atMs, before })
      : send("PUT", { providerId, id: form.id, atMs, before }));
  };

  return (
    <div className="mt-6 border-t border-hairline pt-5">
      {form === null ? (
        <button type="button" onClick={openNew} className={`text-sm ${QUIET_BUTTON}`}>
          {t("reset_add")}
        </button>
      ) : (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
          className="space-y-4"
        >
          <div className="flex flex-wrap gap-x-5 gap-y-4">
            <label className="block">
              <span className="text-sm text-ink-3">{t("reset_when", { timeZone })}</span>
              <input
                type="datetime-local"
                step={60}
                required
                min={form.kind === "restart" ? undefined : wallClockInput(model.cycle.startMs + MINUTE_MS, timeZone)}
                max={wallClockInput(Date.now(), timeZone)}
                value={form.when}
                onChange={(event) => changeWhen(event.target.value)}
                className={`mt-1.5 block tabular-nums ${FIELD}`}
              />
            </label>
            <label className="block">
              <span className="text-sm text-ink-3">{t("reset_before")}</span>
              <span className="relative mt-1.5 block w-28">
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  maxLength={7}
                  placeholder="–"
                  value={form.before}
                  onChange={(event) => setForm({ ...form, before: event.target.value, beforeTouched: true })}
                  className={`block w-28 pr-8 tabular-nums ${FIELD}`}
                />
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ink-3"
                >
                  %
                </span>
              </span>
            </label>
          </div>
          <p className="max-w-2xl text-sm text-ink-3">
            {t.rich("reset_mode_note", {
              label: providerLabel,
              mode: resetMode,
              period: model.period,
              link: (chunks) => (
                <Link
                  href="/settings#settings-general"
                  className="text-ink-2 underline decoration-rule underline-offset-4 hover:decoration-ink-3"
                >
                  {chunks}
                </Link>
              ),
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={`text-sm ${PRIMARY_BUTTON}`}>
              {t("reset_save")}
            </button>
            <button type="button" disabled={busy} onClick={() => setForm(null)} className={`text-sm ${QUIET_BUTTON}`}>
              {t("reset_cancel")}
            </button>
          </div>
        </form>
      )}

      <div aria-live="polite">
        {problem && (
          <div className="mt-3">
            <StatusLine tone="problem">{t(`reset_problem_${problem}`)}</StatusLine>
          </div>
        )}
      </div>

      {model.resets.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-medium text-ink-2">{t("reset_list_heading")}</h3>
          <ul className="mt-2 space-y-2 text-sm text-ink-2">
            {model.resets.map((reset) => {
              const values = {
                moment: formatCycleMoment(reset.atMs, model.period, timeZone, locale),
                before: reset.before === null ? "–" : formatPercent(reset.before / 100, locale),
              };
              return (
                <li key={reset.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span>{reset.kind === "restart" ? t("reset_row_restart", values) : t("reset_row_keep", values)}</span>
                  {reset.source === "report" && <span className="text-ink-3">{t("reset_detected")}</span>}
                  <span className="ml-auto flex shrink-0 gap-2">
                    <button type="button" disabled={busy} onClick={() => openEdit(reset)} className={QUIET_BUTTON}>
                      {t("reset_edit")}
                    </button>
                    {reset.source === "report" ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void send("DELETE", { providerId, id: reset.id, revert: true })}
                        className={QUIET_BUTTON}
                      >
                        {t("reset_revert")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void send("DELETE", { providerId, id: reset.id })}
                        className={QUIET_BUTTON}
                      >
                        {t("delete")}
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

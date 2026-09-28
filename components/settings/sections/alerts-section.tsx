"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { PlusIcon, XIcon } from "@/components/icons";
import { type AlertsDraft, withAlertThreshold } from "@/components/settings/draft";
import { problemText } from "@/components/settings/problem-text";
import { StatusLine } from "@/components/status-line";
import { FIELD, QUIET_BUTTON } from "@/components/ui/classes";
import { Segmented } from "@/components/ui/segmented";
import { Toast } from "@/components/ui/toast";
import { routing } from "@/i18n/routing";
import type { AlertsFormat } from "@/lib/config";
import { MAX_ALERT_THRESHOLDS } from "@/lib/settings";
import { isAllowedWebhookUrl } from "@/lib/webhook";

const FORMATS: AlertsFormat[] = ["generic", "slack", "discord"];

/** The language's own name in itself, matching `LanguageSwitcher`'s labels. */
function localeLabel(locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

export function AlertsSection({
  titleId,
  alerts,
  useTokenLimits,
  onPatch,
}: {
  titleId: string;
  alerts: AlertsDraft;
  useTokenLimits: boolean;
  onPatch: (changes: Partial<AlertsDraft>) => void;
}) {
  const t = useTranslations("Settings");
  const webhookId = useId();
  const formatName = useId();
  const thresholdId = useId();
  const [thresholdProblem, setThresholdProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [testProblem, setTestProblem] = useState<string | null>(null);
  const [testNotice, setTestNotice] = useState<string | null>(null);

  const trimmedUrl = alerts.webhookUrl.trim();
  const urlProblem = trimmedUrl !== "" && !isAllowedWebhookUrl(trimmedUrl);
  const thresholdsFull = alerts.thresholds.length >= MAX_ALERT_THRESHOLDS;

  function addThreshold() {
    if (alerts.newThreshold.trim() === "") return;
    const result = withAlertThreshold(alerts.thresholds, alerts.newThreshold);
    if ("problem" in result) {
      setThresholdProblem(problemText(t, result.problem));
      return;
    }
    setThresholdProblem(null);
    onPatch({ thresholds: result.thresholds, newThreshold: "" });
  }

  async function sendTest() {
    if (trimmedUrl === "" || urlProblem) {
      setTestNotice(null);
      setTestProblem(t("alerts_webhook_invalid"));
      return;
    }
    setSending(true);
    setTestProblem(null);
    setTestNotice(null);
    try {
      const response = await fetch("/api/alerts/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookUrl: trimmedUrl, format: alerts.format, locale: alerts.locale }),
      });
      if (response.ok) {
        setTestNotice(t("alerts_test_sent"));
      } else if (response.status === 401) {
        setTestProblem(t("session_expired"));
      } else {
        setTestProblem(t("alerts_test_failed"));
      }
    } catch {
      setTestProblem(t("server_did_not_respond"));
    } finally {
      setSending(false);
    }
  }

  return (
    <section aria-labelledby={`${titleId}-alerts`} className="space-y-4">
      <h3 id={`${titleId}-alerts`} className="font-medium">
        {t("alerts_heading")}
      </h3>
      <p className="text-sm text-ink-3">
        {useTokenLimits ? t("alerts_explanation_measured") : t("alerts_explanation_official")}
      </p>

      <label className="block" htmlFor={webhookId}>
        <span className="text-sm text-ink-3">{t("alerts_webhook_label")}</span>
        <input
          id={webhookId}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("alerts_webhook_placeholder")}
          value={alerts.webhookUrl}
          onChange={(event) => onPatch({ webhookUrl: event.target.value })}
          aria-invalid={urlProblem || undefined}
          className={`mt-1.5 block w-full min-w-0 ${FIELD}`}
        />
      </label>
      {urlProblem && <StatusLine tone="problem">{t("alerts_webhook_invalid")}</StatusLine>}

      <fieldset>
        <legend className="text-sm text-ink-3">{t("alerts_format_label")}</legend>
        <Segmented
          name={formatName}
          value={alerts.format}
          onChange={(format) => onPatch({ format })}
          className="mt-1.5"
          options={FORMATS.map((format) => ({ value: format, label: t(`alerts_format_${format}`) }))}
        />
      </fieldset>

      <fieldset>
        <legend className="text-sm text-ink-3">{t("alerts_thresholds_label")}</legend>
        {alerts.thresholds.length > 0 ? (
          // biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics once list-style is none
          <ul role="list" className="mt-1.5 flex flex-wrap gap-2">
            {alerts.thresholds.map((threshold) => (
              <li
                key={threshold}
                className="flex items-center rounded-full border border-rule py-0.5 pl-3 pr-0.5 text-sm tabular-nums text-ink"
              >
                {t("alerts_threshold_chip", { value: threshold })}
                <button
                  type="button"
                  onClick={() => {
                    setThresholdProblem(null);
                    onPatch({ thresholds: alerts.thresholds.filter((other) => other !== threshold) });
                  }}
                  aria-label={t("alerts_threshold_remove_aria", { value: threshold })}
                  title={t("alerts_threshold_remove_aria", { value: threshold })}
                  className="ml-0.5 rounded-full p-1.5 text-ink-3 transition-colors hover:text-ink"
                >
                  <XIcon className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-sm text-ink-3">{t("alerts_thresholds_empty")}</p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <label htmlFor={thresholdId} className="sr-only">
            {t("alerts_threshold_add_aria")}
          </label>
          <input
            id={thresholdId}
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            step={1}
            placeholder="80"
            value={alerts.newThreshold}
            disabled={thresholdsFull}
            onChange={(event) => {
              setThresholdProblem(null);
              onPatch({ newThreshold: event.target.value });
            }}
            onKeyDown={(event) => {
              // Enter adds the value; it must not submit the whole settings form.
              if (event.key !== "Enter") return;
              event.preventDefault();
              addThreshold();
            }}
            aria-invalid={thresholdProblem !== null || undefined}
            className={`w-24 tabular-nums ${FIELD}`}
          />
          <span className="text-ink-3">%</span>
          <button
            type="button"
            onClick={addThreshold}
            disabled={thresholdsFull}
            className={`flex items-center gap-2 ${QUIET_BUTTON}`}
          >
            <PlusIcon />
            {t("alerts_threshold_add")}
          </button>
        </div>
        <div aria-live="polite" className="mt-2">
          {thresholdProblem ? (
            <StatusLine tone="problem">{thresholdProblem}</StatusLine>
          ) : thresholdsFull ? (
            <p className="text-sm text-ink-3">{t("alerts_threshold_max", { max: MAX_ALERT_THRESHOLDS })}</p>
          ) : null}
        </div>
      </fieldset>

      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={alerts.perProvider}
          onChange={(event) => onPatch({ perProvider: event.target.checked })}
          className="mt-1 size-4 shrink-0 cursor-pointer accent-ink"
        />
        <span>
          {t("alerts_per_provider_label")}
          <span className="mt-0.5 block text-sm text-ink-3">{t("alerts_per_provider_explanation")}</span>
        </span>
      </label>

      <label className="block">
        <span className="text-sm text-ink-3">{t("alerts_locale_label")}</span>
        <select
          value={alerts.locale}
          onChange={(event) => onPatch({ locale: event.target.value })}
          className={`mt-1.5 block w-48 ${FIELD}`}
        >
          {routing.locales.map((locale) => (
            <option key={locale} value={locale}>
              {localeLabel(locale)}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={sendTest} disabled={sending} className={`text-sm ${QUIET_BUTTON}`}>
          {sending ? t("alerts_test_sending") : t("alerts_test_button")}
        </button>
        <div aria-live="polite">{testProblem && <StatusLine tone="problem">{testProblem}</StatusLine>}</div>
      </div>
      {testNotice && (
        <Toast onDismiss={() => setTestNotice(null)}>
          <StatusLine tone="good">{testNotice}</StatusLine>
        </Toast>
      )}
    </section>
  );
}

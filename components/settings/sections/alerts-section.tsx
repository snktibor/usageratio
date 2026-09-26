"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { AlertsDraft } from "@/components/settings/draft";
import { toggleAlertThreshold } from "@/components/settings/draft";
import { StatusLine } from "@/components/status-line";
import { FIELD, QUIET_BUTTON } from "@/components/ui/classes";
import { Segmented } from "@/components/ui/segmented";
import { Toast } from "@/components/ui/toast";
import { ToggleChip } from "@/components/ui/toggle-chip";
import { routing } from "@/i18n/routing";
import type { AlertsFormat } from "@/lib/config";
import { isAllowedWebhookUrl } from "@/lib/webhook";

/** Thresholds offered even before they are saved; whatever is already stored is offered too. */
const PRESET_THRESHOLDS = [25, 50, 75, 80, 90, 100];

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
  const [sending, setSending] = useState(false);
  const [testProblem, setTestProblem] = useState<string | null>(null);
  const [testNotice, setTestNotice] = useState<string | null>(null);

  const trimmedUrl = alerts.webhookUrl.trim();
  const urlProblem = trimmedUrl !== "" && !isAllowedWebhookUrl(trimmedUrl);
  const thresholdOptions = [...new Set([...PRESET_THRESHOLDS, ...alerts.thresholds])].sort((a, b) => a - b);

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
        <div className="mt-1.5 flex flex-wrap gap-2">
          {thresholdOptions.map((threshold) => (
            <ToggleChip
              key={threshold}
              checked={alerts.thresholds.includes(threshold)}
              onChange={() => onPatch({ thresholds: toggleAlertThreshold(alerts.thresholds, threshold) })}
            >
              {t("alerts_threshold_chip", { value: threshold })}
            </ToggleChip>
          ))}
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

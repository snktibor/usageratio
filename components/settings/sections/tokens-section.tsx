"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { CommandBlock } from "@/components/code-block";
import { KeyIcon, PlusIcon, XIcon } from "@/components/icons";
import { SudoUnlock } from "@/components/setup/sudo-unlock";
import { StatusLine } from "@/components/status-line";
import { FIELD, QUIET_BUTTON } from "@/components/ui/classes";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Toast } from "@/components/ui/toast";
import { formatDateTime } from "@/lib/format";

/**
 * Mirrors lib/tokens.ts's MAX_LABEL_LENGTH and MAX_TOKENS; kept local so this
 * client component never imports lib/tokens.ts, which pulls in node:crypto
 * for token generation.
 */
const MAX_LABEL_LENGTH = 64;
const MAX_TOKENS = 100;
/** How long the revoke confirm button stays disabled after opening. */
const CONFIRM_DELAY_SECONDS = 3;

interface MachineTokenView {
  id: string;
  label: string;
  machineId: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

type Load = { phase: "loading" } | { phase: "failed" } | { phase: "ready"; tokens: MachineTokenView[] };
type SudoRetry =
  | { kind: "create"; label: string; machineId: string | null }
  | { kind: "revoke"; token: MachineTokenView };

async function errorCode(response: Response): Promise<string | null> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error ?? null;
}

/**
 * The settings panel's per-machine tokens section: lists every issued token
 * (label, bound machine, created/last-used, revoked badge), a form to mint a
 * new one, and a revoke button per row. The freshly minted plaintext is shown
 * once, right here, and never fetched again. Fetches its own data
 * (GET /api/tokens), independently of the panel's draft, the same way
 * MachinesSection and TokenSection own their status.
 */
export function TokensSection({
  titleId,
  timeZone,
  onManaged,
}: {
  titleId: string;
  timeZone: string;
  onManaged: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations("Settings");
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  /** The machines that have reported, to bind a new token to; empty until loaded (or if that fails). */
  const [knownMachines, setKnownMachines] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  /** "" = any machine. */
  const [machineId, setMachineId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createProblem, setCreateProblem] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<{ id: string; token: string } | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<MachineTokenView | null>(null);
  const [sudoRetry, setSudoRetry] = useState<SudoRetry | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const labelInputId = useId();
  const machineInputId = useId();

  function reload() {
    setLoad({ phase: "loading" });
    fetch("/api/tokens", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw response.status;
        const payload = (await response.json()) as { tokens: MachineTokenView[] };
        setLoad({ phase: "ready", tokens: payload.tokens });
      })
      .catch(() => setLoad({ phase: "failed" }));
  }

  useEffect(reload, []);

  useEffect(() => {
    fetch("/api/machines", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { machines: { machineId: string }[] };
        // One entry per machine: the index lists a machine once per provider it reports.
        const ids = [...new Set(payload.machines.map((machine) => machine.machineId))];
        setKnownMachines(ids.sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => {});
  }, []);

  const tokens = load.phase === "ready" ? load.tokens : [];

  async function performCreate(rawLabel: string, rawMachineId: string | null) {
    setCreating(true);
    setCreateProblem(null);
    try {
      const response = await fetch("/api/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: rawLabel, ...(rawMachineId !== null && { machineId: rawMachineId }) }),
      });
      if (response.ok) {
        const payload = (await response.json()) as { id: string; token: string };
        setJustCreated(payload);
        setLabel("");
        setMachineId("");
        reload();
        onManaged();
        return;
      }
      const error = await errorCode(response);
      if (error === "sudo_required") {
        setSudoRetry({ kind: "create", label: rawLabel, machineId: rawMachineId });
        return;
      }
      setCreateProblem(
        error === "too_many_tokens" ? t("tokens_too_many", { limit: MAX_TOKENS }) : t("tokens_action_failed"),
      );
    } catch {
      setCreateProblem(t("tokens_action_failed"));
    } finally {
      setCreating(false);
    }
  }

  function requestCreate() {
    const trimmedLabel = label.trim();
    if (trimmedLabel.length === 0 || trimmedLabel.length > MAX_LABEL_LENGTH) {
      setCreateProblem(t("tokens_label_problem", { max: MAX_LABEL_LENGTH }));
      return;
    }
    void performCreate(trimmedLabel, machineId === "" ? null : machineId);
  }

  async function performRevoke(token: MachineTokenView) {
    const response = await fetch(`/api/tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" });
    if (response.ok) {
      setLoad((current) =>
        current.phase === "ready"
          ? {
              phase: "ready",
              tokens: current.tokens.map((entry) =>
                entry.id === token.id ? { ...entry, revokedAt: Date.now() } : entry,
              ),
            }
          : current,
      );
      setToast(t("tokens_revoked_toast", { label: token.label }));
      onManaged();
      return;
    }
    const error = await errorCode(response);
    if (error === "sudo_required") {
      setSudoRetry({ kind: "revoke", token });
      return;
    }
    setProblem(t("tokens_action_failed"));
  }

  return (
    <section aria-labelledby={`${titleId}-tokens`} className="space-y-4">
      <h3 id={`${titleId}-tokens`} className="font-medium">
        {t("tokens_heading")}
      </h3>
      <p className="text-sm text-ink-3">
        {t.rich("tokens_explanation", { code: (chunks) => <code className="text-ink-2">{chunks}</code> })}
      </p>

      {load.phase === "loading" ? (
        <p className="text-sm text-ink-3">{t("loading_status")}</p>
      ) : load.phase === "failed" ? (
        <StatusLine tone="problem">{t("tokens_load_failed")}</StatusLine>
      ) : tokens.length === 0 ? (
        <p className="text-sm text-ink-3">{t("tokens_empty")}</p>
      ) : (
        // biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics once list-style is none
        <ul role="list" className="border-t border-hairline">
          {tokens.map((token) => (
            <li key={token.id} className="border-b border-hairline py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="min-w-0 grow truncate wrap-anywhere">{token.label}</span>
                <span className="shrink-0 text-sm text-ink-3">
                  {token.machineId ? t("tokens_bound_machine", { id: token.machineId }) : t("tokens_any_machine")}
                </span>
                {token.revokedAt !== null ? (
                  <span className="shrink-0 rounded-full border border-rule px-2.5 py-0.5 text-xs text-ink-3">
                    {t("tokens_revoked_badge")}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setPendingRevoke(token)}
                    aria-label={t("tokens_revoke_aria", { label: token.label })}
                    className="rounded-md p-2 text-ink-3 transition-colors hover:text-ink"
                  >
                    <XIcon />
                  </button>
                )}
              </div>
              <p className="mt-1 text-sm text-ink-3">
                {t("tokens_created_at", { date: formatDateTime(token.createdAt, timeZone, locale) })}
                {" · "}
                {token.lastUsedAt !== null
                  ? t("tokens_last_used", { date: formatDateTime(token.lastUsedAt, timeZone, locale) })
                  : t("tokens_never_used")}
              </p>
            </li>
          ))}
        </ul>
      )}

      {justCreated && (
        <div className="space-y-2.5 rounded-md border border-rule bg-raised p-3.5">
          <p className="flex items-center gap-2 text-sm font-medium text-ink">
            <KeyIcon />
            {t("tokens_created_heading")}
          </p>
          <CommandBlock command={justCreated.token} label={t("tokens_created_heading")} />
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-ink-3">{t("tokens_created_note")}</p>
            <button type="button" onClick={() => setJustCreated(null)} className={`shrink-0 ${QUIET_BUTTON}`}>
              {t("tokens_created_done")}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label htmlFor={labelInputId} className="block min-w-0 grow">
          <span className="text-sm text-ink-3">{t("tokens_label_field")}</span>
          <input
            id={labelInputId}
            type="text"
            autoComplete="off"
            maxLength={MAX_LABEL_LENGTH}
            placeholder={t("tokens_new_label_placeholder")}
            value={label}
            onChange={(event) => {
              setLabel(event.target.value);
              setCreateProblem(null);
            }}
            onKeyDown={(event) => {
              // Enter creates the token; it must not submit the whole settings form.
              if (event.key !== "Enter") return;
              event.preventDefault();
              requestCreate();
            }}
            className={`mt-1.5 block w-full min-w-0 ${FIELD}`}
          />
        </label>
        <label htmlFor={machineInputId} className="block min-w-0 sm:w-56">
          <span className="text-sm text-ink-3">{t("tokens_machine_field")}</span>
          <select
            id={machineInputId}
            value={machineId}
            onChange={(event) => {
              setMachineId(event.target.value);
              setCreateProblem(null);
            }}
            className={`mt-1.5 block w-full min-w-0 ${FIELD}`}
          >
            <option value="">{t("tokens_any_machine")}</option>
            {knownMachines.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={requestCreate}
          disabled={creating}
          className={`flex shrink-0 items-center justify-center gap-2 ${QUIET_BUTTON}`}
        >
          <PlusIcon />
          {creating ? t("saving") : t("tokens_create_button")}
        </button>
      </div>

      <div aria-live="polite" className="space-y-2.5">
        {createProblem && <StatusLine tone="problem">{createProblem}</StatusLine>}
        {problem && <StatusLine tone="problem">{problem}</StatusLine>}
        {sudoRetry && (
          <SudoUnlock
            onUnlocked={() => {
              const retry = sudoRetry;
              setSudoRetry(null);
              if (retry.kind === "create") void performCreate(retry.label, retry.machineId);
              else void performRevoke(retry.token);
            }}
          />
        )}
      </div>
      {toast && (
        <Toast onDismiss={() => setToast(null)}>
          <StatusLine tone="good">{toast}</StatusLine>
        </Toast>
      )}

      {pendingRevoke && (
        <ConfirmDialog
          title={t("tokens_revoke_title")}
          body={t("tokens_revoke_body", { label: pendingRevoke.label })}
          cancelLabel={t("cancel")}
          confirmLabel={(secondsLeft) =>
            secondsLeft > 0 ? t("confirm_yes_countdown", { seconds: secondsLeft }) : t("confirm_yes")
          }
          danger
          countdownSeconds={CONFIRM_DELAY_SECONDS}
          onCancel={() => setPendingRevoke(null)}
          onConfirm={() => {
            const token = pendingRevoke;
            setPendingRevoke(null);
            void performRevoke(token);
          }}
        />
      )}
    </section>
  );
}

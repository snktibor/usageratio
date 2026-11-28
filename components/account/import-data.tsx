"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { SudoUnlock } from "@/components/setup/sudo-unlock";
import { StatusLine } from "@/components/status-line";
import { QUIET_BUTTON } from "@/components/ui/classes";

/** One workspace of an export file that has data to import (lib/account-export.ts). */
interface Candidate {
  tenantId: string;
  name: string;
  keys: Record<string, unknown>;
}

type State =
  | { phase: "idle" }
  | { phase: "choose"; candidates: Candidate[] }
  | { phase: "busy" }
  | { phase: "sudo"; candidate: Candidate }
  | { phase: "problem"; message: string };

/** The workspaces of an export file that carry their data; null when the file is not an export. */
export function importCandidates(text: string): Candidate[] | null {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  const { format, workspaces } = (document ?? {}) as { format?: unknown; workspaces?: unknown };
  if (format !== "usageratio-account-export" || !Array.isArray(workspaces)) return null;
  return workspaces.flatMap((entry) => {
    const { tenantId, name, data } = (entry ?? {}) as { tenantId?: unknown; name?: unknown; data?: { keys?: unknown } };
    const keys = data?.keys;
    if (typeof keys !== "object" || keys === null) return [];
    return [
      {
        tenantId: String(tenantId),
        name: typeof name === "string" ? name : String(tenantId),
        keys: keys as Record<string, unknown>,
      },
    ];
  });
}

/** The request body, gzip-compressed where the browser can (an export can be several megabytes). */
async function requestBody(text: string): Promise<{ body: BodyInit; gzip: boolean }> {
  if (typeof CompressionStream === "undefined") return { body: text, gzip: false };
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return { body: await new Response(stream).arrayBuffer(), gzip: true };
}

/**
 * Loads a workspace of a downloaded export back (POST /api/import). `workspace`: multi-tenant
 * mode, into a new workspace, which is then opened; `instance`: a single-user instance, into the
 * instance itself while it is empty, behind the PIN.
 */
export function ImportData({ mode }: { mode: "workspace" | "instance" }) {
  const t = useTranslations("Import");
  const locale = useLocale();
  const inputId = useId();
  const [state, setState] = useState<State>({ phase: "idle" });

  async function importCandidate(candidate: Candidate) {
    setState({ phase: "busy" });
    const payload = JSON.stringify({
      format: "usageratio-account-export",
      version: 1,
      workspace: { name: candidate.name, keys: candidate.keys },
    });
    const { body, gzip } = await requestBody(payload);
    const response = await fetch("/api/import", {
      method: "POST",
      headers: { "content-type": "application/json", ...(gzip && { "content-encoding": "gzip" }) },
      body,
    }).catch(() => null);
    const result = (await response?.json().catch(() => null)) as {
      error?: string;
      limit?: number;
      tenantId?: string;
    } | null;
    if (response?.ok && result?.tenantId) {
      if (mode === "workspace") {
        await fetch("/api/session/tenant", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantId: result.tenantId }),
        }).catch(() => null);
      }
      window.location.assign(`/${locale}`);
      return;
    }
    const error = result?.error;
    const limit = result?.limit ?? 0;
    if (error === "sudo_required") setState({ phase: "sudo", candidate });
    else if (error === "too_many_workspaces") setState({ phase: "problem", message: t("error_workspaces", { limit }) });
    else if (error === "registration_closed") setState({ phase: "problem", message: t("error_registration") });
    else if (error === "tenant_disabled") setState({ phase: "problem", message: t("error_disabled") });
    else if (error === "too_many_machines" || error === "too_many_providers" || error === "too_many_groups") {
      setState({ phase: "problem", message: t("error_quota", { limit }) });
    } else if (error === "workspace_not_empty") setState({ phase: "problem", message: t("error_not_empty") });
    else if (error === "payload_too_large") setState({ phase: "problem", message: t("error_too_large") });
    else if (error === "invalid_payload" || error === "invalid_json") {
      setState({ phase: "problem", message: t("error_invalid") });
    } else setState({ phase: "problem", message: t("error_failed") });
  }

  async function chosen(file: File | undefined) {
    if (!file) return;
    const candidates = importCandidates(await file.text());
    if (candidates === null) setState({ phase: "problem", message: t("error_invalid") });
    else if (candidates.length === 0) setState({ phase: "problem", message: t("error_none") });
    else if (candidates.length === 1) await importCandidate(candidates[0]!);
    else setState({ phase: "choose", candidates });
  }

  return (
    <div>
      <h3 className="font-medium">{t("heading")}</h3>
      <p className="mt-2 text-sm text-ink-2">
        {mode === "workspace" ? t("description_workspace") : t("description_instance")}
      </p>
      <label
        htmlFor={inputId}
        className={`mt-4 inline-block cursor-pointer ${QUIET_BUTTON} ${state.phase === "busy" ? "pointer-events-none opacity-40" : ""}`}
      >
        {state.phase === "busy" ? t("importing") : t("choose_file")}
      </label>
      <input
        id={inputId}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        disabled={state.phase === "busy"}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          void chosen(file);
        }}
      />
      <div aria-live="polite" className="mt-3 space-y-3">
        {state.phase === "choose" && (
          <div>
            <p className="text-sm text-ink-2">{t("choose_workspace")}</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {state.candidates.map((candidate) => (
                <li key={candidate.tenantId}>
                  <button type="button" className={QUIET_BUTTON} onClick={() => importCandidate(candidate)}>
                    {candidate.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {state.phase === "problem" && <StatusLine tone="problem">{state.message}</StatusLine>}
        {state.phase === "sudo" && (
          <SudoUnlock prompt={t("sudo_prompt")} onUnlocked={() => importCandidate(state.candidate)} />
        )}
      </div>
    </div>
  );
}

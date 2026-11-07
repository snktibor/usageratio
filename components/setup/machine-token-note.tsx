"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { CopyError, type CopyErrorCode } from "@/components/clipboard";
import { CommandBlock } from "@/components/code-block";
import { KeyIcon } from "@/components/icons";
import { issueMachineToken } from "@/components/setup/machine-token";
import { SudoUnlock } from "@/components/setup/sudo-unlock";
import { StatusLine } from "@/components/status-line";
import { QUIET_BUTTON } from "@/components/ui/classes";

type State =
  | { phase: "idle" }
  | { phase: "busy" }
  | { phase: "sudo" }
  | { phase: "issued"; token: string }
  | { phase: "problem"; code: Exclude<CopyErrorCode, "sudo_required"> };

/**
 * Multi-tenant mode's token step for the routes that run the installer by hand: there is no
 * shared token to copy, so this issues the machine's own (bound to it, on the audit trail) and
 * shows it once, for the installer's prompt.
 */
export function MachineTokenNote({ machineId }: { machineId: string | null }) {
  const t = useTranslations("Setup");
  const [state, setState] = useState<State>({ phase: "idle" });

  async function issue() {
    if (!machineId) return;
    setState({ phase: "busy" });
    try {
      setState({ phase: "issued", token: await issueMachineToken(machineId) });
    } catch (error) {
      const code = error instanceof CopyError ? error.code : "generic";
      if (code === "sudo_required") setState({ phase: "sudo" });
      else setState({ phase: "problem", code });
    }
  }

  return (
    <div className="space-y-3">
      <p>{t("machine_token_note")}</p>
      {state.phase === "issued" ? (
        <>
          <CommandBlock command={state.token} label={t("machine_token_label")} />
          <p className="text-sm text-ink-3">{t("machine_token_once")}</p>
        </>
      ) : (
        <button
          type="button"
          onClick={issue}
          disabled={!machineId || state.phase === "busy"}
          className={`flex items-center gap-2 ${QUIET_BUTTON}`}
        >
          <KeyIcon />
          {t("machine_token_button")}
        </button>
      )}
      {!machineId && <p className="text-sm text-ink-3">{t("fix_group_machine")}</p>}
      <div aria-live="polite">
        {state.phase === "sudo" && <SudoUnlock onUnlocked={issue} />}
        {state.phase === "problem" && <StatusLine tone="problem">{t(`copy_problem_${state.code}`)}</StatusLine>}
      </div>
    </div>
  );
}

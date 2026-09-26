"use client";

import { useTranslations } from "next-intl";
import { StopCircleIcon } from "@/components/icons";
import type { SetupGroup } from "@/components/setup/setup-view";
import { Segmented } from "@/components/setup/steps";
import { OS_LABEL, SETUP_MODES, SETUP_OSES, type SettingsCheck, type SetupMode, type SetupOs } from "@/lib/setup";

const FIELD =
  "rounded-md border border-rule bg-raised px-3 py-2 text-ink placeholder:text-ink-3 aria-invalid:border-critical";

/** A field's hint, or its problem in its place. */
function FieldNote({ id, problem, hint }: { id: string; problem: string | null; hint: string }) {
  return problem ? (
    <p id={id} className="mt-2 flex items-start gap-2 text-sm text-ink">
      <StopCircleIcon className="mt-0.5 shrink-0 text-critical" />
      <span>{problem}</span>
    </p>
  ) : (
    <p id={id} className="mt-2 text-sm leading-relaxed text-ink-3">
      {hint}
    </p>
  );
}

/** The package's OS and run mode, and the group/machine fields every route uses. */
export function PackageSettings({
  os,
  setOs,
  mode,
  setMode,
  group,
  setGroup,
  machine,
  setMachine,
  cost,
  setCost,
  groups,
  check,
  ids,
}: {
  os: SetupOs;
  setOs: (os: SetupOs) => void;
  mode: SetupMode;
  setMode: (mode: SetupMode) => void;
  group: string;
  setGroup: (group: string) => void;
  machine: string;
  setMachine: (machine: string) => void;
  cost: boolean;
  setCost: (cost: boolean) => void;
  groups: SetupGroup[];
  check: SettingsCheck;
  ids: { group: string; groupNote: string; machine: string; machineNote: string };
}) {
  const t = useTranslations("Setup");
  const rule = t("id_rule");
  const groupProblem = check.ok
    ? null
    : check.group === "missing"
      ? t("group_problem_missing")
      : check.group === "invalid"
        ? t("group_problem_invalid", { rule })
        : null;
  const machineProblem = check.ok ? null : check.machine === "invalid" ? t("machine_problem_invalid", { rule }) : null;
  const selectedGroup = group.trim();

  return (
    <section aria-label={t("package_settings_aria")} className="mt-10 rounded-lg border border-rule px-5 py-6 sm:px-6">
      <div className="flex flex-wrap gap-x-10 gap-y-5">
        <Segmented
          legend={t("os_legend")}
          name="os"
          value={os}
          options={SETUP_OSES}
          labels={OS_LABEL}
          onChange={setOs}
        />
        <Segmented
          legend={t("mode_legend")}
          name="mode"
          value={mode}
          options={SETUP_MODES}
          labels={{ auto: t("mode_auto"), manual: t("mode_manual") }}
          onChange={setMode}
        />
      </div>
      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-ink-2">{t(`mode_${mode}_${os}`)}</p>

      <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-6 border-t border-hairline pt-6 sm:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor={ids.group} className="text-sm text-ink-3">
            {t("group_label")}
          </label>
          <input
            id={ids.group}
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            value={group}
            onChange={(event) => setGroup(event.target.value)}
            aria-invalid={(!check.ok && check.group !== null) || undefined}
            aria-describedby={ids.groupNote}
            className={`mt-1.5 block w-full ${FIELD}`}
          />
          {groups.length > 0 && (
            <div role="group" className="mt-2.5 flex flex-wrap gap-2" aria-label={t("existing_groups")}>
              {groups.map((known) => (
                <button
                  key={known.id}
                  type="button"
                  aria-pressed={known.id === selectedGroup}
                  onClick={() => setGroup(known.id)}
                  className="inline-flex max-w-full items-center gap-2 rounded-full border border-rule px-3 py-1 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink aria-pressed:border-ink-3 aria-pressed:bg-raised aria-pressed:text-ink"
                >
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: known.color }}
                  />
                  <span className="truncate">{known.id}</span>
                </button>
              ))}
            </div>
          )}
          <FieldNote id={ids.groupNote} problem={groupProblem} hint={t("group_hint")} />
        </div>

        <div className="min-w-0">
          <label htmlFor={ids.machine} className="text-sm text-ink-3">
            {t("machine_label")}
          </label>
          <input
            id={ids.machine}
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            placeholder={t("machine_placeholder")}
            value={machine}
            onChange={(event) => setMachine(event.target.value)}
            aria-invalid={(!check.ok && check.machine !== null) || undefined}
            aria-describedby={ids.machineNote}
            className={`mt-1.5 block w-full ${FIELD}`}
          />
          <FieldNote id={ids.machineNote} problem={machineProblem} hint={t("machine_hint")} />
        </div>
      </div>

      <label className="mt-6 flex cursor-pointer items-start gap-3 border-t border-hairline pt-6">
        <input
          type="checkbox"
          checked={cost}
          onChange={(event) => setCost(event.target.checked)}
          className="mt-1 size-4 shrink-0 cursor-pointer accent-ink"
        />
        <span>
          {t("cost_opt_in")}
          <span className="mt-0.5 block text-sm text-ink-3">{t("cost_opt_in_hint")}</span>
        </span>
      </label>
    </section>
  );
}

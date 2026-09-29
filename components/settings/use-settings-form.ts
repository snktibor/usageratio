"use client";

import { useTranslations } from "next-intl";
import { createElement, Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import {
  type AlertsDraft,
  type Draft,
  type DraftGroup,
  type DraftProvider,
  type DraftSubLimit,
  draftFrom,
  groupNameProblem,
  parseLimit,
  toRequest,
  withNewGroup,
} from "@/components/settings/draft";
import { problemText } from "@/components/settings/problem-text";
import { useRouter } from "@/i18n/routing";
import type { SettingsView } from "@/lib/settings";

export interface SettingsFormActions {
  patch: (changes: Partial<Draft>) => void;
  patchGroup: (id: string, changes: Partial<DraftGroup>) => void;
  patchProvider: (id: string, changes: Partial<DraftProvider>) => void;
  setCounted: (groupId: string, providerId: string, counted: boolean) => void;
  addSubLimit: (provider: DraftProvider) => void;
  patchSubLimit: (providerId: string, key: string, changes: Partial<DraftSubLimit>) => void;
  removeSubLimit: (providerId: string, key: string) => void;
  patchAlerts: (changes: Partial<AlertsDraft>) => void;
  addGroup: () => void;
  removeGroup: (group: DraftGroup) => void;
  /** Replaces the draft's group list in place: how the Machines/Groups/Accounts sections reflect a rename, merge or delete they made directly against the manage routes, outside the draft's own save. */
  setGroups: (updater: (groups: DraftGroup[]) => DraftGroup[]) => void;
  save: () => Promise<void>;
  /** Refreshes the page's server-fetched data after a manage-route action (rename/delete/merge/prune), so the page catches up with what the action changed. */
  refresh: () => void;
}

/**
 * The settings form's state and its `save()`, kept apart from the JSX so the
 * form and its sections stay small. `draft.ts` does the actual parsing and
 * validation; this hook only wires it to React state, the translator and the
 * PUT request.
 */
export function useSettingsForm(
  view: SettingsView,
  onSaved: () => void,
): { draft: Draft; actions: SettingsFormActions; problem: ReactNode | null; saving: boolean; dirty: boolean } {
  const t = useTranslations("Settings");
  const router = useRouter();
  /** The draft as last saved (or as loaded): what `dirty` compares against. */
  const [baseline, setBaseline] = useState<Draft>(() => draftFrom(view));
  const [draft, setDraft] = useState<Draft>(baseline);
  const [problem, setProblem] = useState<ReactNode | null>(null);
  const [saving, setSaving] = useState(false);
  const newSubLimitKey = useRef(0);
  /** Set by a successful save: the next view the refresh brings replaces the draft, normalised the way the server stored it. */
  const resyncOnView = useRef(false);

  // Only after a save: a refresh after a manage-route action must not throw away what is being typed.
  useEffect(() => {
    if (!resyncOnView.current) return;
    resyncOnView.current = false;
    const fresh = draftFrom(view);
    setBaseline(fresh);
    setDraft(fresh);
  }, [view]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);

  const patch = (changes: Partial<Draft>) => setDraft((current) => ({ ...current, ...changes }));

  const patchGroup = (id: string, changes: Partial<DraftGroup>) =>
    setDraft((current) => ({
      ...current,
      groups: current.groups.map((group) => (group.id === id ? { ...group, ...changes } : group)),
    }));

  const patchProvider = (id: string, changes: Partial<DraftProvider>) =>
    setDraft((current) => ({
      ...current,
      providers: current.providers.map((provider) => (provider.id === id ? { ...provider, ...changes } : provider)),
    }));

  const setCounted = (groupId: string, providerId: string, counted: boolean) =>
    setDraft((current) => ({
      ...current,
      groups: current.groups.map((group) =>
        group.id === groupId
          ? {
              ...group,
              excluded: counted
                ? group.excluded.filter((id) => id !== providerId)
                : [...group.excluded.filter((id) => id !== providerId), providerId],
            }
          : group,
      ),
    }));

  const patchSubLimits = (providerId: string, change: (list: DraftSubLimit[]) => DraftSubLimit[]) =>
    setDraft((current) => ({
      ...current,
      providers: current.providers.map((provider) =>
        provider.id === providerId ? { ...provider, subLimits: change(provider.subLimits) } : provider,
      ),
    }));

  const patchSubLimit = (providerId: string, key: string, changes: Partial<DraftSubLimit>) =>
    patchSubLimits(providerId, (list) => list.map((sub) => (sub.key === key ? { ...sub, ...changes } : sub)));

  const removeSubLimit = (providerId: string, key: string) =>
    patchSubLimits(providerId, (list) => list.filter((sub) => sub.key !== key));

  const patchAlerts = (changes: Partial<AlertsDraft>) =>
    setDraft((current) => ({ ...current, alerts: { ...current.alerts, ...changes } }));

  const addSubLimit = (provider: DraftProvider) =>
    patchSubLimits(provider.id, (list) => [
      ...list,
      {
        id: null,
        key: `new-${(newSubLimitKey.current += 1)}`,
        name: "",
        modelsText: "",
        mode: "separate",
        shareText: "50",
        limitText: provider.limitText,
        savedShare: 50,
        savedLimit: parseLimit(provider.limitText) ?? provider.savedLimit,
      },
    ]);

  function addGroup() {
    const nameProblem = groupNameProblem(draft.newGroupName, draft.groups);
    setProblem(nameProblem ? problemText(t, nameProblem) : null);
    if (!nameProblem) setDraft(withNewGroup);
  }

  function removeGroup(group: DraftGroup) {
    setDraft((current) => ({
      ...current,
      groups: current.groups.filter((other) => other.id !== group.id),
      // A group that was only ever in this draft has nothing to remove on the server.
      removed: view.groups.some((saved) => saved.id === group.id) ? [...current.removed, group] : current.removed,
    }));
  }

  async function save() {
    // The token has its own save, with its own confirmation: typed but not saved, it would be lost.
    if (draft.apiToken.trim() !== "") {
      setProblem(t("unsaved_api_token"));
      return;
    }

    // A name left in the field was meant to be added: do not lose it silently.
    let pending = draft;
    if (draft.newGroupName.trim() !== "") {
      const nameProblem = groupNameProblem(draft.newGroupName, draft.groups);
      if (nameProblem) {
        setProblem(problemText(t, nameProblem));
        return;
      }
      pending = withNewGroup(draft);
      setDraft(pending);
    }

    const result = toRequest(pending);
    if ("problem" in result) {
      setProblem(problemText(t, result.problem));
      return;
    }

    setSaving(true);
    setProblem(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result.request),
      });
      if (response.ok) {
        setBaseline(pending);
        resyncOnView.current = true;
        router.refresh();
        onSaved();
        return;
      }

      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (response.status === 401) {
        setProblem(t("session_expired"));
        router.refresh();
      } else if (response.status === 403 && payload?.error === "demo_read_only") {
        setProblem(t("demo_read_only"));
      } else if (response.status === 409 && Array.isArray(payload?.groups)) {
        const refused = payload.groups.map(String);
        setDraft((current) => ({
          ...current,
          groups: [
            ...current.groups,
            ...current.removed
              .filter((group) => refused.includes(group.id))
              .map((group) => ({ ...group, hasReports: true })),
          ],
          removed: current.removed.filter((group) => !refused.includes(group.id)),
        }));
        setProblem(t("report_received_during_save", { refused: refused.join(", ") }));
      } else if (response.status === 400 && Array.isArray(payload?.details)) {
        // No JSX here: this file stays a plain .ts module, so the markup is built with createElement.
        const details = payload.details.map(String);
        setProblem(
          createElement(
            Fragment,
            null,
            t("server_rejected_settings"),
            createElement(
              "details",
              { className: "mt-1.5" },
              createElement(
                "summary",
                { className: "cursor-pointer text-ink-2 hover:text-ink" },
                t("server_rejected_details_summary"),
              ),
              createElement(
                "pre",
                {
                  className:
                    "code-scroll mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-hairline bg-page/60 p-2 text-xs",
                },
                details.join("\n"),
              ),
            ),
          ),
        );
      } else {
        setProblem(t("store_unavailable"));
      }
    } catch {
      setProblem(t("server_did_not_respond"));
    } finally {
      setSaving(false);
    }
  }

  // The manage routes have already stored the change: the baseline takes it too, so it does not count as unsaved.
  const setGroups = (updater: (groups: DraftGroup[]) => DraftGroup[]) => {
    setDraft((current) => ({ ...current, groups: updater(current.groups) }));
    setBaseline((current) => ({ ...current, groups: updater(current.groups) }));
  };

  return {
    draft,
    problem,
    saving,
    dirty,
    actions: {
      patch,
      patchGroup,
      patchProvider,
      setCounted,
      addSubLimit,
      patchSubLimit,
      removeSubLimit,
      patchAlerts,
      addGroup,
      removeGroup,
      setGroups,
      save,
      refresh: () => router.refresh(),
    },
  };
}

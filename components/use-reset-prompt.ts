"use client";

import { useCallback, useEffect, useState } from "react";
import { promptsReset } from "@/lib/resets";

/**
 * "Was there a reset?" (lib/resets.ts `promptsReset`): the figure the official
 * field held when an edit of it began, kept while the edit is being saved and
 * while the question it raises stands. `from` is that figure once the
 * question stands, else null. The question waits for the save to settle: a
 * reset recorded while the save was still on its way would be overwritten by
 * it, since the save carries the old segment's tag. `beginEdit` is called
 * before each change (it keeps the first figure), `dismiss` once answered.
 */
export function useResetPrompt(
  percent: number | null,
  saving: boolean,
): { from: number | null; beginEdit: () => void; dismiss: () => void } {
  const [edit, setEdit] = useState<{ from: number | null } | null>(null);
  const asks = edit !== null && promptsReset(edit.from, percent);

  useEffect(() => {
    // An edit that raises no question ends with its save.
    if (edit !== null && !saving && !asks) setEdit(null);
  }, [edit, saving, asks]);

  const beginEdit = useCallback(() => setEdit((current) => current ?? { from: percent }), [percent]);
  const dismiss = useCallback(() => setEdit(null), []);
  return { from: asks && !saving ? (edit?.from ?? null) : null, beginEdit, dismiss };
}

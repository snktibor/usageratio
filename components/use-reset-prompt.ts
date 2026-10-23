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
 *
 * An edit belongs to the segment it began in: `sessionKey` names that segment
 * and whether it is a finished cycle's (`${closed}:${segment start}`). When it
 * changes (a reset was recorded or detected meanwhile, or the page went to or
 * from a past cycle) the edit ends with it, however the figure stands now: the
 * view stays mounted across those, and a figure typed before must not raise a
 * question about the figure of another segment.
 */
export function useResetPrompt(
  percent: number | null,
  saving: boolean,
  sessionKey: string,
): { from: number | null; beginEdit: () => void; dismiss: () => void } {
  const [edit, setEdit] = useState<{ from: number | null; key: string } | null>(null);
  // An edit of another key is no edit: derived here, so no render shows it, and cleared below.
  const current = edit !== null && edit.key === sessionKey ? edit : null;
  const asks = current !== null && promptsReset(current.from, percent);

  useEffect(() => {
    // An edit that raises no question ends with its save.
    if (edit !== null && (current === null || (!saving && !asks))) setEdit(null);
  }, [edit, current, saving, asks]);

  const beginEdit = useCallback(
    () => setEdit((open) => (open !== null && open.key === sessionKey ? open : { from: percent, key: sessionKey })),
    [percent, sessionKey],
  );
  const dismiss = useCallback(() => setEdit(null), []);
  return { from: asks && !saving ? (current?.from ?? null) : null, beginEdit, dismiss };
}

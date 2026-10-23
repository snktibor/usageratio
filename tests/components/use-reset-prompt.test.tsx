import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useResetPrompt } from "@/components/use-reset-prompt";

interface Props {
  percent: number | null;
  saving: boolean;
  sessionKey: string;
}

const OPEN = "false:1000";

function renderPrompt(initial: Props = { percent: 62, saving: false, sessionKey: OPEN }) {
  const hook = renderHook((props: Props) => useResetPrompt(props.percent, props.saving, props.sessionKey), {
    initialProps: initial,
  });
  /** What a change of the field does in one event: the edit begins and the figure and its save follow. */
  const edit = (next: Props) =>
    act(() => {
      hook.result.current.beginEdit();
      hook.rerender(next);
    });
  return { ...hook, edit };
}

describe("useResetPrompt", () => {
  it("asks from the figure the edit began at, once the save has settled", () => {
    const { result, rerender, edit } = renderPrompt();
    expect(result.current.from).toBeNull();

    edit({ percent: 8, saving: true, sessionKey: OPEN });
    expect(result.current.from).toBeNull();

    rerender({ percent: 8, saving: false, sessionKey: OPEN });
    expect(result.current.from).toBe(62);

    act(() => result.current.dismiss());
    expect(result.current.from).toBeNull();
  });

  it("keeps the first figure through further changes, and ends with an edit that raises no question", () => {
    const { result, rerender, edit } = renderPrompt();
    edit({ percent: 8, saving: true, sessionKey: OPEN });
    edit({ percent: 3, saving: true, sessionKey: OPEN });
    rerender({ percent: 3, saving: false, sessionKey: OPEN });
    expect(result.current.from).toBe(62);

    // Edited back up: no question, and the session is over, so the next edit starts from here.
    edit({ percent: 40, saving: true, sessionKey: OPEN });
    rerender({ percent: 40, saving: false, sessionKey: OPEN });
    expect(result.current.from).toBeNull();
    edit({ percent: 5, saving: true, sessionKey: OPEN });
    rerender({ percent: 5, saving: false, sessionKey: OPEN });
    expect(result.current.from).toBe(40);
  });

  it("ends the session when the key changes: a new segment, or a switch to or from a finished cycle", () => {
    const { result, rerender, edit } = renderPrompt();
    edit({ percent: 8, saving: true, sessionKey: OPEN });
    rerender({ percent: 8, saving: false, sessionKey: OPEN });
    expect(result.current.from).toBe(62);

    // The figure still holds (8, 54 points under 62) but belongs to another segment's session.
    rerender({ percent: 8, saving: false, sessionKey: "false:2000" });
    expect(result.current.from).toBeNull();
    // Gone for good, not only hidden: the old key coming back does not revive it.
    rerender({ percent: 8, saving: false, sessionKey: OPEN });
    expect(result.current.from).toBeNull();

    // An edit begun under one key raises no question under a finished cycle's.
    edit({ percent: 2, saving: true, sessionKey: OPEN });
    rerender({ percent: 2, saving: false, sessionKey: OPEN });
    expect(result.current.from).toBe(8);
    rerender({ percent: 2, saving: false, sessionKey: "true:1000" });
    expect(result.current.from).toBeNull();
  });
});

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSegmentEntries } from "@/components/use-official-entry";

const refresh = vi.fn();
vi.mock("@/i18n/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/i18n/routing")>()),
  useRouter: () => ({ push: vi.fn(), refresh }),
}));

const START = Date.parse("2026-09-28T00:00:00Z");
const END = Date.parse("2026-10-05T00:00:00Z");
const A = START;

type Props = { official: number | null };

/** The bodies of the PUTs sent so far. */
function bodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

/** The hook over one segment `A`, whose server figure is `official`. */
function renderSegments(initial: Props) {
  return renderHook(({ official }: Props) => useSegmentEntries("claude", START, [{ startMs: A, official }], END), {
    initialProps: initial,
  });
}

describe("useSegmentEntries", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    refresh.mockClear();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a newer edit when an earlier save's refresh brings that save's figure", async () => {
    // The first save stays in flight until we say so.
    let finishFirst: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (finishFirst = resolve)));
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const hook = renderSegments({ official: 20 });

    act(() => hook.result.current[1](A, "50"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Typing on while the first save is on its way arms a second one.
    act(() => hook.result.current[1](A, "55"));
    await act(async () => {
      finishFirst(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    // The refresh brings the first save's figure: the newer text must stand.
    hook.rerender({ official: 50 });
    expect(hook.result.current[0].get(A)?.raw).toBe("55");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies(fetchMock)[1]).toEqual({
      providerId: "claude",
      raw: "55",
      cycleStartMs: START,
      segmentStartMs: A,
    });
  });
  describe("two segments edited in a row", () => {
    const B = A + 3 * 24 * 3_600_000;
    const renderTwo = () =>
      renderHook(
        () =>
          useSegmentEntries(
            "claude",
            START,
            [
              { startMs: A, official: 20 },
              { startMs: B, official: 30 },
            ],
            END,
          ),
        {},
      );

    it("sends the second save only once the first has settled, each with its own segment", async () => {
      let finishFirst: (response: Response) => void = () => {};
      fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (finishFirst = resolve)));
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
      const hook = renderTwo();

      act(() => hook.result.current[1](A, "50"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      act(() => hook.result.current[1](B, "60"));

      // The first save goes out at 600 ms and is held; the second one's pause is over at 700 ms.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        finishFirst(new Response(JSON.stringify({ ok: true }), { status: 200 }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(bodies(fetchMock)).toEqual([
        { providerId: "claude", raw: "50", cycleStartMs: START, segmentStartMs: A },
        { providerId: "claude", raw: "60", cycleStartMs: START, segmentStartMs: B },
      ]);
      expect(hook.result.current[2].get(A)).toEqual({ status: "saved", problem: null });
      expect(hook.result.current[2].get(B)).toEqual({ status: "saved", problem: null });
    });

    it("does not stall behind a save that was rejected or never got through", async () => {
      fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("offline")));
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
      const hook = renderTwo();

      act(() => hook.result.current[1](A, "50"));
      act(() => hook.result.current[1](B, "60"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(hook.result.current[2].get(A)).toEqual({ status: "failed", problem: "network" });
      expect(hook.result.current[2].get(B)).toEqual({ status: "saved", problem: null });
    });
  });
  it("does not render again on mount, and still takes a changed server figure", () => {
    let renders = 0;
    const hook = renderHook(
      ({ official }: Props) => {
        renders += 1;
        return useSegmentEntries("claude", START, [{ startMs: A, official }], END);
      },
      { initialProps: { official: 20 } as Props },
    );
    expect(hook.result.current[0].get(A)?.raw).toBe("20");
    expect(renders).toBe(1);

    hook.rerender({ official: 35 });
    expect(hook.result.current[0].get(A)?.raw).toBe("35");
  });
});

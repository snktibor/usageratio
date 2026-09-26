import { describe, expect, it } from "vitest";
import { TxPlan, TxPlanMismatchError } from "@/lib/redis-tx";

describe("TxPlan", () => {
  it("reads results back by name, in the order the commands were planned", () => {
    const plan = new TxPlan();
    const queued: string[] = [];
    plan.add("first", () => queued.push("a"));
    plan.add(null, () => queued.push("b"));
    plan.add("third", () => queued.push("c"));

    expect(queued).toEqual(["a", "b", "c"]);
    expect(plan.size).toBe(3);
    expect(plan.has("first")).toBe(true);
    expect(plan.has("second")).toBe(false);
    const results = [1, "ignored", 0];
    expect(plan.result(results, "first")).toBe(1);
    expect(plan.result(results, "third")).toBe(0);
  });

  it("returns what the enqueue callback returns", () => {
    const plan = new TxPlan();
    expect(plan.add("x", () => 42)).toBe(42);
  });

  it("refuses a result array of the wrong length", () => {
    const plan = new TxPlan();
    plan.add("only", () => undefined);
    expect(() => plan.result([], "only")).toThrow(TxPlanMismatchError);
    expect(() => plan.result([1, 2], "only")).toThrow(/Planned 1 commands but got 2 results/);
  });

  it("refuses an unknown name and a name planned twice", () => {
    const plan = new TxPlan();
    plan.add("a", () => undefined);
    expect(() => plan.result([1], "b")).toThrow(/No command was planned as "b"/);
    expect(() => plan.add("a", () => undefined)).toThrow(/planned twice/);
  });
});

/**
 * Names the commands of a pipeline or transaction, so their results are read
 * back by name rather than by position. A plan that does not match the number
 * of results (a command added or dropped on one side only) fails loudly instead
 * of silently reading a neighbour's result.
 *
 *   const plan = new TxPlan();
 *   plan.add("group", () => tx.hsetnx(...));
 *   plan.add(null, () => tx.expire(...));        // a result nobody reads
 *   const results = await tx.exec();
 *   Number(plan.result(results, "group")) === 1
 */
export class TxPlanMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxPlanMismatchError";
  }
}

export class TxPlan {
  private count = 0;
  private readonly positions = new Map<string, number>();

  /** Queues one command (`enqueue` does the queuing) under `name`; null for a result nobody needs. */
  add<T>(name: string | null, enqueue: () => T): T {
    if (name !== null) {
      if (this.positions.has(name)) throw new TxPlanMismatchError(`Command "${name}" is planned twice.`);
      this.positions.set(name, this.count);
    }
    this.count += 1;
    return enqueue();
  }

  /** The result of the command planned as `name`. */
  result(results: readonly unknown[], name: string): unknown {
    if (results.length !== this.count) {
      throw new TxPlanMismatchError(`Planned ${this.count} commands but got ${results.length} results.`);
    }
    const position = this.positions.get(name);
    if (position === undefined) throw new TxPlanMismatchError(`No command was planned as "${name}".`);
    return results[position];
  }

  get size(): number {
    return this.count;
  }

  has(name: string): boolean {
    return this.positions.has(name);
  }
}

/**
 * Migrates the pre-provider ("DeepSeek only") key layout into the current,
 * provider-prefixed one — see lib/migrate-legacy.ts.
 *
 *   npm run migrate:legacy             dry run: prints the plan, writes nothing
 *   npm run migrate:legacy -- --apply  performs the migration
 *
 * Run this against production, with --apply, BEFORE deploying a build of this
 * app whose lib/usage-store.ts no longer reads the legacy shapes. Idempotent:
 * a second run (dry or applied) finds nothing left to do.
 *
 * Reads KV_REST_API_URL / KV_REST_API_TOKEN like every other script here.
 */
import { parseArgs } from "node:util";
import { migrateLegacyData } from "@/lib/migrate-legacy";

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });

  const { plan, summary } = await migrateLegacyData({ apply: values.apply });

  console.log(`Plan (${values.apply ? "applying" : "dry run"}):`);
  let anything = false;
  for (const event of plan.events) {
    if (event.action === "skip") continue;
    anything = true;
    console.log(
      `  usage:events:${event.groupId}  →  ${event.action === "rename" ? "rename to" : "merge into"} usage:events:deepseek:${event.groupId}`,
    );
  }
  for (const machine of plan.machines) {
    if (machine.action === "skip") continue;
    anything = true;
    console.log(`  usage:machines field "${machine.field}"  →  "deepseek:${machine.field}"`);
  }
  if (!anything) console.log("  nothing to do");

  console.log(
    `${values.apply ? "Applied" : "Would apply"}: ${summary.renamed} renamed, ${summary.merged} merged, ` +
      `${summary.machinesMoved} machine field(s) moved, ${summary.skipped} already migrated / nothing to do.`,
  );
  if (!values.apply) console.log("Dry run: nothing written. Pass --apply to perform the migration.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("Migration failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });

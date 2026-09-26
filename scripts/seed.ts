/**
 * Fills the configured store with the synthetic demo dataset.
 *
 *   npm run seed                 add the dataset (a second run stores nothing new: every report is a duplicate)
 *   npm run seed -- --reset      wipe the usage data first (sessions and the stored API token stay)
 *   npm run seed -- --now=2026-09-23T12:00:00Z --seed=7
 *   npm run seed -- --dry-run    build the dataset and print its size, write nothing
 *
 * Reads KV_REST_API_URL / KV_REST_API_TOKEN (or USAGE_STORE=memory, which is
 * pointless here: the memory store dies with the process). Refuses to run
 * against a Vercel production deployment unless told --i-know-this-is-production.
 */
import { parseArgs } from "node:util";
import { getConfig } from "@/lib/config";
import { DEMO_SEED } from "@/lib/demo/dataset";
import { demoDatasetFor, seedStore } from "@/lib/demo/seed";
import { storageKind } from "@/lib/redis";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      reset: { type: "boolean", default: false },
      now: { type: "string" },
      seed: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "i-know-this-is-production": { type: "boolean", default: false },
    },
  });

  if (process.env.VERCEL_ENV === "production" && !values["i-know-this-is-production"]) {
    console.error("Refusing to seed a production deployment. Pass --i-know-this-is-production to override.");
    return 2;
  }

  const now = values.now ? new Date(values.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    console.error(`--now is not a date: ${values.now}`);
    return 2;
  }
  const seed = values.seed === undefined ? DEMO_SEED : Number(values.seed);
  if (!Number.isInteger(seed)) {
    console.error(`--seed is not an integer: ${values.seed}`);
    return 2;
  }

  const dataset = demoDatasetFor(now, seed);
  const bytes = dataset.reports.reduce((sum, report) => sum + Buffer.byteLength(JSON.stringify(report.body)), 0);
  console.log(
    `Dataset at ${now.toISOString()} (seed ${seed}, ${dataset.timeZone}): ${dataset.reports.length} reports, ` +
      `${Math.round(bytes / 1024)} KB, ${dataset.official.length} official figures; store: ${storageKind()} ` +
      `(${process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? "not configured"})`,
  );

  try {
    const summary = await seedStore({ now, wipe: values.reset, dryRun: values["dry-run"], dataset });
    if (values["dry-run"]) {
      console.log("Dry run: nothing written.");
      return 0;
    }
    console.log(
      `Wiped ${summary.wiped} keys, stored ${summary.stored} reports (${summary.duplicates} already there), ` +
        `${summary.official} official figures.`,
    );
    if (summary.invalid.length > 0) {
      console.error(`${summary.invalid.length} reports were refused:\n  ${summary.invalid.join("\n  ")}`);
      return 1;
    }
    console.log(`Cycle: ${dataset.cycles.current.start.toISOString()} → ${dataset.cycles.current.end.toISOString()}`);
    console.log(`Open the dashboard and sign in with DASHBOARD_PIN (${getConfig().reset.timeZone}).`);
    return 0;
  } catch (error) {
    console.error("Seeding failed:", error instanceof Error ? error.message : error);
    console.error(
      "Is the store up? Local Redis: `npm run redis:up`, then KV_REST_API_URL=http://localhost:8079 in .env.local.",
    );
    return 1;
  }
}

main().then((code) => process.exit(code));

/**
 * Restores a backup file (npm run backup) into the configured store.
 *
 *   npm run restore -- backup.json                      dry run: what would be written, nothing is
 *   npm run restore -- backup.json --apply              write every key that does not exist yet
 *   npm run restore -- backup.json --only='usage:settings' --only='usage:events:claude:*' --apply
 *   npm run restore -- backup.json --only=usage:groups --apply --force   replace the existing key
 *
 * `--only` takes an exact key, or a prefix ending in `*`; repeat it. A key that exists is skipped
 * unless --force. TTLs are restored as the instant they ran out (a key already expired is skipped).
 * Reads KV_REST_API_URL / KV_REST_API_TOKEN, and needs a read-write token. Always dry-run first and
 * check the host it prints. See docs/runbooks.md.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { getRedis } from "@/lib/redis";
import { countByType, parseBackup, restoreBackup } from "@/lib/store-backup";

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      only: { type: "string", multiple: true, default: [] },
    },
    allowPositionals: true,
  });
  const [file] = positionals;
  if (!file) {
    console.error("Usage: npm run restore -- <backup.json> [--only=<key|prefix*>]… [--apply] [--force]");
    return 2;
  }
  const backup = parseBackup(readFileSync(file, "utf8"));
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "(not configured)";
  console.log(
    `Backup ${backup.takenAt}: ${Object.keys(backup.keys).length} keys ${JSON.stringify(countByType(backup))}\n` +
      `Target ${new URL(url, "http://invalid").host}, ${values.apply ? "APPLYING" : "dry run"}${values.force ? ", force" : ""}`,
  );

  const report = await restoreBackup(getRedis(), backup, {
    only: values.only,
    force: values.force,
    apply: values.apply,
  });
  const verb = values.apply ? "restored" : "would restore";
  console.log(`  ${verb}: ${report.restored.length} (${report.replaced.length} replacing an existing key)`);
  console.log(`  skipped, key exists (use --force): ${report.skippedExisting.length}`);
  console.log(`  skipped, TTL already ran out: ${report.skippedExpired.length}`);
  for (const key of report.restored.slice(0, 20)) console.log(`    ${key}`);
  if (report.restored.length > 20) console.log(`    … and ${report.restored.length - 20} more`);
  if (report.unmatched.length > 0) {
    console.error(`--only matched nothing in the backup: ${report.unmatched.join(", ")}`);
    return 2;
  }
  if (!values.apply) console.log("Dry run: nothing written. Pass --apply to restore.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("Restore failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });

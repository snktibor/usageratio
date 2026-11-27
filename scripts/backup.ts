/**
 * Read-only full backup of the configured store (every key, with its type and TTL) into one JSON file.
 *
 *   npm run backup -- backups/2026-11-27.json
 *   npm run backup -- --stdout > backup.json
 *
 * Reads KV_REST_API_URL / KV_REST_API_TOKEN (UPSTASH_REDIS_REST_* work too); the read-only token is
 * enough. The file holds everything the store holds (sessions, token hashes, webhook URLs): it is
 * written 0600, keep it outside the repository. Restore with `npm run restore`; see docs/runbooks.md.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { getRedis } from "@/lib/redis";
import { countByType, takeBackup } from "@/lib/store-backup";

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: { stdout: { type: "boolean", default: false } },
    allowPositionals: true,
  });
  const [out] = positionals;
  if (!values.stdout && !out) {
    console.error("Usage: npm run backup -- <out.json> | --stdout");
    return 2;
  }
  const backup = await takeBackup(getRedis());
  const text = JSON.stringify(backup);
  if (values.stdout) process.stdout.write(text);
  else writeFileSync(out as string, text, { mode: 0o600 });
  console.error(
    JSON.stringify({ saved: Object.keys(backup.keys).length, dbsize: backup.dbsize, types: countByType(backup) }),
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("Backup failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });

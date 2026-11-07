/**
 * Prepares a single-tenant store for more tenants — see lib/migrate-tenant.ts.
 * Nothing is moved or deleted: the default tenant keeps its keys.
 *
 *   npm run migrate:tenant             dry run: prints the plan, writes nothing
 *   npm run migrate:tenant -- --apply  adds the tenant record, token index entries and registry names
 *
 * Run it (with --apply) before switching an instance to REGISTRATION=invite
 * or open; take a backup of the store first. Idempotent: a second run finds
 * nothing left to add.
 *
 * Reads KV_REST_API_URL / KV_REST_API_TOKEN like every other script here.
 */
import { parseArgs } from "node:util";
import { migrateToTenants } from "@/lib/migrate-tenant";

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });
  const { plan } = await migrateToTenants({ apply: values.apply, now: new Date() });

  console.log(`Plan (${values.apply ? "applying" : "dry run"}):`);
  console.log(`  default tenant record:   ${plan.createTenantRecord ? "create" : "already there"}`);
  console.log(`  tokens to index:         ${plan.tokensToIndex.length}`);
  console.log(`  keys to register:        ${plan.keysToRegister.length}`);
  for (const key of plan.keysToRegister.slice(0, 20)) console.log(`    ${key}`);
  if (plan.keysToRegister.length > 20) console.log(`    … and ${plan.keysToRegister.length - 20} more`);
  if (!values.apply) console.log("Dry run: nothing written. Pass --apply to perform the migration.");
  else console.log("Applied.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("Migration failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });

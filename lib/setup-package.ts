import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CLIENT_SOURCES,
  DEFAULT_API_URL,
  packageFiles,
  packageName,
  renderConfig,
  renderReadme,
  type ClientSources,
  type MachineSettings,
  type SetupMode,
  type SetupOs,
} from "@/lib/setup";
import { createZip } from "@/lib/zip";

/**
 * Server side of the setup packages: reads the client scripts from clients/
 * (next.config.ts traces them into the functions that call this) and zips a
 * package. lib/setup.ts decides what goes in.
 */

export async function loadClientSources(): Promise<ClientSources> {
  const entries = await Promise.all(
    CLIENT_SOURCES.map(async (source) => {
      // Spelled with a literal "clients" so the build traces that folder alone, not the whole project.
      const file = path.join(process.cwd(), "clients", source.slice("clients/".length));
      return [source, await readFile(file, "utf8")] as const;
    }),
  );
  return Object.fromEntries(entries) as ClientSources;
}

const HOST_PATTERN = /^[a-z0-9.-]+(:\d{1,5})?$/i;

function firstValue(header: string | null): string {
  return header?.split(",")[0]?.trim() ?? "";
}

/**
 * The ingest address a new client reports to. In production it is the
 * project's production domain: the deployment-specific *.vercel.app addresses
 * sit behind Vercel Authentication, where every report would bounce with 401.
 * Anywhere else (local development) it is the address the page was opened on.
 */
export function usageEndpoint(
  headers: { get(name: string): string | null },
  env: Record<string, string | undefined> = process.env,
): string {
  const production = env.VERCEL_ENV === "production" ? env.VERCEL_PROJECT_PRODUCTION_URL?.trim() : undefined;
  if (production) return HOST_PATTERN.test(production) ? `https://${production}/api/usage` : DEFAULT_API_URL;

  const host = firstValue(headers.get("x-forwarded-host")) || firstValue(headers.get("host"));
  if (!HOST_PATTERN.test(host)) return DEFAULT_API_URL;
  const forwarded = firstValue(headers.get("x-forwarded-proto"));
  const local = /^(localhost|127\.0\.0\.1)(:|$)/i.test(host);
  const protocol = forwarded === "http" || forwarded === "https" ? forwarded : local ? "http" : "https";
  return `${protocol}://${host}/api/usage`;
}

/**
 * Windows text files get CRLF line ends, which every Windows editor shows
 * properly, and README.txt a byte order mark so Notepad reads its accents.
 */
function forPlatform(os: SetupOs, text: string): string {
  return os === "windows" ? text.replace(/\r?\n/g, "\r\n") : text;
}

export function buildSetupZip(
  os: SetupOs,
  mode: SetupMode,
  settings: MachineSettings,
  sources: ClientSources,
  now: Date = new Date(),
): { fileName: string; bytes: Uint8Array<ArrayBuffer> } {
  const readme = forPlatform(os, renderReadme(os, mode, settings));
  const entries = [
    { name: "README.txt", data: os === "windows" ? `﻿${readme}` : readme, executable: false },
    ...packageFiles(os, mode).map((file) => ({
      name: file.name,
      data: forPlatform(os, file.source ? sources[file.source] : renderConfig(os, settings)),
      executable: os !== "windows" && file.executable,
    })),
  ];
  return { fileName: `${packageName(os, mode)}.zip`, bytes: createZip(entries, now) };
}

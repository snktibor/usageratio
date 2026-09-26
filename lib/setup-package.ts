import { readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { Translator } from "@/lib/i18n";
import {
  CLIENT_SOURCES,
  type ClientSources,
  DEFAULT_API_URL,
  type MachineSettings,
  type OneShotBlobs,
  packageFiles,
  packageName,
  renderConfig,
  renderReadme,
  type SetupMode,
  type SetupOs,
} from "@/lib/setup";
import { createZip } from "@/lib/zip";

/**
 * Server side of the setup packages: reads the client scripts from clients/
 * (next.config.ts traces them into the functions that call this) and zips a
 * package. lib/setup.ts decides what goes in.
 */

async function readClientSources(): Promise<ClientSources> {
  const entries = await Promise.all(
    CLIENT_SOURCES.map(async (source) => {
      // Spelled with a literal "clients" so the build traces that folder alone, not the whole project.
      const file = path.join(process.cwd(), "clients", source.slice("clients/".length));
      return [source, await readFile(file, "utf8")] as const;
    }),
  );
  return Object.fromEntries(entries) as ClientSources;
}

// The scripts only change with a deploy, so one read serves every request; in
// `next dev` they are re-read every time, so an edit shows up without a restart.
let cachedSources: Promise<ClientSources> | null = null;

export function loadClientSources(): Promise<ClientSources> {
  if (process.env.NODE_ENV === "development") return readClientSources();
  return (cachedSources ??= readClientSources());
}

/** Gzipped and in base64, 76 characters a line: what a here-document or here-string carries safely. */
function pack(text: string): string {
  return gzipSync(text, { level: 9 })
    .toString("base64")
    .replace(/.{76}(?=.)/g, "$&\n");
}

// Keyed by the sources object, so a fresh `loadClientSources()` result (only
// possible in `next dev`) gets its own blobs rather than a stale entry.
const blobsBySources = new WeakMap<ClientSources, OneShotBlobs>();

/** The scripts the one-off report unpacks (lib/setup.ts renderOneShot). */
export function oneShotBlobs(sources: ClientSources): OneShotBlobs {
  const cached = blobsBySources.get(sources);
  if (cached) return cached;
  const blobs: OneShotBlobs = {
    parser: pack(sources["clients/shared/ccusage-providers.cjs"]),
    unixCore: pack(sources["clients/shared/report-usage-core.sh"]),
    windowsCore: pack(sources["clients/shared/report-usage-core.ps1"]),
  };
  blobsBySources.set(sources, blobs);
  return blobs;
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
  translate: Translator<"Setup">,
  now: Date = new Date(),
): { fileName: string; bytes: Uint8Array<ArrayBuffer> } {
  const readme = forPlatform(os, renderReadme(os, mode, settings, translate));
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

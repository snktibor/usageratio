import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { type MessageFormatElement, TYPE } from "@formatjs/icu-messageformat-parser";
import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";

/**
 * The message files behind next-intl: every locale must carry the very same
 * keys with the same ICU arguments, and every key must be one the code asks
 * for. The scan below reads the sources, so a key nobody references (or a
 * reference to a key nobody wrote) fails here rather than in a browser.
 */

const ROOT = join(__dirname, "..");
const MESSAGES_DIR = join(ROOT, "messages");
const SOURCE_DIRS = ["app", "components", "lib"];

/**
 * Keys the code does not reference yet: translations prepared for strings
 * that are still hardcoded (see the i18n work in the plan). A key that gets
 * wired up must be taken off this list: the test says so.
 */
const RESERVED_KEYS: string[] = [];

/**
 * Keys reached through a table or a template literal that the scanner cannot
 * follow. Each pattern must match at least one key, or it is stale.
 */
const DYNAMIC_KEY_PATTERNS = [
  /^Setup\.route_(zip|manual|oneShot)$/,
  /^Setup\.mode_(auto|manual)_(windows|macos|linux)$/,
  /^Setup\.runner_(global|npx)_desc$/,
  /^Widgets\.status_(active|late|inactive)$/,
  /^Dashboard\.mode_note_(delta|snapshot|counter)$/,
  // lib/api-token.ts apiTokenStatusNote() hands the key over as data: `t(note.key)`.
  /^Settings\.token_status_(no_key|empty|unreadable|mismatch|stored_matches|stored)$/,
  // lib/setup.ts PackageFile.roleKey: a Setup.role_* key, translated via `t(file.roleKey)`.
  /^Setup\.role_(config|reporter_auto_unix|reporter_manual_unix|core|parser|installer_unix_auto|installer_unix_manual|reporter_auto_win|reporter_manual_win|task_installer|installer_win_auto|installer_win_manual|install_cmd)$/,
];

type Messages = Record<string, unknown>;

function flatten(value: unknown, prefix = "", into = new Map<string, string>()): Map<string, string> {
  if (typeof value === "string") {
    into.set(prefix, value);
  } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Messages)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, into);
    }
  } else {
    throw new Error(`${prefix}: messages must be strings or objects, got ${JSON.stringify(value)}`);
  }
  return into;
}

function loadLocales(): Map<string, Map<string, string>> {
  const locales = new Map<string, Map<string, string>>();
  for (const file of readdirSync(MESSAGES_DIR).sort()) {
    if (!file.endsWith(".json")) continue;
    const raw = JSON.parse(readFileSync(join(MESSAGES_DIR, file), "utf8")) as unknown;
    locales.set(file.replace(/\.json$/, ""), flatten(raw));
  }
  return locales;
}

/** The names a message needs from its caller: arguments, plural/select variables and rich-text tags. */
function icuNames(elements: MessageFormatElement[], into = new Set<string>()): Set<string> {
  for (const element of elements) {
    switch (element.type) {
      case TYPE.argument:
      case TYPE.number:
      case TYPE.date:
      case TYPE.time:
        into.add(element.value);
        break;
      case TYPE.select:
      case TYPE.plural:
        into.add(element.value);
        for (const option of Object.values(element.options)) icuNames(option.value, into);
        break;
      case TYPE.tag:
        into.add(`<${element.value}>`);
        icuNames(element.children, into);
        break;
      default:
        break;
    }
  }
  return into;
}

function sourceFiles(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, into);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) into.push(path);
  }
  return into;
}

interface Scan {
  /** `Ns.key` for every literal key the code asks for, with where it was found. */
  literal: Map<string, string[]>;
  /** Patterns derived from template-literal keys such as `` t(`route_${route}`) ``, with where they came from. */
  templates: Map<string, string[]>;
  /** Calls whose namespace could not be worked out. */
  unresolved: string[];
}

const BINDING =
  /\b(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\((?:\s*"([^"]+)"|[^)]*namespace:\s*"([^"]+)")/g;
/** A translator handed in with its type: `translate: Translator<"Setup">` (lib/i18n.ts). */
const TYPED_BINDING = /\b(\w+)\??\s*:\s*Translator<\s*"([^"]+)"\s*>/g;
const LITERAL_CALL = /\b(\w+)(?:\.(?:rich|raw|has|markup))?\(\s*"([^"]+)"/g;
const TEMPLATE_CALL = /\b(\w+)(?:\.(?:rich|raw|has|markup))?\(\s*`([^`]+)`/g;
const TABLE_CALL = /\b(\w+)(?:\.(?:rich|raw|has|markup))?\(\s*([A-Za-z_]\w*)\s*\[/g;

function scanSources(): Scan {
  const scan: Scan = { literal: new Map(), templates: new Map(), unresolved: [] };
  const remember = (map: Map<string, string[]>, key: string, where: string) => {
    map.set(key, [...(map.get(key) ?? []), where]);
  };

  for (const path of SOURCE_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)))) {
    const source = readFileSync(path, "utf8");
    const file = relative(ROOT, path);

    // Which translator variable belongs to which namespace in this file.
    const byName = new Map<string, Set<string>>();
    for (const match of source.matchAll(BINDING)) {
      const [, name, direct, viaOptions] = match;
      const namespace = direct ?? viaOptions;
      if (!name || !namespace) continue;
      byName.set(name, new Set([...(byName.get(name) ?? []), namespace]));
    }
    for (const [, name, namespace] of source.matchAll(TYPED_BINDING)) {
      if (!name || !namespace) continue;
      byName.set(name, new Set([...(byName.get(name) ?? []), namespace]));
    }
    const fileNamespaces = new Set([...byName.values()].flatMap((set) => [...set]));
    const translatorNames = new Set([...byName.keys(), "t"]);

    // An untyped translator parameter is taken to be the file's only namespace.
    const namespaceOf = (name: string, where: string): string | null => {
      const own = byName.get(name);
      if (own?.size === 1) return [...own][0]!;
      if (!own && fileNamespaces.size === 1) return [...fileNamespaces][0]!;
      scan.unresolved.push(`${where}: ${name}(…) binds ${own ? [...own].join("/") : "no"} namespace`);
      return null;
    };
    const lineOf = (index: number) => `${file}:${source.slice(0, index).split("\n").length}`;

    for (const match of source.matchAll(LITERAL_CALL)) {
      const [, name, key] = match;
      if (!name || !key || !translatorNames.has(name)) continue;
      const namespace = namespaceOf(name, lineOf(match.index));
      if (namespace) remember(scan.literal, `${namespace}.${key}`, lineOf(match.index));
    }
    for (const match of source.matchAll(TEMPLATE_CALL)) {
      const [, name, template] = match;
      if (!name || !template || !translatorNames.has(name)) continue;
      const namespace = namespaceOf(name, lineOf(match.index));
      if (!namespace) continue;
      const pattern = `^${namespace.replace(/\./g, "\\.")}\\.${template
        .split(/\$\{[^}]*\}/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^.]+")}$`;
      remember(scan.templates, pattern, lineOf(match.index));
    }
    for (const match of source.matchAll(TABLE_CALL)) {
      const [, name, table] = match;
      if (!name || !table || !translatorNames.has(name)) continue;
      const namespace = namespaceOf(name, lineOf(match.index));
      if (!namespace) continue;
      const definition = new RegExp(`\\bconst\\s+${table}\\b[^=]*=\\s*\\{([^}]*)\\}`).exec(source);
      if (!definition?.[1]) {
        scan.unresolved.push(
          `${lineOf(match.index)}: ${name}(${table}[…]) but no \`const ${table} = { … }\` in the file`,
        );
        continue;
      }
      for (const value of definition[1].matchAll(/:\s*"([^"]+)"/g)) {
        remember(scan.literal, `${namespace}.${value[1]}`, `${file} (${table})`);
      }
    }
  }
  return scan;
}

const locales = loadLocales();
const localeNames = [...locales.keys()];
const en = locales.get("en");

describe("messages/*.json", () => {
  it("has an English file and at least one other locale", () => {
    expect(en).toBeDefined();
    expect(localeNames.length).toBeGreaterThan(1);
  });

  it("carries the same keys in every locale", () => {
    const reference = new Set(en!.keys());
    const problems: string[] = [];
    for (const [locale, messages] of locales) {
      if (locale === "en") continue;
      const keys = new Set(messages.keys());
      for (const key of reference) if (!keys.has(key)) problems.push(`${key} is missing in ${locale}.json`);
      for (const key of keys)
        if (!reference.has(key)) problems.push(`${key} is extra in ${locale}.json (not in en.json)`);
    }
    expect(problems).toEqual([]);
  });

  it("has no empty messages", () => {
    const empty: string[] = [];
    for (const [locale, messages] of locales) {
      for (const [key, value] of messages) if (value.trim() === "") empty.push(`${locale}.json: ${key}`);
    }
    expect(empty).toEqual([]);
  });

  it("parses every message and asks for the same ICU arguments in every locale", () => {
    const problems: string[] = [];
    const referenceNames = new Map<string, Set<string>>();
    for (const [locale, messages] of [["en", en!] as const, ...[...locales].filter(([name]) => name !== "en")]) {
      for (const [key, message] of messages) {
        let names: Set<string>;
        try {
          names = icuNames(new IntlMessageFormat(message, locale).getAst());
        } catch (error) {
          problems.push(`${locale}.json: ${key} does not parse: ${error instanceof Error ? error.message : error}`);
          continue;
        }
        const reference = referenceNames.get(key);
        if (!reference) {
          referenceNames.set(key, names);
        } else if ([...reference].sort().join() !== [...names].sort().join()) {
          problems.push(
            `${key}: en.json uses {${[...reference].sort().join(", ")}}, ${locale}.json uses {${[...names].sort().join(", ")}}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("message keys and the code", () => {
  const scan = scanSources();
  const keys = new Set(en!.keys());
  const matchesDynamic = (key: string) =>
    DYNAMIC_KEY_PATTERNS.some((pattern) => pattern.test(key)) ||
    [...scan.templates.keys()].some((pattern) => new RegExp(pattern).test(key));

  it("can tell the namespace of every translator call", () => {
    expect(scan.unresolved).toEqual([]);
    expect(scan.literal.size).toBeGreaterThan(100);
  });

  it("only asks for keys that exist", () => {
    const missing = [...scan.literal]
      .filter(([key]) => !keys.has(key))
      .map(([key, where]) => `${key} (${where.join(", ")})`);
    expect(missing).toEqual([]);
  });

  it("matches every template-literal key to at least one message", () => {
    const stale = [...scan.templates]
      .filter(([pattern]) => ![...keys].some((key) => new RegExp(pattern).test(key)))
      .map(([pattern, where]) => `${pattern} (${where.join(", ")})`);
    expect(stale).toEqual([]);
  });

  it("keeps DYNAMIC_KEY_PATTERNS and RESERVED_KEYS current", () => {
    const stalePatterns = DYNAMIC_KEY_PATTERNS.filter((pattern) => ![...keys].some((key) => pattern.test(key)));
    expect(stalePatterns.map(String), "patterns matching no key").toEqual([]);

    const gone = RESERVED_KEYS.filter((key) => !keys.has(key));
    expect(gone, "reserved keys that no longer exist").toEqual([]);

    const nowUsed = RESERVED_KEYS.filter((key) => scan.literal.has(key) || matchesDynamic(key));
    expect(nowUsed, "keys the code now uses: remove them from RESERVED_KEYS").toEqual([]);
  });

  it("has no message the code never asks for", () => {
    const unused = [...keys].filter(
      (key) => !scan.literal.has(key) && !matchesDynamic(key) && !RESERVED_KEYS.includes(key),
    );
    expect(unused).toEqual([]);
  });
});

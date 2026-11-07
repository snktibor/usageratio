import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Tripwires for the tenant boundary (lib/tenant.ts):
 *
 * - no key is spelled outside lib/redis-keys.ts: a string or template literal
 *   starting with `usage:` or `t:` anywhere else fails;
 * - a tenant store is only made where a tenant is worked out (the request
 *   guards, the jobs that walk the tenants, the demo seed);
 * - the raw client (`getRedis()`) is only reached for global keys and by the
 *   modules that own them.
 *
 * Comments are skipped: they name keys in backticks all over the codebase.
 */

const ROOT = path.resolve(__dirname, "..");
const SCANNED_DIRS = ["app", "lib", "components", "scripts"];

const KEY_MODULE = "lib/redis-keys.ts";

/** Where a tenant store may be made (`tenantStore(` / `defaultTenantStore(`). */
const STORE_MAKERS = new Set([
  "lib/tenant.ts", // the definition
  "lib/tenant-context.ts", // the session guard
  "lib/api.ts", // the bearer guard
  "lib/housekeeping.ts", // the cron run over every tenant
  "lib/instrumentation-node.ts", // the demo seed at start-up
  "scripts/seed.ts", // npm run seed
]);

/** Who may reach the raw client: global keys only, or the store's own plumbing. */
const RAW_CLIENT_USERS = new Set([
  "lib/redis.ts",
  "lib/tenant.ts",
  "lib/auth.ts",
  "lib/rate-limit.ts",
  "lib/migrate-legacy.ts",
  "lib/demo/seed.ts",
  "app/api/health/route.ts",
]);

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const relative = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(relative);
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(relative);
    }
  };
  for (const dir of SCANNED_DIRS) walk(dir);
  return files.sort();
}

interface CodeToken {
  kind: "string" | "code";
  text: string;
  line: number;
}

/** Characters after which a `/` starts a regular expression rather than a division. */
const REGEX_PRECEDERS = new Set([
  "",
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "~",
  "^",
]);

/**
 * A small TypeScript lexer, just enough to tell code from comments and
 * literals: line and block comments are dropped, string literals and the
 * text of template literals (each part between `${…}`) come out as "string"
 * tokens, everything else as "code". Regular expressions are skipped by the
 * usual heuristic (a `/` after an operator or an opening bracket).
 */
function tokenize(source: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let line = 1;
  let code = "";
  let codeLine = 1;
  let lastSignificant = "";
  /** Open `${` of template literals, by brace depth inside them. */
  const templateDepths: number[] = [];

  const flushCode = () => {
    if (code.trim()) tokens.push({ kind: "code", text: code, line: codeLine });
    code = "";
    codeLine = line;
  };
  const pushString = (text: string, at: number) => tokens.push({ kind: "string", text, line: at });

  const readTemplatePart = (start: number): number => {
    let i = start;
    let text = "";
    const at = line;
    while (i < source.length) {
      const ch = source[i]!;
      if (ch === "\\") {
        text += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === "`") {
        pushString(text, at);
        return i + 1;
      }
      if (ch === "$" && source[i + 1] === "{") {
        pushString(text, at);
        templateDepths.push(0);
        return i + 2;
      }
      if (ch === "\n") line += 1;
      text += ch;
      i += 1;
    }
    pushString(text, at);
    return i;
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      line += (source.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      flushCode();
      const at = line;
      let j = i + 1;
      let text = "";
      while (j < source.length && source[j] !== ch && source[j] !== "\n") {
        if (source[j] === "\\") {
          text += source.slice(j, j + 2);
          j += 2;
        } else {
          text += source[j];
          j += 1;
        }
      }
      pushString(text, at);
      i = j + 1;
      lastSignificant = "a";
      continue;
    }
    if (ch === "`") {
      flushCode();
      i = readTemplatePart(i + 1);
      lastSignificant = "a";
      continue;
    }
    if (templateDepths.length > 0 && (ch === "{" || ch === "}")) {
      const depth = templateDepths.length - 1;
      if (ch === "{") templateDepths[depth]! += 1;
      else if (templateDepths[depth] === 0) {
        templateDepths.pop();
        flushCode();
        i = readTemplatePart(i + 1);
        lastSignificant = "a";
        continue;
      } else templateDepths[depth]! -= 1;
    }
    if (ch === "/" && REGEX_PRECEDERS.has(lastSignificant)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n") {
        const c = source[j]!;
        if (c === "\\") j += 1;
        else if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        j += 1;
      }
      code += source.slice(i, j + 1);
      i = j + 1;
      lastSignificant = "a";
      continue;
    }
    if (ch === "\n") line += 1;
    if (!/\s/.test(ch)) lastSignificant = /[\w$)\]]/.test(ch) ? "a" : ch;
    code += ch;
    i += 1;
  }
  flushCode();
  return tokens;
}

const KEY_LITERAL = /^(usage|t):/;

describe("tokenize", () => {
  it("finds literals in code and ignores them in comments", () => {
    // The source under test, spelled as one template literal (its own backticks and `${` escaped).
    const tokens = tokenize(`// usage:in-a-line-comment
/* \`usage:in-a-block\` */
const a = "usage:double";
const b = 'usage:single';
const c = \`usage:\${x}:template\`;
const d = \`\${p}events:\${q}\`;
const re = /"usage:not-a-string"/;
const e = \`outer \${\`t:nested\`} end\`;`);
    const strings = tokens.filter((token) => token.kind === "string").map((token) => token.text);
    expect(strings).toEqual([
      "usage:double",
      "usage:single",
      "usage:",
      ":template",
      "",
      "events:",
      "",
      "outer ",
      "t:nested",
      " end",
    ]);
    expect(strings.filter((text) => KEY_LITERAL.test(text))).toEqual([
      "usage:double",
      "usage:single",
      "usage:",
      "t:nested",
    ]);
  });
});

describe("the tenant boundary", () => {
  const files = sourceFiles();

  it("spells no Redis key outside lib/redis-keys.ts", () => {
    const offenders = files
      .filter((file) => file !== KEY_MODULE)
      .flatMap((file) =>
        tokenize(readFileSync(path.join(ROOT, file), "utf8"))
          .filter((token) => token.kind === "string" && KEY_LITERAL.test(token.text))
          .map((token) => `${file}:${token.line}: ${token.text}`),
      );
    expect(offenders).toEqual([]);
  });

  it("makes a tenant store only where a tenant is worked out", () => {
    const offenders = files.filter((file) => {
      if (STORE_MAKERS.has(file)) return false;
      const code = tokenize(readFileSync(path.join(ROOT, file), "utf8"))
        .filter((token) => token.kind === "code")
        .map((token) => token.text)
        .join(" ");
      return /\b(tenantStore|defaultTenantStore)\(/.test(code);
    });
    expect(offenders).toEqual([]);
  });

  it("reaches the raw client only for global keys", () => {
    const offenders = files.filter((file) => {
      if (RAW_CLIENT_USERS.has(file)) return false;
      const code = tokenize(readFileSync(path.join(ROOT, file), "utf8"))
        .filter((token) => token.kind === "code")
        .map((token) => token.text)
        .join(" ");
      return /\bgetRedis\(/.test(code);
    });
    expect(offenders).toEqual([]);
  });
});

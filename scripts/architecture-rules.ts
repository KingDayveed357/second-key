// Import rules that make the capture-isolation invariant structural (architecture §2, ADR-0005).
// A tiny static checker: dependency-cruiser cannot parse TypeScript 7 yet, and a rule that
// silently passes is worse than none. Covered by test-support/architecture.test.ts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface Violation {
  rule: string;
  file: string;
  specifier: string;
}

interface Rule {
  name: string;
  /** Files the rule applies to (repo-relative, forward slashes). */
  from: RegExp;
  /** Unless the importing file also matches this. */
  fromNot?: RegExp;
  /** Import specifiers (bare or resolved-relative) that are forbidden. */
  to: RegExp;
}

export const RULES: Rule[] = [
  { name: "money-movement-only-in-executor", from: /^/, fromNot: /^packages\/(executor|paypal)\//, to: /^@witness\/paypal\/money-movement$|money-movement(\.ts)?$/ },
  { name: "executor-only-in-worker", from: /^/, fromNot: /^(apps\/worker|packages\/executor)\//, to: /^@witness\/executor(\/|$)/ },
  { name: "core-is-pure", from: /^packages\/core\//, to: /^@witness\/|^(pg|pg-boss|fastify|drizzle-orm)(\/|$)|^node:(net|http|https|dgram|child_process|fs)$/ },
  // The AP2 verifier decides on bytes alone: no database, network, files or other Witness code.
  { name: "ap2-is-pure", from: /^packages\/ap2\//, to: /^@witness\/|^(pg|pg-boss|fastify|drizzle-orm)(\/|$)|^node:(net|http|https|dgram|child_process|fs)$/ },
  { name: "web-never-touches-paypal-or-db", from: /^apps\/web\//, to: /^@witness\/(paypal|db|executor)(\/|$)|^pg(\/|$)/ },
  { name: "ai-has-no-money-access", from: /^packages\/ai\//, to: /^@witness\/(paypal|db|executor|engine)(\/|$)|^(pg|pg-boss)(\/|$)/ },
  { name: "agent-is-an-outsider", from: /^apps\/agent\//, to: /^@witness\/|^(pg|pg-boss)(\/|$)/ },
  { name: "api-has-no-job-consumers", from: /^apps\/api\//, to: /^@witness\/worker(\/|$)/ },
];

const IMPORT = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;

export function importsOf(source: string): string[] {
  const out: string[] = [];
  // Strip comments so commented-out imports don't count either way.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const m of code.matchAll(IMPORT)) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}

function* tsFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsFiles(p);
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.d\.ts$/.test(name)) yield p;
  }
}

export function checkFiles(root: string, files: Iterable<string>): Violation[] {
  const v: Violation[] = [];
  for (const abs of files) {
    const file = relative(root, abs).split(sep).join("/");
    // Tests may reach across boundaries to prove things; production code may not.
    if (/(^|\/)test\//.test(file) || /\.test\.ts$/.test(file)) continue;
    const specs = importsOf(readFileSync(abs, "utf8"));
    for (const rule of RULES) {
      if (!rule.from.test(file) || rule.fromNot?.test(file)) continue;
      for (const s of specs) if (rule.to.test(s)) v.push({ rule: rule.name, file, specifier: s });
    }
  }
  return v;
}

export function checkRepo(root: string): Violation[] {
  const files = [...tsFiles(join(root, "apps")), ...tsFiles(join(root, "packages"))];
  return checkFiles(root, files);
}

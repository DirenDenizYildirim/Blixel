// Path rules for agents: where each one may edit, and which files always need
// the user's approval. Patterns follow .gitignore: `*` stays inside one folder,
// `**` crosses folders, a trailing `/` means a folder, `!` excludes, and the
// last matching line wins.

import PROTECTED from "./protected-paths.json";

interface Rule {
  negate: boolean;
  re: RegExp;
}

function toRegExp(pattern: string): RegExp {
  let p = pattern;
  const anchored = p.startsWith("/") || p.slice(0, -1).includes("/");
  p = p.replace(/^\//, "");
  const folder = p.endsWith("/");
  p = p.replace(/\/$/, "");
  let body = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      body += ".*";
      i++;
      if (p[i + 1] === "/") i++;
    } else if (c === "*") body += "[^/]*";
    else if (c === "?") body += "[^/]";
    else body += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const prefix = anchored ? "^" : "(^|.*/)";
  // A pattern that names a folder also covers everything inside it.
  const suffix = folder ? "/.*$" : "(/.*)?$";
  return new RegExp(prefix + body + suffix);
}

export function parseRules(text: string): Rule[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const negate = line.startsWith("!");
      return { negate, re: toRegExp(negate ? line.slice(1) : line) };
    });
}

/** Whether an agent with these edit patterns may edit `path`. No patterns: anywhere. */
export function mayEdit(path: string, patterns: string): boolean {
  const rules = parseRules(patterns);
  let allowed = !rules.some((r) => !r.negate);
  for (const rule of rules) if (rule.re.test(path)) allowed = !rule.negate;
  return allowed;
}

/**
 * Agent settings and instruction files, and git's own folder (its hooks run
 * code): any change to them goes to the user first. The list is shared with
 * the core (src-tauri/src/rules.rs), and so is this way of matching it: a
 * folder anywhere in the path, or the file's own name.
 */
export function isProtected(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  return parts.some((part, i) => (i < parts.length - 1 ? PROTECTED.folders : PROTECTED.files).includes(part));
}

/** The protected folders and files, for the settings page. */
export const PROTECTED_NAMES = [...PROTECTED.folders.map((f) => f + "/"), ...PROTECTED.files];

/** The patterns as one line for summaries, or null for the whole project. */
export function describeArea(patterns: string): string | null {
  const lines = patterns
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  return lines.length ? lines.join(", ") : null;
}

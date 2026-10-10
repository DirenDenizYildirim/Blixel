// Ready-made connectors for services agents often need, plus a custom one.
// Each template asks only for what it needs (a token, mostly) and builds the
// transport from it. A token becomes a whole header value ("Bearer <token>")
// before it is stored, so the core sends the header as it is. Addresses and
// headers were checked against each service's own documentation in
// October 2026. There are no file or web templates: the app's own tools cover those.

import { APP_NAME } from "../brand";
import type { Connector, ConnectorTransport, ConnectorVar } from "../model/types";
import type { IconKind } from "./pixel-icons";

export type FieldValues = Record<string, string | boolean>;

export interface TemplateField {
  key: string;
  label: string;
  /** A secret goes to the keychain; a switch changes what the connector is given. */
  kind: "secret" | "switch";
  placeholder?: string;
  hint?: string;
  optional?: boolean;
}

/** A transport and the values of its secrets, by variable name. A secret left out keeps its stored value. */
export interface Built {
  transport: ConnectorTransport;
  secrets: Record<string, string>;
}

export interface ConnectorTemplate {
  id: string;
  name: string;
  blurb: string;
  icon: IconKind;
  hue: number;
  /** What it needs on this computer, if anything. */
  needs?: string;
  fields: TemplateField[];
  /** `before` is the saved transport when editing. */
  build(values: FieldValues, before: ConnectorTransport | null): Built;
  /** Its switches as they are in a saved transport. */
  read(transport: ConnectorTransport): FieldValues;
}

const text = (v: string | boolean | undefined) => (typeof v === "string" ? v.trim() : "");

/** A remote server reached with a token in one header, composed as `prefix + token`. */
function remote(opts: {
  url: string;
  readOnlyUrl?: string;
  header: string;
  prefix: string;
  tokenOptional?: boolean;
}): Pick<ConnectorTemplate, "build" | "read"> {
  return {
    build(values, before) {
      const token = text(values.token);
      const url = values.readOnly && opts.readOnlyUrl ? opts.readOnlyUrl : opts.url;
      const had = before?.kind === "url" && before.headers.some((h) => h.name === opts.header && h.secret);
      // An optional token left empty keeps the stored one, or means no header at all.
      const headers: ConnectorVar[] = token || had || !opts.tokenOptional ? [{ name: opts.header, value: "", secret: true }] : [];
      return { transport: { kind: "url", url, headers }, secrets: token ? { [opts.header]: opts.prefix + token } : {} };
    },
    read: (t) => ({ readOnly: Boolean(opts.readOnlyUrl) && t.kind === "url" && t.url === opts.readOnlyUrl }),
  };
}

/** A server started on this computer with npx. */
function local(args: string[], env?: { name: string; field: string }): Pick<ConnectorTemplate, "build" | "read"> {
  return {
    build(values) {
      const value = text(values[env?.field ?? ""]);
      return {
        transport: { kind: "command", command: "npx", args, env: env ? [{ name: env.name, value: "", secret: true }] : [] },
        secrets: env && value ? { [env.name]: value } : {},
      };
    },
    read: () => ({}),
  };
}

const READ_ONLY = (what: string): TemplateField => ({
  key: "readOnly",
  label: "Read only",
  kind: "switch",
  hint: `Agents can look at ${what} but not change anything there.`,
});

export const TEMPLATES: ConnectorTemplate[] = [
  {
    id: "github",
    name: "GitHub",
    blurb: "Issues, pull requests, code and reviews",
    icon: "branch",
    hue: 290,
    fields: [
      {
        key: "token",
        label: "Personal access token",
        kind: "secret",
        placeholder: "github_pat_…",
        hint: "Made in GitHub's developer settings. A fine-grained token limited to the repositories agents need is safest.",
      },
      READ_ONLY("repositories, issues and pull requests"),
    ],
    ...remote({
      url: "https://api.githubcopilot.com/mcp/",
      readOnlyUrl: "https://api.githubcopilot.com/mcp/readonly",
      header: "Authorization",
      prefix: "Bearer ",
    }),
  },
  {
    id: "linear",
    name: "Linear",
    blurb: "Issues, projects and cycles",
    icon: "ticket",
    hue: 255,
    fields: [
      { key: "token", label: "API key", kind: "secret", placeholder: "lin_api_…", hint: "A personal API key from Linear's settings." },
      READ_ONLY("issues and projects"),
    ],
    ...remote({
      url: "https://mcp.linear.app/mcp",
      readOnlyUrl: "https://mcp.linear.app/mcp/readonly",
      header: "Authorization",
      prefix: "Bearer ",
    }),
  },
  {
    id: "sentry",
    name: "Sentry",
    blurb: "Errors, crashes and their traces",
    icon: "bug",
    hue: 15,
    fields: [{ key: "token", label: "Auth token", kind: "secret", placeholder: "sntryu_…", hint: "A user auth token from Sentry's settings." }],
    ...remote({ url: "https://mcp.sentry.dev/mcp", header: "Authorization", prefix: "Sentry-Bearer " }),
  },
  {
    id: "context7",
    name: "Context7",
    blurb: "Current documentation for libraries",
    icon: "book",
    hue: 160,
    fields: [
      {
        key: "token",
        label: "API key",
        kind: "secret",
        optional: true,
        placeholder: "Optional",
        hint: "It works without one, with lower limits.",
      },
    ],
    ...remote({ url: "https://mcp.context7.com/mcp", header: "Authorization", prefix: "Bearer ", tokenOptional: true }),
  },
  {
    id: "postgres",
    name: "Postgres",
    blurb: "Query Postgres and other SQL databases, through DBHub",
    icon: "database",
    hue: 215,
    needs: "Node.js, to run it with npx",
    fields: [
      {
        key: "dsn",
        label: "Connection string",
        kind: "secret",
        placeholder: "postgres://user:password@localhost:5432/app",
        hint: "Also MySQL, MariaDB, SQL Server or SQLite. A database user that may only read is safest.",
      },
    ],
    ...local(["@bytebase/dbhub@latest", "--transport", "stdio"], { name: "DSN", field: "dsn" }),
  },
  {
    id: "playwright",
    name: "Playwright",
    blurb: "A browser agents can drive: open pages, click, read them",
    icon: "browser",
    hue: 90,
    needs: "Node.js, to run it with npx; it downloads a browser the first time",
    fields: [],
    ...local(["@playwright/mcp@latest", "--headless", "--isolated"]),
  },
];

export const CUSTOM = { id: "custom", name: "Custom", blurb: "Any MCP server, by command or address", icon: "plug" as IconKind, hue: 50 };

export const templateById = (id: string | null) => TEMPLATES.find((t) => t.id === id);

// ---- Slugs: the name a connector's tools reach agents under ----

export const SLUG_RULE = /^[a-z][a-z0-9-]{0,23}$/;

/** Names the app's own tool servers and the agent programs use. */
const RESERVED = new Set([APP_NAME.toLowerCase(), "workspace", "computer-use", "ide"]);

/** Why a slug cannot be used, or null. */
export function slugProblem(slug: string, others: Connector[]): string | null {
  if (!slug) return "Give it a short name for its tools.";
  if (!SLUG_RULE.test(slug)) return "Use lowercase letters, digits and dashes, starting with a letter, at most 24.";
  if (RESERVED.has(slug) || slug.startsWith("claude")) return "That name is taken by the app or the agents' programs.";
  if (others.some((c) => c.slug === slug)) return "Another connector has this name.";
  return null;
}

/** A free slug made from a name: "My Tracker" becomes "my-tracker", or "my-tracker-2" if taken. */
export function freeSlug(name: string, others: Connector[]): string {
  let base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 21)
    .replace(/-+$/, "");
  if (!base || slugProblem(base, []) !== null) base = "connector";
  const taken = new Set(others.map((c) => c.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

// ---- Arguments, written on one line ----

/** Splits a command line into arguments, keeping quoted parts together. */
export function splitArgs(line: string): string[] {
  const args: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) args.push(m[1]?.replace(/\\(.)/g, "$1") ?? m[2] ?? m[3]);
  return args;
}

export function joinArgs(args: string[]): string {
  return args.map((a) => (a === "" || /[\s"']/.test(a) ? `"${a.replace(/(["\\])/g, "\\$1")}"` : a)).join(" ");
}

/** Where a connector runs, in a few words: the address's host, or the command. */
export function whereItRuns(t: ConnectorTransport): string {
  if (t.kind === "command") return [t.command, t.args.find((a) => !a.startsWith("-")) ?? ""].join(" ").trim();
  try {
    return new URL(t.url).host;
  } catch {
    return t.url;
  }
}

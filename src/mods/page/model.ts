// What the Mods page shows about one mod: whether it runs, what it adds and
// asks for, and whether it needs the user. Shared by the cards, the filter
// and the counts, so they always agree.

import { hasCode, isActive } from "../registry";
import type { Capability, Manifest, ModRecord, ThemeContribution } from "../types";

export type Tone = "on" | "off" | "warn" | "error";

export interface ModFacts {
  name: string;
  on: boolean;
  /** Approved before (it may since have changed or failed). */
  approved: boolean;
  /** Its files changed since the user approved it, so it stays off until approved again. */
  changed: boolean;
  /** What it asks for now. */
  asks: Capability[];
  /** What it asks for beyond what was granted. */
  newAsks: Capability[];
  asksMore: boolean;
  code: boolean;
  status: { text: string; tone: Tone };
  /** Changed, failing, or asking for more than was approved. */
  needsYou: boolean;
}

export function modFacts(mod: ModRecord, errors: string[]): ModFacts {
  const m = mod.manifest;
  const asks: Capability[] = m?.permissions ?? [];
  const on = isActive(mod);
  // Approved before, but not running as approved: its files changed (the core
  // then reports it off until it is approved again), or it asks for more than
  // was granted.
  const approved = mod.enabled || mod.changed;
  const changed = mod.changed && !mod.dev && !mod.error;
  const newAsks = approved ? asks.filter((c) => !mod.granted.includes(c)) : [];
  const asksMore = !mod.error && newAsks.length > 0;

  let status: ModFacts["status"];
  if (mod.builtin && !mod.error) status = { text: "Always on", tone: "on" };
  else if (mod.error) status = { text: "Problem", tone: "error" };
  else if (changed) status = { text: "Changed — approve again", tone: "warn" };
  else if (asksMore) status = { text: "Asks for more", tone: "warn" };
  else if (on) status = { text: "On", tone: "on" };
  else status = { text: "Off", tone: "off" };

  return {
    name: m?.name ?? mod.id,
    on,
    approved,
    changed,
    asks,
    newAsks,
    asksMore,
    code: hasCode(mod),
    status,
    needsYou: Boolean(mod.error) || changed || asksMore || errors.length > 0,
  };
}

export interface Addition {
  key: string;
  text: string;
  /** The names of what it adds, for the tooltip. */
  names: string[];
  themes?: ThemeContribution[];
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a mod adds, in the order the page lists them. */
export function additions(m: Manifest | null): Addition[] {
  const c = m?.contributes;
  if (!c) return [];
  const out: Addition[] = [];
  if (c.themes?.length) {
    out.push({ key: "themes", text: count(c.themes.length, "theme", "themes"), names: c.themes.map((t) => t.label), themes: c.themes });
  }
  if (c.layouts?.length) out.push({ key: "layouts", text: count(c.layouts.length, "layout", "layouts"), names: c.layouts.map((l) => l.label) });
  if (c.rulePacks?.length) {
    out.push({ key: "rulePacks", text: count(c.rulePacks.length, "rule pack", "rule packs"), names: c.rulePacks.map((p) => p.label) });
  }
  if (c.commands?.length) {
    out.push({
      key: "commands",
      text: count(c.commands.length, "command", "commands"),
      names: c.commands.map((k) => (k.key ? `${k.title} (${k.key})` : k.title)),
    });
  }
  if (c.views?.length) out.push({ key: "views", text: count(c.views.length, "panel", "panels"), names: c.views.map((v) => v.title) });
  return out;
}

export type Filter = "all" | "on" | "off" | "needs";

/** Whether a mod matches the filter text: its name, id, author or description. */
export function matchesText(mod: ModRecord, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const m = mod.manifest;
  return [mod.id, m?.name, m?.author, m?.description].some((s) => s?.toLowerCase().includes(q));
}

export function matchesFilter(facts: ModFacts, filter: Filter): boolean {
  if (filter === "on") return facts.on;
  if (filter === "off") return !facts.on;
  if (filter === "needs") return facts.needsYou;
  return true;
}

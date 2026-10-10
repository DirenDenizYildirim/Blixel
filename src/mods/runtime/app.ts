// What mods may see of the app, read from its stores: the theme's colours and
// a summary of each agent. Only what the host API documents; never chats,
// settings or keys.

import { hueOf } from "../../model/store";
import type { Agent, Presence } from "../../model/types";
import { token } from "../../theme/theme";
import { THEME_NUMBERS, THEME_TOKENS } from "../types";

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

/** The theme as views receive it: each token's value, and whether it is a light theme. */
export type ThemeSnapshot = { tokens: Record<string, string>; light: boolean };

/** The live theme, read from the CSS variables on the root element, so mod themes are covered too. */
export function themeSnapshot(): ThemeSnapshot {
  const tokens: Record<string, string> = {};
  for (const name of [...THEME_TOKENS, ...THEME_NUMBERS]) tokens[name] = token(kebab(name));
  const scheme = getComputedStyle(document.documentElement).colorScheme;
  return { tokens, light: scheme.split(" ")[0] === "light" };
}

/** An agent as `host.agents` shows it, with the statuses the host API documents. */
export type AgentInfo = { id: string; name: string; hue: number; status: Exclude<Agent["status"], "limited">; file: string | null };

export function agentInfo(agent: Agent, presence: Record<string, Presence>): AgentInfo {
  return {
    id: agent.id,
    name: agent.name,
    hue: Math.round(hueOf(agent) * 10) / 10,
    // An agent at its spending limit is idle as far as mods know: what it spends is not theirs to see.
    status: agent.status === "limited" ? "idle" : agent.status,
    file: presence[agent.id]?.path ?? null,
  };
}

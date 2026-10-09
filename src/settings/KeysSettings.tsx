// Every command that has a key, grouped by the start of its title. Read only for now.

import { useMemo, useState } from "react";
import { formatKey } from "../commands/keynames";
import { keyBindings } from "../commands/keys";
import { useCommands, type Command } from "../commands/registry";
import { modName } from "../mods/registry";
import { Keycaps } from "./Keycaps";

/** The app's own groups in this order; any others (mods') follow by name. */
const ORDER = ["Layout", "Editor", "Commands", "Settings", "Mods", "Theme"];

interface Row {
  command: Command;
  name: string;
  /** The mod's name for a mod's command; empty for the app's own. */
  source: string;
  key: string;
}

/** Who provides a command: a mod's own command (`mod:<mod id>:...`) always names its mod. */
function sourceOf(command: Command): string {
  const own = /^mod:([^:]+):/.exec(command.id);
  const mod = own ? own[1] : command.source === "core" ? null : command.source;
  return mod ? modName(mod) : "";
}

function groupsOf(commands: Record<string, Command>): [string, Row[]][] {
  const keys = keyBindings().byCommand;
  const groups = new Map<string, Row[]>();
  for (const command of Object.values(commands)) {
    const key = keys.get(command.id);
    if (!key) continue;
    const at = command.title.indexOf(": ");
    const group = at > 0 ? command.title.slice(0, at) : "Other";
    const row = { command, name: at > 0 ? command.title.slice(at + 2) : command.title, source: sourceOf(command), key };
    groups.set(group, [...(groups.get(group) ?? []), row]);
  }
  const rank = (g: string) => (ORDER.includes(g) ? ORDER.indexOf(g) : ORDER.length);
  return [...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

export function KeysSettings() {
  const commands = useCommands();
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupsOf(commands), [commands]);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = groups
    .map(([group, rows]): [string, Row[]] => [
      group,
      rows.filter((r) => {
        const text = `${group} ${r.name} ${r.source} ${r.key} ${formatKey(r.key)}`.toLowerCase();
        return terms.every((t) => text.includes(t));
      }),
    ])
    .filter(([, rows]) => rows.length);

  return (
    <section id="settings-keys" aria-labelledby="settings-keys-title" className="panel">
      <h2 id="settings-keys-title" className="tight">
        Keys
      </h2>
      <div className="hint-line">Every command with a key. Changing keys comes later; all commands are in the palette.</div>
      <input
        className="input keys-filter"
        type="search"
        aria-label="Filter keys"
        placeholder="Filter by name or key"
        spellCheck={false}
        autoComplete="off"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {shown.map(([group, rows]) => (
        <div key={group} className="keys-group">
          <h3>{group}</h3>
          {rows.map((r) => (
            <div key={r.command.id} className="keys-row">
              <span className="grow min0">
                {r.name}
                {r.source && <span className="label"> from {r.source}</span>}
              </span>
              <Keycaps keys={r.key} />
            </div>
          ))}
        </div>
      ))}
      {!shown.length && <div className="keys-empty label">No key matches “{query.trim()}”.</div>}
    </section>
  );
}

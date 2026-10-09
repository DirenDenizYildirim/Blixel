// The command palette: every command by name, with its source and key. It
// lives in its own React root so it can open over any page.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyEvent } from "react";
import { createRoot } from "react-dom/client";
import { create } from "zustand";
import { modName } from "../mods/registry";
import { notify } from "../model/store";
import { formatKey } from "./keynames";
import { keyBindings } from "./keys";
import { runCommand, useCommands, type Command } from "./registry";
import "./palette.css";

const usePalette = create<{ open: boolean }>(() => ({ open: false }));

/** Where focus was before the palette opened, to give it back on close. */
let returnFocus: HTMLElement | null = null;

export function openPalette() {
  if (usePalette.getState().open) return;
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  usePalette.setState({ open: true });
}

export function closePalette() {
  if (!usePalette.getState().open) return;
  usePalette.setState({ open: false });
  returnFocus?.focus();
  returnFocus = null;
}

interface Entry {
  command: Command;
  /** The mod's name for a mod's command; empty for built-in ones. */
  source: string;
  key: string;
}

/**
 * Who provides a command, as shown: nothing for the app's own, the mod's name
 * otherwise. A mod's own command (`mod:<mod id>:...`) always names its mod.
 */
function sourceOf(command: Command): string {
  const own = /^mod:([^:]+):/.exec(command.id);
  const mod = own ? own[1] : command.source === "core" ? null : command.source;
  return mod ? modName(mod) : "";
}

/** Every term must appear in the title or source; titles that start with the query come first. */
function filter(entries: Entry[], query: string): Entry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  const terms = q.split(/\s+/);
  return entries
    .map((e) => ({ e, text: `${e.command.title} ${e.source}`.toLowerCase(), title: e.command.title.toLowerCase() }))
    .filter(({ text }) => terms.every((t) => text.includes(t)))
    .sort((a, b) => Number(b.title.startsWith(q)) - Number(a.title.startsWith(q)) || a.title.indexOf(terms[0]) - b.title.indexOf(terms[0]))
    .map(({ e }) => e);
}

function PaletteCard() {
  const commands = useCommands();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  // Whether a command applies is read when the palette opens and as commands change.
  const entries = useMemo((): Entry[] => {
    const keys = keyBindings().byCommand;
    return Object.values(commands)
      .filter((c) => !c.hidden?.())
      .map((command) => ({
        command,
        source: sourceOf(command),
        key: keys.get(command.id) ?? "",
      }))
      .sort((a, b) => a.command.title.localeCompare(b.command.title));
  }, [commands]);
  const shown = useMemo(() => filter(entries, query), [entries, query]);
  const current = Math.min(active, Math.max(0, shown.length - 1));

  useEffect(() => input.current?.focus(), []);
  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const run = (entry: Entry | undefined) => {
    if (!entry) return;
    closePalette();
    runCommand(entry.command.id).catch((e) => notify(e instanceof Error ? e.message : String(e)));
  };

  const onKeyDown = (e: ReactKeyEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + shown.length) % shown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(shown[current]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    } else if (e.key === "Tab") {
      // Focus stays in the filter; the list is reached with the arrow keys.
      e.preventDefault();
    }
  };

  const optionId = (i: number) => `palette-option-${i}`;
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closePalette()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Commands" onKeyDown={onKeyDown}>
        <input
          ref={input}
          className="palette-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={shown.length ? optionId(current) : undefined}
          aria-label="Type a command"
          placeholder="Type a command"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
        <ul ref={list} id="palette-list" className="palette-list" role="listbox" aria-label="Commands">
          {shown.map((entry, i) => (
            <li
              key={entry.command.id}
              id={optionId(i)}
              data-index={i}
              role="option"
              aria-selected={i === current}
              className="palette-item"
              onMouseMove={() => i !== current && setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(entry)}
            >
              <span className="palette-title ellipsis">{entry.command.title}</span>
              {entry.source && <span className="palette-source ellipsis">{entry.source}</span>}
              {entry.key && <kbd className="palette-key">{formatKey(entry.key)}</kbd>}
            </li>
          ))}
          {!shown.length && <li className="palette-empty">No matching commands</li>}
        </ul>
      </div>
    </div>
  );
}

function Palette() {
  const open = usePalette((s) => s.open);
  return open ? <PaletteCard /> : null;
}

/** Puts the palette in its own root at the end of the page. Call once, at start. */
export function mountPalette() {
  const host = document.createElement("div");
  host.id = "palette-root";
  document.body.appendChild(host);
  createRoot(host).render(<Palette />);
}

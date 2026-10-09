// One key listener for every command's key. Built-in keys are caught before
// anything else sees them (capture phase), so Ctrl+S or Ctrl+B work while the
// editor or a text field has focus; keys without a command pass through, so
// the editor's own keys (Ctrl+Z, Ctrl+F...) keep working. A mod's keys come
// last (bubble phase), only when nothing else used the key: they need Ctrl or
// Alt (or are function keys), never take a standard editing key, and in a
// text field or the editor only work with Ctrl, since Alt there may type a
// character.

import { notify } from "../model/store";
import { eventKey, normalizeKey } from "./keynames";
import { runCommand, useCommands, type Command } from "./registry";

/** Editing keys a mod may not take, whatever it declares. */
const RESERVED = new Set(
  ["Ctrl+A", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+Z", "Ctrl+Shift+Z", "Ctrl+Y", "Ctrl+F", "Ctrl+Q", "Ctrl+W", "Ctrl+R"],
);
const NAVIGATION = /(?:^|\+)(?:Arrow\w+|Backspace|Delete|Home|End|PageUp|PageDown|Enter|Tab|Escape|Space|Insert)$/;

const modMayUse = (key: string) =>
  !RESERVED.has(key) && !NAVIGATION.test(key) && (/^(?:Ctrl|Alt)\+/.test(key) || /(?:^|\+)F\d+$/.test(key));

interface Bindings {
  core: Map<string, Command>;
  mods: Map<string, Command>;
  /** The key that runs each command, by command id: what the palette shows. */
  byCommand: Map<string, string>;
}

let cache: { commands: Record<string, Command>; bindings: Bindings } | null = null;

/** Which key runs which command. Built-in commands win; among mods, the first registered. */
export function keyBindings(): Bindings {
  const commands = useCommands.getState();
  if (cache?.commands === commands) return cache.bindings;
  const bindings: Bindings = { core: new Map(), mods: new Map(), byCommand: new Map() };
  const all = Object.values(commands);
  for (const command of all) {
    const key = command.source === "core" && command.key ? normalizeKey(command.key) : null;
    if (!key || bindings.core.has(key)) continue;
    bindings.core.set(key, command);
    bindings.byCommand.set(command.id, key);
  }
  for (const command of all) {
    const key = command.source !== "core" && command.key ? normalizeKey(command.key) : null;
    if (!key || !modMayUse(key) || bindings.core.has(key) || bindings.mods.has(key)) continue;
    bindings.mods.set(key, command);
    bindings.byCommand.set(command.id, key);
  }
  cache = { commands, bindings };
  return bindings;
}

const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement);

function run(e: KeyboardEvent, command: Command) {
  // A command that does not apply now leaves the key to whoever else wants it.
  if (command.hidden?.()) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return;
  runCommand(command.id).catch((err) => notify(err instanceof Error ? err.message : String(err)));
}

function onCoreKey(e: KeyboardEvent) {
  if (e.isComposing) return;
  const key = eventKey(e);
  const command = key ? keyBindings().core.get(key) : undefined;
  if (command) run(e, command);
}

function onModKey(e: KeyboardEvent) {
  if (e.isComposing || e.defaultPrevented) return;
  const key = eventKey(e);
  if (!key || (editable(e.target) && !key.startsWith("Ctrl+"))) return;
  const command = keyBindings().mods.get(key);
  if (command) run(e, command);
}

let installed = false;

/** Starts listening. Call once, at start. */
export function installKeys() {
  if (installed) return;
  installed = true;
  window.addEventListener("keydown", onCoreKey, true);
  window.addEventListener("keydown", onModKey);
}

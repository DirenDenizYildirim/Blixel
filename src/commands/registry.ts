// Everything the user can run by name: from the command palette, a key, or a
// menu. Built-in commands and mods' commands live in one list.

import { create } from "zustand";

export interface Command {
  /** "layout.zen" for built-in commands, `mod:<mod id>:<command id>` for a mod's. */
  id: string;
  title: string;
  /**
   * Who provides it, as the palette shows it: "core", or the mod's id. Only
   * shown: what a mod may run depends on the command's id, not on this (a
   * mod's theme names the mod here, but its command is the app's).
   */
  source: string;
  /** Default key, written like "Ctrl+Shift+P" or "Ctrl+." (Ctrl means Cmd on macOS). */
  key?: string;
  /** Whether a mod may run this command through its host API. Built-in commands default to no. */
  modCallable?: boolean;
  /** Hidden from the palette, e.g. while it does not apply. */
  hidden?: () => boolean;
  run: (arg?: unknown) => unknown;
}

export const useCommands = create<Record<string, Command>>(() => ({}));

/** Adds a command; the returned function removes it again. */
export function registerCommand(command: Command): () => void {
  useCommands.setState({ [command.id]: command });
  return () => {
    if (useCommands.getState()[command.id] !== command) return;
    const next = { ...useCommands.getState() };
    delete next[command.id];
    useCommands.setState(next, true);
  };
}

/** Whether a command is one of a mod's own, from its manifest: `mod:<mod id>:<command id>`. */
export const isModsOwn = (command: Command, mod: string) => command.id.startsWith(`mod:${mod}:`);

/**
 * Runs a command. `caller` is "user" for the palette, keys and menus, or the
 * id of the mod asking: a mod may run its own commands (`mod:<its id>:...`)
 * and those marked `modCallable`, nothing else.
 */
export async function runCommand(id: string, arg?: unknown, caller = "user"): Promise<unknown> {
  const command = useCommands.getState()[id];
  if (!command) throw new Error(`No command ${id}`);
  if (caller !== "user" && !isModsOwn(command, caller) && !command.modCallable) {
    throw new Error(`Mods may not run ${id}`);
  }
  return command.run(arg);
}

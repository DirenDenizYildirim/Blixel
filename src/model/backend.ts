import { DEMO_FILES, DEMO_NAME } from "./demo-project";
import type { TreeEntry } from "./types";

/** Where project files come from: the in-memory demo, or a folder on disk. */
export interface Backend {
  kind: "demo" | "folder";
  name: string;
  list(): Promise<TreeEntry[]>;
  read(path: string): Promise<string>;
  /**
   * Writes a file. With `expected`, only if the file still holds that text
   * (a missing file holds ""); the answer says whether it was written.
   */
  write(path: string, content: string, expected?: string): Promise<boolean>;
}

/** True inside the desktop app; false when the interface runs in a plain browser. */
export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function demoBackend(): Backend {
  const files = new Map(Object.entries(DEMO_FILES));
  return {
    kind: "demo",
    name: DEMO_NAME,
    async list() {
      const dirs = new Set<string>();
      for (const path of files.keys()) {
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
      }
      return [
        ...[...dirs].map((path) => ({ path, dir: true })),
        ...[...files.keys()].map((path) => ({ path, dir: false })),
      ].sort((a, b) => a.path.localeCompare(b.path));
    },
    async read(path) {
      const text = files.get(path);
      if (text === undefined) throw new Error(`${path} does not exist`);
      return text;
    },
    async write(path, content, expected) {
      if (expected !== undefined && (files.get(path) ?? "") !== expected) return false;
      files.set(path, content);
      return true;
    },
  };
}

/**
 * The open project's folder, through the core. The core's project_open has
 * already made it the workspace; every path is confined to it there.
 */
export function folderBackend(name: string): Backend {
  const call = async <T>(cmd: string, args?: Record<string, unknown>) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  };
  return {
    kind: "folder",
    name,
    list: () => call<TreeEntry[]>("list_tree"),
    read: (path) => call<string>("read_file", { path }),
    write: (path, content, expected) => call<boolean>("write_file", { path, content, expected: expected ?? null }),
  };
}

/** Asks the user for a folder. Null when cancelled or outside the desktop app. */
export async function pickFolder(title = "Open a project folder"): Promise<string | null> {
  if (!inTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title });
  return typeof picked === "string" ? picked : null;
}

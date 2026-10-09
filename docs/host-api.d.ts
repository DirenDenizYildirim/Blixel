// The API a mod's code sees, as the global `host`. A mod's `main` script runs
// in a sandboxed worker with no DOM, no network and no access to the app; its
// views are sandboxed pages. Both reach the app only through this object.
// Published for mod authors (docs/mods.md): copy it into a mod for editor
// completion. Keep it in step with src/mods/runtime (the client is in
// src/mods/runtime/frame/view.js, the checks in protocol.ts and session.ts).
//
// Every call that returns a promise rejects with a readable reason when the
// mod lacks the permission, the arguments are wrong, or the host refuses.
// Arguments and messages must be plain JSON data, at most 1 MB each. A mod's
// messages (logic and views together) are read at most 200 a second and 4 MB
// a second, answers included; more wait their turn, and past 2000 waiting
// they are dropped unanswered and count as a failure (docs/mods.md, Limits).
//
// `host` is the only way to the app. In a view, ignore `message` events on
// `window`: other mods' frames can send them. In the logic, the worker's own
// `postMessage` throws.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Off = () => void;
type Capability = "files:read" | "agents:read";

interface TreeEntry {
  /** Relative to the project folder, with "/" separators. */
  path: string;
  dir: boolean;
}

interface AgentInfo {
  id: string;
  name: string;
  /** 0..360, the agent's colour. Draw it as oklch(var(--av-l) var(--av-c) <hue>) to match the app. */
  hue: number;
  status: "idle" | "working" | "waiting" | "queued" | "stopped";
  /** The file it is reading or typing in, or null. */
  file: string | null;
}

interface Host {
  /** The API version this app runs. `minor` grows when methods are added. */
  api: { major: 1; minor: number };
  /** This mod's id and the permissions the user granted it. */
  mod: { id: string; granted: Capability[] };
  /**
   * Resolves once the mod is connected to the app. In the logic that is at
   * once. A view connects after its page has loaded: until then `mod.granted`
   * is empty, and calls made meanwhile wait and are sent on connecting.
   */
  ready: Promise<void>;

  commands: {
    /**
     * Gives the code for one of the commands listed in the manifest (by its
     * id there, e.g. "count"). The user runs it from the palette or its key;
     * until some frame registers it, running it shows "not ready yet".
     */
    register(id: string, run: (arg?: Json) => unknown): Off;
    /**
     * Runs one of this mod's commands (by its manifest id), or a built-in
     * command marked as callable by mods (by its full id).
     */
    run(id: string, arg?: Json): Promise<void>;
  };

  /** Logic only: talk to this mod's views, by their manifest ids. */
  views: {
    /** Sends to every open copy of the view; dropped if it is not open. */
    post(view: string, message: Json): void;
    onMessage(view: string, listener: (message: Json) => void): Off;
    /**
     * A view was shown or hidden. Views reload when moved, so keep state in
     * the logic and send it to the view when it is shown.
     */
    onShown(view: string, listener: (shown: boolean) => void): Off;
  };

  /** Views only: talk to this mod's logic. Posts made while it starts are passed on once it runs. */
  logic: {
    post(message: Json): void;
    onMessage(listener: (message: Json) => void): Off;
  };

  /** A short notice at the bottom of the window, shown as "Mod <name>: <text>". At most one every 2 seconds; others are dropped. */
  notify(text: string): void;

  /** Values kept for this mod across restarts; at most 1 MB in all. Keys are 1 to 200 characters. */
  storage: {
    /** The stored value, or undefined. */
    get(key: string): Promise<Json | undefined>;
    /**
     * Stores a value; undefined (or null) removes it. Writes are gathered (the
     * latest value per key, written at most twice a second), so this resolves
     * once the value is written, usually within half a second. `get` sees the
     * new value at once.
     */
    set(key: string, value: Json | undefined): Promise<void>;
  };

  /**
   * The current theme. Views get the same values as CSS variables, kept up to
   * date (--bg, --fg, --accent-ink...), plus the app's font, from base.css.
   */
  theme: {
    /** Each token's value by its name in mod.json ("bg", "accentInk"...); avL and avC as number text. */
    tokens(): Promise<Record<string, string>>;
    onChange(listener: () => void): Off;
  };

  workspace: {
    /** The open project's name. */
    name(): Promise<string>;
    /** The user opened another project. */
    onChange(listener: () => void): Off;
  };

  /** Needs "files:read". Without it, calls reject and listeners are never called. */
  files: {
    list(): Promise<TreeEntry[]>;
    /** A file's text as last saved, by its project path. Files over 1 MB are refused. */
    read(path: string): Promise<string>;
    /** The file in the editor and the cursor's line (from 1), or null. */
    active(): Promise<{ path: string; line: number } | null>;
    /** The user saved a file. */
    onSaved(listener: (path: string) => void): Off;
  };

  /** Needs "agents:read". Without it, calls reject and listeners are never called. */
  agents: {
    list(): Promise<AgentInfo[]>;
    /** An agent's status, name, colour or file changed. */
    onStatus(listener: (agent: AgentInfo) => void): Off;
  };
}

declare const host: Host;

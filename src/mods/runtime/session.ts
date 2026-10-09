// One running mod: its commands and views registered with the app, its logic
// in a hidden sandboxed frame (when it has `main`), and a port to each of its
// frames. The frames get nothing but these ports, and every message on them is
// checked here before anything happens.
//
// Reading a message is what costs (it is copied out of the frame on the
// window's thread), so the limits come before reading: a mod over its rate or
// its bytes waits its turn, unread, and one that keeps going gets failures.

import { createElement } from "react";
import { registerCommand, runCommand } from "../../commands/registry";
import { registerView } from "../../layout/views";
import { getBackend, notify, useStore } from "../../model/store";
import { storageGet, storageSet } from "../core";
import { modBeingRemoved, reportModFailure } from "../registry";
import {
  API_MAJOR,
  API_MINOR,
  MAX_MESSAGE_BYTES,
  type Capability,
  type EventMessage,
  type Json,
  type Manifest,
  type ModMessage,
  type ModRecord,
  type ResultMessage,
} from "../types";
import { agentInfo, themeSnapshot } from "./app";
import { ModView } from "./ModView";
import {
  ByteBudget,
  MAX_BYTES_PER_SECOND,
  MAX_MESSAGES_PER_SECOND,
  MAX_WAITING,
  RateLimiter,
  SUBSCRIBABLE,
  Throttle,
  checkCall,
  checkSubscription,
  commandTarget,
  decode,
  isGreeting,
  isProjectPath,
  isStorageKey,
  jsonText,
  largeAnswer,
  oneLine,
  postToView,
} from "./protocol";
import { frameKey, modUrl, withKey } from "./url";

/** How often the logic is asked whether it still runs, and how long it has to answer. */
const PING_EVERY_MS = 5000;
const PONG_WITHIN_MS = 5000;
/** How long the logic's page may take to load. */
const START_WITHIN_MS = 15_000;
/** Posts from views kept while the logic starts; later ones are dropped. */
const EARLY_POSTS = 50;
/** Notices from one mod, at most one per this long; the rest are dropped. */
const NOTICE_EVERY_MS = 2000;
/** A mod's storage is written at most this often: the latest value of each key set meanwhile. */
const SAVE_EVERY_MS = 500;
/** Keys written in one go; the rest wait for the next. */
const KEYS_PER_SAVE = 10;
/** Keys that may wait to be written; a new key beyond them is refused until they are. */
const MAX_UNSAVED_KEYS = 100;

const API = { major: API_MAJOR, minor: API_MINOR };
const MB = MAX_BYTES_PER_SECOND / (1024 * 1024);

/** One of the mod's frames, as the app sees it. */
interface Endpoint {
  kind: "logic" | "view";
  /** The view's local id, for views. */
  view: string | null;
  port: MessagePort;
  /** The key in its frame's address. Until the frame sends it back, nothing else on the port is read. */
  key: string;
  trusted: boolean;
  /** Events it listens to that need asking for ("saved", "agents"). */
  subs: Set<string>;
  /** Local ids of the commands it handles. */
  commands: Set<string>;
}

interface Logic {
  frame: HTMLIFrameElement;
  key: string;
  endpoint: Endpoint | null;
  /** Its page connected once. It never loads again by itself. */
  connected: boolean;
  /** It loaded again after connecting, which replaced its worker; the next check stops it. */
  reloaded: boolean;
  startedAt: number;
  lastPing: number;
  /** The check waiting for an answer. */
  ping: { n: number; at: number } | null;
}

/** A view's frame, by the key in its address. A frame connects once: only the page it opened with. */
interface ViewFrame {
  endpoint: Endpoint | null;
  connected: boolean;
}

/** A message that came while the mod was over its limits: not read yet. */
interface Waiting {
  ep: Endpoint;
  event: MessageEvent;
  at: number;
}

/** A storage value not written yet, and the calls waiting for it to be. */
interface Unsaved {
  value: Json;
  waiting: { resolve: () => void; reject: (e: unknown) => void }[];
}

const event = (name: string, data: Json): EventMessage => ({ t: "event", name, data });

/** A value as plain JSON (null if it is not), for passing on what the app gives a command. */
function toJson(value: unknown): Json {
  const text = jsonText(value ?? null);
  return text === null ? null : (JSON.parse(text) as Json);
}

export class ModSession {
  readonly id: string;
  readonly name: string;
  /** What it was started from; a different signature means it must restart. */
  readonly signature: string;
  private readonly manifest: Manifest;
  private readonly granted: Capability[];
  private readonly commandIds: string[];
  private readonly endpoints = new Set<Endpoint>();
  private readonly frames = new Map<string, ViewFrame>();
  private readonly offs: (() => void)[] = [];
  private readonly rate = new RateLimiter(MAX_MESSAGES_PER_SECOND, performance.now());
  private readonly budget = new ByteBudget(MAX_BYTES_PER_SECOND, performance.now());
  private waiting: Waiting[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly notices = new Throttle(NOTICE_EVERY_MS);
  /** Failures are reported at most once a second, so one burst is one failure. */
  private readonly failures = new Throttle(1000);
  private readonly unsaved = new Map<string, Unsaved>();
  /** Values being written now, so reads meanwhile still see them. */
  private readonly saving = new Map<string, Json>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSave = -Infinity;
  private logic: Logic | null = null;
  private early: ModMessage[] = [];
  private pings = 0;
  private stopped = false;

  constructor(
    record: ModRecord,
    manifest: Manifest,
    signature: string,
    /** Distinguishes this start from earlier ones, so views get fresh frames on a restart. */
    private readonly generation: number,
  ) {
    this.id = record.id;
    this.name = manifest.name;
    this.signature = signature;
    this.manifest = manifest;
    // Only what the user granted and the manifest still asks for.
    this.granted = record.granted.filter((c) => manifest.permissions?.includes(c));
    this.commandIds = (manifest.contributes?.commands ?? []).map((c) => c.id);
  }

  /** Registers its commands and views, and starts its logic in a frame inside `container`. */
  start(container: HTMLElement) {
    const { commands = [], views = [] } = this.manifest.contributes ?? {};
    for (const c of commands) {
      this.offs.push(
        registerCommand({
          id: `mod:${this.id}:${c.id}`,
          title: c.title,
          source: this.id,
          key: c.key,
          run: (arg) => this.runCommand(c.id, c.title, arg),
        }),
      );
    }
    for (const v of views) {
      const src = modUrl(this.id, v.entry);
      const connect = (frame: HTMLIFrameElement, key: string) => this.loadView(v.id, frame, key);
      const disconnect = (key: string) => this.closeView(key);
      this.offs.push(
        registerView({
          id: `mod:${this.id}:${v.id}`,
          title: v.title,
          minWidth: v.minWidth ?? 200,
          source: this.id,
          render: () => createElement(ModView, { key: this.generation, src, title: v.title, connect, disconnect }),
        }),
      );
    }
    if (this.manifest.main) this.startLogic(container);
  }

  /** Removes everything it registered, closes its ports and removes its logic frame (which ends its worker). */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.offs.splice(0).forEach((off) => off());
    for (const ep of this.endpoints) this.close(ep);
    this.endpoints.clear();
    this.frames.clear();
    this.logic?.frame.remove();
    this.logic = null;
    this.early = [];
    this.waiting = [];
    if (this.drainTimer !== null) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    // What it stored is written now rather than lost, unless the mod is being removed with its storage.
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (modBeingRemoved(this.id)) this.discardUnsaved();
    else this.scheduleSave();
  }

  /**
   * The watchdog, called about once a second: asks the logic whether it still
   * runs. Returns why it should be stopped, or null. After a pause (the
   * window was asleep or busy), the checks start over instead of blaming it.
   */
  check(now: number, paused: boolean): string | null {
    const logic = this.logic;
    if (this.stopped || !logic) return null;
    if (logic.reloaded) return "Its background page loaded again, which it never does by itself.";
    if (paused) {
      if (logic.ping) logic.ping.at = now;
      logic.startedAt = Math.max(logic.startedAt, now - START_WITHIN_MS / 2);
      return null;
    }
    const ep = logic.endpoint;
    if (!logic.connected || !ep) return now - logic.startedAt > START_WITHIN_MS ? "Its code did not start." : null;
    if (logic.ping) {
      if (now - logic.ping.at < PONG_WITHIN_MS) return null;
      // It sent more since the check, so it still runs: its answer waits behind what it sent before.
      const since = logic.ping.at;
      if (this.waiting.some((w) => w.ep === ep && w.at >= since)) return null;
      return "Its code stopped responding.";
    }
    if (now - logic.lastPing >= PING_EVERY_MS) {
      logic.lastPing = now;
      logic.ping = { n: ++this.pings, at: now };
      this.send(ep, { t: "ping", n: logic.ping.n });
    }
    return null;
  }

  /** Sends an app event to every frame, or for events that need asking, to those that asked. */
  broadcast(name: string, data: Json) {
    if (this.stopped) return;
    const asked = Object.prototype.hasOwnProperty.call(SUBSCRIBABLE, name);
    for (const ep of this.endpoints) {
      if (ep.trusted && (!asked || ep.subs.has(name))) this.send(ep, event(name, data));
    }
  }

  /** Whether any of its frames listens to `name`. */
  wants(name: string): boolean {
    for (const ep of this.endpoints) if (ep.trusted && ep.subs.has(name)) return true;
    return false;
  }

  // ---- Frames ----
  //
  // Each frame's address carries a key of its own ("#k=..."). The app hands a
  // port to whatever page is in the frame when it loads, so the page must send
  // the key back first: a page that replaced the one the app opened (another
  // mod's, say) cannot, and its port is closed. A frame is connected once;
  // pages it goes to later get nothing.

  private startLogic(container: HTMLElement) {
    const frame = document.createElement("iframe");
    // Sandboxed before it has a source: scripts only, an opaque origin, no way to the app.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.title = `${this.name} (background)`;
    const key = frameKey();
    frame.addEventListener("load", () => this.loadLogic(frame));
    frame.src = withKey(modUrl(this.id, "__host/logic.html"), key);
    const now = performance.now();
    this.logic = { frame, key, endpoint: null, connected: false, reloaded: false, startedAt: now, lastPing: now, ping: null };
    container.appendChild(frame);
  }

  private loadLogic(frame: HTMLIFrameElement) {
    const logic = this.logic;
    const target = frame.contentWindow;
    if (this.stopped || !logic || logic.frame !== frame || !target) return;
    if (logic.endpoint) this.drop(logic.endpoint);
    if (logic.connected) {
      logic.reloaded = true;
      return;
    }
    const channel = new MessageChannel();
    logic.endpoint = this.open("logic", null, channel.port1, logic.key);
    target.postMessage({ t: "init", kind: "logic", mod: { id: this.id, granted: this.granted }, api: API }, "*", [
      channel.port2,
    ]);
  }

  private logicReady(ep: Endpoint) {
    const logic = this.logic;
    if (!logic || logic.endpoint !== ep) return;
    logic.connected = true;
    logic.ping = null;
    logic.lastPing = performance.now();
    // It learns which views are already open, and gets what they posted while it started.
    for (const view of this.openViews()) this.send(ep, event("shown", { view, shown: true }));
    for (const message of this.early.splice(0)) this.send(ep, message);
  }

  /** A view's frame loaded a page. */
  private loadView(view: string, frame: HTMLIFrameElement, key: string) {
    const target = frame.contentWindow;
    if (this.stopped || !target) return;
    const known = this.frames.get(key);
    if (known?.endpoint) this.drop(known.endpoint);
    if (known?.connected) {
      known.endpoint = null;
      this.fail(`Its view "${view}" went to another page, which is not connected: a view keeps the page it opened with.`);
      return;
    }
    const channel = new MessageChannel();
    const ep = this.open("view", view, channel.port1, key);
    this.frames.set(key, { endpoint: ep, connected: false });
    target.postMessage(
      { t: "init", kind: "view", view, mod: { id: this.id, granted: this.granted }, api: API, theme: themeSnapshot() },
      "*",
      [channel.port2],
    );
  }

  private viewReady(ep: Endpoint) {
    const frame = this.frames.get(ep.key);
    if (frame) frame.connected = true;
    if (ep.view !== null && this.countViews(ep.view) === 1) this.toLogic(event("shown", { view: ep.view, shown: true }), false);
  }

  /** A view's frame went away: closed, moved (a new frame then loads) or the mod restarted. */
  private closeView(key: string) {
    const known = this.frames.get(key);
    this.frames.delete(key);
    if (known?.endpoint) this.drop(known.endpoint);
  }

  private open(kind: Endpoint["kind"], view: string | null, port: MessagePort, key: string): Endpoint {
    const ep: Endpoint = { kind, view, port, key, trusted: false, subs: new Set(), commands: new Set() };
    port.onmessage = (e) => this.arrive(ep, e);
    this.endpoints.add(ep);
    return ep;
  }

  private close(ep: Endpoint) {
    ep.port.onmessage = null;
    ep.port.close();
  }

  private drop(ep: Endpoint) {
    if (!this.endpoints.delete(ep)) return;
    this.close(ep);
    if (this.logic?.endpoint === ep) this.logic.endpoint = null;
    if (ep.trusted && ep.kind === "view" && ep.view !== null && this.countViews(ep.view) === 0) {
      this.toLogic(event("shown", { view: ep.view, shown: false }), false);
    }
  }

  private countViews(view: string): number {
    let n = 0;
    for (const ep of this.endpoints) if (ep.trusted && ep.kind === "view" && ep.view === view) n++;
    return n;
  }

  private openViews(): string[] {
    const views = new Set<string>();
    for (const ep of this.endpoints) if (ep.trusted && ep.kind === "view" && ep.view !== null) views.add(ep.view);
    return [...views];
  }

  private send(ep: Endpoint, message: ModMessage) {
    try {
      ep.port.postMessage(message);
    } catch {
      // A closed port; the frame is going away.
    }
  }

  /** Counts bytes the mod caused against its budget. */
  private charge(bytes: number) {
    if (bytes) this.budget.spend(bytes, performance.now());
  }

  /** To the logic, or, while it starts, kept for it when `keep` is set. Dropped if there is no logic. */
  private toLogic(message: ModMessage, keep: boolean, bytes = 0) {
    const logic = this.logic;
    const ep = logic?.endpoint;
    if (ep?.trusted) {
      this.charge(bytes);
      this.send(ep, message);
    } else if (logic && keep && this.early.length < EARLY_POSTS) {
      this.charge(bytes);
      this.early.push(message);
    }
  }

  private fail(reason: string) {
    if (!this.failures.take(performance.now())) return;
    console.warn(`[mod ${this.id}] ${reason}`);
    reportModFailure(this.id, reason);
  }

  // ---- Messages from its frames ----

  /** A message from a frame, not read yet. */
  private arrive(ep: Endpoint, e: MessageEvent) {
    if (this.stopped || !this.endpoints.has(ep)) return;
    if (!ep.trusted) {
      this.greet(ep, e.data);
      return;
    }
    const now = performance.now();
    if (!this.waiting.length && this.mayRead(now)) {
      this.receive(ep, e.data);
      return;
    }
    if (this.waiting.length >= MAX_WAITING) {
      this.fail(`It sent more than ${MAX_MESSAGES_PER_SECOND} messages or ${MB} MB a second for too long, so some were dropped.`);
      return;
    }
    this.waiting.push({ ep, event: e, at: now });
    this.scheduleDrain();
  }

  /** Whether one more message may be read now; takes its place in the rate if so. */
  private mayRead(now: number): boolean {
    return this.budget.open(now) && this.rate.take(now);
  }

  private scheduleDrain(again = false) {
    if (again && this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.drainTimer !== null || !this.waiting.length || this.stopped) return;
    const now = performance.now();
    const wait = Math.max(this.rate.wait(now), this.budget.wait(now));
    this.drainTimer = setTimeout(() => this.drain(), Math.ceil(wait));
  }

  /** Reads waiting messages, oldest first, as far as the limits allow. */
  private drain() {
    this.drainTimer = null;
    while (this.waiting.length && !this.stopped) {
      const next = this.waiting[0];
      if (!this.endpoints.has(next.ep)) {
        this.waiting.shift();
        continue;
      }
      if (!this.mayRead(performance.now())) break;
      this.waiting.shift();
      this.receive(next.ep, next.event.data);
    }
    this.scheduleDrain();
  }

  /** A frame's first message: its key back, or its port is closed. */
  private greet(ep: Endpoint, data: unknown) {
    if (!isGreeting(data, ep.key)) {
      const where = ep.kind === "logic" ? "Its background page" : `Its view "${ep.view}"`;
      this.drop(ep);
      this.fail(`${where} held a page the app did not open there, so its connection was closed.`);
      return;
    }
    ep.trusted = true;
    if (ep.kind === "logic") this.logicReady(ep);
    else this.viewReady(ep);
  }

  private receive(ep: Endpoint, data: unknown) {
    const decoded = decode(data);
    // One refused as too large still had to be copied here, so it takes the whole second's share.
    this.charge(decoded.bytes > MAX_MESSAGE_BYTES ? MAX_BYTES_PER_SECOND : decoded.bytes);
    if (!decoded.ok) {
      // A call the mod got wrong is answered; anything else did not come from the host API.
      if (decoded.id !== undefined) this.reply(ep, decoded.id, false, decoded.reason);
      else this.fail(`It sent ${decoded.reason}.`);
      return;
    }
    const msg = decoded.msg;
    if (msg.t === "pong") {
      const logic = this.logic;
      if (logic?.endpoint === ep && logic.ping?.n === msg.n) logic.ping = null;
      else this.fail("It answered a check the app did not make.");
    } else if (msg.t === "event") this.onEvent(ep, msg.name, msg.data, decoded.bytes);
    else void this.call(ep, msg.id, msg.method, msg.params);
  }

  private onEvent(ep: Endpoint, name: "post" | "error", data: Json, bytes: number) {
    if (name === "error") {
      const where = ep.kind === "logic" ? "Its code" : `Its view "${ep.view}"`;
      const text = typeof data === "string" ? data : JSON.stringify(data);
      this.fail(`${where} hit an error: ${oneLine(text, 300)}`);
      return;
    }
    if (ep.kind === "view") {
      this.toLogic(event("post", { view: ep.view, message: data }), true, bytes);
      return;
    }
    const post = postToView(data);
    if (!post) {
      this.fail("It posted to a view without naming the view.");
      return;
    }
    for (const other of this.endpoints) {
      if (other.trusted && other.kind === "view" && other.view === post.view) {
        this.charge(bytes);
        this.send(other, event("post", post.message));
      }
    }
  }

  private async call(ep: Endpoint, id: number, method: string, params: Json[]) {
    const refused = checkCall(method, params, this.granted);
    if (refused) {
      this.reply(ep, id, false, refused);
      return;
    }
    // An answer that can be large is paid for before it is fetched, so a burst
    // of such calls cannot run far past the budget; what it did not use comes back.
    const reserved = largeAnswer(method) ? MAX_MESSAGE_BYTES : 0;
    this.charge(reserved);
    try {
      this.reply(ep, id, true, await this.handle(ep, method, params));
    } catch (e) {
      this.reply(ep, id, false, e instanceof Error ? e.message : String(e));
    }
    if (reserved) {
      this.budget.spend(-reserved, performance.now());
      this.scheduleDrain(true);
    }
  }

  private reply(ep: Endpoint, id: number, ok: boolean, value: Json | string) {
    if (this.stopped || !this.endpoints.has(ep)) return;
    let message: ResultMessage;
    let bytes: number;
    if (!ok) {
      const error = oneLine(String(value), 500);
      message = { t: "result", id, ok: false, error };
      bytes = error.length;
    } else {
      const text = jsonText(value);
      bytes = text === null ? MAX_MESSAGE_BYTES : text.length;
      message = text === null ? { t: "result", id, ok: false, error: "The answer is larger than 1 MB." } : { t: "result", id, ok: true, value };
    }
    this.charge(bytes);
    this.send(ep, message);
  }

  /** Runs one checked call. Arguments have the types METHODS declares. */
  private async handle(ep: Endpoint, method: string, p: Json[]): Promise<Json> {
    switch (method) {
      case "commands.register": {
        const id = p[0] as string;
        if (!this.commandIds.includes(id)) throw new Error(`"${id}" is not one of the commands in this mod's mod.json.`);
        ep.commands.add(id);
        return null;
      }
      case "commands.unregister":
        ep.commands.delete(p[0] as string);
        return null;
      case "commands.run":
        await runCommand(commandTarget(this.id, this.commandIds, p[0] as string), p[1] ?? undefined, this.id);
        return null;
      case "subscribe": {
        const refused = checkSubscription(p[0], this.granted);
        if (refused) throw new Error(refused);
        ep.subs.add(p[0] as string);
        return null;
      }
      case "unsubscribe":
        ep.subs.delete(p[0] as string);
        return null;
      case "notify": {
        const text = oneLine(p[0] as string, 200);
        // Always under the mod's name, so a mod's notice never reads as the app's own.
        if (text && this.notices.take(performance.now())) notify(`Mod ${this.name}: ${text}`);
        return null;
      }
      case "storage.get": {
        const key = p[0] as string;
        if (!isStorageKey(key)) throw new Error("A storage key must be a text of 1 to 200 characters.");
        const unsaved = this.unsaved.get(key);
        if (unsaved) return unsaved.value;
        if (this.saving.has(key)) return this.saving.get(key)!;
        return (await storageGet(this.id, key)) ?? null;
      }
      case "storage.set": {
        const key = p[0] as string;
        if (!isStorageKey(key)) throw new Error("A storage key must be a text of 1 to 200 characters.");
        await this.store(key, p[1] ?? null);
        return null;
      }
      case "theme.tokens":
        return themeSnapshot().tokens;
      case "workspace.name":
        return useStore.getState().workspace.name;
      case "files.list":
        return (await getBackend().list()).map((e) => ({ path: e.path, dir: e.dir }));
      case "files.read": {
        const path = p[0] as string;
        if (!isProjectPath(path)) throw new Error(`"${oneLine(path, 80)}" is not a path inside the project.`);
        return await getBackend().read(path);
      }
      case "files.active": {
        const { activePath, cursor } = useStore.getState();
        return activePath ? { path: activePath, line: cursor.line } : null;
      }
      case "agents.list": {
        const { agents, presence } = useStore.getState();
        return agents.map((a) => agentInfo(a, presence));
      }
    }
    throw new Error(`There is no method ${method}.`);
  }

  // ---- Storage ----
  //
  // Writes are gathered: each key keeps only its latest value, and the mod's
  // storage is written at most every SAVE_EVERY_MS, a few keys at a time, so
  // a mod cannot keep the disk busy. A set resolves once its value is written.

  private store(key: string, value: Json): Promise<void> {
    let entry = this.unsaved.get(key);
    if (!entry) {
      if (this.unsaved.size >= MAX_UNSAVED_KEYS) {
        return Promise.reject(new Error("Too many storage keys are waiting to be written; try again in a moment."));
      }
      entry = { value, waiting: [] };
      this.unsaved.set(key, entry);
    }
    entry.value = value;
    const waiting = entry.waiting;
    const written = new Promise<void>((resolve, reject) => waiting.push({ resolve, reject }));
    this.scheduleSave();
    return written;
  }

  private scheduleSave() {
    if (this.saveTimer !== null || this.saving.size || !this.unsaved.size) return;
    // Once stopped, what is left is written at once.
    const wait = this.stopped ? 0 : Math.max(0, this.lastSave + SAVE_EVERY_MS - performance.now());
    this.saveTimer = setTimeout(() => void this.save(), wait);
  }

  /** Writes waiting values one after another, so a later value never lands before an earlier one. */
  private async save() {
    this.saveTimer = null;
    if (modBeingRemoved(this.id)) {
      this.discardUnsaved();
      return;
    }
    this.lastSave = performance.now();
    const batch = [...this.unsaved].slice(0, this.stopped ? undefined : KEYS_PER_SAVE);
    for (const [key, entry] of batch) {
      this.unsaved.delete(key);
      this.saving.set(key, entry.value);
    }
    for (const [key, entry] of batch) {
      try {
        await storageSet(this.id, key, entry.value);
        entry.waiting.forEach((w) => w.resolve());
      } catch (e) {
        entry.waiting.forEach((w) => w.reject(e));
      }
      this.saving.delete(key);
    }
    this.scheduleSave();
  }

  /** The mod is being removed with its storage: nothing waiting is written. */
  private discardUnsaved() {
    const error = new Error("The mod is being removed.");
    for (const entry of this.unsaved.values()) entry.waiting.forEach((w) => w.reject(error));
    this.unsaved.clear();
  }

  // ---- Commands run from the app ----

  private runCommand(local: string, title: string, arg: unknown) {
    const handlers = [...this.endpoints].filter((ep) => ep.trusted && ep.commands.has(local));
    if (!handlers.length) {
      notify(`${this.name}: ${title} is not ready yet.`);
      return;
    }
    const data = { id: local, arg: toJson(arg) };
    for (const ep of handlers) this.send(ep, event("command", data));
  }
}

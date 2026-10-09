// The checks on every message a mod's frames send to the app: shape, size,
// rate, capability and argument types. Pure functions, with no access to the
// app, so they can be tested on their own. Nothing a mod sends is trusted.

import { MAX_MESSAGE_BYTES, type Capability, type Json } from "../types";

/** Messages a mod may send each second, across its logic and views; more wait their turn. */
export const MAX_MESSAGES_PER_SECOND = 200;
/**
 * Bytes of messages a mod may cause each second, both ways together: what it
 * sends, the answers it asks for and the posts passed on to its views. More
 * wait their turn.
 */
export const MAX_BYTES_PER_SECOND = 4 * 1024 * 1024;
/**
 * Messages that may wait for their turn (ten seconds' worth at the rate); one
 * more is dropped unread and counts as a failure. Enough for a mod that asks
 * for many files at once to be slowed down rather than failed.
 */
export const MAX_WAITING = 2000;

/** What a frame sends, once its envelope has been checked. */
export type Incoming =
  | { t: "call"; id: number; method: string; params: Json[] }
  | { t: "event"; name: "post" | "error"; data: Json }
  | { t: "pong"; n: number };

/**
 * The checked message, or why it was refused, with its size in bytes of JSON
 * (at least the limit when it was refused as too large). `id` is set when the
 * refused message was a call that can still be answered (it is the mod's
 * mistake, not a broken frame).
 */
export type Decoded = ({ ok: true; msg: Incoming } | { ok: false; reason: string; id?: number }) & { bytes: number };

type ArgType = "string" | "json";
interface MethodSpec {
  /** Each parameter's type; a "?" after the type makes it optional. */
  args: `${ArgType}${"" | "?"}`[];
  cap?: Capability;
  /** Its answer can be as large as a message may be, so that much is set aside before it runs. */
  large?: true;
}

/** The methods behind `host`, by wire name. Kept in step with frame/view.js. */
export const METHODS: Record<string, MethodSpec> = {
  "commands.register": { args: ["string"] },
  "commands.unregister": { args: ["string"] },
  "commands.run": { args: ["string", "json?"] },
  subscribe: { args: ["string"] },
  unsubscribe: { args: ["string"] },
  notify: { args: ["string"] },
  "storage.get": { args: ["string"], large: true },
  "storage.set": { args: ["string", "json?"] },
  "theme.tokens": { args: [] },
  "workspace.name": { args: [] },
  "files.list": { args: [], cap: "files:read", large: true },
  "files.read": { args: ["string"], cap: "files:read", large: true },
  "files.active": { args: [], cap: "files:read" },
  "agents.list": { args: [], cap: "agents:read" },
};

/** Events a mod must subscribe to, and the capability each needs. Others (theme, workspace) reach every frame. */
export const SUBSCRIBABLE: Record<string, Capability> = {
  saved: "files:read",
  agents: "agents:read",
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Length of a JSON text in UTF-8 bytes, counted exactly only when it could be near the limit. */
export function byteLength(text: string): number {
  return text.length * 3 <= MAX_MESSAGE_BYTES ? text.length : new TextEncoder().encode(text).length;
}

/**
 * JSON text of a value, or null if it is not plain JSON or larger than the
 * limit. Values arrive by structured clone, which also carries things JSON
 * does not (Maps, cycles, binary data); going through JSON keeps only data.
 */
export function jsonText(value: unknown): string | null {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (text === undefined || byteLength(text) > MAX_MESSAGE_BYTES) return null;
  return text;
}

/**
 * Whether a value's JSON is surely larger than `max` bytes. It looks at no
 * more than about `max` of the value, so a huge message is refused without
 * turning all of it into text.
 */
function surelyLarger(value: unknown, max: number): boolean {
  let size = 0;
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    // Lower bounds: every character is at least a byte, and every value at least one more.
    if (typeof v === "string") size += v.length + 2;
    else if (Array.isArray(v)) {
      size += v.length + 1;
      if (size > max) return true;
      for (const item of v) stack.push(item);
    } else if (typeof v === "object" && v !== null) {
      const keys = Object.keys(v);
      size += keys.length + 1;
      if (size > max) return true;
      for (const key of keys) {
        size += key.length + 3;
        stack.push((v as Record<string, unknown>)[key]);
      }
    } else size += 1;
    if (size > max) return true;
  }
  return false;
}

/** Checks a message's envelope: plain JSON, within the size limit, and one of the known kinds. */
export function decode(data: unknown): Decoded {
  // Only a call can be answered, so its id is read first, from the value as it arrived.
  const call = isObject(data) && data.t === "call";
  const rawId = call ? data.id : undefined;
  const id = typeof rawId === "number" && Number.isSafeInteger(rawId) && rawId >= 0 ? rawId : undefined;
  if (call && id === undefined) return { ok: false, reason: "a call without an id", bytes: 0 };
  const tooLarge = (bytes: number) =>
    call ? { ok: false as const, reason: "The call is larger than 1 MB.", id, bytes } : { ok: false as const, reason: "a message larger than 1 MB", bytes };
  if (surelyLarger(data, MAX_MESSAGE_BYTES)) return tooLarge(MAX_MESSAGE_BYTES + 1);

  let text: string | undefined;
  try {
    text = JSON.stringify(data);
  } catch {
    return { ok: false, reason: "a message that is not plain JSON", bytes: 0 };
  }
  if (text === undefined) return { ok: false, reason: "an empty message", bytes: 0 };
  const bytes = byteLength(text);
  if (bytes > MAX_MESSAGE_BYTES) return tooLarge(bytes);
  // Going through JSON keeps only data (structured clone also carries Maps, cycles, binary data).
  const m: unknown = JSON.parse(text);
  if (!isObject(m)) return { ok: false, reason: "a message that is not an object", bytes };

  if (m.t === "call") {
    if (typeof m.method !== "string") return { ok: false, reason: "A call needs a method name.", id, bytes };
    const params = m.params ?? [];
    if (!Array.isArray(params)) return { ok: false, reason: "A call's parameters must be a list.", id, bytes };
    return { ok: true, msg: { t: "call", id: id!, method: m.method, params: params as Json[] }, bytes };
  }
  if (m.t === "event") {
    if (m.name !== "post" && m.name !== "error") return { ok: false, reason: `an unknown event ${JSON.stringify(m.name)}`, bytes };
    return { ok: true, msg: { t: "event", name: m.name, data: (m.data ?? null) as Json }, bytes };
  }
  if (m.t === "pong") {
    if (typeof m.n !== "number") return { ok: false, reason: "a reply to a check without its number", bytes };
    return { ok: true, msg: { t: "pong", n: m.n }, bytes };
  }
  return { ok: false, reason: `an unknown kind of message ${JSON.stringify(m.t)}`, bytes };
}

/**
 * Whether a frame's first message is its greeting with the key the app put in
 * its address. Until it is, nothing else from the frame is read.
 */
export function isGreeting(data: unknown, key: string): boolean {
  return isObject(data) && data.t === "hello" && typeof data.k === "string" && data.k === key;
}

/** Whether a method's answer may be as large as a message may be. */
export function largeAnswer(method: string): boolean {
  return Object.prototype.hasOwnProperty.call(METHODS, method) && METHODS[method].large === true;
}

/** Why a call may not run (unknown method, missing capability, wrong arguments), or null. */
export function checkCall(method: string, params: Json[], granted: readonly Capability[]): string | null {
  const spec = Object.prototype.hasOwnProperty.call(METHODS, method) ? METHODS[method] : undefined;
  if (!spec) return `There is no method ${method}.`;
  if (spec.cap && !granted.includes(spec.cap)) return `This needs the "${spec.cap}" permission in mod.json, approved by the user.`;
  if (params.length > spec.args.length) return `${method} takes at most ${spec.args.length} arguments.`;
  for (let i = 0; i < spec.args.length; i++) {
    const want = spec.args[i];
    const optional = want.endsWith("?");
    const value = params[i];
    if (value === undefined || value === null) {
      if (!optional) return `${method} is missing argument ${i + 1}.`;
      continue;
    }
    if (want.startsWith("string") && typeof value !== "string") return `Argument ${i + 1} of ${method} must be a text.`;
  }
  return null;
}

/** Why a subscription is refused, or null. */
export function checkSubscription(name: Json, granted: readonly Capability[]): string | null {
  if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(SUBSCRIBABLE, name)) {
    return `There is no event ${JSON.stringify(name)} to listen to.`;
  }
  const cap = SUBSCRIBABLE[name];
  return granted.includes(cap) ? null : `Listening to this needs the "${cap}" permission in mod.json, approved by the user.`;
}

/** A post from the logic to a view: `{view, message}`, or null if it is not one. */
export function postToView(data: Json): { view: string; message: Json } | null {
  if (!isObject(data) || typeof data.view !== "string") return null;
  return { view: data.view, message: (data.message ?? null) as Json };
}

/**
 * The full id of a command a mod asks to run: one of its own by its local id,
 * or any other id as given (the command registry decides whether it may).
 */
export function commandTarget(modId: string, ownLocalIds: readonly string[], id: string): string {
  return ownLocalIds.includes(id) ? `mod:${modId}:${id}` : id;
}

/** A path inside the open project: relative, "/" separated, not leaving it. */
export function isProjectPath(path: string): boolean {
  if (!path || path.length > 4096) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || /^[A-Za-z]:/.test(path)) return false;
  return !path.split("/").some((part) => part === ".." || part === "");
}

/** A storage key: a short text. */
export function isStorageKey(key: string): boolean {
  return key.length > 0 && key.length <= 200;
}

/** Allows `perSecond` events a second on average, in bursts of up to `perSecond`. */
export class RateLimiter {
  private tokens: number;
  private last: number;

  constructor(
    private readonly perSecond: number,
    now: number,
  ) {
    this.tokens = perSecond;
    this.last = now;
  }

  private refill(now: number) {
    this.tokens = Math.min(this.perSecond, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
  }

  /** Takes one event; false when over the rate. */
  take(now: number): boolean {
    this.refill(now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Milliseconds until one more event is allowed. */
  wait(now: number): number {
    this.refill(now);
    return this.tokens >= 1 ? 0 : ((1 - this.tokens) / this.perSecond) * 1000;
  }
}

/**
 * Allows `perSecond` bytes a second on average. A message larger than what
 * is left still passes, leaving a debt: nothing more passes until it is paid
 * back, so one large message cannot be followed by many more.
 */
export class ByteBudget {
  private level: number;
  private last: number;

  constructor(
    private readonly perSecond: number,
    now: number,
  ) {
    this.level = perSecond;
    this.last = now;
  }

  private refill(now: number) {
    this.level = Math.min(this.perSecond, this.level + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
  }

  /** Whether anything may pass now. */
  open(now: number): boolean {
    this.refill(now);
    return this.level > 0;
  }

  /** Counts `bytes` against the budget; a negative number gives back what was set aside and not used. */
  spend(bytes: number, now: number) {
    this.refill(now);
    this.level = Math.min(this.perSecond, this.level - bytes);
  }

  /** Milliseconds until something may pass again. */
  wait(now: number): number {
    this.refill(now);
    return this.level > 0 ? 0 : ((1 - this.level) / this.perSecond) * 1000;
  }
}

/** Lets something happen at most once every `ms`. */
export class Throttle {
  private last = -Infinity;

  constructor(private readonly ms: number) {}

  /** True, and starts a new interval, if the last one has passed. */
  take(now: number): boolean {
    if (now - this.last < this.ms) return false;
    this.last = now;
    return true;
  }
}

/** A short, single-line text from a mod, for notices and error lists. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

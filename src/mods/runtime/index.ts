// Starts and stops the code of enabled mods. Each one runs sandboxed: its
// logic in a worker inside a hidden frame, its views in frames of their own,
// all reaching the app only through the checked ports of a ModSession. This
// file follows the mod list, passes app events on to running mods, and runs
// the watchdog. Outside the desktop app there is no mod scheme, so no mod
// code runs.

import { onFileSaved } from "../../editor/sessions";
import { inTauri } from "../../model/backend";
import { useStore } from "../../model/store";
import { heartbeat } from "../core";
import { reportModFailure, runnableCodeMods, useMods } from "../registry";
import type { ModRecord } from "../types";
import { agentInfo, themeSnapshot } from "./app";
import { ModSession } from "./session";

/** After its code dies, a mod restarts after this pause, unless it died this often lately. */
const RESTART_AFTER_MS = 3000;
const DEATHS_TO_HOLD = 3;
const DEATH_WINDOW_MS = 10 * 60_000;
/** How often the window tells the core it is alive. */
const HEARTBEAT_EVERY_MS = 2000;

const running = new Map<string, ModSession>();
/** Mods whose code died and waits to restart: until a time, or (Infinity) until the mod changes or reloads. */
const held = new Map<string, { signature: string; until: number }>();
const deaths = new Map<string, number[]>();
let container: HTMLElement | null = null;
let generation = 0;
let lastTick = 0;
let beating = false;

/**
 * Tells the core every 2 seconds that the window is alive. The timer runs on
 * the window's own thread, which mod views share on Linux: a view that loops,
 * or a crashed page, stops it, and the core then treats the session's end as
 * unclean. Call once, as early as possible.
 */
export function startHeartbeat(): void {
  if (beating || !inTauri) return;
  beating = true;
  // A core without the command (an older build) just refuses; nothing to do about it here.
  const beat = () => void heartbeat().catch(() => {});
  beat();
  setInterval(beat, HEARTBEAT_EVERY_MS);
}

/** Starts and stops code mods' frames as mods are enabled and disabled. Call once, after the first paint. */
export function startModRuntime(): void {
  startHeartbeat();
  if (container || !inTauri) return;
  container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  container.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none";
  document.body.appendChild(container);
  useMods.subscribe(sync);
  sync();
  watchApp();
  lastTick = performance.now();
  setInterval(tick, 1000);
}

/** The mods whose code should run now, with what each was started from. */
function wanted(): Map<string, { record: ModRecord; signature: string }> {
  const s = useMods.getState();
  const out = new Map<string, { record: ModRecord; signature: string }>();
  // Includes mods with views but no `main`: their pages use the host API directly.
  for (const record of runnableCodeMods()) {
    const manifest = record.manifest;
    if (!manifest) continue;
    const signature = JSON.stringify([record.dir, record.granted, manifest, s.restarts[record.id] ?? 0]);
    out.set(record.id, { record, signature });
  }
  return out;
}

function sync() {
  if (!container) return;
  const want = wanted();
  const now = performance.now();
  for (const [id, session] of [...running]) {
    const next = want.get(id);
    if (next?.signature === session.signature) continue;
    running.delete(id);
    // The new one registers first, so its views and commands replace the old ones without a gap.
    if (next) start(next.record, next.signature);
    session.stop();
  }
  for (const [id, hold] of [...held]) {
    if (want.get(id)?.signature !== hold.signature) held.delete(id);
  }
  for (const [id, next] of want) {
    if (running.has(id) || (held.get(id)?.until ?? 0) > now) continue;
    held.delete(id);
    start(next.record, next.signature);
  }
}

function start(record: ModRecord, signature: string) {
  const session = new ModSession(record, record.manifest!, signature, ++generation);
  running.set(record.id, session);
  try {
    session.start(container!);
  } catch (e) {
    running.delete(record.id);
    session.stop();
    held.set(record.id, { signature, until: Infinity });
    reportModFailure(record.id, `It could not start: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Stops a mod whose code stopped responding; it restarts after a pause unless it keeps dying. */
function died(session: ModSession, reason: string) {
  if (running.get(session.id) !== session) return;
  running.delete(session.id);
  session.stop();
  const now = performance.now();
  const recent = [...(deaths.get(session.id) ?? []).filter((t) => now - t < DEATH_WINDOW_MS), now];
  deaths.set(session.id, recent);
  held.set(session.id, { signature: session.signature, until: recent.length >= DEATHS_TO_HOLD ? Infinity : now + RESTART_AFTER_MS });
  // This may turn the mod off; the mod list changing then runs sync.
  reportModFailure(session.id, reason);
  setTimeout(sync, RESTART_AFTER_MS + 50);
}

function tick() {
  const now = performance.now();
  // A long gap means the window was asleep or the page was busy, not that a mod hung.
  const paused = now - lastTick > 3000;
  lastTick = now;
  for (const session of [...running.values()]) {
    const reason = session.check(now, paused);
    if (reason) died(session, reason);
  }
}

/** Passes the app's events on to running mods: theme, project, saves and agents. */
function watchApp() {
  // Whatever applies a theme (built in or from a mod) sets variables on the root element.
  let theme = JSON.stringify(themeSnapshot());
  let pending: ReturnType<typeof setTimeout> | undefined;
  new MutationObserver(() => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      const next = themeSnapshot();
      const text = JSON.stringify(next);
      if (text === theme) return;
      theme = text;
      for (const session of running.values()) session.broadcast("theme", next);
    }, 50);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });

  const lastAgents = new Map<string, string>();
  const agentsChanged = () => {
    const { agents, presence } = useStore.getState();
    const listening = [...running.values()].filter((s) => s.wants("agents"));
    for (const agent of agents) {
      const info = agentInfo(agent, presence);
      const text = JSON.stringify(info);
      if (lastAgents.get(agent.id) === text) continue;
      lastAgents.set(agent.id, text);
      for (const session of listening) session.broadcast("agents", info);
    }
  };
  agentsChanged();

  useStore.subscribe((s, prev) => {
    if (s.workspace !== prev.workspace) {
      for (const session of running.values()) session.broadcast("workspace", s.workspace.name);
    }
    if (s.agents !== prev.agents || s.presence !== prev.presence) agentsChanged();
  });

  onFileSaved((path) => {
    for (const session of running.values()) session.broadcast("saved", path);
  });
}

// One editor buffer per open file, shared by the user and the agents. A single
// EditorView shows whichever buffer is active; the others keep updating in
// the background, so agent edits land even in files nobody is looking at.
//
// The file on disk is the truth. Each buffer remembers the disk text it is
// based on; an agent's edit is shown in the buffer only when it was made to
// that same text, and a save only goes through if the disk still holds it.
// Otherwise a clean buffer is reloaded, and one with unsaved changes is put in
// conflict for the user to settle: nothing is overwritten or dropped silently.

import {
  Annotation,
  ChangeSet,
  EditorState,
  type ChangeDesc,
  type StateEffect,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useSettings } from "../model/app-settings";
import { agentById, getBackend, notify, onWorkspaceChange, setConflict, setCursor, setDirty, useStore } from "../model/store";
import { caretOf, clearCaret, markLines, setCaret } from "./agents";
import { applyEditorSettings, createEditorState } from "./setup";

/** Marks transactions that replay an agent's edit, so they never count as unsaved user changes. */
export const agentEdit = Annotation.define<string>();

/** Edits to files larger than this appear at once instead of being typed out. */
const MAX_TYPED_BYTES = 256 * 1024;

const sessions = new Map<string, EditorState>();
const loading = new Map<string, Promise<EditorState>>();
/** The disk text each buffer is based on. */
const bases = new Map<string, string>();
/** Agent edits already on disk but not yet shown in the buffer, per file. */
const pending = new Map<string, number>();
/** Files whose pending edits should finish at once because a save is waiting. */
const hurry = new Set<string>();
const settled = new Map<string, (() => void)[]>();
/**
 * Positions in a buffer that an agent's edit is still to reach, kept in step
 * with every change to it (the user may type while the agent's edit plays out).
 */
const anchors = new Map<string, Set<Anchor>>();
interface Anchor {
  from: number;
  to: number;
}
let view: EditorView | null = null;
let viewPath: string | null = null;

function mapAnchors(path: string, changes: ChangeDesc) {
  for (const a of anchors.get(path) ?? []) {
    a.from = changes.mapPos(a.from, 1);
    a.to = Math.max(a.from, changes.mapPos(a.to, -1));
  }
}

const tracker = EditorView.updateListener.of((u) => {
  if (!viewPath || u.view !== view) return;
  if (u.docChanged) mapAnchors(viewPath, u.changes);
  if (u.transactions.some((tr) => tr.docChanged && !tr.annotation(agentEdit))) setDirty(viewPath, true);
  if (u.selectionSet || u.docChanged) {
    const head = u.state.selection.main.head;
    const line = u.state.doc.lineAt(head);
    setCursor(line.number, head - line.from + 1);
  }
});

onWorkspaceChange(() => {
  sessions.clear();
  anchors.clear();
  loading.clear();
  bases.clear();
  pending.clear();
  hurry.clear();
  settled.forEach((waiters) => waiters.forEach((done) => done()));
  settled.clear();
  viewPath = null;
  view?.setState(EditorState.create({ doc: "" }));
});

export function attachView(v: EditorView | null) {
  // Keep the shown buffer, including anything typed into it, before the view goes away.
  if (view && viewPath) sessions.set(viewPath, view.state);
  view = v;
  viewPath = null;
}

export async function ensureSession(path: string): Promise<EditorState> {
  const ready = sessions.get(path);
  if (ready) return ready;
  let load = loading.get(path);
  if (!load) {
    load = getBackend()
      .read(path)
      .then((text) => {
        const state = createEditorState(path, text, tracker);
        sessions.set(path, state);
        bases.set(path, text);
        return state;
      })
      .finally(() => loading.delete(path));
    loading.set(path, load);
  }
  return load;
}

export function stateOf(path: string): EditorState | undefined {
  return path === viewPath && view ? view.state : sessions.get(path);
}

/** Shows a loaded buffer in the editor, keeping the previous one's state. */
export function showPath(path: string) {
  const next = sessions.get(path);
  if (!view || !next || path === viewPath) return;
  if (viewPath) sessions.set(viewPath, view.state);
  view.setState(next);
  viewPath = path;
  const head = next.selection.main.head;
  const line = next.doc.lineAt(head);
  setCursor(line.number, head - line.from + 1);
}

/** Brings every buffer, shown or not, up to the current editor settings. */
export function reconfigureAll() {
  const effects = applyEditorSettings();
  for (const path of [...sessions.keys()]) {
    if (path === viewPath && view) continue;
    sessions.set(path, sessions.get(path)!.update({ effects }).state);
  }
  view?.dispatch({ effects });
}

// Settings apply as they change; buffers made later start with them.
useSettings.subscribe((now, before) => {
  if (now.editor !== before.editor) reconfigureAll();
});

export function dispatchTo(path: string, spec: TransactionSpec) {
  if (path === viewPath && view) {
    view.dispatch(spec); // the tracker maps the anchors
    return;
  }
  const state = sessions.get(path);
  if (!state) return;
  const tr = state.update(spec);
  if (tr.docChanged) mapAnchors(path, tr.changes);
  sessions.set(path, tr.state);
}

const isDirty = (path: string) => Boolean(useStore.getState().dirty[path]);
const inConflict = (path: string) => Boolean(useStore.getState().conflicts[path]);

// ---- Saving ----

const savedListeners = new Set<(path: string) => void>();

/** Calls `listener` with the path after each save the user makes; the returned function stops it. */
export function onFileSaved(listener: (path: string) => void): () => void {
  savedListeners.add(listener);
  return () => void savedListeners.delete(listener);
}

function announceSaved(path: string) {
  for (const listener of [...savedListeners]) {
    try {
      listener(path);
    } catch (e) {
      console.error(e);
    }
  }
}

/** Waits until every agent edit announced for `path` shows in its buffer, typing the rest out at once. */
function waitForEdits(path: string): Promise<void> {
  if (!pending.get(path)) return Promise.resolve();
  hurry.add(path);
  return new Promise((done) => settled.set(path, [...(settled.get(path) ?? []), done]));
}

/** Saves the buffer, unless the file changed on disk in a way the buffer has not taken in. */
export async function save(path: string) {
  if (!stateOf(path)) return;
  if (inConflict(path)) {
    notify("This file changed on disk while you had unsaved changes. Choose a version above the editor first.");
    return;
  }
  await waitForEdits(path);
  const content = stateOf(path)?.doc.toString();
  if (content === undefined) return;
  try {
    const saved = await getBackend().write(path, content, bases.get(path) ?? "");
    if (!saved) {
      setConflict(path, { agentId: null });
      return;
    }
    bases.set(path, content);
    // Anything typed while the save was on its way is still unsaved.
    setDirty(path, stateOf(path)?.doc.toString() !== content);
    announceSaved(path);
  } catch (e) {
    notify(`Could not save ${path}: ${e}`);
  }
}

/** Settles a conflict by saving the buffer over whatever is on disk. */
export async function keepMine(path: string) {
  const content = stateOf(path)?.doc.toString();
  if (content === undefined) return;
  try {
    await getBackend().write(path, content);
    bases.set(path, content);
    setConflict(path, null);
    setDirty(path, false);
    announceSaved(path);
  } catch (e) {
    notify(`Could not save ${path}: ${e}`);
  }
}

/** Settles a conflict by dropping the unsaved changes and showing the file on disk. */
export async function useDiskVersion(path: string) {
  try {
    await reload(path);
  } catch (e) {
    notify(`Could not read ${path}: ${e}`);
  }
}

/** Reloads a buffer from disk, dropping unsaved changes. */
async function reload(path: string) {
  const text = await getBackend().read(path);
  const state = stateOf(path);
  if (!state) return;
  if (state.doc.toString() !== text) {
    dispatchTo(path, { changes: { from: 0, to: state.doc.length, insert: text }, annotations: agentEdit.of("disk") });
  }
  bases.set(path, text);
  setDirty(path, false);
  setConflict(path, null);
}

/**
 * After a command ran: brings open buffers up to date with what is now on
 * disk. A clean buffer is reloaded; one with unsaved changes goes into conflict.
 */
export async function checkDisk() {
  for (const path of [...sessions.keys()]) {
    if (pending.get(path) || inConflict(path)) continue;
    let text: string;
    try {
      text = await getBackend().read(path);
    } catch {
      continue; // Moved or deleted; the file list shows that.
    }
    if (pending.get(path) || text === bases.get(path) || !stateOf(path)) continue;
    if (isDirty(path)) setConflict(path, { agentId: null });
    else await reload(path);
  }
}

// ---- Agent edits ----

/** Opens the agent's file in the editor if the user is following that agent. */
function followInto(agentId: string, path: string) {
  const { following, openTabs, activePath } = useStore.getState();
  if (following !== agentId || activePath === path) return;
  useStore.setState({ openTabs: openTabs.includes(path) ? openTabs : [...openTabs, path], activePath: path });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AgentEdit {
  agentId: string;
  path: string;
  /** The whole file before the edit; null if it was too large to send. */
  before: string | null;
  find: string;
  replace: string;
  replaceAll: boolean;
}

/** Call as soon as an agent's edit is on disk, before showing it, so a save waits for it. */
export function expectEdit(path: string) {
  pending.set(path, (pending.get(path) ?? 0) + 1);
}

function editShown(path: string) {
  const left = (pending.get(path) ?? 1) - 1;
  if (left > 0) {
    pending.set(path, left);
    return;
  }
  pending.delete(path);
  hurry.delete(path);
  settled.get(path)?.forEach((done) => done());
  settled.delete(path);
}

/**
 * Shows an agent's edit, already on disk, in the file's buffer: typed out at
 * the agent's speed, or at once when the user chose that in the settings, or
 * when it is large or replaces every match.
 * Pair every call with an earlier `expectEdit(path)`.
 */
export async function showAgentEdit(e: AgentEdit) {
  try {
    await show(e);
  } finally {
    editShown(e.path);
  }
}

async function show(e: AgentEdit) {
  const { agentId, path, before } = e;
  const open = sessions.has(path) || loading.has(path);
  if (!open) {
    // Nobody had this file open: start from its old content, so the edit can play out.
    if (before === null) return;
    sessions.set(path, createEditorState(path, before, tracker));
    bases.set(path, before);
  }
  await ensureSession(path);
  followInto(agentId, path);

  const doc = stateOf(path)!.doc.toString();
  const after = before === null ? null : apply(before, e.find, e.replace, e.replaceAll);
  // The agent's changes, line by line, and where each lands in the buffer.
  // They only apply to a buffer based on the text the agent changed, and
  // never onto lines the user has changed and not saved.
  const placed = before === null || after === null || before !== bases.get(path) ? null : place(before, after, doc);
  if (!placed) {
    if (!isDirty(path)) await reload(path);
    else conflictWith(agentId, path);
    return;
  }
  const instant = useSettings.getState().editor.agentEdits === "instant";
  if (instant || e.replaceAll || before!.length > MAX_TYPED_BYTES || placed.length > MAX_TYPED_HUNKS) {
    applyAtOnce(agentId, path, placed);
  } else if (!(await typeHunks(agentId, path, placed))) {
    // The user typed inside a part the agent was still to change.
    conflictWith(agentId, path);
    return;
  }
  bases.set(path, after!);
}

function conflictWith(agentId: string, path: string) {
  if (inConflict(path)) return;
  setConflict(path, { agentId });
  const name = agentById(agentId)?.name ?? "An agent";
  notify(`${name} changed ${path.split("/").pop()} while you had unsaved changes. Choose a version above the editor.`);
}

/** The text after the agent's edit, as the core computed it; null if the edit does not apply. */
function apply(text: string, find: string, replace: string, all: boolean): string | null {
  if (find === "") return text === "" ? replace : null;
  if (!text.includes(find)) return null;
  return all ? text.split(find).join(replace) : text.replace(find, () => replace);
}

/** A change to a range of whole lines: `from`..`to` replaced by `insert`. */
interface Hunk {
  from: number;
  to: number;
  insert: string;
}

/** Edits replacing more separate parts than this appear at once instead of being typed. */
const MAX_TYPED_HUNKS = 6;
/** Above this many line pairs, the changed middle of a file is treated as one change. */
const MAX_DIFF_CELLS = 4_000_000;

const splitLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** The changes from `a` to `b` as replacements of whole-line ranges of `a`. */
function lineHunks(a: string, b: string): Hunk[] {
  if (a === b) return [];
  const A = splitLines(a);
  const B = splitLines(b);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const n = A.length - pre - suf;
  const m = B.length - pre - suf;
  const offset: number[] = [0];
  for (const line of A) offset.push(offset[offset.length - 1] + line.length);

  // Longest common subsequence of the changed middle, read back as hunks.
  const pairs: [number, number][] = [];
  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= MAX_DIFF_CELLS) {
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          A[pre + i] === B[pre + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    for (let i = 0, j = 0; i < n && j < m; ) {
      if (A[pre + i] === B[pre + j]) pairs.push([i++, j++]);
      else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) i++;
      else j++;
    }
  }
  pairs.push([n, m]);
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of pairs) {
    if (pi > i || pj > j) {
      hunks.push({ from: offset[pre + i], to: offset[pre + pi], insert: B.slice(pre + j, pre + pj).join("") });
    }
    i = pi + 1;
    j = pj + 1;
  }
  return hunks;
}

/**
 * Places the agent's changes (`before` to `after`) in the buffer `doc`, which
 * is `before` plus the user's unsaved changes. Null when a change of the
 * agent's touches or borders lines the user changed.
 */
function place(before: string, after: string, doc: string): Hunk[] | null {
  const theirs = lineHunks(before, after);
  const ours = doc === before ? [] : lineHunks(before, doc);
  const placed: Hunk[] = [];
  for (const t of theirs) {
    let shift = 0;
    for (const o of ours) {
      if (o.from <= t.to && t.from <= o.to) return null;
      if (o.to <= t.from) shift += o.insert.length - (o.to - o.from);
    }
    placed.push({ from: t.from + shift, to: t.to + shift, insert: t.insert });
  }
  return placed;
}

function applyAtOnce(agentId: string, path: string, hunks: Hunk[]) {
  const length = stateOf(path)!.doc.length;
  const changes = ChangeSet.of(hunks, length);
  const effects: StateEffect<unknown>[] = [];
  let end = 0;
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (toB > fromB) effects.push(markLines.of({ agentId, from: fromB, to: toB }));
    end = toB;
  });
  effects.push(setCaret.of({ agentId, pos: end, mode: "typing" }));
  dispatchTo(path, { changes, effects, annotations: agentEdit.of(agentId) });
}

/** Types out each change in turn. False if the user changed a part before the agent reached it. */
async function typeHunks(agentId: string, path: string, hunks: Hunk[]): Promise<boolean> {
  const doc = stateOf(path)!.doc;
  const todo = hunks.map((h) => ({ anchor: { from: h.from, to: h.to }, old: doc.sliceString(h.from, h.to), insert: h.insert }));
  const tracked = anchors.get(path) ?? new Set<Anchor>();
  anchors.set(path, tracked);
  todo.forEach((t) => tracked.add(t.anchor));
  try {
    for (const t of todo) {
      const state = stateOf(path);
      if (!state || state.doc.sliceString(t.anchor.from, t.anchor.to) !== t.old) return false;
      tracked.delete(t.anchor);
      await typeOut(agentId, path, t.anchor.from, t.old, t.insert);
    }
    return true;
  } finally {
    todo.forEach((t) => tracked.delete(t.anchor));
    if (!tracked.size) anchors.delete(path);
  }
}

/** Types out the replacement of `find` (at `at`) with `replace` at the agent's speed. */
async function typeOut(agentId: string, path: string, at: number, find: string, replace: string) {
  let pre = 0;
  while (pre < find.length && pre < replace.length && find[pre] === replace[pre]) pre++;
  let suf = 0;
  while (
    suf < find.length - pre &&
    suf < replace.length - pre &&
    find[find.length - 1 - suf] === replace[replace.length - 1 - suf]
  )
    suf++;
  const from = at + pre;
  const text = replace.slice(pre, replace.length - suf);

  // Short edits type at the agent's speed; long ones speed up to finish in about eight seconds.
  const speed = () => Math.max(1, agentById(agentId)?.typingSpeed ?? 12);
  const perTick = Math.max(1, Math.ceil(text.length / (speed() * 8)));

  dispatchTo(path, {
    changes: { from, to: at + find.length - suf },
    effects: setCaret.of({ agentId, pos: from, mode: "typing" }),
    annotations: agentEdit.of(agentId),
  });
  let i = 0;
  while (i < text.length) {
    // A line break and the indentation after it arrive together; a waiting save takes the rest at once.
    let n = hurry.has(path) ? text.length - i : perTick;
    if (n === 1 && text[i] === "\n") while (text[i + n] === " ") n++;
    const chunk = text.slice(i, i + n);
    const state = stateOf(path);
    if (!state) break;
    const pos = caretOf(state, agentId)?.pos ?? from;
    const effects: StateEffect<unknown>[] = [
      setCaret.of({ agentId, pos: pos + chunk.length, mode: "typing" }),
      markLines.of({ agentId, from: pos, to: pos + chunk.length }),
    ];
    if (path === viewPath && useStore.getState().following === agentId) {
      effects.push(EditorView.scrollIntoView(pos, { y: "nearest", yMargin: 60 }));
    }
    dispatchTo(path, { changes: { from: pos, insert: chunk }, effects, annotations: agentEdit.of(agentId) });
    i += n;
    if (i < text.length) await sleep(1000 / speed());
  }
}

/** Shows an agent reading lines `fromLine`..`toLine` (1-based) of a file. */
export async function showReading(agentId: string, path: string, fromLine: number, toLine: number) {
  await ensureSession(path);
  const state = stateOf(path)!;
  const last = state.doc.line(Math.min(toLine, state.doc.lines));
  dispatchTo(path, { effects: setCaret.of({ agentId, pos: last.to, mode: "reading", fromLine }) });
}

export function hideCaret(agentId: string, path: string) {
  if (stateOf(path)) dispatchTo(path, { effects: clearCaret.of(agentId) });
}

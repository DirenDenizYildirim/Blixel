// Agents inside a file: their named cursors, the lines they added, and the
// lines they are reading. Everything is mapped through edits, so marks stay on
// the right lines while the user and agents type.

import { RangeSet, StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  gutter,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { agentById, hueOf } from "../model/store";
import { agentColor, agentTint } from "../theme/theme";

export interface AgentCaret {
  agentId: string;
  pos: number;
  mode: "typing" | "reading";
  /** For reading: the first line of the range (1-based). The caret sits at the end of the last. */
  fromLine?: number;
}

interface LineMark {
  agentId: string;
}

interface AgentState {
  carets: AgentCaret[];
  /** One point per marked line, at the line start. */
  marks: RangeSet<MarkValue>;
  /** Whether the user has placed their own cursor in this file yet. */
  userHere: boolean;
}

class MarkValue extends GutterMarker {
  constructor(readonly mark: LineMark) {
    super();
  }
  eq(other: MarkValue) {
    return other.mark.agentId === this.mark.agentId;
  }
  toDOM() {
    const el = document.createElement("span");
    el.textContent = "+";
    const agent = agentById(this.mark.agentId);
    if (agent) el.style.color = agentColor(hueOf(agent));
    return el;
  }
}

export const setCaret = StateEffect.define<AgentCaret>({
  map: (c, changes) => ({ ...c, pos: changes.mapPos(c.pos, 1) }),
});
export const clearCaret = StateEffect.define<string>();
/** Marks every line touched by the range [from, to] as added by the agent. */
export const markLines = StateEffect.define<{ agentId: string; from: number; to: number }>({
  map: (m, changes) => ({ ...m, from: changes.mapPos(m.from, -1), to: changes.mapPos(m.to, 1) }),
});

export const agentField = StateField.define<AgentState>({
  create: () => ({ carets: [], marks: RangeSet.empty, userHere: false }),
  update(value, tr) {
    const userHere = value.userHere || tr.isUserEvent("select") || tr.isUserEvent("input") || tr.isUserEvent("delete");
    let carets = value.carets.map((c) => ({ ...c, pos: tr.changes.mapPos(c.pos, 1) }));
    let marks = value.marks.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setCaret)) {
        carets = [...carets.filter((c) => c.agentId !== e.value.agentId), e.value];
      } else if (e.is(clearCaret)) {
        carets = carets.filter((c) => c.agentId !== e.value);
      } else if (e.is(markLines)) {
        const doc = tr.state.doc;
        const from = Math.min(e.value.from, doc.length);
        let to = Math.min(e.value.to, doc.length);
        // Text ending in a line break does not touch the line after it.
        if (to > from && doc.lineAt(to).from === to) to--;
        const first = doc.lineAt(from).number;
        const last = doc.lineAt(to).number;
        const starts = new Set<number>();
        const add: Range<MarkValue>[] = [];
        for (let n = first; n <= last; n++) {
          const from = doc.line(n).from;
          starts.add(from);
          add.push(new MarkValue({ agentId: e.value.agentId }).range(from));
        }
        marks = marks.update({ filter: (from) => !starts.has(from), add, sort: true });
      }
    }
    return { carets, marks, userHere };
  },
});

class CaretWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly color: string,
    readonly above: boolean,
    readonly bar: boolean,
  ) {
    super();
  }
  eq(o: CaretWidget) {
    return o.label === this.label && o.color === this.color && o.above === this.above && o.bar === this.bar;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-agent-caret" + (this.above ? " above" : "");
    wrap.style.setProperty("--c", this.color);
    if (this.bar) {
      const bar = document.createElement("span");
      bar.className = "bar";
      wrap.appendChild(bar);
    }
    const flag = document.createElement("span");
    flag.className = "flag";
    flag.textContent = this.label;
    wrap.appendChild(flag);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const { carets, marks, userHere } = state.field(agentField);
  const doc = state.doc;
  const ranges: Range<Decoration>[] = [];
  const typingLines = new Set<number>();
  for (const c of carets) if (c.mode === "typing") typingLines.add(doc.lineAt(Math.min(c.pos, doc.length)).from);

  // Lines the agents added: a light tint, stronger where an agent is typing.
  marks.between(0, doc.length, (from, _to, value) => {
    const agent = agentById(value.mark.agentId);
    if (!agent) return;
    const tint = agentTint(hueOf(agent), typingLines.has(from) ? 14 : 7);
    ranges.push(Decoration.line({ attributes: { style: `background: ${tint}` } }).range(from));
  });

  for (const c of carets) {
    const agent = agentById(c.agentId);
    if (!agent) continue;
    const hue = hueOf(agent);
    const pos = Math.min(c.pos, doc.length);
    if (c.mode === "reading" && c.fromLine) {
      const last = doc.lineAt(pos).number;
      for (let n = Math.max(1, c.fromLine); n <= last; n++) {
        ranges.push(Decoration.line({ attributes: { style: `background: ${agentTint(hue, 9)}` } }).range(doc.line(n).from));
      }
    }
    const label = c.mode === "reading" ? `${agent.name}, reading` : agent.name;
    const widget = new CaretWidget(label, agentColor(hue), c.mode === "reading", true);
    ranges.push(Decoration.widget({ widget, side: 1 }).range(pos));
  }

  // The user's own cursor gets a "you" flag whenever an agent is in the same file.
  if (carets.length && userHere) {
    const head = state.selection.main.head;
    ranges.push(Decoration.widget({ widget: new CaretWidget("you", "var(--accent)", false, false), side: 1 }).range(head));
  }
  return Decoration.set(ranges, true);
}

const decorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.transactions.some((t) => t.effects.length)) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const markGutter = gutter({
  class: "cm-agent-gutter",
  markers: (view) => view.state.field(agentField).marks,
  initialSpacer: () => new MarkValue({ agentId: "" }),
});

export const agentExtensions: Extension = [agentField, markGutter, decorations];

export function caretOf(state: EditorState, agentId: string) {
  return state.field(agentField).carets.find((c) => c.agentId === agentId);
}

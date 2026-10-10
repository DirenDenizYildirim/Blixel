// How the editor looks and behaves, with a small live editor to see it in.
// Open files take each change at once (editor/sessions.ts follows the settings).

import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { Segmented } from "../components/controls";
import { applyEditorSettings, createEditorState } from "../editor/setup";
import { FONT_SIZES, lineHeightFor, updateEditor, useSettings } from "../model/app-settings";
import type { EditorSettings as Settings } from "../model/types";
import { Toggle } from "./Toggle";

/** A few lines with ligatures, indentation and one long line, indented as the settings say. */
function sample(s: Settings): string {
  const i = s.indent === "tabs" ? "\t" : " ".repeat(s.tabSize);
  return [
    "export function greet(names: string[]) {",
    `${i}for (const name of names) {`,
    `${i}${i}if (name !== "" && name.length >= 2) console.log(\`Hello, \${name}! Good to see you again; the tests are waiting for you.\`);`,
    `${i}}`,
    `${i}return names.map((n) => n.trim());`,
    "}",
  ].join("\n");
}

function Preview() {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const settings = useSettings((s) => s.editor);

  useEffect(() => {
    const v = new EditorView({ parent: host.current! });
    view.current = v;
    return () => v.destroy();
  }, []);

  // A fresh buffer when the indentation changes; otherwise only the settings are swapped.
  const { indent, tabSize } = settings;
  useEffect(() => {
    const doc = sample(useSettings.getState().editor);
    const line3 = doc.split("\n").slice(0, 2).join("\n").length + 1;
    view.current?.setState(
      createEditorState("preview.ts", doc, [EditorState.readOnly.of(true), EditorView.editable.of(false)]).update({
        selection: EditorSelection.cursor(line3 + 4),
      }).state,
    );
  }, [indent, tabSize]);
  useEffect(() => {
    view.current?.dispatch({ effects: applyEditorSettings(settings) });
  }, [settings]);

  return <div ref={host} className="editor-preview" aria-label="Preview of the editor" role="img" />;
}

export function EditorSettings() {
  const s = useSettings((all) => all.editor);
  return (
    <section id="settings-editor" aria-labelledby="settings-editor-title" className="panel">
      <h2 id="settings-editor-title" className="tight">
        Editor
      </h2>
      <div className="hint-line">How files look and behave in the editor, for you and for the agents typing in them.</div>
      <Preview />

      <div className="set-block first">
        <h3>Text</h3>
        <div className="tool-row">
          <div className="tool-text">
            <span>Font size</span>
            <span className="label">
              {s.fontSize} px, lines {lineHeightFor(s.fontSize)} px apart
            </span>
          </div>
          <input
            type="range"
            className="range settings-range"
            aria-label="Font size"
            min={FONT_SIZES.min}
            max={FONT_SIZES.max}
            step={1}
            value={s.fontSize}
            onChange={(e) => updateEditor({ fontSize: Number(e.target.value) })}
          />
        </div>
        <div className="tool-row">
          <div className="tool-text">
            <span>Ligatures</span>
            <span className="label">Fira Code draws =&gt;, !== and &gt;= as single signs</span>
          </div>
          <Toggle label="Ligatures" checked={s.ligatures} onChange={(on) => updateEditor({ ligatures: on })} />
        </div>
      </div>

      <div className="set-block">
        <h3>Indentation</h3>
        <div className="tool-row">
          <div className="tool-text">
            <span>Tab size</span>
            <span className="label">How wide a tab shows, and one step of indentation</span>
          </div>
          <Segmented
            label="Tab size"
            value={String(s.tabSize) as "2" | "4" | "8"}
            options={[
              { value: "2", label: "2" },
              { value: "4", label: "4" },
              { value: "8", label: "8" },
            ]}
            onChange={(v) => updateEditor({ tabSize: Number(v) as 2 | 4 | 8 })}
          />
        </div>
        <div className="tool-row">
          <div className="tool-text">
            <span>Indent with</span>
            <span className="label">What Tab and new lines insert</span>
          </div>
          <Segmented
            label="Indent with"
            value={s.indent}
            options={[
              { value: "spaces", label: "Spaces" },
              { value: "tabs", label: "Tabs" },
            ]}
            onChange={(v) => updateEditor({ indent: v })}
          />
        </div>
      </div>

      <div className="set-block">
        <h3>Display</h3>
        <div className="tool-row">
          <div className="tool-text">
            <span>Wrap long lines</span>
            <span className="label">Instead of scrolling sideways</span>
          </div>
          <Toggle label="Wrap long lines" checked={s.wordWrap} onChange={(on) => updateEditor({ wordWrap: on })} />
        </div>
        <div className="tool-row">
          <div className="tool-text">
            <span>Line numbers</span>
          </div>
          <Toggle label="Line numbers" checked={s.lineNumbers} onChange={(on) => updateEditor({ lineNumbers: on })} />
        </div>
        <div className="tool-row">
          <div className="tool-text">
            <span>Highlight the current line</span>
          </div>
          <Toggle label="Highlight the current line" checked={s.activeLine} onChange={(on) => updateEditor({ activeLine: on })} />
        </div>
      </div>

      <div className="set-block">
        <h3>Agents' edits</h3>
        <div className="tool-row">
          <div className="tool-text">
            <span>Show them</span>
            <span className="label">
              {s.agentEdits === "typed"
                ? "Typed out at each agent's own speed, so you can follow along"
                : "Whole at once, with the changed lines marked"}
            </span>
          </div>
          <Segmented
            label="Show agents' edits"
            value={s.agentEdits}
            options={[
              { value: "typed", label: "Typed at their speed" },
              { value: "instant", label: "At once" },
            ]}
            onChange={(v) => updateEditor({ agentEdits: v })}
          />
        </div>
      </div>
    </section>
  );
}

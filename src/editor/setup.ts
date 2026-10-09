import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { agentExtensions } from "./agents";

const LANGUAGES: Record<string, { label: string; ext: () => Extension }> = {
  ts: { label: "TypeScript", ext: () => javascript({ typescript: true }) },
  tsx: { label: "TypeScript", ext: () => javascript({ typescript: true, jsx: true }) },
  js: { label: "JavaScript", ext: () => javascript() },
  mjs: { label: "JavaScript", ext: () => javascript() },
  jsx: { label: "JavaScript", ext: () => javascript({ jsx: true }) },
  json: { label: "JSON", ext: () => json() },
  md: { label: "Markdown", ext: () => markdown() },
  rs: { label: "Rust", ext: () => rust() },
  css: { label: "CSS", ext: () => css() },
  html: { label: "HTML", ext: () => html() },
  py: { label: "Python", ext: () => python() },
};

function extOf(path: string) {
  const name = path.split("/").pop() ?? "";
  return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
}

export function languageLabel(path: string): string {
  return LANGUAGES[extOf(path)]?.label ?? "Plain text";
}

// Syntax colours come from the theme tokens, so switching themes needs no rebuild.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword, t.modifier], color: "var(--kw)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--str)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "var(--type)" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))],
    color: "var(--fn)",
  },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--com)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--type)" },
  { tag: t.heading, color: "var(--strong)", fontWeight: "600" },
  { tag: [t.link, t.url], color: "var(--accent)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.invalid, color: "var(--danger-fg)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--fg)", backgroundColor: "transparent", fontSize: "14px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "22px", padding: "12px 0" },
  ".cm-content": { caretColor: "var(--accent)", padding: "0 16px 0 0" },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--accent)", marginLeft: "-1px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "var(--sel) !important" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--com)" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "40px", padding: "0", textAlign: "right" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--strong)" },
  ".cm-agent-gutter .cm-gutterElement": { width: "24px", textAlign: "center" },
  ".cm-matchingBracket": { backgroundColor: "var(--line)", outline: "none" },
});

export function createEditorState(path: string, doc: string, extra: Extension = []): EditorState {
  const lang = LANGUAGES[extOf(path)];
  return EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      agentExtensions,
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      syntaxHighlighting(highlight),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorState.tabSize.of(2),
      theme,
      lang ? lang.ext() : [],
      extra,
    ],
  });
}

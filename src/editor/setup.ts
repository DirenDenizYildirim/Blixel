import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, type Extension, type StateEffect } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { lineHeightFor, useSettings } from "../model/app-settings";
import type { EditorSettings } from "../model/types";
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
  "&": { height: "100%", color: "var(--fg)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", padding: "12px 0" },
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
  // See-through, so a selection on the line still shows.
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--line) 40%, transparent)" },
});

// ---- The user's editor settings, swapped in place through one compartment ----

const prefs = new Compartment();

// A theme per size and per ligature choice, made once: a new theme each time would add a new style sheet.
const sizeThemes = new Map<number, Extension>();
function sizeTheme(fontSize: number): Extension {
  let ext = sizeThemes.get(fontSize);
  if (!ext) {
    ext = EditorView.theme({
      "&": { fontSize: `${fontSize}px` },
      ".cm-scroller": { lineHeight: `${lineHeightFor(fontSize)}px` },
    });
    sizeThemes.set(fontSize, ext);
  }
  return ext;
}
// Fira Code draws its ligatures through contextual alternates, which "none" turns off.
const ligaturesOn = EditorView.theme({ ".cm-content": { fontVariantLigatures: "normal" } });
const ligaturesOff = EditorView.theme({ ".cm-content": { fontVariantLigatures: "none" } });
const wrap = EditorView.lineWrapping;
const numbers = lineNumbers();
const activeLine = [highlightActiveLine(), highlightActiveLineGutter()];

function prefsExtension(s: EditorSettings): Extension {
  return [
    s.lineNumbers ? numbers : [],
    s.activeLine ? activeLine : [],
    sizeTheme(s.fontSize),
    s.ligatures ? ligaturesOn : ligaturesOff,
    s.wordWrap ? wrap : [],
    EditorState.tabSize.of(s.tabSize),
    indentUnit.of(s.indent === "tabs" ? "\t" : " ".repeat(s.tabSize)),
  ];
}

/** The effect that brings a buffer up to the given (or current) editor settings. */
export function applyEditorSettings(settings: EditorSettings = useSettings.getState().editor): StateEffect<unknown> {
  return prefs.reconfigure(prefsExtension(settings));
}

export function createEditorState(path: string, doc: string, extra: Extension = []): EditorState {
  const lang = LANGUAGES[extOf(path)];
  return EditorState.create({
    doc,
    extensions: [
      // First, so the line numbers stay left of the agents' gutter.
      prefs.of(prefsExtension(useSettings.getState().editor)),
      agentExtensions,
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      syntaxHighlighting(highlight),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      theme,
      lang ? lang.ext() : [],
      extra,
    ],
  });
}

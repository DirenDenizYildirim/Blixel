import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { attachView, ensureSession, keepMine, showPath, useDiskVersion } from "../editor/sessions";
import { languageLabel } from "../editor/setup";
import { ViewMenuButton } from "../layout/ViewMenu";
import { isOpen, setChatOpen, setEditorOpen, useLayout } from "../model/layout";
import { closeTab, hueOf, notify, openFile, setFollowing, useStore } from "../model/store";
import { agentColor } from "../theme/theme";
import { ChatIcon, CloseIcon } from "./icons";

const baseName = (path: string) => path.split("/").pop() ?? path;

/** The open files. The shell and the status bar are drawn by the layout, so they can sit anywhere. */
export function EditorPanel() {
  return (
    <main className="editor-panel">
      <Tabs />
      <ConflictBar />
      <div className="code-card">
        <CodeEditor />
      </div>
    </main>
  );
}

function Tabs() {
  const openTabs = useStore((s) => s.openTabs);
  const activePath = useStore((s) => s.activePath);
  const dirty = useStore((s) => s.dirty);
  const conflicts = useStore((s) => s.conflicts);
  const presence = useStore((s) => s.presence);
  const agents = useStore((s) => s.agents);
  const chatOpen = useLayout((l) => isOpen(l, "chat"));

  return (
    <div className="tabs" role="tablist" data-tauri-drag-region>
      {!chatOpen && (
        <button type="button" className="reopen-btn" aria-label="Show chat" title="Show the chat" onClick={() => setChatOpen(true)}>
          <ChatIcon />
          <span>Chat</span>
        </button>
      )}
      {openTabs.map((path) => {
        const here = agents.filter((a) => presence[a.id]?.path === path);
        return (
          <div key={path} className="tab" role="tab" aria-selected={path === activePath} title={path}>
            <button type="button" className="tab-name" onClick={() => openFile(path)}>
              {baseName(path)}
            </button>
            {conflicts[path] ? (
              <span className="dot" title="Changed on disk while you had unsaved changes" style={{ background: "var(--warn)" }} />
            ) : (
              dirty[path] && <span className="dot" title="Unsaved changes" style={{ background: "var(--fg)" }} />
            )}
            {here.map((a) => (
              <span key={a.id} className="dot" title={`${a.name} is here`} style={{ background: agentColor(hueOf(a)) }} />
            ))}
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${baseName(path)}`}
              onClick={() => {
                if (dirty[path]) notify(`${baseName(path)} has unsaved changes; they stay in memory until you save.`);
                closeTab(path);
              }}
            >
              <CloseIcon size={10} />
            </button>
          </div>
        );
      })}
      <span className="grow" data-tauri-drag-region />
      <span className="head-tools tabs-tool">
        <ViewMenuButton view="editor" />
        {chatOpen && (
          <button type="button" className="icon-btn small muted" aria-label="Hide editor" title="Hide editor" onClick={() => setEditorOpen(false)}>
            <CloseIcon size={11} />
          </button>
        )}
      </span>
    </div>
  );
}

/** Shown when the open file changed on disk while it had unsaved changes: the user picks a version. */
function ConflictBar() {
  const path = useStore((s) => s.activePath);
  const conflict = useStore((s) => (s.activePath ? s.conflicts[s.activePath] : undefined));
  const by = useStore((s) => s.agents.find((a) => a.id === conflict?.agentId));
  if (!path || !conflict) return null;
  const file = baseName(path);
  return (
    <div className="conflict-bar" role="alert">
      <span className="grow">
        {by ? `${by.name} changed ${file}` : `${file} changed on disk`} while you had unsaved changes. Your version is
        still in the editor; nothing is saved until you choose.
      </span>
      <button type="button" className="btn" title="Save your version over the one on disk" onClick={() => void keepMine(path)}>
        Keep mine
      </button>
      <button type="button" className="btn" title="Drop your unsaved changes" onClick={() => void useDiskVersion(path)}>
        Use the version on disk
      </button>
    </div>
  );
}

/** The editor on screen, for putting the cursor in it from a command. */
let shown: EditorView | null = null;

export function focusEditor() {
  if (shown && useStore.getState().activePath) shown.focus();
}

function CodeEditor() {
  const host = useRef<HTMLDivElement>(null);
  const activePath = useStore((s) => s.activePath);
  const workspace = useStore((s) => s.workspace);

  useEffect(() => {
    const view = new EditorView({ state: EditorState.create({ doc: "" }), parent: host.current! });
    attachView(view);
    shown = view;
    return () => {
      if (shown === view) shown = null;
      attachView(null);
      view.destroy();
    };
  }, []);

  useEffect(() => {
    if (!activePath) return;
    let cancelled = false;
    ensureSession(activePath)
      .then(() => {
        if (!cancelled) showPath(activePath);
      })
      .catch((e) => notify(String(e)));
    return () => {
      cancelled = true;
    };
  }, [activePath, workspace]);

  return (
    <>
      <div ref={host} className="cm-host" hidden={!activePath} />
      {!activePath && <div className="editor-empty">Open a file from the sidebar.</div>}
    </>
  );
}

/** The editor's follow and cursor bar, drawn at the bottom of the editor's column. */
export function StatusBar() {
  const following = useStore((s) => s.agents.find((a) => a.id === s.following));
  const selected = useStore((s) => s.agents.find((a) => a.id === s.selectedId));
  const cursor = useStore((s) => s.cursor);
  const activePath = useStore((s) => s.activePath);
  const target = following ?? selected;

  return (
    <div className="statusbar">
      {target && (
        <button
          type="button"
          className="follow-btn"
          aria-pressed={Boolean(following)}
          onClick={() => setFollowing(following ? null : target.id)}
        >
          <span className="dot" style={{ background: following ? agentColor(hueOf(following)) : "var(--muted)" }} />
          <span>{following ? `Following ${following.name}` : `Follow ${target.name}`}</span>
        </button>
      )}
      {following && <span>typing at {following.typingSpeed} chars/s</span>}
      <span className="push-right">{activePath ? `Ln ${cursor.line}, Col ${cursor.col}` : ""}</span>
      <span>{activePath ? languageLabel(activePath) : ""}</span>
    </div>
  );
}

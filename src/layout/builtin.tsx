// The views built into the app. Mods add theirs through the same registry.

import { ChatPanel } from "../components/ChatPanel";
import { EditorPanel } from "../components/EditorPanel";
import { ShellPanel } from "../components/ShellPanel";
import { TasksPanel } from "../components/TasksPanel";
import { registerView } from "./views";

let registered = false;

/** Call before the first render, so the default layout has something to draw. */
export function registerBuiltinViews() {
  if (registered) return;
  registered = true;
  registerView({ id: "chat", title: "Chat", minWidth: 320, source: "core", render: () => <ChatPanel /> });
  registerView({ id: "editor", title: "Editor", minWidth: 360, source: "core", render: () => <EditorPanel /> });
  registerView({ id: "shell", title: "Shell", minWidth: 280, source: "core", render: () => <ShellPanel /> });
  registerView({ id: "tasks", title: "Tasks", minWidth: 280, source: "core", render: () => <TasksPanel /> });
}

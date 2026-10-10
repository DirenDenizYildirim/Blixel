import { useEffect } from "react";
import { AskCard } from "./components/AskCard";
import { checkDisk } from "./editor/sessions";
import { registerBuiltinViews } from "./layout/builtin";
import { registerLayoutCommands } from "./layout/commands";
import { Workspace } from "./layout/Workspace";
import { loadSettings } from "./model/app-settings";
import { startProjects } from "./model/projects";
import { listenToCore } from "./model/real-agent";
import { useStore } from "./model/store";

// The default layout needs its views before the first render.
registerBuiltinViews();

export default function App() {
  const notice = useStore((s) => s.notice);
  const ready = useStore((s) => s.ready);

  useEffect(() => {
    void listenToCore();
    void loadSettings();
    // The last project, or the demo with its opening scene.
    void startProjects();
    registerLayoutCommands();
  }, []);

  // Files may have changed in another program while the window was in the background.
  useEffect(() => {
    const onFocus = () => void checkDisk();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return (
    <div className="app">
      {ready && <Workspace />}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      <AskCard />
    </div>
  );
}

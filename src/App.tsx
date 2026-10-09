import { useEffect } from "react";
import { checkDisk } from "./editor/sessions";
import { registerBuiltinViews } from "./layout/builtin";
import { registerLayoutCommands } from "./layout/commands";
import { Workspace } from "./layout/Workspace";
import { playOpeningScene } from "./model/mock-agent";
import { listenToCore } from "./model/real-agent";
import { openFile, refreshTree, useStore } from "./model/store";

// The default layout needs its views before the first render.
registerBuiltinViews();

export default function App() {
  const notice = useStore((s) => s.notice);

  useEffect(() => {
    void listenToCore();
    void refreshTree().then(() => {
      openFile("src/agents/router.ts");
      playOpeningScene();
    });
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
      <Workspace />
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}

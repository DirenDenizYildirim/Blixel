import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/500.css";
import "@fontsource/fira-code/600.css";
import "@fontsource/fira-code/700.css";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installBuiltinCommands } from "./commands/builtin";
import { installKeys } from "./commands/keys";
import { mountPalette } from "./commands/Palette";
import { notify } from "./model/store";
import { loadMods } from "./mods/registry";
import { startHeartbeat, startModRuntime } from "./mods/runtime";
import "./styles.css";
import { installThemes } from "./theme/active";

// The theme (from the built-in mods) is applied before the first paint.
installThemes();
installBuiltinCommands();
installKeys();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
mountPalette();

// Installed mods come from the core; their code starts after the first paint.
startHeartbeat();
void loadMods()
  .catch((e) => notify(`Mods could not be loaded: ${e}`))
  .finally(() => requestAnimationFrame(() => startModRuntime()));

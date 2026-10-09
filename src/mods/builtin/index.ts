// Mods compiled into the app: the standard themes and layouts. They are always
// on, cannot be removed, and go through the same checks as any other mod.

import type { ModRecord } from "../types";
import { displayOnly, validateManifest } from "../validate";
import layouts from "./layouts/mod.json";
import themes from "./themes/mod.json";

function builtin(raw: unknown): ModRecord {
  const checked = validateManifest(raw, { builtin: true });
  const id = checked.ok ? checked.manifest.id : String((raw as { id?: unknown }).id);
  return {
    id,
    dir: "",
    dev: false,
    enabled: true,
    granted: [],
    manifest: checked.ok ? checked.manifest : displayOnly(raw, id),
    error: checked.ok ? null : checked.error,
    changed: false,
    builtin: true,
  };
}

export const BUILTIN_MODS: ModRecord[] = [builtin(themes), builtin(layouts)];

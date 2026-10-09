import { formatKey } from "../commands/keynames";

/** A key's parts as the user's system names them: "Ctrl+Shift+P" to Ctrl, Shift, P ("Ctrl++" ends in the plus key). */
function keyParts(key: string): string[] {
  const shown = formatKey(key);
  if (shown === "+") return ["+"];
  if (shown.endsWith("++")) return [...shown.slice(0, -2).split("+"), "+"];
  return shown.split("+");
}

/** A key drawn as small keycaps. */
export function Keycaps({ keys }: { keys: string }) {
  return (
    <span className="keycaps">
      {keyParts(keys).map((part, i) => (
        <kbd key={i} className="keycap">
          {part}
        </kbd>
      ))}
    </span>
  );
}

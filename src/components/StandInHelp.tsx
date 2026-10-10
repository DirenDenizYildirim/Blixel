// How to script the stand-in: the test program that follows instructions
// instead of a model. The lines listed here must match what the core's
// stand-in reads.

import { useState } from "react";
import { ChevronDown, ChevronRight } from "./icons";

const STEPS: { line: string; does: string }[] = [
  { line: "say <text>", does: "Replies with the text." },
  { line: "read <path>", does: "Reads a file." },
  { line: "edit <path>", does: "Changes a file. The lines after it: <<<, the old text, ===, the new text, >>>." },
  { line: "write <path>", does: "Writes a whole file. The lines after it: <<<, its text, >>>." },
  { line: "run <command>", does: "Runs a command." },
  { line: "call <connector> <tool> <json>", does: "Calls a connector's tool, the connector by its short name." },
  { line: "ask <title>", does: "Asks your permission, as for a tool, and waits." },
  { line: "cost <dollars>", does: "Reports what the session has cost so far, as Claude Code does after a turn." },
  { line: "sleep <time>", does: "Waits: 500 (milliseconds), 500ms or 2s. Stop ends it." },
  { line: "settings", does: "Says the model and thinking effort it runs on." },
  { line: "fail <reason>", does: "Ends the turn with an error." },
];

const EXAMPLE = `say Starting on it.
read README.md
edit README.md
<<<
# Old title
===
# New title
>>>
run npm test
sleep 2s
cost 0.12
say Done.`;

export function StandInHelp() {
  const [open, setOpen] = useState(false);
  return (
    <div className="top12">
      <button type="button" className="standin-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={11} color="currentColor" /> : <ChevronRight size={11} color="currentColor" />}
        <span>How to script it</span>
      </button>
      {open && (
        <div className="standin-body">
          <div className="label">
            Send it a message with one instruction per line. It works through them in order, with the same tools,
            permissions and limits as a real agent. A line it does not know comes back as it was; a message with no
            instructions costs $0.01.
          </div>
          <ul className="standin-steps">
            {STEPS.map((s) => (
              <li key={s.line}>
                <code>{s.line}</code>
                <span>{s.does}</span>
              </li>
            ))}
          </ul>
          <div className="label">For example:</div>
          <pre className="standin-example">{EXAMPLE}</pre>
        </div>
      )}
    </div>
  );
}

// The Mods page's side column: how many there are, what a mod can and can
// never do, and where to start making one.

import { showView } from "../../model/store";
import { CheckIcon, NoIcon } from "./icons";

const CAN: [string, string][] = [
  ["Themes", "colours for the whole app"],
  ["Layouts", "where chat, editor, shell go"],
  ["Rule packs", "limits and guidance for agents"],
  ["Commands", "with keys, in the palette"],
  ["Panels", "their own pages, in the layout"],
];

const CANNOT: string[] = [
  "Answer permission requests",
  "Change your agents",
  "Read your keys",
  "Type or send for you",
  "Reach the network",
];

export function ModsAside(props: { on: number; installed: number; builtin: number }) {
  return (
    <aside aria-label="About mods" className="mods-aside">
      <div className="mods-aside-block counts">
        <div className="label">On this computer</div>
        <div className="mods-counts">
          <div>
            <span className="mods-count-n">{props.on}</span>
            <span className="label">on</span>
          </div>
          <div>
            <span className="mods-count-n">{props.installed}</span>
            <span className="label">installed</span>
          </div>
          <div>
            <span className="mods-count-n">{props.builtin}</span>
            <span className="label">built in</span>
          </div>
        </div>
      </div>

      <div className="mods-aside-block">
        <div className="label">What mods can add</div>
        <ul className="mods-list">
          {CAN.map(([what, how]) => (
            <li key={what}>
              <span className="mods-list-mark ok">
                <CheckIcon />
              </span>
              <span className="mods-list-text">
                <span className="strong">{what}</span>
                <span className="mods-list-hint">{how}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mods-aside-block">
        <div className="label">What they never can</div>
        <ul className="mods-list">
          {CANNOT.map((what) => (
            <li key={what}>
              <span className="mods-list-mark no">
                <NoIcon />
              </span>
              <span>{what}</span>
            </li>
          ))}
        </ul>
        <div className="mods-aside-foot">A mod's code runs in a sandbox and sees only what you allow when you turn it on.</div>
      </div>

      <div className="mods-aside-block">
        <div className="label">Make your own</div>
        <div className="mods-make">
          <div>
            A mod is a folder with a <code>mod.json</code>. The guide is in <code>docs/mods.md</code>, and working examples
            are in <code>examples/mods/</code>.
          </div>
          <div className="muted">Load it as a dev mod while you work on it.</div>
        </div>
      </div>

      <button type="button" className="btn big mods-back" onClick={() => showView({ kind: "main" })}>
        Back
      </button>
    </aside>
  );
}

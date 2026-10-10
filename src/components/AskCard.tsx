import { useEffect, useRef } from "react";
import { answerAsking, useStore } from "../model/store";
import "./ask.css";

/** The app's yes-or-no questions (see `ask` in the store), in a small card over the window. */
export function AskCard() {
  const q = useStore((s) => s.asking);
  const yes = useRef<HTMLButtonElement>(null);
  const no = useRef<HTMLButtonElement>(null);

  // A question that removes something starts on the safe answer.
  useEffect(() => {
    if (q) (q.danger ? no : yes).current?.focus();
  }, [q]);

  if (!q) return null;
  return (
    <div
      className="ask-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) answerAsking(false);
      }}
    >
      <div
        className="ask-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ask-title"
        aria-describedby={q.detail ? "ask-detail" : undefined}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            answerAsking(false);
          }
        }}
      >
        <div id="ask-title" className="ask-title">
          {q.title}
        </div>
        {q.detail && (
          <div id="ask-detail" className="ask-detail">
            {q.detail}
          </div>
        )}
        <div className="ask-actions">
          <button ref={no} type="button" className="btn" onClick={() => answerAsking(false)}>
            {q.no ?? "Cancel"}
          </button>
          <button ref={yes} type="button" className={"btn " + (q.danger ? "danger" : "primary")} onClick={() => answerAsking(true)}>
            {q.yes}
          </button>
        </div>
      </div>
    </div>
  );
}

// The menu floating by its button, such as a view's "⋯".

import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

export type MenuItem =
  | { label: string; run: () => void; disabled?: boolean; checked?: boolean; hint?: string }
  | "separator";

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** Closes on a click elsewhere, and when the window loses focus (a click into a mod's frame). */
function useCloseAway(inside: () => (HTMLElement | null | undefined)[], onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  const within = useRef(inside);
  within.current = inside;
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!within.current().some((el) => el?.contains(e.target as Node))) close.current();
    };
    const blur = () => close.current();
    window.addEventListener("mousedown", away);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("blur", blur);
    };
  }, []);
}

/** Arrow keys move between items; Escape closes. */
function onMenuKey(e: React.KeyboardEvent<HTMLElement>, close: () => void) {
  const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const go = (j: number) => buttons[(j + buttons.length) % buttons.length]?.focus();
  if (e.key === "ArrowDown") go(i + 1);
  else if (e.key === "ArrowUp") go(i < 0 ? -1 : i - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(-1);
  else if (e.key === "Escape") close();
  else return;
  e.preventDefault();
  e.stopPropagation();
}

function Items({ items, close }: { items: MenuItem[]; close: () => void }) {
  return items.map((item, i) =>
    item === "separator" ? (
      <div key={`sep${i}`} className="menu-sep" role="separator" />
    ) : (
      <button
        key={`${i}${item.label}`}
        type="button"
        role={item.checked === undefined ? "menuitem" : "menuitemradio"}
        aria-checked={item.checked}
        disabled={item.disabled}
        onClick={() => {
          close();
          item.run();
        }}
      >
        <span className="grow ellipsis">{item.label}</span>
        {item.hint && <span className="menu-hint">{item.hint}</span>}
      </button>
    ),
  );
}

/**
 * A menu floating by `anchor`: under it, or beside it with `beside` (for the
 * rail). It takes focus, and gives it back to the anchor when closed with Escape.
 */
export function PopupMenu(props: {
  anchor: HTMLElement | null;
  label: string;
  items: MenuItem[];
  beside?: boolean;
  onClose: () => void;
}) {
  const { anchor, beside } = props;
  const ref = useRef<HTMLDivElement>(null);
  useCloseAway(() => [ref.current, anchor], props.onClose);

  // Placed before paint, inside the window, flipping up or left when there is no room.
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!anchor || !menu) return;
    const a = anchor.getBoundingClientRect();
    // Beside the rail means beside its edge, not just its button.
    const edge = beside ? (anchor.closest("nav") ?? anchor).getBoundingClientRect() : a;
    const { offsetWidth: w, offsetHeight: h } = menu;
    const { innerWidth: vw, innerHeight: vh } = window;
    let left = beside ? edge.right + 6 : a.right - w;
    let top = beside ? a.top : a.bottom + 4;
    if (beside && left + w > vw - 8) left = edge.left - w - 6;
    if (!beside && top + h > vh - 8) top = a.top - h - 4;
    menu.style.left = `${clamp(left, 8, vw - w - 8)}px`;
    menu.style.top = `${clamp(top, 8, vh - h - 8)}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [anchor, beside]);

  const escape = () => {
    props.onClose();
    anchor?.focus();
  };

  return createPortal(
    <div ref={ref} className="menu" role="menu" aria-label={props.label} onKeyDown={(e) => onMenuKey(e, escape)}>
      <Items items={props.items} close={props.onClose} />
    </div>,
    document.body,
  );
}

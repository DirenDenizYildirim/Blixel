// A mod's view: its page in a sandboxed frame that fills the slot. The frame
// may run scripts but has an opaque origin, so it cannot reach the app. Its
// address carries a key of its own, which the page sends back to prove that
// the port the app hands over reached the page it opened; only that first
// page is connected. Moving the view remounts it: a new frame with a new key,
// which loads the page again.

import { useEffect, useState, type CSSProperties } from "react";
import { frameKey, withKey } from "./url";

const FILL: CSSProperties = { display: "block", width: "100%", height: "100%", border: 0, background: "var(--bg)" };

interface Props {
  src: string;
  title: string;
  /** The frame loaded a page; `key` is the one in its address. The session decides whether it gets a port. */
  connect: (frame: HTMLIFrameElement, key: string) => void;
  /** The frame went away: its port closes. */
  disconnect: (key: string) => void;
}

export function ModView({ src, title, connect, disconnect }: Props) {
  const [key] = useState(frameKey);
  useEffect(() => () => disconnect(key), [key, disconnect]);
  // onLoad is attached before the frame is inserted, so even a fast first load is not missed.
  return (
    <iframe
      title={title}
      src={withKey(src, key)}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={FILL}
      onLoad={(e) => connect(e.currentTarget, key)}
    />
  );
}

import { useId, useLayoutEffect, useRef } from "react";
import type { CSSProperties, JSX } from "react";
import { nameHue } from "./generator";
import type { AvatarMode, AvatarStyle } from "./generator";
import { animateAvatar } from "./ticker";
import type { AvatarHandle } from "./ticker";
import "./avatar.css";

export interface AvatarProps {
  name: string;
  style: AvatarStyle;
  mode: AvatarMode;
  /** Rendered size in px, e.g. 20, 32, 48, 220. */
  size: number;
  /** Overrides the hue derived from the name. */
  hue?: number;
  className?: string;
  /** When given the avatar is announced as an image with this label; otherwise it is hidden from assistive tech. */
  title?: string;
}

/** Sizes at or below this use the thicker strokes of `.small`. */
const SMALL_MAX = 48;

export function Avatar({ name, style, mode, size, hue, className, title }: AvatarProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const handleRef = useRef<AvatarHandle | null>(null);
  // Unique per instance and safe inside url(#...); only the goo style uses it.
  const filterId = "av-goo-" + useId().replace(/[^A-Za-z0-9_-]/g, "_");

  // Layout effects run in order: bind to the loop, then set the mode, then build the creature,
  // so the first frame is drawn with the right mode before the browser paints.
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handle = animateAvatar(svg, filterId);
    handleRef.current = handle;
    return () => {
      handle.dispose();
      if (handleRef.current === handle) handleRef.current = null;
    };
  }, [filterId]);

  useLayoutEffect(() => {
    handleRef.current?.setMode(mode);
  }, [mode, filterId]);

  useLayoutEffect(() => {
    handleRef.current?.setFigure(name, style);
  }, [name, style, filterId]);

  const h = hue ?? nameHue(name);
  const classes = "av" + (size <= SMALL_MAX ? " small" : "") + (className ? " " + className : "");
  const vars = { "--h": h.toFixed(1) } as CSSProperties;

  return (
    <svg
      ref={svgRef}
      className={classes}
      viewBox="-50 -50 100 100"
      width={size}
      height={size}
      style={vars}
      role={title ? "img" : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
    />
  );
}

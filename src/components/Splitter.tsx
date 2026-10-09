import { useRef } from "react";

/**
 * A draggable divider between two panels. `value` is the size of the panel it
 * controls; dragging toward that panel shrinks it when `invert` is set.
 * Arrow keys move it in steps; double-click resets it.
 */
export function Splitter(props: {
  axis: "x" | "y";
  label: string;
  value: number;
  min: number;
  max: number;
  invert?: boolean;
  onChange: (value: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<{ start: number; value: number } | null>(null);
  const sign = props.invert ? -1 : 1;
  const pos = (e: React.PointerEvent) => (props.axis === "x" ? e.clientX : e.clientY);

  return (
    <div
      role="separator"
      aria-label={props.label}
      aria-orientation={props.axis === "x" ? "vertical" : "horizontal"}
      aria-valuenow={props.value}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabIndex={0}
      className={`splitter splitter-${props.axis}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { start: pos(e), value: props.value };
        document.body.dataset.resizing = props.axis;
      }}
      onPointerMove={(e) => {
        if (drag.current) props.onChange(drag.current.value + (pos(e) - drag.current.start) * sign);
      }}
      onPointerUp={() => {
        drag.current = null;
        delete document.body.dataset.resizing;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        delete document.body.dataset.resizing;
      }}
      onDoubleClick={props.onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        const back = props.axis === "x" ? "ArrowLeft" : "ArrowUp";
        const fwd = props.axis === "x" ? "ArrowRight" : "ArrowDown";
        if (e.key === back) props.onChange(props.value - step * sign);
        else if (e.key === fwd) props.onChange(props.value + step * sign);
        else return;
        e.preventDefault();
      }}
    />
  );
}

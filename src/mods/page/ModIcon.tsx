// A mod's picture: pixel art on a rounded tile, drawn as crisp SVG squares.

import { memo, type ReactElement } from "react";
import type { PixelIcon } from "../types";

/** Draws the pixels; runs of one colour on a row become one rectangle. */
export const PixelArt = memo(function PixelArt({ icon, size }: { icon: PixelIcon; size: number }) {
  const rows = icon.pixels.map((row) => [...row]);
  const width = rows[0]?.length ?? 0;
  const rects: ReactElement[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const key = row[x];
      const fill = key === "." || key === " " ? undefined : icon.colors[key];
      let n = 1;
      while (x + n < row.length && row[x + n] === key) n++;
      if (fill) rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={n} height={1} fill={fill} />);
      x += n;
    }
  });
  return (
    <svg viewBox={`0 0 ${width} ${rows.length}`} width={size} height={size} shapeRendering="crispEdges" aria-hidden="true">
      {rects}
    </svg>
  );
});

/** The tile: the picture over a faint wash of its main colour. */
export function ModIcon({ icon, tint, size = 72 }: { icon: PixelIcon; tint: string; size?: number }) {
  // Whole screen pixels per icon pixel look sharpest: a 16-pixel icon at 4x on the usual 72 px tile.
  const grid = Math.max(icon.pixels.length, [...(icon.pixels[0] ?? "")].length, 1);
  const art = Math.floor((size - 8) / grid) * grid || size - 8;
  return (
    <div className="mod-icon" style={{ width: size, height: size, ["--tint" as string]: tint }}>
      <PixelArt icon={icon} size={art} />
    </div>
  );
}

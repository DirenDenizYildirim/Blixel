// The pictures the Mods page draws for mods without an icon of their own:
// one per kind of thing a mod adds, 16 by 16 pixels, coloured from the mod's
// id. Keys: o outline, d shade, m main, l light, w lightest, k ink; r y g b
// are paint colours. "." is empty.

import { nameHue } from "../../avatars/generator";
import type { Manifest, PixelIcon } from "../types";

const PALETTE = [
  "................",
  "................",
  "....oooooooo....",
  "..oolllllllloo..",
  ".olmmrrmmyymmdo.",
  "olmmmrrmmyymmmdo",
  "olmmmmmmmmmmggdo",
  "olmoommmmmmmggdo",
  "olo..ommmmmmmmdo",
  "olo..ommmbbmmmdo",
  ".odoommmmbbmmdo.",
  "..ooddddddddoo..",
  "....oooooooo....",
  "................",
  "................",
  "................",
];

const LAYOUT = [
  "................",
  ".oooooooooooooo.",
  ".olrlylgllllllo.",
  ".oooooooooooooo.",
  ".odddommmmowwwo.",
  ".odldomllmowbwo.",
  ".odddommmmowwwo.",
  ".odldomlllowbbo.",
  ".odddommmmowwwo.",
  ".odldomllmowbwo.",
  ".odddommmmowwwo.",
  ".odddommmmowbbo.",
  ".odddommmmowwwo.",
  ".oooooooooooooo.",
  "................",
  "................",
];

const SCROLL = [
  "................",
  "..oooooooooooo..",
  ".ollllllllllllo.",
  ".odmmmmmmmmmmdo.",
  "..oooooooooooo..",
  "...owwwwwwwwo...",
  "...owddddddwo...",
  "...owwwwwwwwo...",
  "...owddddwwwo...",
  "...owwwwwwwwo...",
  "...owddddddwo...",
  "...owwwwwwwwo...",
  "..oooooooooooo..",
  ".ollllllllllllo.",
  ".odmmmmmmmmmmdo.",
  "..oooooooooooo..",
];

const KEYCAP = [
  "................",
  "................",
  "..oooooooooooo..",
  ".ollllllllllllo.",
  ".olwwwwwwwwwwlo.",
  ".olwwkwwwwwwwlo.",
  ".olwwwkwwwwwwlo.",
  ".olwwwwkwwwwwlo.",
  ".olwwwkwwwwwwlo.",
  ".olwwkwwwkkkwlo.",
  ".olwwwwwwwwwwlo.",
  ".ommmmmmmmmmmmo.",
  ".oddddddddddddo.",
  ".oddddddddddddo.",
  "..oooooooooooo..",
  "................",
];

const PANEL = [
  "................",
  ".oooooooooooooo.",
  ".ollllllllllllo.",
  ".oooooooooooooo.",
  ".owwwwwwwwwwwwo.",
  ".owwwwwwwwwbbwo.",
  ".owwwwwwwwwbbwo.",
  ".owwwwwyywwbbwo.",
  ".owwwwwyywwbbwo.",
  ".owwggwyywwbbwo.",
  ".owwggwyywwbbwo.",
  ".owrggwyywwbbwo.",
  ".owwwwwwwwwwwwo.",
  ".oooooooooooooo.",
  "................",
  "................",
];

const BLOCK = [
  "................",
  "................",
  "...oooo..oooo...",
  "...ollo..ollo...",
  ".ooommoooommooo.",
  ".ollllllllllllo.",
  ".olmmmmmmmmmmdo.",
  ".olmmmmmmmmmmdo.",
  ".olmmmmmmmmmmdo.",
  ".olmmmmmmmmmmdo.",
  ".olmmmmmmmmmmdo.",
  ".olmmmmmmmmmmdo.",
  ".oddddddddddddo.",
  ".oooooooooooooo.",
  "................",
  "................",
];

/** The picture for what a mod adds, most telling first: a panel, then commands, rules, themes, layouts. */
function pictureFor(manifest: Manifest | null): string[] {
  const c = manifest?.contributes;
  if (c?.views?.length) return PANEL;
  if (c?.commands?.length) return KEYCAP;
  if (c?.rulePacks?.length) return SCROLL;
  if (c?.themes?.length) return PALETTE;
  if (c?.layouts?.length) return LAYOUT;
  return BLOCK;
}

/** Shades of one hue for the outline, shadow, body and light, plus fixed paint colours. */
function colours(hue: number): Record<string, string> {
  const h = hue.toFixed(1);
  return {
    o: `oklch(0.30 0.05 ${h})`,
    d: `oklch(0.50 0.11 ${h})`,
    m: `oklch(0.66 0.14 ${h})`,
    l: `oklch(0.80 0.11 ${h})`,
    w: `oklch(0.95 0.03 ${h})`,
    k: `oklch(0.30 0.05 ${h})`,
    r: "#e06c75",
    y: "#e5c07b",
    g: "#7fd99a",
    b: "#61afef",
  };
}

/** The mod's own icon, or the app's picture for what it adds in its own colour. */
export function modIcon(id: string, manifest: Manifest | null): { icon: PixelIcon; tint: string } {
  if (manifest?.icon) {
    const { colors } = manifest.icon;
    // The tile takes the icon's most used colour, faintly.
    const counts = new Map<string, number>();
    for (const row of manifest.icon.pixels) for (const ch of row) if (colors[ch]) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const main = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { icon: manifest.icon, tint: main ? colors[main] : "var(--muted)" };
  }
  const hue = nameHue(id);
  const palette = colours(hue);
  return { icon: { pixels: pictureFor(manifest), colors: palette }, tint: palette.m };
}

/** The picture for the empty list: a building block in the accent colour's hue family. */
export const EMPTY_ICON: PixelIcon = { pixels: BLOCK, colors: colours(15) };

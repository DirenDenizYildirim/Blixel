// The pictures for connectors: one per template, 16 by 16 pixels, drawn
// like the Mods page's (keys: o outline, d shade, m main, l light, w
// lightest; r y g b are paint colours; "." is empty). Each connector is
// coloured by a hue: its template's, or one from its own name.

import { nameHue } from "../avatars/generator";
import type { PixelIcon } from "../mods/types";

/** Branches off a line: code hosting, without anyone's logo. */
const BRANCH = [
  ".oooooo..oooooo.",
  ".ollllo..ollllo.",
  ".olwwlo..olwwlo.",
  ".olwwlo..olwwlo.",
  ".ollllo..ollllo.",
  ".oommoo..oommoo.",
  "..ommo...oommo..",
  "..ommo.ooommoo..",
  "..ommooommmoo...",
  "..ommommmooo....",
  ".oommmmooo......",
  ".oddddoo........",
  ".odwwdo.........",
  ".odwwdo.........",
  ".oddddo.........",
  ".oooooo.........",
];

/** A ticket with its tear-off line: issues and tasks. */
const TICKET = [
  "................",
  "................",
  "oooooooooooooooo",
  "ollllllllllllllo",
  "ommmmmmmmmwmmmmo",
  "ommwwwwwmmmmmmmo",
  "ommmmmmmmmwmmmmo",
  "ooomlllllmmmmooo",
  "ooomlllllmwmmooo",
  "ommmmmmmmmmmmmmo",
  "ommwwwwmmmwmmmmo",
  "ommmmmmmmmmmmmmo",
  "oddddddddddddddo",
  "oooooooooooooooo",
  "................",
  "................",
];

/** A beetle: errors and crashes. */
const BUG = [
  "................",
  ".....d....d.....",
  ".....odoodo.....",
  ".....odlldo.....",
  ".....oddddo.....",
  "...doommmmood...",
  "....dmlddmmd....",
  "....omlddmmo....",
  "....omlddmmo....",
  ".ddddmlddmmdddd.",
  "....ommddmmo....",
  "....ommddmmo....",
  "....domddmod....",
  "...d.oddddo.d...",
  ".....oooooo.....",
  "................",
];

/** An open book: library documentation. */
const BOOK = [
  "................",
  "................",
  ".oooooo..oooooo.",
  "oowwwwoooowwwwoo",
  "owwwwwwddwwwwwwo",
  "owwwwwwddwwwwwwo",
  "owmmmmwddwmmmmwo",
  "owwwwwwddwwwwwwo",
  "owmmmmwddwmmmmwo",
  "owwwwwwddwwwwwwo",
  "owmmmmwddwmmmmwo",
  "owwwwwwddwwwwwwo",
  "owwwwwlddlwwwwwo",
  "ommmmmmddmmmmmmo",
  "oooooooooooooooo",
  "................",
];

/** A cylinder of stacked discs: a database. */
const DATABASE = [
  "................",
  "...oooooooooo...",
  ".ooollllllllooo.",
  ".ollwwwwwwwwllo.",
  ".ollllllllllllo.",
  ".omddddddddddmo.",
  ".olmmmmmmmmmddo.",
  ".olmmmmmmmmmddo.",
  ".oldddddddddddo.",
  ".olmmmmmmmmmddo.",
  ".olmmmmmmmmmddo.",
  ".oldddddddddddo.",
  ".olmmmmmmmmmddo.",
  ".ooommmmmmmmooo.",
  "...oooooooooo...",
  "................",
];

/** A browser window with a page in it. */
const BROWSER = [
  "................",
  "oooooooooooooooo",
  "ollllllllllllllo",
  "olrlylglwwwwwwlo",
  "ollllllllllllllo",
  "owwwwwwwwwwwwwwo",
  "owwmmmmmmwwwwwwo",
  "owwwwwwwwwwwwwwo",
  "owwbbbwllllllwwo",
  "owwbbbwwwwwwwwwo",
  "owwbbbwlllllwwwo",
  "owwwwwwwwwwwwwwo",
  "owwmmmmmmmmwwwwo",
  "owwwwwwwwwwwwwwo",
  "oooooooooooooooo",
  "................",
];

/** A plug: anything else. */
const PLUG = [
  "................",
  ".....d....d.....",
  ".....d....d.....",
  "..ooodoooodooo..",
  "..ollllllllllo..",
  "..ommmmmmmmmdo..",
  "..ommmmmmmmmdo..",
  "..ommmmmmmmmdo..",
  "..oommmmmmmdoo..",
  "...oommmmmdoo...",
  "....oommmmoo....",
  ".....ooddoo.....",
  "......oddoo.....",
  "......ooddooo...",
  ".......oodddo...",
  "........ooooo...",
];

const PICTURES = { branch: BRANCH, ticket: TICKET, bug: BUG, book: BOOK, database: DATABASE, browser: BROWSER, plug: PLUG };

export type IconKind = keyof typeof PICTURES;

/** Shades of one hue for the outline, shadow, body and light, plus fixed paint colours. */
function colours(hue: number): Record<string, string> {
  const h = hue.toFixed(1);
  return {
    o: `oklch(0.30 0.05 ${h})`,
    d: `oklch(0.50 0.11 ${h})`,
    m: `oklch(0.66 0.14 ${h})`,
    l: `oklch(0.80 0.11 ${h})`,
    w: `oklch(0.95 0.03 ${h})`,
    r: "#e06c75",
    y: "#e5c07b",
    g: "#7fd99a",
    b: "#61afef",
  };
}

export interface TileArt {
  icon: PixelIcon;
  tint: string;
}

export function connectorArt(kind: IconKind, hue: number): TileArt {
  const palette = colours(hue);
  return { icon: { pixels: PICTURES[kind], colors: palette }, tint: palette.m };
}

/** A custom connector's hue, from its name for the tool prefix, so it keeps its colour. */
export const slugHue = (slug: string) => nameHue(slug);

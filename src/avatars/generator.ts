// Agent avatars, drawn from the agent's name. Ported from the design kit's avatar-lab.html.
// The same name always gives the same creature, and how it moves shows what the agent is doing.
// Everything that decides the creature's shape (hash, rng, recipes, eyes, the order of every
// random draw) must stay identical to the lab, or existing agents would change appearance.

export type AvatarStyle = "blob" | "goo" | "pixelblob" | "pixelgoo";
export type AvatarMode = "idle" | "working" | "waiting";

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The part of a DOMRect the gaze needs. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** How fast the creature's clock runs and how far its body wobbles. */
export interface Energy {
  readonly speed: number;
  readonly amp: number;
}

/** Where the eyes look (-1..1 on each axis) and how open they are. */
interface Look {
  lx: number;
  ly: number;
  open: number;
  mode: AvatarMode;
}

type Rng = () => number;

const TAU = Math.PI * 2;

/** The clock value used for the single still frame when motion is reduced. */
export const STILL_CLOCK = 7.3;

export const ENERGY: Readonly<Record<AvatarMode, Energy>> = {
  idle: { speed: 0.35, amp: 0.6 },
  working: { speed: 1.25, amp: 1.25 },
  waiting: { speed: 0.5, amp: 0.8 },
};

// ---- Seeded randomness: a name always produces the same numbers ----

/** FNV-1a, 32 bit. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32. */
function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A repeatable 0..1 value for a seed and up to three whole numbers. */
function noise(seed: number, a: number, b: number, c: number): number {
  let h =
    seed ^
    Math.imul((a | 0) + 1, 73856093) ^
    Math.imul((b | 0) + 1, 19349663) ^
    Math.imul((c | 0) + 1, 83492791);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function between(r: Rng, lo: number, hi: number): number {
  return lo + r() * (hi - lo);
}

function sign(r: Rng): number {
  return r() < 0.5 ? -1 : 1;
}

/** The form of a name that decides the creature: trimmed, lower case, never empty. */
export function norm(name: string): string {
  return name.trim().toLowerCase() || "unnamed";
}

/** The hue (0..359.9) the lab gives this name. */
export function nameHue(name: string): number {
  return (hash(norm(name)) % 3600) / 10;
}

// ---- Geometry helpers ----

function closed(points: readonly number[]): string {
  let d = "M";
  for (let i = 0; i < points.length; i += 2) {
    d += (i ? "L" : "") + points[i].toFixed(1) + " " + points[i + 1].toFixed(1);
  }
  return d + "Z";
}

interface Wave {
  readonly n: number;
  readonly a: number;
  readonly p: number;
  readonly w: number;
}

function push(waves: readonly Wave[], angle: number, t: number): number {
  let k = 0;
  for (const wave of waves) k += wave.a * Math.sin(wave.n * angle + wave.p + wave.w * t);
  return k;
}

/** A circle of radius R pushed in and out by a few sine waves. */
function wobbly(R: number, waves: readonly Wave[], t: number, amp: number, steps: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * TAU;
    const rad = R * (1 + amp * push(waves, a, t));
    pts.push(rad * Math.cos(a), rad * Math.sin(a));
  }
  return pts;
}

function oval(el: Element, cx: number, cy: number, rx: number, ry: number): void {
  el.setAttribute("cx", cx.toFixed(1));
  el.setAttribute("cy", cy.toFixed(1));
  el.setAttribute("rx", rx.toFixed(2));
  el.setAttribute("ry", Math.max(0, ry).toFixed(2));
}

function dot(el: Element, cx: number, cy: number, radius: number): void {
  el.setAttribute("cx", cx.toFixed(1));
  el.setAttribute("cy", cy.toFixed(1));
  el.setAttribute("r", Math.max(0, radius).toFixed(2));
}

// ---- Recipes. A smooth type and its pixel twin read the same recipe, so they are the same creature. ----

interface BlobRecipe {
  readonly waves: readonly Wave[];
  readonly eyes: number;
}

interface Drop {
  readonly far: number;
  readonly size: number;
  readonly w: number;
  readonly p: number;
  readonly beat: number;
}

interface GooRecipe {
  readonly core: number;
  readonly drops: readonly Drop[];
  readonly eyes: number;
}

interface Ball {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

function blobRecipe(r: Rng): BlobRecipe {
  const waves = [2, 3, 4, 5].map((n): Wave => ({
    n,
    a: between(r, 0.03, 0.1),
    p: r() * TAU,
    w: between(r, 0.5, 1.4) * sign(r),
  }));
  return { waves, eyes: 1 + Math.floor(r() * 3) };
}

function gooRecipe(r: Rng): GooRecipe {
  const core = between(r, 17, 21);
  const count = 3 + Math.floor(r() * 2);
  const drops: Drop[] = [];
  for (let i = 0; i < count; i++) {
    drops.push({
      far: between(r, 14, 25),
      size: between(r, 8, 12),
      w: between(r, 0.5, 1.3) * sign(r),
      p: r() * TAU,
      beat: between(r, 0.6, 1.4),
    });
  }
  return { core, drops, eyes: Math.min(2, 1 + Math.floor(r() * 3)) };
}

/** Where the goo's core and droplets are at time t. */
function gooBalls(recipe: GooRecipe, t: number, amp: number): Ball[] {
  const cx = 2 * Math.sin(t * 0.7);
  const cy = 2 * Math.cos(t * 0.5);
  const balls: Ball[] = [{ x: cx, y: cy, r: recipe.core * (1 + 0.05 * amp * Math.sin(t * 2)) }];
  for (const d of recipe.drops) {
    const far = d.far * (0.75 + 0.35 * amp * Math.sin(t * d.beat + d.p));
    const a = d.p + t * d.w;
    balls.push({ x: cx + far * Math.cos(a), y: cy + far * Math.sin(a), r: d.size });
  }
  return balls;
}

// ---- Figures: markup plus a function that poses it at time t. ----

interface Figure {
  readonly html: string;
  pose(kids: readonly Element[], t: number, e: Energy, look: Look): void;
}

interface Eyes {
  readonly html: string;
  pose(kids: readonly Element[], at: number, ox: number, oy: number, t: number, look: Look): void;
}

/** Eyes for the smooth creatures. `look` says where to gaze and how open they are. */
function smoothEyes(r: Rng, n: number, scale: number): Eyes {
  const big = r() < 0.55;
  let size = (big ? between(r, 5, 7) : between(r, 3.2, 4.6)) * scale;
  if (n === 3) size = Math.min(size, (big ? 5 : 3.8) * scale);
  const gap = Math.max(between(r, 10, 15) * scale, size * 2 + 3);
  const y = between(r, -8, 2) * scale;
  const phase = r() * 8;
  let html = "";
  // The lab writes fill="var(--card)"; a class keeps that colour in CSS, where var() always works.
  for (let i = 0; i < n; i++) html += '<ellipse class="eye"/>' + (big ? '<circle fill="currentColor"/>' : "");
  return {
    html,
    pose(k, at, ox, oy, t, look) {
      const blink = (t * 0.3 + phase) % 1 < 0.045 ? 0.1 : 1;
      const open = Math.min(1.2, look.open) * blink;
      for (let i = 0; i < n; i++) {
        const cx = ox + (i - (n - 1) / 2) * gap;
        const cy = oy + y;
        if (big) {
          const pupil = size * 0.46;
          const reach = (size - pupil) * 0.9;
          oval(k[at + i * 2], cx, cy, size, size * open);
          dot(k[at + i * 2 + 1], cx + look.lx * reach, cy + look.ly * reach * Math.min(1, open), open < 0.35 ? 0 : pupil);
        } else {
          oval(k[at + i], cx + look.lx * 2.6, cy + look.ly * 2, size, size * open);
        }
      }
    },
  };
}

// The pixel creatures: an 11 by 11 grid, redrawn a few times a second so the motion is chunky.
const CELLS = 11;
const CELL = 8;
const EDGE = -44;

type Inside = (t: number, e: Energy) => (x: number, y: number) => boolean;

function pixelCreature(r: Rng, eyes: number, eyeRow: number, inside: Inside): Figure {
  const phase = r() * 8;
  let last = "";
  return {
    html: '<path fill="currentColor"/>',
    pose(k, t, e, look) {
      const tick = Math.floor(t * 7);
      const sx = Math.round(look.lx);
      const sy = Math.round(look.ly * 0.8);
      const shut = look.open < 0.5 || (t * 0.3 + phase) % 1 < 0.05;
      const key = tick + "|" + sx + "|" + sy + "|" + shut + "|" + look.mode;
      if (key === last) return;
      last = key;
      const test = inside(tick / 7, e);
      let d = "";
      for (let gy = 0; gy < CELLS; gy++) {
        for (let gx = 0; gx < CELLS; gx++) {
          if (!test(EDGE + (gx + 0.5) * CELL, EDGE + (gy + 0.5) * CELL)) continue;
          const col = gx - sx;
          if (
            !shut &&
            gy === eyeRow + sy &&
            (eyes === 1 ? col === 5 : eyes === 2 ? col === 4 || col === 6 : col === 3 || col === 5 || col === 7)
          ) {
            continue;
          }
          d += "M" + (EDGE + gx * CELL) + " " + (EDGE + gy * CELL) + "h" + CELL + "v" + CELL + "h-" + CELL + "z";
        }
      }
      k[0].setAttribute("d", d);
    },
  };
}

// ---- The four types ----

interface StyleDef {
  readonly label: string;
  /** Which recipe it reads; also salts the seed, so a smooth type and its pixel twin match. */
  readonly recipe: "blob" | "goo";
  /** Whether the markup refers to the goo filter. */
  readonly goo: boolean;
  make(r: Rng, filterId: string): Figure;
}

const STYLES: Readonly<Record<AvatarStyle, StyleDef>> = {
  blob: {
    label: "Blob",
    recipe: "blob",
    goo: false,
    make(r) {
      const recipe = blobRecipe(r);
      const face = smoothEyes(r, recipe.eyes, 1);
      const feelers = r() < 0.4;
      const fx = between(r, 6, 11);
      const fp = r() * TAU;
      const first = feelers ? 3 : 0;
      const html =
        (feelers ? '<path class="ln"/><circle fill="currentColor"/><circle fill="currentColor"/>' : "") +
        '<path fill="currentColor"/>' +
        face.html;
      return {
        html,
        pose(k, t, e, look) {
          if (feelers) {
            const sway = 4 * Math.sin(t * 1.3 + fp);
            const lx = -fx - 3 + sway;
            const rx = fx + 3 + sway;
            k[0].setAttribute(
              "d",
              "M" + (-fx).toFixed(1) + " -20L" + lx.toFixed(1) + " -41M" + fx.toFixed(1) + " -20L" + rx.toFixed(1) + " -41",
            );
            dot(k[1], lx, -41, 3.2);
            dot(k[2], rx, -41, 3.2);
          }
          k[first].setAttribute("d", closed(wobbly(feelers ? 28 : 31, recipe.waves, t, e.amp, 72)));
          face.pose(k, first + 1, 0, feelers ? 3 : 0, t, look);
        },
      };
    },
  },

  goo: {
    label: "Goo",
    recipe: "goo",
    goo: true,
    make(r, filterId) {
      const recipe = gooRecipe(r);
      const face = smoothEyes(r, recipe.eyes, 0.8);
      let html = '<g filter="url(#' + filterId + ')">';
      for (let i = 0; i <= recipe.drops.length; i++) html += '<circle fill="currentColor"/>';
      return {
        html: html + "</g>" + face.html,
        pose(k, t, e, look) {
          const balls = gooBalls(recipe, t, e.amp);
          const circles = k[0].children;
          for (let i = 0; i < balls.length; i++) dot(circles[i], balls[i].x, balls[i].y, balls[i].r);
          face.pose(k, 1, balls[0].x, balls[0].y + 2, t, look);
        },
      };
    },
  },

  pixelblob: {
    label: "Pixel blob",
    recipe: "blob",
    goo: false,
    make(r) {
      const recipe = blobRecipe(r);
      return pixelCreature(r, recipe.eyes, 4, (t, e) => (x, y) =>
        Math.hypot(x, y) < 31 * (1 + 1.2 * e.amp * push(recipe.waves, Math.atan2(y, x), t)),
      );
    },
  },

  pixelgoo: {
    label: "Pixel goo",
    recipe: "goo",
    goo: false,
    make(r) {
      const recipe = gooRecipe(r);
      return pixelCreature(r, recipe.eyes, 5, (t, e) => {
        const balls = gooBalls(recipe, t, e.amp);
        // Inside when the pull of all the balls adds up to 1.
        return (x, y) => {
          let pull = 0;
          for (const b of balls) {
            const dx = x - b.x;
            const dy = y - b.y;
            pull += (b.r * b.r) / (dx * dx + dy * dy + 0.01);
          }
          return pull >= 1;
        };
      });
    },
  },
};

export const AVATAR_STYLES: { id: AvatarStyle; label: string }[] = (
  ["blob", "goo", "pixelblob", "pixelgoo"] as const
).map((id) => ({ id, label: STYLES[id].label }));

/** The goo filter, as in the lab: blur the balls together, then cut the alpha back to a hard edge. */
function gooFilter(id: string): string {
  return (
    '<defs><filter id="' +
    id +
    '" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB">' +
    '<feGaussianBlur in="SourceGraphic" stdDeviation="3.2"/>' +
    '<feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10"/>' +
    "</filter></defs>"
  );
}

/**
 * One avatar bound to one <svg viewBox="-50 -50 100 100">. It owns the gaze, the bounce and the
 * "needs you" ring. The clock, pointer and box are supplied by the caller (see ticker.ts).
 */
export class AvatarView {
  private readonly svg: SVGSVGElement;
  private readonly filterId: string;
  private key = "";
  private seed = 0;
  private offset = 0;
  private made: Figure | null = null;
  private body: Element | null = null;
  private ping: Element | null = null;
  private kids: Element[] = [];
  private readonly look: Look = { lx: 0, ly: 0, open: 1, mode: "working" };

  /** `filterId` must be unique in the document and valid inside url(#...). */
  constructor(svg: SVGSVGElement, filterId: string) {
    this.svg = svg;
    this.filterId = filterId;
  }

  /** Builds the creature for this name and style. Returns false when it is already showing. */
  set(name: string, style: AvatarStyle): boolean {
    const id = style + "|" + norm(name);
    if (id === this.key) return false;
    this.key = id;
    this.seed = hash(norm(name));
    this.offset = ((this.seed % 1000) / 1000) * TAU;
    const def = STYLES[style] ?? STYLES.blob;
    const made = def.make(rng(this.seed ^ hash(def.recipe)), this.filterId);
    // Static markup only: nothing from the name reaches the HTML.
    this.svg.innerHTML =
      (def.goo ? gooFilter(this.filterId) : "") + "<g>" + made.html + '</g><circle class="ping" r="0"/>';
    const nodes = this.svg.children;
    const body = nodes[nodes.length - 2];
    this.made = made;
    this.body = body;
    this.ping = nodes[nodes.length - 1];
    this.kids = Array.from(body.children);
    return true;
  }

  /**
   * Poses the creature. `t` is its clock (runs at the mode's speed), `real` its unscaled time,
   * `dt` the seconds since the last draw. `still` draws a resting frame with no easing or bounce.
   */
  draw(
    t: number,
    energy: Energy,
    mode: AvatarMode,
    real: number,
    dt: number,
    pointer: Point | null,
    box: Box | null,
    still: boolean,
  ): void {
    const { made, body, ping, look } = this;
    if (!made || !body || !ping) return;
    let want: { lx: number; ly: number; open: number };
    if (mode === "idle") {
      want = { lx: 0, ly: 0.5, open: 0.2 }; // dozing
    } else if (mode === "working") {
      const hop = Math.floor(real * 1.3 + this.offset); // eyes dart to a new spot now and then
      want = { lx: noise(this.seed, hop, 1, 0) * 2 - 1, ly: noise(this.seed, hop, 2, 0) * 1.4 - 0.6, open: 1 };
    } else {
      want = { lx: 0, ly: -0.2, open: 1.15 }; // watching the pointer
      if (pointer && box) {
        const dx = pointer.x - (box.left + box.width / 2);
        const dy = pointer.y - (box.top + box.height / 2);
        const far = Math.hypot(dx, dy) || 1;
        const pull = Math.min(1, far / 90);
        want.lx = (dx / far) * pull;
        want.ly = (dy / far) * pull;
      }
    }
    const ease = still ? 1 : 1 - Math.exp(-dt * 9);
    look.lx += (want.lx - look.lx) * ease;
    look.ly += (want.ly - look.ly) * ease;
    look.open += (want.open - look.open) * ease;
    look.mode = mode;
    made.pose(this.kids, t, energy, look);
    const waiting = mode === "waiting" && !still;
    body.setAttribute(
      "transform",
      "translate(0 " + (waiting ? -4 * Math.abs(Math.sin(real * 3.4 + this.offset)) : 0).toFixed(2) + ")",
    );
    if (waiting) {
      const p = (real * 0.6) % 1;
      ping.setAttribute("r", (28 + 19 * p).toFixed(1));
      ping.setAttribute("opacity", (1 - p).toFixed(2));
    } else {
      ping.setAttribute("opacity", "0");
    }
  }
}

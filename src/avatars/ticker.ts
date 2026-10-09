// One animation loop for every mounted avatar.
//
// - A single requestAnimationFrame drives all avatars that are on screen; it stops when none are.
// - Each avatar keeps its own clock, advanced by dt times its own mode's speed.
// - Off-screen avatars (IntersectionObserver) are paused.
// - prefers-reduced-motion is followed live: when reduced, every avatar shows one still frame.
// - One shared pointermove listener feeds the "waiting" gaze; bounding boxes are measured lazily,
//   marked stale on scroll (any scroller), resize, visibility changes and once a second.

import { AvatarView, ENERGY, STILL_CLOCK } from "./generator";
import type { AvatarMode, AvatarStyle, Box, Point } from "./generator";

/** What Avatar.tsx holds for one mounted <svg>. */
export interface AvatarHandle {
  /** Re-creates the creature when the name or style changed; otherwise does nothing. */
  setFigure(name: string, style: AvatarStyle): void;
  setMode(mode: AvatarMode): void;
  dispose(): void;
}

const MAX_DT = 0.05;
const REMEASURE_MS = 1000;

const mounted = new Set<Driver>();
const visible = new Set<Driver>();
const byElement = new Map<Element, Driver>();

let observer: IntersectionObserver | null = null;
let motion: MediaQueryList | null = null;
let still = false;
let pointer: Point | null = null;
let layoutEpoch = 0;
let frameId = 0;
let lastTime = 0;
let lastRemeasure = 0;

class Driver implements AvatarHandle {
  readonly el: SVGSVGElement;
  private readonly view: AvatarView;
  private mode: AvatarMode = "working";
  private clock = STILL_CLOCK;
  private real = 0;
  private box: Box | null = null;
  private boxEpoch = -1;

  constructor(svg: SVGSVGElement, filterId: string) {
    this.el = svg;
    this.view = new AvatarView(svg, filterId);
  }

  setFigure(name: string, style: AvatarStyle): void {
    if (this.view.set(name, style)) this.repaint();
  }

  setMode(mode: AvatarMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.repaint();
  }

  dispose(): void {
    detach(this);
  }

  markStale(): void {
    this.boxEpoch = -1;
  }

  /** Reads layout, only when the gaze needs it and the cached box is stale. */
  measure(): void {
    if (this.mode !== "waiting" || !pointer || this.boxEpoch === layoutEpoch) return;
    this.box = this.el.getBoundingClientRect();
    this.boxEpoch = layoutEpoch;
  }

  step(dt: number): void {
    this.clock += dt * ENERGY[this.mode].speed;
    this.real += dt;
    this.render(dt);
  }

  /** Draws now without advancing time (a still frame when motion is reduced). */
  repaint(): void {
    this.measure();
    this.render(0);
  }

  private render(dt: number): void {
    if (still) {
      // Rest at the lab's still frame; animation resumes from here if motion comes back.
      this.clock = STILL_CLOCK;
      this.real = 0;
    }
    this.view.draw(this.clock, ENERGY[this.mode], this.mode, this.real, dt, pointer, this.box, still);
  }
}

/** Binds an avatar to the shared loop. Call dispose() when the <svg> unmounts. */
export function animateAvatar(svg: SVGSVGElement, filterId: string): AvatarHandle {
  const driver = new Driver(svg, filterId);
  attach(driver);
  return driver;
}

function attach(driver: Driver): void {
  if (mounted.size === 0) listen();
  mounted.add(driver);
  byElement.set(driver.el, driver);
  if (observer) observer.observe(driver.el);
  else visible.add(driver);
  schedule();
}

function detach(driver: Driver): void {
  if (!mounted.delete(driver)) return;
  visible.delete(driver);
  byElement.delete(driver.el);
  observer?.unobserve(driver.el);
  if (mounted.size === 0) unlisten();
  schedule();
}

function listen(): void {
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  // Capture, so scrolling inside any pane (scroll does not bubble) also marks boxes stale.
  window.addEventListener("scroll", onLayoutChange, { passive: true, capture: true });
  window.addEventListener("resize", onLayoutChange, { passive: true });
  motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  still = motion.matches;
  motion.addEventListener("change", onMotionChange);
  observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(onIntersect) : null;
}

function unlisten(): void {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("scroll", onLayoutChange, { capture: true });
  window.removeEventListener("resize", onLayoutChange);
  motion?.removeEventListener("change", onMotionChange);
  motion = null;
  observer?.disconnect();
  observer = null;
}

function onPointerMove(ev: PointerEvent): void {
  pointer = { x: ev.clientX, y: ev.clientY };
}

function onLayoutChange(): void {
  layoutEpoch++;
}

function onMotionChange(): void {
  still = motion?.matches ?? false;
  if (still) for (const driver of mounted) driver.repaint();
  schedule();
}

function onIntersect(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    const driver = byElement.get(entry.target);
    if (!driver) continue;
    if (entry.isIntersecting) {
      visible.add(driver);
      driver.markStale();
    } else {
      visible.delete(driver);
    }
  }
  schedule();
}

function running(): boolean {
  return !still && visible.size > 0;
}

/** Starts or stops the loop to match what is on screen. */
function schedule(): void {
  if (running()) {
    if (frameId === 0) {
      lastTime = performance.now();
      frameId = requestAnimationFrame(frame);
    }
  } else if (frameId !== 0) {
    cancelAnimationFrame(frameId);
    frameId = 0;
  }
}

function frame(now: number): void {
  const dt = Math.min(MAX_DT, Math.max(0, (now - lastTime) / 1000));
  lastTime = now;
  if (now - lastRemeasure >= REMEASURE_MS) {
    // Panes can move without a scroll or resize; refresh boxes now and then.
    layoutEpoch++;
    lastRemeasure = now;
  }
  // All layout reads first, then all writes, so one frame never forces layout twice.
  for (const driver of visible) driver.measure();
  for (const driver of visible) driver.step(dt);
  frameId = running() ? requestAnimationFrame(frame) : 0;
}

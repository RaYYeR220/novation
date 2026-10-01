import { CELLS } from '@/lib/scenario';
import { INITIAL_YAW, worstNode, type CrownScale } from './crownMath';

/**
 * Mutable state shared by the DOM layer (pointer, keyboard, tooltip, IM readout) and the WebGL
 * scene. The scene reads inputs and writes outputs once per frame; nothing here goes through React
 * state, so a turning crown never re-renders the tree.
 */
export class CrownRig {
  /* data */
  target = new Float32Array(CELLS);
  targetIm = 0;
  scale: CrownScale = { loss: 1, gain: 1 };
  worst = 0;
  /** Bumped whenever targets change; the scene uses it to wake the springs. */
  version = 0;

  /* spring state (what is on screen) */
  shown = new Float32Array(CELLS);
  vel = new Float32Array(CELLS);
  shownIm = 0;
  velIm = 0;
  seeded = false;

  /* pose */
  yaw = INITIAL_YAW;
  yawVel = 0;
  dragging = false;
  dragGoal = INITIAL_YAW;
  /** Yaw the keyboard asked for (turns the stepped node toward the viewer), or null. */
  keyGoal: number | null = null;

  /* focus: -1 shows the worst node */
  focus = -1;
  focusSource: 'none' | 'pointer' | 'key' = 'none';

  /* environment */
  reduced = false;
  visible = true;

  /* outputs */
  /** Node centres in CSS px relative to the stage, [x0,y0,x1,y1,…]. */
  screen = new Float32Array(CELLS * 2);
  frames = 0;
  live = false;

  /* hooks */
  invalidate: () => void = () => {};
  onFrame: (() => void) | null = null;

  /** A rig already holding its data, for renders that mount the scene directly. */
  static seeded(cells: readonly number[], im: number, scale: CrownScale): CrownRig {
    const r = new CrownRig();
    r.setData(cells, im, scale);
    return r;
  }

  setData(cells: readonly number[], im: number, scale: CrownScale) {
    for (let i = 0; i < CELLS; i++) this.target[i] = cells[i] ?? 0;
    this.targetIm = im;
    this.scale = scale;
    this.worst = worstNode(cells).index;
    this.version++;
    if (!this.seeded || this.reduced) this.snap();
  }

  /** Jump straight to the targets (first paint, reduced motion). */
  snap() {
    this.shown.set(this.target);
    this.vel.fill(0);
    this.shownIm = this.targetIm;
    this.velIm = 0;
    this.seeded = true;
  }

  /** Index the tooltip points at. */
  get active() {
    return this.focus >= 0 ? this.focus : this.worst;
  }
}

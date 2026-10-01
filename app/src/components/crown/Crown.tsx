'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { ScenarioGrid, Session } from '@/lib/client/types';
import { SESSION_LABEL, fmtNumber, fmtSigned } from '@/lib/format';
import { CELLS, PRICE_POINTS, VOL_POINTS, cellCoords } from '@/lib/scenario';
import {
  INITIAL_YAW,
  angleDelta,
  crownScale,
  describeNode,
  nearestNode,
  nodeColor,
  priceLabel,
  projectNodes,
  scenarioLabel,
  stepNode,
  volLabel,
  worstNode,
  yawFacing,
  type CrownScale,
} from './crownMath';
import { CrownPoster, POSTER } from './CrownPoster';
import { CrownRig } from './rig';
import styles from './crown.module.css';

const CrownScene = dynamic(() => import('./CrownScene'), { ssr: false });

export interface CrownLabels {
  /** Accessible name of the object. */
  name: string;
  /** Caption next to the IM value. */
  im: string;
  unit: string;
  /** Flag on the tooltip when it shows the worst scenario. */
  worst: string;
  /** Group label of the session toggle. */
  sessions: string;
  /** What the cyan ring means. */
  datum: string;
  /** Interaction hint, read by screen readers and shown on wide layouts. */
  hint: string;
  /** Button that loads the 3D view on small screens and save-data. */
  load: string;
}

export const DEFAULT_LABELS: CrownLabels = {
  name: 'Scenario crown: the book re-priced across 39 price and volatility scenarios',
  im: 'Initial margin',
  unit: 'USDG',
  worst: 'Worst of 39',
  sessions: 'Market session',
  datum: 'The cyan ring sits at −IM. Every node above it is a scenario the margin covers.',
  hint: 'Drag to turn it. Arrow keys step through the scenarios.',
  load: 'Load 3D view',
};

export interface CrownProps {
  grid: ScenarioGrid;
  /** Initial margin for this grid's session, in USDG. */
  im: number;
  variant: 'hero' | 'panel';
  session: Session;
  onSessionChange?: (session: Session) => void;
  labels?: Partial<CrownLabels>;
  /**
   * Height and colour scale. Pass one scale for every session you switch between (see crownScale)
   * so a switch re-seats the nodes instead of rescaling them. Defaults to this grid and IM.
   */
  scale?: CrownScale;
  /** Sessions offered by the toggle. */
  sessions?: readonly Session[];
  className?: string;
  /** 'low' skips the glass transmission pass and heavy AA from the start; 'auto' drops to it on slow devices. */
  quality?: 'auto' | 'low';
  /** Lab only: render continuously and record frame timings. */
  measure?: boolean;
  /** The pre-rendered stills show account 7's book; pass false for any other book so no other shape stands in for it. */
  poster?: boolean;
}

type Phase = 'poster' | 'offer' | 'static' | 'loading' | 'live';

const DEFAULT_SESSIONS: readonly Session[] = ['REGULAR', 'WEEKEND'];

function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

function saveData(): boolean {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !!c?.saveData;
}

function whenIdle(fn: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(fn, { timeout: 1200 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(fn, 200);
  return () => window.clearTimeout(id);
}

/** Contained rect of the poster inside the stage (object-fit: contain). */
function posterRect(w: number, h: number) {
  const a = POSTER.width / POSTER.height;
  if (w / h > a) return { x: (w - h * a) / 2, y: 0, w: h * a, h };
  return { x: 0, y: (h - w / a) / 2, w, h: w / a };
}

export function Crown({
  grid,
  im,
  variant,
  session,
  onSessionChange,
  labels: labelsIn,
  scale: scaleIn,
  sessions = DEFAULT_SESSIONS,
  className,
  quality = 'auto',
  measure = false,
  poster = true,
}: CrownProps) {
  const labels = { ...DEFAULT_LABELS, ...labelsIn };
  const cells = grid.cells;
  const scale = useMemo(() => scaleIn ?? crownScale([cells], [im]), [scaleIn, cells, im]);
  const ids = useId();
  const hintId = `${ids}-hint`;

  const rigRef = useRef<CrownRig | null>(null);
  if (rigRef.current === null) rigRef.current = new CrownRig();

  const stageRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const tipFlagRef = useRef<HTMLSpanElement>(null);
  const tipKeyRef = useRef<HTMLSpanElement>(null);
  const tipValueRef = useRef<HTMLSpanElement>(null);
  const tipNumRef = useRef<HTMLSpanElement>(null);
  const imRef = useRef<HTMLSpanElement>(null);
  const shown = useRef({ text: '', im: '', w: 0, pw: 0, ph: 0 });
  const drag = useRef<{ id: number; x: number; yaw: number; moved: boolean } | null>(null);

  const [phase, setPhase] = useState<Phase>('poster');
  const [announce, setAnnounce] = useState('');
  const live = phase === 'live';
  const liveRef = useRef(false);

  /** Write the tooltip and IM readout from the rig. Runs every rendered frame, or on events when static. Reads layout only when the text changes. */
  const paint = useCallback(() => {
    const r = rigRef.current;
    const tip = tipRef.current;
    const stage = stageRef.current;
    if (!r || !tip || !stage) return;
    const s = shown.current;
    const i = r.active;
    const pnl = r.shown[i] as number;
    const key = `${i}|${fmtSigned(pnl)}|${r.focus < 0 ? 1 : 0}`;
    if (key !== s.text) {
      s.text = key;
      if (tipFlagRef.current) tipFlagRef.current.textContent = r.focus < 0 ? labels.worst : '';
      if (tipKeyRef.current) tipKeyRef.current.textContent = scenarioLabel(i);
      if (tipNumRef.current) tipNumRef.current.textContent = fmtSigned(pnl);
      if (tipValueRef.current) tipValueRef.current.style.color = nodeColor(pnl, r.scale);
      const plate = tip.lastElementChild as HTMLElement | null;
      s.pw = plate?.offsetWidth ?? 0;
      s.ph = plate?.offsetHeight ?? 0;
    }
    if (s.w === 0) s.w = stage.clientWidth;
    const x = r.screen[i * 2] as number;
    const y = r.screen[i * 2 + 1] as number;
    // keep the plate inside the stage; shorten the leader before flipping the plate under the node
    const dx = Math.max(8 + s.pw / 2 - x, Math.min(s.w - 8 - s.pw / 2 - x, 0));
    const room = y - s.ph - 8;
    const below = room < 14;
    tip.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    tip.style.setProperty('--dx', `${dx.toFixed(1)}px`);
    tip.style.setProperty('--stem', `${below ? 30 : Math.min(30, Math.round(room))}px`);
    tip.dataset.below = String(below);
    tip.dataset.show = 'true';
    const imText = fmtNumber(r.shownIm);
    if (imText !== s.im && imRef.current) {
      s.im = imText;
      imRef.current.textContent = imText;
    }
    stage.dataset.frames = String(r.frames);
  }, [labels.worst]);

  /** Static projection for the poster pose. */
  const projectStatic = useCallback(() => {
    const r = rigRef.current;
    const stage = stageRef.current;
    if (!r || !stage || liveRef.current) return;
    const rect = posterRect(stage.clientWidth, stage.clientHeight);
    if (rect.w < 2 || rect.h < 2) return;
    projectNodes(r.shown, r.scale, INITIAL_YAW, rect.w, rect.h, r.screen);
    for (let i = 0; i < CELLS; i++) {
      r.screen[i * 2] = (r.screen[i * 2] as number) + rect.x;
      r.screen[i * 2 + 1] = (r.screen[i * 2 + 1] as number) + rect.y;
    }
    paint();
  }, [paint]);

  // data → rig
  useEffect(() => {
    const r = rigRef.current;
    if (!r) return;
    r.setData(cells, im, scale);
    if (!liveRef.current) r.snap();
    r.invalidate();
    projectStatic();
  }, [cells, im, scale, projectStatic]);

  // the scene calls paint after every frame
  useEffect(() => {
    const r = rigRef.current;
    if (!r) return;
    r.onFrame = paint;
    return () => {
      r.onFrame = null;
    };
  }, [paint]);

  // reduced motion, visibility, resize
  useEffect(() => {
    const r = rigRef.current;
    const stage = stageRef.current;
    if (!r || !stage) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => {
      r.reduced = mq.matches;
      if (r.reduced) {
        r.snap();
        r.keyGoal = null;
      }
      r.invalidate();
    };
    onMotion();
    mq.addEventListener('change', onMotion);
    const io = new IntersectionObserver(
      ([e]) => {
        r.visible = !!e?.isIntersecting;
        if (r.visible) r.invalidate();
      },
      { threshold: 0.01 },
    );
    io.observe(stage);
    // Switzer arrives after first paint; re-measure the tooltip plate once it has
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (!alive) return;
      shown.current.text = '';
      if (liveRef.current) r.invalidate();
      else paint();
    });
    const ro = new ResizeObserver(() => {
      shown.current.w = stage.clientWidth;
      shown.current.text = '';
      projectStatic();
      r.invalidate();
    });
    ro.observe(stage);
    return () => {
      alive = false;
      mq.removeEventListener('change', onMotion);
      io.disconnect();
      ro.disconnect();
    };
  }, [projectStatic, paint]);

  // decide how to show it once the page is idle: 3D, a load button, or the poster alone
  useEffect(
    () =>
      whenIdle(() => {
        if (!hasWebGL()) setPhase('static');
        else if (saveData() || window.innerWidth < 480) setPhase('offer');
        else setPhase('loading');
      }),
    [],
  );

  const onReady = useCallback(() => {
    liveRef.current = true;
    const r = rigRef.current;
    if (r) r.live = true;
    setPhase('live');
  }, []);

  const onLost = useCallback(() => {
    liveRef.current = false;
    const r = rigRef.current;
    if (r) {
      r.live = false;
      r.yaw = INITIAL_YAW;
    }
    setPhase('static');
    requestAnimationFrame(() => projectStatic());
  }, [projectStatic]);

  /* ---------- pointer ---------- */

  const local = (e: PointerEvent<HTMLDivElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };

  const setFocus = (i: number, source: CrownRig['focusSource']) => {
    const r = rigRef.current;
    if (!r) return;
    if (r.focus === i && r.focusSource === source) return;
    r.focus = i;
    r.focusSource = i < 0 ? 'none' : source;
    if (source !== 'key') r.keyGoal = null;
    if (liveRef.current) r.invalidate();
    else paint();
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const r = rigRef.current;
    if (!r || !liveRef.current || e.button !== 0) return;
    drag.current = { id: e.pointerId, x: e.clientX, yaw: r.yaw, moved: false };
    r.dragGoal = r.yaw;
    r.keyGoal = null;
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = rigRef.current;
    if (!r) return;
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      const dx = e.clientX - d.x;
      if (!d.moved && Math.abs(dx) > 3) {
        d.moved = true;
        r.dragging = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.dataset.dragging = 'true';
      }
      if (d.moved) {
        r.dragGoal = d.yaw + dx * 0.0085;
        r.invalidate();
        return;
      }
    }
    if (e.pointerType === 'touch' && !d) return;
    const p = local(e);
    setFocus(nearestNode(r.screen, p.x, p.y, 56), 'pointer');
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const r = rigRef.current;
    const d = drag.current;
    if (!r || !d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.moved) {
      r.dragging = false;
      r.yawVel = Math.max(-2.5, Math.min(2.5, r.yawVel));
      if (r.reduced) r.yawVel = 0;
      delete e.currentTarget.dataset.dragging;
      r.invalidate();
    } else if (e.pointerType === 'touch') {
      const p = local(e);
      setFocus(nearestNode(r.screen, p.x, p.y, 56), 'pointer');
    }
  };

  const onPointerLeave = () => {
    const r = rigRef.current;
    if (r && r.focusSource === 'pointer' && !drag.current) setFocus(-1, 'none');
  };

  /* ---------- keyboard ---------- */

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const r = rigRef.current;
    if (!r) return;
    if (e.key === 'Escape') {
      if (r.focus >= 0) {
        setFocus(-1, 'none');
        setAnnounce('');
      }
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const next = stepNode(r.focus >= 0 ? r.focus : r.worst, e.key);
    if (liveRef.current && !r.reduced) {
      const goal = yawFacing(cellCoords(next).j);
      r.keyGoal = r.yaw + angleDelta(r.yaw, goal);
    }
    setFocus(next, 'key');
    setAnnounce(describeNode(next, r.target[next] as number, labels.unit));
  };

  const onBlur = () => {
    const r = rigRef.current;
    if (r && r.focusSource === 'key') {
      r.keyGoal = null;
      setFocus(-1, 'none');
    }
  };

  /* ---------- render ---------- */

  const mountScene = phase === 'loading' || phase === 'live';
  const lossEnd = Math.round(scale.loss);
  const gainEnd = Math.round(scale.gain);
  const imPos = 50 * (1 - Math.min(1, im / scale.loss));
  const worstIdx = useMemo(() => worstNode(cells).index, [cells]);

  return (
    <figure
      className={[styles.crown, styles[variant], className].filter(Boolean).join(' ')}
      data-crown-phase={phase}
      data-variant={variant}
    >
      <div
        ref={stageRef}
        className={styles.stage}
        data-live={live}
        tabIndex={0}
        role="group"
        aria-roledescription="3D chart"
        aria-label={labels.name}
        aria-describedby={hintId}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      >
        {poster ? <CrownPoster session={session} priority={variant === 'hero'} className={styles.poster} gone={live} /> : null}
        {mountScene ? (
          <div className={styles.canvas} data-ready={live}>
            <CrownScene rigRef={rigRef} measure={measure} low={quality === 'low'} onReady={onReady} onLost={onLost} />
          </div>
        ) : null}
        <div ref={tipRef} className={styles.tip} aria-hidden="true">
          <span className={styles.tipDot} />
          <span className={styles.tipStem} />
          <span className={styles.tipPlate}>
            <span className={styles.tipKey}>
              <span ref={tipFlagRef} className={styles.tipFlag} />
              <span ref={tipKeyRef}>{scenarioLabel(worstIdx)}</span>
            </span>
            <span ref={tipValueRef} className={styles.tipValue}>
              <span ref={tipNumRef}>{fmtSigned(cells[worstIdx] ?? 0)}</span>
              <span className={styles.tipUnit}>{labels.unit}</span>
            </span>
          </span>
        </div>
        {phase === 'offer' ? (
          <button type="button" className={styles.load} onClick={() => setPhase('loading')}>
            <i aria-hidden="true" />
            {labels.load}
          </button>
        ) : null}
      </div>

      <figcaption className={styles.legend}>
        {onSessionChange ? (
          <div className={styles.seg} role="group" aria-label={labels.sessions}>
            {sessions.map((s) => (
              <button key={s} type="button" aria-pressed={s === session} onClick={() => s !== session && onSessionChange(s)}>
                <i aria-hidden="true" />
                {SESSION_LABEL[s]}
              </button>
            ))}
          </div>
        ) : null}
        <div className={styles.im}>
          <span className={styles.imKey}>
            <svg width="20" height="10" viewBox="0 0 20 10" aria-hidden="true">
              <ellipse cx="10" cy="5" rx="9" ry="3.6" fill="none" stroke="var(--color-cyan)" strokeWidth="1.5" />
            </svg>
            {labels.im}
          </span>
          <span className={styles.imValue}>
            <span ref={imRef}>{fmtNumber(im)}</span>
            <span className={styles.imUnit}>{labels.unit}</span>
          </span>
        </div>
        <div className={styles.ramp} aria-hidden="true">
          <div className={styles.bar}>
            <span className={styles.imTick} style={{ left: `${imPos}%` }} />
          </div>
          <div className={styles.scale}>
            <span>{fmtSigned(-lossEnd, 0)}</span>
            <span>0</span>
            <span>{fmtSigned(gainEnd, 0)}</span>
          </div>
        </div>
        <p className={styles.note}>
          {labels.datum} <span id={hintId}>{labels.hint}</span>
        </p>
      </figcaption>

      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <table className="sr-only">
        <caption>
          {`Scenario PnL in ${labels.unit}, ${SESSION_LABEL[session]} session. Initial margin ${fmtNumber(im)} ${labels.unit}.`}
        </caption>
        <thead>
          <tr>
            <th scope="col">Volatility</th>
            {Array.from({ length: PRICE_POINTS }, (_, j) => (
              <th key={j} scope="col">
                {priceLabel(j)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: VOL_POINTS }, (_, v) => (
            <tr key={v}>
              <th scope="row">{volLabel(v)}</th>
              {Array.from({ length: PRICE_POINTS }, (_, j) => (
                <td key={j}>{fmtSigned(cells[v * PRICE_POINTS + j] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

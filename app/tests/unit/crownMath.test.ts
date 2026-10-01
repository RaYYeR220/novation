import { describe, expect, it } from 'vitest';
import account7 from '@/fixtures/account7.json';
import {
  HUB_RADIUS,
  LINKS,
  MAX_HEIGHT,
  NODE_RADIUS,
  RING_RADII,
  SPAN,
  angleDelta,
  crownBounds,
  crownScale,
  describeNode,
  fitCamera,
  linkEnds,
  naturalAspect,
  nearestNode,
  nodeColor,
  nodeHeight,
  nodePosition,
  nodePositions,
  priceLabel,
  projectNdc,
  projectNodes,
  rotateY,
  scenarioLabel,
  spokeAngle,
  springStep,
  stepNode,
  volLabel,
  worstNode,
  yawFacing,
  type Vec3,
} from '@/components/crown/crownMath';
import { cellIndex } from '@/lib/scenario';

const regular = account7.grids.REGULAR.cells;
const weekend = account7.grids.WEEKEND.cells;
const ims = [account7.summary.im_regular, account7.summary.im_weekend];
const scale = crownScale([regular, weekend], ims);
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

describe('crown layout', () => {
  it('spreads 13 spokes over 300° with price 0 facing the viewer', () => {
    expect(spokeAngle(0)).toBeCloseTo(-SPAN / 2);
    expect(spokeAngle(12)).toBeCloseTo(SPAN / 2);
    expect(spokeAngle(6)).toBeCloseTo(0);
    expect(spokeAngle(1) - spokeAngle(0)).toBeCloseTo((25 * Math.PI) / 180);
  });

  it('puts each vol index on its own ring, −R on the left and +R on the right', () => {
    for (let v = 0; v < 3; v++)
      for (let j = 0; j < 13; j++) {
        const [x, y, z] = nodePosition(v, j, 0.3);
        expect(Math.hypot(x, z)).toBeCloseTo(RING_RADII[v] as number);
        expect(y).toBe(0.3);
      }
    expect(nodePosition(2, 0, 0)[0]).toBeLessThan(0);
    expect(nodePosition(2, 12, 0)[0]).toBeGreaterThan(0);
    const front = nodePosition(1, 6, 0);
    expect(front[0]).toBeCloseTo(0);
    expect(front[2]).toBeCloseTo(RING_RADII[1]);
  });

  it('flattens 39 positions in cell order (index = v*13 + j)', () => {
    const pos = nodePositions(regular, scale);
    expect(pos).toHaveLength(117);
    const i = cellIndex(2, 0);
    const p = nodePosition(2, 0, nodeHeight(regular[i] as number, scale));
    expect([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]].map((n) => Number(n?.toFixed(5)))).toEqual(p.map((n) => Number(n.toFixed(5))));
  });

  it('wires 75 links: spoke roots from the hub, spokes across rings, arcs around each ring', () => {
    expect(LINKS).toHaveLength(75);
    expect(LINKS.filter(([a]) => a < 0)).toHaveLength(13);
    const key = (l: readonly number[]) => [...l].sort((a, b) => a - b).join(',');
    expect(new Set(LINKS.map(key)).size).toBe(75);
    for (const [a, b] of LINKS) {
      if (a < 0) continue;
      const da = Math.floor(a / 13) - Math.floor(b / 13);
      const dj = (a % 13) - (b % 13);
      expect(Math.abs(da) + Math.abs(dj)).toBe(1);
    }
  });

  it('trims links to the node rings and roots spokes on the hub bezel', () => {
    const pos = nodePositions(regular, scale);
    const root = linkEnds([-1 - 6, 6], pos);
    expect(Math.hypot(root[0] as number, root[2] as number)).toBeCloseTo(HUB_RADIUS);
    expect(root[1]).toBe(0);
    const ring = linkEnds([cellIndex(0, 3), cellIndex(1, 3)], pos);
    const a = cellIndex(0, 3);
    const dA = Math.hypot((ring[0] as number) - (pos[a * 3] as number), (ring[2] as number) - (pos[a * 3 + 2] as number));
    expect(dA).toBeCloseTo(NODE_RADIUS);
    expect(ring[1]).toBeCloseTo(pos[a * 3 + 1] as number);
  });
});

describe('height scaling', () => {
  it('shares one scale across sessions and includes the IM', () => {
    expect(scale.loss).toBeCloseTo(Math.max(-Math.min(...weekend), ...ims));
    expect(scale.gain).toBeCloseTo(Math.max(...regular, ...weekend));
    expect(crownScale([[0, 0]])).toEqual({ loss: 1, gain: 1 });
  });

  it('is linear and signed, with the loss scale at full depth', () => {
    expect(nodeHeight(0, scale)).toBe(0);
    expect(nodeHeight(-scale.loss, scale)).toBeCloseTo(-MAX_HEIGHT);
    expect(nodeHeight(-scale.loss / 2, scale)).toBeCloseTo(-MAX_HEIGHT / 2);
    expect(nodeHeight(50, scale)).toBeCloseTo((50 / scale.loss) * MAX_HEIGHT);
    expect(nodeHeight(-10 * scale.loss, scale)).toBe(-MAX_HEIGHT);
  });

  it('sinks the weekend worst node and the IM datum below the regular ones', () => {
    const w = worstNode(weekend);
    const r = worstNode(regular);
    expect(nodeHeight(w.pnl, scale)).toBeLessThan(nodeHeight(r.pnl, scale));
    expect(nodeHeight(-ims[1]!, scale)).toBeLessThan(nodeHeight(-ims[0]!, scale));
    // margin covers every scenario: every node sits above its session's datum
    for (const v of regular) expect(nodeHeight(v, scale)).toBeGreaterThan(nodeHeight(-ims[0]!, scale));
    for (const v of weekend) expect(nodeHeight(v, scale)).toBeGreaterThan(nodeHeight(-ims[1]!, scale));
  });
});

describe('worst-node selection', () => {
  it('matches the account 7 fixture: price −R, vol ×1.4', () => {
    const w = worstNode(regular);
    expect(w.index).toBe(account7.account.state.worstScenario);
    expect(w).toMatchObject({ v: 2, j: 0 });
    expect(w.pnl).toBe(Math.min(...regular));
    expect(worstNode(weekend).index).toBe(account7.summary.worstScenario.WEEKEND);
  });

  it('takes the first index on a tie', () => {
    const cells = Array.from({ length: 39 }, () => 5);
    cells[4] = -1;
    cells[30] = -1;
    expect(worstNode(cells)).toMatchObject({ index: 4, v: 0, j: 4 });
  });
});

describe('ramp colours', () => {
  it('uses each side of the ramp on its own scale', () => {
    expect(nodeColor(0, scale)).toBe('#9FB3D9');
    expect(nodeColor(-scale.loss, scale)).toBe('#FF4400');
    expect(nodeColor(scale.gain, scale)).toBe('#9DC93B');
    expect(nodeColor(-scale.loss / 3, scale)).toBe('#FFB68A');
    expect(nodeColor(scale.gain / 3, scale)).toBe('#DDEFAE');
  });

  it('keeps the regular book lighter than the weekend book at the worst node', () => {
    const lum = (hex: string) => parseInt(hex.slice(3, 5), 16);
    const i = worstNode(regular).index;
    expect(lum(nodeColor(regular[i]!, scale))).toBeGreaterThan(lum(nodeColor(weekend[i]!, scale)));
  });
});

describe('labels', () => {
  it('names prices as fractions of the shock range and vols as multipliers', () => {
    expect(priceLabel(0)).toBe('price −R');
    expect(priceLabel(2)).toBe('price −2/3 R');
    expect(priceLabel(6)).toBe('price 0');
    expect(priceLabel(9)).toBe('price +1/2 R');
    expect(priceLabel(12)).toBe('price +R');
    expect([0, 1, 2].map(volLabel)).toEqual(['vol ×0.7', 'vol ×1.0', 'vol ×1.4']);
    expect(scenarioLabel(26)).toBe('price −R, vol ×1.4');
  });

  it('formats the tooltip line', () => {
    expect(describeNode(26, -759.36)).toBe('price −R, vol ×1.4: −759.36 USDG');
    expect(describeNode(12, 77.957457)).toBe('price +R, vol ×0.7: +77.96 USDG');
    expect(describeNode(19, 0)).toBe('price 0, vol ×1.0: 0.00 USDG');
  });
});

describe('camera fit', () => {
  const bounds = crownBounds(scale);
  const ring = (y: number): Vec3[] =>
    Array.from({ length: 64 }, (_, k) => {
      const a = (k / 64) * Math.PI * 2;
      return [bounds.radius * Math.sin(a), y, bounds.radius * Math.cos(a)] as Vec3;
    });
  const pts = [...ring(bounds.yMin), ...ring(bounds.yMax)];

  for (const aspect of [390 / 520, 1, 1440 / 470, 1280 / 330, 16 / 9]) {
    it(`keeps the whole crown in view at aspect ${aspect.toFixed(2)}`, () => {
      const fit = fitCamera(aspect, bounds);
      const ndc = pts.map((p) => projectNdc(p, fit));
      const xs = ndc.map((n) => n[0]);
      const ys = ndc.map((n) => n[1]);
      expect(Math.max(...xs.map(Math.abs))).toBeLessThanOrEqual(0.96 + 1e-3);
      expect(Math.max(...ys)).toBeLessThanOrEqual(0.94 + 1e-3);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(-0.94 - 1e-3);
      // tight on at least one axis
      const tightX = Math.max(...xs.map(Math.abs)) > 0.955;
      const tightY = Math.max(...ys) - Math.min(...ys) > 1.87;
      expect(tightX || tightY).toBe(true);
      // centred vertically
      expect(Math.max(...ys) + Math.min(...ys)).toBeCloseTo(0, 3);
    });
  }

  it('finds the aspect where both axes are tight', () => {
    const a = naturalAspect(bounds);
    expect(a).toBeGreaterThan(1);
    expect(a).toBeLessThan(3);
    const fit = fitCamera(a, bounds);
    const ndc = pts.map((p) => projectNdc(p, fit));
    expect(Math.max(...ndc.map((n) => Math.abs(n[0])))).toBeGreaterThan(0.95);
    expect(Math.max(...ndc.map((n) => n[1])) - Math.min(...ndc.map((n) => n[1]))).toBeGreaterThan(1.86);
  });

  it('projects nodes into the viewport and snaps to the nearest one', () => {
    const screen = projectNodes(regular, scale, 0.55, 900, 480);
    for (let i = 0; i < 39; i++) {
      expect(screen[i * 2]).toBeGreaterThan(0);
      expect(screen[i * 2]).toBeLessThan(900);
      expect(screen[i * 2 + 1]).toBeGreaterThan(0);
      expect(screen[i * 2 + 1]).toBeLessThan(480);
    }
    const i = 26;
    expect(nearestNode(screen, screen[i * 2]! + 3, screen[i * 2 + 1]! - 2)).toBe(i);
    expect(nearestNode(screen, -500, -500)).toBe(-1);
  });

  it('rotates like Object3D.rotation.y', () => {
    const [x, , z] = rotateY([0, 0, 1], Math.PI / 2);
    expect(close(x, 1)).toBe(true);
    expect(close(z, 0, 1e-12)).toBe(true);
    // yawFacing brings the spoke to just left of the viewer
    for (const j of [0, 6, 12]) {
      const p = rotateY(nodePosition(1, j, 0), yawFacing(j));
      expect(Math.atan2(p[0], p[2])).toBeCloseTo(-0.25);
    }
  });
});

describe('interaction and motion', () => {
  it('steps through scenarios with the arrow keys and clamps at the edges', () => {
    expect(stepNode(26, 'ArrowRight')).toBe(27);
    expect(stepNode(26, 'ArrowLeft')).toBe(26);
    expect(stepNode(26, 'ArrowDown')).toBe(13);
    expect(stepNode(26, 'ArrowUp')).toBe(26);
    expect(stepNode(14, 'End')).toBe(25);
    expect(stepNode(14, 'Home')).toBe(13);
    expect(stepNode(-1, 'ArrowRight')).toBe(20);
    expect(stepNode(5, 'x')).toBe(5);
  });

  it('re-seats with a spring that settles within 900 ms and does not jump', () => {
    let x = 0;
    let v = 0;
    let peak = 0;
    const dt = 1 / 60;
    const trace: number[] = [];
    for (let k = 0; k < 54; k++) {
      [x, v] = springStep(x, v, 1, dt);
      peak = Math.max(peak, x);
      trace.push(x);
    }
    expect(Math.abs(x - 1)).toBeLessThan(0.01);
    expect(Math.abs(v)).toBeLessThan(0.1);
    expect(peak).toBeLessThan(1.05);
    expect(trace[5]!).toBeLessThan(0.4); // not instant
    expect(trace[26]!).toBeGreaterThan(0.9); // mostly there by half time
    // frame-rate independent
    let y = 0;
    let w = 0;
    for (let k = 0; k < 27; k++) [y, w] = springStep(y, w, 1, 2 * dt);
    expect(Math.abs(y - x)).toBeLessThan(0.01);
  });

  it('wraps angle differences to the short way round', () => {
    expect(angleDelta(0, 0.5)).toBeCloseTo(0.5);
    expect(angleDelta(3, -3)).toBeCloseTo(2 * Math.PI - 6);
    expect(angleDelta(0, 7)).toBeCloseTo(7 - 2 * Math.PI);
  });
});

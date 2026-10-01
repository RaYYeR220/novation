'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, Environment, Lightformer } from '@react-three/drei';
import { Bloom, EffectComposer, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { CELLS } from '@/lib/scenario';
import {
  DATUM_RADIUS,
  FOV,
  GROUND_Y,
  HUB_RADIUS,
  IDLE_SPEED,
  INITIAL_YAW,
  LINKS,
  NODE_RADIUS,
  NODE_TUBE,
  angleDelta,
  cameraEye,
  crownBounds,
  fitCamera,
  linkEnds,
  nodeColor,
  nodeHeight,
  nodePositions,
  springStep,
} from './crownMath';
import type { CrownRig } from './rig';

type RigRef = RefObject<CrownRig | null>;

export interface CrownSceneProps {
  rigRef: RigRef;
  /** Poster capture: rest pose, no motion, keeps the drawing buffer. */
  still?: boolean;
  /** Render continuously and record frame timings on window.__crownPerf (lab only). */
  measure?: boolean;
  /** Start in the low-power tier (no transmission pass, lighter AA and bloom). It is also entered automatically. */
  low?: boolean;
  onReady?: () => void;
  onLost?: () => void;
}

const LINK_RADIUS = 0.03;
const SLEEVE = { radius: 0.043, length: 0.08 };
const HOVER_SCALE = 1.18;

/* ---------- geometry ---------- */

/** A shallow crystal cabochon: flat base, short wall, spherical cap. Built bottom-up so the lathe normals face out. */
function cabochon(radius: number, height: number, wall = 0.012, segments = 40, rows = 12) {
  const R = (radius * radius + height * height) / (2 * height);
  const phiMax = Math.asin(radius / R);
  const pts = [new THREE.Vector2(0, -wall), new THREE.Vector2(radius, -wall), new THREE.Vector2(radius, 0)];
  for (let k = rows; k >= 0; k--) {
    const phi = (k / rows) * phiMax;
    pts.push(new THREE.Vector2(Math.max(1e-4, R * Math.sin(phi)), R * Math.cos(phi) - (R - height)));
  }
  return new THREE.LatheGeometry(pts, segments);
}

function flatTorus(radius: number, tube: number, radial: number, tubular: number) {
  return new THREE.TorusGeometry(radius, tube, radial, tubular).rotateX(Math.PI / 2);
}

/** Vertex-coloured sky for the studio: cool dark ceiling, a lifted horizon band, near-black floor. */
function backdrop() {
  const r = 40;
  const g = new THREE.SphereGeometry(r, 64, 32);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color('#0c1222');
  const horizon = new THREE.Color('#2a3448');
  const bottom = new THREE.Color('#03060e');
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / r;
    if (y >= 0) c.copy(horizon).lerp(top, Math.pow(y, 0.35));
    else c.copy(horizon).lerp(bottom, Math.pow(-y, 0.25));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/* ---------- materials ---------- */

function chrome(color: string, roughness: number, clearcoat = 1) {
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness: 1,
    roughness,
    clearcoat,
    clearcoatRoughness: Math.min(0.12, roughness * 0.5),
  });
}

/** Clear crystal whose attenuation colour is the per-instance ramp colour. */
function tintedCrystal() {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.06,
    transmission: 1,
    thickness: 0.035,
    ior: 1.45,
    attenuationColor: new THREE.Color(1, 1, 1),
    attenuationDistance: 0.5,
    specularIntensity: 1,
    envMapIntensity: 1.25,
  });
  m.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader
      .replace('#include <color_fragment>', '')
      .replace(
        '#include <transmission_fragment>',
        THREE.ShaderChunk.transmission_fragment.replace(
          'material.attenuationColor = attenuationColor;',
          'material.attenuationColor = attenuationColor * vColor.rgb;',
        ),
      );
  };
  m.customProgramCacheKey = () => 'crown-tinted-crystal';
  return m;
}

/** Low-power stand-in: the same cabochon as a clear-coated tinted lens over the plate, without the transmission pass. */
function liteCrystal() {
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.05,
    transparent: true,
    opacity: 0.38,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    envMapIntensity: 1.3,
    depthWrite: false,
  });
}

function buildKit() {
  const mats = {
    hub: chrome('#ffffff', 0.07),
    node: chrome('#f3f5f9', 0.1),
    link: chrome('#e3e8f1', 0.17, 0.6),
    crystal: tintedCrystal(),
    crystalLite: liteCrystal(),
    plate: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.15, 1.15, 1.15) }),
    datum: new THREE.MeshBasicMaterial({ color: new THREE.Color("#10e1ff").multiplyScalar(3.6) }),
    halo: new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff4400').multiplyScalar(10) }),
  };
  const geos = {
    ring: flatTorus(NODE_RADIUS, NODE_TUBE, 18, 60),
    plate: new THREE.CircleGeometry(NODE_RADIUS - 0.03, 32).rotateX(-Math.PI / 2).translate(0, -0.004, 0),
    dome: cabochon(NODE_RADIUS - 0.022, 0.07),
    link: new THREE.CylinderGeometry(LINK_RADIUS, LINK_RADIUS, 1, 12, 1, true),
    sleeve: new THREE.CylinderGeometry(SLEEVE.radius, SLEEVE.radius, SLEEVE.length, 14, 1, false),
    bezel: flatTorus(HUB_RADIUS, 0.11, 36, 144),
    step: flatTorus(0.47, 0.034, 14, 112),
    hubDome: cabochon(0.46, 0.3, 0.02, 96, 18),
    datum: flatTorus(DATUM_RADIUS, 0.0095, 6, 256),
    halo: flatTorus(NODE_RADIUS + 0.06, 0.0065, 6, 64),
  };

  const rings = new THREE.InstancedMesh(geos.ring, mats.node, CELLS);
  const plates = new THREE.InstancedMesh(geos.plate, mats.plate, CELLS);
  const domes = new THREE.InstancedMesh(geos.dome, mats.crystal, CELLS);
  const links = new THREE.InstancedMesh(geos.link, mats.link, LINKS.length);
  const sleeves = new THREE.InstancedMesh(geos.sleeve, mats.node, LINKS.length * 2);
  for (const m of [rings, plates, domes, links, sleeves]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
  }
  const white = new THREE.Color(1, 1, 1);
  for (let i = 0; i < CELLS; i++) {
    plates.setColorAt(i, white);
    domes.setColorAt(i, white);
  }

  // the clearinghouse: a thick bezel, a raised step and a polished dome, all mirror chrome
  const hub = new THREE.Group();
  const bezel = new THREE.Mesh(geos.bezel, mats.hub);
  const step = new THREE.Mesh(geos.step, mats.node);
  step.position.y = 0.05;
  const dome = new THREE.Mesh(geos.hubDome, mats.hub);
  dome.position.y = 0.03;
  hub.add(bezel, step, dome);

  const datum = new THREE.Mesh(geos.datum, mats.datum);
  const halo = new THREE.Mesh(geos.halo, mats.halo);

  const root = new THREE.Group();
  root.add(hub, links, sleeves, rings, plates, domes, datum, halo);

  return {
    root,
    mats,
    rings,
    plates,
    domes,
    links,
    sleeves,
    datum,
    halo,
    dispose() {
      Object.values(geos).forEach((g) => g.dispose());
      Object.values(mats).forEach((m) => m.dispose());
      [rings, plates, domes, links, sleeves].forEach((m) => m.dispose());
    },
  };
}

type Kit = ReturnType<typeof buildKit>;

function swapGlass(kit: Kit, low: boolean) {
  kit.domes.material = low ? kit.mats.crystalLite : kit.mats.crystal;
}

/* ---------- per-frame writers ---------- */

const UP = new THREE.Vector3(0, 1, 0);
const tmp = {
  m: new THREE.Matrix4(),
  q: new THREE.Quaternion(),
  p: new THREE.Vector3(),
  s: new THREE.Vector3(),
  d: new THREE.Vector3(),
  c: new THREE.Color(),
  ends: new Float32Array(6),
  identity: new THREE.Quaternion(),
};

function writeNodes(kit: Kit, rig: CrownRig, pos: Float32Array) {
  for (let i = 0; i < CELLS; i++) {
    const s = i === rig.focus ? HOVER_SCALE : 1;
    tmp.p.set(pos[i * 3] as number, pos[i * 3 + 1] as number, pos[i * 3 + 2] as number);
    tmp.s.set(s, s, s);
    tmp.m.compose(tmp.p, tmp.identity, tmp.s);
    kit.rings.setMatrixAt(i, tmp.m);
    kit.plates.setMatrixAt(i, tmp.m);
    kit.domes.setMatrixAt(i, tmp.m);
    tmp.c.set(nodeColor(rig.shown[i] as number, rig.scale));
    kit.plates.setColorAt(i, tmp.c);
    kit.domes.setColorAt(i, tmp.c);
  }
  kit.rings.instanceMatrix.needsUpdate = true;
  kit.plates.instanceMatrix.needsUpdate = true;
  kit.domes.instanceMatrix.needsUpdate = true;
  if (kit.plates.instanceColor) kit.plates.instanceColor.needsUpdate = true;
  if (kit.domes.instanceColor) kit.domes.instanceColor.needsUpdate = true;

  const w = rig.worst;
  const ws = w === rig.focus ? HOVER_SCALE : 1;
  kit.halo.position.set(pos[w * 3] as number, pos[w * 3 + 1] as number, pos[w * 3 + 2] as number);
  kit.halo.scale.setScalar(ws);
  kit.datum.position.y = nodeHeight(-rig.shownIm, rig.scale);
}

function writeLinks(kit: Kit, pos: Float32Array) {
  const e = tmp.ends;
  for (let k = 0; k < LINKS.length; k++) {
    const link = LINKS[k] as (typeof LINKS)[number];
    linkEnds(link, pos, e);
    tmp.d.set((e[3] as number) - (e[0] as number), (e[4] as number) - (e[1] as number), (e[5] as number) - (e[2] as number));
    const len = tmp.d.length();
    tmp.d.divideScalar(len || 1);
    tmp.q.setFromUnitVectors(UP, tmp.d);
    tmp.p.set((e[0] as number) + (e[3] as number), (e[1] as number) + (e[4] as number), (e[2] as number) + (e[5] as number)).multiplyScalar(0.5);
    tmp.s.set(1, len, 1);
    tmp.m.compose(tmp.p, tmp.q, tmp.s);
    kit.links.setMatrixAt(k, tmp.m);
    // sleeves sit just outside the chrome they plug into
    tmp.s.set(1, 1, 1);
    const offA = (link[0] < 0 ? 0.105 : NODE_TUBE) + SLEEVE.length * 0.35;
    tmp.p.set(e[0] as number, e[1] as number, e[2] as number).addScaledVector(tmp.d, offA);
    tmp.m.compose(tmp.p, tmp.q, tmp.s);
    kit.sleeves.setMatrixAt(k * 2, tmp.m);
    tmp.p.set(e[3] as number, e[4] as number, e[5] as number).addScaledVector(tmp.d, -(NODE_TUBE + SLEEVE.length * 0.35));
    tmp.m.compose(tmp.p, tmp.q, tmp.s);
    kit.sleeves.setMatrixAt(k * 2 + 1, tmp.m);
  }
  kit.links.instanceMatrix.needsUpdate = true;
  kit.sleeves.instanceMatrix.needsUpdate = true;
}

/* ---------- scene parts ---------- */

/** Studio lighting, captured once into the environment map. Memoised: a re-render would re-capture the cube and PMREM. */
const Studio = memo(function Studio() {
  const sky = useMemo(() => backdrop(), []);
  useEffect(() => () => sky.dispose(), [sky]);
  return (
    <Environment resolution={512} frames={1}>
      <mesh geometry={sky}>
        <meshBasicMaterial vertexColors side={THREE.BackSide} toneMapped={false} />
      </mesh>
      {/* overhead softbox behind the crown: the bright top edge of every ring */}
      <Lightformer form="rect" intensity={1.5} position={[0, 9, -4]} target={[0, 0, 0]} scale={[16, 5, 1]} />
      {/* thin strips: crisp highlight lines along the tubes */}
      <Lightformer form="rect" intensity={1.9} position={[0, 3.2, -8]} target={[0, 0, 0]} scale={[22, 0.45, 1]} />
      <Lightformer form="rect" intensity={1.9} position={[0, 6.5, 5]} target={[0, 0, 0]} scale={[18, 0.35, 1]} />
      {/* key from the left, fill strip on the right */}
      <Lightformer form="rect" intensity={1.9} position={[-8, 3, 2]} target={[0, 0, 0]} scale={[2.6, 7, 1]} />
      <Lightformer form="rect" intensity={1.5} position={[8, 2.5, -1]} target={[0, 0, 0]} scale={[1.1, 8, 1]} />
      {/* window softbox near the camera: the soft reflection on the hub dome and the near faces of the rings */}
      <Lightformer form="rect" intensity={1.1} position={[-2.5, 4.4, 9]} target={[0, 0, 0]} scale={[6, 2.6, 1]} />
      {/* low front card so the near slopes never fall to black */}
      <Lightformer form="rect" intensity={0.55} position={[0, 1, 9]} target={[0, 0, 0]} scale={[14, 1.6, 1]} />
      {/* ring light for round glints on the crystal */}
      <Lightformer form="ring" intensity={1.9} position={[2.5, 7, 3]} target={[0, 0, 0]} scale={1.6} />
      {/* cyan rim and navy floor bounce */}
      <Lightformer form="rect" intensity={1.3} color="#10e1ff" position={[0, 0.3, -10]} target={[0, 0, 0]} scale={[26, 0.22, 1]} />
      <Lightformer form="rect" intensity={0.7} color="#1b418c" position={[0, -7, 0]} target={[0, 0, 0]} scale={[30, 30, 1]} />
    </Environment>
  );
});

const CameraRig = memo(function CameraRig({ rigRef }: { rigRef: RigRef }) {
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const get = useThree((s) => s.get);
  useLayoutEffect(() => {
    const r = rigRef.current;
    const { camera, invalidate } = get();
    if (!r || !(camera instanceof THREE.PerspectiveCamera) || width < 2 || height < 2) return;
    const fit = fitCamera(width / height, crownBounds(r.scale));
    const eye = cameraEye(fit);
    camera.fov = fit.fov;
    camera.near = 0.5;
    camera.far = fit.distance + 20;
    camera.position.set(eye[0], eye[1], eye[2]);
    camera.lookAt(0, fit.targetY, 0);
    camera.setViewOffset(width, height, 0, (fit.shiftY * height) / 2, width, height);
    camera.updateProjectionMatrix();
    invalidate();
  }, [width, height, get, rigRef]);
  return null;
});

interface ModelProps {
  rigRef: RigRef;
  still: boolean;
  low: boolean;
  onReady?: () => void;
  onSlow: () => void;
}

const CrownModel = memo(function CrownModel({ rigRef, still, low, onReady, onSlow }: ModelProps) {
  const group = useRef<THREE.Group>(null);
  const kit = useMemo(() => buildKit(), []);
  useEffect(() => () => kit.dispose(), [kit]);
  const [shadowLive, setShadowLive] = useState(false);
  const get = useThree((s) => s.get);
  useEffect(() => {
    swapGlass(kit, low);
    get().gl.domElement.dataset.tier = low ? 'low' : 'full';
    rigRef.current?.invalidate();
  }, [kit, low, rigRef, get]);

  const state = useRef({
    pos: new Float32Array(CELLS * 3),
    version: -1,
    focus: -2,
    ready: false,
    frames: 0,
    slowFrames: 0,
    shadowLive: false,
    world: new THREE.Vector3(),
  });

  // seed the instances before the first frame so the contact shadow sees the crown
  useLayoutEffect(() => {
    const r = rigRef.current;
    if (!r) return;
    nodePositions(r.shown, r.scale, state.current.pos);
    writeNodes(kit, r, state.current.pos);
    writeLinks(kit, state.current.pos);
    if (group.current) group.current.rotation.y = still ? INITIAL_YAW : r.yaw;
  }, [kit, rigRef, still]);

  useFrame((three, rawDt) => {
    const r = rigRef.current;
    const g = group.current;
    if (!r || !g) return;
    const st = state.current;
    const dt = Math.min(rawDt, 0.1);
    let moving = false;

    // springs
    let dirty = st.version !== r.version || st.focus !== r.focus;
    if (st.version !== r.version) {
      st.version = r.version;
      if (!still && !r.reduced && !st.shadowLive && st.frames > 0) {
        st.shadowLive = true;
        setShadowLive(true);
      }
    }
    if (still || r.reduced) {
      let off = r.shownIm !== r.targetIm;
      for (let i = 0; i < CELLS && !off; i++) off = r.shown[i] !== r.target[i];
      if (off) {
        r.snap();
        dirty = true;
      }
    } else {
      let unsettled = false;
      for (let i = 0; i < CELLS; i++) {
        const t = r.target[i] as number;
        const x = r.shown[i] as number;
        const v = r.vel[i] as number;
        if (Math.abs(x - t) < 1e-3 && Math.abs(v) < 1e-3) {
          if (x !== t) {
            r.shown[i] = t;
            r.vel[i] = 0;
            dirty = true;
          }
          continue;
        }
        const [nx, nv] = springStep(x, v, t, dt);
        r.shown[i] = nx;
        r.vel[i] = nv;
        unsettled = true;
      }
      if (Math.abs(r.shownIm - r.targetIm) > 1e-3 || Math.abs(r.velIm) > 1e-3) {
        [r.shownIm, r.velIm] = springStep(r.shownIm, r.velIm, r.targetIm, dt);
        unsettled = true;
      } else {
        r.shownIm = r.targetIm;
        r.velIm = 0;
      }
      if (unsettled) {
        dirty = true;
        moving = true;
      } else if (st.shadowLive) {
        st.shadowLive = false;
        setShadowLive(false);
      }
    }
    st.focus = r.focus;
    if (dirty) {
      nodePositions(r.shown, r.scale, st.pos);
      writeNodes(kit, r, st.pos);
      writeLinks(kit, st.pos);
    }

    // yaw: drag follows the pointer, keyboard dials the stepped node forward, otherwise idle turn with inertia
    if (still) {
      r.yaw = INITIAL_YAW;
    } else if (r.dragging) {
      const k = r.reduced ? 1 : 1 - Math.exp(-dt * 16);
      const before = r.yaw;
      r.yaw += (r.dragGoal - r.yaw) * k;
      r.yawVel = dt > 0 ? (r.yaw - before) / dt : 0;
      moving = Math.abs(r.dragGoal - r.yaw) > 1e-4;
    } else if (r.keyGoal !== null && !r.reduced) {
      const d = angleDelta(r.yaw, r.keyGoal);
      r.yaw += d * (1 - Math.exp(-dt * 7));
      r.yawVel = 0;
      moving = moving || Math.abs(d) > 1e-4;
    } else if (!r.reduced) {
      const idle = r.visible && r.focusSource === 'none' ? IDLE_SPEED : 0;
      r.yawVel += (idle - r.yawVel) * (1 - Math.exp(-dt * 2.4));
      if (Math.abs(r.yawVel - idle) < 1e-4) r.yawVel = idle;
      r.yaw += r.yawVel * dt;
      moving = moving || Math.abs(r.yawVel) > 1e-5;
    } else {
      r.yawVel = 0;
    }
    g.rotation.y = r.yaw;
    g.updateMatrixWorld();

    // project node centres for the DOM overlay
    const { camera, size } = three;
    for (let i = 0; i < CELLS; i++) {
      st.world.set(st.pos[i * 3] as number, st.pos[i * 3 + 1] as number, st.pos[i * 3 + 2] as number).applyMatrix4(g.matrixWorld).project(camera);
      r.screen[i * 2] = ((st.world.x + 1) / 2) * size.width;
      r.screen[i * 2 + 1] = ((1 - st.world.y) / 2) * size.height;
    }

    // slow device: sustained < 40 fps while animating drops the extras
    if (moving && rawDt > 0 && rawDt < 0.2) {
      st.slowFrames = rawDt > 1 / 40 ? st.slowFrames + 1 : Math.max(0, st.slowFrames - 2);
      if (st.slowFrames === 90) onSlow();
    }

    r.frames++;
    st.frames++;
    r.onFrame?.();
    if (!st.ready && st.frames >= 2) {
      st.ready = true;
      onReady?.();
    }
    if (!st.ready || (moving && (r.visible || r.dragging))) three.invalidate();
  }, -1);

  return (
    <group ref={group}>
      <primitive object={kit.root} />
      <ContactShadows
        position={[0, GROUND_Y, 0]}
        scale={8.4}
        resolution={512}
        blur={2.2}
        far={2.6}
        opacity={0.95}
        color="#01040f"
        frames={shadowLive ? Infinity : 1}
      />
    </group>
  );
});

const Effects = memo(function Effects({ low }: { low: boolean }) {
  // dense pixels need less MSAA; one sample pass at 4x on a 1.75 DPR laptop panel costs more than it shows
  const dense = useThree((s) => s.viewport.dpr > 1.3);
  return (
    <EffectComposer multisampling={low ? 0 : dense ? 2 : 4} frameBufferType={THREE.HalfFloatType} stencilBuffer={false}>
      <Bloom mipmapBlur luminanceThreshold={2.1} luminanceSmoothing={0.2} intensity={low ? 0.3 : 0.42} radius={0.42} levels={5} />
      <ToneMapping mode={ToneMappingMode.NEUTRAL} />
    </EffectComposer>
  );
});

declare global {
  interface Window {
    __crownPerf?: { cpu: number[]; gpu: number[]; dt: number[]; calls: number; triangles: number; gpuTimer: boolean; dpr: number };
  }
}

/** Frame timing for the lab: CPU submit time, GPU time (when EXT_disjoint_timer_query_webgl2 exists) and frame intervals. */
function Probe() {
  const get = useThree((s) => s.get);
  const q = useRef<{
    gl: THREE.WebGLRenderer;
    ctx: WebGL2RenderingContext;
    ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    pending: WebGLQuery[];
    t0: number;
    active: WebGLQuery | null;
  } | null>(null);
  useEffect(() => {
    const gl = get().gl;
    const ctx = gl.getContext() as WebGL2RenderingContext;
    const ext = ctx.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    q.current = { gl, ctx, ext, pending: [], t0: 0, active: null };
    setInfoAutoReset(gl, false);
    window.__crownPerf = { cpu: [], gpu: [], dt: [], calls: 0, triangles: 0, gpuTimer: !!ext, dpr: gl.getPixelRatio() };
    return () => setInfoAutoReset(gl, true);
  }, [get]);
  useFrame((_, dt) => {
    const p = q.current;
    const out = window.__crownPerf;
    if (!p || !out) return;
    p.gl.info.reset();
    out.dt.push(dt * 1000);
    p.t0 = performance.now();
    if (p.ext) {
      const query = p.ctx.createQuery();
      if (query) {
        p.ctx.beginQuery(p.ext.TIME_ELAPSED_EXT, query);
        p.active = query;
      }
    }
  }, -100);
  useFrame(() => {
    const p = q.current;
    const out = window.__crownPerf;
    if (!p || !out) return;
    if (p.ext && p.active) {
      p.ctx.endQuery(p.ext.TIME_ELAPSED_EXT);
      p.pending.push(p.active);
      p.active = null;
    }
    out.cpu.push(performance.now() - p.t0);
    out.calls = p.gl.info.render.calls;
    out.triangles = p.gl.info.render.triangles;
    out.dpr = p.gl.getPixelRatio();
    if (p.ext) {
      const disjoint = p.ctx.getParameter(p.ext.GPU_DISJOINT_EXT);
      while (p.pending.length) {
        const head = p.pending[0] as WebGLQuery;
        if (!p.ctx.getQueryParameter(head, p.ctx.QUERY_RESULT_AVAILABLE)) break;
        const ns = p.ctx.getQueryParameter(head, p.ctx.QUERY_RESULT) as number;
        if (!disjoint) out.gpu.push(ns / 1e6);
        p.ctx.deleteQuery(head);
        p.pending.shift();
      }
    }
  }, 100);
  return null;
}

/** GPU budget per frame; above it (median of the first frames) the scene drops to the low tier. */
const GPU_BUDGET_MS = 5;

type TimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

/**
 * Measures real GPU time for the first frames with EXT_disjoint_timer_query_webgl2 and calls
 * onOver when the median is above budget. Browsers without the extension fall back to the
 * frame-interval check in CrownModel.
 */
const GpuBudget = memo(function GpuBudget({ onOver }: { onOver: () => void }) {
  const get = useThree((s) => s.get);
  const st = useRef<{ ctx: WebGL2RenderingContext; ext: TimerExt; pending: WebGLQuery[]; samples: number[]; active: WebGLQuery | null; done: boolean } | null>(null);
  useEffect(() => {
    const ctx = get().gl.getContext() as WebGL2RenderingContext;
    const ext = ctx.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
    if (ext) st.current = { ctx, ext, pending: [], samples: [], active: null, done: false };
    return () => {
      const s = st.current;
      if (s) s.pending.forEach((q) => s.ctx.deleteQuery(q));
      st.current = null;
    };
  }, [get]);
  useFrame(() => {
    const s = st.current;
    if (!s || s.done || s.pending.length > 4) return;
    const q = s.ctx.createQuery();
    if (!q) return;
    s.ctx.beginQuery(s.ext.TIME_ELAPSED_EXT, q);
    s.active = q;
  }, -100);
  useFrame(() => {
    const s = st.current;
    if (!s || s.done) return;
    if (s.active) {
      s.ctx.endQuery(s.ext.TIME_ELAPSED_EXT);
      s.pending.push(s.active);
      s.active = null;
    }
    const disjoint = s.ctx.getParameter(s.ext.GPU_DISJOINT_EXT);
    while (s.pending.length) {
      const head = s.pending[0] as WebGLQuery;
      if (!s.ctx.getQueryParameter(head, s.ctx.QUERY_RESULT_AVAILABLE)) break;
      const ns = s.ctx.getQueryParameter(head, s.ctx.QUERY_RESULT) as number;
      if (!disjoint) s.samples.push(ns / 1e6);
      s.ctx.deleteQuery(head);
      s.pending.shift();
    }
    // skip the first frames (shader warm-up, environment capture), then judge on 60 samples
    if (s.samples.length >= 75) {
      s.done = true;
      const sorted = s.samples.slice(15).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] as number;
      if (median > GPU_BUDGET_MS) onOver();
    }
  }, 100);
  return null;
});

function setInfoAutoReset(gl: THREE.WebGLRenderer, on: boolean) {
  gl.info.autoReset = on;
}

const DPR_FULL: [number, number] = [1, 1.75];
const DPR_LOW: [number, number] = [1, 1.25];
const CAMERA = { fov: FOV, near: 0.5, far: 60, position: [0, 6, 14] as [number, number, number] };
const GL = { antialias: false, alpha: true, stencil: false, powerPreference: 'high-performance' as const };
const GL_STILL = { ...GL, preserveDrawingBuffer: true };
const FILL = { position: 'absolute', inset: 0 } as const;

function CrownScene({ rigRef, still = false, measure = false, low: startLow = false, onReady, onLost }: CrownSceneProps) {
  const [low, setLow] = useState(startLow);
  const onSlow = useCallback(() => setLow(true), []);
  return (
    <Canvas
      dpr={low ? DPR_LOW : DPR_FULL}
      frameloop={measure ? 'always' : 'demand'}
      gl={still ? GL_STILL : GL}
      camera={CAMERA}
      onCreated={({ gl, invalidate }) => {
        gl.setClearColor(0x000000, 0);
        gl.transmissionResolutionScale = 0.5;
        const r = rigRef.current;
        if (r) r.invalidate = invalidate;
        gl.domElement.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          onLost?.();
        });
      }}
      style={FILL}
    >
      <CameraRig rigRef={rigRef} />
      <Studio />
      <CrownModel rigRef={rigRef} still={still} low={low} onReady={onReady} onSlow={onSlow} />
      <Effects low={low} />
      {measure ? <Probe /> : !low && !still ? <GpuBudget onOver={onSlow} /> : null}
    </Canvas>
  );
}

export default memo(CrownScene);

/**
 * poster-vj.js — Three.js VJ engine for the "异质同构与蒙德里安" poster.
 *
 * Original VJ look restored: floating Mondrian cube cloud with spring physics,
 * spin, kick detonation, mixed-shape shards and roaming wide-angle camera.
 * The newer coloured glow is kept through shards and bloom, without hash-shaped
 * bars or visible orb light sources.
 */
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const canvas = document.getElementById("poster");

const PALETTE = {
  red: new THREE.Color("#dc241c"),
  yellow: new THREE.Color("#edc312"),
  blue: new THREE.Color("#1a45cc"),
  white: new THREE.Color("#dcdad0"),
  black: new THREE.Color("#101013"),
};
const GLOW = {
  red: new THREE.Color(1.0, 0.05, 0.04),
  yellow: new THREE.Color(1.0, 0.78, 0.05),
  blue: new THREE.Color(0.07, 0.22, 1.0),
};
const SHARD_COLORS = [GLOW.red, GLOW.yellow, GLOW.blue, new THREE.Color(0.96, 0.96, 0.9)];
const PITCH_COLOR = [0, 2, 1, 0, 2, 1, 2, 0, 1, 2, 0, 1];

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;

const scene = new THREE.Scene();
scene.background = new THREE.Color("#0a0a0e");
scene.fog = new THREE.FogExp2("#0a0a0e", 0.016);

const camera = new THREE.PerspectiveCamera(74, 0.707, 0.1, 200);
camera.position.set(0, 0, 22);

// ── Floating Mondrian cube cloud (original VJ lattice) ──
const GX = 9;
const GY = 13;
const GZ = 5;
const COUNT = GX * GY * GZ;
const SPACING = 1.5;
const CUBE = 0.64;
const halfW = ((GX - 1) / 2) * SPACING;
const halfH = ((GY - 1) / 2) * SPACING;
const halfD = ((GZ - 1) / 2) * SPACING;

// Stable pseudo-randomness keeps the original lively density while giving the
// cube field a repeatable composition instead of reshuffling on every refresh.
function hash01(x, y, z, salt = 0) {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + salt * 53.3) * 43758.5453;
  return n - Math.floor(n);
}

function pickColor(x, y, z) {
  const accent = hash01(x, y, z, 1);
  // Loose colour territories create an asymmetric Mondrian rhythm without
  // turning the cloud into rigid stripes.
  if (x <= 2 && y >= 7 && accent < 0.34) return PALETTE.red;
  if (x >= 5 && y >= 5 && accent < 0.28) return PALETTE.blue;
  if (x >= 4 && y <= 3 && accent < 0.22) return PALETTE.yellow;

  const r = hash01(x, y, z, 2);
  if (r < 0.36) return PALETTE.white;
  if (r < 0.57) return PALETTE.black;
  if (r < 0.75) return PALETTE.red;
  if (r < 0.9) return PALETTE.blue;
  return PALETTE.yellow;
}

const cubeGeo = new THREE.BoxGeometry(CUBE, CUBE, CUBE);
const cubeMat = new THREE.MeshBasicMaterial({ toneMapped: true });
const cubes = new THREE.InstancedMesh(cubeGeo, cubeMat, COUNT);
cubes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
cubes.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 3), 3);
scene.add(cubes);

const dummy = new THREE.Object3D();
const tmpColor = new THREE.Color();

const home = new Float32Array(COUNT * 3);
const pos = new Float32Array(COUNT * 3);
const vel = new Float32Array(COUNT * 3);
const baseColor = [];
const bandOf = new Int32Array(COUNT);
const seed = new Float32Array(COUNT);
const spin = new Float32Array(COUNT * 3);
const sizeRhythm = new Float32Array(COUNT);
const depthTone = new Float32Array(COUNT);

let ci = 0;
for (let x = 0; x < GX; x++) {
  for (let y = 0; y < GY; y++) {
    for (let z = 0; z < GZ; z++) {
      const hx = (x - (GX - 1) / 2) * SPACING;
      const hy = (y - (GY - 1) / 2) * SPACING;
      const hz = (z - (GZ - 1) / 2) * SPACING;
      home[ci * 3] = hx; home[ci * 3 + 1] = hy; home[ci * 3 + 2] = hz;
      pos[ci * 3] = hx; pos[ci * 3 + 1] = hy; pos[ci * 3 + 2] = hz;
      baseColor[ci] = pickColor(x, y, z);
      bandOf[ci] = Math.min(7, Math.floor((y / GY) * 8));
      seed[ci] = hash01(x, y, z, 3) * 1000;
      spin[ci * 3] = hash01(x, y, z, 4) * 2 - 1;
      spin[ci * 3 + 1] = hash01(x, y, z, 5) * 2 - 1;
      spin[ci * 3 + 2] = hash01(x, y, z, 6) * 2 - 1;
      const sizeHash = hash01(x, y, z, 7);
      sizeRhythm[ci] = sizeHash > 0.9 ? 1.16 : sizeHash < 0.16 ? 0.88 : 1;
      // Rear layers stay slightly quieter, so the front plane reads first while
      // the five-layer depth and explosive perspective remain intact.
      depthTone[ci] = 0.72 + (z / Math.max(1, GZ - 1)) * 0.28;
      ci++;
    }
  }
}

// ── Wireframe shell ──
const shellMat = new THREE.MeshBasicMaterial({
  color: "#243056", wireframe: true, transparent: true, opacity: 0.14,
});
const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(16, 1), shellMat);
scene.add(shell);

// ── Mixed-shape shard bursts ──
const SHAPES = [
  new THREE.BoxGeometry(0.5, 0.5, 0.5),
  new THREE.TetrahedronGeometry(0.46),
  new THREE.OctahedronGeometry(0.42),
  new THREE.BoxGeometry(1.0, 0.16, 0.16),
  new THREE.IcosahedronGeometry(0.4, 0),
];
const SHARD_CAP = 150;
const shardMat = new THREE.MeshBasicMaterial({ toneMapped: true });
const pools = SHAPES.map((geo) => {
  const mesh = new THREE.InstancedMesh(geo, shardMat, SHARD_CAP);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SHARD_CAP * 3), 3);
  mesh.frustumCulled = false;
  scene.add(mesh);
  dummy.position.set(0, 0, 0);
  dummy.scale.setScalar(0);
  dummy.updateMatrix();
  for (let i = 0; i < SHARD_CAP; i++) mesh.setMatrixAt(i, dummy.matrix);
  mesh.instanceMatrix.needsUpdate = true;
  return {
    mesh, head: 0,
    pos: new Float32Array(SHARD_CAP * 3),
    vel: new Float32Array(SHARD_CAP * 3),
    rot: new Float32Array(SHARD_CAP * 3),
    spin: new Float32Array(SHARD_CAP * 3),
    life: new Float32Array(SHARD_CAP),
    scl: new Float32Array(SHARD_CAP),
    col: new Float32Array(SHARD_CAP * 3),
  };
});

function spawnShards(amount, colorIdx, power) {
  for (let n = 0; n < amount; n++) {
    const p = pools[(Math.random() * pools.length) | 0];
    const i = p.head;
    p.head = (p.head + 1) % SHARD_CAP;
    const o = i * 3;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(rand(-1, 1));
    const sp = power * rand(0.45, 1.25);
    p.pos[o] = rand(-3, 3);
    p.pos[o + 1] = rand(-3, 3);
    p.pos[o + 2] = rand(-2, halfD + 1);
    p.vel[o] = Math.sin(phi) * Math.cos(theta) * sp;
    p.vel[o + 1] = Math.sin(phi) * Math.sin(theta) * sp + rand(0, 2);
    p.vel[o + 2] = Math.cos(phi) * sp;
    p.rot[o] = rand(0, 6.28); p.rot[o + 1] = rand(0, 6.28); p.rot[o + 2] = rand(0, 6.28);
    p.spin[o] = rand(-4, 4); p.spin[o + 1] = rand(-4, 4); p.spin[o + 2] = rand(-4, 4);
    p.life[i] = rand(0.7, 1.6);
    p.scl[i] = rand(0.5, 1.4);
    const c = SHARD_COLORS[colorIdx % SHARD_COLORS.length];
    p.col[o] = c.r; p.col[o + 1] = c.g; p.col[o + 2] = c.b;
  }
}

function updateShards(dt) {
  const drag = Math.exp(-1.2 * dt);
  for (let pi = 0; pi < pools.length; pi++) {
    const p = pools[pi];
    let changed = false;
    for (let i = 0; i < SHARD_CAP; i++) {
      if (p.life[i] <= 0) continue;
      const o = i * 3;
      p.life[i] -= dt;
      p.vel[o] *= drag; p.vel[o + 1] *= drag; p.vel[o + 2] *= drag;
      p.vel[o + 1] -= 2.2 * dt;
      p.pos[o] += p.vel[o] * dt;
      p.pos[o + 1] += p.vel[o + 1] * dt;
      p.pos[o + 2] += p.vel[o + 2] * dt;
      p.rot[o] += p.spin[o] * dt;
      p.rot[o + 1] += p.spin[o + 1] * dt;
      p.rot[o + 2] += p.spin[o + 2] * dt;
      changed = true;
      if (p.life[i] <= 0) {
        dummy.position.set(0, 0, 0); dummy.scale.setScalar(0); dummy.updateMatrix();
        p.mesh.setMatrixAt(i, dummy.matrix);
        continue;
      }
      const fade = Math.min(1, p.life[i] / 0.4);
      const jitter = musicActive && motionGate > 0.2 ? (0.018 + levelEnv * 0.035 + kickEnv * 0.03) * motionGate : 0;
      const jt = clock.elapsedTime * 18 + i * 2.17 + pi * 5.31;
      dummy.position.set(
        p.pos[o] + Math.sin(jt) * jitter,
        p.pos[o + 1] + Math.cos(jt * 1.17) * jitter,
        p.pos[o + 2] + Math.sin(jt * 0.83) * jitter
      );
      dummy.rotation.set(
        p.rot[o] + Math.sin(jt * 0.9) * jitter * 0.8,
        p.rot[o + 1] + Math.cos(jt * 1.1) * jitter * 0.8,
        p.rot[o + 2]
      );
      dummy.scale.setScalar(p.scl[i] * Math.max(0.05, fade));
      dummy.updateMatrix();
      p.mesh.setMatrixAt(i, dummy.matrix);
      tmpColor.setRGB(p.col[o] * fade, p.col[o + 1] * fade, p.col[o + 2] * fade);
      p.mesh.setColorAt(i, tmpColor);
    }
    if (changed) {
      p.mesh.instanceMatrix.needsUpdate = true;
      if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
    }
  }
}

// ── Firework sparks: additive points that burst out, arc under gravity and
// twinkle as they die — fired on strong hits / chorus peaks. ──
const FW_CAP = 3200;
const fwPos = new Float32Array(FW_CAP * 3);
const fwVel = new Float32Array(FW_CAP * 3);
const fwLife = new Float32Array(FW_CAP);
const fwLife0 = new Float32Array(FW_CAP);
const fwBase = new Float32Array(FW_CAP * 3);
const fwColAttr = new Float32Array(FW_CAP * 3);
for (let i = 0; i < FW_CAP; i++) fwPos[i * 3] = 99999;
const fwGeo = new THREE.BufferGeometry();
fwGeo.setAttribute("position", new THREE.BufferAttribute(fwPos, 3));
fwGeo.setAttribute("color", new THREE.BufferAttribute(fwColAttr, 3));
const fwMat = new THREE.PointsMaterial({
  size: 0.46,
  vertexColors: true,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  sizeAttenuation: true,
});
const fireworks = new THREE.Points(fwGeo, fwMat);
fireworks.frustumCulled = false;
scene.add(fireworks);
let fwHead = 0;
const FW_PALETTE = [
  new THREE.Color("#ff4030"),
  new THREE.Color("#ffd23a"),
  new THREE.Color("#3a7bff"),
  new THREE.Color("#ff7ad0"),
  new THREE.Color("#7affd0"),
];

function spawnFirework(cx, cy, cz, count, power, baseCol) {
  for (let n = 0; n < count; n++) {
    const i = fwHead;
    fwHead = (fwHead + 1) % FW_CAP;
    const o = i * 3;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(rand(-1, 1));
    const sp = power * rand(0.5, 1.3);
    fwPos[o] = cx; fwPos[o + 1] = cy; fwPos[o + 2] = cz;
    fwVel[o] = Math.sin(phi) * Math.cos(theta) * sp;
    fwVel[o + 1] = Math.sin(phi) * Math.sin(theta) * sp;
    fwVel[o + 2] = Math.cos(phi) * sp;
    const life = rand(1.0, 2.0);
    fwLife[i] = life;
    fwLife0[i] = life;
    // Push the base colour past 1 so the additive sparks really pop/bloom.
    const c = baseCol || FW_PALETTE[(Math.random() * FW_PALETTE.length) | 0];
    const intensity = 1.8;
    fwBase[o] = c.r * intensity; fwBase[o + 1] = c.g * intensity; fwBase[o + 2] = c.b * intensity;
  }
}

function updateFireworks(dt) {
  const drag = Math.exp(-1.1 * dt);
  for (let i = 0; i < FW_CAP; i++) {
    if (fwLife[i] <= 0) continue;
    const o = i * 3;
    fwLife[i] -= dt;
    if (fwLife[i] <= 0) {
      fwPos[o] = 99999;
      fwColAttr[o] = fwColAttr[o + 1] = fwColAttr[o + 2] = 0;
      continue;
    }
    fwVel[o] *= drag; fwVel[o + 1] *= drag; fwVel[o + 2] *= drag;
    fwVel[o + 1] -= 2.6 * dt; // gravity → arcing trails
    fwPos[o] += fwVel[o] * dt;
    fwPos[o + 1] += fwVel[o + 1] * dt;
    fwPos[o + 2] += fwVel[o + 2] * dt;
    const fade = fwLife[i] / fwLife0[i];
    const twinkle = 0.55 + 0.45 * Math.sin(fwLife[i] * 40 + i);
    const b = fade * fade * twinkle;
    fwColAttr[o] = fwBase[o] * b;
    fwColAttr[o + 1] = fwBase[o + 1] * b;
    fwColAttr[o + 2] = fwBase[o + 2] * b;
  }
  fwGeo.attributes.position.needsUpdate = true;
  fwGeo.attributes.color.needsUpdate = true;
}

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(768, 1086), 0.44, 0.46, 0.74);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function resize() {
  const w = canvas.clientWidth || 768;
  const h = canvas.clientHeight || 1086;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  composer.setSize(w, h);
  bloom.setSize(w, h);
}
window.addEventListener("resize", resize);

canvas.addEventListener("pointerdown", () => {
  if (!musicActive) return;
  kickEnv = 1;
  detonate(0.9);
  spawnShards(36, (Math.random() * 3) | 0, 9);
  spawnFirework(rand(-halfW * 0.4, halfW * 0.4), rand(0, halfH * 0.5), rand(-2, halfD),
    200, 8, FW_PALETTE[(Math.random() * FW_PALETTE.length) | 0]);
});

// Pause / play control in the dock. Pause FREEZES the current animated frame
// (holds it exactly) so it can be screenshotted/exported as a still poster.
const toggleBtn = document.getElementById("audio-toggle");
let lastToggleLabel = "";
let frozen = false;
if (toggleBtn) {
  toggleBtn.addEventListener("click", async () => {
    const st = window.MUSIC && window.MUSIC.state;
    if (!st || !st.ready) return;
    const playing = window.MUSIC.isPlaying && window.MUSIC.isPlaying();
    if (playing) {
      if (window.MUSIC.togglePlay) window.MUSIC.togglePlay(); // pause audio
      frozen = true;                                          // hold the frame
    } else {
      if (window.MUSIC.resume) await window.MUSIC.resume();
      if (window.MUSIC.togglePlay) window.MUSIC.togglePlay(); // resume audio
      frozen = false;
    }
    setToggleLabel(frozen ? "▶ 播放" : "⏸ 暂停");
  });
}
function setToggleLabel(label) {
  if (toggleBtn && label !== lastToggleLabel) {
    toggleBtn.textContent = label;
    lastToggleLabel = label;
  }
}
function syncToggle() {
  if (!toggleBtn) return;
  const st = window.MUSIC && window.MUSIC.state;
  const ready = !!(st && st.ready);
  toggleBtn.hidden = !ready;
  const playing = ready && window.MUSIC.isPlaying && window.MUSIC.isPlaying();
  setToggleLabel(playing ? "⏸ 暂停" : "▶ 播放");
}

let levelEnv = 0;
let kickEnv = 0;
let beatEnv = 0;
let chorusEnv = 0;
let bassEnv = 0;
const bandEnv = new Float32Array(8);
let chorusEmit = 0;
let camAngle = 0;
let musicActive = false;
let motionGate = 0;
let lastVisualKickAt = -Infinity;
const baseFov = 74;
// Smoothed camera state so motion eases instead of snapping/shaking each frame.
let camPosX = 0, camPosY = 0, camPosZ = 22;
let camRoll = 0;
let fovEnv = 74;
const MOTION_GATE_LEVEL = 0.22;
const KICK_GATE_LEVEL = 0.28;
const KICK_GATE_BASS = 0.18;
const VISUAL_KICK_GAP = 0.32;
let lastFwAt = -Infinity;
const FW_GAP = 0.3;

const clock = new THREE.Clock();

function readMusic() {
  const m = window.MUSIC ? window.MUSIC.state : null;
  const playing = !!(m && m.ready && window.MUSIC && window.MUSIC.isPlaying && window.MUSIC.isPlaying());
  if (playing) {
    musicActive = true;
    levelEnv = lerp(levelEnv, clamp01(m.levelSmooth * 3.2), 0.2);
    bassEnv = lerp(bassEnv, clamp01(m.bassEnergy * 4.5), 0.25);
    chorusEnv = lerp(chorusEnv, clamp01(m.chorusLevel), 0.06);
    motionGate = lerp(motionGate, clamp01((levelEnv - MOTION_GATE_LEVEL) / 0.45), 0.18);
    for (let b = 0; b < 8; b++) {
      bandEnv[b] = lerp(bandEnv[b], clamp01((m.bandVal[b] || 0) * 3.0), 0.3);
    }
    const now = clock.elapsedTime;
    const strongKick =
      m.kick &&
      levelEnv > KICK_GATE_LEVEL &&
      (bassEnv > KICK_GATE_BASS || (m.kickEnergy || 0) > 0.08) &&
      now - lastVisualKickAt > VISUAL_KICK_GAP;
    if (strongKick) {
      lastVisualKickAt = now;
      kickEnv = 1;
      const idx = m.chord && m.chord.root >= 0 ? PITCH_COLOR[m.chord.root] : (Math.random() * 3) | 0;
      detonate(0.55 + bassEnv * 0.85 + chorusEnv * 0.6);
      spawnShards(26 + Math.floor((bassEnv + chorusEnv) * 38), idx, 6 + bassEnv * 5 + chorusEnv * 4);
      // Firework on most kicks (slightly throttled) so the bursts read clearly.
      if ((bassEnv > 0.2 || chorusEnv > 0.3) && now - lastFwAt > FW_GAP) {
        lastFwAt = now;
        const cx = rand(-halfW * 0.5, halfW * 0.5);
        const cy = rand(-halfH * 0.15, halfH * 0.6);
        const cz = rand(-2, halfD + 1);
        spawnFirework(cx, cy, cz, 150 + Math.floor(bassEnv * 110 + chorusEnv * 110),
          6.5 + bassEnv * 5 + chorusEnv * 5, FW_PALETTE[idx % FW_PALETTE.length]);
      }
    }
    if (m.beat) beatEnv = 1;
  } else {
    musicActive = false;
    levelEnv = lerp(levelEnv, 0, 0.12);
    bassEnv = lerp(bassEnv, 0, 0.12);
    chorusEnv = lerp(chorusEnv, 0, 0.12);
    motionGate = lerp(motionGate, 0, 0.12);
    for (let b = 0; b < 8; b++) {
      bandEnv[b] = lerp(bandEnv[b], 0, 0.12);
    }
  }

  if (musicActive && motionGate > 0.35 && chorusEnv > 0.45) {
    chorusEmit += chorusEnv * 1.1;
    while (chorusEmit >= 1) {
      chorusEmit -= 1;
      spawnShards(1, (Math.random() * 3) | 0, 4.5 + chorusEnv * 4);
    }
  }

  kickEnv = Math.max(0, kickEnv - 0.05);
  beatEnv = Math.max(0, beatEnv - 0.07);
}

function detonate(power) {
  for (let k = 0; k < COUNT; k++) {
    const hx = home[k * 3], hy = home[k * 3 + 1], hz = home[k * 3 + 2];
    const len = Math.hypot(hx, hy, hz) || 1;
    const f = power * (0.6 + 0.4 * Math.random()) * 4.2;
    vel[k * 3] += (hx / len) * f;
    vel[k * 3 + 1] += (hy / len) * f;
    vel[k * 3 + 2] += (hz / len) * f;
  }
}

function updateCubes(dt, t) {
  const springK = 18;
  const damp = Math.exp(-2.6 * dt);
  for (let k = 0; k < COUNT; k++) {
    const o = k * 3;
    vel[o] += (home[o] - pos[o]) * springK * dt;
    vel[o + 1] += (home[o + 1] - pos[o + 1]) * springK * dt;
    vel[o + 2] += (home[o + 2] - pos[o + 2]) * springK * dt;
    vel[o] *= damp; vel[o + 1] *= damp; vel[o + 2] *= damp;
    pos[o] += vel[o] * dt;
    pos[o + 1] += vel[o + 1] * dt;
    pos[o + 2] += vel[o + 2] * dt;

    const s = seed[k];
    const band = bandEnv[bandOf[k]];

    // Lively float: every cube bobs on its own frequencies and a small orbit,
    // with amplitude rising on its band energy + chorus → a nimble swarm.
    const live = musicActive ? (0.16 + band * 0.6 + chorusEnv * 0.35) * motionGate : 0;
    const f1 = 1.0 + spin[o] * 0.7;
    const f2 = 0.85 + spin[o + 1] * 0.7;
    const f3 = 0.7 + spin[o + 2] * 0.5;
    const jx = Math.sin(t * f1 + s) * live;
    const jy = Math.cos(t * f2 + s * 1.3) * live;
    const jz = Math.sin(t * f3 + s * 0.7) * live * 0.7;

    // High-frequency micro shimmer (gated so weak input doesn't twitch).
    const micro = musicActive && motionGate > 0.18 ? (0.01 + levelEnv * 0.03 + kickEnv * 0.02) * motionGate : 0;
    const mt = t * 20 + s;
    const mx = Math.sin(mt) * micro;
    const my = Math.cos(mt * 1.31) * micro;
    const mz = Math.sin(mt * 0.79) * micro;

    const scale = CUBE * sizeRhythm[k] * (0.62 + band * 1.15 + kickEnv * 0.45 + levelEnv * 0.25);
    const spinMul = musicActive ? (0.25 + band * 0.7 + chorusEnv * 0.5) * motionGate : 0;

    dummy.position.set(pos[o] + jx + mx, pos[o + 1] + jy + my, pos[o + 2] + jz + mz);
    dummy.rotation.set(
      t * spin[o] * spinMul,
      t * spin[o + 1] * spinMul,
      t * spin[o + 2] * spinMul
    );
    dummy.scale.setScalar(Math.max(0.02, scale));
    dummy.updateMatrix();
    cubes.setMatrixAt(k, dummy.matrix);

    const bc = baseColor[k];
    const flash = Math.min(1.16, 0.76 + band * 0.44 + kickEnv * 0.3 + beatEnv * 0.1 + chorusEnv * 0.16)
      * depthTone[k];
    tmpColor.copy(bc).multiplyScalar(flash);
    cubes.setColorAt(k, tmpColor);
  }
  cubes.instanceMatrix.needsUpdate = true;
  if (cubes.instanceColor) cubes.instanceColor.needsUpdate = true;
}

function animate() {
  requestAnimationFrame(animate);
  // Frozen (user paused): hold the exact current frame, re-rendering the same
  // unchanged scene so it survives resizes and can be exported as a still.
  if (frozen) {
    clock.getDelta(); // consume elapsed time so it doesn't jump on resume
    composer.render();
    return;
  }
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.elapsedTime;

  if (window.MUSIC) window.MUSIC.update();
  readMusic();
  syncToggle();
  updateCubes(dt, t);
  updateShards(dt);
  updateFireworks(dt);

  shell.rotation.y += musicActive ? dt * (0.025 + levelEnv * 0.18 + chorusEnv * 0.16) * motionGate : 0;
  shell.rotation.x += musicActive ? dt * 0.012 * motionGate : 0;
  shell.scale.setScalar(1 + kickEnv * 0.1 + chorusEnv * 0.06);
  shellMat.opacity = 0.1 + levelEnv * 0.16 + chorusEnv * 0.12;

  if (musicActive) {
    camAngle += dt * (0.04 + levelEnv * 0.08 + chorusEnv * 0.08) * motionGate;
  }
  // Target position is a slow, gentle orbit when playing; a composed, slightly
  // angled still framing when idle/paused so the poster reads cleanly.
  const radius = musicActive ? 18 + Math.sin(t * 0.06) * 1.6 * motionGate - chorusEnv * 1.6 : 20.5;
  const targetX = musicActive ? Math.sin(camAngle) * radius * 0.32 * motionGate : 2.6;
  const targetY = musicActive ? Math.sin(camAngle * 0.7) * 1.8 * motionGate : 1.4;
  const targetZ = musicActive ? Math.cos(camAngle) * radius : radius;
  // Heavy smoothing → eases toward the target, damping any jitter in the drivers.
  const ease = 1 - Math.exp(-2.2 * dt);
  camPosX = lerp(camPosX, targetX, ease);
  camPosY = lerp(camPosY, targetY, ease);
  camPosZ = lerp(camPosZ, targetZ, ease);
  camera.position.set(camPosX, camPosY, camPosZ);
  const targetRoll = musicActive ? Math.sin(t * 0.08) * 0.04 * motionGate : 0;
  camRoll = lerp(camRoll, targetRoll, ease);
  camera.up.set(camRoll, 1, 0);
  camera.lookAt(0, 0, 0);
  // Smooth FOV so kicks add a soft breath; idle uses a tighter, composed lens.
  const fovTarget = musicActive ? baseFov - kickEnv * 3 - chorusEnv * 3 : 64;
  fovEnv = lerp(fovEnv, fovTarget, 1 - Math.exp(-4 * dt));
  if (Math.abs(fovEnv - camera.fov) > 0.01) {
    camera.fov = fovEnv;
    camera.updateProjectionMatrix();
  }

  bloom.strength = 0.4 + kickEnv * 0.2 + chorusEnv * 0.24;
  renderer.toneMappingExposure = 0.91 + kickEnv * 0.02 + chorusEnv * 0.01;

  composer.render();
}

resize();
requestAnimationFrame(resize);
animate();

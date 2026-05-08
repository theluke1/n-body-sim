'use strict';
/**
 * N-Body Physics Worker
 * Runs entirely in a Web Worker — no network, no Python, no latency.
 * Physics at 200 Hz, broadcasts state to main thread at 60 fps.
 * GPU acceleration via WebGPU when available (auto-detected at startup).
 *
 * Force mode:
 *   gravity  — Newtonian N-body + optional black hole
 */

importScripts('/static/gpu-gravity.js');

// Use GPU when N >= this threshold. Below it, GPU launch overhead costs more than it saves.
const GPU_THRESHOLD = Number.POSITIVE_INFINITY;

// ── Constants ─────────────────────────────────────────────────
const G        = 4 * Math.PI * Math.PI;  // AU³/(M☉·yr²)
const PHYS_HZ  = 90;
const BCAST_HZ = 30;
const PHYS_MS  = 1000 / PHYS_HZ;

// Adaptive integrator bounds
const MAX_SUBSTEPS_PER_FRAME = 1024;  // hard cap per outer dt
const MIN_DT                 = 1e-7;  // absolute floor on substep
const HIGH_N_LIMIT           = 80;
const REALTIME_N_LIMIT       = 120;
const MODE_LIMITS            = { realtime: 200, scientific: 60, high_accuracy: 25 };
const MODE_DEFAULTS          = {
  realtime:      { dt: 0.0030, eta: 0.025 },
  scientific:    { dt: 0.0015, eta: 0.018 },
  high_accuracy: { dt: 0.0008, eta: 0.010 },
};

// ── Config ────────────────────────────────────────────────────
const cfg = {
  // `dt` is the OUTER (display) timestep — simTime advances by this each physLoop tick.
  // Internally we take as many adaptive substeps as needed to stay stable.
  dt: 0.003, eps: 0.02,
  N: 5, spawnRadius: 10, massMin: 0.5, massMax: 3, velFactor: 0.6,
  bhMass: 200, bhPos: [0, 0, 0], collideRadius: 0.05,
  dphi_max: 0.06, N_photons: 12, beamSpread: 0.03, rsTarget: 0.25,
  // Adaptive-timestep safety factor (Aarseth η). 0.025 ≈ 1/40 of closest-pair orbital time.
  eta: 0.025,
  // Seeded RNG — full reproducibility. Change via 'set_seed' message.
  seed: 0xC0FFEE,
  // Gravity is the only exposed force mode.
  forceMode: 'gravity',
  integratorMode: 'realtime',
  kCoulomb:  1.0,
  ljSigma:   0.5,
  ljEpsilon: 1.0,
};

function modeLimit(mode = cfg.integratorMode) {
  return MODE_LIMITS[mode] ?? MODE_LIMITS.realtime;
}

function approximationActiveFor(n = bodies.length) {
  return cfg.integratorMode === 'realtime' && n > REALTIME_N_LIMIT;
}

function clampNForMode(n) {
  return Math.max(2, Math.min(modeLimit(), Math.round(n)));
}

function applyModeDefaults(mode) {
  const d = MODE_DEFAULTS[mode] ?? MODE_DEFAULTS.realtime;
  cfg.dt = d.dt;
  cfg.eta = d.eta;
}

function trustLevel() {
  if (diag.maxSubstepsHit || !isFinite(diag.energyDrift) || diag.energyDrift >= 1e-2) return 'unreliable';
  if (diag.energyDrift >= 1e-4 || (isFinite(diag.rmin) && diag.rmin < 0.05)) return 'stress';
  if (approximationActiveFor()) return 'approximate';
  return 'nominal';
}

// Diagnostic readouts, refreshed each broadcast
let diag = {
  substeps:       0,   // substeps used in last outer step
  maxSubstepsHit: false,
  energy0:        null, // energy at first sample after reset
  energy:         0,
  energyDrift:    0,   // |E - E0|/|E0|
  px: 0, py: 0, pz: 0, // total linear momentum
  Lx: 0, Ly: 0, Lz: 0, // total angular momentum (about origin)
  rmin:           Infinity, // min pairwise separation this frame
};

// ── State ─────────────────────────────────────────────────────
let bodies        = [];
let blackHole     = null;
let centralOn     = false;
let running       = true;
let photonsOn     = false;
let photons       = [];
let simTime       = 0;
let selectedIndex = null;

let bodyIdCtr   = 0;
let photonIdCtr = 0;
let photonTick  = 0;

let recording      = false;
let recordRows     = [];
let recordCount    = 0;

// Pending events accumulated between broadcasts — flushed in getState().
// Each entry: { type: 'collision'|'bh_absorption', count: N, t: simTime }
let pendingEvents  = [];
let sampleInterval = 30;
let recordTick     = 0;

let energyCache = 0;
let energyTick  = 0;
let bcastTick   = 0;

// ── Seeded PRNG ───────────────────────────────────────────────
// Mulberry32 (Tommy Ettinger, public domain): tiny, fast, statistically sound 32-bit PRNG.
// Gives deterministic, reproducible initial conditions from cfg.seed.
let _rngState = cfg.seed >>> 0;
function rngSeed(s) { _rngState = (s >>> 0) || 1; }
function freshSeed() {
  const buf = new Uint32Array(1);
  if (self.crypto?.getRandomValues) {
    self.crypto.getRandomValues(buf);
    return buf[0] || 1;
  }
  return ((Date.now() ^ Math.floor(Math.random() * 0xFFFFFFFF)) >>> 0) || 1;
}
function rand() {
  let t = (_rngState = (_rngState + 0x6D2B79F5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
rngSeed(cfg.seed);

// ── Math helpers ──────────────────────────────────────────────
function randn() {
  // Box–Muller on the seeded stream
  return Math.sqrt(-2 * Math.log(rand() + 1e-10)) * Math.cos(2 * Math.PI * rand());
}
function randNormVec() {
  const x = randn(), y = randn(), z = randn();
  const n = Math.sqrt(x*x + y*y + z*z) + 1e-12;
  return [x/n, y/n, z/n];
}
function randUnitVec() {
  let x, y, z, l;
  do { x = rand()*2-1; y = rand()*2-1; z = rand()*2-1; l = x*x+y*y+z*z; }
  while (l > 1 || l < 1e-12);
  l = Math.sqrt(l); return [x/l, y/l, z/l];
}
function norm3(v)    { return Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]); }
function dot3(a, b)  { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function cross3(a,b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function unit3(v)    { const n=norm3(v)+1e-12; return [v[0]/n,v[1]/n,v[2]/n]; }
function add3(a, b)  { return [a[0]+b[0],a[1]+b[1],a[2]+b[2]]; }
function sub3(a, b)  { return [a[0]-b[0],a[1]-b[1],a[2]-b[2]]; }
function scale3(v,s) { return [v[0]*s,v[1]*s,v[2]*s]; }

// ── Body ──────────────────────────────────────────────────────
class Body {
  constructor(pos, vel, mass, color, charge = 0, radius = null) {
    this.id            = ++bodyIdCtr;
    this.pos           = pos.slice();
    this.prevPos       = pos.slice(); // previous position for segment-sphere intersection
    this.vel           = vel.slice();
    this.mass          = mass;
    this.color         = color;
    this.charge        = charge;
    this.opacity       = 1.0;
    this.displayRadius = radius !== null ? radius : 0.12 * Math.cbrt(mass);
    this.trail         = [];
    this._tc           = 0;
  }
  setPos(p) {
    this.prevPos = this.pos.slice(); // save before updating (needed for tunnelling check)
    this.pos = p.slice();
    if (++this._tc % 4 === 0) {
      this.trail.push([+p[0].toFixed(2), +p[1].toFixed(2), +p[2].toFixed(2)]);
      if (this.trail.length > 300) this.trail.shift();
    }
  }
  toDict(includeTrail) {
    return {
      id: this.id, pos: this.pos, vel: this.vel,
      mass: this.mass, color: this.color, opacity: this.opacity,
      radius: this.displayRadius, charge: this.charge,
      trail: includeTrail ? this.trail.slice(-50) : null,
    };
  }
}

// ── Black Hole ────────────────────────────────────────────────
class BlackHole {
  constructor(mass, pos) { this.mass = mass; this.pos = pos.slice(); }
  radii() {
    // Educational visual scale: real stellar-mass Schwarzschild radii are far
    // too small in AU for this scene, so mass maps to a visible event horizon.
    // All physics capture + renderer zones derive from this one model.
    const eventHorizon = 0.5 * Math.pow(this.mass / 50, 0.4);
    const photonSphere = eventHorizon * 1.5;
    const shadow       = eventHorizon * 2.598076;
    const lens         = Math.max(3.0, shadow * 5.0);
    return { eventHorizon, photonSphere, shadow, lens };
  }
  toDict() {
    const r = this.radii();
    return {
      mass: this.mass,
      pos: this.pos,
      // Back-compat for older UI code: radius is the true capture boundary.
      radius: r.eventHorizon,
      ring_radius: r.photonSphere,
      glow_radius: r.shadow,
      event_horizon_radius: r.eventHorizon,
      photon_sphere_radius: r.photonSphere,
      shadow_radius: r.shadow,
      lens_radius: r.lens,
    };
  }
}

// ── Photon ────────────────────────────────────────────────────
class Photon {
  constructor(u, up, phi, b, er0, et0) {
    this.id    = ++photonIdCtr;
    this.u     = u; this.up = up; this.phi = phi; this.b = b;
    this.er0   = er0; this.et0 = et0;
    this.trail = [];
    this._tmax = 120;
    this.alive = true;
  }
  getPos() {
    if (this.u <= 0) return null;
    const r = 1/this.u, c = Math.cos(this.phi), s = Math.sin(this.phi);
    const [bx,by,bz] = cfg.bhPos;
    return [
      bx + r*(c*this.er0[0] + s*this.et0[0]),
      by + r*(c*this.er0[1] + s*this.et0[1]),
      bz + r*(c*this.er0[2] + s*this.et0[2]),
    ];
  }
  toDict() { return { id: this.id, trail: this.trail.slice(-40) }; }
}

// ── Force Computation ─────────────────────────────────────────
// Uses Newton's 3rd law (N(N-1)/2 pairs) for all three modes.
function computeAcc(positions, masses, charges) {
  const n    = positions.length;
  const acc  = Array.from({length: n}, () => [0, 0, 0]);
  const eps2 = cfg.eps * cfg.eps;
  const mode = cfg.forceMode;
  const realtime = approximationActiveFor(n);

  if (realtime) {
    let mt = 0, cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      const m = Math.max(0.001, masses[i]);
      mt += m;
      cx += positions[i][0] * m;
      cy += positions[i][1] * m;
      cz += positions[i][2] * m;
    }
    if (mt > 0) { cx /= mt; cy /= mt; cz /= mt; }

    const centerMass = centralOn && blackHole ? blackHole.mass : Math.max(8, mt * 0.28);
    const center = centralOn && blackHole ? cfg.bhPos : [cx, cy, cz];
    for (let i = 0; i < n; i++) {
      const dx = center[0] - positions[i][0];
      const dy = center[1] - positions[i][1];
      const dz = center[2] - positions[i][2];
      const r2 = dx*dx + dy*dy + dz*dz + Math.max(0.18, cfg.eps * 8) ** 2;
      const f = G * centerMass / (r2 * Math.sqrt(r2));
      acc[i][0] = f * dx;
      acc[i][1] = f * dy;
      acc[i][2] = f * dz;
    }
    return acc;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i+1; j < n; j++) {
      const dx  = positions[j][0]-positions[i][0];
      const dy  = positions[j][1]-positions[i][1];
      const dz  = positions[j][2]-positions[i][2];
      const r2v = dx*dx + dy*dy + dz*dz + eps2;

      if (mode === 'gravity') {
        // F_on_i = G·m_i·m_j / r³ · d  →  a_i = G·m_j / r³ · d
        const ir3 = 1 / (r2v * Math.sqrt(r2v));
        const fij = G * ir3;
        const fmi = fij * masses[i], fmj = fij * masses[j];
        acc[i][0] += fmj*dx; acc[i][1] += fmj*dy; acc[i][2] += fmj*dz;
        acc[j][0] -= fmi*dx; acc[j][1] -= fmi*dy; acc[j][2] -= fmi*dz;

      } else if (mode === 'coulomb') {
        // F_on_i = −k·q_i·q_j / r³ · d  (same sign → repulsive, points away from j)
        // F_on_j = +k·q_i·q_j / r³ · d  (Newton's 3rd)
        const ir3   = 1 / (r2v * Math.sqrt(r2v));
        const coeff = cfg.kCoulomb * charges[i] * charges[j] * ir3;
        const ci = coeff / masses[i], cj = coeff / masses[j];
        acc[i][0] -= ci*dx; acc[i][1] -= ci*dy; acc[i][2] -= ci*dz;
        acc[j][0] += cj*dx; acc[j][1] += cj*dy; acc[j][2] += cj*dz;

      } else { // lj
        // U = 4ε[(σ/r)¹² − (σ/r)⁶]
        // F_on_i = (24ε / r²)·[2·sr6² − sr6] · d   (attractive when r > r_eq, repulsive when r < r_eq)
        const sr2     = cfg.ljSigma * cfg.ljSigma / r2v;
        const sr6     = sr2 * sr2 * sr2;
        const ljcoeff = 24 * cfg.ljEpsilon * (2*sr6*sr6 - sr6) / r2v;
        const ci = ljcoeff / masses[i], cj = ljcoeff / masses[j];
        acc[i][0] += ci*dx; acc[i][1] += ci*dy; acc[i][2] += ci*dz;
        acc[j][0] -= cj*dx; acc[j][1] -= cj*dy; acc[j][2] -= cj*dz;
      }
    }
  }

  // Black hole gravity (gravity mode only) with 1PN post-Newtonian correction.
  // F_BH = F_Newton × (1 + 3v²/cSim² + 3GM/(r·cSim²))
  //
  // cSim² is derived from the visual Schwarzschild radius so GR effects are
  // perceptible at simulation scales:
  //   • perihelion precession for bodies in elliptic orbits near the BH
  //   • bodies inside r_ISCO = 3·rs lose angular-momentum support and spiral in
  //
  // Reference: Misner, Thorne & Wheeler §25.5 (geodesic deviation, weak-field limit)
  if (mode === 'gravity' && centralOn && blackHole) {
    const [bx,by,bz] = cfg.bhPos, bm = blackHole.mass;
    const rs    = blackHole.radii().eventHorizon;  // visual event-horizon radius (AU)
    const cSim2 = 2 * G * bm / rs;                // effective c² in sim units
    const GM    = G * bm;
    for (let i = 0; i < n; i++) {
      const dx  = bx-positions[i][0], dy = by-positions[i][1], dz = bz-positions[i][2];
      const r2v = dx*dx + dy*dy + dz*dz + 1e-4;
      const r   = Math.sqrt(r2v);
      const f   = GM / (r2v * r);
      // Use velocity at start of outer timestep — adequate for a 1PN correction.
      const vel = bodies[i]?.vel ?? [0, 0, 0];
      const v2  = vel[0]*vel[0] + vel[1]*vel[1] + vel[2]*vel[2];
      // Cap at 10× Newtonian to prevent impulsive kicks just before absorption.
      const grFactor = Math.min(1 + 3*v2/cSim2 + 3*GM/(r*cSim2), 10);
      acc[i][0] += f*dx*grFactor; acc[i][1] += f*dy*grFactor; acc[i][2] += f*dz*grFactor;
    }
  }
  return acc;
}

// ── Force dispatch: GPU if ready + N ≥ threshold, else CPU ────
async function computeAccDispatch(positions, masses, charges) {
  if (gpuIsReady() && positions.length >= GPU_THRESHOLD) {
    return gpuComputeAcc(
      positions, masses, charges,
      centralOn, cfg.bhPos,
      centralOn && blackHole ? blackHole.mass : 0,
      cfg.eps,
      cfg.forceMode, cfg.kCoulomb, cfg.ljSigma, cfg.ljEpsilon
    );
  }
  return computeAcc(positions, masses, charges);
}

// ── Adaptive substep Velocity Verlet ──────────────────────────
// One outer "frame" advances simTime by cfg.dt, but internally we break that
// into as many Velocity-Verlet substeps as needed to keep the integrator stable
// during close encounters. Substep size = η · (closest-pair orbital time), which
// shrinks automatically when two bodies fly past each other at high speed.
//
// Why this fixes the "bodies shoot off to infinity" bug:
// fixed-dt Verlet can't resolve a close pass — one step delivers an impulsive
// kick larger than escape velocity. Adaptive substepping forces dt to shrink
// during the close approach and restores energy conservation.
//
// Reference: Aarseth 2003, "Gravitational N-Body Simulations", §2.1 block timesteps.
// We use a global (not per-particle) step because Velocity Verlet breaks
// symplecticity when the step varies per particle.

// Pre-allocated scratch — avoids per-step garbage from .map()/.slice()
const _scratchPos0   = [];
const _scratchVel0   = [];
const _scratchPos1   = [];
const _scratchMasses = [];
const _scratchCharges= [];
function _ensureScratch(n) {
  while (_scratchPos0.length < n) {
    _scratchPos0.push([0,0,0]);
    _scratchVel0.push([0,0,0]);
    _scratchPos1.push([0,0,0]);
    _scratchMasses.push(0);
    _scratchCharges.push(0);
  }
}

function estimateSubstepDt(positions, masses, dtRemaining) {
  // Find closest pair, return η · t_orbital(closest_pair).
  // Also track rmin for diagnostics.
  const n = positions.length;
  if (n < 2 || cfg.forceMode !== 'gravity') return dtRemaining;
  if (approximationActiveFor(n)) {
    diag.rmin = Infinity;
    return dtRemaining;
  }

  let minDt = dtRemaining;
  let rmin  = Infinity;
  const eta2 = cfg.eta * cfg.eta;
  const highN = cfg.integratorMode === 'realtime' && n > HIGH_N_LIMIT;
  const stride = highN ? Math.max(2, Math.floor(n / 48)) : 1;

  for (let i = 0; i < n; i++) {
    const jStep = highN ? stride : 1;
    for (let j = i+1; j < n; j += jStep) {
      const dx = positions[j][0]-positions[i][0];
      const dy = positions[j][1]-positions[i][1];
      const dz = positions[j][2]-positions[i][2];
      const r2 = dx*dx + dy*dy + dz*dz;
      if (r2 < rmin) rmin = r2;
      const Mtot = masses[i] + masses[j];
      if (Mtot <= 0) continue;
      // t_dyn² = r³ / (G · M_tot);  dt² ≤ η² · t_dyn²
      const r  = Math.sqrt(r2 + cfg.eps*cfg.eps);
      const dt2 = eta2 * r*r*r / (G * Mtot);
      if (dt2 < minDt*minDt) minDt = Math.sqrt(dt2);
    }
  }

  // Black hole case — treat BH as a big pairwise partner for every body.
  if (centralOn && blackHole) {
    const bm   = blackHole.mass;
    const [bx,by,bz] = cfg.bhPos;
    // Event horizon capture boundary — same radius model as handleBHAbsorption
    // and the renderer's visible event-horizon sphere.
    const capR = blackHole.radii().eventHorizon;
    for (let i = 0; i < n; i++) {
      const dx = positions[i][0]-bx, dy = positions[i][1]-by, dz = positions[i][2]-bz;
      const r2 = dx*dx + dy*dy + dz*dz;
      if (r2 < rmin) rmin = r2;
      const r  = Math.sqrt(r2 + 1e-4);
      const dt2 = eta2 * r*r*r / (G * (bm + masses[i]));
      if (dt2 < minDt*minDt) minDt = Math.sqrt(dt2);
      // Velocity constraint: no body may cross more than 20% of capR in one substep.
      // This pre-emptively prevents tunnelling for high-velocity bodies near the BH.
      const vx = _scratchVel0[i][0], vy = _scratchVel0[i][1], vz = _scratchVel0[i][2];
      const speed = Math.sqrt(vx*vx + vy*vy + vz*vz);
      if (speed > 0) {
        const dtV = 0.20 * capR / speed;
        if (dtV < minDt) minDt = dtV;
      }
    }
  }

  diag.rmin = Math.sqrt(rmin);
  if (highN) minDt = Math.max(minDt, dtRemaining / 4);
  return Math.max(MIN_DT, Math.min(minDt, dtRemaining));
}

async function timestep() {
  if (!running || bodies.length === 0) return;

  const outerDt = cfg.dt;
  const tEnd    = simTime + outerDt;
  const maxSubsteps =
    approximationActiveFor(bodies.length) ? 1 :
    cfg.integratorMode === 'high_accuracy' ? MAX_SUBSTEPS_PER_FRAME :
    bodies.length > HIGH_N_LIMIT ? 4 : MAX_SUBSTEPS_PER_FRAME;
  let substeps  = 0;
  diag.maxSubstepsHit = false;

  while (simTime < tEnd - 1e-12 && substeps < maxSubsteps) {
    const n = bodies.length;
    if (n === 0) break;
    _ensureScratch(n);

    // Snapshot current state into reusable scratch (no allocations)
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      _scratchPos0[i][0] = b.pos[0]; _scratchPos0[i][1] = b.pos[1]; _scratchPos0[i][2] = b.pos[2];
      _scratchVel0[i][0] = b.vel[0]; _scratchVel0[i][1] = b.vel[1]; _scratchVel0[i][2] = b.vel[2];
      _scratchMasses[i]  = b.mass;
      _scratchCharges[i] = b.charge;
    }
    // Slice just the active range — compute functions iterate .length
    const pos0    = _scratchPos0.slice(0, n);
    const vel0    = _scratchVel0.slice(0, n);
    const masses  = _scratchMasses.slice(0, n);
    const charges = _scratchCharges.slice(0, n);

    // a(t)
    const acc0 = await computeAccDispatch(pos0, masses, charges);

    // Decide substep size (gravity only; LJ/Coulomb use the full outer dt)
    const dt = estimateSubstepDt(pos0, masses, tEnd - simTime);

    // Drift: x(t+dt) = x + v·dt + ½·a·dt²
    for (let i = 0; i < n; i++) {
      _scratchPos1[i][0] = pos0[i][0] + vel0[i][0]*dt + 0.5*acc0[i][0]*dt*dt;
      _scratchPos1[i][1] = pos0[i][1] + vel0[i][1]*dt + 0.5*acc0[i][1]*dt*dt;
      _scratchPos1[i][2] = pos0[i][2] + vel0[i][2]*dt + 0.5*acc0[i][2]*dt*dt;
    }
    const pos1 = _scratchPos1.slice(0, n);

    // a(t+dt)
    const acc1 = await computeAccDispatch(pos1, masses, charges);

    // Kick: v(t+dt) = v + ½·(a_old + a_new)·dt
    for (let i = 0; i < n; i++) {
      let vx = vel0[i][0] + 0.5*(acc0[i][0]+acc1[i][0])*dt;
      let vy = vel0[i][1] + 0.5*(acc0[i][1]+acc1[i][1])*dt;
      let vz = vel0[i][2] + 0.5*(acc0[i][2]+acc1[i][2])*dt;

      // NaN/Inf guard only — no maxSpeed clamp. If you hit this, the integrator
      // failed and the run is invalid; we just keep simTime advancing so the UI
      // doesn't freeze. A real failure will also trip diag.maxSubstepsHit below.
      if (!isFinite(vx) || !isFinite(vy) || !isFinite(vz)) { vx = 0; vy = 0; vz = 0; }

      bodies[i].setPos([pos1[i][0], pos1[i][1], pos1[i][2]]);
      bodies[i].vel = [vx, vy, vz];
    }

    // Gravity-only post-step effects. For high-N scenes, pairwise collision
    // checks inside every adaptive substep dominate frame time, so run them
    // after the outer step instead. Low-N benchmark scenes keep the stricter
    // inside-substep behavior.
    if (cfg.forceMode === 'gravity') {
      handleBHAbsorption();
      if (bodies.length <= HIGH_N_LIMIT) handleCollisions();
    }

    simTime += dt;
    substeps++;
  }

  if (substeps >= maxSubsteps && simTime < tEnd - 1e-12) {
    diag.maxSubstepsHit = true;
    console.warn('[physics] max substeps hit — system may be in an unresolved close encounter');
    simTime = tEnd; // keep UI clock honest even if we bailed early
  }
  diag.substeps = substeps;

  if (cfg.forceMode === 'gravity' && bodies.length > HIGH_N_LIMIT) {
    handleCollisions();
  }

  if (recording && ++recordTick % sampleInterval === 0) {
    for (const b of bodies)
      recordRows.push([+simTime.toFixed(5), b.id,
        ...b.pos.map(v => +v.toFixed(4)),
        ...b.vel.map(v => +v.toFixed(4)),
        +b.mass.toFixed(4)]);
    recordCount += bodies.length;
  }
}

// ── Collisions (gravity mode only) ───────────────────────────
function handleCollisions() {
  if (bodies.length < 2) return;
  const thr2 = cfg.collideRadius * cfg.collideRadius;
  const rm   = new Set();
  for (let i = 0; i < bodies.length; i++) {
    if (rm.has(i)) continue;
    for (let j = i+1; j < bodies.length; j++) {
      if (rm.has(j)) continue;
      const dx = bodies[j].pos[0]-bodies[i].pos[0];
      const dy = bodies[j].pos[1]-bodies[i].pos[1];
      const dz = bodies[j].pos[2]-bodies[i].pos[2];
      if (dx*dx + dy*dy + dz*dz < thr2) {
        const mi = bodies[i].mass, mj = bodies[j].mass, mt = mi+mj;
        bodies[i].pos = [
          (mi*bodies[i].pos[0]+mj*bodies[j].pos[0])/mt,
          (mi*bodies[i].pos[1]+mj*bodies[j].pos[1])/mt,
          (mi*bodies[i].pos[2]+mj*bodies[j].pos[2])/mt,
        ];
        bodies[i].vel = [
          (mi*bodies[i].vel[0]+mj*bodies[j].vel[0])/mt,
          (mi*bodies[i].vel[1]+mj*bodies[j].vel[1])/mt,
          (mi*bodies[i].vel[2]+mj*bodies[j].vel[2])/mt,
        ];
        bodies[i].mass = mt;
        rm.add(j);
      }
    }
  }
  if (rm.size > 0) {
    bodies = bodies.filter((_, i) => !rm.has(i));
    pendingEvents.push({ type: 'collision', count: rm.size, t: simTime });
  }
}

// ── Segment-sphere intersection ───────────────────────────────
// Returns true if the line segment from p0 to p1 passes through or starts/ends
// inside the sphere at `center` with radius `r`. Uses the quadratic formula on
// the parameterised segment p(t) = p0 + t·(p1−p0), t ∈ [0,1].
// This is the core fix for bodies tunnelling through the BH capture sphere
// in a single large substep.
function segmentIntersectsSphere(p0, p1, center, r) {
  const dx = p1[0]-p0[0], dy = p1[1]-p0[1], dz = p1[2]-p0[2];
  const fx = p0[0]-center[0], fy = p0[1]-center[1], fz = p0[2]-center[2];
  const a = dx*dx + dy*dy + dz*dz;
  if (a < 1e-14) return fx*fx+fy*fy+fz*fz <= r*r; // stationary: just check if inside
  const b    = 2*(fx*dx + fy*dy + fz*dz);
  const c    = fx*fx + fy*fy + fz*fz - r*r;
  const disc = b*b - 4*a*c;
  if (disc < 0) return false;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2*a);
  const t2 = (-b + sq) / (2*a);
  return t1 <= 1 && t2 >= 0; // segment overlaps sphere if [t1,t2] ∩ [0,1] ≠ ∅
}

// ── BH Absorption ─────────────────────────────────────────────
function handleBHAbsorption() {
  if (!centralOn || !blackHole || !bodies.length) return;
  // Capture exactly at the visible event horizon. The larger apparent shadow
  // and bent-light region are lensing effects, not body-removal boundaries.
  const capR  = blackHole.radii().eventHorizon;
  const fadeR = capR * 2;
  const bhCenter = cfg.bhPos;
  let absorbed = 0;
  const rm = [];
  for (let i = 0; i < bodies.length; i++) {
    const b  = bodies[i];
    const dx = b.pos[0]-bhCenter[0], dy = b.pos[1]-bhCenter[1], dz = b.pos[2]-bhCenter[2];
    const r  = Math.sqrt(dx*dx + dy*dy + dz*dz);
    // Endpoint check (fast path) OR segment check (catches high-speed tunnellers)
    const captured = r <= capR || segmentIntersectsSphere(b.prevPos, b.pos, bhCenter, capR);
    if (captured)       { absorbed += b.mass; rm.push(i); }
    else if (r < fadeR) { b.opacity = Math.max(0, Math.min(1, (r-capR)/capR)); }
    else                { b.opacity = 1.0; }
  }
  for (let i = rm.length-1; i >= 0; i--) bodies.splice(rm[i], 1);
  if (absorbed > 0) {
    blackHole.mass += absorbed;
    cfg.bhMass = blackHole.mass;
    pendingEvents.push({ type: 'bh_absorption', count: rm.length, t: simTime });
  }
}

// ── Photon Geodesics ──────────────────────────────────────────
function updatePhotons() {
  if (!photonsOn || !centralOn || !blackHole || !photons.length) return;
  const bm    = blackHole.mass;
  const cSim  = Math.sqrt(2 * G * bm / cfg.rsTarget);
  const rs    = 2 * G * bm / (cSim * cSim);
  const rAbs  = 1.05 * rs;
  const MAX_S = 12, MAX_D = 0.3;
  function f(u) { return 1.5*rs*u*u - u; }

  for (let k = photons.length-1; k >= 0; k--) {
    const ph = photons[k];
    if (!ph.alive || !isFinite(ph.u) || ph.u <= 0) { photons.splice(k,1); continue; }
    const r = 1/ph.u;
    if (r <= rAbs) { photons.splice(k,1); continue; }

    let dphi = (cSim * ph.b / (r*r + 1e-12)) * cfg.dt;
    dphi = Math.max(-MAX_D, Math.min(MAX_D, dphi));
    const nsub = Math.min(Math.ceil(Math.abs(dphi) / cfg.dphi_max), MAX_S);
    const h    = dphi / nsub;
    let u = ph.u, up = ph.up;
    for (let s = 0; s < nsub; s++) {
      const uph = up + 0.5*f(u)*h;
      const un  = u + uph*h;
      up = uph + 0.5*f(un)*h;
      ph.phi += h;
      u = un;
      if (!isFinite(u) || u <= 0 || 1/u <= rAbs) { u = -1; break; }
    }
    ph.u = u; ph.up = up;
    if (!isFinite(u) || u <= 0) { photons.splice(k,1); continue; }

    const pos = ph.getPos();
    if (pos) {
      ph.trail.push(pos.map(v => +v.toFixed(2)));
      if (ph.trail.length > ph._tmax) ph.trail.shift();
    }
  }
}

function spawnPhotons(camPos, camDir) {
  if (!centralOn || !blackHole) return;
  photons = [];
  const aim = unit3(sub3(cfg.bhPos, camPos));
  for (let i = 0; i < cfg.N_photons; i++) {
    const spread = randUnitVec().map(v => v * cfg.beamSpread * 2.4);
    const ndir   = unit3(add3(aim, spread));
    const x0     = add3(camPos, scale3(ndir, 0.2));
    const rvec   = sub3(x0, cfg.bhPos);
    const r0     = norm3(rvec) + 1e-12;
    const er0    = unit3(rvec);

    let h = cross3(rvec, ndir);
    if (norm3(h) < 1e-12) h = cross3(er0, [0,0,1]);
    if (norm3(h) < 1e-12) h = cross3(er0, [0,1,0]);
    h = unit3(h);
    const et0 = unit3(cross3(h, er0));

    const n_r = dot3(ndir, er0);
    const n_t = dot3(ndir, et0);
    const bImp = Math.max(1e-6, r0 * Math.abs(n_t));
    const u    = 1 / r0;
    const up   = Math.abs(n_t) >= 1e-8 ? -n_r / (r0 * n_t) : -Math.sign(n_r) * 1e3;
    photons.push(new Photon(u, up, 0, bImp, er0, et0));
  }
}

// ── Body Generation ───────────────────────────────────────────

function randomColor() {
  return `hsl(${(rand()*360)|0},${60+(rand()*40)|0}%,${55+(rand()*20)|0}%)`;
}

function safeVmax() {
  const Mref = (centralOn && blackHole)
    ? blackHole.mass
    : Math.max(1, cfg.N * 0.5 * (cfg.massMin + cfg.massMax));
  return Math.sqrt(G * Mref / Math.max(0.5, cfg.spawnRadius));
}
function orbitalVel(pos) {
  if (!centralOn || !blackHole) return [0,0,0];
  const rel = sub3(pos, cfg.bhPos), r = norm3(rel) + 1e-9;
  let t = [-rel[1], rel[0], 0];
  if (norm3(t) < 1e-12) t = cross3(rel, [0,1,0]);
  return scale3(unit3(t), Math.sqrt(G * blackHole.mass / r));
}

function recenterGeneratedBodies() {
  if (bodies.length === 0) return;
  let mt = 0, cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0;
  for (const b of bodies) {
    mt += b.mass;
    cx += b.mass * b.pos[0]; cy += b.mass * b.pos[1]; cz += b.mass * b.pos[2];
    vx += b.mass * b.vel[0]; vy += b.mass * b.vel[1]; vz += b.mass * b.vel[2];
  }
  if (mt <= 0) return;
  cx /= mt; cy /= mt; cz /= mt;
  vx /= mt; vy /= mt; vz /= mt;
  for (const b of bodies) {
    b.pos[0] -= cx; b.pos[1] -= cy; b.pos[2] -= cz;
    if (!centralOn) {
      b.vel[0] -= vx; b.vel[1] -= vy; b.vel[2] -= vz;
    }
  }
}

// Gravity: random sphere, optional BH orbital velocity
function generateGravityBodies(n) {
  bodies = [];
  const vmax = safeVmax() * cfg.velFactor;
  for (let i = 0; i < n; i++) {
    const dir  = randNormVec();
    const r    = cfg.spawnRadius * Math.cbrt(rand());
    const pos  = scale3(dir, r);
    const mass = cfg.massMin + rand() * (cfg.massMax - cfg.massMin);
    let vel    = scale3(randUnitVec(), rand() * vmax);
    if (centralOn && blackHole) vel = add3(vel, orbitalVel(pos));
    bodies.push(new Body(pos, vel, mass, randomColor(), 0));
  }
  recenterGeneratedBodies();
}

// Coulomb: 1 nucleus (charge +nElec, mass 1836) + (n−1) electrons in circular orbits
// Each electron placed in a random orbital plane at increasing radius.
function generateCoulombBodies(n) {
  bodies = [];
  const nElec = Math.max(1, n - 1);
  const nucCharge = nElec;  // charge neutrality

  // Nucleus: heavy, gold, at rest at origin
  bodies.push(new Body([0, 0, 0], [0, 0, 0], 1836, '#ffcc44', nucCharge, 0.18));

  for (let i = 0; i < nElec; i++) {
    const r = 0.5 + i * 0.4;  // increasing orbital radii: 0.5, 0.9, 1.3, ...

    // Random orbital plane: pick normal vector h, then radial & tangential unit vectors
    const h  = randNormVec();
    let er   = cross3(h, [0, 0, 1]);
    if (norm3(er) < 1e-6) er = cross3(h, [0, 1, 0]);
    er       = unit3(er);
    const et = unit3(cross3(h, er));

    // Circular orbit velocity: v = sqrt(k·Z / r)  [ignores e-e repulsion for init]
    const pos   = scale3(er, r);
    const vCirc = Math.sqrt(cfg.kCoulomb * nucCharge / r);
    const vel   = scale3(et, vCirc);

    bodies.push(new Body(pos, vel, 1.0, '#00b4e8', -1, 0.06));
  }
}

// LJ: bodies on a 3D grid, spacing 1.2σ, Maxwell-Boltzmann velocities
function generateLJBodies(n) {
  bodies = [];
  const spacing = 1.2 * cfg.ljSigma;
  const side    = Math.ceil(Math.cbrt(n));
  const offset  = spacing * (side - 1) / 2;
  const vth     = Math.sqrt(2 * cfg.ljEpsilon);  // thermal velocity scale

  outer:
  for (let k = 0; k < side; k++) {
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        if (bodies.length >= n) break outer;
        const pos = [i*spacing - offset, j*spacing - offset, k*spacing - offset];
        const vel = [randn()*vth, randn()*vth, randn()*vth];
        bodies.push(new Body(pos, vel, 1.0, randomColor(), 0, 0.12));
      }
    }
  }
}

function generateBodies(n) {
  cfg.forceMode = 'gravity';
  cfg.N = clampNForMode(n);
  generateGravityBodies(cfg.N);
}

// ── Presets ───────────────────────────────────────────────────
// Each preset function sets cfg values, creates bodies[], and optionally a blackHole.
// Caller must reset photons/simTime/recordRows before calling.

function _presetSolarSystem() {
  cfg.forceMode = 'gravity';
  cfg.dt = 0.002;  // ~120 steps per Mercury orbit at 200Hz
  // Real semi-major axes (AU), masses (M☉), display colors, display radii
  const data = [
    // [ a_AU,  mass_Msun,  color,       dispRadius ]
    [  0,      1.0,        '#fff5c2',    0.45 ],  // Sun
    [  0.387,  1.66e-7,    '#b5b5b5',    0.07 ],  // Mercury
    [  0.723,  2.45e-6,    '#e8cda0',    0.09 ],  // Venus
    [  1.000,  3.00e-6,    '#4a9eff',    0.10 ],  // Earth
    [  1.524,  3.23e-7,    '#e8603e',    0.08 ],  // Mars
    [  5.203,  9.55e-4,    '#c88b3a',    0.25 ],  // Jupiter
    [  9.537,  2.86e-4,    '#e4d191',    0.22 ],  // Saturn
    [ 19.19,   4.37e-5,    '#7de8e8',    0.17 ],  // Uranus
    [ 30.07,   5.15e-5,    '#4b70dd',    0.16 ],  // Neptune
  ];
  data.forEach(([a, mass, color, radius], i) => {
    if (a === 0) { bodies.push(new Body([0,0,0], [0,0,0], mass, color, 0, radius)); return; }
    const theta = (i - 1) * (2 * Math.PI / 8);  // evenly spaced orbital angles
    const pos = [a * Math.cos(theta), a * Math.sin(theta), 0];
    // v_circ = sqrt(G * M_sun / a) = sqrt(4π² / a) = 2π / sqrt(a)
    const v = 2 * Math.PI / Math.sqrt(a);
    const vel = [-v * Math.sin(theta), v * Math.cos(theta), 0];
    bodies.push(new Body(pos, vel, mass, color, 0, radius));
  });
  // Zero total linear momentum (Sun kicks slightly)
  let px = 0, py = 0;
  for (const b of bodies) { px += b.mass * b.vel[0]; py += b.mass * b.vel[1]; }
  const Mtot = bodies.reduce((s, b) => s + b.mass, 0);
  for (const b of bodies) { b.vel[0] -= px/Mtot; b.vel[1] -= py/Mtot; }
}

function _presetBinaryStar() {
  cfg.forceMode = 'gravity';
  cfg.dt = 0.003;
  const m1 = 1.5, m2 = 1.0, M = m1 + m2, d = 5.0;
  const r1 = (m2 / M) * d, r2 = (m1 / M) * d;
  const omega = Math.sqrt(G * M / (d * d * d));
  const v1 = omega * r1 * 1.15;  // ×1.15 → slightly elliptical orbit
  const v2 = omega * r2 * 1.15;
  bodies = [
    new Body([-r1, 0, 0], [0, -v1, 0], m1, '#ffd700', 0, 0.18),  // larger, gold
    new Body([ r2, 0, 0], [0,  v2, 0], m2, '#aad4ff', 0, 0.14),  // smaller, blue-white
  ];
}

function _presetGalaxyCore() {
  cfg.forceMode = 'gravity';
  cfg.dt = 0.001;
  cfg.bhMass = 200;
  centralOn = true;
  blackHole = new BlackHole(200, [0, 0, 0]);
  for (let i = 0; i < 40; i++) {
    const r = 1.5 + rand() * 7;  // 1.5–8.5 AU
    const theta = rand() * 2 * Math.PI;
    const z = (rand() - 0.5) * 0.4;  // thin disk
    const pos = [r * Math.cos(theta), r * Math.sin(theta), z];
    const v = Math.sqrt(G * blackHole.mass / r);  // Keplerian circular
    const vel = [-v * Math.sin(theta), v * Math.cos(theta), (rand()-0.5)*0.1];
    bodies.push(new Body(pos, vel, 0.2 + rand() * 0.8, randomColor(), 0));
  }
}

function _presetHydrogen() {
  cfg.forceMode = 'coulomb';
  cfg.kCoulomb = 1.0;
  cfg.dt = 0.003;
  // Proton: heavy nucleus, charge +1, at rest
  bodies.push(new Body([0,0,0], [0,0,0], 1836, '#ff9900', 1, 0.15));
  // Electron: circular orbit at r=1 Bohr (v_circ = sqrt(k·Z/r) = 1.0)
  bodies.push(new Body([1, 0, 0], [0, 1.0, 0], 1.0, '#00b4e8', -1, 0.06));
}

function _presetHelium() {
  cfg.forceMode = 'coulomb';
  cfg.kCoulomb = 1.0;
  cfg.dt = 0.003;
  // Helium nucleus: charge +2
  bodies.push(new Body([0,0,0], [0,0,0], 1836, '#ff4444', 2, 0.18));
  // Two electrons on opposite sides: r=0.5, v_circ = sqrt(k·2/0.5) = 2.0
  const r = 0.5, vCirc = Math.sqrt(1.0 * 2 / r);
  bodies.push(new Body([ r, 0, 0], [0,  vCirc, 0], 1.0, '#00b4e8', -1, 0.06));
  bodies.push(new Body([-r, 0, 0], [0, -vCirc, 0], 1.0, '#7be5ff', -1, 0.06));
}

function _presetArgon() {
  cfg.forceMode = 'lj';
  cfg.ljSigma   = 0.5;
  cfg.ljEpsilon = 1.0;
  cfg.dt = 0.001;  // smaller dt for LJ stability
  generateLJBodies(50);
}

// ── Canonical scientific presets ─────────────────────────────
// These are standard benchmarks from the gravitational dynamics literature.
// Each has a well-known analytical or high-precision-numerical solution we
// can compare against, which is what makes them suitable for validating
// the integrator.

// Kepler 2-body — the textbook closed elliptical orbit.
// Closed-form solution: orbit is an ellipse with period T = 2π·√(a³/G·M).
// If your integrator preserves E and L perfectly, the orbit closes on itself
// forever. If it drifts, you'll see the ellipse precess.
function _presetKepler() {
  cfg.forceMode = 'gravity';
  cfg.dt        = 0.003;
  cfg.eps       = 0.001;                // nearly point-mass for a clean orbit
  // Central body + test particle in elliptical orbit, a=1 AU, e=0.5
  const M = 1.0, a = 1.0, e = 0.5;
  const rp = a * (1 - e);               // periapsis distance
  const vp = Math.sqrt(G * M * (1 + e) / (a * (1 - e)));  // vis-viva at periapsis
  bodies = [
    new Body([0, 0, 0],   [0, 0, 0],   M,    '#ffd84a', 0, 0.18),
    new Body([rp, 0, 0],  [0, vp, 0],  1e-6, '#4a9eff', 0, 0.05),
  ];
}

// Figure-8 three-body (Chenciner & Montgomery, Ann. Math. 2000).
// Three equal masses chase each other around a figure-8 in a common plane.
// Discovered numerically by Moore 1993, proved to exist by Chenciner–Montgomery.
// It's the most famous "choreography" solution of the 3-body problem and a
// standard integrator test: only a stable integrator keeps the figure closed
// and all three bodies on the same curve.
// Initial conditions from Chenciner & Montgomery (normalised so G=1, M=1).
// We rescale time/length to match our G = 4π².
function _presetFigureEight() {
  cfg.forceMode = 'gravity';
  cfg.dt        = 0.0015;
  cfg.eps       = 0.001;
  // Canonical Chenciner–Montgomery initial conditions (in units with G=1, m=1)
  // Positions:
  //   r1 = (-r2)            r3 = (0,0)
  //   r2 = ( 0.97000436, -0.24308753, 0)
  // Velocities:
  //   v3 = (-0.93240737, -0.86473146, 0)
  //   v1 = v2 = -v3/2
  const a = 0.97000436, b = -0.24308753;
  const vx = -0.93240737, vy = -0.86473146;
  // Rescale velocity: our G = 4π² instead of 1  ⇒ v_new = v_old · √(G_new / G_old) = v·(2π)
  const s = 2 * Math.PI;
  bodies = [
    new Body([ a,  b, 0], [-vx/2 * s, -vy/2 * s, 0], 1.0, '#ff4a4a', 0, 0.08),
    new Body([-a, -b, 0], [-vx/2 * s, -vy/2 * s, 0], 1.0, '#4aff6a', 0, 0.08),
    new Body([ 0,  0, 0], [ vx    * s,  vy    * s, 0], 1.0, '#4a9eff', 0, 0.08),
  ];
}

// Pythagorean three-body (Burrau 1913; Szebehely & Peters 1967).
// Three bodies of mass 3, 4, 5 at the vertices of a 3-4-5 right triangle,
// all starting at rest. This is one of the most chaotic three-body setups
// known: it cannot be solved in closed form and is exquisitely sensitive
// to integrator quality. Szebehely & Peters 1967 showed that the system
// evolves until ~t = 60 (in their units) at which point the mass-3 and
// mass-4 bodies form a binary and eject the mass-5 body to infinity.
// It is *the* standard stress-test for N-body codes.
function _presetPythagorean() {
  cfg.forceMode = 'gravity';
  cfg.dt        = 0.002;
  cfg.eps       = 0.001;
  cfg.eta       = 0.015;                // tighter η for this chaotic system
  // Classic Burrau positions: (1,3), (-2,-1), (1,-1)
  // Masses: 3, 4, 5 (respectively).
  // In Szebehely–Peters units G=1; rescale velocity-equivalent factor irrelevant here (start at rest).
  bodies = [
    new Body([ 1,  3, 0], [0, 0, 0], 3, '#ff6644', 0, 0.14),  // m=3
    new Body([-2, -1, 0], [0, 0, 0], 4, '#44ff88', 0, 0.16),  // m=4
    new Body([ 1, -1, 0], [0, 0, 0], 5, '#4488ff', 0, 0.18),  // m=5
  ];
}

// Plummer sphere (Plummer 1911, MNRAS 71, 460).
// A simple spherically-symmetric model of a star cluster with density
// ρ(r) = 3 M / (4π a³) · (1 + r²/a²)^(-5/2). It has an analytic distribution
// function so we can draw particles in *virial equilibrium* — i.e. the
// system starts with 2·T + U = 0 and should remain bound for many crossing
// times. Great for testing that an N-body code doesn't artificially heat
// or cool a collisionless system.
// Sampling recipe: Aarseth, Hénon & Wielen 1974, A&A 37, 183.
function _presetPlummer(N = 50) {
  cfg.forceMode = 'gravity';
  cfg.dt        = 0.003;
  cfg.eps       = 0.05;                 // softened to suppress two-body relaxation
  cfg.eta       = 0.03;
  const M_tot = N * 1.0;                // each star = 1 M☉
  const a     = 3.0;                    // Plummer scale length (AU)

  for (let i = 0; i < N; i++) {
    // Sample radius from cumulative mass fraction X = r³/(r²+a²)^(3/2)
    const X = rand();
    const r = a / Math.sqrt(Math.pow(X, -2/3) - 1);
    // Uniform on sphere
    const cosT = 2 * rand() - 1;
    const sinT = Math.sqrt(1 - cosT*cosT);
    const phi  = 2 * Math.PI * rand();
    const pos  = [r*sinT*Math.cos(phi), r*sinT*Math.sin(phi), r*cosT];
    // Escape velocity at radius r
    const v_e  = Math.sqrt(2 * G * M_tot / Math.sqrt(r*r + a*a));
    // von Neumann rejection sample on g(q) = q² (1 − q²)^(7/2), q = v/v_e
    let q, g;
    do { q = rand(); g = rand() * 0.1; } while (g > q*q * Math.pow(1 - q*q, 3.5));
    const v     = q * v_e;
    const cosTv = 2*rand() - 1, sinTv = Math.sqrt(1 - cosTv*cosTv);
    const phiV  = 2 * Math.PI * rand();
    const vel   = [v*sinTv*Math.cos(phiV), v*sinTv*Math.sin(phiV), v*cosTv];
    bodies.push(new Body(pos, vel, 1.0, randomColor(), 0));
  }
  // Enforce zero total momentum
  let px=0, py=0, pz=0;
  for (const b of bodies) { px+=b.mass*b.vel[0]; py+=b.mass*b.vel[1]; pz+=b.mass*b.vel[2]; }
  const Mtot = bodies.reduce((s,b)=>s+b.mass, 0);
  for (const b of bodies) { b.vel[0]-=px/Mtot; b.vel[1]-=py/Mtot; b.vel[2]-=pz/Mtot; }
}

// Sun–Jupiter–Trojan (L4/L5 Lagrange points).
// A test particle placed at the leading (L4) Lagrange point 60° ahead of
// Jupiter in its orbit — should stay there indefinitely (it's a stable
// equilibrium for μ < 0.0385). Classic textbook check on the restricted
// three-body problem.
function _presetTrojan() {
  cfg.forceMode = 'gravity';
  cfg.dt        = 0.003;
  cfg.eps       = 0.001;
  const aJ = 5.2, Msun = 1.0, Mjup = 9.55e-4;
  const M  = Msun + Mjup;
  const vJ = Math.sqrt(G * M / aJ);
  // Sun
  bodies.push(new Body([-Mjup/M * aJ, 0, 0], [0, -Mjup/M * vJ, 0], Msun, '#fff5c2', 0, 0.35));
  // Jupiter
  bodies.push(new Body([ Msun/M * aJ, 0, 0], [0,  Msun/M * vJ, 0], Mjup, '#c88b3a', 0, 0.14));
  // L4 Trojan: 60° ahead of Jupiter, same orbital radius, same angular speed
  const th = Math.PI / 3;
  const pos = [aJ * Math.cos(th), aJ * Math.sin(th), 0];
  const v   = vJ;
  const vel = [-v * Math.sin(th), v * Math.cos(th), 0];
  bodies.push(new Body(pos, vel, 1e-10, '#ffaa33', 0, 0.05));
}

function loadPreset(name) {
  // Reset shared state
  centralOn = false;
  blackHole = null;
  photonsOn = false;
  photons   = [];
  simTime   = 0;
  recordRows = []; recordCount = 0;
  selectedIndex = null;
  bodies = [];
  // Every preset gets a deterministic stream from the current seed
  rngSeed(cfg.seed);

  switch (name) {
    case 'solar_system': _presetSolarSystem(); break;
    case 'binary_star':  _presetBinaryStar();  break;
    case 'galaxy_core':  _presetGalaxyCore();  break;
    case 'hydrogen':     _presetHydrogen();    break;
    case 'helium':       _presetHelium();      break;
    case 'argon_gas':    _presetArgon();       break;
    case 'kepler':       _presetKepler();      break;
    case 'figure_eight': _presetFigureEight(); break;
    case 'pythagorean':  _presetPythagorean(); break;
    case 'plummer':      _presetPlummer(50);   break;
    case 'trojan':       _presetTrojan();      break;
    default:             generateBodies(cfg.N); break;
  }
  cfg.N = bodies.length;
  resetDiagnosticsBaseline();
}

// ── Conservation diagnostics ──────────────────────────────────
// Computes total energy, linear momentum, and angular momentum (about origin).
// These are the three quantities that must be conserved (within dt² error) by
// any legitimate N-body integrator — they are the primary scientific proof
// that the simulation is correct. Populates `diag` and returns E.
function computeDiagnostics() {
  let ke = 0, pe = 0;
  let px = 0, py = 0, pz = 0;
  let Lx = 0, Ly = 0, Lz = 0;
  const eps2 = cfg.eps * cfg.eps;

  for (const b of bodies) {
    const [vx,vy,vz] = b.vel;
    const [x,y,z]    = b.pos;
    const m = b.mass;
    ke += 0.5 * m * (vx*vx + vy*vy + vz*vz);
    px += m*vx; py += m*vy; pz += m*vz;
    // L = r × p
    Lx += m * (y*vz - z*vy);
    Ly += m * (z*vx - x*vz);
    Lz += m * (x*vy - y*vx);
  }

  if (cfg.forceMode === 'gravity') {
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i+1; j < bodies.length; j++) {
        const dx = bodies[j].pos[0]-bodies[i].pos[0];
        const dy = bodies[j].pos[1]-bodies[i].pos[1];
        const dz = bodies[j].pos[2]-bodies[i].pos[2];
        pe -= G * bodies[i].mass * bodies[j].mass / Math.sqrt(dx*dx+dy*dy+dz*dz+eps2);
      }
      if (centralOn && blackHole) {
        const [bx,by,bz] = cfg.bhPos;
        const dx = bodies[i].pos[0]-bx, dy = bodies[i].pos[1]-by, dz = bodies[i].pos[2]-bz;
        pe -= G * blackHole.mass * bodies[i].mass / Math.sqrt(dx*dx+dy*dy+dz*dz+1e-4);
      }
    }
  } else if (cfg.forceMode === 'coulomb') {
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i+1; j < bodies.length; j++) {
        const dx = bodies[j].pos[0]-bodies[i].pos[0];
        const dy = bodies[j].pos[1]-bodies[i].pos[1];
        const dz = bodies[j].pos[2]-bodies[i].pos[2];
        pe += cfg.kCoulomb * bodies[i].charge * bodies[j].charge /
              Math.sqrt(dx*dx+dy*dy+dz*dz+eps2);
      }
    }
  } else { // lj
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i+1; j < bodies.length; j++) {
        const dx  = bodies[j].pos[0]-bodies[i].pos[0];
        const dy  = bodies[j].pos[1]-bodies[i].pos[1];
        const dz  = bodies[j].pos[2]-bodies[i].pos[2];
        const r2  = dx*dx+dy*dy+dz*dz+eps2;
        const sr2 = cfg.ljSigma*cfg.ljSigma / r2;
        const sr6 = sr2*sr2*sr2;
        pe += 4 * cfg.ljEpsilon * (sr6*sr6 - sr6);
      }
    }
  }

  const E = ke + pe;
  diag.energy = E;
  diag.px = px; diag.py = py; diag.pz = pz;
  diag.Lx = Lx; diag.Ly = Ly; diag.Lz = Lz;
  if (diag.energy0 === null || !isFinite(diag.energy0) || diag.energy0 === 0) {
    diag.energy0 = E;
    diag.energyDrift = 0;
  } else {
    diag.energyDrift = Math.abs((E - diag.energy0) / diag.energy0);
  }
  return E;
}
// Back-compat alias
function totalEnergy() { return computeDiagnostics(); }

// ── State Serialisation ───────────────────────────────────────
function getState(includeTrails) {
  if (++energyTick % 6 === 1) { energyCache = computeDiagnostics(); }
  const sel = (selectedIndex !== null && selectedIndex < bodies.length) ? selectedIndex : null;
  return {
    t: +simTime.toFixed(5),
    events: pendingEvents.splice(0),  // flush — consumed once by the UI
    running, central_on: centralOn, photons_on: photonsOn,
    energy: +energyCache.toFixed(4),
    body_count: bodies.length,
    selected_index: sel,
    force_mode: cfg.forceMode,
    bodies:     bodies.map(b => b.toDict(includeTrails)),
    black_hole: blackHole ? blackHole.toDict() : null,
    photons:    photons.map(p => p.toDict()),
    recorder:   { recording, record_count: recordCount },
    // Conservation + integrator diagnostics — the "proof it works" block
    diagnostics: {
      energy:        +diag.energy.toFixed(6),
      energy0:       diag.energy0 === null ? null : +diag.energy0.toFixed(6),
      energyDrift:   +diag.energyDrift.toExponential(3),
      momentum:      [+diag.px.toFixed(6), +diag.py.toFixed(6), +diag.pz.toFixed(6)],
      angMomentum:   [+diag.Lx.toFixed(6), +diag.Ly.toFixed(6), +diag.Lz.toFixed(6)],
      substeps:      diag.substeps,
      maxSubstepsHit:diag.maxSubstepsHit,
      rmin:          isFinite(diag.rmin) ? +diag.rmin.toFixed(4) : null,
      seed:          cfg.seed,
      eta:           cfg.eta,
      integratorMode: cfg.integratorMode,
      approximationActive: approximationActiveFor(),
      trustLevel:    trustLevel(),
    },
    config: {
      dt: cfg.dt, N_target: cfg.N, spawn_radius: cfg.spawnRadius,
      mass_min: cfg.massMin, mass_max: cfg.massMax, vel_factor: cfg.velFactor,
      central_mass: cfg.bhMass, photons_on: photonsOn, sample_interval: sampleInterval,
      force_mode: cfg.forceMode, integrator_mode: cfg.integratorMode,
      eps: cfg.eps, seed: cfg.seed, eta: cfg.eta,
    },
  };
}

// Call this after any initial-condition change so energy drift is measured
// from the new state, not the old one.
function resetDiagnosticsBaseline() {
  diag.energy0 = null;
  diag.energyDrift = 0;
  diag.substeps = 0;
  diag.maxSubstepsHit = false;
}

// ── Message Handler ───────────────────────────────────────────
self.onmessage = function({ data: msg }) {
  const v = msg.value;
  switch (msg.action) {
    case 'toggle_run': running = !running; break;
    case 'reset':
      bodies = []; photons = []; simTime = 0; recordRows = []; recordCount = 0;
      rngSeed(cfg.seed);           // same seed ⇒ same reset
      generateBodies(cfg.N);
      resetDiagnosticsBaseline();
      break;
    case 'random_reset':
      bodies = []; photons = []; simTime = 0; recordRows = []; recordCount = 0;
      cfg.seed = freshSeed();
      rngSeed(cfg.seed);
      generateBodies(cfg.N);
      resetDiagnosticsBaseline();
      break;
    case 'toggle_bh':
      if (cfg.forceMode !== 'gravity') break;
      centralOn = !centralOn;
      if (centralOn) {
        if (!blackHole) blackHole = new BlackHole(cfg.bhMass, cfg.bhPos);
        for (const b of bodies) { const ov = orbitalVel(b.pos); b.vel = add3(b.vel, ov); }
        handleBHAbsorption();
      } else { blackHole = null; }
      resetDiagnosticsBaseline();
      break;
    case 'toggle_photons': photonsOn = !photonsOn; break;
    case 'clear_photons':  photons = []; break;
    case 'spawn_photons':  spawnPhotons(msg.camera_pos, msg.camera_dir); break;
    case 'set_dt':           cfg.dt         = Math.max(1e-4, Math.min(1e-2, v)); break;
    case 'set_eta':          cfg.eta        = Math.max(0.002, Math.min(0.1, v)); break;
    case 'set_eps':          cfg.eps        = Math.max(1e-4, Math.min(1.0, v)); break;
    case 'set_seed':
      cfg.seed = (v | 0) >>> 0;
      rngSeed(cfg.seed);
      break;
    case 'set_N':
      cfg.N = clampNForMode(v);
      rngSeed(cfg.seed);
      generateBodies(cfg.N);
      resetDiagnosticsBaseline();
      break;
    case 'set_spawn_radius': cfg.spawnRadius = Math.max(1, Math.min(50, v)); break;
    case 'set_mass_min':     cfg.massMin    = Math.max(0.1, Math.min(cfg.massMax-0.1, v)); break;
    case 'set_mass_max':     cfg.massMax    = Math.max(cfg.massMin+0.1, Math.min(50, v)); break;
    case 'set_vel_factor':   cfg.velFactor  = Math.max(0, Math.min(3, v)); break;
    case 'set_bh_mass':
      cfg.bhMass = Math.max(10, Math.min(5000, v));
      if (blackHole) blackHole.mass = cfg.bhMass;
      handleBHAbsorption();
      resetDiagnosticsBaseline();
      break;
    case 'toggle_recording': recording = !recording; break;
    case 'save_csv': {
      // Emit a metadata header so every recording is reproducible
      const meta = [
        `# n-body-web-v2 recording`,
        `# timestamp: ${new Date().toISOString()}`,
        `# integrator: adaptive-substep Velocity Verlet`,
        `# force_mode: ${cfg.forceMode}`,
        `# G: ${G}   eps: ${cfg.eps}   eta: ${cfg.eta}`,
        `# dt_outer: ${cfg.dt}   seed: ${cfg.seed}`,
        `# N_initial: ${cfg.N}   bhMass: ${cfg.bhMass}   central_on: ${centralOn}`,
        `# E0: ${diag.energy0}   current E-drift: ${diag.energyDrift}`,
      ].join('\n');
      const hdr  = 'time,body_id,x,y,z,vx,vy,vz,mass\n';
      const rows = recordRows.map(r => r.join(',')).join('\n');
      self.postMessage({ type: 'csv_data', csv: meta + '\n' + hdr + rows, filename: `nbody_seed${cfg.seed}_${Date.now()}.csv` });
      break;
    }
    case 'set_sample_interval': sampleInterval = Math.max(1, Math.min(300, Math.round(v))); break;
    case 'set_integrator_mode': {
      const mode = msg.mode;
      if (mode !== 'realtime' && mode !== 'scientific' && mode !== 'high_accuracy') break;
      cfg.integratorMode = mode;
      applyModeDefaults(mode);
      const nextN = clampNForMode(cfg.N);
      if (nextN !== cfg.N) {
        cfg.N = nextN;
        rngSeed(cfg.seed);
        generateBodies(cfg.N);
      }
      resetDiagnosticsBaseline();
      break;
    }
    case 'set_selected': selectedIndex = msg.index; break;
    case 'load_preset': loadPreset(msg.preset); break;
    case 'set_force_mode': {
      break;
    }
  }
};

// ── Physics Loop (200 Hz, self-scheduling) ────────────────────
async function physLoop() {
  const t0 = performance.now();
  try {
    if (running) await timestep();
    if (++photonTick % 3 === 0) updatePhotons();
  } catch (e) {
    console.error('[physLoop]', e);
  }
  setTimeout(physLoop, Math.max(0, PHYS_MS - (performance.now() - t0)));
}

// ── Broadcast Loop (60 fps) ───────────────────────────────────
function bcastLoop() {
  if (running && bodies.length === 0) generateBodies(cfg.N);  // auto-reset
  ++bcastTick;
  const includeTrails = false;
  self.postMessage({ type: 'state', data: getState(includeTrails) });
  setTimeout(bcastLoop, 1000 / BCAST_HZ);
}

// ── Init ──────────────────────────────────────────────────────
generateBodies(cfg.N);
physLoop();
bcastLoop();

// Start GPU init in background — physLoop uses CPU fallback until ready.
gpuInit().then(ok => {
  self.postMessage({ type: 'gpu_status', gpu: ok });
});

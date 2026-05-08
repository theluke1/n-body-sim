'use strict';
/**
 * gpu-gravity.js
 * WebGPU-accelerated N-body force calculator — three modes: gravity / Coulomb / LJ.
 * Loaded into physics.worker.js via importScripts().
 *
 * Public API (attached to self):
 *   await gpuInit()          → true if WebGPU is available
 *   gpuIsReady()             → true once initialised
 *   await gpuComputeAcc(positions, masses, charges, centralOn, bhPos, bhMass, eps,
 *                        forceMode, kCoulomb, ljSigma, ljEpsilon)
 *                            → [[ax,ay,az], ...] per body
 *
 * Cfg struct (48 bytes = 12 × 4):
 *   [0] N u32  [1] eps2 f32  [2] G f32      [3] centralOn u32
 *   [4] bhX    [5] bhY       [6] bhZ         [7] bhMass
 *   [8] forceMode u32        [9] kCoulomb f32 [10] ljSigma2 f32  [11] ljEps24 f32
 */

(function () {

// ── WGSL compute shader ───────────────────────────────────────────────────────
// One thread per body i. Loops over all j, accumulates acceleration.
// Three force modes selected at runtime by cfg.forceMode (u32):
//   0 = Newtonian gravity   F ∝ G·m_j / r²  (attractive)
//   1 = Coulomb             F ∝ k·q_i·q_j / r²  (same-sign = repulsive)
//   2 = Lennard-Jones       F ∝ 24ε/r² · [2(σ/r)¹² − (σ/r)⁶]
const WGSL = /* wgsl */`
struct Cfg {
  N         : u32,
  eps2      : f32,
  G         : f32,
  centralOn : u32,
  bhX       : f32,
  bhY       : f32,
  bhZ       : f32,
  bhMass    : f32,
  forceMode : u32,   // 0 gravity | 1 coulomb | 2 lj
  kCoulomb  : f32,
  ljSigma2  : f32,   // σ²
  ljEps24   : f32,   // 24ε
};

@group(0) @binding(0) var<storage, read>       pos    : array<vec4f>;
@group(0) @binding(1) var<storage, read>       mass   : array<f32>;
@group(0) @binding(2) var<storage, read_write> acc    : array<vec4f>;
@group(0) @binding(3) var<uniform>             cfg    : Cfg;
@group(0) @binding(4) var<storage, read>       charge : array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3u) {
  let i = gid.x;
  if (i >= cfg.N) { return; }

  let pi = pos[i].xyz;
  let mi = mass[i];
  let qi = charge[i];
  var a  = vec3f(0.0);

  for (var j = 0u; j < cfg.N; j++) {
    if (j == i) { continue; }

    let d   = pos[j].xyz - pi;
    let r2  = dot(d, d) + cfg.eps2;
    let r   = sqrt(r2);
    let ir3 = 1.0 / (r2 * r);

    if (cfg.forceMode == 0u) {
      // ── Gravity ───────────────────────────────────────────────
      // a_i += G · m_j / r³ · d   (always attractive)
      a += cfg.G * mass[j] * ir3 * d;

    } else if (cfg.forceMode == 1u) {
      // ── Coulomb ───────────────────────────────────────────────
      // a_i = −k · q_i · q_j / (m_i · r³) · d
      // same-sign charges → q_i·q_j > 0 → a points away from j (repulsive ✓)
      a -= (cfg.kCoulomb * qi * charge[j] / mi) * ir3 * d;

    } else {
      // ── Lennard-Jones ─────────────────────────────────────────
      // U = 4ε [(σ/r)¹² − (σ/r)⁶]
      // a_i = (24ε / (m_i · r²)) · [2·sr6² − sr6] · d
      // attractive when r > r_eq = 2^(1/6)·σ, repulsive when r < r_eq
      let sr2 = cfg.ljSigma2 / r2;
      let sr6 = sr2 * sr2 * sr2;
      a += (cfg.ljEps24 / (mi * r2)) * (2.0 * sr6 * sr6 - sr6) * d;
    }
  }

  // ── Black hole gravity (gravity mode only) ────────────────────
  if (cfg.forceMode == 0u && cfg.centralOn != 0u) {
    let bh  = vec3f(cfg.bhX, cfg.bhY, cfg.bhZ);
    let d   = bh - pi;
    let r2  = dot(d, d) + 1e-4;
    let ir3 = 1.0 / (r2 * sqrt(r2));
    a      += cfg.G * cfg.bhMass * ir3 * d;
  }

  acc[i] = vec4f(a, 0.0);
}
`;

// ── State ─────────────────────────────────────────────────────────────────────
let device    = null;
let pipeline  = null;
let _ready    = false;

// Cached GPU buffers — recreated only when N changes
let _N        = 0;
let posBuf, massBuf, accBuf, readBuf, cfgBuf, chargeBuf, bindGroup;

// ── Initialise ────────────────────────────────────────────────────────────────
async function gpuInit() {
  if (typeof navigator === 'undefined' || !navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return false;
    device   = await adapter.requestDevice();
    const mod = device.createShaderModule({ code: WGSL });
    pipeline  = device.createComputePipeline({
      layout: 'auto',
      compute: { module: mod, entryPoint: 'main' },
    });
    _ready = true;
    console.log('[GPU] WebGPU ready — three-mode shader loaded');
    return true;
  } catch (e) {
    console.warn('[GPU] init failed — CPU fallback active:', e.message);
    return false;
  }
}

// ── Buffer management — recreate only when N changes ─────────────────────────
function _ensureBuffers(n) {
  if (n === _N) return;
  _N = n;

  if (posBuf)    posBuf.destroy();
  if (massBuf)   massBuf.destroy();
  if (accBuf)    accBuf.destroy();
  if (readBuf)   readBuf.destroy();
  if (cfgBuf)    cfgBuf.destroy();
  if (chargeBuf) chargeBuf.destroy();

  const posBytes  = n * 16;   // vec4f = 4 × f32 per body
  const massBytes = n * 4;    // f32 per body

  posBuf    = device.createBuffer({ size: posBytes,  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  massBuf   = device.createBuffer({ size: massBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  accBuf    = device.createBuffer({ size: posBytes,  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  readBuf   = device.createBuffer({ size: posBytes,  usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  cfgBuf    = device.createBuffer({ size: 48,        usage: GPUBufferUsage.UNIFORM  | GPUBufferUsage.COPY_DST }); // 12 × 4 = 48 bytes
  chargeBuf = device.createBuffer({ size: massBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

  // Bind group is tied to buffers — rebuild whenever N changes
  bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: posBuf    } },
      { binding: 1, resource: { buffer: massBuf   } },
      { binding: 2, resource: { buffer: accBuf    } },
      { binding: 3, resource: { buffer: cfgBuf    } },
      { binding: 4, resource: { buffer: chargeBuf } },
    ],
  });
}

// ── Main compute function ─────────────────────────────────────────────────────
// Returns [[ax,ay,az], ...] per body — same format as CPU computeAcc().
async function gpuComputeAcc(positions, masses, charges,
                              centralOn, bhPos, bhMass, eps,
                              forceMode, kCoulomb, ljSigma, ljEpsilon) {
  const n = positions.length;
  _ensureBuffers(n);

  // ── Pack positions as vec4f (stride 4 floats, w = 0) ───────────
  const posData = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    posData[i * 4]     = positions[i][0];
    posData[i * 4 + 1] = positions[i][1];
    posData[i * 4 + 2] = positions[i][2];
    // posData[i*4+3] = 0 (default Float32Array fill)
  }

  // ── Pack config: 12 × 4 bytes = 48 bytes ───────────────────────
  // Use same buffer as both Float32Array and Uint32Array to write u32 fields correctly.
  const cfgF32 = new Float32Array(12);
  const cfgU32 = new Uint32Array(cfgF32.buffer);
  const forceModeInt = forceMode === 'gravity' ? 0 : forceMode === 'coulomb' ? 1 : 2;

  cfgU32[0]  = n;
  cfgF32[1]  = eps * eps;
  cfgF32[2]  = 4 * Math.PI * Math.PI;   // G = 4π² in AU/M☉/yr units
  cfgU32[3]  = centralOn ? 1 : 0;
  cfgF32[4]  = bhPos[0];
  cfgF32[5]  = bhPos[1];
  cfgF32[6]  = bhPos[2];
  cfgF32[7]  = bhMass;
  cfgU32[8]  = forceModeInt;
  cfgF32[9]  = kCoulomb;
  cfgF32[10] = ljSigma * ljSigma;       // pre-compute σ²
  cfgF32[11] = 24 * ljEpsilon;          // pre-compute 24ε

  // ── Upload to GPU ───────────────────────────────────────────────
  device.queue.writeBuffer(posBuf,    0, posData);
  device.queue.writeBuffer(massBuf,   0, new Float32Array(masses));
  device.queue.writeBuffer(cfgBuf,    0, cfgF32);
  device.queue.writeBuffer(chargeBuf, 0, new Float32Array(charges));

  // ── Dispatch — one workgroup per 64 bodies ─────────────────────
  const enc  = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(n / 64));
  pass.end();

  // Copy result buffer to a mappable readback buffer
  enc.copyBufferToBuffer(accBuf, 0, readBuf, 0, n * 16);
  device.queue.submit([enc.finish()]);

  // ── Readback ────────────────────────────────────────────────────
  await readBuf.mapAsync(GPUMapMode.READ);
  const raw = new Float32Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();

  // ── Unpack vec4f → [[ax,ay,az], ...] ───────────────────────────
  const result = new Array(n);
  for (let i = 0; i < n; i++) {
    result[i] = [raw[i * 4], raw[i * 4 + 1], raw[i * 4 + 2]];
  }
  return result;
}

// ── Export to worker global scope ─────────────────────────────────────────────
self.gpuInit       = gpuInit;
self.gpuIsReady    = () => _ready;
self.gpuComputeAcc = gpuComputeAcc;

})();

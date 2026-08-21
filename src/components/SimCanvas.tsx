import { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { MutableRefObject } from 'react';
import type { SimState } from '../types';

interface Props {
  stateRef: MutableRefObject<SimState>;
  onSelectBody: (index: number | null) => void;
  onSpawnPhotons: (cameraPos: [number, number, number], cameraDir: [number, number, number]) => void;
  showGrid: boolean;
  showTrails: boolean;
  // Bloom (UnrealBloomPass) is visually gorgeous but also the single biggest
  // frame-time cost on integrated GPUs (≈4–8 ms/frame at 1440p on an M1). For
  // scientific / low-spec use we expose it as a toggle — off by default when
  // the user reports lag.
  bloomOn: boolean;
  onCaptureFrame?: (dataUrl: string) => void;
}

const MAX_BODIES    = 300;
const MAX_TRAIL_PTS = 120;
const MAX_PHOTON_T  = 40;

// ── Lensing-sphere haze ───────────────────────────────────────────────────────
// A thin Fresnel rim rendered on the outside of the lensing sphere.  Because it
// is a real 3D mesh (not a screen-space overlay) it moves with the scene and has
// zero lag relative to the camera.  The haze makes the sphere boundary tangible
// without hiding what's behind it — opacity peaks at grazing angles and is zero
// face-on so orbiting bodies are always visible through the "glass."
function makeHazeMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(0x99aabb) },   // near-neutral — astronomical, not decorative
    },
    vertexShader: /* glsl */`
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vNormal   = normalize(normalMatrix * normal);
        vViewDir  = normalize(cameraPosition - worldPos.xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        // Fresnel: bright at grazing angles (edge), dark face-on (center)
        float fresnel = 1.0 - abs(dot(normalize(vNormal), normalize(vViewDir)));
        fresnel = pow(fresnel, 5.0);
        gl_FragColor = vec4(uColor * fresnel, fresnel * 0.04);
      }
    `,
  });
}

function makeEventHorizonRimMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(0xffc36a) },
    },
    vertexShader: /* glsl */`
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vViewDir = normalize(cameraPosition - worldPos.xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        float rim = 1.0 - abs(dot(normalize(vNormal), normalize(vViewDir)));
        rim = pow(rim, 5.5);
        gl_FragColor = vec4(uColor * rim, rim * 0.32);
      }
    `,
  });
}

function makeAccretionDiskMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      time:       { value: 0 },
      inner:      { value: 0.26 },
      outer:      { value: 1.0 },
      colorHot:   { value: new THREE.Color(0xffffff) },  // white inner rim
      colorMid:   { value: new THREE.Color(0xff8800) },  // orange mid-disk
      colorCool:  { value: new THREE.Color(0xcc1100) },  // dark red outer — no purple
      // Relativistic Doppler: camera world position + Schwarzschild radius (AU)
      uCameraPos: { value: new THREE.Vector3() },
      uRS:        { value: 0.25 },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vPos;
      varying vec3 vWorldPos;
      // Prograde orbital velocity direction in world space — used by Doppler
      // formula.  Computed in the vertex shader so each fragment can dot it
      // against the camera direction without a matrix multiply per-fragment.
      varying vec3 vOrbDir;
      void main() {
        vUv      = uv;
        vPos     = position;
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        // RingGeometry lies in the local XY plane (z≈0).  For a prograde
        // Keplerian orbit, the velocity direction is tangent to the ring:
        // ê_orb = normalize(–y, +x, 0) in the local disk frame.
        float r2d     = length(position.xy);
        vec3  localOrb = (r2d > 0.0001)
          ? vec3(-position.y / r2d, position.x / r2d, 0.0)
          : vec3(1.0, 0.0, 0.0);
        vOrbDir = normalize((modelMatrix * vec4(localOrb, 0.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float time;
      uniform float inner;
      uniform float outer;
      uniform vec3  colorHot;
      uniform vec3  colorMid;
      uniform vec3  colorCool;
      uniform vec3  uCameraPos;
      uniform float uRS;
      varying vec2  vUv;
      varying vec3  vPos;
      varying vec3  vWorldPos;
      varying vec3  vOrbDir;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }

      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        float a = atan(p.y, p.x);
        float disk = smoothstep(inner, inner + 0.035, r) * smoothstep(outer, outer - 0.1, r);
        float lane = sin(a * 8.0 + time * 2.1 - r * 17.0);
        float grain = noise(vec2(a * 3.0 + time * 0.45, r * 18.0 - time * 0.9));
        float heat = pow(1.0 - smoothstep(inner, outer, r), 1.7);
        vec3 color = mix(colorCool, colorMid, smoothstep(0.18, 0.74, heat));
        color = mix(color, colorHot, pow(heat, 2.4));
        float alpha = disk * (0.46 + 0.24 * lane + 0.3 * grain);
        alpha *= smoothstep(1.0, 0.15, abs(vPos.y));

        // ── Relativistic Doppler brightening ──────────────────────
        // Keplerian orbital speed in Schwarzschild metric:
        //   β = √(rₛ / 2r),  r = local ring radius in simulation units (AU).
        // Observed flux ∝ D³ where D = 1 / (γ(1 − β·cosθ)).
        // Approaching side (cosθ > 0) brightens; receding side dims.
        float rLocal = length(vPos.xy);
        float betaSq = uRS / (2.0 * max(rLocal, uRS * 0.6));
        betaSq       = min(betaSq, 0.96);        // clamp: stays well subluminal
        float beta   = sqrt(betaSq);
        float gamma  = 1.0 / sqrt(1.0 - betaSq);
        vec3  toCam  = normalize(uCameraPos - vWorldPos);
        float cosA   = dot(vOrbDir, toCam);
        float D      = 1.0 / (gamma * (1.0 - beta * cosA));
        float boost  = pow(clamp(D, 0.08, 8.0), 3.0);

        // ── Gravitational redshift ─────────────────────────────────────────
        // g = √(1 − rₛ/r): emission dims as r → rₛ (inner rim goes dark/red).
        // Most physically significant effect missing from a pure-Doppler disk.
        float gFactor = sqrt(max(0.001, 1.0 - uRS / max(rLocal, uRS * 1.01)));

        gl_FragColor = vec4(color * (1.0 + heat * 2.2) * boost * gFactor, max(alpha, 0.0));
      }
    `,
  });
}

function makeCircleSpriteTexture() {
  const size = 96;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.00, 'rgba(255,255,255,1)');
  g.addColorStop(0.34, 'rgba(255,255,255,0.96)');
  g.addColorStop(0.58, 'rgba(255,255,255,0.46)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Resolve body color — worker sends CSS strings like 'hsl(240,80%,65%)'
// Falls back to mass-based color temperature if missing.
// Writes into `out` rather than allocating, so this can be called every
// frame for every body without producing GC pressure.
function resolveBodyColor(out: THREE.Color, mass: number, workerColor?: string): void {
  if (workerColor) {
    try { out.set(workerColor); return; } catch (_) { /* fall through */ }
  }
  if      (mass > 10) out.setHex(0x80aaff);
  else if (mass > 5)  out.setHex(0xffffff);
  else if (mass > 2)  out.setHex(0xfff0b0);
  else if (mass > 1)  out.setHex(0xffaa55);
  else                out.setHex(0xff5533);
}

// ── Halton low-discrepancy sequence (Halton 1960) ────────────────
// Returns the i-th element of the radical-inverse sequence in the given
// prime base. Halton(2, 3, 5, ...) generates quasi-random points with far
// better angular coverage than Math.random() — no clumps, no bald patches,
// dense everywhere at every resolution. This is what renderers (pbrt, Monte
// Carlo integrators) use to sample the hemisphere without variance spikes.
function halton(index: number, base: number): number {
  let f = 1, r = 0;
  while (index > 0) {
    f /= base;
    r += f * (index % base);
    index = Math.floor(index / base);
  }
  return r;
}

// Harvard spectral classification weights (O/B/A/F/G/K/M). The fractions
// reflect the actual *observable* Milky Way census — M-dwarfs dominate the
// population at ~75% by number, but they're dim so we see fewer in a naked-
// eye catalog. These weights are tuned for how a typical night sky *looks*
// rather than strict population demographics. Source: Allen's Astrophysical
// Quantities, 4th ed., table 15.8.
const STAR_PALETTE = [
  [0.60, 0.72, 1.00], // O/B: blue-white
  [0.90, 0.95, 1.00], // A:   white
  [1.00, 1.00, 0.88], // F/G: yellow-white
  [1.00, 0.88, 0.65], // K:   orange
  [1.00, 0.65, 0.45], // M:   red-orange
];
const STAR_WEIGHTS = [0.20, 0.35, 0.25, 0.12, 0.08];
const STAR_CUMULATIVE = STAR_WEIGHTS.reduce<number[]>(
  (a, w, i) => [...a, (a[i - 1] ?? 0) + w], []);

function buildStarfield(): THREE.Points {
  const N   = 12000;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);

  for (let i = 0; i < N; i++) {
    // Uniform sphere via Halton(2) × Halton(3). Classic trick: θ uniform on
    // [0, 2π), cos φ uniform on [-1, 1] gives a rigorously uniform
    // spherical distribution (equal area per solid-angle). Much cleaner
    // than acos(2r-1) with Math.random().
    const h2     = halton(i + 1, 2);
    const h3     = halton(i + 1, 3);
    const h5     = halton(i + 1, 5);
    const h7     = halton(i + 1, 7);
    const theta  = h2 * Math.PI * 2;
    const cosPhi = 2 * h3 - 1;
    const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
    // Shell radius: 420–700 units, quasi-random in depth so stars don't
    // form a flat sphere but occupy a thick spherical shell.
    const r      = 420 + h5 * 280;
    pos[i * 3]     = r * sinPhi * Math.cos(theta);
    pos[i * 3 + 1] = r * sinPhi * Math.sin(theta);
    pos[i * 3 + 2] = r * cosPhi;

    // Spectral class via Halton(7). Using a separate base ensures color
    // assignment is uncorrelated with position.
    const ci     = STAR_CUMULATIVE.findIndex(c => h7 < c);
    const p      = STAR_PALETTE[ci >= 0 ? ci : 4];
    // Brightness: still use Math.random here because eye response to
    // brightness variance wants true randomness (otherwise you see a
    // subtle interference pattern in a zoomed-out shot).
    const bright = 0.4 + Math.random() * 0.6;
    col[i * 3]     = p[0] * bright;
    col[i * 3 + 1] = p[1] * bright;
    col[i * 3 + 2] = p[2] * bright;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({
    size: 1.4, sizeAttenuation: true, vertexColors: true,
    transparent: true, opacity: 0.9,
  }));
}


// ── Schwarzschild gravitational lensing pass ─────────────────────────────────
// Full 3D Schwarzschild lensing for every pixel. Two effects:
//
//   1. Background distortion: backward rays traced through Binet ODE, deflected
//      direction sampled from a CubeCamera (captures starfield + N-bodies from
//      the BH's position each frame). Mask fades to 5·b_crit for wide coverage.
//
//   2. Ghost disk image: while integrating, each step tracks the 3D photon
//      position and tests whether the geodesic crosses the accretion disk plane
//      (sign change of dot(bhToP, diskNormal)). Crossings past φ > 2.5 rad
//      (≈143°) are the "back side" ghost image — the disk wraps above and below
//      the shadow in the same way it does in Interstellar.
//
// References: Schwarzschild (1916), Binet (1710), Störmer-Verlet (1907/1967).
//   Ghost-image geometry: Luminet (1979), James et al. (2015) Interstellar paper.
//
// `cinematic` compiles a higher-quality variant:
//   • STEPS 240 (vs 120) — sharper photon ring, better ring-2 separation
//   • Ring width 0.032 (vs 0.07)    • Ring intensity D⁴ (vs D³)
//   • Ghost disk blend 0.50 (vs 0.25)  • Mask 8×bc (vs 6×bc)
function makeSchwarzschildLensPass(cubeRT: THREE.WebGLCubeRenderTarget, cinematic = false): ShaderPass {
  const STEPS         = cinematic ? 240 : 120;
  const RING_W        = cinematic ? 0.032 : 0.05;
  const RING_W2       = cinematic ? 0.022 : 0.04;
  const RING_INT      = cinematic ? 5.5   : 5.0;
  const DOPPLER_POW   = cinematic ? 4.0   : 3.0;
  const GHOST_BLEND   = cinematic ? 0.50  : 0.25;
  const MASK_MULT     = cinematic ? 8.0   : 6.0;
  return new ShaderPass({
    uniforms: {
      tDiffuse:       { value: null as THREE.Texture | null },
      uEnvMap:        { value: cubeRT.texture },
      uBHWorldPos:    { value: new THREE.Vector3() },
      uCameraPos:     { value: new THREE.Vector3() },
      uCameraFwd:     { value: new THREE.Vector3(0, 0, -1) },
      uCameraRight:   { value: new THREE.Vector3(1, 0, 0) },
      uCameraUp:      { value: new THREE.Vector3(0, 1, 0) },
      uFovTan:        { value: Math.tan((55 / 2) * (Math.PI / 180)) },
      uAspect:        { value: 1.0 },
      // rₛ is the visible event-horizon/capture radius. The apparent shadow
      // forms near b_crit = 2.598rₛ, outside the actual event horizon.
      uRS:            { value: 0.4 },
      uLensRadius:    { value: 4.0 },
      uEnabled:       { value: 0.0 },
      // Accretion-disk geometry in world space — used for ghost-image ray/disk
      // intersection. Normal, inner and outer radius updated every frame.
      uDiskNormal:    { value: new THREE.Vector3(0, 1, 0) },
      uDiskInner:     { value: 0.4 },
      uDiskOuter:     { value: 3.0 },
      uDiskColorHot:  { value: new THREE.Color(0xffffff) },
      uDiskColorMid:  { value: new THREE.Color(0xff8800) },
      uDiskColorCool: { value: new THREE.Color(0xcc1100) },
      // Disk prograde orbital direction in world space — drives Doppler
      // asymmetry of the photon ring (approaching side brighter).
      uDiskOrbDir:    { value: new THREE.Vector3(1, 0, 0) },
    },

    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,

    fragmentShader: /* glsl */`
      uniform sampler2D   tDiffuse;
      uniform samplerCube uEnvMap;
      uniform vec3  uBHWorldPos;
      uniform vec3  uCameraPos;
      uniform vec3  uCameraFwd;
      uniform vec3  uCameraRight;
      uniform vec3  uCameraUp;
      uniform float uFovTan;
      uniform float uAspect;
      uniform float uRS;
      uniform float uLensRadius;
      uniform float uEnabled;
      uniform vec3  uDiskNormal;
      uniform float uDiskInner;
      uniform float uDiskOuter;
      uniform vec3  uDiskColorHot;
      uniform vec3  uDiskColorMid;
      uniform vec3  uDiskColorCool;
      uniform vec3  uDiskOrbDir;
      varying vec2  vUv;

      // Störmer-Verlet integration — step count set at shader compile time.
      // Normal: 120 steps (6.6 rad).  Cinematic: 240 steps (13.2 rad).
      #define STEPS ${STEPS}
      #define DPHI  0.055

      void main() {
        if (uEnabled < 0.5) { gl_FragColor = texture2D(tDiffuse, vUv); return; }

        // ── 1. Reconstruct world-space ray ───────────────────────────
        vec2 ndc = vUv * 2.0 - 1.0;
        vec3 rd  = normalize(
          uCameraFwd
          + ndc.x * uAspect * uFovTan * uCameraRight
          + ndc.y * uFovTan * uCameraUp
        );

        // ── 2. Ray–lensing-sphere intersection ───────────────────────
        vec3  oc   = uCameraPos - uBHWorldPos;
        float hb   = dot(oc, rd);
        float c_   = dot(oc, oc) - uLensRadius * uLensRadius;
        float disc = hb * hb - c_;
        if (disc < 0.0) { gl_FragColor = texture2D(tDiffuse, vUv); return; }
        float sqD = sqrt(disc);
        float t   = -hb - sqD;
        if (t < 0.001) t = -hb + sqD;
        if (t < 0.001) { gl_FragColor = texture2D(tDiffuse, vUv); return; }

        // ── 3. Orbital-plane basis at entry point ────────────────────
        vec3  P    = uCameraPos + t * rd;
        vec3  rVec = P - uBHWorldPos;
        float r0   = length(rVec);
        if (r0 < 1e-5) { gl_FragColor = texture2D(tDiffuse, vUv); return; }

        vec3  e_r   = rVec / r0;
        float cosA  = dot(rd, e_r);
        vec3  dTang = rd - cosA * e_r;
        float sinA  = length(dTang);

        if (sinA < 1e-4) {
          gl_FragColor = (cosA < 0.0) ? vec4(0.0, 0.0, 0.0, 1.0)
                                      : texture2D(tDiffuse, vUv);
          return;
        }

        vec3  e_t = dTang / sinA;
        float b   = r0 * sinA;            // impact parameter (sim AU)
        float bc  = 2.598076 * uRS;       // critical b (photon sphere at 1.5·rₛ)

        // ── 4. Fade mask ─────────────────────────────────────────────
        // Covers 0 → 5·bc so lensing is visible well past the photon sphere —
        // background stars distort naturally across the whole BH neighbourhood.
        float mask = 1.0 - smoothstep(0.0, ${MASK_MULT.toFixed(1)} * bc, b);
        if (mask < 0.001) { gl_FragColor = texture2D(tDiffuse, vUv); return; }

        // ── 5. Störmer-Verlet Binet integration + ghost-disk test ────
        // d²u/dφ² = (3/2)·rₛ·u² − u,  u = 1/r
        // Simultaneously tracks 3D photon position (bhToP) each step and
        // tests for disk-plane crossings.  Crossings gated at φ > 2.5 rad
        // (≈143°) to exclude the near-side of the disk which is already
        // rendered by the main scene pass (tDiffuse).
        float u   = 1.0 / r0;
        float up  = -cosA / b;
        float phi = 0.0;
        bool  cap = false;

        vec3  bhToP       = r0 * e_r;                    // initial 3D pos
        float prevDiskDot = dot(bhToP, uDiskNormal);
        bool  hitDisk     = false;
        vec3  diskEmit    = vec3(0.0);

        for (int i = 0; i < STEPS; i++) {
          float upp = 1.5 * uRS * u * u - u;
          up  += 0.5 * upp * DPHI;
          u   += up  * DPHI;
          upp  = 1.5 * uRS * u * u - u;
          up  += 0.5 * upp * DPHI;
          phi += DPHI;

          if (u <= 0.0) break;
          if (1.0 / u < uRS) { cap = true; break; }

          // World-space photon position relative to BH
          bhToP = (1.0 / u) * (cos(phi) * e_r + sin(phi) * e_t);
          float diskDot = dot(bhToP, uDiskNormal);
          float diskR   = length(bhToP);

          // Ghost-disk: sign change of dot product = crossed disk plane.
          // φ > 2.5 rad ensures we are on the far/back side of the BH.
          if (!hitDisk && phi > 2.5
              && diskDot * prevDiskDot <= 0.0
              && diskR > uDiskInner && diskR < uDiskOuter) {

            // Heat gradient (inner hot → outer cool, same as disk mesh shader)
            float heat = pow(1.0 - smoothstep(uDiskInner, uDiskOuter, diskR), 1.7);
            diskEmit = mix(uDiskColorCool, uDiskColorMid, smoothstep(0.18, 0.74, heat));
            diskEmit = mix(diskEmit, uDiskColorHot, pow(heat, 2.4));
            diskEmit *= 1.0 + heat * 2.2;

            // Keplerian Doppler at intersection: β = √(rₛ/2r)
            vec3  radDir = normalize(bhToP);
            vec3  orbDir = normalize(cross(uDiskNormal, radDir));
            float betaSq = uRS / (2.0 * max(diskR, uRS * 0.6));
            betaSq       = min(betaSq, 0.96);
            float beta   = sqrt(betaSq);
            float gam    = 1.0 / sqrt(1.0 - betaSq);
            vec3  outDir = normalize(-sin(phi) * e_r + cos(phi) * e_t);
            float cosOA  = dot(orbDir, outDir);
            float D      = 1.0 / (gam * (1.0 - beta * cosOA));
            diskEmit    *= pow(clamp(D, 0.05, 8.0), ${DOPPLER_POW.toFixed(1)});

            hitDisk = true;
            break;
          }
          prevDiskDot = diskDot;
        }

        // ── 6. Compose ───────────────────────────────────────────────
        vec4 src = texture2D(tDiffuse, vUv);

        if (cap) {
          gl_FragColor = vec4(mix(src.rgb, vec3(0.0), mask), 1.0);
          return;
        }

        if (hitDisk) {
          // Ghost disk: blend over original scene — additive edge glow blends
          // cleanly with the accretion disk's own AdditiveBlending material.
          gl_FragColor = vec4(mix(src.rgb, diskEmit, mask * ${GHOST_BLEND.toFixed(2)}), 1.0);
          return;
        }

        // ── Escaped ray ──────────────────────────────────────────────
        // Primary: project the deflected world-space direction back into the
        // camera's screen space and sample tDiffuse there.  This makes every
        // piece of rendered geometry — orbit trails, body sprites, the disk —
        // visibly warp around the BH, not just the background stars.
        //
        // Fallback: off-screen / behind-camera directions sample the cubemap
        // (captures starfield + distant bodies from the BH position).
        vec3 bgDir = cos(phi) * e_r + sin(phi) * e_t;

        // Camera-space components using the basis vectors already passed in.
        // uCameraFwd is world-space "looking" direction (positive = into scene).
        float camX = dot(bgDir, uCameraRight);
        float camY = dot(bgDir, uCameraUp);
        float camZ = dot(bgDir, uCameraFwd);    // > 0 means in front of lens

        // Perspective-divide to NDC.  Guard camZ ≤ 0 (ray behind camera).
        float safeZ  = max(camZ, 0.001);
        vec2  ndcDef = vec2(camX / (safeZ * uFovTan * uAspect),
                            camY / (safeZ * uFovTan));
        vec2  defUV  = ndcDef * 0.5 + 0.5;

        // inView = 1 when deflected ray is inside the camera frustum
        float inView = step(0.001, camZ)
                     * step(0.0, defUV.x) * step(defUV.x, 1.0)
                     * step(0.0, defUV.y) * step(defUV.y, 1.0);

        vec3 screenSample = texture2D(tDiffuse, clamp(defUV, 0.001, 0.999)).rgb;
        vec3 cubeSample   = textureCube(uEnvMap, bgDir).rgb;
        vec3 envCol       = mix(cubeSample, screenSample, inView);

        // Photon ring n=1: sharper/thinner golden ring at b ≈ bc.
        // Doppler asymmetry: approaching side (dot > 0) is ~2× brighter —
        // same physical origin as the disk brightening, visible in EHT images.
        float ring = 1.0 - smoothstep(0.0, ${RING_W.toFixed(3)}, abs(b / bc - 1.0));
        float ringDoppler = 0.5 + 0.5 * dot(e_t, uDiskOrbDir);
        envCol += vec3(1.0, 0.86, 0.42) * ring * ring * ${RING_INT.toFixed(1)} * (0.5 + 0.8 * ringDoppler);

        // Photon ring n=2: secondary image at b ≈ 1.043·bc, ~15% intensity.
        // Arises from photons that orbit 1.5× before escaping (Luminet 1979).
        float ring2 = 1.0 - smoothstep(0.0, ${RING_W2.toFixed(3)}, abs(b / (bc * 1.043) - 1.0));
        envCol += vec3(1.0, 0.80, 0.35) * ring2 * ring2 * 0.55;

        gl_FragColor = vec4(mix(src.rgb, envCol, mask), 1.0);
      }
    `,
  });
}

// ── Trail / body shader — funnel displacement ────────────────────────────────
// Trails store raw world-space positions. This ShaderMaterial displaces each
// vertex toward the BH center in 3D using the same dip magnitude as the grid
// funnel (driven by XZ distance), so trail lines curve inward from any direction
// rather than always downward. All trail materials share the SAME four BH uniform
// objects — updating bhFunnelUniforms once per frame propagates to every trail.
type BHFunnelUniforms = {
  uBHPos:       { value: THREE.Vector3 };
  uBHPresence:  { value: number };
  uFunnelRS:    { value: number };
  uFunnelScale: { value: number };
};

function makeTrailMaterial(bhu: BHFunnelUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      // shared references — mutating bhu.*.value updates all trail materials
      uBHPos:       bhu.uBHPos,
      uBHPresence:  bhu.uBHPresence,
      uFunnelRS:    bhu.uFunnelRS,
      uFunnelScale: bhu.uFunnelScale,
      // per-trail
      uColor:   { value: new THREE.Color(0x7ab8ff) },
      uOpacity: { value: 0.72 },
    },
    vertexShader: /* glsl */`
      uniform vec3  uBHPos;
      uniform float uBHPresence;
      uniform float uFunnelRS;
      uniform float uFunnelScale;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3  uColor;
      uniform float uOpacity;
      void main() {
        gl_FragColor = vec4(uColor, uOpacity);
      }
    `,
  });
}

// ── Glowing spacetime grid ────────────────────────────────────────────────────
// Each grid line is subdivided into SEGS segments so the vertex shader can
// physically displace vertices downward into a gravitational well when a black
// hole is present. The resulting funnel is visible from any non-top-down angle.
// The Schwarzschild lensing ShaderPass then additionally warps the rendered
// pixels — so lines near the BH are both geometrically bent AND optically
// distorted, stacking both effects.
function makeGlowGrid(size: number, divisions: number): { mesh: THREE.LineSegments; material: THREE.ShaderMaterial } {
  const SEGS = 80; // subdivisions per line — controls funnel smoothness
  const step = size / divisions;
  const half = size / 2;
  const positions: number[] = [];

  // X-parallel lines (constant z, subdivided along x)
  for (let i = 0; i <= divisions; i++) {
    const z = -half + i * step;
    for (let j = 0; j < SEGS; j++) {
      const x0 = -half + (j / SEGS) * size;
      const x1 = -half + ((j + 1) / SEGS) * size;
      positions.push(x0, 0, z,  x1, 0, z);
    }
  }
  // Z-parallel lines (constant x, subdivided along z)
  for (let i = 0; i <= divisions; i++) {
    const x = -half + i * step;
    for (let j = 0; j < SEGS; j++) {
      const z0 = -half + (j / SEGS) * size;
      const z1 = -half + ((j + 1) / SEGS) * size;
      positions.push(x, 0, z0,  x, 0, z1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime:        { value: 0 },
      uBHPos:       { value: new THREE.Vector3() },
      uBHPresence:  { value: 0.0 },  // smooth 0→1 driven by render loop
      uFunnelRS:    { value: 1.0 },  // BH Schwarzschild-equivalent radius (AU)
      uFunnelScale: { value: 6.0 },  // depth multiplier
    },
    vertexShader: /* glsl */`
      uniform vec3  uBHPos;
      uniform float uBHPresence;
      uniform float uFunnelRS;
      uniform float uFunnelScale;
      varying float vDistToBH;
      varying float vBend;
      void main() {
        vec3  pos  = position;
        vec2  diff = vec2(pos.x - uBHPos.x, pos.z - uBHPos.z);
        float r    = length(diff);
        vDistToBH  = r;

        // Gravitational well: depth = A*(1/r - 1/rFlat)
        // rFlat scales with the throat so the funnel always spans the same
        // number of throat-radii regardless of BH mass — prevents large BH
        // masses from pushing rFlat inside the grid and killing the effect.
        float rSafe = max(r, uFunnelRS);
        float rFlat = uFunnelRS * 5.0;
        float depth = uFunnelScale * max(1.0 / rSafe - 1.0 / rFlat, 0.0);
        pos.y -= depth * uBHPresence;
        vBend = depth * uBHPresence;

        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform float uBHPresence;
      varying float vDistToBH;
      varying float vBend;
      void main() {
        // Base: visible blue, always present when grid is on
        vec3  baseColor = vec3(0.10, 0.25, 0.65);
        float baseAlpha = 0.80;

        // Proximity glow — brighten lines within ~22 AU of BH
        float proximity = 1.0 - smoothstep(0.0, 22.0, vDistToBH);

        // Outward pulse wave emanating from BH
        float wave  = sin(vDistToBH * 1.6 - uTime * 2.2) * 0.5 + 0.5;
        float pulse = wave * smoothstep(35.0, 0.0, vDistToBH);

        // Bent lines glow brighter — highlights the well geometry
        float bendGlow = min(vBend * 0.25, 1.0);

        vec3  glowColor = vec3(0.15, 0.55, 1.00);
        vec3  color = mix(baseColor, glowColor,
                          uBHPresence * (proximity * 0.8 + pulse * 0.4 + bendGlow * 0.6));
        float alpha = mix(baseAlpha,
                          min(baseAlpha + 0.6 * proximity + 0.18 * pulse + bendGlow * 0.4, 1.0),
                          uBHPresence);
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });

  return { mesh: new THREE.LineSegments(geo, mat), material: mat };
}

export default function SimCanvas({ stateRef, onSelectBody, onSpawnPhotons, showGrid, showTrails, bloomOn, onCaptureFrame }: Props) {
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const gridRef     = useRef<THREE.Object3D | null>(null);
  const gridMatRef  = useRef<THREE.ShaderMaterial | null>(null);
  const trailMapRef = useRef(new Map<number, { line: THREE.Line; buf: Float32Array; len: number }>());
  const photonMapRef= useRef(new Map<number, THREE.Line>());

  // Mirror toggles through refs so the render loop can read them without
  // re-mounting the WebGL context.
  const showTrailsRef = useRef(showTrails);
  const showGridRef   = useRef(showGrid);
  const bloomOnRef    = useRef(bloomOn);
  const bloomPassRef  = useRef<UnrealBloomPass | null>(null);
  const lensPassRef   = useRef<ShaderPass | null>(null);
  // Callback ref so AboutModal can request a frame capture without renderer access.
  const onCaptureFrameRef = useRef(onCaptureFrame);
  useEffect(() => { onCaptureFrameRef.current = onCaptureFrame; }, [onCaptureFrame]);
  useEffect(() => { showTrailsRef.current = showTrails; }, [showTrails]);
  useEffect(() => {
    showGridRef.current = showGrid;
    if (gridRef.current) gridRef.current.visible = showGrid;
  }, [showGrid]);
  useEffect(() => {
    bloomOnRef.current = bloomOn;
    if (bloomPassRef.current) bloomPassRef.current.enabled = bloomOn;
  }, [bloomOn]);

  const handleClick = useCallback((
    e: MouseEvent,
    canvas: HTMLCanvasElement,
    camera: THREE.Camera,
    stateRef: MutableRefObject<SimState>
  ) => {
    const rect   = canvas.getBoundingClientRect();
    const mx     = ((e.clientX - rect.left) / rect.width)  *  2 - 1;
    const my     = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
    const mouse  = new THREE.Vector2(mx, my);
    const bodies = stateRef.current.bodies;

    // Project each body position and find closest to click
    let nearestIdx = -1;
    let nearestD   = 0.06; // screen-space threshold
    for (let i = 0; i < bodies.length; i++) {
      const p = new THREE.Vector3(...bodies[i].pos).project(camera as THREE.PerspectiveCamera);
      const d = Math.hypot(p.x - mouse.x, p.y - mouse.y);
      if (d < nearestD) { nearestD = d; nearestIdx = i; }
    }
    onSelectBody(nearestIdx === -1 ? null : nearestIdx);
  }, [onSelectBody]);

  useEffect(() => {
    const canvas = canvasRef.current!;

    // ── Renderer ────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping        = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure= 1.15;
    renderer.outputColorSpace   = THREE.SRGBColorSpace;

    // ── Scene & Camera ──────────────────────────────────────
    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 2000);
    camera.position.set(0, 14, 32);

    const orb = new OrbitControls(camera, canvas);
    orb.enableDamping  = true;
    orb.dampingFactor  = 0.07;
    orb.minDistance    = 2;
    orb.maxDistance    = 500;

    // ── Lighting ────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0x0b1022, 2.5));
    const key = new THREE.DirectionalLight(0x7090cc, 1.8);
    key.position.set(30, 50, 30);
    scene.add(key);

    // ── Starfield ────────────────────────────────────────────
    scene.add(buildStarfield());

    // ── Reference grid ──────────────────────────────────────
    const { mesh: grid, material: gridMat } = makeGlowGrid(100, 50);
    grid.visible = showGridRef.current;
    scene.add(grid);
    gridRef.current  = grid;
    gridMatRef.current = gridMat;

    // ── PBR environment (PMREM from RoomEnvironment) ────────
    // PMREM (Pre-filtered Mipmapped Radiance Environment, Karis 2013) turns
    // an HDR map into a set of roughness-aware mip levels so PBR specular
    // reflections don't flicker. `RoomEnvironment` is a tiny procedural
    // scene that ships with three.js — gives us a neutral studio lighting
    // env without a network download. Anything with `metalness` or
    // `envMapIntensity` now picks up real reflections.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;

    // ── Body points ─────────────────────────────────────────
    // Bright circular point sprites read much better than shaded spheres for
    // dense orbital motion: they stay visible at every zoom level and cannot
    // go black due to lighting or material state.
    const bodyPos = new Float32Array(MAX_BODIES * 3);
    const bodyCol = new Float32Array(MAX_BODIES * 3);
    const bodyGeo = new THREE.BufferGeometry();
    bodyGeo.setAttribute('position', new THREE.BufferAttribute(bodyPos, 3).setUsage(THREE.DynamicDrawUsage));
    bodyGeo.setAttribute('color', new THREE.BufferAttribute(bodyCol, 3).setUsage(THREE.DynamicDrawUsage));
    bodyGeo.setDrawRange(0, 0);
    const bodySprite = makeCircleSpriteTexture();
    const bodyMat = new THREE.PointsMaterial({
      size: 10,
      sizeAttenuation: false,
      map: bodySprite,
      alphaMap: bodySprite,
      vertexColors: true,
      transparent: true,
      opacity: 1,
      alphaTest: 0.08,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const bodyPoints = new THREE.Points(bodyGeo, bodyMat);
    bodyPoints.frustumCulled = false;
    scene.add(bodyPoints);

    // ── Black hole group ────────────────────────────────────
    const bhGroup = new THREE.Group();
    bhGroup.visible = false;
    scene.add(bhGroup);
    let eventHorizonMesh: THREE.Mesh | null = null;
    let bhDiskMesh: THREE.Mesh<THREE.RingGeometry, THREE.ShaderMaterial> | null = null;
    let bhHazeMesh: THREE.Mesh | null = null;
    let lastBhKey = '';

    function rebuildBH(bh: SimState['blackHole']) {
      if (!bh) return;
      bhGroup.clear();
      eventHorizonMesh = null;
      bhDiskMesh = null;
      bhHazeMesh = null;

      const eventHorizonRadius = bh.event_horizon_radius ?? bh.radius;
      const photonSphereRadius = bh.photon_sphere_radius ?? eventHorizonRadius * 1.5;
      const shadowRadius = bh.shadow_radius ?? eventHorizonRadius * 2.598076;
      const lensRadius = bh.lens_radius ?? Math.max(3.0, shadowRadius * 5.0);

      const horizon = new THREE.Mesh(
        new THREE.SphereGeometry(eventHorizonRadius, 64, 64),
        new THREE.MeshBasicMaterial({ color: 0x000000 })
      );
      horizon.renderOrder = 3;
      bhGroup.add(horizon);
      eventHorizonMesh = horizon;

      const horizonRim = new THREE.Mesh(
        new THREE.SphereGeometry(eventHorizonRadius * 1.015, 64, 64),
        makeEventHorizonRimMaterial()
      );
      horizonRim.renderOrder = 4;
      bhGroup.add(horizonRim);

      // The shader renders the apparent black shadow and photon rings. This
      // subtle shell marks the physical photon-sphere radius for depth only.
      const photonSphere = new THREE.Mesh(
        new THREE.SphereGeometry(photonSphereRadius, 64, 64),
        new THREE.MeshBasicMaterial({
          color: 0xffd38a,
          blending: THREE.AdditiveBlending,
          transparent: true,
          opacity: 0.025,
          depthWrite: false,
          side: THREE.BackSide,
        })
      );
      photonSphere.renderOrder = 2;
      bhGroup.add(photonSphere);

      bhShadowRadius = shadowRadius;
      // Disk inner edge sits outside the apparent shadow. Bodies are captured
      // only at the smaller event horizon, not at this lensing edge.
      bhDiskInner = shadowRadius * 1.08;
      bhDiskOuter = shadowRadius * 4.8;
      const diskRadius = bhDiskOuter;
      const disk = new THREE.Mesh(
        new THREE.RingGeometry(bhDiskInner, diskRadius, 256, 3),
        makeAccretionDiskMaterial()
      );
      disk.rotation.x = Math.PI / 2.22;
      disk.rotation.z = -0.32;
      disk.renderOrder = 2;
      bhGroup.add(disk);
      bhDiskMesh = disk;

      // Blue halo removed — the shader's Fresnel haze and photon ring cover this.
      // Haze sphere at the lensing boundary (radius matches uLensRadius).
      const haze = new THREE.Mesh(
        new THREE.SphereGeometry(lensRadius, 64, 64),
        makeHazeMaterial()
      );
      haze.renderOrder = 1;
      bhGroup.add(haze);
      bhHazeMesh = haze;

      bhGroup.position.set(bh.pos[0], bh.pos[1], bh.pos[2]);
      bhGroup.visible = true;
    }

    // ── Post-processing (Bloom) ─────────────────────────────
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.85, 0.55, 0.22   // strength ↓, threshold ↑ — only the brightest points bloom
    );
    bloom.enabled = bloomOnRef.current;
    composer.addPass(bloom);
    bloomPassRef.current = bloom;

    // ── Schwarzschild lensing ───────────────────────────────
    // CubeCamera captures the scene (starfield + bodies) from the BH's
    // perspective each frame. The lens ShaderPass reads this as uEnvMap and
    // runs Binet geodesic integration per-pixel to produce the distorted
    // background, BH shadow, and photon ring.
    const cubeRT = new THREE.WebGLCubeRenderTarget(512, {
      format: THREE.RGBAFormat,
      type:   THREE.UnsignedByteType,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    const cubeCamera = new THREE.CubeCamera(0.1, 1500, cubeRT);
    scene.add(cubeCamera);

    // Two compiled lens pass variants — normal (120 steps) and cinematic (240).
    // Both live in the composer; only one has uEnabled=1 at a time so the
    // disabled one is a near-free blit (early-return in the shader).
    const lensPass = makeSchwarzschildLensPass(cubeRT, false);
    lensPass.enabled = false;
    composer.addPass(lensPass);
    lensPassRef.current = lensPass;

    // Scratch vectors — reused every frame, no alloc.
    const _camFwd    = new THREE.Vector3();
    const _camRight  = new THREE.Vector3();
    const _camUp     = new THREE.Vector3();
    const _diskNormal  = new THREE.Vector3();
    const _diskOrbDir  = new THREE.Vector3();
    const _tmpVec      = new THREE.Vector3();
    // Disk geometry stored on rebuild so lensing pass gets the right values.
    let bhDiskInner    = 0.4;
    let bhDiskOuter    = 3.0;
    let bhShadowRadius = 0;
    let cubeTick       = 0;
    // Smooth 0→1 presence value — drives grid glow and body/trail dimming
    let bhPresence     = 0.0;

    // ── Resize observer ─────────────────────────────────────
    const prevSize = new THREE.Vector2();
    function resize() {
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      if (prevSize.x === w && prevSize.y === h) return;
      prevSize.set(w, h);
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      bloom.resolution.set(w, h);
      lensPass.uniforms.uAspect.value = w / h;
    }
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement ?? document.body);
    resize();

    // ── Click handler ───────────────────────────────────────
    const clickHandler = (e: MouseEvent) => handleClick(e, canvas, camera, stateRef);
    const fireHandler = () => {
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      onSpawnPhotons(
        [camera.position.x, camera.position.y, camera.position.z],
        [dir.x, dir.y, dir.z]
      );
    };
    const captureHandler = () => {
      // Render one extra frame so the capture is current, then export.
      composer.render();
      const dataUrl = renderer.domElement.toDataURL('image/png');
      if (onCaptureFrameRef.current) onCaptureFrameRef.current(dataUrl);
    };
    canvas.addEventListener('click', clickHandler);
    window.addEventListener('nbody:fire-photons', fireHandler);
    window.addEventListener('nbody:capture-frame', captureHandler);

    // ── Scratch objects ─────────────────────────────────────
    // Everything that would otherwise allocate every frame lives up here so
    // the render loop produces zero garbage. At 60fps × 200 bodies × 2 maps
    // (bodies + photons), this saves ~24k short-lived objects per second —
    // which matters a lot on battery-powered machines.
    const col              = new THREE.Color();
    const activeBodyIds    = new Set<number>();
    const activePhotonIds  = new Set<number>();
    const trailsToRemove: number[] = [];
    const photonsToRemove: number[] = [];
    const clock            = new THREE.Clock();

    // Trail helpers
    const trailMap  = trailMapRef.current;
    const photonMap = photonMapRef.current;

    // Shared BH funnel uniforms for all trail materials — updated once per
    // frame so every trail gets the displacement without per-material loops.
    const bhFunnelUniforms: BHFunnelUniforms = {
      uBHPos:       { value: new THREE.Vector3() },
      uBHPresence:  { value: 0.0 },
      uFunnelRS:    { value: 1.0 },
      uFunnelScale: { value: 6.0 },
    };

    function getTrail(id: number): { line: THREE.Line; buf: Float32Array; len: number } {
      if (trailMap.has(id)) return trailMap.get(id)!;
      const buf  = new Float32Array(MAX_TRAIL_PTS * 3);
      const geo  = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(buf, 3));
      geo.setDrawRange(0, 0);
      const line = new THREE.Line(geo, makeTrailMaterial(bhFunnelUniforms));
      scene.add(line);
      const entry = { line, buf, len: 0 };
      trailMap.set(id, entry);
      return entry;
    }

    // ── Render loop ─────────────────────────────────────────
    let raf = 0;
    let frame = 0;

    function animate() {
      raf = requestAnimationFrame(animate);
      frame++;
      const elapsed = clock.getElapsedTime();
      orb.update();

      const state  = stateRef.current;
      const bodies = state.bodies ?? [];
      const bh     = state.blackHole;
      const photons= state.photons ?? [];
      const trails = showTrailsRef.current;
      const highBodyCount = bodies.length > 120;
      const trailLimit = highBodyCount ? 70 : bodies.length;
      const updateTrailFrame = !highBodyCount || frame % 3 === 0;

      // Smooth BH presence transition (0 = no BH, 1 = fully active)
      bhPresence += ((bh ? 1.0 : 0.0) - bhPresence) * 0.05;

      // Dim bodies and trails when the BH is on — lets the lensing / accretion
      // disk read clearly without competing brightness from point sprites/trails
      const bodyDim    = 1.0 - bhPresence * 0.55;
      const trailAlpha = 0.72 * (1.0 - bhPresence * 0.65);

      // Funnel parameters — capping visualRS keeps the well visible even for
      // very massive BHs whose shadow_radius would otherwise exceed the grid.
      // With rFlat = visualRS*5 the max funnel depth is always scale*(1 - 1/5)
      // = scale*0.8, independent of BH mass. A cap of 18 AU leaves room for
      // the funnel to spread across the 100-AU grid without clipping at the edges.
      const rawRS       = bh ? (bh.shadow_radius ?? (bh.event_horizon_radius ?? bh.radius) * 2.598076) : 1.0;
      const visualRS    = Math.min(rawRS, 18.0);
      const funnelScale = visualRS * 12.0;

      // Update grid + trail shared funnel uniforms
      if (gridMatRef.current) {
        const gu = gridMatRef.current.uniforms;
        gu.uTime.value        = elapsed;
        gu.uBHPresence.value  = bhPresence;
        gu.uFunnelRS.value    = visualRS;
        gu.uFunnelScale.value = funnelScale;
        if (bh) gu.uBHPos.value.set(bh.pos[0], bh.pos[1], bh.pos[2]);
      }
      bhFunnelUniforms.uBHPresence.value  = bhPresence;
      bhFunnelUniforms.uFunnelRS.value    = visualRS;
      bhFunnelUniforms.uFunnelScale.value = funnelScale;
      if (bh) bhFunnelUniforms.uBHPos.value.set(bh.pos[0], bh.pos[1], bh.pos[2]);

      // -- Bodies --
      const n = Math.min(bodies.length, MAX_BODIES);
      bodyGeo.setDrawRange(0, n);
      for (let i = 0; i < n; i++) {
        const b   = bodies[i];
        // Raw physics positions — the lensing shader handles screen-space warping
        bodyPos[i * 3]     = b.pos[0];
        bodyPos[i * 3 + 1] = b.pos[1];
        bodyPos[i * 3 + 2] = b.pos[2];
        resolveBodyColor(col, b.mass, b.color);
        bodyCol[i * 3]     = Math.min(col.r * 1.3 * bodyDim, 1);
        bodyCol[i * 3 + 1] = Math.min(col.g * 1.3 * bodyDim, 1);
        bodyCol[i * 3 + 2] = Math.min(col.b * 1.3 * bodyDim, 1);
      }
      (bodyGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (bodyGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;

      // -- Trails --
      activeBodyIds.clear();
      for (let i = 0; i < bodies.length; i++) activeBodyIds.add(bodies[i].id);
      trailsToRemove.length = 0;
      for (const id of trailMap.keys()) if (!activeBodyIds.has(id)) trailsToRemove.push(id);
      for (const id of trailsToRemove) {
        const entry = trailMap.get(id)!;
        scene.remove(entry.line);
        entry.line.geometry.dispose();
        (entry.line.material as THREE.Material).dispose();
        trailMap.delete(id);
      }
      for (let bi = 0; bi < bodies.length; bi++) {
        const b = bodies[bi];
        if (bi >= trailLimit) {
          const existing = trailMap.get(b.id);
          if (existing) existing.line.visible = false;
          continue;
        }
        const { line, buf } = getTrail(b.id);
        line.visible = trails && bi < trailLimit;
        if (!trails || !updateTrailFrame) continue;
        const entry = trailMap.get(b.id)!;

        if (entry.len < 2 && b.trail && b.trail.length >= 2) {
          entry.len = Math.min(b.trail.length, MAX_TRAIL_PTS);
          for (let i = 0; i < entry.len; i++) {
            buf[i * 3]     = b.trail[i][0];
            buf[i * 3 + 1] = b.trail[i][1];
            buf[i * 3 + 2] = b.trail[i][2];
          }
        }

        const px = b.pos[0];
        const py = b.pos[1];
        const pz = b.pos[2];
        const last = Math.max(0, entry.len - 1) * 3;
        const dx = px - buf[last];
        const dy = py - buf[last + 1];
        const dz = pz - buf[last + 2];
        if (entry.len === 0 || Math.hypot(dx, dy, dz) > 0.015) {
          if (entry.len >= MAX_TRAIL_PTS) {
            buf.copyWithin(0, 3);
            entry.len = MAX_TRAIL_PTS - 1;
          }
          const at = entry.len * 3;
          buf[at] = px;
          buf[at + 1] = py;
          buf[at + 2] = pz;
          entry.len += 1;
        }
        (line.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        line.geometry.setDrawRange(0, entry.len);
        const sm = line.material as THREE.ShaderMaterial;
        resolveBodyColor(col, b.mass, b.color);
        sm.uniforms.uColor.value.copy(col).multiplyScalar(1.25);
        sm.uniforms.uOpacity.value = trailAlpha;
      }

      // -- Black hole --
      if (bh) {
        const key = `${bh.mass}-${bh.pos}`;
        if (key !== lastBhKey) {
          rebuildBH(bh);
          lastBhKey = key;
          lensPass.uniforms.uLensRadius.value = bh.lens_radius ?? Math.max(3.0, bhShadowRadius * 5.0);
        }
        bhGroup.visible = true;
        bhGroup.position.set(bh.pos[0], bh.pos[1], bh.pos[2]);

        // ── Lensing pass updates ──────────────────────────────────
        // Update the cube map every 4 frames (≈15 fps) from the BH position.
        // We hide the BH group itself so its own geometry doesn't occlude
        // the captured background.
        if (++cubeTick % 4 === 0) {
          bhGroup.visible = false;
          lensPass.enabled = false;
          cubeCamera.position.set(bh.pos[0], bh.pos[1], bh.pos[2]);
          cubeCamera.update(renderer, scene);
          bhGroup.visible = true;
          lensPass.enabled = true;
          lensPass.uniforms.uEnabled.value = 1.0;
        }

        // Camera-space basis vectors (world space) for ray reconstruction.
        // Extracted from the camera's matrixWorld columns — column 0 = right,
        // column 1 = up, column 2 = -forward (OpenGL convention).
        _camRight.setFromMatrixColumn(camera.matrixWorld, 0);
        _camUp.setFromMatrixColumn(camera.matrixWorld, 1);
        _camFwd.setFromMatrixColumn(camera.matrixWorld, 2).negate();

        const lu = lensPass.uniforms;
        lu.uBHWorldPos.value.set(bh.pos[0], bh.pos[1], bh.pos[2]);
        lu.uCameraPos.value.copy(camera.position);
        lu.uCameraFwd.value.copy(_camFwd);
        lu.uCameraRight.value.copy(_camRight);
        lu.uCameraUp.value.copy(_camUp);
        lu.uFovTan.value = Math.tan((camera.fov / 2) * (Math.PI / 180));
        if (bhDiskMesh) {
          bhDiskMesh.rotation.z += 0.0065;
          bhDiskMesh.material.uniforms.time.value = elapsed;
          // Doppler: camera position changes every frame
          bhDiskMesh.material.uniforms.uCameraPos.value.copy(camera.position);

          // Ghost-disk intersection: pass the disk's current world-space normal
          // and radii to the lensing pass so it can test ray crossings correctly.
          // RingGeometry lies in the XY plane → local normal = (0,0,1).
          // applyEuler(bhDiskMesh.rotation) transforms that into world space.
          _diskNormal.set(0, 0, 1).applyEuler(bhDiskMesh.rotation).normalize();
          lu.uDiskNormal.value.copy(_diskNormal);
          lu.uDiskInner.value = bhDiskInner;
          lu.uDiskOuter.value = bhDiskOuter;
          // rₛ is the visible event-horizon/capture boundary. The apparent
          // black shadow forms farther out at b_crit = 2.598rₛ.
          const rS = bh.event_horizon_radius ?? bh.radius;
          lu.uRS.value = rS;
          bhDiskMesh.material.uniforms.uRS.value = rS;

          // Disk prograde orbital direction: cross(diskNormal, worldUp) gives
          // the tangent direction in the disk plane for Doppler asymmetry.
          _tmpVec.set(0, 1, 0);
          if (Math.abs(_diskNormal.dot(_tmpVec)) > 0.9) _tmpVec.set(1, 0, 0);
          _diskOrbDir.crossVectors(_diskNormal, _tmpVec).normalize();
          lu.uDiskOrbDir.value.copy(_diskOrbDir);
        }
        if (eventHorizonMesh) {
          const lookScale = 1 + Math.sin(elapsed * 0.8) * 0.006;
          eventHorizonMesh.scale.setScalar(lookScale);
        }

      } else {
        bhGroup.visible = false;
        lastBhKey = '';
        if (lensPass.enabled) { lensPass.enabled = false; lensPass.uniforms.uEnabled.value = 0.0; }
      }

      // -- Photons --
      activePhotonIds.clear();
      for (let i = 0; i < photons.length; i++) activePhotonIds.add(photons[i].id);
      photonsToRemove.length = 0;
      for (const id of photonMap.keys()) if (!activePhotonIds.has(id)) photonsToRemove.push(id);
      for (const id of photonsToRemove) {
        const line = photonMap.get(id)!;
        scene.remove(line);
        line.geometry.dispose();
        photonMap.delete(id);
      }
      for (const ph of photons) {
        if (!ph.trail || ph.trail.length < 2) continue;
        if (!photonMap.has(ph.id)) {
          const buf  = new Float32Array(MAX_PHOTON_T * 3);
          const geo  = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(buf, 3));
          const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
            color: 0xffe880, transparent: true, opacity: 0.9,
            blending: THREE.AdditiveBlending, depthWrite: false,
          }));
          scene.add(line);
          photonMap.set(ph.id, line);
        }
        const line  = photonMap.get(ph.id)!;
        const pattr = line.geometry.attributes.position as THREE.BufferAttribute;
        const tlen  = Math.min(ph.trail.length, MAX_PHOTON_T);
        for (let i = 0; i < tlen; i++) {
          pattr.setXYZ(i, ph.trail[i][0], ph.trail[i][1], ph.trail[i][2]);
        }
        pattr.needsUpdate = true;
        line.geometry.setDrawRange(0, tlen);
      }

      composer.render();
    }

    animate();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('click', clickHandler);
      window.removeEventListener('nbody:fire-photons', fireHandler);
      window.removeEventListener('nbody:capture-frame', captureHandler);
      renderer.dispose();
      composer.dispose();
      cubeRT.dispose();
      bodyGeo.dispose();
      bodyMat.dispose();
      bodySprite.dispose();
      for (const { line } of trailMap.values())  { line.geometry.dispose(); }
      for (const line of photonMap.values())      { line.geometry.dispose(); }
      trailMap.clear();
      photonMap.clear();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleClick, stateRef]);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
    />
  );
}

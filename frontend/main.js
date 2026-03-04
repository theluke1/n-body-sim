/**
 * N-Body Sim — Frontend
 * Three.js renderer with:
 *   - Bloom post-processing (UnrealBloomPass)
 *   - Instanced mesh for bodies (one draw call regardless of count)
 *   - Particle starfield background
 *   - Accretion disk shader on black hole
 *   - Chart.js live plots
 *   - WebSocket client
 */

import * as THREE from 'three';
import { OrbitControls }    from 'three/addons/controls/OrbitControls.js';
import { EffectComposer }   from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }       from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass }  from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }       from 'three/addons/postprocessing/OutputPass.js';

// ============================================================
// WebSocket
// ============================================================

const WS_URL = `ws://${location.host}/ws`;
let ws = null;
let lastState = null;

function connectWS() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => console.log('[WS] connected');
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'state')     onState(msg.data);
    if (msg.type === 'csv_saved') {
      const name = msg.filename.split(/[\\/]/).pop();
      document.getElementById('rec-status').textContent = `Saved: ${name}`;
    }
  };
  ws.onclose = () => { setTimeout(connectWS, 2000); };
  ws.onerror = (err) => console.error('[WS]', err);
}

function sendWS(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function control(action, value = 0) { sendWS({ action, value }); }

// ============================================================
// Renderer + scene + camera
// ============================================================

const canvas = document.getElementById('sim-canvas');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // cap at 2× — saves GPU on retina
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 2000);
camera.position.set(0, 12, 28);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping  = true;
controls.dampingFactor  = 0.07;
controls.minDistance    = 1;
controls.maxDistance    = 500;

// Lights
scene.add(new THREE.AmbientLight(0x111827, 3));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
keyLight.position.set(30, 40, 20);
scene.add(keyLight);

// ============================================================
// Post-processing: Bloom
// ============================================================

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  1.2,   // strength  — how bright the bloom is
  0.5,   // radius    — how far it spreads
  0.2    // threshold — objects brighter than this get bloomed
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// ============================================================
// Starfield (static — created once, zero per-frame CPU cost)
// ============================================================

(function buildStarfield() {
  const COUNT = 3500;
  const positions = new Float32Array(COUNT * 3);
  const colors    = new Float32Array(COUNT * 3);
  const sizes     = new Float32Array(COUNT);

  for (let i = 0; i < COUNT; i++) {
    // Spread stars on a large sphere shell
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    const r     = 300 + Math.random() * 400;
    positions[i*3]   = r * Math.sin(phi) * Math.cos(theta);
    positions[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i*3+2] = r * Math.cos(phi);

    // Slight blue/white tint variation
    const warm = Math.random();
    colors[i*3]   = 0.7 + warm * 0.3;
    colors[i*3+1] = 0.8 + warm * 0.1;
    colors[i*3+2] = 1.0;

    sizes[i] = 0.4 + Math.random() * 1.2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('size',     new THREE.BufferAttribute(sizes, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: `
      attribute float size;
      attribute vec3 color;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (300.0 / -mvPos.z);
        gl_Position  = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        if (d > 1.0) discard;
        float alpha = smoothstep(1.0, 0.2, d);
        gl_FragColor = vec4(vColor, alpha);
      }
    `,
    transparent: true,
    depthWrite:  false,
    blending:    THREE.AdditiveBlending,
    vertexColors: true,
  });

  scene.add(new THREE.Points(geo, mat));
})();

// ============================================================
// Instanced body mesh (all bodies in ONE draw call)
// ============================================================

const MAX_BODIES = 200;
const _dummy     = new THREE.Object3D();
const _color     = new THREE.Color();

const bodyGeo = new THREE.SphereGeometry(1, 14, 10);
const bodyMat = new THREE.MeshStandardMaterial({
  roughness: 0.35,
  metalness: 0.1,
  // emissive set per-instance via instanceColor trick below
});

const bodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, MAX_BODIES);
bodyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
bodyMesh.count = 0;
scene.add(bodyMesh);

// Trail lines — still per-body (thin geometry, cheap)
const trailLines = new Map(); // bodyId → THREE.Line

function getOrCreateTrail(id, colorHex) {
  if (trailLines.has(id)) return trailLines.get(id);
  const geo  = new THREE.BufferGeometry();
  const mat  = new THREE.LineBasicMaterial({
    color: new THREE.Color(colorHex),
    transparent: true,
    opacity: 0.4,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  trailLines.set(id, line);
  return line;
}

function removeTrail(id) {
  const line = trailLines.get(id);
  if (!line) return;
  scene.remove(line);
  line.geometry.dispose();
  line.material.dispose();
  trailLines.delete(id);
}

// ============================================================
// Black hole visuals
// ============================================================

let bhGroup  = null;
let diskMat  = null;   // shader material ref for time updates

const DISK_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DISK_FRAG = `
  uniform float time;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    vec2 c  = vUv - 0.5;
    float r = length(c) * 2.0;
    if (r < 0.18 || r > 1.0) { gl_FragColor = vec4(0.0); return; }

    float angle  = atan(c.y, c.x);
    float swirl  = sin(angle * 5.0 - r * 6.0 + time * 1.8) * 0.5 + 0.5;
    float swirl2 = sin(angle * 9.0 + r * 4.0 - time * 2.5) * 0.5 + 0.5;
    float heat   = swirl * 0.6 + swirl2 * 0.4;

    // Fade in from inner edge, fade out at outer edge
    float fade = smoothstep(0.18, 0.35, r) * smoothstep(1.0, 0.55, r);

    // Color: white-hot core → orange → deep red rim
    vec3 col = mix(vec3(1.0, 0.95, 0.7), vec3(1.0, 0.45, 0.05), r * 1.2);
    col       = mix(col, vec3(0.6, 0.1, 0.0), smoothstep(0.6, 1.0, r));

    float alpha = fade * (0.5 + heat * 0.5) * 0.9;
    gl_FragColor = vec4(col * (0.8 + heat * 0.6), alpha);
  }
`;

function updateBHVisual(bh) {
  if (!bh) {
    if (bhGroup) { scene.remove(bhGroup); bhGroup = null; diskMat = null; }
    return;
  }

  if (!bhGroup) {
    bhGroup = new THREE.Group();

    // Dark event horizon core
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 24),
      new THREE.MeshStandardMaterial({ color: 0x050508, roughness: 1, metalness: 0 })
    );
    core.name = 'core';
    bhGroup.add(core);

    // Subtle photon-ring halo (backside sphere)
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 24),
      new THREE.MeshStandardMaterial({
        color: 0xffd580, emissive: 0xffd580, emissiveIntensity: 0.6,
        transparent: true, opacity: 0.08, side: THREE.BackSide,
      })
    );
    halo.name = 'halo';
    bhGroup.add(halo);

    // Accretion disk (animated shader)
    diskMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 } },
      vertexShader:   DISK_VERT,
      fragmentShader: DISK_FRAG,
      transparent: true,
      blending:    THREE.AdditiveBlending,
      depthWrite:  false,
      side:        THREE.DoubleSide,
    });
    const disk = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), diskMat);
    disk.name     = 'disk';
    disk.rotation.x = Math.PI * 0.5;  // horizontal
    disk.rotation.z = Math.PI * 0.12; // slight tilt — looks more dynamic
    bhGroup.add(disk);

    // Outer volumetric glow (large additive sphere)
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xff8800,
      transparent: true,
      opacity: 0.04,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
    });
    const glowSphere = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), glowMat);
    glowSphere.name = 'glow';
    bhGroup.add(glowSphere);

    scene.add(bhGroup);
  }

  bhGroup.position.set(...bh.pos);
  bhGroup.getObjectByName('core').scale.setScalar(bh.radius);
  bhGroup.getObjectByName('halo').scale.setScalar(bh.ring_radius * 1.1);

  const diskScale = bh.glow_radius * 2.2;
  bhGroup.getObjectByName('disk').scale.set(diskScale, diskScale, diskScale);
  bhGroup.getObjectByName('glow').scale.setScalar(bh.glow_radius * 4.0);
}

// ============================================================
// Photon trail lines
// ============================================================

const photonLines = new Map();

function getOrCreatePhoton(id) {
  if (photonLines.has(id)) return photonLines.get(id);
  const geo  = new THREE.BufferGeometry();
  const mat  = new THREE.LineBasicMaterial({
    color: 0x00ffee, transparent: true, opacity: 0.75,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  photonLines.set(id, line);
  return line;
}

function removePhotonLine(id) {
  const line = photonLines.get(id);
  if (!line) return;
  scene.remove(line);
  line.geometry.dispose();
  line.material.dispose();
  photonLines.delete(id);
}

// ============================================================
// Click-to-select via Raycaster on InstancedMesh
// ============================================================

const raycaster = new THREE.Raycaster();
const pointer   = new THREE.Vector2();

canvas.addEventListener('click', (e) => {
  if (!lastState) return;
  const rect = canvas.getBoundingClientRect();
  pointer.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  pointer.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(bodyMesh);
  if (hits.length > 0) {
    sendWS({ action: 'set_selected', index: hits[0].instanceId });
  }
});

// ============================================================
// Resize
// ============================================================

function onResize() {
  const wrap = document.getElementById('canvas-wrap');
  const w = wrap.clientWidth, h = wrap.clientHeight;
  renderer.setSize(w, h);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  bloomPass.resolution.set(w, h);
}
window.addEventListener('resize', onResize);
onResize();

// ============================================================
// HUD
// ============================================================

const hudTime   = document.getElementById('hud-time');
const hudBodies = document.getElementById('hud-bodies');
const hudEnergy = document.getElementById('hud-energy');
const hudSel    = document.getElementById('hud-selected');
const hudStatus = document.getElementById('hud-status');
const selInfo   = document.getElementById('sel-info');

function updateHUD(state) {
  hudTime.textContent   = `t = ${state.t.toFixed(3)} yr`;
  hudBodies.textContent = `Bodies: ${state.body_count}`;
  hudEnergy.textContent = `E = ${state.energy.toExponential(2)}`;

  hudStatus.textContent = state.running ? 'RUNNING' : 'PAUSED';
  hudStatus.className   = state.running ? 'status-running' : 'status-paused';

  const idx = state.selected_index;
  if (idx !== null && idx < state.bodies.length) {
    const b   = state.bodies[idx];
    const spd = Math.hypot(...b.vel).toFixed(3);
    selInfo.innerHTML =
      `id=${b.id} &nbsp; m=${b.mass.toFixed(2)}<br>` +
      `vx=${b.vel[0].toFixed(3)} vy=${b.vel[1].toFixed(3)} vz=${b.vel[2].toFixed(3)}<br>` +
      `speed=${spd}`;
    hudSel.textContent = `Selected: #${idx}`;
  } else {
    selInfo.textContent = '—';
    hudSel.textContent  = '';
  }

  const rec = state.recorder;
  const recStatus = document.getElementById('rec-status');
  recStatus.textContent = rec.recording
    ? `● REC — ${rec.record_count} rows` : `Idle — ${rec.record_count} rows`;
  recStatus.style.color = rec.recording ? '#ff5252' : '';

  document.getElementById('btn-rec').textContent  = rec.recording ? 'Stop Rec' : 'Start Rec';
  document.getElementById('btn-bh').textContent   = state.central_on ? 'Disable BH' : 'Enable BH';
  document.getElementById('btn-photons').textContent = state.photons_on ? 'Disable Photons' : 'Enable Photons';
  document.getElementById('btn-run').textContent  = state.running ? 'Pause' : 'Run';
}

// ============================================================
// Chart.js
// ============================================================

const CHART_MAX = 200;

const chartBase = {
  animation: false,
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { labels: { color: '#7a8aaa', font: { size: 10 }, boxWidth: 12 } } },
  scales: {
    x: { display: false },
    y: { ticks: { color: '#7a8aaa', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
  },
};

const energyChart = new Chart(document.getElementById('chart-energy'), {
  type: 'line',
  data: {
    labels: [],
    datasets: [
      { label: 'Energy',  data: [], borderColor: '#f5c518', borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.3 },
      { label: 'Bodies',  data: [], borderColor: '#00b4e8', borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.3, yAxisID: 'yb' },
    ],
  },
  options: {
    ...chartBase,
    scales: {
      ...chartBase.scales,
      yb: { position: 'right', ticks: { color: '#00b4e8', font: { size: 9 } }, grid: { drawOnChartArea: false } },
    },
  },
});

const velChart = new Chart(document.getElementById('chart-vel'), {
  type: 'line',
  data: {
    labels: [],
    datasets: [
      { label: 'vx', data: [], borderColor: '#ff5252', borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.3 },
      { label: 'vy', data: [], borderColor: '#4caf50', borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.3 },
      { label: 'vz', data: [], borderColor: '#5588ff', borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.3 },
    ],
  },
  options: chartBase,
});

let chartTick = 0, prevSelected = null;

function pushChart(chart, label, ...vals) {
  chart.data.labels.push(label);
  vals.forEach((v, i) => chart.data.datasets[i].data.push(v));
  if (chart.data.labels.length > CHART_MAX) {
    chart.data.labels.shift();
    chart.data.datasets.forEach(ds => ds.data.shift());
  }
  chart.update('none');
}

function updateCharts(state) {
  if (++chartTick % 3 !== 0) return;
  const t = state.t.toFixed(3);
  pushChart(energyChart, t, state.energy, state.body_count);

  const idx = state.selected_index;
  if (idx !== null && idx < state.bodies.length) {
    if (prevSelected !== idx) {
      velChart.data.labels = [];
      velChart.data.datasets.forEach(ds => ds.data = []);
      prevSelected = idx;
    }
    const b = state.bodies[idx];
    pushChart(velChart, t, b.vel[0], b.vel[1], b.vel[2]);
  }
}

// ============================================================
// Main state handler
// ============================================================

function onState(state) {
  lastState = state;

  // ── Bodies (instanced) ──────────────────────────────────
  const liveIds = new Set(state.bodies.map(b => b.id));

  // Remove trails for dead bodies
  for (const id of trailLines.keys()) {
    if (!liveIds.has(id)) removeTrail(id);
  }

  // Update instanced mesh
  const n = Math.min(state.bodies.length, MAX_BODIES);
  bodyMesh.count = n;

  state.bodies.slice(0, n).forEach((b, i) => {
    _dummy.position.set(...b.pos);
    _dummy.scale.setScalar(b.radius);
    _dummy.updateMatrix();
    bodyMesh.setMatrixAt(i, _dummy.matrix);
    bodyMesh.setColorAt(i, _color.set(b.color));

    // Trail line
    if (b.trail.length >= 2) {
      const pts  = b.trail.map(p => new THREE.Vector3(...p));
      const line = getOrCreateTrail(b.id, b.color);
      line.geometry.setFromPoints(pts);
    }
  });

  bodyMesh.instanceMatrix.needsUpdate = true;
  if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;

  // ── Black hole ──────────────────────────────────────────
  updateBHVisual(state.black_hole);

  // ── Photons ─────────────────────────────────────────────
  const livePIds = new Set(state.photons.map(p => p.id));
  for (const id of photonLines.keys()) {
    if (!livePIds.has(id)) removePhotonLine(id);
  }
  for (const p of state.photons) {
    if (p.trail.length >= 2) {
      const pts  = p.trail.map(pt => new THREE.Vector3(...pt));
      const line = getOrCreatePhoton(p.id);
      line.geometry.setFromPoints(pts);
    }
  }

  updateHUD(state);
  updateCharts(state);
}

// ============================================================
// Render loop
// ============================================================

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();

  controls.update();

  // Animate accretion disk
  if (diskMat) diskMat.uniforms.time.value = t;

  // Slowly rotate the BH group so the disk has a slight wobble
  if (bhGroup) bhGroup.rotation.y = t * 0.04;

  composer.render();   // bloom-aware render instead of renderer.render()
}

animate();

// ============================================================
// Control panel wiring
// ============================================================

document.querySelectorAll('button[data-action]').forEach(btn => {
  btn.addEventListener('click', () => control(btn.dataset.action));
});

document.getElementById('btn-flashlight').addEventListener('click', () => {
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  sendWS({
    action: 'spawn_photons',
    camera_pos: camera.position.toArray(),
    camera_dir: fwd.toArray(),
  });
});

function wireSlider(id, valId, action, fmt = v => v.toFixed(4)) {
  const sl = document.getElementById(id);
  const vl = document.getElementById(valId);
  if (!sl) return;
  sl.addEventListener('input', () => {
    const v = parseFloat(sl.value);
    vl.textContent = fmt(v);
    control(action, v);
  });
}

wireSlider('sl-dt',     'val-dt',     'set_dt',              v => v.toFixed(4));
wireSlider('sl-N',      'val-N',      'set_N',               v => v.toFixed(0));
wireSlider('sl-spawn',  'val-spawn',  'set_spawn_radius',    v => v.toFixed(1));
wireSlider('sl-mmin',   'val-mmin',   'set_mass_min',        v => v.toFixed(1));
wireSlider('sl-mmax',   'val-mmax',   'set_mass_max',        v => v.toFixed(1));
wireSlider('sl-vfac',   'val-vfac',   'set_vel_factor',      v => v.toFixed(2));
wireSlider('sl-bhmass', 'val-bhmass', 'set_bh_mass',         v => v.toFixed(0));
wireSlider('sl-sample', 'val-sample', 'set_sample_interval', v => v.toFixed(0));

document.getElementById('btn-csv').addEventListener('click', () => control('save_csv'));

// ============================================================
// Connect
// ============================================================

connectWS();

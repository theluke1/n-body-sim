/**
 * N-Body Sim — Frontend
 * Three.js 3-D renderer + WebSocket client + Chart.js plots
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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
    if (msg.type === 'state') onState(msg.data);
  };
  ws.onclose = () => {
    console.warn('[WS] disconnected — retrying in 2 s');
    setTimeout(connectWS, 2000);
  };
  ws.onerror = (err) => console.error('[WS] error', err);
}

function sendWS(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ============================================================
// REST helpers
// ============================================================

async function control(action, value = 0) {
  const res = await fetch('/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, value }),
  });
  return res.json();
}

// ============================================================
// Three.js scene
// ============================================================

const canvas = document.getElementById('sim-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x000000);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 2000);
camera.position.set(0, 0, 30);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1;
controls.maxDistance = 500;

// Ambient + directional light
scene.add(new THREE.AmbientLight(0x223344, 2));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(30, 40, 20);
scene.add(sun);

// ── Body meshes ──────────────────────────────────────────────

// Map from body id → {mesh, trailLine, color}
const bodyMeshes = new Map();

const sphereGeo = new THREE.SphereGeometry(1, 16, 12);

function hexToColor(hex) {
  return new THREE.Color(hex);
}

function getOrCreateBody(id, colorHex) {
  if (bodyMeshes.has(id)) return bodyMeshes.get(id);

  const mat = new THREE.MeshStandardMaterial({
    color: hexToColor(colorHex),
    emissive: hexToColor(colorHex),
    emissiveIntensity: 0.25,
    roughness: 0.4,
    metalness: 0.2,
  });
  const mesh = new THREE.Mesh(sphereGeo, mat);
  scene.add(mesh);

  // Trail line
  const trailGeo = new THREE.BufferGeometry();
  const trailMat = new THREE.LineBasicMaterial({
    color: hexToColor(colorHex),
    transparent: true,
    opacity: 0.35,
  });
  const trailLine = new THREE.Line(trailGeo, trailMat);
  scene.add(trailLine);

  const entry = { mesh, trailLine, color: colorHex };
  bodyMeshes.set(id, entry);
  return entry;
}

function removeBodyMesh(id) {
  const entry = bodyMeshes.get(id);
  if (!entry) return;
  scene.remove(entry.mesh);
  entry.mesh.geometry.dispose();
  entry.mesh.material.dispose();
  scene.remove(entry.trailLine);
  entry.trailLine.geometry.dispose();
  entry.trailLine.material.dispose();
  bodyMeshes.delete(id);
}

// ── Photon trail lines ──────────────────────────────────────

const photonLines = new Map(); // photon id → Line

function getOrCreatePhoton(id) {
  if (photonLines.has(id)) return photonLines.get(id);
  const geo = new THREE.BufferGeometry();
  const mat = new THREE.LineBasicMaterial({
    color: 0x00ffff, transparent: true, opacity: 0.7,
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

// ── Black hole visuals ──────────────────────────────────────

let bhGroup = null;

function updateBHVisual(bh) {
  if (!bh) {
    if (bhGroup) { scene.remove(bhGroup); bhGroup = null; }
    return;
  }

  if (!bhGroup) {
    bhGroup = new THREE.Group();

    // Shadow sphere
    const shadow = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 24),
      new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 1, metalness: 0 })
    );
    shadow.name = 'shadow';
    bhGroup.add(shadow);

    // Photon ring
    const ring = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 24),
      new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, side: THREE.BackSide })
    );
    ring.name = 'ring';
    bhGroup.add(ring);

    // Accretion glow (additive sprite)
    const glowTex = buildGlowTexture();
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xffaa00,
      transparent: true, opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    glow.name = 'glow';
    bhGroup.add(glow);

    scene.add(bhGroup);
  }

  bhGroup.position.set(...bh.pos);
  bhGroup.getObjectByName('shadow').scale.setScalar(bh.radius);
  bhGroup.getObjectByName('ring').scale.setScalar(bh.ring_radius);
  const glowSize = bh.glow_radius * 3.5;
  bhGroup.getObjectByName('glow').scale.set(glowSize, glowSize, 1);
}

function buildGlowTexture() {
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const grad = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  grad.addColorStop(0.0, 'rgba(255,160,0,1)');
  grad.addColorStop(0.4, 'rgba(255,80,0,0.5)');
  grad.addColorStop(1.0, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(cv);
}

// ── Selection highlight ─────────────────────────────────────

let selectedId = null;

function setSelectedHighlight(id) {
  // Reset previous
  if (selectedId !== null) {
    const prev = bodyMeshes.get(selectedId);
    if (prev) prev.mesh.material.emissiveIntensity = 0.25;
  }
  selectedId = id;
  if (id !== null) {
    const cur = bodyMeshes.get(id);
    if (cur) cur.mesh.material.emissiveIntensity = 1.5;
  }
}

// ── Raycaster for click-to-select ───────────────────────────

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  pointer.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  pointer.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const meshList = [...bodyMeshes.values()].map(e => e.mesh);
  const hits = raycaster.intersectObjects(meshList);
  if (hits.length > 0) {
    const hitMesh = hits[0].object;
    for (const [id, entry] of bodyMeshes) {
      if (entry.mesh === hitMesh) {
        // Find index in lastState
        if (lastState) {
          const idx = lastState.bodies.findIndex(b => b.id === id);
          if (idx >= 0) {
            sendWS({ action: 'set_selected', index: idx });
            setSelectedHighlight(id);
          }
        }
        break;
      }
    }
  }
});

// ============================================================
// Resize handler
// ============================================================

function onResize() {
  const wrap = document.getElementById('canvas-wrap');
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

window.addEventListener('resize', onResize);
onResize();

// ============================================================
// HUD
// ============================================================

const hudTime    = document.getElementById('hud-time');
const hudBodies  = document.getElementById('hud-bodies');
const hudEnergy  = document.getElementById('hud-energy');
const hudSel     = document.getElementById('hud-selected');
const hudStatus  = document.getElementById('hud-status');
const selInfo    = document.getElementById('sel-info');

function updateHUD(state) {
  hudTime.textContent   = `t = ${state.t.toFixed(3)} yr`;
  hudBodies.textContent = `Bodies: ${state.body_count}`;
  hudEnergy.textContent = `E = ${state.energy.toExponential(2)}`;

  if (state.running) {
    hudStatus.textContent = 'RUNNING';
    hudStatus.className = 'status-running';
  } else {
    hudStatus.textContent = 'PAUSED';
    hudStatus.className = 'status-paused';
  }

  // Selected body info
  const idx = state.selected_index;
  if (idx !== null && idx < state.bodies.length) {
    const b = state.bodies[idx];
    const spd = Math.hypot(...b.vel).toFixed(3);
    selInfo.innerHTML =
      `id=${b.id} &nbsp; m=${b.mass.toFixed(2)}<br>` +
      `vx=${b.vel[0].toFixed(3)} vy=${b.vel[1].toFixed(3)} vz=${b.vel[2].toFixed(3)}<br>` +
      `speed=${spd}`;
    hudSel.textContent = `Selected: #${idx}`;
    setSelectedHighlight(b.id);
  } else {
    selInfo.textContent = '—';
    hudSel.textContent = '';
  }

  // Recording status
  const rec = state.recorder;
  const recStatus = document.getElementById('rec-status');
  if (rec.recording) {
    recStatus.textContent = `● REC — ${rec.record_count} rows`;
    recStatus.style.color = '#ff5252';
  } else {
    recStatus.textContent = `Idle — ${rec.record_count} rows`;
    recStatus.style.color = '';
  }
  document.getElementById('btn-rec').textContent =
    rec.recording ? 'Stop Rec' : 'Start Rec';

  // BH button label
  document.getElementById('btn-bh').textContent =
    state.central_on ? 'Disable BH' : 'Enable BH';
  document.getElementById('btn-photons').textContent =
    state.photons_on ? 'Disable Photons' : 'Enable Photons';
  document.getElementById('btn-run').textContent =
    state.running ? 'Pause' : 'Run';
}

// ============================================================
// Chart.js
// ============================================================

const CHART_MAX_POINTS = 200;
const chartDefaults = {
  animation: false,
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { labels: { color: '#7a8aaa', font: { size: 10 } } } },
  scales: {
    x: { display: false },
    y: {
      ticks: { color: '#7a8aaa', font: { size: 9 } },
      grid:  { color: 'rgba(255,255,255,0.05)' },
    },
  },
};

const energyChart = new Chart(document.getElementById('chart-energy'), {
  type: 'line',
  data: {
    labels: [],
    datasets: [
      {
        label: 'Energy',
        data: [], borderColor: '#f5c518', borderWidth: 1.5,
        pointRadius: 0, fill: false, tension: 0.3,
      },
      {
        label: 'Bodies',
        data: [], borderColor: '#00b4e8', borderWidth: 1.5,
        pointRadius: 0, fill: false, tension: 0.3,
        yAxisID: 'yb',
      },
    ],
  },
  options: {
    ...chartDefaults,
    scales: {
      ...chartDefaults.scales,
      yb: {
        position: 'right',
        ticks: { color: '#00b4e8', font: { size: 9 } },
        grid: { drawOnChartArea: false },
      },
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
  options: chartDefaults,
});

let chartPrevSelected = null;

function pushData(chart, label, ...values) {
  chart.data.labels.push(label);
  values.forEach((v, i) => chart.data.datasets[i].data.push(v));
  if (chart.data.labels.length > CHART_MAX_POINTS) {
    chart.data.labels.shift();
    chart.data.datasets.forEach(ds => ds.data.shift());
  }
  chart.update('none');
}

let chartFrameCount = 0;

function updateCharts(state) {
  chartFrameCount++;
  if (chartFrameCount % 3 !== 0) return; // throttle to ~10 updates/sec

  const t = state.t.toFixed(3);
  pushData(energyChart, t, state.energy, state.body_count);

  const idx = state.selected_index;
  if (idx !== null && idx < state.bodies.length) {
    const b = state.bodies[idx];

    // Clear on selection change
    if (chartPrevSelected !== idx) {
      velChart.data.labels = [];
      velChart.data.datasets.forEach(ds => ds.data = []);
      chartPrevSelected = idx;
    }

    pushData(velChart, t, b.vel[0], b.vel[1], b.vel[2]);
  }
}

// ============================================================
// Main state handler — called on every WS message
// ============================================================

function onState(state) {
  lastState = state;

  // ── Bodies ──
  const liveIds = new Set(state.bodies.map(b => b.id));

  // Remove gone bodies
  for (const id of bodyMeshes.keys()) {
    if (!liveIds.has(id)) removeBodyMesh(id);
  }

  // Update / create
  for (const b of state.bodies) {
    const entry = getOrCreateBody(b.id, b.color);
    entry.mesh.position.set(...b.pos);
    entry.mesh.scale.setScalar(b.radius);
    entry.mesh.material.opacity = b.opacity;
    entry.mesh.material.transparent = b.opacity < 1;

    // Trail
    if (b.trail.length >= 2) {
      const pts = b.trail.map(p => new THREE.Vector3(...p));
      entry.trailLine.geometry.setFromPoints(pts);
    }
  }

  // ── Black hole ──
  updateBHVisual(state.black_hole);

  // ── Photons ──
  const livePIds = new Set(state.photons.map(p => p.id));
  for (const id of photonLines.keys()) {
    if (!livePIds.has(id)) removePhotonLine(id);
  }
  for (const p of state.photons) {
    const line = getOrCreatePhoton(p.id);
    if (p.trail.length >= 2) {
      const pts = p.trail.map(pt => new THREE.Vector3(...pt));
      line.geometry.setFromPoints(pts);
    }
  }

  updateHUD(state);
  updateCharts(state);
}

// ============================================================
// Render loop
// ============================================================

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// ============================================================
// Control panel wiring
// ============================================================

// Generic buttons with data-action
document.querySelectorAll('button[data-action]').forEach(btn => {
  btn.addEventListener('click', () => control(btn.dataset.action));
});

// Flashlight button (needs camera direction)
document.getElementById('btn-flashlight').addEventListener('click', () => {
  const camPos = camera.position.toArray();
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  sendWS({ action: 'spawn_photons', camera_pos: camPos, camera_dir: fwd.toArray() });
});

// Sliders
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

// ── Save CSV — show filename in console ──
document.getElementById('btn-csv').addEventListener('click', async () => {
  const result = await control('save_csv');
  if (result.filename) {
    console.log('[CSV] saved:', result.filename);
    document.getElementById('rec-status').textContent =
      `Saved: ${result.filename.split(/[\\/]/).pop()}`;
  }
});

// ============================================================
// Connect
// ============================================================

connectWS();

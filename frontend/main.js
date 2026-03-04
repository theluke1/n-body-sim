/* global Chart */
/**
 * N-Body Sim — Frontend
 * Three.js renderer + WebSocket client + Chart.js data panel
 */

import * as THREE from 'three';
import { OrbitControls }   from 'three/addons/controls/OrbitControls.js';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }      from 'three/addons/postprocessing/OutputPass.js';

// ============================================================
// WebSocket
// ============================================================

const WS_URL = `ws://${location.host}/ws`;
let ws = null;
let lastState = null;

function connectWS() {
  ws = new WebSocket(WS_URL);
  ws.onopen    = () => console.log('[WS] connected');
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'state')     onState(msg.data);
    if (msg.type === 'csv_saved') {
      document.getElementById('rec-status').textContent =
        `Saved: ${msg.filename.split(/[\\/]/).pop()}`;
    }
  };
  ws.onclose = () => setTimeout(connectWS, 2000);
  ws.onerror = (err) => console.error('[WS]', err);
}

function sendWS(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function control(action, value = 0) { sendWS({ action, value }); }

// ============================================================
// Three.js setup
// ============================================================

const canvas = document.getElementById('sim-canvas');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 2000);
camera.position.set(0, 12, 28);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.minDistance   = 1;
controls.maxDistance   = 500;

scene.add(new THREE.AmbientLight(0x111827, 3));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
keyLight.position.set(30, 40, 20);
scene.add(keyLight);

// ── Post-processing ──────────────────────────────────────────

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  1.2, 0.5, 0.2
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// ── Starfield ────────────────────────────────────────────────

(function buildStarfield() {
  const N = 3500;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const sz  = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    const r     = 300 + Math.random() * 400;
    pos[i*3]   = r * Math.sin(phi) * Math.cos(theta);
    pos[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
    pos[i*3+2] = r * Math.cos(phi);
    const w = Math.random();
    col[i*3] = 0.7 + w*0.3; col[i*3+1] = 0.8 + w*0.1; col[i*3+2] = 1.0;
    sz[i] = 0.4 + Math.random() * 1.2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
  geo.setAttribute('size',     new THREE.BufferAttribute(sz,  1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: `
      attribute float size; attribute vec3 color; varying vec3 vCol;
      void main() {
        vCol = color;
        vec4 mv = modelViewMatrix * vec4(position,1.0);
        gl_PointSize = size*(300.0/-mv.z);
        gl_Position  = projectionMatrix*mv;
      }`,
    fragmentShader: `
      varying vec3 vCol;
      void main() {
        float d = length(gl_PointCoord-0.5)*2.0;
        if(d>1.0) discard;
        gl_FragColor = vec4(vCol, smoothstep(1.0,0.2,d));
      }`,
    transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, vertexColors: true,
  });
  scene.add(new THREE.Points(geo, mat));
})();

// ── Instanced body mesh ──────────────────────────────────────

const MAX_BODIES = 50;
const _dummy = new THREE.Object3D();
const _color = new THREE.Color();

const bodyMesh = new THREE.InstancedMesh(
  new THREE.SphereGeometry(1, 14, 10),
  new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.1 }),
  MAX_BODIES
);
bodyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
bodyMesh.count = 0;
scene.add(bodyMesh);

// Trail lines per body
const trailLines = new Map();

function getOrCreateTrail(id, colorHex) {
  if (trailLines.has(id)) return trailLines.get(id);
  const line = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({
      color: new THREE.Color(colorHex),
      transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  scene.add(line);
  trailLines.set(id, line);
  return line;
}

function removeTrail(id) {
  const l = trailLines.get(id);
  if (!l) return;
  scene.remove(l); l.geometry.dispose(); l.material.dispose();
  trailLines.delete(id);
}

// ── Black hole ───────────────────────────────────────────────

let bhGroup = null, diskMat = null;

const DISK_VERT = `varying vec2 vUv;
void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;

const DISK_FRAG = `uniform float time; varying vec2 vUv;
void main(){
  vec2 c=vUv-0.5; float r=length(c)*2.0;
  if(r<0.18||r>1.0){ gl_FragColor=vec4(0.0); return; }
  float a=atan(c.y,c.x);
  float s1=sin(a*5.0-r*6.0+time*1.8)*0.5+0.5;
  float s2=sin(a*9.0+r*4.0-time*2.5)*0.5+0.5;
  float heat=s1*0.6+s2*0.4;
  float fade=smoothstep(0.18,0.35,r)*smoothstep(1.0,0.55,r);
  vec3 col=mix(vec3(1.0,0.95,0.7),vec3(1.0,0.45,0.05),r*1.2);
  col=mix(col,vec3(0.6,0.1,0.0),smoothstep(0.6,1.0,r));
  gl_FragColor=vec4(col*(0.8+heat*0.6), fade*(0.5+heat*0.5)*0.9);
}`;

function updateBHVisual(bh) {
  if (!bh) { if (bhGroup) { scene.remove(bhGroup); bhGroup = null; diskMat = null; } return; }
  if (!bhGroup) {
    bhGroup = new THREE.Group();

    const core = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 24),
      new THREE.MeshStandardMaterial({ color: 0x050508, roughness: 1 })
    );
    core.name = 'core'; bhGroup.add(core);

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 24),
      new THREE.MeshStandardMaterial({
        color: 0xffd580, emissive: 0xffd580, emissiveIntensity: 0.6,
        transparent: true, opacity: 0.08, side: THREE.BackSide,
      })
    );
    halo.name = 'halo'; bhGroup.add(halo);

    diskMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 } },
      vertexShader: DISK_VERT, fragmentShader: DISK_FRAG,
      transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const disk = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), diskMat);
    disk.name = 'disk'; disk.rotation.x = Math.PI * 0.5; disk.rotation.z = Math.PI * 0.12;
    bhGroup.add(disk);

    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0xff8800, transparent: true, opacity: 0.04,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
      })
    );
    glow.name = 'glow'; bhGroup.add(glow);
    scene.add(bhGroup);
  }
  bhGroup.position.set(...bh.pos);
  bhGroup.getObjectByName('core').scale.setScalar(bh.radius);
  bhGroup.getObjectByName('halo').scale.setScalar(bh.ring_radius * 1.1);
  const ds = bh.glow_radius * 2.2;
  bhGroup.getObjectByName('disk').scale.set(ds, ds, ds);
  bhGroup.getObjectByName('glow').scale.setScalar(bh.glow_radius * 4.0);
}

// ── Photon trails ────────────────────────────────────────────

const photonLines = new Map();

function getOrCreatePhoton(id) {
  if (photonLines.has(id)) return photonLines.get(id);
  const line = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({
      color: 0x00ffee, transparent: true, opacity: 0.75,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  scene.add(line); photonLines.set(id, line); return line;
}

function removePhotonLine(id) {
  const l = photonLines.get(id);
  if (!l) return;
  scene.remove(l); l.geometry.dispose(); l.material.dispose(); photonLines.delete(id);
}

// ── Raycaster ────────────────────────────────────────────────

const raycaster = new THREE.Raycaster();
const pointer   = new THREE.Vector2();

canvas.addEventListener('click', (e) => {
  if (!lastState) return;
  const rect = canvas.getBoundingClientRect();
  pointer.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  pointer.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(bodyMesh);
  if (hits.length > 0) sendWS({ action: 'set_selected', index: hits[0].instanceId });
});

// ── Resize ───────────────────────────────────────────────────

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
// Side panel — tab toggle logic
// ============================================================

let activeSideTab = null;

function openSideTab(tab) {
  const panel = document.getElementById('side-panel');
  if (activeSideTab === tab) {
    // Clicking the active tab closes the panel
    panel.classList.remove('open');
    activeSideTab = null;
    document.querySelectorAll('.tab-icon').forEach(b => b.classList.remove('active'));
    return;
  }
  activeSideTab = tab;
  panel.classList.add('open');

  // Highlight the right strip icon
  document.querySelectorAll('.tab-icon').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-btn-${tab}`).classList.add('active');

  // Switch inner panel sub-tab
  document.querySelectorAll('.ptab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`ptab-${tab}`).classList.add('active');
  document.querySelectorAll('.ptab').forEach(b => b.classList.remove('active'));
  document.querySelector(`.ptab[data-ptab="${tab}"]`).classList.add('active');
}

document.getElementById('tab-btn-data').addEventListener('click', () => openSideTab('data'));
document.getElementById('tab-btn-rec') .addEventListener('click', () => openSideTab('rec'));
document.getElementById('panel-close') .addEventListener('click', () => {
  document.getElementById('side-panel').classList.remove('open');
  document.querySelectorAll('.tab-icon').forEach(b => b.classList.remove('active'));
  activeSideTab = null;
});

// Inner sub-tab switching
document.querySelectorAll('.ptab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.ptab;
    document.querySelectorAll('.ptab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.ptab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`ptab-${tab}`).classList.add('active');
  });
});

// ============================================================
// HUD
// ============================================================

function updateHUD(state) {
  document.getElementById('hud-time').textContent   = `t = ${state.t.toFixed(3)} yr`;
  document.getElementById('hud-bodies').textContent = `Bodies: ${state.body_count}`;
  document.getElementById('hud-energy').textContent = `E = ${state.energy.toExponential(2)}`;

  const st = document.getElementById('hud-status');
  st.textContent = state.running ? 'RUNNING' : 'PAUSED';
  st.className   = state.running ? 'status-running' : 'status-paused';

  document.getElementById('btn-run').textContent =
    state.running ? 'Pause' : 'Run';
  document.getElementById('btn-bh').textContent =
    state.central_on ? 'Disable BH' : 'Enable BH';
  document.getElementById('btn-photons').textContent =
    state.photons_on ? 'Photons On' : 'Photons Off';

  const rec = state.recorder;
  const recEl = document.getElementById('rec-status');
  if (rec.recording) {
    recEl.textContent = `● REC — ${rec.record_count} rows`;
    recEl.style.color = '#ff5252';
  } else {
    recEl.textContent = `Idle — ${rec.record_count} rows`;
    recEl.style.color = '';
  }
  document.getElementById('btn-rec').textContent =
    rec.recording ? 'Stop Rec' : 'Start Rec';

  // Selected body panel info
  const idx = state.selected_index;
  const selInfo = document.getElementById('sel-info');
  if (idx !== null && idx < state.bodies.length) {
    const b = state.bodies[idx];
    const spd = Math.hypot(...b.vel);
    document.getElementById('hud-selected').textContent = `Selected: #${idx}`;
    selInfo.innerHTML =
      `<span class="cyan">Body #${idx}</span>  id=${b.id}  m=${b.mass.toFixed(2)}<br>` +
      `pos  (${b.pos.map(v=>v.toFixed(2)).join(', ')})<br>` +
      `vel  (${b.vel.map(v=>v.toFixed(3)).join(', ')})<br>` +
      `<span class="gold">speed ${spd.toFixed(3)}</span>`;
  } else {
    document.getElementById('hud-selected').textContent = '';
    selInfo.textContent = 'Click a body to select it';
  }
}

// ============================================================
// Chart.js — 4 data charts in the side panel
// ============================================================

const CHART_MAX = 300;

const _chartDefaults = {
  animation: false,
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { labels: { color: '#7a8aaa', font: { size: 9 }, boxWidth: 10 } } },
  scales: {
    x: { ticks: { color: '#7a8aaa', font: { size: 8 }, maxTicksLimit: 5 },
         grid:  { color: 'rgba(255,255,255,0.04)' } },
    y: { ticks: { color: '#7a8aaa', font: { size: 8 }, maxTicksLimit: 5 },
         grid:  { color: 'rgba(255,255,255,0.04)' } },
  },
};

const _scatterDefaults = {
  ..._chartDefaults,
  scales: {
    x: { ..._chartDefaults.scales.x, title: { display: false } },
    y: { ..._chartDefaults.scales.y, title: { display: false } },
  },
};

// 1. Orbital path (x vs y scatter)
const orbitChart = new Chart(document.getElementById('chart-orbit'), {
  type: 'scatter',
  data: { datasets: [{
    label: 'xy',
    data: [],
    pointRadius: 1.5,
    pointBackgroundColor: '#00b4e8',
    showLine: true,
    borderColor: 'rgba(0,180,232,0.5)',
    borderWidth: 1,
    fill: false,
  }]},
  options: _scatterDefaults,
});

// 2. Phase space (|r| vs speed scatter)
const phaseChart = new Chart(document.getElementById('chart-phase'), {
  type: 'scatter',
  data: { datasets: [{
    label: 'r vs v',
    data: [],
    pointRadius: 1.5,
    pointBackgroundColor: '#c77dff',
    showLine: false,
  }]},
  options: {
    ..._scatterDefaults,
    scales: {
      x: { ..._scatterDefaults.scales.x, title: { display: true, text: 'dist', color: '#7a8aaa', font: { size: 8 } } },
      y: { ..._scatterDefaults.scales.y, title: { display: true, text: 'speed', color: '#7a8aaa', font: { size: 8 } } },
    },
  },
});

// 3. Velocity components (line)
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
  options: _chartDefaults,
});

// 4. Kinetic energy (line)
const keChart = new Chart(document.getElementById('chart-ke'), {
  type: 'line',
  data: {
    labels: [],
    datasets: [{ label: 'KE', data: [], borderColor: '#4caf82', borderWidth: 1.5, pointRadius: 0, fill: true,
      backgroundColor: 'rgba(76,175,130,0.1)', tension: 0.3 }],
  },
  options: _chartDefaults,
});

function clearDataCharts() {
  orbitChart.data.datasets[0].data = [];
  phaseChart.data.datasets[0].data = [];
  velChart.data.labels = []; velChart.data.datasets.forEach(d => d.data = []);
  keChart.data.labels  = []; keChart.data.datasets.forEach(d => d.data = []);
  orbitChart.update('none'); phaseChart.update('none');
  velChart.update('none');   keChart.update('none');
}

let chartTick = 0;
let prevChartSelected = null;

function pushLine(chart, label, ...vals) {
  chart.data.labels.push(label);
  vals.forEach((v, i) => chart.data.datasets[i].data.push(v));
  if (chart.data.labels.length > CHART_MAX) {
    chart.data.labels.shift();
    chart.data.datasets.forEach(d => d.data.shift());
  }
  chart.update('none');
}

function pushScatter(chart, x, y) {
  chart.data.datasets[0].data.push({ x, y });
  if (chart.data.datasets[0].data.length > CHART_MAX)
    chart.data.datasets[0].data.shift();
  chart.update('none');
}

function updateCharts(state) {
  if (++chartTick % 3 !== 0) return;

  const idx = state.selected_index;
  if (idx === null || idx >= state.bodies.length) return;
  const b = state.bodies[idx];

  // Clear on body change
  if (prevChartSelected !== idx) { clearDataCharts(); prevChartSelected = idx; }

  const t     = state.t.toFixed(3);
  const r     = Math.hypot(...b.pos);
  const speed = Math.hypot(...b.vel);
  const ke    = 0.5 * b.mass * speed * speed;

  pushScatter(orbitChart, b.pos[0], b.pos[1]);
  pushScatter(phaseChart, r, speed);
  pushLine(velChart, t, b.vel[0], b.vel[1], b.vel[2]);
  pushLine(keChart,  t, ke);
}

// ============================================================
// Main state handler
// ============================================================

function onState(state) {
  lastState = state;

  // Bodies
  const liveIds = new Set(state.bodies.map(b => b.id));
  for (const id of trailLines.keys()) if (!liveIds.has(id)) removeTrail(id);

  const n = Math.min(state.bodies.length, MAX_BODIES);
  bodyMesh.count = n;

  state.bodies.slice(0, n).forEach((b, i) => {
    _dummy.position.set(...b.pos);
    _dummy.scale.setScalar(b.radius);
    _dummy.updateMatrix();
    bodyMesh.setMatrixAt(i, _dummy.matrix);
    bodyMesh.setColorAt(i, _color.set(b.color));

    if (b.trail.length >= 2) {
      const pts  = b.trail.map(p => new THREE.Vector3(...p));
      getOrCreateTrail(b.id, b.color).geometry.setFromPoints(pts);
    }
  });

  bodyMesh.instanceMatrix.needsUpdate = true;
  if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;

  updateBHVisual(state.black_hole);

  // Photons
  const livePIds = new Set(state.photons.map(p => p.id));
  for (const id of photonLines.keys()) if (!livePIds.has(id)) removePhotonLine(id);
  for (const p of state.photons) {
    if (p.trail.length >= 2)
      getOrCreatePhoton(p.id).geometry.setFromPoints(
        p.trail.map(pt => new THREE.Vector3(...pt))
      );
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
  if (diskMat) diskMat.uniforms.time.value = t;
  if (bhGroup)  bhGroup.rotation.y = t * 0.04;
  composer.render();
}

animate();

// ============================================================
// Control wiring
// ============================================================

// Generic data-action buttons
document.querySelectorAll('button[data-action]').forEach(btn =>
  btn.addEventListener('click', () => control(btn.dataset.action))
);

// Run/Pause (no data-action, needs text update)
document.getElementById('btn-run').addEventListener('click', () => control('toggle_run'));

// Flashlight — fire photons from camera
document.getElementById('btn-flashlight').addEventListener('click', () => {
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  sendWS({
    action: 'spawn_photons',
    camera_pos: camera.position.toArray(),
    camera_dir: fwd.toArray(),
  });
});

// CSV
document.getElementById('btn-csv').addEventListener('click', () => control('save_csv'));

// Sliders
function wireSlider(id, valId, action, fmt) {
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

// ============================================================
// Connect
// ============================================================

connectWS();

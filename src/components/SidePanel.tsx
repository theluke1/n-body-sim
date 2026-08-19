import { useState, useRef, useEffect } from 'react';
import type { UISnap } from '../hooks/useSimulation';
import type { BodyState, SimConfig } from '../types';

interface Props {
  open: boolean;
  snap: UISnap;
  selectedBody: BodyState | null;
  config: SimConfig;
  log: string[];
  onSend: (action: string, value?: number | string) => void;
  onUpdateConfig: (u: Partial<SimConfig>) => void;
}

type Tab = 'telemetry' | 'system' | 'log' | 'rec';

function speed(b: BodyState) {
  const [vx, vy, vz] = b.vel;
  return Math.sqrt(vx * vx + vy * vy + vz * vz);
}

function TabBtn({ id, active, label, onClick }: { id: Tab; active: Tab; label: string; onClick: (t: Tab) => void }) {
  const isActive = id === active;
  return (
    <button onClick={() => onClick(id)} style={{
      background: 'transparent', border: 'none', cursor: 'pointer',
      fontFamily: 'var(--font-mono)', fontSize: 13, letterSpacing: 1.5,
      textTransform: 'uppercase', padding: '8px 12px',
      color: isActive ? 'var(--cyan)' : 'var(--text-dim)',
      borderBottom: `2px solid ${isActive ? 'var(--cyan)' : 'transparent'}`,
      transition: 'color 0.15s, border-color 0.15s',
    }}>
      {label}
    </button>
  );
}

function DataRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-dim)', letterSpacing: 0.8 }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: color ?? 'var(--text-mono)' }}>{value}</span>
    </div>
  );
}

function fmtRadius(v: number) {
  return `${v.toFixed(4)} AU`;
}

// Normalised drift bar: logarithmic so 1e-6 → 1e-2 spans the full width.
// Lets the eye see whether the integrator is "staying on the manifold" at a
// glance, without reading scientific notation. Anchored to the same
// thresholds as driftColor() in HUD.tsx so both widgets agree.
function DriftBar({ drift }: { drift: number }) {
  const logd   = Math.log10(Math.max(drift, 1e-12));
  // Map -8 (excellent) → 0% and -2 (terrible) → 100%
  const pct    = Math.min(100, Math.max(0, ((logd + 8) / 6) * 100));
  const color  = drift < 1e-4 ? 'var(--green)' : drift < 1e-2 ? 'var(--amber)' : 'var(--red)';
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-dim)', letterSpacing: 1 }}>
          |ΔE / E₀|
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color }}>
          {drift.toExponential(2)}
        </span>
      </div>
      <div className="perf-bar-track">
        <div className="perf-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

// Ring-buffer sparkline of |ΔE/E₀| over the last N_HIST samples.
// Log-scale so 1e-8 (excellent) → 1e-1 (broken) all fit in one view.
const N_HIST = 120;
const LOG_MIN = -9; // 1e-9
const LOG_MAX = -1; // 1e-1

function EnergySparkline({ drift }: { drift: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const histRef   = useRef<Float32Array>(new Float32Array(N_HIST).fill(NaN));
  const headRef   = useRef(0);

  // Push new sample
  const idx = headRef.current % N_HIST;
  histRef.current[idx] = drift;
  headRef.current++;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Background grid at 1e-4 (green threshold) and 1e-2 (red threshold)
    const gridAt = (logVal: number, color: string) => {
      const y = H - ((logVal - LOG_MIN) / (LOG_MAX - LOG_MIN)) * H;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    };
    gridAt(-4, '#4caf82');  // 1e-4 green threshold
    gridAt(-2, '#e8a838');  // 1e-2 amber threshold

    // Line
    const buf = histRef.current;
    const head = headRef.current;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < N_HIST; i++) {
      const age = (head - N_HIST + i + N_HIST) % N_HIST;
      const v = buf[age];
      if (!Number.isFinite(v) || v <= 0) { started = false; continue; }
      const logV = Math.max(LOG_MIN, Math.min(LOG_MAX, Math.log10(v)));
      const x = (i / (N_HIST - 1)) * W;
      const y = H - ((logV - LOG_MIN) / (LOG_MAX - LOG_MIN)) * H;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    // Color the line by current trust level
    const color = drift < 1e-4 ? '#4caf82' : drift < 1e-2 ? '#e8a838' : '#e05555';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = 4;
    ctx.stroke();
    ctx.shadowBlur = 0;
  });

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', letterSpacing: 1 }}>
          |ΔE / E₀| history
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: drift < 1e-4 ? 'var(--green)' : drift < 1e-2 ? 'var(--amber)' : 'var(--red)' }}>
          {drift.toExponential(2)}
        </span>
      </div>
      <canvas
        ref={canvasRef}
        width={320} height={48}
        style={{ width: '100%', height: 48, borderRadius: 3, background: 'rgba(0,0,0,0.35)', display: 'block' }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)' }}>older</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)' }}>now</span>
      </div>
    </div>
  );
}

function vecMag(v: [number, number, number]) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function trustMeta(level: string) {
  if (level === 'unreliable') return { label: 'UNRELIABLE', color: 'var(--red)' };
  if (level === 'stress') return { label: 'NUMERICAL STRESS', color: 'var(--amber)' };
  if (level === 'approximate') return { label: 'APPROXIMATE', color: 'var(--purple)' };
  return { label: 'NOMINAL', color: 'var(--green)' };
}

function modeLabel(mode: string) {
  if (mode === 'high_accuracy') return 'HIGH ACCURACY';
  if (mode === 'scientific') return 'SCIENTIFIC';
  return 'REALTIME';
}

export default function SidePanel({ open, snap, selectedBody, config, log, onSend, onUpdateConfig }: Props) {
  const [tab, setTab] = useState<Tab>('telemetry');

  return (
    <div style={{
      position: 'absolute',
      top: 0, right: 42, bottom: 0,
      width: 380,
      background: 'rgba(5,6,14,0.94)',
      backdropFilter: 'blur(14px)',
      borderLeft: '1px solid var(--border)',
      transform: open ? 'translateX(0)' : 'translateX(100%)',
      transition: 'transform 0.22s cubic-bezier(0.4,0,0.2,1)',
      zIndex: 20,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>

      {/* Tab bar */}
      <div style={{
        display: 'flex', alignItems: 'center',
        borderBottom: '1px solid var(--border)',
        minHeight: 48, flexShrink: 0, paddingLeft: 4,
      }}>
        <TabBtn id="telemetry" active={tab} label="TELEM"  onClick={setTab} />
        <TabBtn id="system"    active={tab} label="SYSTEM" onClick={setTab} />
        <TabBtn id="log"       active={tab} label="LOG"    onClick={setTab} />
        <TabBtn id="rec"       active={tab} label="REC"    onClick={setTab} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>

        {/* ── TELEMETRY tab ─────────────────────────────────── */}
        {tab === 'telemetry' && (
          <div>
            {selectedBody ? (
              <>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--cyan)', letterSpacing: 2, marginBottom: 12 }}>
                  ◉ BODY #{selectedBody.id}
                </div>
                <DataRow label="MASS"    value={`${selectedBody.mass.toFixed(4)} M☉`} color="var(--blue-light)" />
                <DataRow label="SPEED"   value={`${speed(selectedBody).toFixed(4)} AU/yr`} color="var(--cyan)" />
                <DataRow label="CHARGE"  value={selectedBody.charge.toFixed(3)} />
                <DataRow label="RADIUS"  value={selectedBody.radius.toFixed(4)} />
                <div style={{ marginTop: 12, marginBottom: 6, fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-dim)', letterSpacing: 2 }}>
                  POSITION (AU)
                </div>
                {['X','Y','Z'].map((ax, i) => (
                  <DataRow key={ax} label={ax} value={selectedBody.pos[i].toFixed(5)} />
                ))}
                <div style={{ marginTop: 12, marginBottom: 6, fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-dim)', letterSpacing: 2 }}>
                  VELOCITY (AU/yr)
                </div>
                {['VX','VY','VZ'].map((ax, i) => (
                  <DataRow key={ax} label={ax} value={selectedBody.vel[i].toFixed(5)} />
                ))}
                <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-dim)', letterSpacing: 2, marginBottom: 8 }}>
                    KINETIC ENERGY
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, color: 'var(--amber)', textShadow: '0 0 10px var(--amber)' }}>
                    {(0.5 * selectedBody.mass * speed(selectedBody) ** 2).toFixed(5)}
                  </div>
                </div>
              </>
            ) : (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', textAlign: 'center', marginTop: 40, lineHeight: 2 }}>
                <div style={{ fontSize: 24, marginBottom: 8 }}>◎</div>
                Click a body to select it
              </div>
            )}
          </div>
        )}

        {/* ── SYSTEM tab ────────────────────────────────────── */}
        {tab === 'system' && (
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-dim)', letterSpacing: 2, marginBottom: 10 }}>
              SIMULATION STATE
            </div>
            <DataRow label="SIM TIME"   value={`${snap.time.toFixed(3)} yr`}        color="var(--cyan)"  />
            <DataRow label="BODIES"     value={String(snap.bodyCount)}               color="var(--text)"  />
            <DataRow label="TOT ENERGY" value={snap.energy.toFixed(6)}               color={snap.energy < 0 ? 'var(--green)' : 'var(--red)'} />
            <DataRow label="STATUS"     value={snap.running ? 'RUNNING' : 'PAUSED'}  color={snap.running ? 'var(--green)' : 'var(--amber)'} />
            <DataRow label="GPU"        value={snap.gpuActive ? 'ACTIVE ⚡' : 'CPU'} color={snap.gpuActive ? 'var(--amber)' : 'var(--text-dim)'} />

            {/* ── Conservation diagnostics (the "trustworthy?" panel) ──
               For an isolated N-body system with a symplectic integrator,
               energy should be bounded and linear + angular momentum should
               be exactly conserved (to numerical precision). Drift > 1e-2
               means the integrator couldn't resolve a close encounter —
               either lower η, lower dt, or increase softening (ε).         */}
            {snap.diagnostics && (
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                {(() => {
                  const trust = trustMeta(snap.diagnostics.trustLevel);
                  return (
                    <>
                      <DataRow label="TRUST LEVEL" value={trust.label} color={trust.color} />
                      <DataRow label="MODE" value={modeLabel(snap.diagnostics.integratorMode)} color="var(--cyan)" />
                      <DataRow
                        label="APPROXIMATION"
                        value={snap.diagnostics.approximationActive ? 'ACTIVE' : 'OFF'}
                        color={snap.diagnostics.approximationActive ? 'var(--purple)' : 'var(--green)'}
                      />
                    </>
                  );
                })()}
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--amber)', letterSpacing: 2, marginBottom: 10 }}>
                  SIMULATION INTEGRITY
                </div>
                <EnergySparkline drift={snap.diagnostics.energyDrift} />
                <DataRow
                  label="E₀"
                  value={snap.diagnostics.energy0 !== null ? snap.diagnostics.energy0.toFixed(6) : '—'}
                  color="var(--text-mono)"
                />
                <DataRow label="MOMENTUM |p|"   value={vecMag(snap.diagnostics.momentum).toExponential(2)} />
                <DataRow label="ANG. MOMENTUM |L|"   value={vecMag(snap.diagnostics.angMomentum).toExponential(2)} />
                <DataRow
                  label="SUBSTEPS"
                  value={`${snap.diagnostics.substeps}${snap.diagnostics.maxSubstepsHit ? ' (cap)' : ''}`}
                  color={snap.diagnostics.maxSubstepsHit ? 'var(--red)' : 'var(--text-mono)'}
                />
                <DataRow
                  label="CLOSEST r_min"
                  value={snap.diagnostics.rmin !== null ? snap.diagnostics.rmin.toFixed(4) : '—'}
                />
                <DataRow
                  label="VIRIAL Q = 2K/|U|"
                  value={snap.diagnostics.virialQ !== null && snap.diagnostics.virialQ !== undefined
                    ? snap.diagnostics.virialQ.toFixed(4)
                    : '—'}
                  color={(() => {
                    const q = snap.diagnostics.virialQ;
                    if (q === null || q === undefined) return 'var(--text-dim)';
                    return Math.abs(q - 1) < 0.1 ? 'var(--green)' : Math.abs(q - 1) < 0.5 ? 'var(--amber)' : 'var(--red)';
                  })()}
                />
                <DataRow label="TEXTBOOK" value="F = Gm₁m₂ / r²" color="var(--text-mono)" />
                <DataRow label="ENERGY" value="E = K + U" color="var(--text-mono)" />
                <DataRow label="ROTATION" value="L = r × p" color="var(--text-mono)" />
              </div>
            )}

            {/* ── Physics configuration ─────────────────────────────── */}
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-dim)', letterSpacing: 2, marginBottom: 10 }}>
                INTEGRATOR
              </div>
              <DataRow label="SCHEME"     value="VELOCITY VERLET + ADAPTIVE SUBSTEP" color="var(--text-mono)" />
              <DataRow label="FORCE"      value="GRAVITY"                            color="var(--cyan)"      />
              <DataRow label="MODE"       value={modeLabel(config.integratorMode)}    color="var(--cyan)"      />
              <DataRow label="dt (outer)" value={config.dt.toFixed(4)}               color="var(--text-mono)" />
              <DataRow label="η (eta)"    value={config.eta.toFixed(3)}              color="var(--text-mono)" />
              <DataRow label="seed"       value={`0x${config.seed.toString(16).toUpperCase()}`} color="var(--text-mono)" />
              <DataRow label="BH MASS"    value={`${config.bhMass} M☉`}              color="var(--purple)"    />

              {snap.blackHole && (
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--purple)', letterSpacing: 2, marginBottom: 10 }}>
                    BLACK HOLE ZONES
                  </div>
                  <DataRow label="EVENT HORIZON" value={fmtRadius(snap.blackHole.event_horizon_radius)} color="var(--amber)" />
                  <DataRow label="PHOTON SPHERE" value={fmtRadius(snap.blackHole.photon_sphere_radius)} color="var(--text-mono)" />
                  <DataRow label="SHADOW (b_cr)" value={fmtRadius(snap.blackHole.shadow_radius)} color="var(--text-mono)" />
                  <DataRow label="LENSING REGION" value={fmtRadius(snap.blackHole.lens_radius)} color="var(--text-mono)" />
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6, marginTop: 6 }}>
                    Bodies are absorbed at the event horizon. The shadow and bent-light region are optical effects outside that boundary.
                  </div>

                  {/* NFW dark matter halo toggle. Gated to Galaxy Core preset initially (DD-003).
                     Toggle mid-simulation to watch the rotation curve change live. */}
                  <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--purple)', letterSpacing: 2, marginBottom: 8 }}>
                      DARK MATTER HALO (NFW)
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <input
                        type="checkbox"
                        id="halo-on"
                        checked={config.haloOn}
                        onChange={e => onUpdateConfig({ haloOn: e.target.checked })}
                        style={{ accentColor: 'var(--purple)', cursor: 'pointer' }}
                      />
                      <label htmlFor="halo-on" style={{
                        fontFamily: 'var(--font-mono)', fontSize: 10,
                        color: config.haloOn ? 'var(--purple)' : 'var(--text-dim)',
                        cursor: 'pointer',
                      }}>
                        NFW halo {config.haloOn ? '● ON — rotation curve flat' : '○ OFF — Keplerian (1/√r)'}
                      </label>
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)', marginLeft: 20 }}>
                      ρ(r) = ρₛ / [(r/rₛ)(1+r/rₛ)²] · NFW 1996/1997
                    </div>
                  </div>

                  {/* Photon spawn mode: cone (random) vs image-plane (systematic b sweep).
                     Image-plane mode reveals the photon sphere — b_cr = 3√3/2 · r_s. */}
                  {snap.photonsOn && (
                    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--cyan)', letterSpacing: 2, marginBottom: 8 }}>
                        PHOTON SPAWN MODE
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          className="mc-btn"
                          style={{
                            fontSize: 9, flex: 1,
                            background: config.photonMode === 'cone' ? 'var(--cyan)' : 'transparent',
                            color: config.photonMode === 'cone' ? 'var(--bg)' : 'var(--cyan)',
                            border: '1px solid var(--cyan)',
                          }}
                          onClick={() => onUpdateConfig({ photonMode: 'cone' })}
                        >
                          CONE
                        </button>
                        <button
                          className="mc-btn"
                          style={{
                            fontSize: 9, flex: 1,
                            background: config.photonMode === 'image_plane' ? 'var(--cyan)' : 'transparent',
                            color: config.photonMode === 'image_plane' ? 'var(--bg)' : 'var(--cyan)',
                            border: '1px solid var(--cyan)',
                          }}
                          onClick={() => onUpdateConfig({ photonMode: 'image_plane' })}
                        >
                          IMAGE PLANE
                        </button>
                      </div>
                      {config.photonMode === 'image_plane' && (
                        <div style={{ marginTop: 8 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-dim)' }}>
                              scan width (× b_cr)
                            </span>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--cyan)' }}>
                              {config.imagePlaneWidth.toFixed(1)}×
                            </span>
                          </div>
                          <input
                            type="range" min={1} max={10} step={0.5}
                            value={config.imagePlaneWidth}
                            style={{ width: '100%', color: 'var(--cyan)' }}
                            onChange={e => onUpdateConfig({ imagePlaneWidth: Number(e.target.value) })}
                          />
                          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)', marginTop: 2 }}>
                            Sweeps b from 0 → {config.imagePlaneWidth.toFixed(1)} × b_cr to reveal photon sphere
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* η slider: lower η = more substeps = tighter conservation,
                 at the cost of wall-clock time. Mirrors Aarseth 2003 §2.4. */}
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-dim)', letterSpacing: 1 }}>η (timestep safety factor)</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--cyan)' }}>{config.eta.toFixed(3)}</span>
                </div>
                <input
                  type="range" min={0.005} max={0.1} step={0.005}
                  value={config.eta}
                  style={{ width: '100%', color: 'var(--cyan)' }}
                  onChange={e => onUpdateConfig({ eta: Number(e.target.value) })}
                />
              </div>

              {/* θ slider: Barnes-Hut opening angle. Controls accuracy/speed tradeoff.
                 At θ=0.7, force error ≈ 1% (Hernquist 1987). Range 0.3–0.9.
                 Accurate / Standard / Fast labels match GADGET-2 conventions. */}
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-dim)', letterSpacing: 1 }}>
                    θ (Barnes-Hut opening angle)
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--cyan)' }}>
                    {config.theta.toFixed(2)}&nbsp;
                    <span style={{ color: 'var(--text-dim)' }}>
                      {config.theta <= 0.4 ? '— Accurate' : config.theta <= 0.75 ? '— Standard' : '— Fast'}
                    </span>
                  </span>
                </div>
                <input
                  type="range" min={0.3} max={0.9} step={0.05}
                  value={config.theta}
                  style={{ width: '100%', color: 'var(--cyan)' }}
                  onChange={e => onUpdateConfig({ theta: Number(e.target.value) })}
                />
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)', marginTop: 2 }}>
                  ~1% force error at θ=0.7 · only applies when N &gt; 120 in realtime mode
                </div>
              </div>

              {/* Virial equilibration: rescale spawn velocities so Q = 2KE/|PE| = 1.
                 Default off — arbitrary Q is physically interesting (collapse, dispersal). */}
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  id="virial-equil"
                  checked={config.virialEquil}
                  onChange={e => onUpdateConfig({ virialEquil: e.target.checked })}
                  style={{ accentColor: 'var(--cyan)', cursor: 'pointer' }}
                />
                <label htmlFor="virial-equil" style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)',
                  cursor: 'pointer', letterSpacing: 0.5,
                }}>
                  Virial equilibrium at spawn (Q = 1)
                </label>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)', marginLeft: 20, marginTop: 2 }}>
                Takes effect on next reset — rescales velocities so 2KE/|PE| = 1
              </div>

              {/* Seed field: any integer is valid; Mulberry32 mixes it well.
                 Hex input for the "0xDEADBEEF vibe" — parsed via parseInt/16. */}
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-dim)', letterSpacing: 1 }}>
                  seed (hex)
                </span>
                <input
                  type="text"
                  defaultValue={config.seed.toString(16).toUpperCase()}
                  onBlur={e => {
                    const v = parseInt(e.target.value, 16);
                    if (Number.isFinite(v) && v >= 0) onUpdateConfig({ seed: v });
                  }}
                  style={{
                    flex: 1, background: 'var(--bg)', border: '1px solid var(--border)',
                    color: 'var(--cyan)', fontFamily: 'var(--font-mono)', fontSize: 10,
                    padding: '3px 6px', borderRadius: 3, minWidth: 0,
                  }}
                />
                <button
                  className="mc-btn mc-btn-cyan"
                  onClick={() => onUpdateConfig({ seed: (Math.random() * 0xFFFFFFFF) >>> 0 })}
                  style={{ fontSize: 9 }}
                >
                  🎲
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── LOG tab ───────────────────────────────────────── */}
        {tab === 'log' && (
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-dim)', letterSpacing: 2, marginBottom: 10 }}>
              EVENT LOG
            </div>
            {log.length === 0 ? (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', marginTop: 20 }}>
                No events yet.
              </div>
            ) : (
              log.map((entry, i) => {
                const isBH    = entry.includes('absorbed by black hole');
                const isMerge = entry.includes('body merge');
                const color   = isBH    ? 'var(--amber)'
                              : isMerge ? 'var(--green)'
                              : i === 0 ? 'var(--cyan)'
                              : 'var(--text-dim)';
                return (
                  <div key={i} style={{
                    fontFamily: 'var(--font-mono)', fontSize: 9,
                    color,
                    padding: '5px 0',
                    borderBottom: '1px solid var(--border)',
                    letterSpacing: 0.5,
                  }}>
                    {entry}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* ── REC tab ───────────────────────────────────────── */}
        {tab === 'rec' && (
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-dim)', letterSpacing: 2, marginBottom: 14 }}>
              RECORDING
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <button className="mc-btn mc-btn-green" onClick={() => onSend('toggle_recording')} style={{ fontSize: 9 }}>
                ⏺ RECORD
              </button>
              <button className="mc-btn mc-btn-cyan" onClick={() => onSend('save_csv')} style={{ fontSize: 9 }}>
                ⬇ CSV
              </button>
            </div>
            <DataRow label="ROWS" value={String(snap.recordCount)} color="var(--cyan)" />
            <div style={{ marginTop: 16 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-dim)', letterSpacing: 2, marginBottom: 8 }}>
                SAMPLE INTERVAL
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="range" min={1} max={120} step={1}
                  value={config.sampleInterval}
                  style={{ color: 'var(--cyan)', width: 140 }}
                  onChange={e => onUpdateConfig({ sampleInterval: Number(e.target.value) })}
                />
                <span className="mc-value" style={{ color: 'var(--cyan)' }}>
                  {config.sampleInterval} frames
                </span>
              </div>
            </div>
            <div style={{ marginTop: 20, padding: 10, background: 'var(--bg)', borderRadius: 4, border: '1px solid var(--border)' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-dim)', letterSpacing: 2, marginBottom: 6 }}>
                STATUS
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: snap.recordCount > 0 ? 'var(--green)' : 'var(--text-dim)' }}>
                {snap.recordCount > 0 ? `● Recording — ${snap.recordCount} rows` : 'Idle — 0 rows'}
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

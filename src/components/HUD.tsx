import type { UISnap } from '../hooks/useSimulation';
import type { BodyState } from '../types';

interface Props {
  snap: UISnap;
  selectedBody: BodyState | null;
}

function speed(b: BodyState) {
  const [vx, vy, vz] = b.vel;
  return Math.sqrt(vx * vx + vy * vy + vz * vz);
}

// Color-code the energy-drift number. Below 1e-4 is "research-grade" for a
// symplectic integrator on a 2-body test; above 1e-2 means something is wrong
// (close encounter not resolved, η too large, or a collision just happened).
function driftColor(d: number) {
  if (d < 1e-4) return 'var(--green)';
  if (d < 1e-2) return 'var(--amber)';
  return 'var(--red)';
}

function vecMag(v: [number, number, number]) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function trustMeta(level: string) {
  if (level === 'unreliable') return { label: 'Unreliable', color: 'var(--red)' };
  if (level === 'stress') return { label: 'Numerical Stress', color: 'var(--amber)' };
  if (level === 'approximate') return { label: 'Approximate', color: 'var(--purple)' };
  return { label: 'Nominal', color: 'var(--green)' };
}

function modeLabel(mode?: string) {
  if (mode === 'high_accuracy') return 'High Accuracy';
  if (mode === 'scientific') return 'Scientific';
  return 'Realtime';
}

function modeDescription(mode?: string, approx?: boolean) {
  if (mode === 'high_accuracy') return 'Strict adaptive substeps for close encounters.';
  if (mode === 'scientific') return 'Exact all-pairs gravity: F = Gm₁m₂ / r².';
  return approx
    ? 'Smooth visual mode. Approximation active above 120 bodies.'
    : 'Smooth visual mode. Approximation may activate above 120 bodies.';
}

function fmtRadius(v: number) {
  return `${v.toFixed(3)} AU`;
}

export default function HUD({ snap, selectedBody }: Props) {
  const { time, energy, bodyCount, running, diagnostics, blackHole } = snap;
  const trust = diagnostics ? trustMeta(diagnostics.trustLevel) : trustMeta('nominal');

  return (
    <div style={{
      position: 'absolute',
      top: 14, left: 14,
      pointerEvents: 'none',
      userSelect: 'none',
      zIndex: 10,
      fontFamily: 'var(--font-mono)',
      fontSize: 16,
      lineHeight: 1.65,
      color: 'var(--text-mono)',
    }}>
      {/* Primary telemetry */}
      <div>t = <span style={{ color: 'var(--cyan)' }}>{time.toFixed(3)}</span> yr</div>
      <div>E = <span style={{ color: energy < 0 ? 'var(--green)' : 'var(--red)' }}>{energy.toFixed(5)}</span></div>
      <div>N = <span style={{ color: 'var(--text)' }}>{bodyCount}</span></div>

      {blackHole && (
        <div style={{
          marginTop: 10,
          paddingTop: 8,
          borderTop: '1px solid var(--border)',
          fontSize: 15,
        }}>
          <div style={{ color: 'var(--purple)', letterSpacing: 1.3, marginBottom: 4, fontSize: 14 }}>
            BLACK HOLE ZONES
          </div>
          <div>Event Horizon = <span style={{ color: 'var(--amber)' }}>{fmtRadius(blackHole.event_horizon_radius)}</span></div>
          <div>Photon Sphere = {fmtRadius(blackHole.photon_sphere_radius)}</div>
          <div>Shadow = {fmtRadius(blackHole.shadow_radius)}</div>
          <div>ISCO (3r<sub>s</sub>) = <span style={{ color: 'var(--cyan)' }}>{fmtRadius(blackHole.event_horizon_radius * 3)}</span></div>
          <div style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 2 }}>
            Capture happens at the event horizon. Bent light extends outside it.
          </div>
        </div>
      )}

      {/* Running status */}
      <div style={{
        marginTop: 6,
        fontWeight: 700,
        fontSize: 15,
        letterSpacing: 1.5,
        color: running ? 'var(--green)' : 'var(--amber)',
        textShadow: running ? '0 0 8px var(--green)' : '0 0 8px var(--amber)',
      }}>
        {running ? '▶ RUNNING' : '⏸ PAUSED'}
      </div>

      {/* ── Integrator diagnostics ──────────────────────────────
         The "is this simulation trustworthy?" block. All quantities below
         should be *conserved* for an isolated system integrated with a
         symplectic scheme. Large drift = the integrator couldn't resolve a
         close encounter (or a physical collision/absorption happened).   */}
      {diagnostics && (
        <div style={{
          marginTop: 10,
          paddingTop: 8,
          borderTop: '1px solid var(--border)',
          fontSize: 15,
          opacity: 0.92,
        }}>
          <div style={{ color: 'var(--amber)', letterSpacing: 1.3, marginBottom: 4, fontSize: 14 }}>
            SIMULATION INTEGRITY
          </div>
          <div>
            Mode = <span style={{ color: 'var(--cyan)' }}>{modeLabel(diagnostics.integratorMode)}</span>
          </div>
          <div style={{ color: 'var(--text-dim)', maxWidth: 430 }}>
            {modeDescription(diagnostics.integratorMode, diagnostics.approximationActive)}
          </div>
          <div style={{ marginTop: 4 }}>
            Trust Level = <span style={{ color: trust.color }}>{trust.label}</span>
          </div>
          <div>
            Energy Drift |ΔE / E₀| ={' '}
            <span style={{ color: driftColor(diagnostics.energyDrift) }}>
              {diagnostics.energyDrift.toExponential(2)}
            </span>
          </div>
          <div>Momentum Error |p| = {vecMag(diagnostics.momentum).toExponential(2)}</div>
          <div>Angular Momentum |L| = {vecMag(diagnostics.angMomentum).toExponential(2)}</div>
          <div>
            Substeps = <span style={{ color: diagnostics.maxSubstepsHit ? 'var(--red)' : 'var(--text)' }}>
              {diagnostics.substeps}{diagnostics.maxSubstepsHit ? '*' : ''}
            </span>
            {diagnostics.rmin !== null && (
              <> · Closest Approach r<sub>min</sub> = {diagnostics.rmin.toFixed(3)}</>
            )}
          </div>
          <div style={{ color: 'var(--text-dim)', marginTop: 3 }}>
            E = K + U · L = r × p · seed {diagnostics.seed.toString(16)}
          </div>
          <div style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 2 }}>
            η = {diagnostics.eta.toFixed(3)}
          </div>
        </div>
      )}

      {/* Selected body panel */}
      {selectedBody && (
        <div style={{
          marginTop: 10,
          paddingTop: 8,
          borderTop: '1px solid var(--border)',
          fontSize: 15,
        }}>
          <div style={{ color: 'var(--cyan)', letterSpacing: 1.3, marginBottom: 4, fontSize: 14 }}>
            BODY #{selectedBody.id}
          </div>
          <div>m = {selectedBody.mass.toFixed(3)} M☉</div>
          <div>v = {speed(selectedBody).toFixed(4)} AU/yr</div>
          {(() => {
            if (!snap.blackHole) return null;
            const bh = snap.blackHole;
            const dx = selectedBody.pos[0] - bh.pos[0];
            const dy = selectedBody.pos[1] - bh.pos[1];
            const dz = selectedBody.pos[2] - bh.pos[2];
            const r  = Math.sqrt(dx*dx + dy*dy + dz*dz);
            const isco = bh.event_horizon_radius * 3;
            if (r >= isco) return null;
            return (
              <div style={{
                marginTop: 5,
                fontFamily: 'var(--font-mono)', fontSize: 12,
                color: 'var(--red)',
                textShadow: '0 0 8px var(--red)',
                letterSpacing: 1.2,
                fontWeight: 700,
              }}>
                ⚠ INSIDE ISCO — SPIRALING IN
              </div>
            );
          })()}
          <div style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 3 }}>
            Detailed state vectors available in Telemetry.
          </div>
        </div>
      )}
    </div>
  );
}

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

function fmtRadius(v: number) {
  return `${v.toFixed(3)} AU`;
}

// Green → amber → red thresholds match SidePanel EnergySparkline for consistency
function driftColor(d: number) {
  if (d < 1e-4) return 'var(--green)';
  if (d < 1e-2) return 'var(--amber)';
  return 'var(--red)';
}

function virialColor(q: number) {
  if (Math.abs(q - 1) < 0.1) return 'var(--green)';
  if (Math.abs(q - 1) < 0.5) return 'var(--amber)';
  return 'var(--red)';
}

export default function HUD({ snap, selectedBody }: Props) {
  const { time, energy, bodyCount, running, diagnostics, blackHole } = snap;

  return (
    <div style={{
      position: 'absolute',
      top: 14, left: 14,
      pointerEvents: 'none',
      userSelect: 'none',
      zIndex: 10,
      fontFamily: 'var(--font-mono)',
      lineHeight: 1.7,
      color: 'var(--text-mono)',
    }}>
      {/* ── Primary readout — bigger, cleaner ── */}
      <div style={{ fontSize: 19, marginBottom: 1 }}>
        t = <span style={{ color: 'var(--cyan)' }}>{time.toFixed(3)}</span>
        <span style={{ fontSize: 13, color: 'var(--text-dim)' }}> yr</span>
      </div>
      <div style={{ fontSize: 19, marginBottom: 1 }}>
        E = <span style={{ color: energy < 0 ? 'var(--green)' : 'var(--red)' }}>{energy.toFixed(4)}</span>
        <span style={{ fontSize: 13, color: 'var(--text-dim)', marginLeft: 7 }}>
          {energy < 0 ? '(bound)' : '(unbound)'}
        </span>
      </div>
      <div style={{ fontSize: 19, marginBottom: 5 }}>
        N = <span style={{ color: 'var(--text)' }}>{bodyCount}</span>
      </div>

      {/* ── Virial ratio — key physics diagnostic ── */}
      {diagnostics?.virialQ != null && (
        <div style={{ fontSize: 17, marginBottom: 2 }}>
          Q = <span style={{ color: virialColor(diagnostics.virialQ) }}>
            {diagnostics.virialQ.toFixed(3)}
          </span>
          <span style={{ fontSize: 13, color: 'var(--text-dim)', marginLeft: 6 }}>
            {Math.abs(diagnostics.virialQ - 1) < 0.1
              ? '(equilibrium)'
              : diagnostics.virialQ < 1 ? '(collapsing)' : '(dispersing)'}
          </span>
        </div>
      )}

      {/* ── Energy drift — compact one-liner ── */}
      {diagnostics && (
        <div style={{ fontSize: 14, color: 'var(--text-dim)', marginBottom: 2 }}>
          |ΔE/E₀| ={' '}
          <span style={{ color: driftColor(diagnostics.energyDrift) }}>
            {diagnostics.energyDrift.toExponential(2)}
          </span>
        </div>
      )}

      {/* ── Running status ── */}
      <div style={{
        marginTop: 5,
        fontWeight: 700,
        fontSize: 15,
        letterSpacing: 1.5,
        color: running ? 'var(--green)' : 'var(--amber)',
        textShadow: running ? '0 0 8px var(--green)' : '0 0 8px var(--amber)',
      }}>
        {running ? '▶ RUNNING' : '⏸ PAUSED'}
      </div>

      {/* ── Black hole zone radii ── */}
      {blackHole && (
        <div style={{
          marginTop: 10, paddingTop: 8,
          borderTop: '1px solid var(--border)',
          fontSize: 15,
        }}>
          <div style={{ color: 'var(--purple)', letterSpacing: 1.3, marginBottom: 5, fontSize: 13 }}>
            BLACK HOLE ZONES
          </div>
          <div>r_horizon = <span style={{ color: 'var(--amber)' }}>{fmtRadius(blackHole.event_horizon_radius)}</span></div>
          <div>r_photon = {fmtRadius(blackHole.photon_sphere_radius)}</div>
          <div>b_cr = {fmtRadius(blackHole.shadow_radius)}</div>
          <div>ISCO = <span style={{ color: 'var(--cyan)' }}>{fmtRadius(blackHole.event_horizon_radius * 3)}</span></div>
          <div style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 3 }}>
            Photons captured below b_cr. Bodies absorbed at r_horizon.
          </div>
        </div>
      )}

      {/* ── Selected body ── */}
      {selectedBody && (
        <div style={{
          marginTop: 10, paddingTop: 8,
          borderTop: '1px solid var(--border)',
          fontSize: 15,
        }}>
          <div style={{ color: 'var(--cyan)', letterSpacing: 1.3, marginBottom: 4, fontSize: 13 }}>
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
            if (r >= bh.event_horizon_radius * 3) return null;
            return (
              <div style={{
                marginTop: 5, fontSize: 12,
                color: 'var(--red)', textShadow: '0 0 8px var(--red)',
                letterSpacing: 1.2, fontWeight: 700,
              }}>
                ⚠ INSIDE ISCO — SPIRALING IN
              </div>
            );
          })()}
          <div style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 3 }}>
            Full state vectors in Telemetry panel.
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect } from 'react';
import { createPortal } from 'react-dom';

interface Section {
  title: string;
  color: string;
  equations: { label: string; eq: string }[];
  body: string;
  ref: string;
}

const SECTIONS: Section[] = [
  {
    title:  'N-Body Gravity',
    color:  'var(--amber)',
    equations: [
      { label: 'Gravitational force',   eq: 'F = G m₁m₂ / r²' },
      { label: 'Total acceleration',    eq: 'aᵢ = G Σⱼ mⱼ (rⱼ − rᵢ) / |rⱼ − rᵢ|³' },
    ],
    body: 'Each body accelerates under the summed Newtonian gravity of all others every timestep. '
        + 'The Velocity Verlet integrator (Störmer 1907) is second-order accurate in dt and '
        + 'exactly time-reversible, which keeps long-run energy drift low. '
        + 'Scientific and High Accuracy modes switch to adaptive sub-stepping (Aarseth η criterion) '
        + 'so close encounters are resolved without blowing up the global timestep.',
    ref: 'Aarseth, S.J. (2003). Gravitational N-Body Simulations.',
  },
  {
    title:  'Schwarzschild Lensing',
    color:  'var(--cyan)',
    equations: [
      { label: 'Binet geodesic ODE',   eq: 'd²u/dφ² = (3/2) rₛ u² − u,   u = 1/r' },
      { label: 'Critical impact param', eq: 'bᶜ = (3√3 / 2) rₛ ≈ 2.598 rₛ' },
      { label: 'Shadow radius',         eq: 'r_shadow = 2.4 r_BH  (simulation units)' },
    ],
    body: 'Every screen pixel fires a backward null geodesic into curved spacetime. '
        + 'The Binet equation reduces the full geodesic to a 1D ODE in the orbital plane — '
        + 'exact for the Schwarzschild (non-spinning) metric. '
        + 'Störmer-Verlet integration runs 120 steps per ray in the normal pass and 240 in Cinematic mode. '
        + 'Rays with impact parameter b < bᶜ spiral into the shadow. '
        + 'The photon sphere at r = 1.5 rₛ produces the bright photon ring; '
        + 'rays completing > 143° of arc intersect the back face of the disk, creating a ghost image above and below the shadow.',
    ref: 'Luminet, J.P. (1979). A&A 75:228. · James et al. (2015). CQG 32 065001.',
  },
  {
    title:  'Accretion Disk',
    color:  'var(--green)',
    equations: [
      { label: 'Keplerian speed',         eq: 'β = √(rₛ / 2r)' },
      { label: 'Relativistic Doppler',    eq: 'D = 1 / γ(1 − β cosθ),   flux ∝ D³' },
      { label: 'Gravitational redshift',  eq: 'g = √(1 − rₛ/r)' },
      { label: 'ISCO inner edge',         eq: 'r_ISCO = 3 rₛ  →  inner = 1.155 r_shadow' },
    ],
    body: 'The disk is a RingGeometry with a procedural noise shader. '
        + 'Approaching gas (cosθ > 0) is Doppler-boosted and blue-shifted; '
        + 'receding gas dims by the same factor — producing the characteristic one-sided brightness asymmetry '
        + 'visible in EHT images of M87* and Sgr A*. '
        + 'Gravitational redshift darkens the innermost annuli as photons climb out of the potential well. '
        + 'The inner edge is set at the Innermost Stable Circular Orbit (ISCO), '
        + 'inside which no stable orbits exist in Schwarzschild spacetime.',
    ref: 'Shakura & Sunyaev (1973). A&A 24:337. · Event Horizon Telescope (2019, 2022).',
  },
  {
    title:  'Photon Tracing (Cinematic)',
    color:  'var(--purple)',
    equations: [
      { label: 'Photon ring n=1',  eq: 'b ≈ bᶜ   (one near-orbit)' },
      { label: 'Photon ring n=2',  eq: 'b ≈ 1.043 bᶜ  (~15% intensity, Luminet 1979)' },
      { label: 'Disk ghost image', eq: 'φ > 2.5 rad → far-side disk crossing detected' },
    ],
    body: 'In Cinematic mode the shader doubles its integration step count and sharpens '
        + 'the ring profile. A secondary photon ring (n=2) appears just outside the primary — '
        + 'photons that orbited the BH 1.5 times before escaping. '
        + 'The Doppler asymmetry is also stronger (D⁴ vs D³), matching the contrast '
        + 'seen in millimetre-wave VLBI observations.',
    ref: 'Luminet (1979). · Johnson et al. (2020). Sci. Adv. 6 eaaz1310.',
  },
];

interface Props {
  onClose: () => void;
}

export default function PhysicsPanel({ onClose }: Props) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(4, 6, 18, 0.82)',
        backdropFilter: 'blur(12px) saturate(1.2)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: 80, overflowY: 'auto',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          width: '100%', maxWidth: 820,
          margin: '0 16px 80px',
          padding: '28px 28px 24px',
          boxShadow: '0 32px 80px rgba(0,0,0,0.65)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700, letterSpacing: 2.5, color: 'var(--text)' }}>
              PHYSICS MODEL
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}>
              Equations and approximations used in this simulation
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: '1px solid var(--border)',
              borderRadius: 5, color: 'var(--text-dim)',
              fontFamily: 'var(--font-mono)', fontSize: 14,
              padding: '6px 12px', cursor: 'pointer',
            }}
          >ESC</button>
        </div>

        {/* Sections */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {SECTIONS.map(sec => (
            <div
              key={sec.title}
              style={{
                border: `1px solid var(--border)`,
                borderLeft: `3px solid ${sec.color}`,
                borderRadius: 7,
                padding: '16px 18px',
                background: 'rgba(255,255,255,0.018)',
              }}
            >
              {/* Section title */}
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 2.2,
                textTransform: 'uppercase', color: sec.color, marginBottom: 12,
              }}>
                {sec.title}
              </div>

              {/* Equations */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                {sec.equations.map(e => (
                  <div key={e.label} style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                    <span style={{
                      fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)',
                      letterSpacing: 1, minWidth: 170, flexShrink: 0,
                    }}>
                      {e.label}
                    </span>
                    <span style={{
                      fontFamily: 'var(--font-mono)', fontSize: 14, color: sec.color,
                      letterSpacing: 0.5,
                    }}>
                      {e.eq}
                    </span>
                  </div>
                ))}
              </div>

              {/* Body text */}
              <p style={{
                fontFamily: 'var(--font-mono)', fontSize: 12,
                color: 'var(--text-dim)', lineHeight: 1.65,
                margin: '0 0 10px',
              }}>
                {sec.body}
              </p>

              {/* Reference */}
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 10,
                color: 'var(--text-dim)', opacity: 0.6,
                borderTop: '1px solid var(--border)', paddingTop: 8,
              }}>
                {sec.ref}
              </div>
            </div>
          ))}
        </div>

        {/* Footer note */}
        <div style={{
          marginTop: 20,
          fontFamily: 'var(--font-mono)', fontSize: 11,
          color: 'var(--text-dim)', opacity: 0.5,
          textAlign: 'center', letterSpacing: 1,
        }}>
          This simulation uses Schwarzschild (non-spinning) spacetime. Kerr metric and spin effects are not modelled.
        </div>
      </div>
    </div>,
    document.body
  );
}

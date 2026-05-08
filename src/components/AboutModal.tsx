import { useEffect } from 'react';
import { createPortal } from 'react-dom';

const TECH = [
  { label: 'Three.js',      color: 'var(--cyan)'       },
  { label: 'WebGL GLSL',    color: 'var(--amber)'      },
  { label: 'Web Workers',   color: 'var(--green)'      },
  { label: 'React',         color: 'var(--blue-light)' },
  { label: 'TypeScript',    color: 'var(--purple)'     },
];

const REFS = [
  { short: 'Schwarzschild (1916)',          full: 'K. Schwarzschild — "Über das Gravitationsfeld eines Massenpunktes nach der Einsteinschen Theorie"' },
  { short: 'Luminet (1979)',                full: 'J.-P. Luminet — "Image of a spherical black hole with thin accretion disk", A&A 75:228' },
  { short: 'Chenciner & Montgomery (2000)', full: 'A. Chenciner, R. Montgomery — "A remarkable periodic solution of the three body problem in the case of equal masses", Annals of Mathematics 152:881' },
  { short: 'James et al. (2015)',           full: 'O. James et al. — "Gravitational lensing by spinning black holes in astrophysics, and in the movie Interstellar", CQG 32:065001' },
  { short: 'Plummer (1911)',                full: 'H. C. Plummer — "On the problem of distribution in globular star clusters", MNRAS 71:460' },
  { short: 'EHT Collaboration (2019)',      full: 'Event Horizon Telescope Collaboration — "First M87 Event Horizon Telescope Results", ApJL 875:L1' },
];

const KEY_EQUATIONS = [
  { label: 'N-body gravity',      eq: 'aᵢ = G Σⱼ mⱼ (rⱼ − rᵢ) / |rⱼ − rᵢ|³' },
  { label: 'Binet geodesic ODE',  eq: 'd²u/dφ² = (3/2) rₛ u² − u' },
  { label: 'Photon sphere',       eq: 'r_ph = 1.5 rₛ,   bᶜ = 2.598 rₛ' },
  { label: 'Doppler factor',      eq: 'D = 1 / γ(1 − β cosθ),   flux ∝ D³' },
  { label: 'Grav. redshift',      eq: 'g = √(1 − rₛ / r)' },
];

interface Props {
  onClose: () => void;
  onCaptureFrame: () => void;
}

export default function AboutModal({ onClose, onCaptureFrame }: Props) {
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
        {/* ── Header ── */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
              <div style={{
                width: 38, height: 38, borderRadius: 7, flexShrink: 0,
                background: 'linear-gradient(135deg, #00d4ff 0%, #0044cc 100%)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18, fontWeight: 700, color: '#fff',
                boxShadow: '0 0 24px rgba(0,212,255,0.35)',
              }}>N</div>
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 700, letterSpacing: 2.5, color: 'var(--text)' }}>
                  RELATIVISTIC N-BODY LAB
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-dim)', letterSpacing: 1 }}>
                  V3.0.0 · Real-time gravitational physics in the browser
                </div>
              </div>
            </div>
            {/* Tech badges */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              {TECH.map(t => (
                <span key={t.label} style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 1.2,
                  color: t.color, border: `1px solid ${t.color}`,
                  borderRadius: 3, padding: '2px 7px', opacity: 0.85,
                }}>
                  {t.label}
                </span>
              ))}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: '1px solid var(--border)',
              borderRadius: 5, color: 'var(--text-dim)',
              fontFamily: 'var(--font-mono)', fontSize: 14,
              padding: '6px 12px', cursor: 'pointer', flexShrink: 0,
            }}
          >ESC</button>
        </div>

        {/* ── Description ── */}
        <div style={{
          fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-dim)',
          lineHeight: 1.7, marginBottom: 22,
          borderLeft: '3px solid var(--cyan)', paddingLeft: 14,
        }}>
          Interactive Newtonian N-body gravity simulator with realtime
          Schwarzschild-inspired black-hole lensing.
          The simulation runs entirely in the browser:
          The physics worker runs on a dedicated thread via the Web Workers API,
          freeing the main thread for Three.js rendering at 60fps.
          The black hole uses per-pixel Schwarzschild geodesic integration in a WebGL
          fragment shader — every screen pixel fires a backward null geodesic through
          curved spacetime to produce gravitational lensing, photon rings, and ghost disk images,
          all in real time.
        </div>

        {/* ── Two-column layout ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>

          {/* Key equations */}
          <div style={{
            border: '1px solid var(--border)', borderRadius: 7,
            padding: '14px 16px', background: 'rgba(255,255,255,0.018)',
          }}>
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 2,
              textTransform: 'uppercase', color: 'var(--amber)', marginBottom: 12,
            }}>Key Equations</div>
            {KEY_EQUATIONS.map(e => (
              <div key={e.label} style={{ marginBottom: 9 }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', letterSpacing: 1, marginBottom: 2 }}>
                  {e.label}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--cyan)' }}>
                  {e.eq}
                </div>
              </div>
            ))}
          </div>

          {/* What's modelled */}
          <div style={{
            border: '1px solid var(--border)', borderRadius: 7,
            padding: '14px 16px', background: 'rgba(255,255,255,0.018)',
          }}>
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 2,
              textTransform: 'uppercase', color: 'var(--green)', marginBottom: 12,
            }}>What's Modelled</div>
            {[
              ['✓', 'Newtonian N-body gravity (exact all-pairs)',         'var(--green)'],
              ['✓', 'Velocity Verlet + adaptive Störmer-Verlet',          'var(--green)'],
              ['✓', 'Schwarzschild (non-spinning) geodesic lensing',      'var(--green)'],
              ['✓', 'Relativistic Doppler brightening (D³ / D⁴)',        'var(--green)'],
              ['✓', 'Gravitational redshift on disk emission',            'var(--green)'],
              ['✓', 'Photon ring n=1 + n=2 with Doppler asymmetry',      'var(--green)'],
              ['✓', 'Ghost disk image (far-side geodesic crossing)',      'var(--green)'],
              ['✗', 'Kerr metric (BH spin / frame dragging)',             'var(--text-dim)'],
              ['✗', 'Blackbody spectrum (Wien temperature → RGB)',        'var(--text-dim)'],
              ['✗', 'General relativistic magnetohydrodynamics (GRMHD)',  'var(--text-dim)'],
              ['✗', 'Validated NASA-grade production science software',   'var(--text-dim)'],
            ].map(([mark, text, color]) => (
              <div key={text as string} style={{
                display: 'flex', gap: 8, marginBottom: 5,
                fontFamily: 'var(--font-mono)', fontSize: 11,
              }}>
                <span style={{ color: color as string, flexShrink: 0 }}>{mark as string}</span>
                <span style={{ color: 'var(--text-dim)' }}>{text as string}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── References ── */}
        <div style={{
          border: '1px solid var(--border)', borderRadius: 7,
          padding: '14px 16px', background: 'rgba(255,255,255,0.018)',
          marginBottom: 20,
        }}>
          <div style={{
            fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 2,
            textTransform: 'uppercase', color: 'var(--purple)', marginBottom: 12,
          }}>References</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {REFS.map(r => (
              <div key={r.short} style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--purple)',
                  minWidth: 200, flexShrink: 0,
                }}>{r.short}</span>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)',
                  lineHeight: 1.5,
                }}>{r.full}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Capture button ── */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <button
            className="mc-btn mc-btn-cyan"
            onClick={() => { onCaptureFrame(); onClose(); }}
            style={{ fontSize: 14, padding: '8px 22px' }}
            title="Renders and downloads the current frame as a PNG"
          >
            ⬇ CAPTURE FRAME
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

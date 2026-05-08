import { useEffect } from 'react';
import { createPortal } from 'react-dom';

interface Preset {
  id: string;
  label: string;
  desc: string;
  tag: string;   // short physics tag shown on card
  tagColor: string;
}

const GROUPS: { title: string; color: string; presets: Preset[] }[] = [
  {
    title: 'Benchmarks',
    color: 'var(--amber)',
    presets: [
      {
        id:       'kepler',
        label:    'Kepler Orbit',
        desc:     'Sun + test particle in an e = 0.5 ellipse. Closed-form vis-viva solution — orbit closes on itself forever with a good integrator.',
        tag:      '2-body',
        tagColor: 'var(--amber)',
      },
      {
        id:       'figure_eight',
        label:    'Figure-8 Choreography',
        desc:     'Three equal masses chasing each other in a planar figure-8 (Chenciner–Montgomery 2000). The most famous periodic 3-body solution.',
        tag:      '3-body',
        tagColor: 'var(--amber)',
      },
      {
        id:       'pythagorean',
        label:    'Pythagorean 3-4-5',
        desc:     'Masses 3, 4, 5 at rest at the vertices of a right triangle (Burrau 1913). Ends in a binary + hyperbolic ejection — exquisitely sensitive to integrator quality.',
        tag:      '3-body',
        tagColor: 'var(--red)',
      },
      {
        id:       'plummer',
        label:    'Plummer Sphere',
        desc:     'N = 50 stars sampled from Plummer\'s 1911 density profile in virial equilibrium (2T + U = 0). Tests long-term energy conservation for collisionless systems.',
        tag:      'N-body',
        tagColor: 'var(--cyan)',
      },
      {
        id:       'trojan',
        label:    'Sun–Jupiter Trojan',
        desc:     'Test mass placed at the L4 Lagrange point, 60° ahead of Jupiter. Should librate stably around L4 (restricted 3-body, μ ≪ 0.0385).',
        tag:      '3-body',
        tagColor: 'var(--green)',
      },
    ],
  },
  {
    title: 'Gravity',
    color: 'var(--cyan)',
    presets: [
      {
        id:       'solar_system',
        label:    'Solar System',
        desc:     'Sun + 8 planets with real AU semi-major axes, solar masses, and Keplerian circular velocities. Total momentum zeroed to the centre-of-mass frame.',
        tag:      'N-body',
        tagColor: 'var(--cyan)',
      },
      {
        id:       'binary_star',
        label:    'Binary Star',
        desc:     'Two stars (1.5 M☉ + 1.0 M☉) in a slightly elliptical mutual orbit, initialised from Kepler\'s vis-viva with a ×1.15 velocity boost.',
        tag:      '2-body',
        tagColor: 'var(--blue-light)',
      },
      {
        id:       'galaxy_core',
        label:    'Galaxy Core',
        desc:     '40 stars on Keplerian circular orbits in a thin disk around a 200 M☉ central black hole. Demonstrates differential rotation and tidal disruption.',
        tag:      'N + BH',
        tagColor: 'var(--purple)',
      },
    ],
  },
  {
    title: 'Atomic / Molecular',
    color: 'var(--green)',
    presets: [
      {
        id:       'hydrogen',
        label:    'Hydrogen Atom',
        desc:     'Proton (m = 1836) + electron in a circular Bohr orbit using the Coulomb force. Tests the integrator\'s ability to preserve angular momentum for a 1/r² potential.',
        tag:      'Coulomb',
        tagColor: 'var(--green)',
      },
      {
        id:       'helium',
        label:    'Helium Atom',
        desc:     'α nucleus (charge +2) + two electrons in a symmetric Coulomb configuration. Includes repulsion between the electrons — a genuine 3-body Coulomb problem.',
        tag:      'Coulomb',
        tagColor: 'var(--green)',
      },
      {
        id:       'argon_gas',
        label:    'Argon Gas (LJ)',
        desc:     '50 particles interacting via a 12-6 Lennard-Jones potential (σ = 0.5, ε = 1.0). Thermalises into a liquid / dense-gas phase under its own pressure.',
        tag:      'LJ fluid',
        tagColor: 'var(--text-dim)',
      },
    ],
  },
];

interface Props {
  onSelect: (preset: string) => void;
  onClose: () => void;
}

export default function PresetModal({ onSelect, onClose }: Props) {
  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Render via portal so the overlay escapes any ancestor stacking context
  // created by backdrop-filter (TopBar, etc.). Without this, position:fixed
  // children are clipped to the nearest filter-bearing ancestor bounds.
  return createPortal(
    // ── Backdrop ──────────────────────────────────────────────────────
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(4, 6, 18, 0.78)',
        backdropFilter: 'blur(10px) saturate(1.2)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: 80,
        overflowY: 'auto',
      }}
    >
      {/* ── Panel ──────────────────────────────────────────────────── */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          width: '100%', maxWidth: 860,
          margin: '0 16px 80px',
          padding: '28px 28px 24px',
          boxShadow: '0 32px 80px rgba(0,0,0,0.6)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700, letterSpacing: 2.5, color: 'var(--text)' }}>
              PRESET SCENARIOS
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}>
              Select a scenario — resets the simulation immediately
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
          >
            ESC
          </button>
        </div>

        {/* Groups */}
        {GROUPS.map(({ title, color, presets }) => (
          <div key={title} style={{ marginBottom: 24 }}>
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 2.2,
              textTransform: 'uppercase', color, marginBottom: 10,
              paddingBottom: 6, borderBottom: `1px solid var(--border)`,
            }}>
              {title}
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: 10,
            }}>
              {presets.map(p => (
                <button
                  key={p.id}
                  onClick={() => { onSelect(p.id); onClose(); }}
                  style={{
                    textAlign: 'left', background: 'rgba(255,255,255,0.025)',
                    border: '1px solid var(--border)', borderRadius: 7,
                    padding: '13px 14px', cursor: 'pointer',
                    transition: 'background 0.15s, border-color 0.15s',
                    color: 'inherit',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.background = 'rgba(0,212,255,0.07)';
                    e.currentTarget.style.borderColor = 'var(--cyan)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.025)';
                    e.currentTarget.style.borderColor = 'var(--border)';
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
                      {p.label}
                    </span>
                    <span style={{
                      fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 1.2,
                      color: p.tagColor, border: `1px solid ${p.tagColor}`,
                      borderRadius: 3, padding: '1px 6px', opacity: 0.85,
                    }}>
                      {p.tag}
                    </span>
                  </div>
                  <p style={{
                    fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-dim)',
                    lineHeight: 1.55, margin: 0,
                  }}>
                    {p.desc}
                  </p>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body
  );
}

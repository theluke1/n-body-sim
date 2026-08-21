import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

type Mode = 'explorer' | 'physics';

function GEntry({ label, desc, color = 'var(--cyan)' }: { label: string; desc: string; color?: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color, letterSpacing: 0.8, marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--text-dim)', lineHeight: 1.65 }}>
        {desc}
      </div>
    </div>
  );
}

function GSection({ title, color = 'var(--amber)', children }: { title: string; color?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{
        fontFamily: 'var(--font-mono)', fontSize: 11, color, letterSpacing: 2.5,
        textTransform: 'uppercase', marginBottom: 10, paddingBottom: 6,
        borderBottom: `1px solid ${color}33`,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

const EXPLORER = (
  <>
    <GSection title="Simulation Controls">
      <GEntry label="RUN / PAUSE" desc="Start or stop the simulation at any time." />
      <GEntry label="RESET" desc="Spawn a fresh random configuration of particles. Use the PRESET button above to try specific scenarios like Galaxy Core, Kepler, or Lagrange Points." />
    </GSection>

    <GSection title="Integrator Mode">
      <GEntry label="Realtime" desc="Fast and smooth. Uses a spatial tree algorithm (Barnes-Hut) for large particle counts — accurate enough for visual exploration." />
      <GEntry label="Scientific" desc="Exact physics with no approximations, capped at 60 bodies. Best for precise measurements." />
      <GEntry label="High Accuracy" desc="Adds extra sub-steps near close encounters. Highest precision, fewest bodies." />
    </GSection>

    <GSection title="Particles">
      <GEntry label="N — count" desc="Number of particles to simulate. More bodies = richer dynamics, but slower performance." />
      <GEntry label="R — radius" desc="Starting spread. Small = dense, fast-collapsing cloud. Large = diffuse, slowly-evolving gas." />
      <GEntry label="Vel — velocity" desc="Initial speed scale. 0 = everything starts still and falls inward. 1 = random circular-orbit speeds. Higher = particles may escape the system entirely." />
    </GSection>

    <GSection title="Mass">
      <GEntry label="Min / Max" desc="Range of particle masses in solar masses (M☉). Heavier particles dominate the gravitational dynamics and are harder to deflect." />
      <GEntry label="dt" desc="Base integration timestep. Smaller = more accurate but slower. The integrator adds extra sub-steps automatically near close encounters regardless." />
    </GSection>

    <GSection title="Black Hole">
      <GEntry label="BH ON / OFF" desc="Toggle a central supermassive object. This enables gravitational lensing — photons and bodies curve around it according to Einstein's General Relativity." />
      <GEntry label="M — mass" desc="Black hole mass in solar masses. Controls the event horizon size and lensing strength. Larger mass = more extreme bending." />
    </GSection>

    <GSection title="Photons (Light Rays)">
      <GEntry label="ON / FIRE" desc="Toggle light ray simulation. FIRE launches a set of photons from the camera toward the black hole — watch them curve, orbit the photon sphere, or get captured at the event horizon." />
      <GEntry label="IMAGE PLANE" desc="Found in the Telemetry panel → System tab. Sweeps light rays across all impact parameters systematically. This reveals the full Einstein ring structure and photon sphere geometry that random firing can't." />
    </GSection>

    <GSection title="Visual Effects">
      <GEntry label="TRAILS" desc="Show particle history as trailing lines. Reveals orbital shapes, resonances, and chaotic trajectories over time." />
      <GEntry label="GRID" desc="Reference coordinate grid for spatial orientation." />
      <GEntry label="BLOOM" desc="Glow effect around bright objects. Disable this for a significant performance boost on older or integrated-GPU hardware." />
    </GSection>

    <GSection title="HUD Readout (top-left of canvas)">
      <GEntry label="t — simulation time" desc="Time elapsed in the simulation, measured in years." />
      <GEntry label="E — total energy" desc="Total mechanical energy of the system. Negative = gravitationally bound (particles stay together). Positive = unbound (system is flying apart)." />
      <GEntry label="N — particle count" desc="Current number of particles. Decreases when bodies merge or fall into the black hole." />
      <GEntry label="Q — virial ratio" desc="Measures the energy balance of the system. Q ≈ 1 = equilibrium (stable). Q < 1 = too cold, will collapse inward. Q > 1 = too hot, will disperse outward." />
      <GEntry label="|ΔE/E₀| — energy drift" desc="How well the integrator is conserving energy over time. Green = excellent. Amber = noisy conditions. Red = a close encounter wasn't resolved — try High Accuracy mode." />
    </GSection>

    <GSection title="Telemetry Panel (right side)">
      <GEntry label="SYSTEM tab → Energy chart" desc="Live history of energy conservation quality. A flat line is the goal for a symplectic integrator like Velocity Verlet." />
      <GEntry label="NFW Dark Matter Halo" desc="Adds an invisible dark matter envelope around the galaxy. Changes the rotation curve from Keplerian (velocity drops with distance, like isolated stars) to flat (velocity stays constant at large radius), matching what we observe in real spiral galaxies." />
      <GEntry label="θ slider" desc="Barnes-Hut accuracy. Lower θ = more accurate forces but slower simulation. Default 0.7 gives ~1.8% mean error — fast enough for real-time use." />
      <GEntry label="η slider" desc="Controls how small the adaptive sub-steps become near close encounters. Lower = tighter conservation but slower." />
      <GEntry label="Virial equilibration" desc="Rescales all particle velocities at spawn so the system starts in perfect balance (Q = 1 exactly). Useful for studying long-term stability rather than collapse/dispersal dynamics." />
    </GSection>
  </>
);

const PHYSICS = (
  <>
    <GSection title="Integrator" color="var(--cyan)">
      <GEntry
        color="var(--text-mono)"
        label="Velocity Verlet (symplectic, O(dt²))"
        desc="Preserves the modified Hamiltonian H̃ exactly — energy oscillates but never drifts secularly. Non-symplectic integrators like RK4 accumulate secular drift ΔE ∝ t."
      />
      <GEntry
        color="var(--text-mono)"
        label="Benchmark result"
        desc="VV energy error oscillates bounded at 5.5×10⁻³ at step 10,000. RK4 drifts monotonically to 9.1×10⁻² (15× worse). Source: Hairer, Lubich & Wanner 2002."
      />
    </GSection>

    <GSection title="Force Calculation" color="var(--cyan)">
      <GEntry
        color="var(--text-mono)"
        label="Realtime: Barnes-Hut octree — O(N log N)"
        desc="Opening angle criterion: if s/d < θ, treat the cell as a single point mass at its center of mass (accept). Otherwise recurse into children. θ=0.7 gives mean force error 1.77% — within the Hernquist bound of 9θ²/4≈1.10. GADGET-2 default."
      />
      <GEntry
        color="var(--text-mono)"
        label="Scientific: all-pairs — O(N²)"
        desc="Exact pairwise gravity F = Gm₁m₂/r². No approximation. Softened at ε to prevent divergence at r→0."
      />
      <GEntry
        color="var(--text-mono)"
        label="High Accuracy: Aarseth adaptive substepping"
        desc="Per-body timestep δtᵢ = η √(|aᵢ|/|ȧᵢ|), where ȧ is the gravitational jerk. η=0.02 default. Sub-step ceiling: 64 (Aarseth 2003, §2.4)."
      />
    </GSection>

    <GSection title="Gravitational Lensing" color="var(--purple)">
      <GEntry
        color="var(--text-mono)"
        label="Schwarzschild metric"
        desc="ds²=−(1−rₛ/r)c²dt²+(1−rₛ/r)⁻¹dr²+r²dΩ², where rₛ=2GM/c² is the Schwarzschild radius."
      />
      <GEntry
        color="var(--text-mono)"
        label="Binet equation (photon null geodesic)"
        desc="d²u/dφ²+u=(3rₛ/2)u², where u=1/r. The GR correction (3rₛ/2)u² curves photon paths beyond Newtonian gravity. Source: Misner, Thorne & Wheeler §25.6."
      />
      <GEntry
        color="var(--text-mono)"
        label="Critical impact parameter b_cr"
        desc="b_cr=3√3/2·rₛ≈2.598rₛ. Photon sphere at r=1.5rₛ. Deflection angle Δφ diverges logarithmically: Δφ∼−ln(b/b_cr−1) as b→b_cr⁺. Benchmark: b=1.01b_cr → Δφ=242°; b=20b_cr → Δφ=2.27° (GR weak-field: 2.21°)."
      />
    </GSection>

    <GSection title="NFW Dark Matter Halo" color="var(--purple)">
      <GEntry
        color="var(--text-mono)"
        label="Density profile"
        desc="ρ(r)=ρₛ/[(r/rₛ)(1+r/rₛ)²]. Source: Navarro, Frenk & White ApJ 462:563 (1996) / 490:493 (1997)."
      />
      <GEntry
        color="var(--text-mono)"
        label="Enclosed mass"
        desc="M(r)=M_halo·[ln(1+r/rₛ)−(r/rₛ)/(1+r/rₛ)]."
      />
      <GEntry
        color="var(--text-mono)"
        label="Acceleration"
        desc="a_NFW(r)=−G·M(r)/r² (radial, computed analytically per body each timestep)."
      />
      <GEntry
        color="var(--text-mono)"
        label="Benchmark"
        desc="v_total/v_Kepler=2.09× at r=25 AU using Galaxy Core preset parameters (M_BH=200, M_halo=500, rₛ=3.0 AU). Flat rotation curve confirmed."
      />
    </GSection>

    <GSection title="Virial Theorem" color="var(--green)">
      <GEntry
        color="var(--text-mono)"
        label="Classical form"
        desc="2⟨KE⟩+⟨PE⟩=0 for a time-averaged gravitationally bound system in steady state."
      />
      <GEntry
        color="var(--text-mono)"
        label="Virial ratio Q"
        desc="Q=2KE/|PE|. Q=1 at virial equilibrium. Virial equilibration: rescale all velocities by √(|PE|/2KE) at spawn so Q=1 exactly (velocity Verlet then conserves this to within oscillations)."
      />
      <GEntry
        color="var(--text-mono)"
        label="ML significance"
        desc="Q_init is the dominant feature in the 3-body orbit stability classifier: ~35% Gini importance in Random Forest. This validates why the virial ratio is the primary diagnostic to display."
      />
    </GSection>

    <GSection title="Orbit Stability Classifier (ML)" color="var(--green)">
      <GEntry
        color="var(--text-mono)"
        label="Setup"
        desc="3,000 random 3-body simulations, N=3, 2,000 Velocity Verlet steps each. Features: Q_init, r_min, r_max, mass_ratio, L_norm, E_spec, v_spread. Q sampled from log-normal(0, 0.55) to span Q∈[0.2, 4]."
      />
      <GEntry
        color="var(--text-mono)"
        label="Outcome classes"
        desc="Stable triple (79.6%), binary+escapee (17.0%), dissolved (3.4%). Naive baseline (always predict stable): 79.6%."
      />
      <GEntry
        color="var(--text-mono)"
        label="Models"
        desc="Logistic Regression: 89.8%. Random Forest: 91.3% (best). Gradient Boosting: 90.8%. All scikit-learn. Binary+escapee class hardest: F1=0.72, physically expected at the chaotic escape boundary."
      />
    </GSection>
  </>
);

export default function UserGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('explorer');

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            style={{
              position: 'absolute', inset: 0, zIndex: 40,
              background: 'rgba(0,0,0,0.55)',
              backdropFilter: 'blur(3px)',
            }}
          />

          {/* Panel slides from left */}
          <motion.div
            initial={{ x: -460 }}
            animate={{ x: 0 }}
            exit={{ x: -460 }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            style={{
              position: 'absolute', top: 0, left: 0, bottom: 0, zIndex: 41,
              width: 440,
              background: 'rgba(3,5,18,0.97)',
              backdropFilter: 'blur(20px)',
              borderRight: '1px solid var(--border)',
              display: 'flex', flexDirection: 'column',
              boxShadow: '12px 0 60px rgba(0,0,0,0.6)',
            }}
          >
            {/* Header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '0 20px', minHeight: 56, flexShrink: 0,
              borderBottom: '1px solid var(--border)',
            }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 700, letterSpacing: 2.5, color: 'var(--text)' }}>
                USER GUIDE
              </div>
              <motion.button
                onClick={onClose}
                whileTap={{ scale: 0.9 }}
                style={{
                  background: 'transparent', border: '1px solid var(--border)',
                  color: 'var(--text-dim)', cursor: 'pointer', borderRadius: 5,
                  width: 32, height: 32, fontSize: 18,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                ×
              </motion.button>
            </div>

            {/* Mode tabs */}
            <div style={{ display: 'flex', flexShrink: 0, borderBottom: '1px solid var(--border)' }}>
              {(['explorer', 'physics'] as Mode[]).map(m => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  style={{
                    flex: 1, padding: '13px 0',
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    fontFamily: 'var(--font-mono)', fontSize: 13, letterSpacing: 1.8,
                    textTransform: 'uppercase',
                    color: mode === m ? 'var(--cyan)' : 'var(--text-dim)',
                    borderBottom: `2px solid ${mode === m ? 'var(--cyan)' : 'transparent'}`,
                    transition: 'color 0.15s, border-color 0.15s',
                  }}
                >
                  {m === 'explorer' ? '◎ Explorer' : '⚛ Physics'}
                </button>
              ))}
            </div>

            {/* Tab description */}
            <div style={{
              padding: '8px 20px',
              fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)',
              borderBottom: '1px solid var(--border)', flexShrink: 0,
            }}>
              {mode === 'explorer'
                ? 'Plain English — what does every control do?'
                : 'Equations, algorithms, and benchmarks behind each feature.'}
            </div>

            {/* Scrollable content */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>
              <AnimatePresence mode="wait">
                <motion.div
                  key={mode}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.14 }}
                >
                  {mode === 'explorer' ? EXPLORER : PHYSICS}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

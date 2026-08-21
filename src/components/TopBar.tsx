import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import PresetModal  from './PresetModal';
import PhysicsPanel from './PhysicsPanel';
import AboutModal   from './AboutModal';

interface Props {
  running: boolean;
  gpuActive: boolean;
  sidePanelOpen: boolean;
  time: number;
  bodyCount: number;
  energy: number;
  onToggleSidePanel: () => void;
  onToggleGuide: () => void;
  onPreset: (p: string) => void;
}

const TAP = { whileTap: { scale: 0.96 as number }, transition: { duration: 0.10 } } as const;

function StatPill({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 12,
        color: 'var(--text-dim)', letterSpacing: 1.8,
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 17, fontWeight: 600,
        color, letterSpacing: 0.5,
      }}>
        {value}
      </span>
    </div>
  );
}

export default function TopBar({
  running, gpuActive, sidePanelOpen,
  time, bodyCount, energy,
  onToggleSidePanel, onToggleGuide, onPreset,
}: Props) {
  const [elapsed, setElapsed]         = useState(0);
  const [presetOpen, setPresetOpen]   = useState(false);
  const [physicsOpen, setPhysicsOpen] = useState(false);
  const [aboutOpen, setAboutOpen]     = useState(false);

  // Wall-clock timer — ticks only while sim is running
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setElapsed(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  const fmt = (s: number) => {
    const h  = Math.floor(s / 3600).toString().padStart(2, '0');
    const m  = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
    const sc = (s % 60).toString().padStart(2, '0');
    return `${h}:${m}:${sc}`;
  };

  return (
    <div style={{
      minHeight: 64, flexShrink: 0,
      background: 'var(--bg-panel)',
      borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'center',
      padding: '0 16px', gap: 16,
      position: 'relative', zIndex: 30,
      backdropFilter: 'blur(18px) saturate(1.35)',
      boxShadow: '0 10px 34px rgba(0,0,0,0.22)',
    }}>

      {/* ── Logo ─────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 210, flexShrink: 0 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 6, flexShrink: 0,
          background: 'linear-gradient(135deg, #00d4ff 0%, #0044cc 100%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 800, color: '#fff', letterSpacing: 0.5,
          boxShadow: '0 0 20px rgba(0,212,255,0.34), inset 0 0 12px rgba(255,255,255,0.16)',
          fontFamily: 'var(--font-mono)',
        }}>GL</div>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 700, letterSpacing: 2.5, color: 'var(--text)' }}>
            GRAVITY LENS LAB
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', letterSpacing: 1.2 }}>
            N-BODY SIMULATOR
          </div>
        </div>
      </div>

      {/* ── Nav buttons ──────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <motion.button className="mc-btn mc-btn-cyan" onClick={() => setPresetOpen(o => !o)} style={{ fontSize: 14 }} {...TAP}>
          ◈ PRESET
        </motion.button>
        <motion.button className="mc-btn" onClick={() => setPhysicsOpen(o => !o)} style={{ fontSize: 14 }} {...TAP}>
          ⚛ PHYSICS
        </motion.button>
        <motion.button className="mc-btn" onClick={() => setAboutOpen(o => !o)} style={{ fontSize: 14 }} {...TAP}>
          ◎ ABOUT
        </motion.button>
        <motion.button className="mc-btn" onClick={onToggleGuide} style={{ fontSize: 14 }} {...TAP}>
          ? GUIDE
        </motion.button>

        {presetOpen  && <PresetModal onSelect={onPreset} onClose={() => setPresetOpen(false)} />}
        {physicsOpen && <PhysicsPanel onClose={() => setPhysicsOpen(false)} />}
        {aboutOpen   && <AboutModal onClose={() => setAboutOpen(false)} onCaptureFrame={() => window.dispatchEvent(new Event('nbody:capture-frame'))} />}
      </div>

      {/* ── Live sim stats (center) ───────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 28 }}>
        <StatPill label="T" value={`${time.toFixed(2)} yr`} color="var(--cyan)" />
        <StatPill label="N" value={String(bodyCount)} color="var(--text)" />
        <StatPill
          label="E"
          value={energy.toFixed(4)}
          color={energy < 0 ? 'var(--green)' : 'var(--red)'}
        />

        {/* Running state dot */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 7, height: 7, borderRadius: '50%',
            background: running ? 'var(--green)' : 'var(--amber)',
            boxShadow: `0 0 8px ${running ? 'var(--green)' : 'var(--amber)'}`,
            animation: running ? 'pulse-dot 2.4s ease-in-out infinite' : undefined,
            flexShrink: 0,
          }} />
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 14, letterSpacing: 1.5,
            color: running ? 'var(--green)' : 'var(--amber)',
          }}>
            {running ? 'RUNNING' : 'PAUSED'}
          </span>
        </div>
      </div>

      {/* ── Right: GPU · Wall time · Telemetry ───────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 14, letterSpacing: 1,
          color: gpuActive ? 'var(--amber)' : 'var(--text-dim)',
          textShadow: gpuActive ? '0 0 10px rgba(245,160,32,0.55)' : undefined,
        }}>
          {gpuActive ? '⚡ GPU' : '◌ CPU'}
        </span>

        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', letterSpacing: 1.6, marginBottom: 1 }}>
            WALL TIME
          </div>
          <div className="glow-cyan" style={{
            fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700,
            color: 'var(--cyan)', letterSpacing: 3,
          }}>
            {fmt(elapsed)}
          </div>
        </div>

        <motion.button
          className="mc-btn"
          onClick={onToggleSidePanel}
          style={{
            borderColor: sidePanelOpen ? 'var(--cyan)' : 'var(--border)',
            color: sidePanelOpen ? 'var(--cyan)' : 'var(--text-dim)',
            background: sidePanelOpen ? 'rgba(0,212,255,0.08)' : undefined,
            fontSize: 14,
          }}
          {...TAP}
        >
          TELEMETRY
        </motion.button>
      </div>
    </div>
  );
}

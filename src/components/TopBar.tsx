import { useState, useEffect } from 'react';
import PresetModal  from './PresetModal';
import PhysicsPanel from './PhysicsPanel';
import AboutModal   from './AboutModal';

interface Props {
  running: boolean;
  gpuActive: boolean;
  sidePanelOpen: boolean;
  onToggleSidePanel: () => void;
  onPreset: (p: string) => void;
}

const STATUS = [
  { label: 'SYSTEM',    value: 'ONLINE',   color: 'var(--green)'      },
  { label: 'DATA LINK', value: 'ACTIVE',   color: 'var(--amber)'      },
  { label: 'TELEMETRY', value: 'NOMINAL',  color: 'var(--blue-light)' },
];

export default function TopBar({ running, gpuActive, sidePanelOpen, onToggleSidePanel, onPreset }: Props) {
  const [elapsed, setElapsed]           = useState(0);
  const [presetOpen, setPresetOpen]     = useState(false);
  const [physicsOpen, setPhysicsOpen]   = useState(false);
  const [aboutOpen, setAboutOpen]       = useState(false);

  // Mission elapsed time — ticks only when sim is running
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
      padding: '0 14px', gap: 16,
      position: 'relative', zIndex: 30,
      backdropFilter: 'blur(18px) saturate(1.35)',
      boxShadow: '0 10px 34px rgba(0,0,0,0.22)',
    }}>

      {/* ── Logo ───────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 150, flexShrink: 0 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 5, flexShrink: 0,
          background: 'linear-gradient(135deg, #00d4ff 0%, #0044cc 100%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16, fontWeight: 700, color: '#fff',
          boxShadow: '0 0 20px rgba(0,212,255,0.34), inset 0 0 12px rgba(255,255,255,0.16)',
        }}>N</div>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 700, letterSpacing: 2, color: 'var(--text)' }}>
            N-BODY SIM
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-dim)', letterSpacing: 1 }}>V3.0.0</div>
        </div>
      </div>

      {/* ── Preset · Physics · Cinematic buttons ───────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <button
          className="mc-btn mc-btn-cyan"
          onClick={() => setPresetOpen(o => !o)}
          style={{ fontSize: 14 }}
        >
          ◈ PRESET
        </button>
        <button
          className="mc-btn"
          onClick={() => setPhysicsOpen(o => !o)}
          style={{ fontSize: 14 }}
        >
          ⚛ PHYSICS
        </button>
        <button
          className="mc-btn"
          onClick={() => setAboutOpen(o => !o)}
          style={{ fontSize: 14 }}
        >
          ◎ ABOUT
        </button>
        {presetOpen && (
          <PresetModal
            onSelect={onPreset}
            onClose={() => setPresetOpen(false)}
          />
        )}
        {physicsOpen && (
          <PhysicsPanel onClose={() => setPhysicsOpen(false)} />
        )}
        {aboutOpen && (
          <AboutModal
            onClose={() => setAboutOpen(false)}
            onCaptureFrame={() => window.dispatchEvent(new Event('nbody:capture-frame'))}
          />
        )}
      </div>

      {/* ── Status indicators ──────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 24 }}>
        {STATUS.map(({ label, value, color }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <div className="pulse" style={{
              width: 7, height: 7, borderRadius: '50%',
              background: color, color,
              flexShrink: 0,
            }} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-dim)', letterSpacing: 1.1 }}>
              {label}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color, letterSpacing: 1 }}>
              {value}
            </span>
          </div>
        ))}
      </div>

      {/* ── Right: GPU · Mission Time · Telemetry ──────────── */}
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
            MISSION TIME
          </div>
          <div className="glow-cyan" style={{
            fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700,
            color: 'var(--cyan)', letterSpacing: 3,
          }}>
            {fmt(elapsed)}
          </div>
        </div>

        <button
          className="mc-btn"
          onClick={onToggleSidePanel}
          style={{
            borderColor: sidePanelOpen ? 'var(--cyan)' : 'var(--border)',
            color: sidePanelOpen ? 'var(--cyan)' : 'var(--text-dim)',
            background: sidePanelOpen ? 'rgba(0,212,255,0.08)' : undefined,
            fontSize: 14,
          }}
        >
          TELEMETRY
        </button>
      </div>
    </div>
  );
}

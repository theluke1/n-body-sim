import { useEffect, useState } from 'react';
import type { IntegratorMode, SimConfig } from '../types';

interface Props {
  config: SimConfig;
  running: boolean;
  trailsOn: boolean;
  gridOn: boolean;
  bloomOn: boolean;
  onSend: (action: string, value?: number | string) => void;
  onUpdateConfig: (updates: Partial<SimConfig>) => void;
  onToggleTrails: () => void;
  onToggleGrid: () => void;
  onToggleBloom: () => void;
}

// Reusable slider row
function SliderRow({
  label, value, min, max, step, color = 'var(--cyan)', fmt,
  onChange, commitOnRelease = false,
}: {
  label: string; value: number; min: number; max: number; step: number;
  color?: string; fmt?: (v: number) => string;
  commitOnRelease?: boolean;
  onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const shown = commitOnRelease ? draft : value;
  const display = fmt ? fmt(shown) : shown % 1 === 0 ? String(shown) : shown.toFixed(3);
  const commit = () => {
    if (commitOnRelease && draft !== value) onChange(draft);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
      <span className="mc-label">{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={shown}
        style={{ color, width: 82 }}
        onChange={e => {
          const next = Number(e.target.value);
          if (commitOnRelease) setDraft(next);
          else onChange(next);
        }}
        onPointerUp={commit}
        onBlur={commit}
      />
      <span className="mc-value" style={{ color }}>{display}</span>
    </div>
  );
}

// Separator
const Sep = () => (
  <div style={{ width: 1, height: 36, background: 'var(--border)', flexShrink: 0, margin: '0 5px' }} />
);

const MODE_LIMITS: Record<IntegratorMode, number> = {
  realtime: 200,
  scientific: 60,
  high_accuracy: 25,
};

const MODE_LABELS: Record<IntegratorMode, string> = {
  realtime: 'Realtime',
  scientific: 'Scientific',
  high_accuracy: 'High Accuracy',
};

// Section label
function SectionLabel({ text }: { text: string }) {
  return (
    <span style={{
      fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: 1.6,
      color: 'var(--text-dim)', textTransform: 'uppercase',
      writingMode: 'horizontal-tb', flexShrink: 0, marginRight: 2,
      paddingRight: 6, borderRight: '1px solid var(--border)',
    }}>
      {text}
    </span>
  );
}

export default function ControlStrip({
  config, running, trailsOn, gridOn, bloomOn,
  onSend, onUpdateConfig, onToggleTrails, onToggleGrid, onToggleBloom,
}: Props) {
  const { N, dt, spawnRadius, massMin, massMax, velFactor, bhMass, bhEnabled, photonsOn, integratorMode } = config;
  const nMax = MODE_LIMITS[integratorMode];

  return (
    <div style={{
      minHeight: 96,
      maxHeight: 168,
      flexShrink: 0,
      background: 'var(--bg-panel)',
      borderTop: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      alignContent: 'center',
      flexWrap: 'wrap',
      padding: '10px 14px calc(10px + env(safe-area-inset-bottom))',
      gap: 8,
      overflowX: 'hidden',
      overflowY: 'auto',
      backdropFilter: 'blur(18px) saturate(1.35)',
      boxShadow: '0 -12px 38px rgba(0,0,0,0.25)',
    }}>

      {/* ── PLAYBACK ───────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <SectionLabel text="CTRL" />
        <button
          className={`mc-btn ${running ? 'mc-btn-amber mc-btn-active-amber' : 'mc-btn-green mc-btn-active-green'}`}
          onClick={() => onSend('toggle_run')}
        >
          {running ? '⏸ PAUSE' : '▶ RUN'}
        </button>
        <button
          className="mc-btn mc-btn-red"
          onClick={() => onSend('random_reset')}
          title="Generate a fresh random seed and restart the simulation."
        >
          ↺ RESET
        </button>
      </div>

      <Sep />

      {/* ── INTEGRATOR MODE ───────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <SectionLabel text="MODE" />
        {(['realtime', 'scientific', 'high_accuracy'] as IntegratorMode[]).map(mode => (
          <button
            key={mode}
            className={`mc-btn ${integratorMode === mode ? 'mc-btn-cyan mc-btn-active-cyan' : ''}`}
            onClick={() => onUpdateConfig({ integratorMode: mode })}
            title={
              mode === 'realtime'
                ? 'Smooth visual mode. Approximation activates above 120 bodies.'
                : mode === 'scientific'
                  ? 'Exact all-pairs gravity capped at 60 bodies.'
                  : 'Strict adaptive substeps capped at 25 bodies.'
            }
            style={{ fontSize: 14 }}
          >
            {MODE_LABELS[mode]}
          </button>
        ))}
      </div>

      <Sep />

      {/* ── BODIES ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
        <SectionLabel text="BODIES" />
        <SliderRow label="N" value={Math.min(N, nMax)} min={2} max={nMax} step={1}
          color="var(--cyan)" commitOnRelease onChange={v => onUpdateConfig({ N: v })} />
        <SliderRow label="R" value={spawnRadius} min={1} max={50} step={0.5}
          color="var(--cyan)" fmt={v => v.toFixed(1)} onChange={v => onUpdateConfig({ spawnRadius: v })} />
        <SliderRow label="Vel" value={velFactor} min={0} max={3} step={0.05}
          color="var(--cyan)" fmt={v => v.toFixed(2)} onChange={v => onUpdateConfig({ velFactor: v })} />
      </div>

      <Sep />

      {/* ── MASS ───────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
        <SectionLabel text="MASS" />
        <SliderRow label="Min" value={massMin} min={0.1} max={10} step={0.1}
          color="var(--blue-light)" fmt={v => v.toFixed(1)} onChange={v => onUpdateConfig({ massMin: v })} />
        <SliderRow label="Max" value={massMax} min={0.1} max={20} step={0.1}
          color="var(--blue-light)" fmt={v => v.toFixed(1)} onChange={v => onUpdateConfig({ massMax: v })} />
        <SliderRow label="dt" value={dt} min={0.0001} max={0.015} step={0.0001}
          color="var(--blue-light)" fmt={v => v.toFixed(4)} onChange={v => onUpdateConfig({ dt: v })} />
      </div>

      <Sep />

      {/* ── BLACK HOLE ─────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
        <SectionLabel text="BH" />
        <button
          className={`mc-btn ${bhEnabled ? 'mc-btn-purple mc-btn-active-amber' : ''}`}
          onClick={() => { onSend('toggle_bh'); onUpdateConfig({ bhEnabled: !bhEnabled }); }}
          style={{ fontSize: 14 }}
        >
          {bhEnabled ? '◉ BH ON' : '○ BH OFF'}
        </button>
        <SliderRow label="M" value={bhMass} min={10} max={5000} step={10}
          color="var(--purple)" fmt={v => String(Math.round(v))} onChange={v => onUpdateConfig({ bhMass: v })} />
      </div>

      <Sep />

      {/* ── PHOTONS ────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <SectionLabel text="PHOT" />
        <button
          className={`mc-btn ${photonsOn ? 'mc-btn-cyan mc-btn-active-cyan' : ''}`}
          onClick={() => { onSend('toggle_photons'); onUpdateConfig({ photonsOn: !photonsOn }); }}
          style={{ fontSize: 14 }}
        >
          {photonsOn ? '◉ ON' : '○ OFF'}
        </button>
        <button
          className="mc-btn mc-btn-cyan"
          onClick={() => {
            if (!bhEnabled) {
              onSend('toggle_bh');
              onUpdateConfig({ bhEnabled: true });
            }
            if (!photonsOn) {
              onSend('toggle_photons');
              onUpdateConfig({ photonsOn: true });
            }
            window.setTimeout(() => window.dispatchEvent(new Event('nbody:fire-photons')), 50);
          }}
          style={{ fontSize: 14 }}
        >
          ✦ FIRE
        </button>
        <button className="mc-btn" onClick={() => onSend('clear_photons')} style={{ fontSize: 14 }}>
          CLEAR
        </button>
      </div>

      <Sep />

      {/* ── VISUAL ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <SectionLabel text="VFX" />
        <button
          className={`mc-btn ${trailsOn ? 'mc-btn-green mc-btn-active-green' : ''}`}
          onClick={onToggleTrails}
          style={{ fontSize: 14 }}
        >
          TRAILS
        </button>
        <button
          className={`mc-btn ${gridOn ? 'mc-btn-green mc-btn-active-green' : ''}`}
          onClick={onToggleGrid}
          style={{ fontSize: 14 }}
        >
          GRID
        </button>
        {/* Bloom toggle: turn off to reclaim ~5ms/frame on low-spec Macs. */}
        <button
          className={`mc-btn ${bloomOn ? 'mc-btn-amber mc-btn-active-amber' : ''}`}
          onClick={onToggleBloom}
          style={{ fontSize: 14 }}
          title="Toggle UnrealBloomPass — disable for a meaningful FPS boost on integrated GPUs."
        >
          BLOOM
        </button>
        <button className="mc-btn" onClick={() => onSend('clear_trails')} style={{ fontSize: 14 }}>
          CLR TRAILS
        </button>
      </div>

    </div>
  );
}

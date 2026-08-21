import { useRef, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { INITIAL_STATE } from './types';
import type { SimState } from './types';
import { useSimulation } from './hooks/useSimulation';
import TopBar       from './components/TopBar';
import SimCanvas    from './components/SimCanvas';
import HUD          from './components/HUD';
import ControlStrip from './components/ControlStrip';
import SidePanel    from './components/SidePanel';
import UserGuide    from './components/UserGuide';

export default function App() {
  // Shared state ref — updated at 60fps by the worker, read by Three.js render loop
  // React state is NOT used here to avoid 60fps re-renders of the whole tree
  const stateRef = useRef<SimState>(INITIAL_STATE);

  const { uiSnap, config, log, send, updateConfig, applyPreset, selectBody } = useSimulation(stateRef);

  // UI state (low-frequency React state)
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [guideOpen,     setGuideOpen]     = useState(false);
  const [selectedBodyIndex, setSelectedBodyIndex] = useState<number | null>(null);
  const [trailsOn, setTrailsOn] = useState(true);
  const [gridOn,   setGridOn]   = useState(false);
  // Bloom is visually beautiful but expensive (~5ms/frame on M1 integrated).
  // Defaults ON because the simulation feels dead without it, but exposed as
  // a toggle in the VFX section of the control strip for low-spec or
  // battery-saving runs.
  const [bloomOn, setBloomOn] = useState(true);

  // Derive selected body from stateRef (no re-render needed, computed at render time)
  const selectedBody = selectedBodyIndex !== null
    ? (stateRef.current.bodies[selectedBodyIndex] ?? null)
    : null;

  const handleSelectBody = useCallback((index: number | null) => {
    setSelectedBodyIndex(index);
    if (index !== null) selectBody(index);
  }, [selectBody]);

  const handleToggleTrails = useCallback(() => {
    setTrailsOn(v => {
      const next = !v;
      if (!next) send('clear_trails');
      return next;
    });
  }, [send]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100vh', width: '100vw', overflow: 'hidden',
      background: 'linear-gradient(180deg, #02030a 0%, #060812 48%, #02030a 100%)',
    }}>

      {/* ── Top bar ─────────────────────────────────────────── */}
      <TopBar
        running={uiSnap.running}
        gpuActive={uiSnap.gpuActive}
        sidePanelOpen={sidePanelOpen}
        time={uiSnap.time}
        bodyCount={uiSnap.bodyCount}
        energy={uiSnap.energy}
        onToggleSidePanel={() => setSidePanelOpen(o => !o)}
        onToggleGuide={() => setGuideOpen(o => !o)}
        onPreset={applyPreset}
      />

      {/* ── Canvas area (fills remaining space) ─────────────── */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', minHeight: 0 }}>

        {/* Three.js canvas */}
        <SimCanvas
          stateRef={stateRef}
          onSelectBody={handleSelectBody}
          onSpawnPhotons={(cameraPos, cameraDir) => send('spawn_photons', { camera_pos: cameraPos, camera_dir: cameraDir })}
          showGrid={gridOn}
          showTrails={trailsOn}
          bloomOn={bloomOn}
          onCaptureFrame={(dataUrl) => {
            const a = document.createElement('a');
            a.href = dataUrl;
            a.download = `nbody-${Date.now()}.png`;
            a.click();
          }}
        />

        {/* HUD overlay */}
        <HUD snap={uiSnap} selectedBody={selectedBody} />

        {/* Tab strip (right edge) */}
        <div style={{
          position: 'absolute', right: 0, top: '50%',
          transform: 'translateY(-50%)',
          width: 46,
          background: 'rgba(5,9,20,0.74)',
          backdropFilter: 'blur(18px) saturate(1.3)',
          border: '1px solid var(--border)',
          borderRight: 'none',
          borderRadius: '8px 0 0 8px',
          display: 'flex', flexDirection: 'column',
          gap: 7, padding: '11px 7px',
          zIndex: 25,
          boxShadow: '0 18px 44px rgba(0,0,0,0.35)',
        }}>
          <TabIcon active={sidePanelOpen} title="Telemetry" onClick={() => setSidePanelOpen(o => !o)}>◉</TabIcon>
          <TabIcon active={gridOn}        title="Grid"      onClick={() => setGridOn(v => !v)}>⊞</TabIcon>
          <TabIcon active={trailsOn}      title="Trails"    onClick={handleToggleTrails}>∿</TabIcon>
        </div>

        {/* Clip container for side panel — overflow:hidden here prevents
            backdropFilter from escaping the canvas area when panel is closed */}
        <div style={{
          position: 'absolute', right: 42, top: 0, bottom: 0, width: 380,
          overflow: 'hidden', zIndex: 20,
          pointerEvents: sidePanelOpen ? 'auto' : 'none',
        }}>
          <SidePanel
            open={sidePanelOpen}
            snap={uiSnap}
            selectedBody={selectedBody}
            config={config}
            log={log}
            onSend={send}
            onUpdateConfig={updateConfig}
          />
        </div>

        {/* User guide (slides in from left) */}
        <UserGuide open={guideOpen} onClose={() => setGuideOpen(false)} />

        {/* Floating guide button (bottom-left, visible when guide is closed) */}
        {!guideOpen && (
          <motion.button
            onClick={() => setGuideOpen(true)}
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.93 }}
            title="Open User Guide"
            style={{
              position: 'absolute', bottom: 16, left: 16, zIndex: 20,
              width: 42, height: 42, borderRadius: '50%',
              background: 'rgba(5,9,20,0.82)',
              backdropFilter: 'blur(10px)',
              border: '1px solid var(--border-bright)',
              color: 'var(--text-dim)',
              fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700,
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
              transition: 'border-color 0.2s, color 0.2s',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--cyan)';
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--cyan)';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-bright)';
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-dim)';
            }}
          >
            ?
          </motion.button>
        )}
      </div>

      {/* ── Control strip ────────────────────────────────────── */}
      <ControlStrip
        config={config}
        running={uiSnap.running}
        trailsOn={trailsOn}
        gridOn={gridOn}
        bloomOn={bloomOn}
        onSend={send}
        onUpdateConfig={updateConfig}
        onToggleTrails={handleToggleTrails}
        onToggleGrid={() => setGridOn(v => !v)}
        onToggleBloom={() => setBloomOn(v => !v)}
      />

    </div>
  );
}

// Small icon button for the tab strip
function TabIcon({
  children, active, title, onClick,
}: { children: React.ReactNode; active: boolean; title: string; onClick: () => void }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: 32, height: 32,
        background: active ? 'rgba(0,212,255,0.12)' : 'transparent',
        border: `1px solid ${active ? 'var(--cyan)' : 'transparent'}`,
        borderRadius: 6,
        color: active ? 'var(--cyan)' : 'var(--text-dim)',
        fontSize: 14, cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'transform 0.16s ease, background 0.16s ease, border-color 0.16s ease, color 0.16s ease',
        boxShadow: active ? '0 0 16px rgba(0,212,255,0.2)' : undefined,
      }}
      onMouseEnter={e => (e.currentTarget.style.transform = 'translateX(-2px)')}
      onMouseLeave={e => (e.currentTarget.style.transform = 'translateX(0)')}
    >
      {children}
    </button>
  );
}

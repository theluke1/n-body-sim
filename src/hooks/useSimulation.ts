import { useEffect, useRef, useCallback, useState } from 'react';
import type { MutableRefObject } from 'react';
import { INITIAL_STATE, INITIAL_CONFIG } from '../types';
import type { SimState, SimConfig, Diagnostics, BlackHoleState } from '../types';

function downloadCSV(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// UISnap: lightweight subset of SimState for React re-renders (throttled)
export interface UISnap {
  time: number;
  energy: number;
  running: boolean;
  gpuActive: boolean;
  recordCount: number;
  selectedIndex: number | null;
  bodyCount: number;
  diagnostics: Diagnostics | null;
  blackHole: BlackHoleState | null;
}

export function useSimulation(stateRef: MutableRefObject<SimState>) {
  const workerRef  = useRef<Worker | null>(null);
  const tickRef    = useRef(0);
  const logRef     = useRef<string[]>([]);

  const [uiSnap, setUiSnap] = useState<UISnap>({
    time: 0, energy: 0, running: false, gpuActive: false,
    recordCount: 0, selectedIndex: null, bodyCount: 0, diagnostics: null,
    blackHole: null,
  });
  const [config, setConfig] = useState<SimConfig>(INITIAL_CONFIG);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    const worker = new Worker('/physics.worker.js');
    workerRef.current = worker;

    worker.onmessage = (e) => {
      const msg = e.data;

      if (msg.type === 'state') {
        const d = msg.data;
        // NOTE: worker uses snake_case field names
        // d.t           → time
        // d.black_hole  → blackHole
        // d.selected_index → selectedIndex
        // d.recorder.record_count → recordCount

        const prevCount = stateRef.current.bodies.length;

        // Fast path: update the ref that Three.js reads directly
        stateRef.current = {
          bodies:        d.bodies          ?? stateRef.current.bodies,
          photons:       d.photons         ?? stateRef.current.photons,
          blackHole:     d.black_hole !== undefined ? d.black_hole : stateRef.current.blackHole,
          time:          d.t               ?? stateRef.current.time,
          energy:        d.energy          ?? stateRef.current.energy,
          running:       d.running         ?? stateRef.current.running,
          selectedIndex: d.selected_index !== undefined ? d.selected_index : stateRef.current.selectedIndex,
          gpuActive:     stateRef.current.gpuActive,
          recordCount:   d.recorder?.record_count ?? stateRef.current.recordCount,
          diagnostics:   d.diagnostics      ?? stateRef.current.diagnostics,
        };

        // Log collision and BH absorption events from the worker's event queue.
        // The worker flushes pending_events each broadcast so we get exact counts
        // and event types rather than inferring from body-count diffs.
        if (Array.isArray(d.events) && d.events.length > 0) {
          const newEntries: string[] = [];
          for (const ev of d.events) {
            const t = (ev.t ?? d.t ?? 0).toFixed(2);
            if (ev.type === 'bh_absorption') {
              newEntries.push(`t=${t} — ${ev.count} body${ev.count > 1 ? 'ies' : ''} absorbed by black hole`);
            } else if (ev.type === 'collision') {
              newEntries.push(`t=${t} — ${ev.count} body merge`);
            }
          }
          if (newEntries.length > 0) {
            logRef.current = [...newEntries, ...logRef.current].slice(0, 50);
          }
        }

        // Slow path: React re-render every ~6 frames for UI panels
        if (++tickRef.current % 6 === 0) {
          const workerSeed = d.config?.seed;
          setConfig(prev => ({
            ...prev,
            seed: typeof workerSeed === 'number' ? workerSeed : prev.seed,
            N: typeof d.config?.N_target === 'number' ? d.config.N_target : prev.N,
            dt: typeof d.config?.dt === 'number' ? d.config.dt : prev.dt,
            eta: typeof d.config?.eta === 'number' ? d.config.eta : prev.eta,
            integratorMode: d.config?.integrator_mode ?? prev.integratorMode,
          }));
          setUiSnap({
            time:          d.t                       ?? 0,
            energy:        d.energy                  ?? 0,
            running:       d.running                 ?? false,
            gpuActive:     stateRef.current.gpuActive,
            recordCount:   d.recorder?.record_count  ?? 0,
            selectedIndex: d.selected_index          ?? null,
            bodyCount:     d.bodies?.length          ?? 0,
            diagnostics:   d.diagnostics             ?? null,
            blackHole:     d.black_hole               ?? null,
          });
          // Sync log every 30 frames
          if (tickRef.current % 30 === 0) setLog([...logRef.current]);
        }
      }

      if (msg.type === 'gpu_status') {
        stateRef.current = { ...stateRef.current, gpuActive: msg.gpu };
        setUiSnap(prev => ({ ...prev, gpuActive: msg.gpu }));
        const entry = `GPU acceleration: ${msg.gpu ? 'ON ⚡' : 'OFF'}`;
        logRef.current = [entry, ...logRef.current].slice(0, 50);
      }

      if (msg.type === 'csv_data') {
        downloadCSV(msg.csv, msg.filename);
        const entry = `CSV saved: ${msg.filename}`;
        logRef.current = [entry, ...logRef.current].slice(0, 50);
        setLog([...logRef.current]);
      }
    };

    worker.onerror = (e) => {
      console.error('[Worker]', e.message);
      const entry = `Worker error: ${e.message}`;
      logRef.current = [entry, ...logRef.current].slice(0, 50);
      setLog([...logRef.current]);
    };

    return () => { worker.terminate(); };
  }, [stateRef]);

  // send: fire-and-forget action to the worker
  const send = useCallback((action: string, value: number | string | Record<string, unknown> = 0) => {
    // Clear the event log whenever the user resets the simulation so stale
    // entries from the previous run don't carry over.
    if (action === 'random_reset' || action === 'reset') {
      logRef.current = [];
      setLog([]);
    }
    if (typeof value === 'object' && value !== null) {
      workerRef.current?.postMessage({ action, ...value });
      return;
    }
    workerRef.current?.postMessage({ action, value });
  }, []);

  // updateConfig: update local config state + notify worker
  const updateConfig = useCallback((updates: Partial<SimConfig>) => {
    setConfig(prev => {
      const next = { ...prev, ...updates };
      const w = workerRef.current;
      if (!w) return next;
      // NOTE: worker action names (from physics.worker.js onmessage handler)
      if ('N'            in updates) w.postMessage({ action: 'set_N',               value: updates.N });
      if ('dt'           in updates) w.postMessage({ action: 'set_dt',              value: updates.dt });
      if ('spawnRadius'  in updates) w.postMessage({ action: 'set_spawn_radius',    value: updates.spawnRadius });
      if ('massMin'      in updates) w.postMessage({ action: 'set_mass_min',        value: updates.massMin });
      if ('massMax'      in updates) w.postMessage({ action: 'set_mass_max',        value: updates.massMax });
      if ('velFactor'    in updates) w.postMessage({ action: 'set_vel_factor',      value: updates.velFactor });
      if ('bhMass'       in updates) w.postMessage({ action: 'set_bh_mass',         value: updates.bhMass });
      if ('sampleInterval' in updates) w.postMessage({ action: 'set_sample_interval', value: updates.sampleInterval });
      if ('integratorMode' in updates) {
        w.postMessage({ action: 'set_integrator_mode', mode: updates.integratorMode });
        // Mirror the worker's applyModeDefaults() immediately so sliders
        // snap to the new values without waiting for the next broadcast.
        const DEFAULTS: Record<string, { dt: number; eta: number }> = {
          realtime:      { dt: 0.0030, eta: 0.025 },
          scientific:    { dt: 0.0015, eta: 0.018 },
          high_accuracy: { dt: 0.0008, eta: 0.010 },
        };
        const d = DEFAULTS[updates.integratorMode!];
        if (d) { next.dt = d.dt; next.eta = d.eta; }
      }
      // Integrator + reproducibility knobs. Both of these trigger a
      // diagnostics-baseline reset inside the worker (see set_seed / set_eta
      // handlers in physics.worker.js) so the next frame's E₀ lines up with
      // the new configuration.
      if ('seed'           in updates) w.postMessage({ action: 'set_seed',            value: updates.seed });
      if ('eta'            in updates) w.postMessage({ action: 'set_eta',             value: updates.eta });
      return next;
    });
  }, []);

  // selectBody: tell the worker which body is selected
  const selectBody = useCallback((index: number | null) => {
    if (index !== null) workerRef.current?.postMessage({ action: 'set_selected', index });
  }, []);

  // applyPreset: send a preset scenario name — clears log first so the new
  // run starts with a clean slate, then adds a single "loaded" entry.
  const applyPreset = useCallback((preset: string) => {
    workerRef.current?.postMessage({ action: 'load_preset', preset });
    const entry = `Preset loaded: ${preset}`;
    logRef.current = [entry];
    setLog([entry]);
  }, []);

  return { uiSnap, config, log, send, updateConfig, applyPreset, selectBody };
}

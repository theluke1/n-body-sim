export interface BodyState {
  id: number;
  pos: [number, number, number];
  vel: [number, number, number];
  mass: number;
  color: string;       // CSS color string from worker e.g. 'hsl(240,80%,65%)'
  charge: number;
  opacity: number;
  radius: number;
  trail: [number, number, number][] | null;
}

export interface PhotonState {
  id: number;
  trail: [number, number, number][];
}

export interface BlackHoleState {
  mass: number;
  pos: [number, number, number];
  radius: number;
  ring_radius: number;
  glow_radius: number;
  event_horizon_radius: number;
  photon_sphere_radius: number;
  shadow_radius: number;
  lens_radius: number;
}

// Conservation + integrator diagnostics emitted by the physics worker.
// Used by the HUD to display the "is this simulation trustworthy?" block.
export interface Diagnostics {
  energy: number;
  energy0: number | null;   // baseline energy at run start
  energyDrift: number;      // |E - E0| / |E0|
  momentum: [number, number, number];
  angMomentum: [number, number, number];
  substeps: number;         // substeps used in last outer frame
  maxSubstepsHit: boolean;  // integrator ran out of substep budget
  rmin: number | null;      // min pairwise separation observed this frame
  seed: number;
  eta: number;
  integratorMode: IntegratorMode;
  approximationActive: boolean;
  trustLevel: 'nominal' | 'approximate' | 'stress' | 'unreliable';
}

export type IntegratorMode = 'realtime' | 'scientific' | 'high_accuracy';

export interface SimState {
  bodies: BodyState[];
  photons: PhotonState[];
  blackHole: BlackHoleState | null;
  time: number;
  energy: number;
  running: boolean;
  selectedIndex: number | null;
  gpuActive: boolean;
  recordCount: number;
  diagnostics: Diagnostics | null;
}

export interface SimConfig {
  N: number;
  dt: number;
  spawnRadius: number;
  massMin: number;
  massMax: number;
  velFactor: number;
  bhMass: number;
  bhEnabled: boolean;
  forceMode: 'gravity';
  integratorMode: IntegratorMode;
  photonsOn: boolean;
  sampleInterval: number;
  // Integrator / reproducibility knobs. These were added in v3 and are
  // surfaced in the SYSTEM panel under "INTEGRATOR".
  //  seed — Mulberry32 PRNG seed (Tommy Ettinger, public-domain 32-bit PRNG).
  //         Any preset or reset rolls from this seed so runs are byte-exact
  //         reproducible given the same {N, seed, scenario}.
  //  eta  — Aarseth time-step safety factor used inside estimateSubstepDt.
  //         Smaller = more substeps = better energy conservation. 0.025 is
  //         the standard choice from Aarseth 2003 "Gravitational N-Body
  //         Simulations", §2.4 — roughly 1/40 of the closest-pair orbital
  //         period. Lower to ~0.01 for Pythagorean / hard scattering runs.
  seed: number;
  eta: number;
}

export const INITIAL_STATE: SimState = {
  bodies: [],
  photons: [],
  blackHole: null,
  time: 0,
  energy: 0,
  running: false,
  selectedIndex: null,
  gpuActive: false,
  recordCount: 0,
  diagnostics: null,
};

export const INITIAL_CONFIG: SimConfig = {
  N: 5,
  dt: 0.003,
  spawnRadius: 10,
  massMin: 0.5,
  massMax: 3.0,
  velFactor: 0.6,
  bhMass: 200,
  bhEnabled: false,
  forceMode: 'gravity',
  integratorMode: 'realtime',
  photonsOn: false,
  sampleInterval: 30,
  // 0xC0FFEE matches the worker's default rngState, so a cold-start UI run
  // is byte-identical to a worker-only run with no messages posted.
  seed: 0xC0FFEE,
  // 0.025 = Aarseth 2003 recommended η. Lower this for chaotic 3-body runs.
  eta: 0.025,
};

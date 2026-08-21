# Gravity Lens Lab

An interactive N-body gravitational simulator with real-time Schwarzschild black hole lensing, running entirely in the browser.

**[▶ Live Demo](https://gravitylenslab.netlify.app)** · **[Technical Case Study](https://gravitylenslab.netlify.app/case-study.html)** · **[Design Process](https://gravitylenslab.netlify.app/design-process.html)**

---

## What It Does

- **N-body physics** — Adaptive-substep Velocity Verlet integration with first-order post-Newtonian (1PN) corrections for relativistic effects near the black hole
- **Barnes-Hut octree** — O(N log N) 3D force approximation (θ = 0.7, GADGET-2 default) for large-N realtime mode; exact O(N²) all-pairs for scientific and high-accuracy modes
- **Schwarzschild lensing** — Per-pixel Binet geodesic integration (120 Störmer-Verlet steps), producing correct photon ring at 1.5r_s, shadow at 2.598r_s, and relativistic Doppler asymmetry
- **NFW dark matter halo** — Analytic potential for the Galaxy Core preset; toggle on/off to see the rotation curve shift from Keplerian to flat
- **Orbit stability classifier** — Random Forest trained on 3,000 simulated 3-body outcomes; virial ratio Q_init is the top predictive feature (35% Gini importance), independently validating the live telemetry display
- **Three accuracy modes** — Realtime (60fps, N up to 200), Scientific (N up to 60), High Accuracy (N up to 25, tightest adaptive timestep)

## Documentation

| Document | Description |
|---|---|
| [Technical Case Study](https://gravitylenslab.netlify.app/case-study.html) | Research-level writeup: every physics claim cited to primary source, four independent benchmarks, Figma diagrams, ML section |
| [Design Process](https://gravitylenslab.netlify.app/design-process.html) | How the project was built: physics audit, what was wrong, how it was fixed, visual design decisions |

## Tech Stack

- **React + TypeScript** — UI and state management
- **Three.js + GLSL** — 3D renderer, custom shader passes (lensing, accretion disk, Flamm's paraboloid grid)
- **Web Worker** — Physics engine runs off the main thread; maintains 60fps under scientific-accuracy mode
- **Vite** — Build tooling
- **Python / scikit-learn** — Benchmarks and orbit stability classifier (`benchmarks/`)

## Physics References

- Springel, V. (2005). GADGET-2. *MNRAS* 364:1105 — integrator and Barnes-Hut defaults
- Misner, Thorne & Wheeler (1973). *Gravitation* §25.6 — Schwarzschild photon geodesic (Binet equation)
- Hernquist, L. (1987). *ApJS* 64:715 — Barnes-Hut force error bounds (9θ²/4)
- Navarro, Frenk & White (1996/1997). *ApJ* 462:563, 490:493 — NFW dark matter halo profile
- Aarseth, S.J. (2003). *Gravitational N-Body Simulations* §2.6 — adaptive timestep criterion

## Run Locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
# output → dist/
```

## Benchmarks

```bash
cd benchmarks
pip install -r requirements.txt
python energy_conservation.py   # VV vs RK4 symplecticity
python force_error_theta.py     # Barnes-Hut opening angle vs accuracy
python photon_deflection.py     # Schwarzschild deflection vs GR
python rotation_curve.py        # NFW dark matter rotation curve
python orbit_classifier.py      # Orbit stability ML classifier
```

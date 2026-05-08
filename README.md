# Relativistic N-Body Lab

Interactive Newtonian N-body gravity simulator with realtime Schwarzschild-inspired black-hole lensing.

This is a browser-based physics and visualization project built for portfolio presentation. It combines a worker-driven gravitational simulation with a Three.js/WebGL renderer, bright body trails, adaptive integrator modes, black-hole capture zones, telemetry, and a realtime lensing shader.

## Tech Stack

- React
- TypeScript
- Vite
- Three.js
- WebGL GLSL shaders
- Web Workers

## Physics And Rendering Model

- Newtonian N-body gravity for massive bodies
- Velocity Verlet integration with adaptive substeps
- Mode caps for smooth realtime and smaller high-accuracy runs
- Schwarzschild-inspired black-hole lensing in a fragment shader
- Event horizon, photon sphere, apparent shadow, and lensing region displayed as distinct zones
- Accretion-disk Doppler brightening and ghost disk imagery for visual realism

## Limitations

This is an educational realtime simulation, not NASA-grade scientific software. It is not a full Kerr ray tracer, does not model black-hole spin or frame dragging, and does not include GRMHD plasma physics. The black-hole visuals are a performant Schwarzschild-style approximation designed for interactive use.

## Run Locally

```bash
npm install
npm run dev -- --open
```

## Build

```bash
npm run build
```

The production site is emitted to `dist`.

## Publish

For Netlify, Vercel, or similar static hosts:

```text
Build command: npm run build
Publish directory: dist
```


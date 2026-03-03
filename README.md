# N-Body Gravitational Simulation — Web App

Real-time gravitational N-body simulation rendered in the browser with Three.js.
Physics engine runs server-side in Python (FastAPI), streaming state to the
browser over WebSocket at 30 fps.

## Stack

| Layer     | Tech                                           |
|-----------|------------------------------------------------|
| Physics   | Python / NumPy (Velocity Verlet)               |
| Server    | FastAPI + uvicorn                              |
| Realtime  | WebSocket (body state broadcast at 30 fps)     |
| 3-D       | Three.js (OrbitControls, trails, BH glow)      |
| Charts    | Chart.js (energy, body count, velocity)        |
| Styling   | Quasar dark theme (custom CSS)                 |

## Quick start (local)

```bash
cd n-body-web/backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Then open **http://localhost:8000** in your browser.

## Project layout

```
n-body-web/
├── backend/
│   ├── simulation.py   # pure Python physics engine (no VPython)
│   ├── main.py         # FastAPI server, WebSocket, REST endpoints
│   └── requirements.txt
└── frontend/
    ├── index.html
    ├── style.css       # quasar dark theme
    └── main.js         # Three.js + Chart.js + WebSocket client
```

## Endpoints

| Method | Path        | Description                       |
|--------|-------------|-----------------------------------|
| GET    | `/`         | Serve frontend                    |
| WS     | `/ws`       | Bidirectional state stream        |
| POST   | `/control`  | Simulation control (see below)    |
| GET    | `/state`    | One-shot state snapshot (JSON)    |

### POST /control actions

| action               | value         |
|----------------------|---------------|
| `toggle_run`         | —             |
| `reset`              | —             |
| `clear_photons`      | —             |
| `toggle_bh`          | —             |
| `toggle_photons`     | —             |
| `set_dt`             | float         |
| `set_N`              | int           |
| `set_spawn_radius`   | float         |
| `set_mass_min`       | float         |
| `set_mass_max`       | float         |
| `set_vel_factor`     | float         |
| `set_bh_mass`        | float         |
| `toggle_recording`   | —             |
| `save_csv`           | —             |
| `set_sample_interval`| int           |

## Deploy to Railway

1. Push this folder to a GitHub repo
2. Create a new Railway project → "Deploy from GitHub"
3. Set the **root directory** to `n-body-web/backend`
4. Set the **start command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
5. Railway will install `requirements.txt` automatically
6. Your live URL will be something like `https://your-app.up.railway.app`

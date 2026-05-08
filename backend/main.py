"""
N-Body Web Server
=================
Per-session architecture: each WebSocket connection gets its own
isolated simulation that starts automatically and resets when the
visitor's tab closes.

Run locally:
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000

Deploy to Railway:
    root dir = n-body-web/backend
    start cmd = uvicorn main:app --host 0.0.0.0 --port $PORT
"""

import asyncio
import json
import time
import threading
from pathlib import Path

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from simulation import NBodySimulation, SimulationConfig

app = FastAPI(title="N-Body Sim")

PHYSICS_HZ  = 200          # physics steps per second
BROADCAST_HZ = 30          # WebSocket frames per second

# ============================================================
# Per-session simulation runner
# ============================================================

class Session:
    """
    One physics simulation per WebSocket connection.
    Physics runs in a background thread; state is broadcast from
    an asyncio task on the main event loop.
    """

    def __init__(self):
        self.config = SimulationConfig()
        self.sim = NBodySimulation(self.config)
        self.sim.generate_bodies(self.config.N_target)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._physics_loop, daemon=True)
        self._thread.start()

    def _physics_loop(self):
        interval = 1.0 / PHYSICS_HZ
        while not self._stop.is_set():
            t0 = time.perf_counter()
            if self.sim.running:
                self.sim.timestep()
                self.sim.update_photons()
                # Auto-reset if all bodies gone (keeps the demo alive)
                if len(self.sim.bodies) == 0:
                    self.sim.clear_photons()
                    self.sim.generate_bodies(self.config.N_target)
            elapsed = time.perf_counter() - t0
            wait = interval - elapsed
            if wait > 0:
                time.sleep(wait)

    def stop(self):
        self._stop.set()

    def handle_message(self, msg: dict):
        action = msg.get("action")
        v = msg.get("value", 0)
        sim = self.sim
        cfg = self.config

        if action == "toggle_run":
            sim.running = not sim.running
        elif action == "reset":
            was = sim.running
            sim.running = False
            sim.clear_bodies()
            sim.clear_photons()
            sim.recorder.clear()
            sim.sim_time = 0.0
            sim.generate_bodies(cfg.N_target)
            sim.running = was
        elif action == "clear_photons":
            sim.clear_photons()
        elif action == "toggle_bh":
            sim.toggle_black_hole()
        elif action == "toggle_photons":
            sim.photons_on = not sim.photons_on
        elif action == "set_dt":
            cfg.dt = max(1e-4, min(1e-2, float(v)))
        elif action == "set_N":
            n = max(2, min(200, int(v)))
            cfg.N_target = n
            was = sim.running
            sim.running = False
            sim.generate_bodies(n)
            sim.running = was
        elif action == "set_spawn_radius":
            cfg.spawn_radius = max(1.0, min(50.0, float(v)))
        elif action == "set_mass_min":
            cfg.mass_min = max(0.1, min(cfg.mass_max - 0.1, float(v)))
        elif action == "set_mass_max":
            cfg.mass_max = max(cfg.mass_min + 0.1, min(50.0, float(v)))
        elif action == "set_vel_factor":
            cfg.vel_factor = max(0.0, min(3.0, float(v)))
        elif action == "set_bh_mass":
            cfg.central_mass = max(10.0, min(5000.0, float(v)))
            if sim.black_hole:
                sim.black_hole.update_mass(cfg.central_mass)
        elif action == "toggle_recording":
            sim.recorder.recording = not sim.recorder.recording
        elif action == "save_csv":
            return sim.recorder.save_csv()
        elif action == "set_sample_interval":
            sim.recorder.sample_interval = max(1, min(300, int(v)))
        elif action == "set_selected":
            idx = int(msg.get("index", 0))
            if 0 <= idx < len(sim.bodies):
                sim.selected_index = idx
        elif action == "spawn_photons":
            cam = np.array(msg.get("camera_pos", [20, 0, 0]), dtype=float)
            fwd = np.array(msg.get("camera_dir", [-1, 0, 0]), dtype=float)
            sim.spawn_photons(cam, fwd)
        return None


# ============================================================
# WebSocket endpoint — one session per connection
# ============================================================

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    session = Session()
    interval = 1.0 / BROADCAST_HZ

    # Broadcast task: runs concurrently while we also listen for messages
    async def broadcast():
        while True:
            state = session.sim.get_state()
            await ws.send_text(json.dumps({"type": "state", "data": state}))
            await asyncio.sleep(interval)

    broadcast_task = asyncio.create_task(broadcast())

    try:
        async for raw in ws.iter_text():
            msg = json.loads(raw)
            result = session.handle_message(msg)
            # If save_csv, echo the filename back
            if msg.get("action") == "save_csv" and result:
                await ws.send_text(json.dumps({"type": "csv_saved", "filename": result}))
    except WebSocketDisconnect:
        pass
    finally:
        broadcast_task.cancel()
        session.stop()


# ============================================================
# Health-check (used by Railway / uptime monitors)
# ============================================================

@app.get("/health")
def health():
    return {"status": "ok"}


# ============================================================
# Static files
# ============================================================

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

    @app.get("/")
    def serve_index():
        return FileResponse(str(FRONTEND_DIR / "index.html"))

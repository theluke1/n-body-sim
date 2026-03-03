"""
N-Body Web Server
=================
FastAPI application that:
  - Runs the physics simulation in a background thread
  - Streams state to all connected WebSocket clients at ~30 fps
  - Exposes REST endpoints to control the simulation
  - Serves the static frontend (HTML/CSS/JS)

Run locally:
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000

Then open http://localhost:8000
"""

import asyncio
import json
import threading
import time
import os
from pathlib import Path
from typing import Set

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

from simulation import NBodySimulation, SimulationConfig

# ============================================================
# App & simulation setup
# ============================================================

app = FastAPI(title="N-Body Sim")

config = SimulationConfig()
sim = NBodySimulation(config)
sim.generate_bodies(config.N_target)

# WebSocket connection pool
_clients: Set[WebSocket] = set()
_clients_lock = asyncio.Lock()

# ============================================================
# Physics loop (runs in a background thread)
# ============================================================

# How many physics steps per second. Independent of broadcast rate.
PHYSICS_HZ = 200
_physics_dt = 1.0 / PHYSICS_HZ

def _physics_loop():
    while True:
        t0 = time.perf_counter()
        if sim.running:
            sim.timestep()
            sim.update_photons()
        elapsed = time.perf_counter() - t0
        sleep_for = _physics_dt - elapsed
        if sleep_for > 0:
            time.sleep(sleep_for)

threading.Thread(target=_physics_loop, daemon=True).start()

# ============================================================
# WebSocket broadcast loop (runs in asyncio event loop)
# ============================================================

BROADCAST_HZ = 30
_broadcast_interval = 1.0 / BROADCAST_HZ


async def _broadcast_loop():
    while True:
        await asyncio.sleep(_broadcast_interval)
        if not _clients:
            continue
        state = sim.get_state()
        payload = json.dumps({"type": "state", "data": state})
        dead = set()
        async with _clients_lock:
            for ws in _clients:
                try:
                    await ws.send_text(payload)
                except Exception:
                    dead.add(ws)
            _clients.difference_update(dead)


@app.on_event("startup")
async def _startup():
    asyncio.create_task(_broadcast_loop())

# ============================================================
# WebSocket endpoint
# ============================================================

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    async with _clients_lock:
        _clients.add(ws)
    # Send initial state immediately
    await ws.send_text(json.dumps({"type": "state", "data": sim.get_state()}))
    try:
        async for message in ws.iter_text():
            _handle_ws_message(json.loads(message))
    except WebSocketDisconnect:
        pass
    finally:
        async with _clients_lock:
            _clients.discard(ws)


def _handle_ws_message(msg: dict):
    """Process control messages sent from the browser over WS."""
    action = msg.get("action")
    if action == "set_selected":
        idx = msg.get("index", 0)
        if 0 <= idx < len(sim.bodies):
            sim.selected_index = idx
    elif action == "spawn_photons":
        cam = np.array(msg.get("camera_pos", [20, 0, 0]), dtype=float)
        fwd = np.array(msg.get("camera_dir", [-1, 0, 0]), dtype=float)
        sim.spawn_photons(cam, fwd)


# ============================================================
# REST control endpoints
# ============================================================

class ControlPayload(BaseModel):
    action: str
    value: float = 0.0


@app.post("/control")
def control(payload: ControlPayload):
    a = payload.action
    v = payload.value

    if a == "toggle_run":
        sim.running = not sim.running
    elif a == "reset":
        was = sim.running
        sim.running = False
        sim.clear_bodies()
        sim.recorder.clear()
        sim.sim_time = 0.0
        sim.generate_bodies(config.N_target)
        sim.running = was
    elif a == "clear_photons":
        sim.clear_photons()
    elif a == "toggle_bh":
        sim.toggle_black_hole()
    elif a == "toggle_photons":
        sim.photons_on = not sim.photons_on
    elif a == "set_dt":
        config.dt = max(1e-4, min(1e-2, v))
    elif a == "set_N":
        n = max(2, min(200, int(v)))
        config.N_target = n
        was = sim.running
        sim.running = False
        sim.generate_bodies(n)
        sim.running = was
    elif a == "set_spawn_radius":
        config.spawn_radius = max(1.0, min(50.0, v))
    elif a == "set_mass_min":
        config.mass_min = max(0.1, min(config.mass_max - 0.1, v))
    elif a == "set_mass_max":
        config.mass_max = max(config.mass_min + 0.1, min(50.0, v))
    elif a == "set_vel_factor":
        config.vel_factor = max(0.0, min(3.0, v))
    elif a == "set_bh_mass":
        config.central_mass = max(10.0, min(5000.0, v))
        if sim.black_hole:
            sim.black_hole.update_mass(config.central_mass)
    elif a == "toggle_recording":
        sim.recorder.recording = not sim.recorder.recording
    elif a == "save_csv":
        filename = sim.recorder.save_csv()
        return {"ok": True, "filename": filename}
    elif a == "set_sample_interval":
        sim.recorder.sample_interval = max(1, min(300, int(v)))

    return {"ok": True, "running": sim.running}


@app.get("/state")
def get_state():
    return sim.get_state()

# ============================================================
# Static files (serve frontend)
# ============================================================

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

    @app.get("/")
    def serve_index():
        return FileResponse(str(FRONTEND_DIR / "index.html"))

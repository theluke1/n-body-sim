"""
N-Body Gravitational Simulation — Pure Physics Engine
======================================================
No VPython or rendering dependencies. Designed to be driven by a
FastAPI + WebSocket server that streams state to a Three.js frontend.

Physics:
- Newtonian N-body (Velocity Verlet)
- Schwarzschild metric for photon geodesics (gravitational lensing)
- Momentum-conserving body merges on collision
- Black hole absorption with mass growth

Units: AU, solar masses, years.  G = 4π²
"""

import numpy as np
import random
import csv
import time
from datetime import datetime
from typing import List, Optional, Tuple
from dataclasses import dataclass, field


# ============================================================
# CONFIGURATION
# ============================================================

@dataclass
class SimulationConfig:
    """All tunable simulation parameters."""
    # Physical constants
    G: float = 4 * np.pi**2          # AU³ / (M_☉ · yr²)

    # Integrator
    dt: float = 0.001
    eps: float = 5e-2                 # Softening length
    max_speed: float = 200.0

    # Body generation
    N_target: int = 5
    spawn_radius: float = 10.0
    mass_min: float = 0.5
    mass_max: float = 3.0
    vel_factor: float = 0.6

    # Black hole
    central_mass: float = 200.0
    central_pos: np.ndarray = field(default_factory=lambda: np.zeros(3))
    central_soft: float = 1e-2
    bh_capture_radius: float = 0.35

    # Collisions
    collisions_on: bool = True
    collide_radius: float = 0.2

    # Photon / GR
    N_photons: int = 20
    photon_trail_length: int = 120
    beam_spread: float = 0.03
    rs_target: float = 0.25
    dphi_max: float = 0.02

    def __post_init__(self):
        self.c_sim = np.sqrt(2.0 * self.G * self.central_mass / self.rs_target)


# ============================================================
# PHYSICS UTILITIES
# ============================================================

class PhysicsUtils:
    @staticmethod
    def rand_unit() -> np.ndarray:
        v = np.random.normal(size=3)
        return v / (np.linalg.norm(v) + 1e-12)

    @staticmethod
    def unit(v: np.ndarray) -> np.ndarray:
        return v / (np.linalg.norm(v) + 1e-12)

    @staticmethod
    def compute_acceleration(
        pos: np.ndarray, m: np.ndarray,
        G: float, eps: float,
        central_on: bool = False,
        central_mass: float = 0.0,
        central_pos: Optional[np.ndarray] = None,
        central_soft: float = 0.0
    ) -> np.ndarray:
        dr = pos[np.newaxis, :, :] - pos[:, np.newaxis, :]
        r2 = np.sum(dr * dr, axis=-1) + eps * eps
        np.fill_diagonal(r2, np.inf)
        inv_r3 = 1.0 / (r2 * np.sqrt(r2))
        acc = G * np.sum(dr * inv_r3[:, :, np.newaxis] * m[np.newaxis, :, np.newaxis], axis=1)

        if central_on and central_pos is not None:
            drc = central_pos - pos
            r2c = np.sum(drc * drc, axis=1) + central_soft**2
            inv_r3c = 1.0 / (r2c * np.sqrt(r2c))
            acc += G * central_mass * drc * inv_r3c[:, None]

        return acc

    @staticmethod
    def make_plane_basis(rvec: np.ndarray, ndir: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        er0 = PhysicsUtils.unit(rvec)
        h = np.cross(rvec, ndir)
        if np.linalg.norm(h) < 1e-12:
            tmp = np.array([0.0, 0.0, 1.0])
            if abs(np.dot(tmp, er0)) > 0.9:
                tmp = np.array([0.0, 1.0, 0.0])
            h = np.cross(er0, tmp)
        h = PhysicsUtils.unit(h)
        et0 = PhysicsUtils.unit(np.cross(h, er0))
        return er0, et0


# ============================================================
# ENTITIES
# ============================================================

class CelestialBody:
    _id_counter = 0

    def __init__(self, pos: np.ndarray, vel: np.ndarray, mass: float,
                 color: str = "#ffffff"):
        CelestialBody._id_counter += 1
        self.id = CelestialBody._id_counter
        self.pos = pos.copy()
        self.vel = vel.copy()
        self.mass = mass
        self.color = color
        self.alive = True
        self.opacity = 1.0
        # Trail: list of [x,y,z] positions (capped)
        self.trail: List[List[float]] = []
        self._trail_max = 80

    def update_position(self, new_pos: np.ndarray):
        self.pos = new_pos.copy()
        self.trail.append(self.pos.tolist())
        if len(self.trail) > self._trail_max:
            self.trail.pop(0)

    def update_velocity(self, new_vel: np.ndarray):
        self.vel = new_vel.copy()

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "pos": self.pos.tolist(),
            "vel": self.vel.tolist(),
            "mass": float(self.mass),
            "color": self.color,
            "opacity": float(self.opacity),
            "radius": float(0.08 * (self.mass ** (1/3))),
            "trail": self.trail[-20:],  # last 20 points for wire trail
        }


class Photon:
    _id_counter = 0

    def __init__(self, u: float, up: float, phi: float, b: float,
                 er0: np.ndarray, et0: np.ndarray):
        Photon._id_counter += 1
        self.id = Photon._id_counter
        self.u = u
        self.up = up
        self.phi = phi
        self.b = b
        self.er0 = er0.copy()
        self.et0 = et0.copy()
        self.alive = True
        self.trail: List[List[float]] = []
        self._trail_max = 120

    def get_position(self, central_pos: np.ndarray) -> Optional[np.ndarray]:
        if self.u <= 0:
            return None
        r = 1.0 / self.u
        return central_pos + r * (np.cos(self.phi) * self.er0 + np.sin(self.phi) * self.et0)

    def to_dict(self, central_pos: np.ndarray) -> dict:
        pos = self.get_position(central_pos)
        return {
            "id": self.id,
            "pos": pos.tolist() if pos is not None else [0, 0, 0],
            "trail": self.trail[-40:],
        }


class BlackHole:
    def __init__(self, mass: float, pos: np.ndarray):
        self.mass = mass
        self.pos = pos.copy()

    def update_mass(self, new_mass: float):
        self.mass = new_mass

    def to_dict(self) -> dict:
        base_radius = 0.3 * (self.mass / 50.0) ** (1/3)
        return {
            "mass": float(self.mass),
            "pos": self.pos.tolist(),
            "radius": float(base_radius),
            "ring_radius": float(base_radius * 1.10),
            "glow_radius": float(base_radius * 2.0),
        }


# ============================================================
# DATA RECORDER
# ============================================================

class DataRecorder:
    def __init__(self, sample_interval: int = 30):
        self.sample_interval = sample_interval
        self.records: list = []
        self.recording: bool = False
        self._frame: int = 0
        self.sim_time: float = 0.0

    def step(self, bodies: list, dt: float):
        self.sim_time += dt
        if not self.recording:
            return
        self._frame += 1
        if self._frame % self.sample_interval == 0:
            for body_id, body in enumerate(bodies):
                self.records.append({
                    "time": round(self.sim_time, 5),
                    "body_id": body_id,
                    "x": round(float(body.pos[0]), 4),
                    "y": round(float(body.pos[1]), 4),
                    "z": round(float(body.pos[2]), 4),
                    "vx": round(float(body.vel[0]), 4),
                    "vy": round(float(body.vel[1]), 4),
                    "vz": round(float(body.vel[2]), 4),
                    "mass": round(float(body.mass), 4),
                })

    def save_csv(self, filename: str = None) -> str:
        if not self.records:
            return ""
        if filename is None:
            filename = f"nbody_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        with open(filename, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=self.records[0].keys())
            writer.writeheader()
            writer.writerows(self.records)
        return filename

    def clear(self):
        self.records.clear()
        self._frame = 0
        self.sim_time = 0.0


# ============================================================
# BODY COLOR PALETTE
# ============================================================

_BODY_COLORS = [
    "#ff6b6b", "#ffd93d", "#6bcb77", "#4d96ff",
    "#c77dff", "#f72585", "#4cc9f0", "#f8961e",
    "#90e0ef", "#a8dadc",
]

def _pick_color() -> str:
    return random.choice(_BODY_COLORS)


# ============================================================
# SIMULATION ENGINE
# ============================================================

class NBodySimulation:
    def __init__(self, config: SimulationConfig):
        self.config = config
        self.bodies: List[CelestialBody] = []
        self.black_hole: Optional[BlackHole] = None
        self.photons: List[Photon] = []

        self.central_on = False
        self.running = True
        self.photons_on = False

        self.selected_index = 0

        self.recorder = DataRecorder()

        # Sim-time accumulator (seconds of sim time elapsed)
        self.sim_time: float = 0.0

    # ----------------------------------------------------------
    # Body management
    # ----------------------------------------------------------

    def add_body(self, pos: np.ndarray, vel: np.ndarray, mass: float) -> CelestialBody:
        body = CelestialBody(pos, vel, mass, color=_pick_color())
        self.bodies.append(body)
        return body

    def generate_bodies(self, n: int):
        self.clear_bodies()
        pos_arr = (np.random.rand(n, 3) * 2 - 1) * self.config.spawn_radius
        masses = self.config.mass_min + (
            self.config.mass_max - self.config.mass_min
        ) * np.random.rand(n)
        vmax = self.config.vel_factor * self._safe_vmax()

        for i in range(n):
            vel = PhysicsUtils.rand_unit() * (np.random.rand() * vmax)
            if self.central_on and self.black_hole:
                vel += self._compute_orbital_velocity(pos_arr[i])
            self.add_body(pos_arr[i], vel, masses[i])

    def clear_bodies(self):
        self.bodies.clear()

    def _safe_vmax(self) -> float:
        if self.central_on and self.black_hole:
            Mref = self.black_hole.mass
        else:
            Mref = max(1.0, self.config.N_target * 0.5 * (
                self.config.mass_min + self.config.mass_max
            ))
        rref = max(0.5, self.config.spawn_radius)
        return np.sqrt(self.config.G * Mref / rref)

    def _compute_orbital_velocity(self, pos: np.ndarray) -> np.ndarray:
        rel = pos - self.config.central_pos
        r = np.linalg.norm(rel) + 1e-9
        t_hat = np.array([-rel[1], rel[0], 0.0])
        t_norm = np.linalg.norm(t_hat)
        if t_norm < 1e-12:
            t_hat = np.cross(rel, np.array([0.0, 1.0, 0.0]))
            t_norm = np.linalg.norm(t_hat)
        t_hat /= (t_norm + 1e-12)
        speed = np.sqrt(self.config.G * self.black_hole.mass / r)
        return t_hat * speed

    # ----------------------------------------------------------
    # Black hole
    # ----------------------------------------------------------

    def toggle_black_hole(self):
        self.central_on = not self.central_on
        if self.central_on:
            if self.black_hole is None:
                self.black_hole = BlackHole(
                    self.config.central_mass, self.config.central_pos
                )
            self._apply_orbital_velocities()
        else:
            self.black_hole = None

    def _apply_orbital_velocities(self, strength: float = 1.0):
        if not (self.central_on and self.black_hole):
            return
        for body in self.bodies:
            rel = body.pos - self.config.central_pos
            r = np.linalg.norm(rel) + 1e-12
            tmp = PhysicsUtils.rand_unit()
            for _ in range(3):
                if abs(np.dot(tmp, rel / r)) <= 0.95:
                    break
                tmp = PhysicsUtils.rand_unit()
            t_hat = np.cross(tmp, rel)
            t_norm = np.linalg.norm(t_hat)
            if t_norm < 1e-12:
                axis = np.array([0.0, 0.0, 1.0])
                if abs(np.dot(axis, rel / r)) > 0.95:
                    axis = np.array([0.0, 1.0, 0.0])
                t_hat = np.cross(axis, rel)
                t_norm = np.linalg.norm(t_hat)
            t_hat /= (t_norm + 1e-12)
            if np.random.rand() < 0.5:
                t_hat = -t_hat
            speed = np.sqrt(self.config.G * self.black_hole.mass / r)
            body.update_velocity(t_hat * (strength * speed))

    # ----------------------------------------------------------
    # Physics step
    # ----------------------------------------------------------

    def handle_collisions(self):
        if not self.config.collisions_on or len(self.bodies) < 2:
            return
        to_remove = set()
        for i in range(len(self.bodies)):
            if i in to_remove:
                continue
            for j in range(i + 1, len(self.bodies)):
                if j in to_remove:
                    continue
                dist = np.linalg.norm(self.bodies[j].pos - self.bodies[i].pos)
                if dist < self.config.collide_radius:
                    mi, mj = self.bodies[i].mass, self.bodies[j].mass
                    m_new = mi + mj
                    self.bodies[i].update_position(
                        (mi * self.bodies[i].pos + mj * self.bodies[j].pos) / m_new
                    )
                    self.bodies[i].update_velocity(
                        (mi * self.bodies[i].vel + mj * self.bodies[j].vel) / m_new
                    )
                    self.bodies[i].mass = m_new
                    to_remove.add(j)
        for j in sorted(to_remove, reverse=True):
            del self.bodies[j]

    def handle_black_hole_absorption(self):
        if not (self.central_on and self.black_hole):
            return
        absorbed_mass = 0.0
        to_remove = []
        fade_radius = 2.0 * self.config.bh_capture_radius

        for i, body in enumerate(self.bodies):
            r = np.linalg.norm(body.pos - self.config.central_pos)
            if r <= self.config.bh_capture_radius:
                absorbed_mass += body.mass
                to_remove.append(i)
            elif r < fade_radius:
                frac = (r - self.config.bh_capture_radius) / self.config.bh_capture_radius
                body.opacity = max(0.0, min(1.0, frac))
            else:
                body.opacity = 1.0

        for i in reversed(to_remove):
            del self.bodies[i]

        if absorbed_mass > 0:
            new_mass = self.black_hole.mass + absorbed_mass
            self.black_hole.update_mass(new_mass)
            self.config.central_mass = new_mass

    def total_energy(self) -> float:
        if not self.bodies:
            return 0.0
        pos = np.array([b.pos for b in self.bodies])
        vel = np.array([b.vel for b in self.bodies])
        m = np.array([b.mass for b in self.bodies])

        ke = 0.5 * np.sum(m * np.sum(vel**2, axis=1))

        dr = pos[np.newaxis, :, :] - pos[:, np.newaxis, :]
        r2 = np.sum(dr * dr, axis=-1) + self.config.eps**2
        np.fill_diagonal(r2, np.inf)
        pe = -0.5 * self.config.G * np.sum(m[:, None] * m[None, :] / np.sqrt(r2))

        if self.central_on and self.black_hole:
            drc = pos - self.config.central_pos
            rc = np.sqrt(np.sum(drc * drc, axis=1) + self.config.central_soft**2)
            pe += -self.config.G * self.black_hole.mass * np.sum(m / rc)

        return float(ke + pe)

    def timestep(self):
        if not self.running or len(self.bodies) == 0:
            return

        pos = np.array([b.pos for b in self.bodies])
        vel = np.array([b.vel for b in self.bodies])
        m = np.array([b.mass for b in self.bodies])

        acc0 = PhysicsUtils.compute_acceleration(
            pos, m, self.config.G, self.config.eps,
            self.central_on, self.config.central_mass,
            self.config.central_pos, self.config.central_soft
        )
        pos = pos + vel * self.config.dt + 0.5 * acc0 * self.config.dt**2
        acc1 = PhysicsUtils.compute_acceleration(
            pos, m, self.config.G, self.config.eps,
            self.central_on, self.config.central_mass,
            self.config.central_pos, self.config.central_soft
        )
        vel = vel + 0.5 * (acc0 + acc1) * self.config.dt

        speeds = np.linalg.norm(vel, axis=1)
        too_fast = speeds > self.config.max_speed
        if np.any(too_fast):
            vel[too_fast] *= (self.config.max_speed / (speeds[too_fast] + 1e-12))[:, None]

        if not (np.isfinite(pos).all() and np.isfinite(vel).all()):
            return

        for body, p, v in zip(self.bodies, pos, vel):
            body.update_position(p)
            body.update_velocity(v)

        self.handle_black_hole_absorption()
        self.handle_collisions()
        self.recorder.step(self.bodies, self.config.dt)
        self.sim_time += self.config.dt

    # ----------------------------------------------------------
    # Photon step (Schwarzschild geodesics)
    # ----------------------------------------------------------

    def update_photons(self):
        if not (self.photons_on and self.central_on and self.black_hole):
            return

        c_sim = np.sqrt(2.0 * self.config.G * self.black_hole.mass / self.config.rs_target)
        rs = 2.0 * self.config.G * self.black_hole.mass / (c_sim**2)
        r_absorb = 1.05 * rs
        MAX_SUBSTEPS = 60
        MAX_DPHI = 0.25

        def f(u):
            return 1.5 * rs * u * u - u

        for photon in self.photons[:]:
            if not photon.alive or not np.isfinite(photon.u) or photon.u <= 0:
                photon.alive = False
                self.photons.remove(photon)
                continue

            r = 1.0 / photon.u
            if r <= r_absorb:
                photon.alive = False
                self.photons.remove(photon)
                continue

            dphi = (c_sim * photon.b / (r * r + 1e-12)) * self.config.dt
            dphi = max(-MAX_DPHI, min(MAX_DPHI, dphi))
            nsub = min(int(abs(dphi) / self.config.dphi_max) + 1, MAX_SUBSTEPS)
            h = dphi / nsub

            u, up = photon.u, photon.up
            for _ in range(nsub):
                up_half = up + 0.5 * f(u) * h
                u_new = u + up_half * h
                up_new = up_half + 0.5 * f(u_new) * h
                photon.phi += h
                u, up = u_new, up_new
                if not np.isfinite(u) or u <= 0 or 1.0 / u <= r_absorb:
                    u = -1.0
                    break

            photon.u = u
            photon.up = up

            if not np.isfinite(u) or u <= 0:
                photon.alive = False
                self.photons.remove(photon)
                continue

            pos = photon.get_position(self.config.central_pos)
            if pos is not None:
                photon.trail.append(pos.tolist())
                if len(photon.trail) > photon._trail_max:
                    photon.trail.pop(0)

    def spawn_photons(self, camera_pos: np.ndarray, camera_dir: np.ndarray,
                      n: Optional[int] = None):
        if not (self.central_on and self.black_hole):
            return
        if n is None:
            n = self.config.N_photons
        self.clear_photons()

        for _ in range(n):
            spread = PhysicsUtils.rand_unit() * self.config.beam_spread
            ndir = PhysicsUtils.unit(camera_dir + spread)
            x0 = camera_pos + ndir * 0.2
            rvec = x0 - self.config.central_pos
            r0 = np.linalg.norm(rvec) + 1e-12
            er0, et0 = PhysicsUtils.make_plane_basis(rvec, ndir)
            n_r = float(np.dot(ndir, er0))
            n_t = float(np.dot(ndir, et0))
            b_imp = max(1e-6, r0 * abs(n_t))
            u = 1.0 / r0
            up = -(n_r) / (r0 * n_t) if abs(n_t) >= 1e-8 else -np.sign(n_r) * 1e3
            photon = Photon(u, up, 0.0, b_imp, er0, et0)
            self.photons.append(photon)

    def clear_photons(self):
        self.photons.clear()

    # ----------------------------------------------------------
    # Serialisation for WebSocket
    # ----------------------------------------------------------

    def get_state(self) -> dict:
        """Return full simulation state as a JSON-serialisable dict."""
        selected = None
        if self.bodies and 0 <= self.selected_index < len(self.bodies):
            selected = self.selected_index

        return {
            "t": round(self.sim_time, 5),
            "running": self.running,
            "central_on": self.central_on,
            "photons_on": self.photons_on,
            "energy": round(self.total_energy(), 4),
            "body_count": len(self.bodies),
            "selected_index": selected,
            "bodies": [b.to_dict() for b in self.bodies],
            "black_hole": self.black_hole.to_dict() if self.black_hole else None,
            "photons": [p.to_dict(self.config.central_pos) for p in self.photons],
            "config": {
                "dt": self.config.dt,
                "N_target": self.config.N_target,
                "spawn_radius": self.config.spawn_radius,
                "mass_min": self.config.mass_min,
                "mass_max": self.config.mass_max,
                "vel_factor": self.config.vel_factor,
                "central_mass": self.config.central_mass,
                "bh_capture_radius": self.config.bh_capture_radius,
                "collisions_on": self.config.collisions_on,
            },
            "recorder": {
                "recording": self.recorder.recording,
                "record_count": len(self.recorder.records),
                "sample_interval": self.recorder.sample_interval,
            },
        }

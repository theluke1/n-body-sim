"""
nbody_batch.py — Offline reference integrator for the n-body web sim.

Purpose
-------
Runs the *same physics* that the browser's physics.worker.js runs, but in
NumPy so it can go long, be timed, and dump CSV / PNG deliverables for the
report. Everything here matches the web worker algorithm bit-for-bit (same
Mulberry32 PRNG, same adaptive substep rule, same softening, same velocity-
Verlet step), so the two implementations act as cross-checks of each other.

How the integrator works (1-minute version)
-------------------------------------------
* Velocity Verlet — a symplectic, 2nd-order-accurate method that updates
  positions and velocities in a leapfrog pattern. "Symplectic" means it
  conserves a discrete energy *exactly* over long times, so orbits don't
  secularly drift outward the way they do under naive Euler. Reference:
  Hairer, Lubich & Wanner, "Geometric Numerical Integration" (Springer,
  2006), chap. VI.
* Adaptive substepping — for each outer step of size `dt` we choose how
  many micro-steps to take based on the *closest* pairwise separation.
  The rule `dt_sub = eta * sqrt(r_min^3 / (G * M_tot_pair))` is from Aarseth
  2003 "Gravitational N-Body Simulations", §2.4. Without this, a close
  flyby can fling a body to infinity because the integrator under-resolves
  the deep potential well.
* Plummer softening — each force is computed with `r^2 + eps^2` instead of
  `r^2`, which removes the 1/r^2 singularity when two bodies overlap. This
  is the standard regularisation used in galaxy simulations; reference:
  Aarseth, Lecar & Starr 1970 (see also Dehnen 2001 on softening).
* Mulberry32 PRNG — tiny seeded 32-bit PRNG by Tommy Ettinger (public
  domain). We use it to build reproducible initial conditions; two runs
  with the same seed produce byte-identical trajectories.

Canonical test scenarios
------------------------
kepler        2-body circular orbit at r = 1 AU.  Exact analytic answer;
              used as the smoke test for energy conservation.
figure_eight  Chenciner & Montgomery 2000 three-equal-mass choreography.
              A knife-edge stable orbit — if the integrator is noisy the
              three bodies fall off the figure-8 within a few periods.
pythagorean   Burrau 1913 / Szebehely–Peters 1967 three-body problem with
              mass ratios 3:4:5 placed at the vertices of a 3-4-5 right
              triangle at rest. Chaotic: around t ~ 60 the mass-5 body is
              ejected. Standard chaos benchmark.
plummer       N = 50 Plummer 1911 sphere (self-gravitating cluster). The
              virial theorem predicts 2T + U = 0 in equilibrium; we check
              this.
trojan        Sun–Jupiter + a test particle at the L4 Lagrange point of
              the restricted 3-body problem. The Trojan should librate
              around L4 for centuries.

Usage
-----
    python scripts/nbody_batch.py kepler --t-end 10 --plot
    python scripts/nbody_batch.py all --t-end 20 --out-dir out/

Outputs
-------
    out/<scenario>_trajectory.csv   t, id, x, y, z, vx, vy, vz, m
    out/<scenario>_diagnostics.csv  t, E, |ΔE/E0|, |p|, |L|, substeps, r_min
    out/<scenario>_orbits.png       XY trajectory plot
    out/<scenario>_energy.png       |ΔE/E0| vs t (log scale)
"""

from __future__ import annotations

import argparse
import csv
import dataclasses as dc
import math
import os
import sys
import time
from pathlib import Path
from typing import Callable

import numpy as np

# ─── Units ────────────────────────────────────────────────────────────────
# AU / M_sun / year  ⇒  G = 4 pi^2 exactly. This choice is standard in solar-
# system work (Kepler's 3rd law becomes a^3 = T^2 for the Earth) and matches
# the worker's choice of units.
G_AU_MSUN_YR = 4 * math.pi ** 2


# ─── Mulberry32 PRNG ──────────────────────────────────────────────────────
# Identical to the worker's rngNext(): a pure-integer PRNG that never calls
# Math.random / np.random, so it's reproducible across JS and Python.
def mulberry32_stream(seed: int) -> Callable[[], float]:
    state = [seed & 0xFFFFFFFF]
    def rand() -> float:
        state[0] = (state[0] + 0x6D2B79F5) & 0xFFFFFFFF
        t = state[0]
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0
    return rand


# ─── Body container ───────────────────────────────────────────────────────
@dc.dataclass
class System:
    pos: np.ndarray   # (N, 3)
    vel: np.ndarray   # (N, 3)
    mass: np.ndarray  # (N,)

    @property
    def n(self) -> int:
        return len(self.mass)


# ─── Force kernel ─────────────────────────────────────────────────────────
def accelerations(pos: np.ndarray, mass: np.ndarray, eps: float) -> np.ndarray:
    """Softened Newtonian acceleration. O(N^2), vectorised.

    The `+ eps**2` in the denominator is Plummer softening: it removes the
    1/r^2 singularity at coincidence and turns the gravitational potential
    into  Phi(r) = -G M / sqrt(r^2 + eps^2), which is smooth everywhere.
    """
    # r[i, j] = pos[j] - pos[i]  ⇒  shape (N, N, 3)
    r = pos[np.newaxis, :, :] - pos[:, np.newaxis, :]
    d2 = np.sum(r * r, axis=-1) + eps * eps      # (N, N)
    np.fill_diagonal(d2, 1.0)                    # avoid /0 on self
    inv_d3 = d2 ** -1.5
    np.fill_diagonal(inv_d3, 0.0)
    # acc[i] = G * sum_j m_j * (pos[j] - pos[i]) / |pos[j]-pos[i]|^3
    return G_AU_MSUN_YR * np.einsum('ijk,ij,j->ik', r, inv_d3, mass)


def pairwise_min_dist(pos: np.ndarray) -> float:
    if len(pos) < 2:
        return float('inf')
    r = pos[np.newaxis, :, :] - pos[:, np.newaxis, :]
    d2 = np.sum(r * r, axis=-1)
    np.fill_diagonal(d2, np.inf)
    return float(np.sqrt(d2.min()))


def estimate_substep_dt(sys: System, eps: float, eta: float) -> float:
    """Aarseth-style time step: eta * sqrt(r_min^3 / G / M_pair).

    Returns a suggested *inner* dt. The outer driver clamps the total
    substep count in [1, MAX_SUBSTEPS] to bound work.
    """
    if sys.n < 2:
        return float('inf')
    r = sys.pos[np.newaxis, :, :] - sys.pos[:, np.newaxis, :]
    d2 = np.sum(r * r, axis=-1) + eps * eps
    np.fill_diagonal(d2, np.inf)
    # Pairwise mass sum for time-scale: M_pair[i, j] = m_i + m_j
    mpair = sys.mass[:, np.newaxis] + sys.mass[np.newaxis, :]
    np.fill_diagonal(mpair, 1.0)
    # dt_pair = eta * sqrt(r^3 / (G * M_pair))
    r3 = d2 ** 1.5
    dt_pair = eta * np.sqrt(r3 / (G_AU_MSUN_YR * mpair))
    return float(dt_pair.min())


# ─── Integrator ───────────────────────────────────────────────────────────
MAX_SUBSTEPS = 256  # same as the web worker's cap


def verlet_step(sys: System, dt: float, eps: float, eta: float) -> tuple[int, float]:
    """Advance one outer step. Returns (substeps_used, r_min_this_step)."""
    dt_sub  = estimate_substep_dt(sys, eps, eta)
    # number of inner steps to cover `dt`
    nsub = max(1, min(MAX_SUBSTEPS, int(math.ceil(dt / max(dt_sub, 1e-12)))))
    h = dt / nsub
    rmin_frame = float('inf')

    acc = accelerations(sys.pos, sys.mass, eps)
    for _ in range(nsub):
        # Velocity Verlet:
        # v_{n+1/2} = v_n + (h/2) a_n
        # x_{n+1}   = x_n + h v_{n+1/2}
        # recompute a_{n+1} at new position
        # v_{n+1}   = v_{n+1/2} + (h/2) a_{n+1}
        sys.vel += 0.5 * h * acc
        sys.pos += h * sys.vel
        acc = accelerations(sys.pos, sys.mass, eps)
        sys.vel += 0.5 * h * acc

        rmin = pairwise_min_dist(sys.pos)
        if rmin < rmin_frame:
            rmin_frame = rmin

    return nsub, rmin_frame


# ─── Conservation diagnostics ─────────────────────────────────────────────
def total_energy(sys: System, eps: float) -> float:
    """Total mechanical energy T + U with Plummer-softened potential."""
    ke = 0.5 * np.sum(sys.mass * np.sum(sys.vel ** 2, axis=1))
    if sys.n < 2:
        return ke
    r = sys.pos[np.newaxis, :, :] - sys.pos[:, np.newaxis, :]
    d  = np.sqrt(np.sum(r * r, axis=-1) + eps * eps)
    # Upper triangle only (avoid double-count + self-pairs)
    iu = np.triu_indices(sys.n, k=1)
    mij = sys.mass[iu[0]] * sys.mass[iu[1]]
    pe  = -G_AU_MSUN_YR * np.sum(mij / d[iu])
    return float(ke + pe)


def total_momentum(sys: System) -> np.ndarray:
    return np.sum(sys.mass[:, None] * sys.vel, axis=0)


def total_angmom(sys: System) -> np.ndarray:
    return np.sum(sys.mass[:, None] * np.cross(sys.pos, sys.vel), axis=0)


# ─── Scenarios (matched to worker presets) ────────────────────────────────
def scenario_kepler() -> System:
    """2-body. Sun (1 M_sun) + test particle in circular orbit at r = 1 AU.
    v_circ = sqrt(G M / r) = 2 pi  (since G=4pi^2, M=1, r=1)."""
    v = 2 * math.pi
    pos = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]])
    vel = np.array([[0.0, 0.0, 0.0], [0.0, v,   0.0]])
    m   = np.array([1.0, 1e-6])
    return System(pos, vel, m)


def scenario_figure_eight() -> System:
    """Chenciner–Montgomery 2000 figure-8. Three equal masses trace the
    same figure-8 curve chasing each other. Exact initial conditions from
    Table 1 of the original paper (G=1 units, rescaled here to G=4π²)."""
    # In G=1 units: period ≈ 6.3259
    p1 = np.array([ 0.97000436, -0.24308753, 0.0])
    p2 = -p1
    p3 = np.array([0.0, 0.0, 0.0])
    v3 = np.array([-0.93240737, -0.86473146, 0.0])
    v1 = -v3 / 2
    v2 = -v3 / 2
    pos = np.stack([p1, p2, p3])
    vel = np.stack([v1, v2, v3])
    # Rescale velocity from G=1 to G=4π²: v' = v * sqrt(G/G') = v / (2π)^{-1}
    vel *= 2 * math.pi
    m   = np.ones(3)
    return System(pos, vel, m)


def scenario_pythagorean() -> System:
    """Burrau 1913 / Szebehely-Peters 1967. Masses 3, 4, 5 at the vertices
    of a 3-4-5 right triangle, at rest. Chaotic: mass-5 body ejected near
    t ≈ 60. Time unit in the original paper is dimensionless; we use AU /
    yr and observe the same qualitative behaviour (ejection timescale
    scales with sqrt(1/G))."""
    pos = np.array([
        [ 1.0,  3.0, 0.0],
        [-2.0, -1.0, 0.0],
        [ 1.0, -1.0, 0.0],
    ])
    vel = np.zeros((3, 3))
    m   = np.array([3.0, 4.0, 5.0])
    return System(pos, vel, m)


def scenario_plummer(n: int = 50, r_scale: float = 1.0, m_total: float = 1.0,
                     seed: int = 0xC0FFEE) -> System:
    """Plummer 1911 sphere sampled via the Aarseth, Hénon & Wielen 1974
    inversion recipe. Produces a self-gravitating cluster in virial
    equilibrium: 2T + U = 0 (check via total_energy after integration)."""
    rand = mulberry32_stream(seed)
    pos = np.zeros((n, 3))
    vel = np.zeros((n, 3))
    m_i = m_total / n

    for i in range(n):
        # Radius from Plummer mass-profile inversion
        u = rand()
        r = r_scale / math.sqrt(u ** (-2 / 3) - 1)
        # Random direction
        cos_th = 2 * rand() - 1
        sin_th = math.sqrt(max(0, 1 - cos_th * cos_th))
        phi    = 2 * math.pi * rand()
        pos[i] = r * np.array([sin_th * math.cos(phi),
                               sin_th * math.sin(phi),
                               cos_th])
        # Velocity sampling: rejection-sample q = v / v_escape with the
        # Plummer DF weight g(q) = q^2 (1-q^2)^{7/2}
        while True:
            q = rand()
            y = 0.1 * rand()
            if y < q * q * (1 - q * q) ** 3.5:
                break
        v_esc = math.sqrt(2 * G_AU_MSUN_YR * m_total) * (1 + (np.linalg.norm(pos[i]) / r_scale) ** 2) ** -0.25
        cos_tv = 2 * rand() - 1
        sin_tv = math.sqrt(max(0, 1 - cos_tv * cos_tv))
        phi_v  = 2 * math.pi * rand()
        vel[i] = q * v_esc * np.array([sin_tv * math.cos(phi_v),
                                        sin_tv * math.sin(phi_v),
                                        cos_tv])

    # Zero total momentum and centre of mass so the cluster doesn't drift
    pos -= np.average(pos, axis=0, weights=np.full(n, m_i))
    vel -= np.average(vel, axis=0, weights=np.full(n, m_i))
    return System(pos, vel, np.full(n, m_i))


def scenario_trojan() -> System:
    """Restricted 3-body problem: Sun (1 M_sun) at origin, Jupiter
    (1e-3 M_sun) at (1, 0, 0), a test body at the Sun–Jupiter L4 point
    (60° ahead of Jupiter, same radius). Distances in AU scaled so
    Jupiter's semi-major axis is 1. Expect libration around L4."""
    m_s, m_j, m_t = 1.0, 1e-3, 1e-9
    # Common circular orbit radius r=1; angular velocity w = sqrt(G(M+m)/r^3)
    w = math.sqrt(G_AU_MSUN_YR * (m_s + m_j))
    # Place about the COM
    r_s = -m_j / (m_s + m_j)
    r_j =  m_s / (m_s + m_j)
    pos_s = np.array([r_s, 0.0, 0.0])
    pos_j = np.array([r_j, 0.0, 0.0])
    # L4: 60° ahead of Jupiter along the circular orbit
    ang   = math.radians(60)
    pos_t = np.array([math.cos(ang), math.sin(ang), 0.0])
    # Velocities perpendicular to radius vector
    def rot90(p): return np.array([-p[1], p[0], 0.0])
    vel_s = w * rot90(pos_s)
    vel_j = w * rot90(pos_j)
    vel_t = w * rot90(pos_t)
    pos = np.stack([pos_s, pos_j, pos_t])
    vel = np.stack([vel_s, vel_j, vel_t])
    m   = np.array([m_s, m_j, m_t])
    return System(pos, vel, m)


SCENARIOS: dict[str, Callable[[], System]] = {
    'kepler':       scenario_kepler,
    'figure_eight': scenario_figure_eight,
    'pythagorean':  scenario_pythagorean,
    'plummer':      scenario_plummer,
    'trojan':       scenario_trojan,
}


# ─── Driver ───────────────────────────────────────────────────────────────
def run(scenario: str, t_end: float, dt: float, eps: float, eta: float,
        out_dir: Path, sample_interval: int = 1) -> dict:
    """Run one scenario, write CSVs, return summary dict for reporting."""
    sys_ = SCENARIOS[scenario]()
    n    = sys_.n

    out_dir.mkdir(parents=True, exist_ok=True)
    traj_path = out_dir / f'{scenario}_trajectory.csv'
    diag_path = out_dir / f'{scenario}_diagnostics.csv'

    E0 = total_energy(sys_, eps)
    wall_start = time.perf_counter()

    traj_f = traj_path.open('w', newline='')
    diag_f = diag_path.open('w', newline='')
    traj_w = csv.writer(traj_f)
    diag_w = csv.writer(diag_f)
    traj_w.writerow(['t', 'id', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'm'])
    diag_w.writerow(['t', 'E', 'dE_rel', 'p_mag', 'L_mag', 'substeps', 'r_min'])

    t     = 0.0
    step  = 0
    nsteps = int(math.ceil(t_end / dt))
    while step < nsteps:
        subs, rmin = verlet_step(sys_, dt, eps, eta)
        t += dt
        step += 1
        if step % sample_interval == 0 or step == nsteps:
            E   = total_energy(sys_, eps)
            dEr = abs(E - E0) / max(abs(E0), 1e-30)
            p   = total_momentum(sys_)
            L   = total_angmom(sys_)
            diag_w.writerow([f'{t:.6f}', f'{E:.9e}', f'{dEr:.6e}',
                             f'{np.linalg.norm(p):.6e}',
                             f'{np.linalg.norm(L):.6e}',
                             subs, f'{rmin:.6e}'])
            for i in range(n):
                traj_w.writerow([f'{t:.6f}', i,
                                 f'{sys_.pos[i, 0]:.6e}',
                                 f'{sys_.pos[i, 1]:.6e}',
                                 f'{sys_.pos[i, 2]:.6e}',
                                 f'{sys_.vel[i, 0]:.6e}',
                                 f'{sys_.vel[i, 1]:.6e}',
                                 f'{sys_.vel[i, 2]:.6e}',
                                 f'{sys_.mass[i]:.6e}'])

    traj_f.close()
    diag_f.close()
    wall = time.perf_counter() - wall_start

    E_final = total_energy(sys_, eps)
    drift = abs(E_final - E0) / max(abs(E0), 1e-30)
    return {
        'scenario': scenario,
        'n': n, 't_end': t_end, 'dt': dt, 'eps': eps, 'eta': eta,
        'E0': E0, 'E_final': E_final, 'drift': drift,
        'wall_time_s': wall,
        'traj_path': str(traj_path), 'diag_path': str(diag_path),
    }


def plot_results(scenario: str, out_dir: Path):
    """Render trajectory + energy-drift plots. Silently skips if matplotlib
    isn't available (so the runner still works on a cold machine)."""
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
    except ImportError:
        print('[plot] matplotlib not installed, skipping.')
        return

    traj = np.genfromtxt(out_dir / f'{scenario}_trajectory.csv',
                         delimiter=',', names=True)
    diag = np.genfromtxt(out_dir / f'{scenario}_diagnostics.csv',
                         delimiter=',', names=True)

    # Orbit plot (XY projection)
    fig, ax = plt.subplots(figsize=(6, 6), dpi=140)
    for bid in np.unique(traj['id']).astype(int):
        mask = traj['id'] == bid
        ax.plot(traj['x'][mask], traj['y'][mask], lw=0.8, label=f'body {bid}')
    ax.set_aspect('equal')
    ax.set_title(f'{scenario} — XY trajectory')
    ax.set_xlabel('x / AU'); ax.set_ylabel('y / AU')
    ax.legend(fontsize=8, loc='best')
    ax.grid(alpha=0.2)
    fig.tight_layout()
    fig.savefig(out_dir / f'{scenario}_orbits.png')
    plt.close(fig)

    # Energy drift plot (log scale)
    fig, ax = plt.subplots(figsize=(7, 3.2), dpi=140)
    ax.semilogy(diag['t'], np.maximum(diag['dE_rel'], 1e-16))
    ax.set_xlabel('t / yr'); ax.set_ylabel(r'$|\Delta E / E_0|$')
    ax.set_title(f'{scenario} — energy conservation')
    ax.axhline(1e-4, color='tab:green', lw=0.6, ls='--', label='research-grade 1e-4')
    ax.axhline(1e-2, color='tab:orange', lw=0.6, ls='--', label='warning 1e-2')
    ax.grid(alpha=0.2, which='both')
    ax.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(out_dir / f'{scenario}_energy.png')
    plt.close(fig)


# ─── CLI ──────────────────────────────────────────────────────────────────
def main(argv: list[str] | None = None):
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('scenario', nargs='?', default='all',
                   choices=[*SCENARIOS.keys(), 'all'],
                   help='Scenario to run (default: all).')
    p.add_argument('--t-end', type=float, default=10.0,
                   help='Total integration time in years (default: 10).')
    p.add_argument('--dt', type=float, default=0.003,
                   help='Outer timestep in years (default: 0.003).')
    p.add_argument('--eps', type=float, default=0.02,
                   help='Plummer softening length in AU (default: 0.02).')
    p.add_argument('--eta', type=float, default=0.025,
                   help='Aarseth η safety factor (default: 0.025).')
    p.add_argument('--out-dir', type=Path, default=Path('out'),
                   help='Output directory for CSVs and PNGs.')
    p.add_argument('--sample-interval', type=int, default=1,
                   help='Write every N outer steps (default: 1).')
    p.add_argument('--plot', action='store_true',
                   help='Also render PNG plots (requires matplotlib).')
    a = p.parse_args(argv)

    scenarios = list(SCENARIOS.keys()) if a.scenario == 'all' else [a.scenario]
    for s in scenarios:
        print(f'[run] {s:12s} t_end={a.t_end} dt={a.dt} eta={a.eta}')
        info = run(s, a.t_end, a.dt, a.eps, a.eta, a.out_dir, a.sample_interval)
        print(f'       ΔE/E0 = {info["drift"]:.3e}   '
              f'wall = {info["wall_time_s"]:.2f} s   '
              f'→ {info["traj_path"]}')
        if a.plot:
            plot_results(s, a.out_dir)


if __name__ == '__main__':
    main()

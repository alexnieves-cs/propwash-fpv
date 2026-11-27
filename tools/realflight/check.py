#!/usr/bin/env python3
"""Check the quad model in src/sim/quad.ts against public real-flight logs.

The sim's motor and airframe equations make five claims that a flight log can test:

1. Rotor speed follows its command through a first-order lag, faster spinning up than down
   (tauUp, tauDown).
2. Rotor speed is proportional to motor command times battery voltage.
3. Thrust is proportional to rotor speed squared.
4. Yaw comes from rotor drag torque plus the reaction to spinning rotors up and down
   (torqueRatio, rotorInertia).
5. Sideways drag is a rotor H-force linear in airspeed and rotor speed (rotorDrag) plus an
   airframe term quadratic in airspeed (cdA).

No log here flies one of the sim's airframes, so the constants are fitted to each vehicle
and the test is whether the equations explain the data, scored on flights the fit never saw.
The fitted constants are then set next to the sim's nearest airframe.

Datasets (fetched by fetch.sh, not stored in the repo):
- NanoBench (BSD-3-Clause): a Crazyflie 2.1 at 40.85 g with motion capture, IMU,
  per-motor PWM and battery voltage, logged at 100 Hz.
- ARPL data-driven-system-identification (MIT): four PX4 ULogs of a 3.35 kg quadrotor
  with IMU, angular acceleration and motor commands.

Usage: python check.py --data <dir with nanobench/ and arpl/> --out docs/realflight
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re

import numpy as np
from scipy import signal

G0 = 9.80665
RHO = 1.225
CF_MASS = 0.04085  # NanoBench README: stock 27 g plus markers and the charging deck
ARPL_MASS = 2.3 + 1.05  # sysid.ipynb in the ARPL repository


# ------------------------------------------------------------------------------------------
# The sim's airframes, read from src/sim/drone-config.ts so the comparison follows the code.

def read_airframes(path: str) -> dict[str, dict[str, float]]:
    src = open(path, encoding="utf8").read()
    out: dict[str, dict[str, float]] = {}
    for m in re.finditer(r"const (\w+): DroneConfig = \{(.*?)\n\};", src, re.S):
        body = m.group(2)
        cfg: dict[str, float] = {}
        for key in ["mass", "maxThrust", "maxOmega", "torqueRatio", "rotorInertia", "tauUp", "tauDown",
                    "rotorDrag", "propRadius", "armX", "armZ"]:
            k = re.search(rf"\n  {key}: ([0-9.eE+-]+),", body)
            if k:
                cfg[key] = float(k.group(1))
        for obj in ["inertia", "cdA"]:
            k = re.search(rf"\n  {obj}: \{{ x: ([0-9.eE+-]+), y: ([0-9.eE+-]+), z: ([0-9.eE+-]+) \}}", body)
            if k:
                cfg[obj + "X"], cfg[obj + "Y"], cfg[obj + "Z"] = (float(v) for v in k.groups())
        name = re.search(r"\n  name: '([^']+)'", body)
        cfg["name"] = name.group(1) if name else m.group(1)  # type: ignore[assignment]
        out[re.search(r"\n  id: '([^']+)'", body).group(1)] = cfg  # type: ignore[union-attr]
    return out


def sim_drag_at_hover(cfg: dict[str, float]) -> dict[str, float]:
    """The sim's sideways drag on a hovering quad, as deceleration per unit airspeed.

    quad.ts applies, per rotor, -rotorDrag * omega * v (linear in v), and on the airframe
    -0.5 * rho * |v| * cdA * v (quadratic in v). Pitch-axis drag area is cdA.z (forward).
    """
    w_hover = cfg["maxOmega"] * np.sqrt(cfg["mass"] * G0 / (4 * cfg["maxThrust"]))
    return {
        "linearPerS": 4 * cfg["rotorDrag"] * w_hover / cfg["mass"],
        "quadraticPerM": 0.5 * RHO * cfg["cdAZ"] / cfg["mass"],
        "hoverOmega": float(w_hover),
    }


# ------------------------------------------------------------------------------------------
# Signal helpers

def lag(x: np.ndarray, dt: float, tau_up: float, tau_down: float) -> np.ndarray:
    """quad.ts's rotor lag: w += (target - w) * (1 - exp(-dt / tau)), tau by direction.

    x: (N, M) targets sampled every dt. Starts settled on the first sample.
    """
    if tau_up <= 0 and tau_down <= 0:
        return x.copy()
    a_up = 1 - np.exp(-dt / tau_up) if tau_up > 0 else 1.0
    a_dn = 1 - np.exp(-dt / tau_down) if tau_down > 0 else 1.0
    if a_up == a_dn:
        b, a = [a_up], [1, -(1 - a_up)]
        return signal.lfilter(b, a, x, axis=0, zi=(1 - a_up) * x[:1])[0]
    y = np.empty_like(x)
    w = x[0].copy()
    for i in range(len(x)):
        d = x[i] - w
        w = w + d * np.where(d > 0, a_up, a_dn)
        y[i] = w
    return y


def butter_causal(x: np.ndarray, fc: float, fs: float) -> np.ndarray:
    """A sensor's second-order low-pass (Crazyflie and PX4 both use one), applied causally."""
    if fc >= fs / 2 * 0.95:
        return x
    b, a = signal.butter(2, fc, fs=fs)
    zi = signal.lfilter_zi(b, a)
    if x.ndim == 1:
        return signal.lfilter(b, a, x, zi=zi * x[0])[0]
    return signal.lfilter(b, a, x, axis=0, zi=zi[:, None] * x[:1])[0]


def smooth(x: np.ndarray, fc: float, fs: float) -> np.ndarray:
    """Zero-phase smoothing, applied identically to data and prediction so it adds no lag."""
    b, a = signal.butter(2, fc, fs=fs)
    return signal.filtfilt(b, a, x, axis=0)


def r2(y: np.ndarray, yhat: np.ndarray) -> float:
    return float(1 - np.sum((y - yhat) ** 2) / np.sum((y - y.mean()) ** 2))


def lstsq(X: np.ndarray, y: np.ndarray) -> np.ndarray:
    return np.linalg.lstsq(X, y, rcond=None)[0]


# ------------------------------------------------------------------------------------------
# NanoBench (Crazyflie 2.1)

NB_FS = 100.0


class Flight:
    def __init__(self, name: str, t, u, volts, acc, gyro, quat, vel, pz):
        self.name, self.t, self.u, self.volts = name, t, u, volts
        self.acc, self.gyro, self.quat, self.vel, self.pz = acc, gyro, quat, vel, pz
        self.rep = int(re.search(r"rep(\d+)", name).group(1)) if "rep" in name else 1  # type: ignore[union-attr]
        self.mask = self._airborne()

    def _airborne(self) -> np.ndarray:
        up = (self.pz > 0.25) & (self.u.min(axis=1) > 0.15)
        # trim 2 s off each end of every airborne stretch: take-off, landing and ground effect
        k = int(2 * NB_FS)
        trimmed = signal.convolve(up.astype(float), np.ones(2 * k + 1), mode="same") >= 2 * k + 1 - 0.5
        return trimmed


def flight_problem(f: Flight) -> str | None:
    """Why a logged flight can't be used, or None when it looks sound.

    The motor command is a 16-bit PWM value, so anything past full scale is a bad record, and a
    small quad flying these shapes doesn't pull past 4 g. Two of the fast trefoil repeats fail
    both checks.
    """
    m = f.mask
    if m.sum() < 5 * NB_FS:
        return "under 5 s airborne"
    umax = float(f.u[m].max())
    if umax > 1.0 + 1e-6:
        return f"motor command {umax:.2f} times full scale"
    amax = float(np.linalg.norm(f.acc[m], axis=1).max())
    if amax > 4 * G0:
        return f"accelerometer peak {amax / G0:.1f} g"
    return None


def sound(flights: list, dropped: dict) -> list:
    """Flights that pass flight_problem; the others go into dropped with the reason."""
    keep = []
    for f in flights:
        why = flight_problem(f)
        if why:
            dropped[f.name] = why
        else:
            keep.append(f)
    return keep


def load_nanobench(path: str) -> Flight:
    d = np.genfromtxt(path, delimiter=",", names=True)
    t = d["t"] - d["t"][0]
    u = np.stack([d[f"motor_motor_m{i}"] for i in range(1, 5)], 1) / 65535.0
    acc = np.stack([d[f"imu_acc_{a}"] for a in "xyz"], 1) * G0  # logged in g
    gyro = np.stack([d[f"imu_gyro_{a}"] for a in "xyz"], 1)
    quat = np.stack([d["qx"], d["qy"], d["qz"], d["qw"]], 1)
    vel = np.stack([d["vx"], d["vy"], d["vz"]], 1)
    return Flight(os.path.basename(path)[:-4], t, u, d["pwr_pm_vbat"], acc, gyro, quat, vel, d["pz"])


def quat_rotate_inv(q: np.ndarray, v: np.ndarray) -> np.ndarray:
    """World vector into the body frame, q as (x, y, z, w) body-to-world."""
    x, y, z, w = q.T
    qv = np.stack([-x, -y, -z], 1)
    t = 2 * np.cross(qv, v)
    return v + w[:, None] * t + np.cross(qv, t)


def stack(flights, fn):
    parts = [fn(f) for f in flights]
    return [np.concatenate(p) for p in zip(*parts)]


_rows_cache: dict = {}


def nb_angular_rows(f: Flight, tau_up: float, tau_down: float, rotor_terms: bool):
    """Regressors for angular acceleration on each axis from per-motor thrust.

    Thrust per motor is k * w^2 with w = lag(u * V). Roll and pitch are fitted from per-motor
    coefficients, which leaves the mixing geometry and signs to the data; yaw adds each
    rotor's spin-up reaction, dw/dt, when rotor_terms is set.
    """
    key = (f.name, tau_up, tau_down, rotor_terms)
    if key in _rows_cache:
        return _rows_cache[key]
    dt = 1 / NB_FS
    w = lag(f.u * f.volts[:, None], dt, tau_up, tau_down)
    X_tq = smooth(w ** 2, 15, NB_FS)
    X_wd = smooth(np.gradient(w, dt, axis=0), 15, NB_FS)
    y = smooth(np.gradient(f.gyro, dt, axis=0), 15, NB_FS)
    m = f.mask
    rows = {}
    for ax in range(3):
        cols = [X_tq, f.gyro[:, ax:ax + 1], np.ones((len(m), 1))]
        if ax == 2 and rotor_terms:
            cols.insert(1, X_wd)
        rows[ax] = (np.hstack(cols)[m], y[m, ax])
    if len(_rows_cache) > 400:
        _rows_cache.clear()
    _rows_cache[key] = rows
    return rows


def fit_angular(train, test, tau_up, tau_down, rotor_terms=True, axes=(0, 1, 2)):
    out = {}
    tr = [nb_angular_rows(f, tau_up, tau_down, rotor_terms) for f in train]
    te = [nb_angular_rows(f, tau_up, tau_down, rotor_terms) for f in test]
    for ax in axes:
        beta = lstsq(np.concatenate([r[ax][0] for r in tr]), np.concatenate([r[ax][1] for r in tr]))
        Xte = np.concatenate([r[ax][0] for r in te])
        yte = np.concatenate([r[ax][1] for r in te])
        out[ax] = {"r2": r2(yte, Xte @ beta), "beta": beta}
    return out


def nanobench(data: str, out: str, sim: dict, figs: dict) -> dict:
    files = sorted(glob.glob(os.path.join(data, "nanobench/datasets/dataset/*.csv")))
    pick = lambda pat: [f for f in files if re.search(pat, os.path.basename(f))]
    # rich excitation for the motor tests: the sysid multisine and the fast 3D shapes
    dropped: dict = {}
    dyn = sound([load_nanobench(p) for p in pick(r"^(A1b_multisine|B9_trefoil_fast_rep[1-4]\.|B10_lissajous_fast|B3_figure8_fast|B8_star_fast_rep[1-4]\.)")], dropped)
    drain = sound([load_nanobench(p) for p in pick(r"^C4_battery_drain")], dropped)
    train = [f for f in dyn if f.rep % 2 == 1]
    test = [f for f in dyn if f.rep % 2 == 0]
    res: dict = {"flights": {"motorTrain": [f.name for f in train], "motorTest": [f.name for f in test],
                             "batteryDrain": [f.name for f in drain], "dropped": dropped}}
    # Gyro units: the dataset converts to rad/s; confirm against motion capture before relying on it.
    res["gyroUnitCheck"] = gyro_scale_check(dyn, data)

    # ---- 1. motor lag from roll and pitch acceleration -------------------------------------------
    grid = [0.0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.13]
    surf = np.zeros((len(grid), len(grid)))
    for i, tu in enumerate(grid):
        for j, td in enumerate(grid):
            fit = fit_angular(train, test, tu, td, rotor_terms=False, axes=(0, 1))
            surf[i, j] = (fit[0]["r2"] + fit[1]["r2"]) / 2
    bi, bj = np.unravel_index(np.argmax(surf), surf.shape)
    sym = [surf[i, i] for i in range(len(grid))]
    gnat = sim["whoop65"]
    at_sim = fit_angular(train, test, gnat["tauUp"], gnat["tauDown"], rotor_terms=False, axes=(0, 1))
    res["lag"] = {
        "grid": grid,
        "testR2RollPitch": surf.round(4).tolist(),
        "best": {"tauUp": grid[bi], "tauDown": grid[bj], "testR2": float(surf[bi, bj])},
        "bestSymmetric": {"tau": grid[int(np.argmax(sym))], "testR2": float(max(sym))},
        "noLag": {"testR2": float(surf[0, 0])},
        "simGnat": {"tauUp": gnat["tauUp"], "tauDown": gnat["tauDown"],
                    "testR2": float((at_sim[0]["r2"] + at_sim[1]["r2"]) / 2)},
        "note": "Fitted lag includes any timing offset between the motor and IMU log blocks; it is an upper bound on rotor lag.",
    }
    tu, td = grid[bi], grid[bj]
    figs["lag_cf"] = (grid, surf, (tu, td), (gnat["tauUp"], gnat["tauDown"]))

    # trace for the figure: a test flight, roll axis
    f = test[0]
    for name, (a, b) in {"no lag": (0.0, 0.0), "fitted lag": (tu, td)}.items():
        fit = fit_angular(train, [f], a, b, rotor_terms=False, axes=(0,))
        X, y = nb_angular_rows(f, a, b, False)[0]
        figs.setdefault("trace_cf", {"t": f.t[f.mask], "y": y, "name": f.name})[name] = X @ fit[0]["beta"]

    # ---- 2. thrust: exponent on rotor speed, and voltage --------------------------------------
    res["thrust"] = thrust_fit(train + drain[:2], test + drain[2:], tu, td, figs)

    # ---- 3. yaw: rotor drag torque, with and without the spin-up reaction --------------------
    with_j = fit_angular(train, test, tu, td, rotor_terms=True, axes=(2,))[2]
    without_j = fit_angular(train, test, tu, td, rotor_terms=False, axes=(2,))[2]
    b = with_j["beta"]
    res["yaw"] = {
        "testR2WithSpinUpReaction": with_j["r2"],
        "testR2DragTorqueOnly": without_j["r2"],
        "perMotorDragTorqueCoef": b[:4].tolist(),
        "perMotorSpinUpCoef": b[4:8].tolist(),
        "signsAgree": bool(np.all(np.sign(b[:4]) == np.sign(b[4:8]))),
        "note": "quad.ts puts both reactions on the same sign per rotor: -spin * (Q + J * dw/dt).",
    }

    # ---- 4. sideways drag ----------------------------------------------------------------------
    drag_flights = sound([load_nanobench(p) for p in pick(r"^B(2_circle|7_oval|3_figure8|8_star|10_lissajous)_(fast|medium)")], dropped)
    res["drag"] = drag_fit(drag_flights, figs)
    res["drag"]["simGnat"] = sim_drag_at_hover(gnat)
    figs["drag_sim"] = res["drag"]["simGnat"]
    return res


def gyro_scale_check(flights, data) -> dict:
    """Regress the IMU gyro on motion-capture body rates: the slope should be about 1 if both are rad/s."""
    xs, ys = [], []
    for f in flights[:4]:
        d = np.genfromtxt(os.path.join(data, "nanobench/datasets/dataset", f.name + ".csv"), delimiter=",", names=True,
                          usecols=("wx_vicon", "wy_vicon", "wz_vicon"))
        v = np.stack([d["wx_vicon"], d["wy_vicon"], d["wz_vicon"]], 1)[f.mask]
        g = f.gyro[f.mask]
        xs.append(v.ravel())
        ys.append(g.ravel())
    x, y = np.concatenate(xs), np.concatenate(ys)
    return {"slopeImuOverMocap": float(np.dot(x, y) / np.dot(x, x)), "corr": float(np.corrcoef(x, y)[0, 1])}


def thrust_fit(train, test, tu, td, figs) -> dict:
    """Body-z specific force against sum over motors of lag(u * V^beta)^n."""

    # The voltage moves over seconds and the lag over tens of milliseconds, so lag the command
    # once and scale by V^beta after; the accelerometer's 30 Hz low-pass goes on the prediction.
    lagged = {f.name: np.clip(lag(f.u, 1 / NB_FS, tu, td), 0, None) for f in train + test}
    meas = {f.name: smooth(f.acc[:, 2], 15, NB_FS)[f.mask] * CF_MASS for f in train + test}

    def rows(fs, beta, n):
        X, y = [], []
        for f in fs:
            T = np.sum((lagged[f.name] * f.volts[:, None] ** beta) ** n, axis=1)
            T = smooth(butter_causal(T, 30, NB_FS), 15, NB_FS)
            X.append(T[f.mask])
            y.append(meas[f.name])
        return np.concatenate(X), np.concatenate(y)

    def score(beta, n):
        Xtr, ytr = rows(train, beta, n)
        k = float(np.dot(Xtr, ytr) / np.dot(Xtr, Xtr))
        Xte, yte = rows(test, beta, n)
        return {"r2": r2(yte, k * Xte), "rmsN": float(np.sqrt(np.mean((yte - k * Xte) ** 2))),
                "rmsPctHover": float(100 * np.sqrt(np.mean((yte - k * Xte) ** 2)) / (CF_MASS * G0))}

    betas = np.round(np.arange(0.0, 2.01, 0.1), 2)
    ns = np.round(np.arange(1.0, 3.51, 0.1), 2)
    surf = np.array([[score(b, n)["r2"] for n in ns] for b in betas])
    bi, ni = np.unravel_index(np.argmax(surf), surf.shape)

    # steady hover on the battery-drain flights: command needed against voltage
    hov = []
    for f in [x for x in train + test if x.name.startswith("C4")]:
        sp = np.linalg.norm(f.vel, axis=1)
        steady = f.mask & (sp < 0.15) & (np.abs(f.gyro).max(axis=1) < 0.3)
        # one-second bins
        b = (f.t[steady] // 1).astype(int)
        for k in np.unique(b):
            s = b == k
            if s.sum() < 50:
                continue
            hov.append((float(np.mean(f.volts[steady][s])), float(np.sqrt(np.mean(f.u[steady][s] ** 2))),
                        float(np.mean(f.acc[steady][s, 2]) * CF_MASS)))
    hov = np.array(hov)
    # thrust ~ (u V^beta)^n at constant hover thrust => log u = c - beta log V
    A = np.stack([np.ones(len(hov)), np.log(hov[:, 0])], 1)
    c, slope = lstsq(A, np.log(hov[:, 1]))
    figs["hover"] = (hov, float(-slope))
    return {
        "betaGrid": betas.tolist(), "exponentGrid": ns.tolist(), "testR2": surf.round(4).tolist(),
        "best": {"voltageExponent": float(betas[bi]), "speedExponent": float(ns[ni]), **score(betas[bi], ns[ni])},
        "simStructure": {"voltageExponent": 1.0, "speedExponent": 2.0, **score(1.0, 2.0)},
        "noVoltage": {"voltageExponent": 0.0, "speedExponent": 2.0, **score(0.0, 2.0)},
        "hoverVoltageExponent": {"beta": float(-slope), "bins": int(len(hov)),
                                 "voltsRange": [float(hov[:, 0].min()), float(hov[:, 0].max())]},
    }


def drag_fit(flights, figs) -> dict:
    """Body-frame sideways specific force against body-frame velocity, both horizontal axes pooled."""
    tr = [f for f in flights if f.rep % 2 == 1]
    te = [f for f in flights if f.rep % 2 == 0]

    def rows(fs):
        X, y, v = [], [], []
        for f in fs:
            vb = quat_rotate_inv(f.quat, f.vel)
            w = np.mean(f.u * f.volts[:, None], axis=1, keepdims=True)
            w = w / np.median(w[f.mask])  # rotor speed relative to its median in flight
            sp = np.linalg.norm(vb, axis=1, keepdims=True)
            a = smooth(f.acc[:, :2], 5, NB_FS)
            vv = smooth(vb[:, :2], 5, NB_FS)
            for ax in range(2):
                X.append(np.stack([w[f.mask, 0] * vv[f.mask, ax], sp[f.mask, 0] * vv[f.mask, ax],
                                   np.ones(f.mask.sum())], 1))
                y.append(a[f.mask, ax])
                v.append(vv[f.mask, ax])
        return np.concatenate(X), np.concatenate(y), np.concatenate(v)

    Xtr, ytr, _ = rows(tr)
    Xte, yte, vte = rows(te)
    models = {"rotorLinear": [0, 2], "airframeQuadratic": [1, 2], "both": [0, 1, 2]}
    out = {"speedRangeMs": [float(np.percentile(np.abs(vte), 50)), float(np.percentile(np.abs(vte), 99))]}
    for name, cols in models.items():
        b = lstsq(Xtr[:, cols], ytr)
        out[name] = {"testR2": r2(yte, Xte[:, cols] @ b), "coef": b.tolist()}
    b = out["both"]["coef"]
    out["fittedAtHover"] = {"linearPerS": -b[0], "quadraticPerM": -b[1],
                            "rotorLinearOnlyPerS": -out["rotorLinear"]["coef"][0]}
    figs["drag"] = (vte, yte, out["rotorLinear"]["coef"])
    return out


# ------------------------------------------------------------------------------------------
# ARPL (PX4, 3.35 kg)

ARPL_FS = 400.0


def load_arpl(path: str):
    from pyulog import ULog

    u = ULog(path, ["actuator_motors_mux", "vehicle_angular_velocity", "vehicle_acceleration"])
    get = lambda n: next(d for d in u.data_list if d.name == n).data
    am, av, ac = get("actuator_motors_mux"), get("vehicle_angular_velocity"), get("vehicle_acceleration")
    t0 = max(am["timestamp_sample"][0], av["timestamp_sample"][0], ac["timestamp_sample"][0])
    t1 = min(am["timestamp_sample"][-1], av["timestamp_sample"][-1], ac["timestamp_sample"][-1])
    t = np.arange(t0, t1, 1e6 / ARPL_FS)
    interp = lambda d, k: np.interp(t, d["timestamp_sample"], d[k])
    motors = np.stack([interp(am, f"control[{i}]") for i in range(4)], 1)
    dgyro = np.stack([interp(av, f"xyz_derivative[{i}]") for i in range(3)], 1)
    gyro = np.stack([interp(av, f"xyz[{i}]") for i in range(3)], 1)
    acc = np.stack([interp(ac, f"xyz[{i}]") for i in range(3)], 1)
    p = u.initial_parameters
    filt = {k: p.get(k) for k in ["IMU_ACCEL_CUTOFF", "IMU_GYRO_CUTOFF", "IMU_DGYRO_CUTOFF", "THR_MDL_FAC"]}
    air = np.isfinite(motors).all(axis=1) & (motors.min(axis=1) > 0.05)
    k = int(1.0 * ARPL_FS)
    air = signal.convolve(air.astype(float), np.ones(2 * k + 1), mode="same") >= 2 * k + 1 - 0.5
    return {"name": os.path.basename(path), "t": (t - t[0]) / 1e6, "u": np.nan_to_num(motors), "dgyro": dgyro,
            "gyro": gyro, "acc": acc, "mask": air, "filters": filt}


def excited(f, fs: float) -> np.ndarray:
    """Stretches where the motors are being driven apart, judged on the commands alone.

    Two of the four logs are mostly hover, where angular acceleration is vibration and the
    motors say little about it. Selecting on the commands (never on the measured response)
    keeps the comparison fair to every model.
    """
    spread = f["u"].max(axis=1) - f["u"].min(axis=1)
    k = int(0.5 * fs)
    sd = np.sqrt(np.maximum(signal.convolve(spread ** 2, np.ones(k) / k, mode="same")
                            - signal.convolve(spread, np.ones(k) / k, mode="same") ** 2, 0))
    return f["mask"] & (sd > np.percentile(sd[f["mask"]], 50))


def arpl_rows(f, tu, td, n=2.0, rotor_terms=False, part=None):
    dt = 1 / ARPL_FS
    w = lag(f["u"], dt, tu, td)
    T = np.clip(w, 0, None) ** n
    F = f["filters"]
    # angular acceleration from the gyro, so put the gyro's low-pass on the prediction as well
    Tg = butter_causal(T, F["IMU_GYRO_CUTOFF"] or 40, ARPL_FS)
    Ta = butter_causal(T, F["IMU_ACCEL_CUTOFF"] or 30, ARPL_FS)
    wdot = butter_causal(np.gradient(w, dt, axis=0), F["IMU_GYRO_CUTOFF"] or 40, ARPL_FS)
    sm = lambda x: smooth(x, 8, ARPL_FS)
    m = excited(f, ARPL_FS)
    # alternate 2 s blocks between fitting and scoring, dropping 0.1 s at each block edge so the
    # smoothing cannot carry a sample from one side to the other
    i = np.arange(len(m))
    block, pos = i // int(2 * ARPL_FS), i % int(2 * ARPL_FS)
    inner = (pos > 0.1 * ARPL_FS) & (pos < 1.9 * ARPL_FS)
    pick = {"first": (block % 2 == 0) & inner, "second": (block % 2 == 1) & inner}.get(part, np.ones(len(m), bool))
    m = m & pick
    y = sm(np.gradient(f["gyro"], dt, axis=0))
    rows = {}
    for ax in range(3):
        cols = [sm(Tg), f["gyro"][:, ax:ax + 1], np.ones((len(m), 1))]
        if ax == 2 and rotor_terms:
            cols.insert(1, sm(wdot))
        rows[ax] = (np.hstack(cols)[m], y[m, ax])
    mz = f["mask"] & pick
    rows["z"] = (np.hstack([sm(Ta), np.ones((len(m), 1))])[mz], sm(-f["acc"][:, 2])[mz])
    return rows


def arpl_fit(flights, tu, td, n=2.0, rotor_terms=False, keys=(0, 1, 2, "z")):
    """Fit on alternate 2 s blocks of every log, score on the blocks in between."""
    out = {}
    tr = [arpl_rows(f, tu, td, n, rotor_terms, "first") for f in flights]
    te = [arpl_rows(f, tu, td, n, rotor_terms, "second") for f in flights]
    for k in keys:
        b = lstsq(np.concatenate([r[k][0] for r in tr]), np.concatenate([r[k][1] for r in tr]))
        Xte = np.concatenate([r[k][0] for r in te])
        yte = np.concatenate([r[k][1] for r in te])
        out[k] = {"r2": r2(yte, Xte @ b), "beta": b}
    return out


def arpl(data: str, sim: dict, figs: dict) -> dict:
    paths = sorted(glob.glob(os.path.join(data, "arpl/logs_large/*.ulg")))
    flights = [load_arpl(p) for p in paths]
    grid = [0.0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.13]
    surf = np.zeros((len(grid), len(grid)))
    for i, tu in enumerate(grid):
        for j, td in enumerate(grid):
            fit = arpl_fit(flights, tu, td, keys=(0, 1))
            surf[i, j] = (fit[0]["r2"] + fit[1]["r2"]) / 2
    bi, bj = np.unravel_index(np.argmax(surf), surf.shape)
    tu, td = grid[bi], grid[bj]
    ns = np.round(np.arange(1.0, 5.01, 0.1), 2)
    zr = [arpl_fit(flights, tu, td, n=n, keys=("z",))["z"]["r2"] for n in ns]
    yaw_j = arpl_fit(flights, tu, td, rotor_terms=True, keys=(2,))[2]
    yaw_0 = arpl_fit(flights, tu, td, rotor_terms=False, keys=(2,))[2]
    figs["lag_arpl"] = (grid, surf, (tu, td), None)
    b = yaw_j["beta"]
    return {
        "logs": [f["name"] for f in flights], "split": "alternate 2 s blocks of every log: even blocks fit, odd blocks score",
        "px4Filters": flights[0]["filters"],
        "lag": {"grid": grid, "testR2RollPitch": surf.round(4).tolist(),
                "best": {"tauUp": tu, "tauDown": td, "testR2": float(surf[bi, bj])},
                "bestSymmetric": {"tau": grid[int(np.argmax(np.diag(surf)))], "testR2": float(np.max(np.diag(surf)))},
                "noLag": {"testR2": float(surf[0, 0])}},
        "thrustExponent": {"grid": ns.tolist(), "testR2": np.round(zr, 4).tolist(), "best": float(ns[int(np.argmax(zr))]),
                           "atTwo": float(zr[int(np.argmin(np.abs(ns - 2)))])},
        "yaw": {"testR2WithSpinUpReaction": yaw_j["r2"], "testR2DragTorqueOnly": yaw_0["r2"],
                "signsAgree": bool(np.all(np.sign(b[:4]) == np.sign(b[4:8])))},
        "note": "No battery voltage in these logs, so the voltage claim is not tested here. PX4 commands go through the ESC's own throttle mapping.",
    }


# ------------------------------------------------------------------------------------------
# Figures

def plot(figs: dict, out: str) -> list[str]:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams.update({"figure.facecolor": "#0f1115", "axes.facecolor": "#0f1115", "axes.edgecolor": "#3a3f4b",
                         "axes.labelcolor": "#d7dae0", "xtick.color": "#9aa0ab", "ytick.color": "#9aa0ab",
                         "text.color": "#e6e8ec", "font.size": 11, "axes.grid": True, "grid.color": "#262a33"})
    written = []

    def save(fig, name):
        p = os.path.join(out, name)
        fig.savefig(p, dpi=140, bbox_inches="tight")
        plt.close(fig)
        written.append(p)

    for key, title in [("lag_cf", "Crazyflie 2.1 (NanoBench)"), ("lag_arpl", "3.35 kg PX4 quad (ARPL)")]:
        if key not in figs:
            continue
        grid, surf, best, simv = figs[key]
        fig, ax = plt.subplots(figsize=(6.4, 5.2))
        ms = np.array(grid) * 1000
        im = ax.imshow(surf, origin="lower", cmap="magma", aspect="auto",
                       extent=[-0.5, len(grid) - 0.5, -0.5, len(grid) - 0.5])
        ax.set_xticks(range(len(grid)), [f"{v:.0f}" for v in ms], rotation=45)
        ax.set_yticks(range(len(grid)), [f"{v:.0f}" for v in ms])
        ax.set_xlabel("spin-down time constant, ms")
        ax.set_ylabel("spin-up time constant, ms")
        bi, bj = grid.index(best[0]), grid.index(best[1])
        ax.plot(bj, bi, "o", ms=13, mfc="none", mec="#3ee6b0", mew=2.5, label=f"best fit {best[0]*1000:.0f} / {best[1]*1000:.0f} ms")
        if simv:
            sx = np.interp(simv[1], grid, range(len(grid)))
            sy = np.interp(simv[0], grid, range(len(grid)))
            ax.plot(sx, sy, "s", ms=11, mfc="none", mec="#ffb020", mew=2.5, label=f"sim Gnat {simv[0]*1000:.0f} / {simv[1]*1000:.0f} ms")
        ax.plot([-0.5, len(grid) - 0.5], [-0.5, len(grid) - 0.5], color="#5b6270", lw=1, ls="--")
        fig.colorbar(im, ax=ax, label="roll and pitch acceleration, R² on unseen flights")
        ax.set_title(f"Motor lag, {title}")
        ax.legend(loc="upper right", facecolor="#1a1d24", edgecolor="#3a3f4b")
        save(fig, f"{key}.png")

    if "trace_cf" in figs:
        tr = figs["trace_cf"]
        t = tr["t"]
        i0 = len(t) // 2
        s = slice(i0, i0 + 400)
        fig, ax = plt.subplots(figsize=(10, 3.8))
        ax.plot(t[s] - t[s][0], tr["y"][s], color="#e6e8ec", lw=2, label="measured (IMU)")
        ax.plot(t[s] - t[s][0], tr["no lag"][s], color="#ff6b6b", lw=1.4, label="sim equations, no motor lag")
        ax.plot(t[s] - t[s][0], tr["fitted lag"][s], color="#3ee6b0", lw=1.6, label="sim equations, fitted lag")
        ax.set_xlabel("seconds")
        ax.set_ylabel("roll acceleration, rad/s²")
        ax.set_title(f"Crazyflie roll acceleration on a flight the fit never saw ({tr['name']})")
        ax.legend(facecolor="#1a1d24", edgecolor="#3a3f4b", ncol=3, loc="upper right")
        save(fig, "trace_cf.png")

    if "hover" in figs:
        hov, beta = figs["hover"]
        fig, ax = plt.subplots(figsize=(6.4, 4.6))
        ax.scatter(hov[:, 0], hov[:, 1], s=14, color="#7aa2ff", alpha=0.8, label="1 s of steady hover")
        v = np.linspace(hov[:, 0].min(), hov[:, 0].max(), 50)
        ref = np.exp(np.mean(np.log(hov[:, 1]) + np.log(hov[:, 0])))
        ax.plot(v, ref / v, color="#ffb020", lw=2, label="sim: command x voltage held constant")
        ref2 = np.exp(np.mean(np.log(hov[:, 1]) + beta * np.log(hov[:, 0])))
        ax.plot(v, ref2 / v ** beta, color="#3ee6b0", lw=2, ls="--", label=f"fit: command ~ V^-{beta:.2f}")
        ax.set_xlabel("battery voltage under load, V")
        ax.set_ylabel("motor command to hover (RMS of 4)")
        ax.set_title("Battery drain: command needed to hold a hover")
        ax.legend(facecolor="#1a1d24", edgecolor="#3a3f4b")
        save(fig, "hover_voltage_cf.png")

    if "drag" in figs:
        v, a, b = figs["drag"]
        a = a - b[1]  # take out the constant accelerometer offset the fit found
        fig, ax = plt.subplots(figsize=(6.4, 4.6))
        idx = np.random.default_rng(0).choice(len(v), size=min(6000, len(v)), replace=False)
        ax.scatter(v[idx], a[idx], s=3, color="#7aa2ff", alpha=0.25, label="measured, unseen flights")
        vv = np.linspace(np.percentile(v, 0.5), np.percentile(v, 99.5), 100)
        ax.plot(vv, b[0] * vv, color="#3ee6b0", lw=2.2, label=f"fit: rotor drag {-b[0]:.2f}/s x speed")
        if "drag_sim" in figs:
            g = figs["drag_sim"]
            ax.plot(vv, -(g["linearPerS"] * vv + g["quadraticPerM"] * np.abs(vv) * vv), color="#ffb020", lw=2,
                    ls="--", label=f"sim Gnat 65: {g['linearPerS']:.2f}/s x speed + quadratic")
        ax.set_xlabel("body-frame airspeed, m/s")
        ax.set_ylabel("sideways specific force, m/s²")
        ax.set_title("Crazyflie sideways drag")
        ax.legend(facecolor="#1a1d24", edgecolor="#3a3f4b", loc="upper right")
        save(fig, "drag_cf.png")
    return written


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", default="docs/realflight")
    ap.add_argument("--config", default="src/sim/drone-config.ts")
    ap.add_argument("--skip-arpl", action="store_true")
    ap.add_argument("--only-arpl", action="store_true", help="redo the ARPL half, keep the NanoBench half of results.json")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    sim = read_airframes(a.config)
    figs: dict = {}
    if a.only_arpl:
        res = json.load(open(os.path.join(a.out, "results.json")))
    else:
        res = {"schema": "propwash-fpv/realflight-check@1", "sim": sim, "nanobench": nanobench(a.data, a.out, sim, figs)}
    if not a.skip_arpl:
        res["arpl"] = arpl(a.data, sim, figs)
    res["figures"] = [os.path.basename(p) for p in plot(figs, a.out)]

    def clean(o):
        if isinstance(o, dict):
            return {str(k): clean(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [clean(v) for v in o]
        if isinstance(o, np.ndarray):
            return clean(o.tolist())
        if isinstance(o, (np.floating, float)):
            return round(float(o), 6)
        if isinstance(o, np.integer):
            return int(o)
        return o

    with open(os.path.join(a.out, "results.json"), "w") as fh:
        json.dump(clean(res), fh, indent=1)
    print(json.dumps(clean({k: v for k, v in res["nanobench"].items() if k not in ("flights",)}), indent=1)[:4000])
    if "arpl" in res:
        print(json.dumps(clean({k: v for k, v in res["arpl"].items() if k in ("lag", "thrustExponent", "yaw")}), indent=1)[:2500])


if __name__ == "__main__":
    main()

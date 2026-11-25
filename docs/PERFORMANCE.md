# Performance

Two different costs decide how smoothly Propwash runs:

1. **The simulation step**: flight controller, motors, aerodynamics and one Rapier physics step. It runs at a fixed 500 Hz, so a 60 fps frame runs about 8 of them.
2. **Rendering**: everything three.js draws. This needs a real GPU in a real browser.

The first is measured below on a CPU-only machine. The second is not measured yet; there is a marked section for it at the end.

## Simulation step cost

### How to run it

```bash
npm run bench
```

This runs `bench/sim-step.bench.ts` with `vitest bench` in Node, writes the raw results to `bench/last-run.json` (not committed) and prints the tables below with the machine it ran on (`bench/report.mjs`). One benchmark iteration is exactly one 2 ms step, so every figure is per step.

### What is measured

- **Flight controller only**: `FlightController.update` with synthetic gyro readings, in Angle mode. No physics.
- **Full step, flat ground**: what `Game.step` runs for the quad, `Quad.preStep` (controller, motors, aerodynamics, battery), one Rapier step and `Quad.postStep`, over a flat box collider. Each airframe has its own world.
- **Full step, terrain and 18k trees**: the same step over a stand-in for Larkspur Valley's colliders: a 420 x 420 cell height field over 1260 m (the map's 3 m grid) and 18,000 six-sided tree colliders merged into one triangle mesh, built the way `src/world/vegetation.ts` builds the real ones. The real map can't be built in Node because it needs a GPU. An estimate of the real number of trees with colliders, made in Node from the map's own placement rules with its height function standing in for the terrain mesh (and without the exclusion zone along the race course), came to about 13,300, so the stand-in is on the heavy side.

In both full-step cases the quad flies in Angle mode with altitude hold, 0.8 m/s of wind and small, constantly changing stick inputs around hover. Every 4,000 steps (8 s of sim time) it is put back at its start point, so it can't wander off. A one-off check of this scenario (40,000 steps per airframe, run with a temporary test that is not committed) showed every airframe staying airborne 2.6 to 4.9 m above the ground and within 11 m of the start, among the nearest trees, with no crashes and no landings.

Not included: race, trick and telemetry bookkeeping in `Game.step`, audio, the HUD, rendering, and garbage collection caused by anything other than the step itself.

### Machine

- CPU: Intel(R) Xeon(R) Processor @ 2.10GHz, 4 logical CPUs, 16 GB RAM (a cloud virtual machine)
- OS: Linux 6.18.44-fc-v880 (x64)
- Node v22.23.5, vitest 4.1.12 bench, Rapier (rapier3d-compat) 0.21.0
- The machine was shared with other jobs. Load average was about 5.4 to 7.6 on 4 CPUs during both runs, so the numbers are noisier and probably slower than on an idle machine.
- Date: 2026-11-25

### Results

Two runs, back to back. Times in microseconds per step.

**Flight controller only**

| Airframe | Run 1 median | Run 1 p99 | Run 2 median | Run 2 p99 |
| --- | ---: | ---: | ---: | ---: |
| Vandal 5″ | 0.8 | 1.7 | 0.8 | 1.6 |
| Kestrel R5 | 0.8 | 1.4 | 0.8 | 1.5 |
| Lantern 3″ | 0.8 | 2.2 | 0.8 | 1.5 |
| Gnat 65 | 0.8 | 1.5 | 0.8 | 1.5 |

At this size the benchmark harness's own per-call overhead is a noticeable share of the figure, so read it as "under a microsecond".

**Full step, flat ground**

| Airframe | Run 1 median | Run 1 p75 | Run 1 p99 | Run 2 median | Run 2 p75 | Run 2 p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Vandal 5″ | 12.2 | 14.2 | 58.3 | 13.0 | 16.3 | 51.2 |
| Kestrel R5 | 11.1 | 12.2 | 43.0 | 10.8 | 12.2 | 34.7 |
| Lantern 3″ | 10.6 | 12.2 | 35.1 | 10.6 | 12.2 | 39.9 |
| Gnat 65 | 12.2 | 15.3 | 44.8 | 10.7 | 11.9 | 40.3 |

**Full step, terrain and 18k trees**

| Airframe | Run 1 median | Run 1 p75 | Run 1 p99 | Run 2 median | Run 2 p75 | Run 2 p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Vandal 5″ | 14.6 | 17.6 | 54.0 | 14.2 | 15.9 | 42.3 |
| Gnat 65 | 14.1 | 16.2 | 43.9 | 15.6 | 18.8 | 53.9 |

Read the medians. Means are higher than medians because of a few very slow samples, up to tens of milliseconds, and the first flat-ground case (Vandal 5″) had a mean of 29 and 34 µs in the two runs. I did not pin down the cause; other processes on this shared machine and garbage collection are the likely ones.

### What it means per frame (derived, not measured)

These are arithmetic on the medians above, not measurements in a browser:

| Display rate | Steps per frame | Step cost per frame at 10.6 to 15.6 µs a step |
| --- | ---: | ---: |
| 60 fps | 8.3 | 0.09 to 0.13 ms |
| 144 fps | 3.5 | 0.04 to 0.05 ms |

A 60 fps frame has 16.7 ms, so on this machine the simulation uses under 1% of it, and the frame rate will be set by rendering. Two cautions: the browser runs the same Rapier WebAssembly but in a different engine and with rendering competing for the CPU, and `Game.frame` stops after 60 steps in one frame, so below about 8 fps the simulation runs slower than real time.

## Alex's GPU run

> **Not measured yet.** Frame rate needs a real GPU in a real browser, and this was written on a machine without one. The table is left empty on purpose; please fill it in from a real run rather than from the numbers above.

How to measure:

1. Run `npm run build` then `npm run preview`, or use the live demo. Avoid `npm run dev` for this, as the dev server is slower.
2. In Settings, Display, pick the Graphics quality to test.
3. Fly each map for about a minute, mostly low among the trees or structures. The HUD shows the frame rate in the top right corner, averaged over half a second. Note a typical value and the lowest you see.
4. The frame rate can't go above the display's refresh rate, so note that too.
5. For a breakdown of where frame time goes, record a few seconds in the Chrome DevTools Performance panel.

| Date | Browser and version | GPU | Display Hz | Map | Quality | Airframe | Camera | Typical fps | Lowest fps | Notes |
| --- | --- | --- | ---: | --- | --- | --- | --- | ---: | ---: | --- |
| | | | | Larkspur Valley | High | | FPV | | | |
| | | | | The Ironworks | High | | FPV | | | |
| | | | | Apron Nine | High | | FPV | | | |
| | | | | Larkspur Valley | Medium | | FPV | | | |

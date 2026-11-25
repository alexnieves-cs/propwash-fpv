# Changelog

## 1.1.0 (unreleased)

Work on the `v1.1` branch. Not merged or released yet. See [docs/ROADMAP.md](docs/ROADMAP.md) for what is done and what is left.

### Added

- **Settings › Radio.** Map a gamepad or a USB radio: assign each stick by moving it, invert it, calibrate centre and endpoints, set a deadband and a throttle style, and pick arm and flight-mode switches. Presets for standard gamepads (Mode 1 and Mode 2) and for EdgeTX radios in Classic joystick mode (AETR and TAER), each with the source of its axis order, and a calibrate-yourself preset for other radios. Saved in the browser.
- **Arm switch safety.** After a radio is plugged in, the arm switch has to be cycled once before it arms, and it won't arm with the throttle up.
- **Settings › Tuning.** Per-airframe rates in Betaflight CLI units for all five rate types (Betaflight, Raceflight, KISS, Actual, Quick), with a curve plot. Import from pasted Betaflight CLI `diff` or `dump` output, or copy the sim's rates out as CLI lines. Sliders for the rate loop's response, damping, I gain, feed-forward and yaw. The rate curves are ported from Betaflight 4.5.1 `src/main/fc/rc.c`.
- **`npm run bench`.** Times one simulation step in Node. Results in [docs/PERFORMANCE.md](docs/PERFORMANCE.md).
- **[docs/PHYSICS-CHECK.md](docs/PHYSICS-CHECK.md).** The airframe table compared with published motor and prop thrust data.
- **Tests** for radio mapping and calibration, the rate curves and the CLI parser, tuning ranges, the two new settings tabs (against a small fake DOM), and golden traces that pin 1.0 flight behaviour.

### Unchanged

- Keyboard controls.
- Flight behaviour for anyone who hasn't changed the new settings: a gamepad without a radio setup reads exactly as in 1.0, and an airframe without a tune flies exactly as in 1.0. The golden-trace tests, recorded on 1.0, check this.
- Settings saved by 1.0 load as before.

## 1.0.0 (2026-11-12)

First release.

- Four airframes: Vandal 5″ freestyle, Kestrel R5 racer, Lantern 3″ cinewhoop and Gnat 65 tiny whoop.
- Three maps: Larkspur Valley, The Ironworks and Apron Nine, each with a race course.
- Freestyle sessions with trick scoring, and races with splits, medals and a ghost.
- Keyboard-first controls, with gamepad and USB radio support.
- Live demo on GitHub Pages, CI, MIT license.

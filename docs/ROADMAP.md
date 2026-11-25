# Roadmap: 1.1

Milestone 1.1 makes Propwash friendlier to pilots with a real radio and their own Betaflight rates, and puts numbers behind the flight model and its performance. Keyboard play stays as it is, and anyone who doesn't touch the new settings flies exactly as in 1.0.

## Status

| Piece | Status | Where |
| --- | --- | --- |
| 1. Radio setup | Done, not yet tried with real hardware | Settings › Radio; `src/core/radio.ts`, `src/ui/setup.ts` |
| 2. Rates and tuning | Done | Settings › Tuning; `src/sim/rates.ts`, `src/sim/tuning.ts` |
| 3. Performance | Step-cost bench done; GPU frame-rate run still to do | `npm run bench`; [PERFORMANCE.md](PERFORMANCE.md) |
| 4. Physics check | Done as a report; follow-ups not applied | [PHYSICS-CHECK.md](PHYSICS-CHECK.md) |
| 5. Browser smoke test | Not started | |

### 1. Radio setup

Axis assignment (move a stick and the sim picks the axis), inversion, centre and endpoint calibration, deadband, throttle style, arm and flight-mode switches, saved in the browser. Presets:

- Gamepad, Mode 2 and Mode 1: from the standard gamepad layout in the W3C Gamepad specification.
- EdgeTX radio, AETR and TAER: channel order from the EdgeTX manual's USB joystick section, mapped to browser axes in the order Chrome reports HID axes. The manual doesn't document stick directions, so these presets ask for a Detect pass.
- Other radio: no axis order is assumed; calibrate yourself.

The default profile reproduces the 1.0 gamepad mapping exactly, which a test checks value for value.

### 2. Rates and tuning

Per-airframe rates in Betaflight CLI units for all five rate types, ported from Betaflight 4.5.1 (`src/main/fc/rc.c`, defaults from `controlrate_profile.c`, CLI names from `cli/settings.c`), and import from pasted `diff` or `dump` output. The rate-loop editor uses the sim's own controller terms (response, damping, I gain, feed-forward, yaw response), because the sim's loop is not Betaflight's and Betaflight P, I and D numbers don't carry over.

### 3. Performance

`npm run bench` times one 500 Hz step in Node. Results from a shared cloud VM are in [PERFORMANCE.md](PERFORMANCE.md).

### 4. Physics check

[PHYSICS-CHECK.md](PHYSICS-CHECK.md) compares each airframe's thrust, RPM and power with published thrust-stand tables. The 5-inch quads match at full throttle. It lists three possible follow-ups (5-inch part-throttle power, Lantern RPM, Gnat current) and what wasn't checked. None were applied, since 1.1 keeps 1.0 flight behaviour.

### 5. Browser smoke test (skipped)

A smoke test would load the built app in a headless browser, start a session on each map, fly a few seconds with scripted keys, open the Radio and Tuning tabs, and fail on any console error. It was skipped: Playwright isn't in the project's dependencies, installing packages beyond the lockfile wasn't approved for this work, and the environment it was done in can't download browsers. The settings tabs are tested against a small fake DOM in `tests/setup-panels.test.ts` instead, which checks behaviour but not layout.

## Left to do before releasing 1.1

- **GPU frame-rate run.** Fill in the table at the end of [PERFORMANCE.md](PERFORMANCE.md) from a real browser with a real GPU.
- **Smoke test.** Add Playwright as a dev dependency and write the test above, if wanted.
- **Hardware check.** Try the presets with a real gamepad and an EdgeTX radio, including the arm and mode switches.
- **Layout check.** Look at the Radio and Tuning tabs in a browser; they have only been tested against a fake DOM.
- **Physics follow-ups.** Decide whether to act on the findings in [PHYSICS-CHECK.md](PHYSICS-CHECK.md), in 1.1 or later.
- **Release.** Bump the version in `package.json` to 1.1.0 and date the entry in [CHANGELOG.md](../CHANGELOG.md).

# Physics check: airframes against published motor and prop data

This compares the airframe table in `src/sim/drone-config.ts` with thrust-stand data that motor makers and shops publish. Nothing in the sim was changed as a result; the findings at the end are for a later decision.

## How the comparison works

The sim does not name a motor for any airframe. It gives, per motor, a static thrust (`maxThrust`) and a loaded rotor speed (`maxOmega`) at the reference voltage of 3.9 V per cell, plus constants for drag torque and power-train efficiency. From the equations in `src/sim/quad.ts`, with no airspeed, no ground effect and sea-level air:

- thrust: T = maxThrust x (w / maxOmega)^2
- mechanical power: P = torqueRatio x T x w
- electrical power: P / (efficiency x (0.62 + 0.38 x min(1, 2.2 x w / maxOmega))) + idleCurrent x V

So for any thrust a published table lists, the sim's RPM and electrical power at that same thrust can be worked out and set next to the table's row. The sim figures below were computed that way, at the reference voltage. Hover figures were measured by running the sim: a 5 s hover at 5 m in Angle mode with altitude hold, no wind.

The published tables are per motor, static, on a test stand, at the voltages they list (about 22 to 24 V for 6S, 15.5 to 16 V for 4S). The numbers were read from the page text of the sources listed at the end. They were transcribed by a tool that summarises pages, so a spot check against the pages is worthwhile before anything is changed on the strength of them.

## Summary

| Airframe | Sim per motor at full throttle | Closest published data | Verdict |
| --- | --- | --- | --- |
| Vandal 5″ (6S, 5.1″ tri) | 1,479 g, 29,030 RPM, 776 W | 1750KV 2207 on 5.1″ tri props: 1,507 to 1,681 g, 29,000 to 31,100 RPM, 768 to 816 W | Full throttle matches. Uses 10 to 44% more power than the data at half to three-quarter thrust. |
| Kestrel R5 (6S, 5.1″ tri) | 1,683 g, 31,990 RPM, 878 W | 1950KV 2207 on the same props: 1,651 to 1,879 g, 29,900 to 32,500 RPM, 934 to 1,003 W | Matches well. Power at full throttle 6 to 9% below the two published rows either side of its thrust. |
| Lantern 3″ (4S, 76 mm 5-blade, ducted) | 479 g, 42,017 RPM, 250 W | 1507 on 75 to 76 mm props: 455 to 468 g at about 31,800 RPM and 270 W | Thrust and power plausible. RPM is 29 to 33% higher than the data at the same thrust. |
| Gnat 65 (1S, 31 mm tri, ducted) | 27.5 g, 49,660 RPM, 8.9 W (2.28 A) | 0702 motors on GF 1219S tri props: 28.3 to 37.2 g; one table: 31 g at 3.8 A, 4.2 V | Thrust at the low end of the range. Current about 40% lower than the one table found. RPM not checked. |

Thrust to weight from the table (Vandal 8.7, Kestrel 12.0, Lantern 4.9, Gnat 4.1) follows directly from the thrust figures, so it stands or falls with them.

## Vandal 5″

Sim: 680 g, 6S, 5.1″ (129.6 mm) three-blade props, 14.5 N (1,479 g) and 29,030 RPM per motor at 23.4 V.

Published: a 2207-size 1750KV motor (V2207 V2) on four T-series 5.1″ tri props, from the motor's product page (source 1).

| Point | Published | Sim at the same thrust |
| --- | --- | --- |
| T5143S, 50% | 546 g, 18,740 RPM, 161 W, 3.39 g/W | 17,641 RPM, 184 W, 2.97 g/W |
| T5146, 50% | 631 g, 18,257 RPM, 157 W, 4.03 g/W | 18,964 RPM, 226 W, 2.80 g/W |
| T5143S, 75% | 1,061 g, 25,890 RPM, 433 W, 2.45 g/W | 24,591 RPM, 477 W, 2.23 g/W |
| T5146, 75% | 1,205 g, 24,974 RPM, 454 W, 2.66 g/W | 26,207 RPM, 574 W, 2.10 g/W |
| T5143S, 100% | 1,507 g, 31,085 RPM, 768 W, 1.96 g/W at 22.5 V | sim full: 1,479 g, 29,030 RPM, 776 W, 1.91 g/W |
| T5146, 100% | 1,636 g, 29,442 RPM, 804 W, 2.03 g/W at 22.3 V | |

- **Thrust and RPM:** in line. The sim's thrust per RPM squared sits between the T5143S and T5146 props.
- **Power at full throttle:** in line, within a few percent.
- **Power at part throttle:** the sim draws 10 to 44% more than the data. Its power-train efficiency is constant above about 45% of full rotor speed, while a real motor is more efficient at part throttle than at full.
- **Hover:** not checked. The sim hovers at about 170 g per motor (measured 7.7 A in total at 24.0 V); the published tables start at 50% throttle, 546 g.

## Kestrel R5

Sim: 560 g, 6S, 5.1″ three-blade props, 16.5 N (1,683 g) and 31,990 RPM per motor at 23.4 V.

Published: the 1950KV version of the same motor on the same props (source 1).

| Point | Published | Sim at the same thrust |
| --- | --- | --- |
| T5143S, 50% | 624 g, 20,048 RPM, 222 W, 2.81 g/W | 19,482 RPM, 209 W, 2.98 g/W |
| T5146, 50% | 749 g, 19,750 RPM, 225 W, 3.32 g/W | 21,344 RPM, 271 W, 2.77 g/W |
| T5143S, 100% | 1,651 g, 32,509 RPM, 934 W, 1.77 g/W at 22.1 V | sim full: 1,683 g, 31,990 RPM, 878 W, 1.92 g/W |
| T5146, 100% | 1,799 g, 30,751 RPM, 966 W, 1.86 g/W at 21.9 V | |

- **Thrust and RPM:** in line, between the two props.
- **Power:** at full throttle, 6 to 9% below the two published rows, whose thrust brackets the sim's; at half thrust, between 6% low and 20% high.
- **Hover:** not checked, for the same reason as the Vandal.

## Lantern 3″

Sim: 390 g, 4S, 76 mm five-blade ducted props, 4.7 N (479 g) and 42,017 RPM per motor at 15.6 V.

I found no published test of a 3″ five-blade prop inside a duct. The closest data is a 1507 motor's product page that tests 75 to 76 mm props on 4S (source 2). The page does not say whether the props were run in ducts, and only names the T76S as a 3-inch prop; HQ-75-6 is listed without a description. That 1507 makes up to about 680 g on these props at full throttle, more than the Lantern's 479 g. A smaller 1404 motor's page (source 3) lists 301 to 345 g at full throttle at about 16 V on props it names GF3016 and HQ3*3*3 (sizes aren't stated; the names suggest 3-inch). The Lantern's thrust sits between the two, which is plausible for a 390 g cinewhoop, but neither motor is a known match.

| Point (4S) | Published | Sim at the same thrust |
| --- | --- | --- |
| T76S, 20% | 71 g, 12,185 RPM, 21 W | 16,172 RPM, 21 W |
| T76S, 30% | 137 g, 16,910 RPM, 50 W | 22,464 RPM, 44 W |
| T76S, 50% | 293 g, 25,082 RPM, 141 W | 32,853 RPM, 123 W |
| T76S, 70% | 455 g, 31,805 RPM, 271 W | 40,939 RPM, 232 W |
| HQ-75-6, 30% | 124 g, 16,408 RPM, 46 W | 21,372 RPM, 38 W |
| HQ-75-6, 50% | 278 g, 24,395 RPM, 131 W | 32,001 RPM, 114 W |
| HQ-75-6, 70% | 468 g, 31,845 RPM, 270 W | 41,520 RPM, 242 W |

- **Power:** 0 to 17% lower than the data across the range. Plausible.
- **RPM:** 29 to 33% higher than the data at every point. The sim's thrust per RPM squared (0.27 g per thousand RPM squared) is well below these props (0.45 to 0.46) and below the HQ3*3*3 on the 1404 page (0.38 to 0.39). Because the power is about right, the sim's drag torque per newton of thrust is correspondingly low. In flight this mainly shows up as a higher motor sound and less yaw torque per unit of thrust than a real prop of this size.
- **Hover:** the sim hovers at 97.5 g per motor at about 18,950 RPM and 28.8 W per motor (measured). The T76S rows either side (71 g and 137 g) suggest a real prop would do it at roughly 14,000 RPM.

## Gnat 65

Sim: 27 g, 1S, 31 mm three-blade ducted props, 0.27 N (27.5 g) and 49,660 RPM per motor at 3.9 V; 2.28 A and 8.9 W per motor at full throttle.

Published:

- BETAFPV's 0702 II product page (source 4) lists maximum thrust with GF 1219S-3 props for six 0702 variants: 28.3 g to 37.2 g. The 0702SE II 23000KV is listed at 32 g. The page gives no test voltage, current or RPM. It does not give the prop's diameter either; it recommends 31 mm props for these motors.
- A shop page for a 0702 27000KV motor (source 5) has one row per prop at 4.2 V and full throttle. With the GF1219 tri prop: 31 g at 3.8 A. Its power and efficiency columns don't agree with its own current and voltage (3.8 A at 4.2 V is about 16 W), so I used only the thrust and current: about 1.8 to 1.9 g/W.

| | Published | Sim |
| --- | --- | --- |
| Max thrust per motor | 28.3 to 37.2 g (source 4); 31 g at 4.2 V (source 5) | 27.5 g at 3.9 V |
| Current at full throttle | 3.8 A at 4.2 V (source 5) | 2.28 A at 3.9 V |
| Thrust per watt at full throttle | about 1.8 to 1.9 g/W | 3.1 g/W |
| RPM | not found | 49,660 |

- **Thrust:** at the low end of the published range, and the sim's figure is at a lower voltage than a fresh 1S pack, so it is plausible.
- **Current:** about 40% lower than the one table found, so the sim's whoop is roughly 1.6 to 1.7 times as efficient at full throttle as that data. It hovers on 1.53 A in total (measured), which works out at about 12 minutes of hover on its 300 mAh pack. That one table is thin evidence, but if it holds, the Gnat's battery lasts longer and sags less than a real whoop's.
- **RPM:** not checked; none of the pages I opened gave an RPM for a 1S whoop motor.

## Findings, for a later decision

None of these are changed in this release, since flight behaviour has to stay identical to v1.0.0.

1. **Part-throttle power (5″ quads).** An efficiency that peaks at part throttle and falls towards full, in place of the constant one above 45% rotor speed, could close the part-throttle gap while keeping full-throttle figures where they are.
2. **Lantern RPM.** Bringing `maxOmega` down by about a quarter, with `torqueRatio` and `inflowFactor` raised to keep power and top speed where they are, would match the 75 to 76 mm data. Mostly an audio and yaw-feel change.
3. **Gnat current.** Worth a better source before acting on it. If it is confirmed, a lower `efficiency` would shorten flight time and add sag.
4. **Not checked at all:** hover power for the 5″ quads, top speed and drag (`cdA`, `inflowFactor`, `rotorDrag`), inertia, motor time constants and battery resistance. I didn't find published data for these that maps onto the table.

## Sources

Pages opened and used:

1. V2207 V2 motor product page, ligpower.com, test data for the 1750KV and 1950KV versions on T5143S, T5146, T5147 and T5150 props: https://www.ligpower.com/product/v2207-v2-fpv-motor.html (the 65% row for T5143S at 1750KV lists the same current as the 60% row, so that row wasn't used)
2. T-Motor store, Velox V1507 3-inch motor, 4S and 6S test data: https://store.tmotor.com/product/v1507-3inch-tinywhoop-fpv-motor.html
3. T-Motor store, F1404, test data for the 2900KV, 3800KV and 4600KV versions: https://store.tmotor.com/goods-1121-F1404.html
4. BETAFPV, 0702 II brushless motors, maximum thrust with GF 1219S-3: https://betafpv.com/products/0702-ii-brushless-motors
5. Shop page for a Sub250 0702 27000KV motor, load data at 4.2 V: https://rcdrone.top/products/sub250-0702-27000kv-brushless-motor

Pages opened but not used, because the text I could read had no per-prop thrust tables (the full results are behind links I didn't follow):

- Mini Quad Test Bench, T-Motor F40 Pro II 1600KV: https://www.miniquadtestbench.com/t-motor-f40-pro-ii-1600kv.html
- Mini Quad Test Bench, SunnySky R2207 1800KV: https://www.miniquadtestbench.com/sunnysky-e-r2207-1800kv.html

Searched for and not found: any published static thrust test of a 3-inch five-blade prop inside a duct, and RPM data for a 1S whoop motor.

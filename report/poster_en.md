# RetinaEvent: Event-Driven Vision on a Low-Cost FPGA

**One-line positioning:** A 400×240 event-camera front-end that exports sparse brightness changes and makes an on-chip action decision, without external memory on the event path.

## 1. Three Numbers at a Glance

| Static-scene activity | On-chip inference | Slice utilization |
|---|---:|---:|
| **0** pulses in static and empty held-out segments (offline, D8-A7) | **8.80 ms** per 100 ms decision window (D8-R5) | **46.23%** of available Slice capacity (D8-R2) |

The three values answer three questions a reviewer asks first: does a static scene stay quiet, how fast is the on-chip decision, and how much of the device is used. The first value is an offline held-out count, not a board-level product claim; the second and third are board-build measurements.

## 2. System Architecture

```text
OV5640 800×480  ->  event engine 400×240  ->  UDP v3 15,940 pps  ->  host panel
                         |                         |                      |
                         |                         +-> record / replay    +-> browser
                         +-> int8 inference 8.80 ms / 100 ms window -> action class0/class1
                         +-> display path DDR3 / LCD
```

*Simplified English rendering of F1; original vector: [f1_system_arch.svg](figures/f1_system_arch.svg). The event and NN paths stay in on-chip BRAM; display reuses the vendor DDR3/MIG base (D8-M3, D8-M5, D8-R2).*

The camera input is 800×480 RGB565 at 26.6–26.7 fps (D8-M4, D8-T6). The event grid is 400×240 (D8-M5). The UDP stream reached 15,940 pps on the live link (D8-H6). The current bitstream is variant_act3c, 2,890,875 B (D8-M6).

## 3. Key Results

| Item | Measured / verified | Source |
|---|---|---|
| Event grid | 400×240, downsampled from 800×480 | D8-M5 |
| Live UDP link | 15,940 pps, healthz 200 | D8-H6 |
| On-chip model | int8 2-class, 100 ms window | D8-A1 |
| Inference time | 8.80 ms, 440,087 cycles at 50 MHz | D8-R5 |
| Slice utilization | 7,327 of 15,850, 46.23% | D8-R2 |
| LUT / BRAM / DSP | 20,559 / 87 / 7 | D8-R2 |
| Timing | WNS +0.306 ns, WHS +0.036 ns | D8-R1 |
| Bitstream | variant_act3c, 2,890,875 B | D8-M6 |
| Offline v7 held-out | 0.9042 window accuracy; 17/17 open segments; 0 wave, 0 static, 0 empty | D8-A7 |

The table separates board measurements from offline held-out results. The 0.9042 figure and the zero counts in the last row are offline, from a fixed session split; they are not a board-level v7 claim (D8-A7, D8-A8, D8-O2).

## 4. Reproduce in Three Commands

    cd retina_event
    pwsh -NoProfile -File tool\run_all_sims.ps1
    pwsh -NoProfile -File tool\build_retina.ps1 -Mode --full

The host-side checks are:

    cd host/app
    npm test
    node tools\launch.mjs --udp --no-open

The RTL regression is fully scripted; the host suite runs 670 tests with 669 pass and 1 skip (D8-H5). The board must be reached at 192.168.1.102; the gateway fails fast with BIND_ADDR_NOT_LOCAL on a mismatched address (D8-H1, D8-H2).

## 5. Evidence Boundary

v7 board-level numbers are not measured in this build (D8-A8, D8-O2). The v7 model is an offline candidate trained on a single session; its held-out accuracy is reported with that boundary. The printed poster keeps only numbers registered in the D8 table, so every value can be traced to a build report, a timing report, or an offline result file.

f4_resources.svg is omitted from this print master because its Slice label conflicts with D8-R2; the key-results table carries the authoritative 46.23% value. The F4 dependency is recorded in a source comment in poster_en.svg. F5 and F7 remain in the report; their values are summarized in Key Results rather than duplicated as Chinese-labelled figures.

## 6. Work, Track, Device

**Work:** RetinaEvent · **Track:** FPGA Innovation Design · **Device:** AMD Artix-7 xc7a100tfgg484-2 (D8-M1) · **Bitstream:** variant_act3c, 2,890,875 B (D8-M6) · **Year:** 2026.


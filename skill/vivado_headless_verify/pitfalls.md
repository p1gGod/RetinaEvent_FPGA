# Vivado headless verification pitfalls

Each row: symptom, cause, action, how to verify. Versions: Vivado 2018.1 and newer unless noted.

## 1 launch_runs waits forever

- Symptom: after launch_runs, wait_on_run never returns; no progress in the run directory.
- Cause: the run server cannot start on a locked-down machine.
- Action: run the flow in one process: synth_design, opt_design, place_design, route_design, write_bitstream.
- Verify: HEADLESS_STEP markers appear in order in the log.

## 2 TCL file starts with a UTF-8 BOM

- Symptom: invalid command name "ï»¿#..." or a syntax error on line 1.
- Cause: editor saved the file as UTF-8 with BOM.
- Action: save as UTF-8 without BOM; PowerShell scripts that contain non-ASCII text need a BOM, TCL files must not.
- Verify: python -c "print(open('x.tcl','rb').read(3))" prints b'#! ' or similar, not b'\xef\xbb\xbf'.

## 3 -tclargs not last

- Symptom: arguments missing or shifted; usage error inside the script.
- Cause: options placed after -tclargs; Vivado stops option parsing there.
- Action: keep -tclargs and all values at the end of the command line.
- Verify: run_vivado.py --dry-run prints RUNNER_TCLARGS_LAST=1.

## 4 .Xil directory inside the source tree

- Symptom: couldn't read file ".../src/.Xil/Vivado-.../realtime/<top>.tcl", synth_design fails before reading RTL.
- Cause: the process working directory was the source directory, so temporary files land there.
- Action: cd to a build directory before synth_design; keep source lists absolute.
- Verify: no .Xil directory under source paths after a run.

## 5 Synthesis helper process crashes intermittently

- Symptom: invalid command name "rt-undefined", could not read unimacro_verilog.tcl or lib_core.tcl, always within seconds of Launching helper process.
- Cause: the helper process startup is unstable on some Windows hosts (observed with Vivado 2020.2).
- Action: retry the same command; three attempts are usually enough.
- Verify: RUNNER_ATTEMPT lines followed by HEADLESS_RESULT=PASS.

## 6 RAM inferred as registers

- Symptom: synth log says RAM is sensitive to asynchronous reset, or RAM has multiple writes via different ports in same process; utilization shows a large FF count.
- Cause: array writes live in an always block with an asynchronous reset, or one array is written by several statements in one block.
- Action: put array writes in a clocked block without asynchronous reset; use one write statement per array; reset only pointers and valid flags.
- Verify: synthesis log has no such warning; report_utilization shows RAMB/RAM32 cells.

## 7 $readmemh path depends on the working directory

- Symptom: ROM initializes to X or zero in one tool and correctly in the other.
- Cause: relative .mem paths resolve against the simulator or synthesizer working directory.
- Action: generate a pure-RTL initial block (initial begin rom[0]=...; end) from your parameter file.
- Verify: grep the RTL for $readmemh; compare word count and checksum against the generator output.

## 8 Timing summary reports WNS as NA

- Symptom: HEADLESS_WNS=NA.
- Cause: no clocks are constrained, constraints were read after route, or the design has no timed paths.
- Action: create_clock before opt_design, read_xdc after synth_design, report after route_design.
- Verify: report_timing_summary shows a clock row; compare_reports.py --min-wns 0.0 fails on NA.

## 9 Report formats differ between Vivado versions

- Symptom: a regex that worked on one version returns NA on another.
- Cause: column order, spacing, or table names changed.
- Action: let synth_verify.tcl compute metrics and emit HEADLESS_* lines, and parse those instead of the human report.
- Verify: metrics.txt exists and contains HEADLESS_LUT, HEADLESS_WNS.

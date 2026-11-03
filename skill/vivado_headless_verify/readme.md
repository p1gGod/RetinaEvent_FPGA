# vivado_headless_verify

一句话：在没有 GUI 的机器上跑完 synth→opt→place→route，把资源与 WNS 变成可比较的数字，并对前后两次构建做门禁。

## 适用范围

- CI、远程机器、无人值守构建：只需要一个 Vivado 安装，不需要打开图形界面。
- 单个模块或小型顶层：非工程模式直接读 RTL，约束用一份 XDC。
- 需要回答「这次改动让 LUT 涨了多少、WNS 掉了多少」的回归场景。
- 需要固定资源/时序门禁的提交检查。
- 不覆盖：IP 打包（.xci/.bd）、多 run 工程、比特流下载与固化。这些场景用工程模式脚本，本包只提供可复用的进程内流程与指标抽取方式。

## 使用方法

依赖：Vivado 2020.2（本版报告的格式基准）、Python 3.8 及以上（仅标准库）。

1) 准备源文件列表与约束：

```text
examples/src_list.example.txt   # 一行一个路径，相对列表文件解析
examples/constraints.example.xdc
examples/blinky.v
```

2) 先干跑，确认命令行与参数顺序：

```bash
python run_vivado.py --dry-run \
  --part xc7a35tcsg324-1 --top blinky \
  --sources examples/src_list.example.txt \
  --xdc examples/constraints.example.xdc \
  --out-dir examples/build
```

输出 RUNNER_CMD、RUNNER_TCLARGS_LAST=1、RUNNER_RESULT=DRY_RUN。干跑不要求本机装有 Vivado。

3) 正式运行（自动定位 vivado：--vivado、环境变量 VIVADO、PATH 顺序查找）：

```bash
python run_vivado.py \
  --part xc7a35tcsg324-1 --top blinky \
  --sources examples/src_list.example.txt \
  --xdc examples/constraints.example.xdc \
  --out-dir build/headless
```

日志写到 <out-dir>/vivado.log，指标写到 <out-dir>/metrics.txt，报告为 util.rpt、timing.rpt、drc.rpt。

4) 前后对比与门禁：

```bash
python compare_reports.py \
  --before old/metrics.txt --after build/headless/metrics.txt \
  --max-lut 12000 --max-ff 12000 --max-slice 5000 \
  --max-bram 20 --min-dsp 1 --max-dsp 8 --min-wns 0.0
```

输出 METRIC 表（before/after/delta）、逐项 GATE 行，末行 COMPARE_RESULT=PASS|FAIL；退出码 0 通过，1 门禁失败。

5) 自检（不依赖 Vivado）：

```bash
python run_vivado.py --selftest
python compare_reports.py --selftest
```

也可以直接调用 TCL（参数顺序固定，-tclargs 必须置于参数末尾）：

```bash
vivado -mode batch -nolog -nojournal -source synth_verify.tcl \
  -tclargs xc7a35tcsg324-1 blinky examples/src_list.example.txt \
  examples/constraints.example.xdc examples/build
```

TCL 的行为：

- 源列表中的相对路径按列表文件所在目录解析，注释行以 # 开头。
- 读完源文件后 cd 到输出目录，避免 .Xil 落在源码树。
- synth_design 之后 read_xdc，再 opt/place/route，随后生成三份报告。
- 打印行首标记 HEADLESS_STEP、HEADLESS_LUT/FF/SLICES/BRAM/DSP/WNS/DRC_ERRORS、HEADLESS_RESULT，并写 metrics.txt。

## 已验证效果

本包自检（2026-10-30，Python 3 标准库，本机 Windows）：

```text
$ python run_vivado.py --selftest
RUNNER_ATTEMPT=1 status=helper_crash retry=1
SELFTEST_CASE=retry_recovers status=PASS attempts=2 runs=2
SELFTEST_CASE=bom_detected status=PASS
SELFTEST_CASE=tclargs_last status=PASS
SELFTEST_CASE=clean_pass status=PASS attempts=1
SELFTEST_RESULT=PASS
```

退出码 0。覆盖：helper 崩溃后重试成功、BOM 检测、-tclargs 置尾、一次通过。

```text
$ python compare_reports.py --selftest
SELFTEST_CASE=parse_util_timing status=PASS
SELFTEST_CASE=parse_markers status=PASS
SELFTEST_CASE=gates_pass status=PASS
SELFTEST_CASE=gate_fail_detected status=PASS
SELFTEST_CASE=negative_wns_detected status=PASS
SELFTEST_CASE=missing_metric_detected status=PASS
SELFTEST_RESULT=PASS
```

干跑实测输出：

```text
$ python run_vivado.py --dry-run --part xc7a35tcsg324-1 --top blinky \
    --sources examples/src_list.example.txt --xdc examples/constraints.example.xdc \
    --out-dir examples/build
RUNNER_CMD=vivado -mode batch -nolog -nojournal -source synth_verify.tcl -tclargs xc7a35tcsg324-1 blinky examples/src_list.example.txt examples/constraints.example.xdc examples/build
RUNNER_TCLARGS_LAST=1
RUNNER_RESULT=DRY_RUN
```

synth_verify.tcl 本版未在 Vivado 中执行（任务禁止长构建），报告解析范围按 Vivado 2018.1 至 2020.2 的表格格式编写，自检用合成报告验证。

来源工程历史实测（非本包自检）：sim/nn/EVIDENCE_M3.md 记录同一套非工程流程在 xc7a100tfgg484-2 上的结果，v2 版为 LUT=1108、FF=400、SLICES=356、BRAM=10.5 tiles、DSP=1、WNS=+8.827 ns（20 ns 周期）；v1 版为 LUT=28023、FF=66423（sim/nn/nn_synth_run_1.log:1167-1169）、Slices 占 98.69%、WNS=-7.001 ns（5 ns 周期）（sim/nn/EVIDENCE_M3.md:24-27）。两版对照说明该流程能把「资源翻倍、时序为负」的回归量化出来。

## 失效条件

- 本机没有 Vivado、没有许可证，或版本低于 2018.1：run_vivado.py 在定位或启动阶段失败。
- 综合 helper 进程连续崩溃超过 --retries 次数：需要人工重试或更换宿主。
- 非工程模式不识别 IP（.xci/.bd）与 Block Design；含 IP 的设计改用工程模式流程。
- 含空格或通配符的路径需要确认命令行引用；run_vivado.py 使用系统默认引用规则，TCL 里按绝对路径读取。
- 未约束时钟或约束在 route 之后才读入：HEADLESS_WNS=NA，对应门禁判失败。
- 异步时钟域需要自行在 XDC 写 set_clock_groups，本包不推断 CDC 约束。
- report_drc 的违规计数依赖 get_drc_violations；老版本没有该命令时 HEADLESS_DRC_ERRORS=NA。
- 只验证综合与实现，不验证板级引脚、比特流内容与上板行为。

## 来源

- 进程内 synth/opt/place/route：build/build_inproc.tcl。
- 指标标记与门禁写法：build/nn_synth_check.tcl。
- 防待机冻结的包装方式：build/run_awake_cmd.ps1。
- 坑 1、3、4、6、7：docs/03_tech/06_rtl_design_and_pitfalls.md。
- 资源与时序数字：sim/nn/EVIDENCE_M3.md。

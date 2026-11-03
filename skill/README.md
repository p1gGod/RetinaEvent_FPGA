# AMD FPGA 开发技能包

一句话：三项与具体题目解耦的工程工具，覆盖任务书契约、无 GUI 构建回归、事件流上板 bringup，换一个 FPGA 项目也能直接套用。

## 总览

| 技能项 | 适用范围 | 使用方法 | 失效条件 |
| --- | --- | --- | --- |
| fpga_agent_task_contract | 把一项工程任务写成可验收的任务书：任何需要多人或多智能体协作、且交付必须机读判据的 FPGA 子任务 | 复制 `contract_template.md` 改五要素（目标、机读判据、写范围白名单、禁止项、产出路径），用 `python check_contract.py <任务书>` 校验结构 | 任务本身没有可机读判据、或验收只能靠人工目视时，模板退化为提醒清单 |
| vivado_headless_verify | 无人值守或无 GUI 环境下重建比特流、把综合布线的资源与时序做成可比较的门禁：任何用 Vivado 批处理跑 OOC 或全流程的项目 | 填 `synth_verify.tcl` 的工程路径后 `python run_vivado.py`，再用 `python compare_reports.py a.rpt b.rpt` 比对两份报告 | Vivado 版本与报告格式差异较大时解析会失配（本版以 2020.2 为格式基准）；工程缺约束文件时时序结论无效 |
| event_vision_bringup | 事件相机或稀疏事件流上板 bringup：需要从丢包、坏包、事件率异常中定位链路问题 | 按 `bringup_checklist.md` 逐项打勾，用 `packet_format.md` 对齐包头，`python check_stream.py --selftest` 后接抓包文件核对 | 协议字段或包长与 `packet_format.md` 不一致时必须先改格式描述，否则检查脚本报的是误判 |

三项互不依赖，可单独复制其中一项到别的项目。

## 快速开始

```bash
python fpga_agent_task_contract/check_contract.py --selftest
python vivado_headless_verify/run_vivado.py --selftest
python vivado_headless_verify/compare_reports.py --selftest
python event_vision_bringup/check_stream.py --selftest
python _check/check_readme.py
```

_check/check_readme.py 输出 SKILL_README_SCHEMA_OK=1 表示目录命名、五项 README 小节与脚本禁用路径检查全部通过。

## 目录结构

```text
skill/
  README.md
  _check/
    check_readme.py          # 目录与 README 小节校验
    run_selfchecks.py        # 在空目录运行全部自检并写证据日志
    EVIDENCE_SKILL_OK.log    # 首行 SKILL_PKG_OK=1
  fpga_agent_task_contract/
    README.md  contract_template.md  check_contract.py  examples/
  vivado_headless_verify/
    README.md  synth_verify.tcl  run_vivado.py  compare_reports.py
    pitfalls.md  examples/
  event_vision_bringup/
    README.md  bringup_checklist.md  packet_format.md  check_stream.py  examples/
```

## 统一约定

- 每项 README 固定五节：适用范围、使用方法、已验证效果、失效条件、来源。
- 脚本只依赖 Python 3 标准库或 Vivado 自带命令，不安装第三方包，不写死仓库绝对路径。
- 每项至少一个脚本带 --selftest 或 --dry-run，可在空目录运行。
- 证据日志首行写判据标记，便于机器验收；数字注明来源文件相对路径，查不到写「本版未测量」。

## 边界

- 不包含任何具体赛题的数据集、模型、板卡引脚与工程文件；来源工程的数字只作附录说明。
- 不替代项目自身的规格文档与验收标准；本包提供模板、流程与检查脚本。
- vivado_headless_verify 的 TCL 需要本机安装 Vivado 才能跑完整流程，自检与解析部分不需要。
- 三项都只检查可观测的形式与统计，不判断算法效果。

## 来源

- 任务书五要素与证据约定：本队 Lead 任务卡格式；仿真 CHECK=/TEST_RESULT= 约定来自 build/run_sim.ps1。
- 无 GUI 构建流程与坑：build/build_inproc.tcl、build/nn_synth_check.tcl、docs/03_tech/06_rtl_design_and_pitfalls.md。
- 上板检查项与包格式：build/udp_frame_check.py、docs/05_experiments/协议v3设计_20261009/v3线协议设计.md。
- 文风与数字溯源要求：docs/04_contest/05_report_outline_and_style.md。

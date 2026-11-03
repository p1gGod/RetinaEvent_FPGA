# fpga_agent_task_contract

一句话：把「任务书」写成机器可验收的契约，并用一个脚本检查契约是否完整、证据是否真的通过。

## 适用范围

- 任何多步骤、需要验收的工程任务：RTL 模块、仿真回归、脚本工具、文档交付。
- 多人或多智能体并行时，用白名单锁住写范围，用禁忌锁住破坏性操作。
- 已经有 CHECK/TEST_RESULT 约定的测试框架（兼容 ModelSim、Vivado 仿真、pytest 风格输出）。
- 不适用于需要人工判断美观、语义或创意的验收；本工具只检查形式与统计。

## 使用方法

1) 复制模板并填写五节：

```bash
cp contract_template.md my_task.md
```

五节标题必须包含关键词：目标、机读判据、白名单、禁忌、产出物。详见 contract_template.md。

2) 写证据日志：每项检查一行 CHECK=<名称> PASS|FAIL，末尾一行 TEST_RESULT=PASS|FAIL，全部通过后在第一行写标记（如 BLINKER_OK=1）。

3) 检查任务书与证据：

```bash
python check_contract.py contract my_task.md
python check_contract.py evidence evidence/blinker.log --expect-marker BLINKER_OK --min-checks 3
```

4) 自检（不读任何外部文件）：

```bash
python check_contract.py --selftest
```

输出以 SELFTEST_RESULT=PASS 结束、退出码 0 表示脚本本身可用。退出码：0 通过，1 判据不满足，2 用法或 IO 错误。

## 已验证效果

本包自检（2026-10-30，Python 3 标准库）：

```text
$ python check_contract.py --selftest
SELFTEST_CASE=contract_good status=PASS want=True got=True
SELFTEST_CASE=contract_missing_whitelist status=PASS want=False got=False
SELFTEST_CASE=evidence_good status=PASS want=True got=True
SELFTEST_CASE=evidence_missing_marker status=PASS want=False got=False
SELFTEST_CASE=evidence_check_fail status=PASS want=False got=False
SELFTEST_CASE=evidence_no_checks status=PASS want=False got=False
SELFTEST_RESULT=PASS
```

退出码 0；覆盖正例、缺节、缺标记、CHECK FAIL、零 CHECK 五类分支。

示例任务书与证据可直接对照检查：

```bash
python check_contract.py contract examples/contract_led_blink.md
python check_contract.py evidence examples/evidence_led_blink.log --min-checks 3
python check_contract.py evidence examples/evidence_led_blink_fail.log --min-checks 3
```

前两条退出码 0，第三条退出码 1（日志含 CHECK=BLINK_PERIOD FAIL 与 TEST_RESULT=FAIL）。

来源工程历史实测（非本包自检）：该 CHECK/TEST_RESULT 约定来自 build/run_sim.ps1，其退出码 0 仅在日志同时满足 TEST_RESULT=PASS 且无 TEST_RESULT=FAIL；本项目 M3 证据 sim/nn/EVIDENCE_M3.md 即以首行判据加 CHECK 统计的方式验收。

## 失效条件

- 五节标题被完全改写且不含关键词（校验按中文关键词匹配，英文标题需自行改 REQUIRED_SECTIONS）。
- 标记不在第一条非空行，或格式不是 NAME=1（不接受 NAME=PASS 或全小写）。
- CHECK 名称含空格、等号或中文；正则只接受字母、数字、下划线、点、冒号、连字符。
- 证据日志被加了非 #、;、> 前缀（例如时间戳列），需要先清洗。
- 多个日志合并检查时，任意一条含 TEST_RESULT=FAIL 即整体失败；空日志同样失败。
- 只验证形式与计数，不验证 CHECK 名称是否对应真实需求；判据设计仍需人工评审。

## 来源

- 模板五要素与「白名单/禁忌/产出物」写法：本队 Lead 任务卡格式（五节结构）。
- CHECK=/TEST_RESULT= 约定与退出码逻辑：build/run_sim.ps1。
- 证据首行判据写法：sim/nn/EVIDENCE_M3.md、sim/nn/nn_act3_summary.txt。
- 把「推断写成事实」列为禁忌：docs/04_contest/05_report_outline_and_style.md 的数字溯源规则。

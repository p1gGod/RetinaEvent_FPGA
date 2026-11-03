# 任务书示例：LED 闪烁计数器

## 1 目标（可验收）

- 交付物：src/blinker.v 与 sim/tb_blinker.v（4 位计数器，1 Hz 翻转）。
- 验收场景：运行仿真，TB 打印全部 CHECK=PASS 且末行 TEST_RESULT=PASS。
- 非目标：不生成比特流，不上板。

## 2 机读判据

- 证据文件：evidence/blinker.log。
- 首行标记：BLINKER_OK=1。
- 通过条件：至少 3 条 CHECK=PASS，无 CHECK=FAIL，末行 TEST_RESULT=PASS。

## 3 白名单

- src/blinker.v
- sim/tb_blinker.v
- evidence/

## 4 禁忌

- 不修改既有仿真入口 run_sim.ps1 与工程文件。
- 不执行 git push。
- 不把推断写成事实，未测量的数字写「本版未测量」。

## 5 产出物

- src/blinker.v：计数器与分频逻辑。
- sim/tb_blinker.v：周期与复位检查。
- evidence/blinker.log：首行 BLINKER_OK=1 与 CHECK 行。

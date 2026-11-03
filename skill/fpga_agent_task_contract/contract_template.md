# 智能体任务书模板（task contract）

用法：复制本文件为 task.md，逐节填写，尖括号占位符替换为实际值。五节缺一不可，check_contract.py 逐节检查。

## 1 目标（可验收）

- 交付物：<模块/脚本/报告的名称与路径>。
- 验收场景：<在什么输入、哪条命令下，观察到什么现象即算完成>。
- 非目标：<明确不做的事，防止范围蔓延>。

## 2 机读判据

- 证据文件：<evidence/<area>.log>。
- 首行标记：<AREA_OK=1>。只认第一行非空行，正则 ^[A-Z][A-Z0-9_]{2,}=1$。
- 测试约定：每项检查输出 CHECK=<名称> PASS|FAIL；末行 TEST_RESULT=PASS|FAIL。
- 通过条件：至少 <N> 条 CHECK=PASS，且没有 CHECK=FAIL，末行 TEST_RESULT=PASS。
- 资源阈值（可选）：<LUT<=N；FF<=N；BRAM<=N tiles；DSP 在 N..M；WNS>=0 @ T ns>。
- 失败样例（可选）：<判据不满足时的输出片段，用于区分环境失败与逻辑失败>。

## 3 白名单

- 只允许修改以下路径，越界即判失败。
- <path/a.v>
- <path/b.py>
- <evidence/>（只写证据与报告）

## 4 禁忌

- 不修改既有顶层与工程文件：<file>。
- 不执行：git push、长构建、安装依赖、端口变更、杀进程。
- 不把推断写成事实：查不到的数字写「本版未测量」。
- 不删除他人产物：<build/、temp/>。

## 5 产出物

- <path/a.v>：<一句话说明>。
- <evidence/<area>.log>：首行判据、全部 CHECK 行、末行 TEST_RESULT。
- <report.md>：结论先行，每个数字括注来源文件相对路径。

## 证据约定（附录）

- 证据日志保存原始 stdout，不截断 CHECK 行；失败时保留完整日志。
- 首行标记在全部检查通过后写入，避免中途落盘造成误判通过。
- 容忍行首前缀 #、;、> 和空白，便于直接粘贴仿真器输出。
- 复现命令：

```bash
python check_contract.py contract contract.md
python check_contract.py evidence evidence/area.log --expect-marker AREA_OK --min-checks 3
```

- 退出码：0 通过；1 判据不满足；2 用法或 IO 错误。

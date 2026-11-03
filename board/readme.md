# 板级交付包（board/）

结论：本目录给出约束文件、JTAG 与 Flash 两套烧写脚本、上板实测输出，以及与离线参考的逐项比对。实测表格见 [measurements.md](measurements.md)，数字由 [extract_measurements.py](extract_measurements.py) 从仓库文件抽取。复跑证据见 [evidence_board_doc.log](evidence_board_doc.log)。

## 1 器件与工具

| 项 | 值 | 源 |
|---|---|---|
| 器件 | AMD Artix-7 `xc7a100tfgg484-2`（正点原子达芬奇Pro） | `docs/06_facts/02_metric_register.md:13` |
| 开发工具 | Vivado 2020.2、ModelSim SE 2020.4 | `docs/06_facts/02_metric_register.md:14` |
| 系统时钟 | `sys_clk` 50 MHz，引脚 R4，非专用时钟引脚 | `docs/06_facts/02_metric_register.md:15` |
| 摄像头输入 | OV5640，800×480 RGB565，8 位 DVP，实测 26.4~27.0 fps | `docs/06_facts/02_metric_register.md:16` |
| 事件分辨率 | 400×240，由 800×480 经 ÷2×÷2 降采样 | `docs/06_facts/02_metric_register.md:17` |

以上口径与全仓库统一登记表一致，不在别处复述。

## 2 包内文件

| 文件 | 用途 | 源 |
|---|---|---|
| [pin.xdc](pin.xdc) | 板卡引脚约束 | `report/tools/pack_map.json:318` |
| [retina_event.xdc](retina_event.xdc) | 引脚、输入时钟、CDC 组与 DVP 输入延时约束 | `docs/06_facts/00_current_status.md:289` |
| [program_retina.tcl](program_retina.tcl) | JTAG 烧写易失位流，默认路径 `build/retina_event.bit` | `build/program_retina.tcl:1` |
| [flash_program.tcl](flash_program.tcl) | 把 `.mcs` 写入板载 SPI Flash 并校验 | `build/flash_program.tcl:1` |
| [flash_program_v3.tcl](flash_program_v3.tcl) | 句柄修正版 Flash 脚本，从器件取回 `PROGRAM.HW_CFGMEM` | `build/flash_program_v3.tcl:1` |
| [flash_retry.tcl](flash_retry.tcl) | Flash 第二次尝试，只写 h63 的 `.mcs`，失败即停 | `build/flash_retry.tcl:1` |
| [flash_detect.tcl](flash_detect.tcl) | 只读探测 Flash 型号与容量 | `docs/05_experiments/Flash固化_20261009/flash_detect.tcl:1` |
| [measurements.md](measurements.md) | 上板实测与离线参考比对，本包主证据 | 本目录 |
| [extract_measurements.py](extract_measurements.py) | 抽取数字、生成表格并自检 | 本目录 |
| [evidence_board_doc.log](evidence_board_doc.log) | 上述脚本的运行证据 | 本目录 |
| [board_vs_offline_v5.md](board_vs_offline_v5.md) | act3c 板上与离线比对的原始输出副本 | `temp_test/vs/out/board_vs_offline_v5explicit.md` |

## 3 路径 A：JTAG 烧写（易失）

结论：JTAG 是当前上板主路径，位流只进 SRAM，掉电或重启即丢失。

1. 板卡上电，JTAG 与网线连接就绪，Vivado 侧 `connect_hw_server` 可用。
2. 在包根目录执行 `vivado.bat -mode batch -source board/program_retina.tcl -log prog.log -tclargs <位流路径>`。
3. `-tclargs` 必须放在命令末尾，脚本取第一个参数作为位流路径。
4. 脚本把 JTAG 频率固定为 6 MHz；默认频率会报 `[Xicom 50-38]` 与 `[Labtools 27-3176]`。
5. 判定只看两行：`PROG_RESULT=OK` 与 `[Labtools 27-3164] End of startup status: HIGH`。
6. 烧后只读复核 `CONFIG_STATUS`：`BIT14_DONE_PIN=1`、`BIT04_EOS=1`。

## 4 路径 B：Flash 固化（脱机自启）

结论：Flash 脚本随包提供，本机未完成端到端实测，该路径只影响脱机上电自启。

- 板载配置 Flash 为 N25Q128（128 Mbit = 16 MB，SPIx4），cfgmem part 名 `n25q128-3.3v-spi-x1_x2_x4`，配置模式 `M[2:0]=001`。
- 命令：`vivado.bat -mode batch -source board/flash_program.tcl -log flash.log -tclargs <mcs 路径>`。
- 判据：`FLASH_PROG_RESULT=OK` 与 `FLASH_VERIFY=OK`，两者都需行首锚定。
- 本机 Vivado 2020.2 的 `program_hw_cfgmem` 自动化多次失败（27-3347/27-3176）。
- 现场兜底用 Hardware Manager GUI 手动添加配置存储器。随后执行 Program 与 Verify。

## 5 上电自检现象

| 检查项 | 通过现象 | 源 |
|---|---|---|
| 配置完成 | `PROG_RESULT=OK` 且 `End of startup status: HIGH` | `docs/05_experiments/m5_board_acceptance_20261029.md:114` |
| 配置寄存器 | `DONE=1`、`EOS=1`、`GWE=1` | `docs/06_facts/00_current_status.md:91` |
| 动作字节 | `/api/action` 的 `available` 由 false 变 true，`class` 与 `conf` 随动作变化 | `docs/05_experiments/m5_board_acceptance_20261029.md:118` |
| 行为反证 | 上位机 ACTION 计数从 0 开始增长，act3c 首烧为 0→403 | `docs/06_facts/00_current_status.md:28` |
| 数据通路 | 网关 `/healthz` 返回 200，事件率约 15,940 事件/秒 | `docs/06_facts/00_current_status.md:32` |
| 以太网自检 | `pwsh tool/check_eth_onboard.ps1` 退出码 0（FULL_OK） | `docs/06_facts/00_current_status.md:201` |

## 6 常见故障处置

| 现象 | 原因 | 处置 | 源 |
|---|---|---|---|
| `[Xicom 50-38]` 或 `[Labtools 27-3176]` | JTAG 默认频率对本板 FT2232H 过高 | `set_property PARAM.FREQUENCY 6000000` | `build/program_retina.tcl:11` |
| `[Labtools 27-2151] No bitstream specified` | 误用 `set_property PROGRAM.FILES` | 改用 `create_hw_bitstream` 加 `program_hw_devices` | `build/program_retina.tcl:17` |
| 烧写成功却报失败 | 本机不存在 `REGISTER.IDCODE` 等属性 | 以 `End of startup status: HIGH` 为准 | `docs/06_facts/00_current_status.md:423` |
| Flash 报 27-3347 或 27-3176 | 2020.2 的 `program_hw_cfgmem` 自动化失败 | 改用 GUI 手动添加配置存储器 | `docs/05_experiments/m5_board_acceptance_20261029.md:126` |
| 掉电后动作引擎消失 | 位流只在 SRAM，未固化 Flash | 重新 JTAG 烧写，或走路径 B 固化 | `docs/06_facts/01_fact_register.md:617` |

## 7 复现与判据

- 生成与自检：`python board/extract_measurements.py`，末行 `BOARD_DOC_OK=1`。
- 抽取条目与逐条来源见 [measurements.md](measurements.md) 的抽取索引一节。
- 硬断言 6 项：act3c 与 act7 的 WNS、LUT、位流 md5，任一不符即退出码 1。
- 结论数字：act3c WNS `+0.306 ns`、LUT `20,559`；act7 WNS `+0.059 ns`、LUT `22,371`。

## 8 边界

- 本包不含 Vivado 工程与实现报告，报告在开发树 `build/variant_*/` 下。
- act7 位流只构建未烧板，Flash 固化未实测。两项在 [measurements.md](measurements.md) 单列。
- 板上动作统计只有 act3c 一次会话，录像目录 `records/20261030-212214_v5probe`。
- 本地开发树与包内路径的映射见 `report/tools/pack_map.json`。

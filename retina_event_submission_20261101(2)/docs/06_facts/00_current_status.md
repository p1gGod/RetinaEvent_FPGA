# retina_event —— 当前状态 / 换机交接

> 生成时刻：2026-10-04 22:02（本机）
> 最后更新：2026-10-31（追加 §0 项目级状态、交付冻结与仓库同步事实；历史条目全部保留）
> 用途：**换到台式机继续工作**时的唯一入口。先读第 0 节，再按第 1 节验环境。

---

## 0. 一句话状态

**2026-10-31：交付包已冻结、仓库已同步 GitHub 私有仓、板上运行 act8（v7b 权重）；A1~A4 动作段验收已完成（3 轮有效、G2 未稳定达标），平台上传材料仍缺。**

- **项目级状态（2026-10-31 快照；本节其下各条为历史时点，按时间从新到旧排列）**：
  - **当前板上**：`build/variant_act8_final/retina_event.bit` —— **2,839,107 B**，全文件 md5 **`5ec55ec07c44f2503df63f1bb160a6e6`**，载荷 md5 `dcbcf543210c33cb22625128bc5f6b97`；**WNS +0.215 ns** / TNS 0 / WHS +0.017；LUT 22,383 / FF 14,325 / Slice 8,026（50.64%）/ BRAM 86.5 / DSP 8 / IOB 140。2026-10-31 02:02 烧写，`PROG_RESULT=OK` / `DONE_PIN=1` / `EOS=1`。
  - **模型**：**v7b 两分类权重**（s50+s100 混合训练、s100 非重叠窗评估与部署；`MARGIN_MIN=16` / `N_CONSEC=3` / guard 0.5 s / 决策节拍 100 ms / 不应期 1.5 s）。判据 **`V7B_MODEL_OK=0`** —— A 组硬负 pulse 2（门限 ≤1）、C 组 `d_wave` 0.0196（门限 ≤0.01）两项未达标，其余通过；**未放宽门限、未挑种子**，权重仍作 act8 部署权重，属**显式风险接受**（`docs/06_facts/03_v7b_deployment_decision.md`；`nn/REPORT_v7b_部署口径重训.md`）。
  - **交付包**：`submission/retina_event_submission_20261031.zip` 已于 **2026-10-31 06:22:30** 冻结 —— **666 文件 / 25,060,025 B / `TREE_HASH=8b9f987b6c1ec78865d47d08f1e8987b86bdb2dcd994276bb1cdc588ee321ede`**。⚠️ 该 `TREE_HASH` **只对应这个 zip**，不对应此后 HEAD 的仓库树（`README.md`、`report/tools/` 是打包输入，改动后重跑打包器会得到新哈希；见事实登记册 **D17**）。
  - **仓库**：私有仓 `https://github.com/scissorlight/FPGA_comp.git`，分支 `main`；**本地 HEAD 与 `origin/main` 一致**（`7b0d2bb`），工作树干净。库容：**5,002 文件 / 760.74 MiB**，最大单文件 62,915,419 B（`docs/05_experiments/板会_20261013/raw/mtu60_dump_sampled.bin`），`.git` 638 MiB ⇒ **`SIZE_VERDICT=WITHIN_LIMIT`**（GitHub 三红线：单文件 100 MB / 单次推送 2 GB / 建议仓库 <1 GB）。体检工具 `report/tools/repo_size_audit.mjs`（`REPO_HYGIENE_OK=1`、`CLONE_OK=1`）。详见事实登记册 **H94~H97** 与 `docs/07_review/07`、`08`。
  - **A1~A4 上板验收（2026-10-31 15:49–16:26，同一 act8 位流 4 轮、3 轮有效）**：A3 召回 14/20、19/20、15/20 → **累计 48/60=0.80**（最好 19/20，**G2 ≥0.85 未稳定达标**）；A1 与 A2 各 0 条（累计 180.4 s）；A4 共 1 条（退场过渡）；非 A3 误触发 1 条/421.1 s=0.143 次/分。逐轮在 `records/20261031-154917_verify_v7/`、`-160544`、`-161557`、`-162341`；报告已回填 `report/evaluation_report.md` §7.1 与 `report/design_report.md` §4.3.3。
  - **仍未完成**：①平台上传 6 项里缺**演示视频成片**（分镜已定稿）、**概览图 PNG**（源 SVG 在）、**开发板实物照 3 张**、**签名授权书**（只有用户能做）；②class2 横向挥手仍实验性、不部署；③板上时延仍无逐条时间戳（计数通路只给段级时间）。

**交付已完成并已上板；2026-10-06 又往前推了一大步 —— 以太网 UDP 回传从"未验证"变成"已上板实测通过"。**

- 原交付（`ETH_EN=0`）：36 模块 RTL + 35 TB（**715 条判据全绿**）→ 构建 OK（WNS +0.951 / WHS +0.013）→ 位流 2,443,559 B → 烧录 OK。
- **本轮（2026-10-06）**：发现并修掉 **3 个真缺陷**（其中 1 个让 `ETH_EN=1` 直接 place 失败、1 个让 UDP 每隔一包静默丢、1 个让交付位流**根本不含 UDP 通路**）→
  `ETH_EN=1` 构建 **OK**（综合后 LUT 17,445 / FF 9,145；实现后 **LUT 16,623 / FF 9,038 / BRAM 77 / DSP 5**；**WNS +0.762 / WHS +0.034**；位流 **2,447,583 B**）→
  烧录 OK → **上板实测：ARP 应答 + 40~65 个整帧（每帧 768,000 B）+ 坏包 0 + 1,982 pkt/s + 出图为真实 800×480 画面**。
- **`ETH_EN` 默认值已改为 1**（旧 `ETH_EN=0` 位流留作回退点 `build/retina_event_v2_eth0.bit`）。
- **2026-10-06 第二轮（ILA）**：加了 `ILA_EN=1` 调试变体（两个 ILA 复用同一 IP），把两件原本"靠推断 / 靠人眼"的事变成机器判据 ——
  **`cam_pclk` 周期实测 20.825 ns（48.019 MHz）**（证实 XDC 的 20.833 ns、推翻厂家的 40 ns），
  **LCD 扫描输出确在画真实且会变的画面**（`lcd_de` 占空 75.0%、4 个行起始、R 16 个不同值、两次抓取颜色集合不同）。
  见事实登记册 **H52~H54**；交付位流仍是 `ILA_EN=0`，抓完已烧回。

- **2026-10-07 第二轮（★ 用户现场判定"板上处理完全是错的"，真 bug）**：修掉**相机通路 2×2 抽点
  被静默旁路**（H63，配套 HUD 叠字 H64）+ 把两端时间基对齐（`FRAME_DECIM=1`）。详见 **§0.2**。
  当前板上的位流 = `build/retina_event_h63_h62decim1_20261007.bit`
  （md5 `F3602CD0A8EAD1C96DDF9ADB8593BCC4`，WNS +0.869 / WHS +0.011 / LUT 16 622 / BRAM 77）。
  **回退点**：`build/retina_event_pre_h63_20261007.bit`（H63 未修 + `FRAME_DECIM=8`）。

- **2026-10-30 动作识别 v5 / act3c（历史）**：2026-10-30 21:10:36 烧写，`PROG_RESULT=OK` / `DONE_PIN=1` / `EOS=1`；位流 `build/variant_act3c/retina_event.bit`（2,890,875 B，md5 `a5fff751e20019d7e80a3a953f7f8c5a`，WNS +0.306 / TNS 0 / WHS +0.036），**含 v5 两分类权重 + task-27 byte23 修复**。行为反证：ACTION 计数 0→403；逐窗回放 v5 参数 open 60 / wave 46，板上 61 / 47（v4 参数 62 / 55）⇒ 板上是 v5 引擎。**证据边界**：编程日志未留存（`prog_bit.tcl` 以 `-nolog -nojournal` 起）；烧录时间由仓库根 `.Xil/Vivado-43124-Windows_11_Plus` + `webtalk.jou` 的 `Start of session at: Fri Oct 30 21:10:36 2026` 与行为反证双重旁证，强度记为「中」，不是编程日志原文。

- **2026-10-30 M9b（历史，act3c 时点）：v7 前端已进源码，未进当时位流**：`nn_winstat.v`（像素域重居中到 50×30）、`nn_feat.v` 与 `nn_top` 的 `u_ws` / `u_feat` 已入源码；`nn_winstat` OOC 综合 **549 LUT / 626 FF / 18 LUTRAM**（修正前 781 LUT / 1461 FF），TB 107/107 PASS（`sim/nn/EVIDENCE_M3b.md`）。**但** `nn_engine` 仍无全局量 MLP，源 `nn_rom_data.v` 仍是 v5 5,476 words，v7 ROM（当前生成物 5,652 words；`results_v7_hw2` 另一版 5,668）未替换；`nn/out_v7/` 尚无 `INT8_CONTRACT.md` / `golden_vectors.json`；⇒ **act3c 不含 v7 前端，v7 位流当时尚不存在**；v7 指标只能按离线回放口径读。2026-10-31 已被 act8 取代，见下条。来源：实测（OOC 综合 + TB）+ 文档（源码/生成物）。

- **2026-10-31 动作识别 v7b / act8（当前已烧板）**：2026-10-31 02:02 烧写 `build/variant_act8_final/retina_event.bit`（2,839,107 B，全文件 md5 `5ec55ec07c44f2503df63f1bb160a6e6`，载荷 md5 `dcbcf543210c33cb22625128bc5f6b97`，头 127 B，载荷 2,838,980 B；WNS +0.215 / TNS 0 / WHS +0.017 / THS 0；LUT 22,383 / FF 14,325 / Slice 8,026（50.64%）/ BRAM 86.5 / DSP 8 / IOB 140），`PROG_RESULT=OK` / `DONE_PIN=1` / `EOS=1`；含 v7b 两分类权重 + 7 路全局量 MLP + task-27 byte23 修复。烧后 frameIdx 复位后递增到 477，空场景 raw=0 / valid=false；**板级动作计数与误触发未测**（A1~A4 已于 2026-10-31 15:49–16:26 执行（4 轮 3 有效，A3 累计 48/60=0.80，G2 未稳定达标））。来源：实测（构建 + 烧板）。

**当前用户面板**：2026-10-30 复核时网关在 `192.168.1.102:1234` 收流、`127.0.0.1:8787` 提供界面（healthz 200、pps≈15,940）；本文件不保证实时状态。

> ⚠️ 本轮的关键结论：**旧交付报告里 `LUT 15,379 / FF 7,802` 那组数字不包含 UDP 通路**
> （`ETH_EN=0` 时 `event_sink` 的 UDP 输出悬空 ⇒ Vivado 把 `udp_merge` 整块优化掉）。
> 详见事实登记册 **H46~H51**。

---

## 0.1 ★ 2026-10-07：把上位机已验证的事件工作点适配到板子上

**一句话**：算法链**一字未改**（它本来就是逐位同构的），改的是**档位** ——
旧档位在物理上到不了上位机现场扫出来的可用工作点。

| | 改前 | 改后 |
|---|---|---|
| θ 档位 | {44, 74, 130} | **{1, 1, 3, 44}** |
| 守卫档位 | {1, 2, 3} | **{20, 32, 18, 1}**（与 θ **成对**） |
| 档位数 | 3 | **4**（= 上位机 `HOST_PRESETS` 条数） |
| **上电默认** | θ=44 / 守卫=1（本场景下等于全黑，1.1 事件/帧） | **θ=1 / 守卫=20**（运动区域） |

四个档位与上位机 `host/app/web/src/hostparams.ts` 的 `HOST_PRESETS` **条数与顺序逐个一致**，
所以板子与上位机可以 1:1 对照：

| 档位 | 名称 | θ | 守卫 |
|---|---|---|---|
| **0** | **运动区域**（★ 上电默认） | 1 | 20 |
| 1 | 区域·省流 | 1 | 32 |
| 2 | 运动边缘 | 3 | 18 |
| 3 | 旧板端（对照） | 44 | 1 |

**唯一改动的 RTL 文件**：`src/hdl/control/sys_ctrl.v`（B5 工作点译码 + 上电默认）。
算法链 `px_luma / luma_log / temporal_diff / spatial_lap / event_gen / refractory` **未改**。

### 证据（怎么证明"板子算的 = 上位机算的"）

```powershell
# ① RTL 侧：跑工作点等价测试台（约 5 分钟），出逐帧事件数 + 逐条事件转储
cd E:\workspace\FPGA_Comp\retina_event
pwsh -NoProfile -File tool\run_sim.ps1 -Tb tb_retina_core_wp      # 期望 TEST_RESULT=PASS
#    产物：build\sim\tb_retina_core_wp\wp_events.txt   （每条事件：pass frame x y pol）

# ② 上位机侧：逐事件对拍（不是比计数，是比每一条事件的 (x,y,pol) 集合）
cd E:\workspace\FPGA_Comp\host\app
node --experimental-strip-types tools\rtl_wp_compare.ts            # 期望 RTL_WP_COMPARE=PASS
```

- **自校验**：测试台第 0 遍（θ=74 / 守卫=2 / 余晖旁路）必须复现 `tb_retina_core` 的已知 golden
  `0,0,5841,0,0,0,4,0,64,0,64,0,4` —— 实测复现；复现不了则后面几遍一律不算数。
- **结论**：5 遍（含 θ=1/守卫=20）**全部逐条一致**；θ=1/守卫=20 那一遍 **43 267 条事件**，
  两边 (x,y,pol) 集合完全相同。
- **判决级**：第 3 帧整帧 **95,361 个** `spatial_lap` 输出（坐标 / `lap` / 中心 `ΔL`）
  与上位机**逐点一致**（事实 **H57**）。

### ★ 上板实测（2026-10-07，事实 H59/H60/H61/H62）

| 项 | 结果 |
|---|---|
| 构建 | `BUILD_RESULT=OK`；DRC 错误 0 / 关键警告 0；**WNS +0.879 / WHS +0.032**；LUT 16,629 / FF 9,038 / BRAM 77 / DSP 5（比改前只多 **6 个 LUT**） |
| 比特流 | 2,426,503 B，md5 `DBFD12F856CFAEC9645996203E2F853C`（归档 `build/retina_event_wp_20261007.bit`） |
| 烧录 | `PROG_RESULT=OK` + `End of startup status: HIGH`；JTAG 只读：`DONE=1 / EOS=1 / GWE=1` |
| **板端事件率** | **平均 2 288 事件/帧**（min 981 / max 3 101；`origin="board"` 即板子自己算的）—— 改前板端默认是 **1.1 事件/帧**，**量级差约 2 000×** |
| 整帧速率 | 3.3 fps（= 26.4 ÷ `frameDecim 8` ✓），`idxGap = 0` / `crcFail = 0` / `evDrop = 0` |
| **ILA 独立复核** | **2 649 事件/帧**（`stat_ev_pf_lcd`，**不经过网络**）—— 与网络路径的 2 288 平均落在同一区间（事实 **H61**）；同批确认 `stat_fcnt_lcd` 699→742 在推进、`cam_data` 84 个不同值、`lcd_de` 占空 75.3% |

> ⚠️ **上板时踩到并修掉的一个"与适配无关"的真问题（H59）**：网关原来跑的是
> `--profile legacy-800x480-1280`，而板子发的是 **v2/STREAM**。两者**魔数相同**（缺口 G6），
> 且 v2 的 1295 B 包 ≥ v1 的 `FIRST_PKT=1290` ⇒ v1 解析器把**每个包**都当首包、
> 按错偏移读帧号 ⇒ 每包 abort 一次（`aborted` ≈ 包数、`idxGap` ≈ 255/包）。
> **症状极像板子坏**：包全在到、`badMagic=0 / crcFail=0 / badLength=0`，就是组不出帧。
> **正确 profile = `retina-v2-800x480-1280`**；诊断工具 `host/app/tools/profile_probe.ts`。
> 以后遇到"包在到但组不出帧"，**先跑它**。

### ⚠️ 两条"看数字会误判"的提醒（本轮实测踩到，已写进事实登记册）

1. **合成图案分不出档位**：该图案的中心 `|ΔL|` 只有 103/152、`|lap| ≥ 26`，且相邻帧不会都有事件
   ⇒ **θ=1 与 θ=3 切出同一批像素、守卫 20 与 32 也相同、不应期不削减任何事件**。
   **档位之间的差别必须用真实场景分辨**（上位机的 θ 扫描就是干这个的）。
   测试台因此把这几条断言写成"**相等**"（并写明理由），而不是硬套"越大越少"。
2. **测试台状态泄漏会伪装成算法缺陷**：`temporal_diff.frame_mem` / `refractory.cool_mem`
   是 BRAM 数组，**`rst_n` 故意不清它们**（板上只上电一次）。在**同一次仿真里跑多遍**时
   必须手清，否则第 N 遍带着第 N-1 遍的余晖位跑 —— 实测表现为"pass3 比 pass1 少 793 个事件，
   且两组不同参数给出同一结果"，非常像 RTL bug。见事实 **H58**。

---

## 0.2 ★★ 2026-10-07（第二轮）：用户判定"板上处理完全是错的" —— **真 bug，已修并两重验证**

**一句话**：算法链还是没错，错在**入口通路的 `de` 契约**。
`retina_core` 把 CDC-0 的 `~empty`（"本拍有数据"的**稀疏选通**）当 VPS 的 `de`
（"带消隐的数据使能"）交给 `vps_resample`，而后者有一支 `else x_cnt <= 0;`（行间清零），
于是**每个像素前面**都触发一次 ⇒ `x_cnt` 永远到不了 799 ⇒ **2×2 抽点被静默旁路**，
整条链退化成"空间边缘检测 + 坐标回绕"。事实 **H63**（配套 **H64** HUD 叠字）。

| | 改前（实测复现） | 改后 |
|---|---|---|
| 每帧进入 `spatial_lap` 的 de | **383 999** | **96 000**（= 400×240） |
| 事件 y 最大值 | **254**（越出 400×240 网格） | **238**（网格上限） |
| 每帧事件数 | 14 441 | 478（合成场景：2 列 × 239 行） |
| 事件场形态 | 满屏竖条纹 + **每帧左移 1 像素** | 连贯的运动区域轮廓 |

### 本轮的 4 处改动

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/hdl/capture/vps_resample.v` | **删掉 `else x_cnt <= 0;`**；行结构改由"像素计数在 `IN_W` 回绕"给出（与 `spatial_lap.v` 的**「关键约定 1」同源**） |
| 2 | `src/hdl/subsys/retina_core.v` | CDC-0 的**帧标记改为在"消隐拍"呈现**（队头带标记时先出一拍 `vsync` 且不弹出），让相机通路与 `vps_pattern_gen` 通路**结构一致**、抽点相位不再错开 1 个输入像素 |
| 3 | `src/hdl/subsys/event_sink.v` | **`FRAME_DECIM` 8 → 1**（H62 选项 (a)：让"上位机模拟处理"与板端引擎**同一时间基**） |
| 4 | `src/hdl/subsys/display_path.v` | `hud_text` 落点 `(8,40)` → **`(288,440)`**，躲开 `hud_panel` 第 2 行（H64） |

### 新增的回归（此前**没有任何 TB 覆盖相机通路**）

`sim/tb/tb_retina_core_cam.v` + `.f`：真实 DVP 时序（cam_pclk 48.05 MHz）+ 真实
CDC-0 拓扑（cam_tap → axis_fifo → clk_cam 50 MHz）+ 静态竖条纹背景 + 每帧右移
2 输入像素的亮条。**改前 6 条判据全红，改后 9/9 全绿。**

### 验证结论（数字见 H63/H65）

- 仿真：**37 个 TB / 749 条判据 / 0 FAIL**；`rtl_cam_compare.ts` 把相机通路下
  稳态 5 帧的 **2 390 条事件与上位机逐条对齐（2390/2390）**。
- 上板：**26.58 fps / 16 001 pps / 20.66 MB/s / `idxGap` 增长 0**；
  **`fresh == count` 90/90 帧、100 302 条事件全部落在 400×240 网格内**；
  同 44 帧同 `frameIdx` 逐条比 ⇒ **板端集合是上位机（余晖旁路）的精确子集
  （44 742/44 742 全中）**，且在板端余晖不生效的 20/44 帧上**完全相等**。
- 仍差最后一处：**不应期实现机制不同**（H66，已量化未改，等用户裁决）。

> ⚠️ **别再犯的测量错误**：摆动装置每帧事件数在 **20…3800** 之间变化，
> 两种模式**分时**采样得到的"均值比"（曾得 2.86 / 4.83）**是混叠假象**。
> 比两端必须用**同一 `frameIdx` 比集合**（`tools/onboard_exact*.ts`）。

---

## 1. 换机第一步：验环境

### 1.1 必需工具与路径（本机值，台式机上**可能不同，请逐个确认**）

| 工具 | 本机路径 | 用途 |
|---|---|---|
| Vivado **2020.2** | `E:\Programs\Xilinx\Vivado\2020.2\bin\vivado.bat` | 构建 / 烧录 |
| ModelSim SE **2020.4** | `E:\Programs\modeltech64_2020.4\win64\`（`vlog.exe`/`vsim.exe`/`vlib.exe`） | 仿真 |
| ModelSim ini | `E:\Programs\modeltech64_2020.4\modelsim.ini` | 见坑 §6.1 |
| FPGABuilder_AMD（只读） | `E:\Tools\FPGABuilder_AMD\fpgab.bat` | 备用工作流 |
| 工程根 | `E:\workspace\FPGA_Comp\retina_event\` | 全部交付物 |

> ⚠️ **Vivado 必须 2020.2**。厂家工程 `prj/retina_event.xpr` 的 Product Version 是 `v2020.2`；**不要用 2023.2 打开它**（会改写工程版本）。2023.2 只在 comms-dev 做单模块 OOC 综合时用过（与 `fpgab.bat` 同版本，那是一次性验证，未碰 `.xpr`）。

### 1.2 环境自检命令

```powershell
cd E:\workspace\FPGA_Comp\retina_event

# ① 工具是否在
Test-Path 'E:\Programs\Xilinx\Vivado\2020.2\bin\vivado.bat'
Test-Path 'E:\Programs\modeltech64_2020.4\win64\vsim.exe'
$env:MODELSIM      # 必须指向 modelsim.ini（见 §6.1）

# ② 源码完整性
(Get-ChildItem src\hdl -Recurse -Filter *.v).Count      # 期望 36
(Get-ChildItem ref_original -Recurse -Filter *.v).Count # 期望 26
(Get-ChildItem sim\tb -Filter 'tb_*.v').Count           # 期望 35

# ③ 冒烟：跑一个 5 秒的 TB
pwsh -NoProfile -File tool\run_sim.ps1 -Tb tb_sync_ff   # 期望 TEST_RESULT=PASS

# ④ 全量回归（约 15 分钟，含整系统仿真 217 s）
pwsh -NoProfile -File tool\run_all_sims.ps1 -Out build\sim_summary.txt

# ⑤ 综合层闸门（约 10 分钟）
pwsh -NoProfile -File tool\check_synth_warnings.ps1

# ⑥ ★ 上板以太网自检（一条命令；退出码 0 = FULL_OK）
#    前提：板子已烧 ETH_EN=1 位流、网线插底板 GE1、PC 有 192.168.1.102
pwsh -NoProfile -ExecutionPolicy Bypass -File tool\check_eth_onboard.ps1
```

### 1.2.1 ★ 本机上板验证的 4 个环境陷阱（2026-10-06 实测，都会让人误判）

| 陷阱 | 症状 | 处置 |
|---|---|---|
| **Clash/Meta TUN 劫持** | `ping 192.168.1.10` **成功**（TTL=64、<1ms），其实板子根本没应答；`Find-NetRoute -RemoteIPAddress 192.168.1.10` 显示出口是虚拟网卡 `Meta`（198.18.0.1/30，默认路由 metric 0） | 一律 `ping -S 192.168.1.102` **源绑定**；判据改用**真实网卡邻居表 MAC**（`Get-NetNeighbor` = `00-11-22-33-44-55`）——代理造不出这条 L2 邻居项 |
| **防火墙 Block 掉 DSH 自带 python** | socket 收 0 个报文，但网卡 `ReceivedUnicastPackets` 猛涨（10 s +14,727） | 用**系统 Python 3.14**（`C:\Users\Admin\AppData\Local\Programs\Python\Python314\python.exe`）或 `node.exe` 跑收包脚本；**别用** `...\.dsh\dsh-runtimes\...\python.exe`（有显式 inbound Block 规则） |
| **厂家栈不回 ICMP** | `ping` 100% 丢包，但 ARP/UDP 全通 | 判据不能依赖 ping；用 ARP MAC + UDP 整帧 |
| **默认 64 KB `SO_RCVBUF`** | 1,470 pkt/s 只收到 268 pkt/s（51 残帧 / 0 整帧） | 收包脚本设 `SO_RCVBUF=16 MB` + 查表 CRC（`tool/udp_frame_check.py` 已内置） |

> 另：本机**没有** FTDI B 通道的 COM 口（只枚举出 `USB Serial Converter` A 通道）⇒
> `UART_EN=1` 的串口遥测**无法在本机验证**，故仍保持 0。

### 1.3 换机注意事项

- 若台式机上 **ModelSim / Vivado 路径不同**：改 `tool/run_sim.ps1`（顶部 `$modelsim`）与 `tool/build_retina.ps1` / `tool/build_inproc.ps1`（顶部 `$vivado` / `$root`）。
- 若 **工程根不同**：`tool/build_inproc.tcl` / `build_retina.tcl` / `program_retina.tcl` 顶部的 `$root` 要改。
- `prj/` 内有**大量本机绝对路径**（Vivado 工程固有）。最稳的做法是**重新拷贝厂家工程**再改名，而不是搬 `prj/`：见 `tool/` 下 build-dev 的拷贝流程说明，或直接按 §2.2 的两个已知坑处理。
- **`build/` 不必搬**（可重建），但 `build/retina_event.bit` 是已上板的成品，建议留着。

---

## 2. 复现全流程（三条命令）

```powershell
cd E:\workspace\FPGA_Comp\retina_event

# 1) 全量仿真  → 期望 35/35 PASS，703 条判据
pwsh -NoProfile -File tool\run_all_sims.ps1 -Out build\sim_summary.txt

# 2) 构建      → 期望 BUILD_RESULT=OK，约 12.6 分钟
pwsh -NoProfile -File tool\build_retina.ps1 -Mode --full -Jobs 12

# 3) 烧录      → 期望 PROG_RESULT=OK + "End of startup status: HIGH"
& 'E:\Programs\Xilinx\Vivado\2020.2\bin\vivado.bat' -mode batch `
    -source tool\program_retina.tcl -log tool\program_retina.log `
    -tclargs build\retina_event.bit
```

### 2.1 期望数字（用作回归基线）

```
仿真 : 35 个 TB / 35 PASS / 715 条判据 / 0 FAIL
       tb_retina_core PASS 50/50   tb_top_retina_event PASS 15/15（~91 s）
构建 : INPROC_RESULT=OK（tool/build_inproc.tcl --full）
       综合后: LUT 17,445  FF 9,145   （修 ETH-1 之前是 38,852 / 68,188）
       实现后: LUT 16,623  FF 9,038  BRAM 77  DSP 5
       WNS +0.762  WHS +0.034  TNS 0.000  THS 0.000
       clk_lcd present=1  period=40.000  source=u_clk_rst_gen/clk_25m_pre_reg/Q
       cam_pclk period=20.833   eth_rxc period=8.000   sys_clk period=20.000
       bit 2,447,583 B  md5=70C0E26B08BCB3A6B5763F26EF20996C
上板 : PROG_RESULT=OK + "End of startup status: HIGH"
       tool/check_eth_onboard.ps1 → VERIFY_RESULT=FULL_OK（退出码 0）
       ARP MAC 00-11-22-33-44-55 Reachable；UDP 39~65 整帧 × 768,000 B；坏包 0；~1,972 pkt/s
闸门 : CHK_MODULES=36  CHK_ERRORS=0  CHK_CRIT=0  CHK_RESULT=OK

── 以下为 2026-10-03 原交付（ETH_EN=0）的基线，**不含 UDP 通路**，仅供回溯 ──
       综合: 0 errors, 0 critical warnings, 157~170 warnings
       WNS +0.951  WHS +0.013  TNS 0.000  THS 0.000
       LUT 15379  FF 7802  BRAM 73  DSP 5
       DRC: 0 Errors / 0 Critical Warnings / 81 Warnings
       bit 2,443,559 B  md5=205221D224A929376AC51A6E82A882B6
```

### 2.2 ⚠️ 两个必踩的构建坑（已内置修复，但换机可能复现）

**(a) `launch_runs` 在本环境挂死** → 必须走**进程内**流程。
```
rundef.js(121, 5) JavaScript runtime error: Access denied
*** Running vivado with args -log clk_wiz_0.vds ... -source clk_wiz_0.tcl   ← 只写这一行就停住
```
`vrs` 子进程不出工（父进程 20 s 内 CPU 只涨 0.05 s）。`build_retina.ps1 --full` 默认已是进程内；`--runs` 模式在本机不可用。参考 `tool/build_inproc.tcl`。

**(b) 工程整份拷贝到新路径后 IP 产物失效** → `generate_target all [get_ips]`（约 23 s）。
```
ERROR: [Synth 8-439] module 'mig_7series_0' not found  [ref_original/ddr3_top.v:118]
```
两个构建脚本都已固定保留这一步。

---

## 3. 交付物地图

| 位置 | 内容 | 说明 |
|---|---|---|
| `src/hdl/` | **36 个模块 RTL** | `primitives/` `control/` `capture/` `engine/` `display/` `hud/` `comms/` `subsys/` `top/` |
| `src/constraints/retina_event.xdc` | 71 条引脚 + 3 输入时钟 + `clk_lcd` generated clock + CDC 组 + DVP `set_input_delay` | **XDC 只能写无条件约束，不能写 `if`/`puts`** |
| `ref_original/` | **26 个厂家 RTL（未改一字）** | `tool/setup_vendor_rtl.ps1 -Check` 应 26/26 |
| `prj/retina_event.xpr` | Vivado 2020.2 工程 | 4 个 IP：`clk_wiz_0` `mig_7series_0` `rd_fifo` `wr_fifo` |
| `sim/tb/` | **35 个 testbench** + `.f` 依赖清单 | `tb_*.f` 里路径相对工程根 |
| `docs/交付报告.md` | **完整交付报告** | 结论/复现/坑/9 个 bug/残留/清单 |
| `docs/00_current_status.md` | **本文件** | 换机交接 |
| `build/retina_event.bit` | **旧交付位流**（`ETH_EN=1`，历史）2,447,583 B，md5 `70C0E26B08BCB3A6B5763F26EF20996C`，**已烧录 + 上板验证** |
| `build/variant_act3b/retina_event.bit` | **act3b 基线**（2026-10-29 构建，v4 两分类 ROM）2,675,095 B，md5 `361713e0a455e5c1436365fe39dbd821`；**未烧板** |
| `build/variant_act3c/retina_event.bit` | **历史：act3c**（v5 两分类权重 + byte23 修复）2,890,875 B，md5 `a5fff751e20019d7e80a3a953f7f8c5a`，WNS +0.306 / TNS 0 / WHS +0.036；2026-10-30 21:10:36 烧写，`PROG_RESULT=OK` / `DONE_PIN=1` / `EOS=1`；证据 `sim/nn/EVIDENCE_M2E.md` |
| `build/variant_act8_final/retina_event.bit` | **当前已烧板 act8**（v7b 两分类 + 7 路全局量 MLP + byte23）2,839,107 B，全文件 md5 `5ec55ec07c44f2503df63f1bb160a6e6`，载荷 md5 `dcbcf543210c33cb22625128bc5f6b97`（头 127 B，载荷 2,838,980 B）；WNS +0.215 / TNS 0 / WHS +0.017 / THS 0，LUT 22,383 / FF 14,325 / Slice 8,026（50.64%）/ BRAM 86.5 / DSP 8 / IOB 140；2026-10-31 02:02 烧写，`PROG_RESULT=OK` / `DONE_PIN=1` / `EOS=1`；证据 `sim/nn/EVIDENCE_M3j.md` |
| `build/retina_event_v2_eth0.bit` | **回退点**：2026-10-03 的 `ETH_EN=0` 位流（2,443,559 B，md5 `205221D2…`，不含 UDP 通路） |
| `build/retina_event_v1_programmed.bit` | 更早的 v1 回退点（md5 `AEBBC895…`，不含 R1/R2/R3） |
| `build/variant_eth/` | `ETH_EN=1` 变体构建产物（综合/实现报告 + 位流），与交付位流同源 |
| `docs/evidence/eth_udp_first_frame.png` | **上板抓帧证据**：UDP 回传的 800×480 首帧（实拍标定纸） |

**act8 已包含**（下列各项在 act3c 时点都不在位流里；act8 已构建并烧板，逐项如下）：

1. **v7b ROM**：`nn_rom_data.v` 已换为 v7b 5,652 words（sha256 `4288488d…`），布局与 `rom_offsets.json` 全等。✅ act8 已包含。
2. **`nn_engine` 布局改造**：v7b 的 `g1` 为 7 路（`g1_w 4896/112`、`g1_b 5568/16`、`g1_sh 5634/16`），全局量已进 `nn_engine`。✅ act8 已包含。
3. **`nn_winstat` 进整机**：OOC 549 LUT / 626 FF / 18 LUTRAM，TB 107/107；act8 已进整机并烧板。✅
4. **全局量 MLP**：7 路全局特征已真正进 `nn_engine`，不再只挂 `o_glob_bus`。✅ act8 已包含。
5. **byte23 回归确认**：act8 保留 act3c 的 task-27 修复；2026-10-31 的 A1~A4 验收未单独复验该字节（验收只核事件计数与丢帧），仍待专项检查。

> 前置状态（**2026-10-31 复核订正**）：`nn/out_v7b/golden_vectors.json` 与 `nn/out_v7b/INT8_CONTRACT.md`（20,880 B，2026-10-31 02:44）**均已就位**，原文「`INT8_CONTRACT.md` 仍缺」已不成立；act8 已烧板。M5 上板验收方案（`05_实验与实测/上位机动作识别_20261029/m5_board_acceptance_v2_20261030.md`）的 P4 之后已用一键脚本 v1.2.0 跑完 4 轮 A1~A4（3 轮有效，见 `05_实验与实测/上位机动作识别_20261029/act8_board_acceptance_a1a4_20261031.md`）。**口径提醒**：该脚本阶段时长为 60/60/40/20 ≈ 182 s，与 M5 v2 的 210 s（A3 70 s，含第 20 次后 30 s 静止保持段）不同，**M5 的 5 轮 × 210 s 设计目标仍未执行**。

### 3.1 `tool/` 关键脚本

| 脚本 | 作用 |
|---|---|
| `run_sim.ps1` | 单 TB：`-Tb tb_xxx`；判据 `TEST_RESULT=PASS`、逐条 `CHECK=<name> PASS|FAIL` |
| `run_all_sims.ps1` | 全量套件；`-Only a,b,c` 子集；出 `build/sim_summary.txt` |
| `build_retina.tcl/.ps1` | 构建；`--full`（进程内）/`--dryrun`/`--runs`/`--resume`；标记 `BUILD_*` |
| `build_inproc.tcl/.ps1` | 进程内最小构建（Lead 版）；标记 `INPROC_*` |
| `program_retina.tcl` | JTAG 烧录（6 MHz + `create_hw_bitstream`）；标记 `PROG_*` |
| `check_synth_warnings.ps1` | **综合层闸门**；标记 `CHK_*` |
| `gen_font.py` / `bitmap_dump.py` / `receive_udp.py` | 字库生成 / 位图 dump 成 PNG / PC 端 UDP 接收+自测（需 numpy ⇒ 只能离线跑，见 §1.2.1 陷阱 b） |
| `setup_vendor_rtl.ps1` | 从厂家例程铺 `ref_original/`（26 个） |
| `check_eth_onboard.ps1` | ★ 上板以太网自检（ARP MAC 门 + UDP 整帧），退出码 0 = FULL_OK |
| `udp_frame_check.py` | 纯 stdlib 收包/拆包/CRC16/整帧重组 + 导出 PPM（防火墙限制下用系统 Python 3.14 跑） |
| `create_ila_ip.tcl` | 建/更新调试 ILA IP（**必须关 OOC 综合**，否则 `[Synth 8-439] module 'ila_dbg' not found`） |
| `ila_capture.tcl` | 抓两个 ILA 的波形到 CSV（**按真实网名设触发**，否则会整段抓到消隐） |
| `ila_analyze.py` | 从 CSV 自动判定：cam_pclk 周期实测 + LCD/DDR3 读通路是否在出真实画面 |
| `hier_util.tcl` / `ooc_ram_probe.tcl` | 分层利用率（定位资源异常）/ 单模块 OOC 综合看数组是否落成 RAM |
| `run_awake_cmd.ps1` | 通用防待机包装（`run_awake.ps1` 只能包 `fpgab.bat`） |

---

## 4. 硬件事实（改 XDC 前必看）

| 项 | 值 |
|---|---|
| 器件 | `xc7a100tfgg484-2`（达芬奇Pro） |
| 系统时钟 | `sys_clk` = **R4**，50 MHz（**非专用时钟引脚** ⇒ 需 `CLOCK_DEDICATED_ROUTE FALSE`） |
| 复位 / 按键 | `sys_rst_n`=U7；`key[3:0]` = T4/T3/R6/T6（**低有效**） |
| LED / 蜂鸣器 | `led[3:0]` = V9/Y8/Y7/W7；`beep` = V7 |
| LCD 背光/复位 | `lcd_bl`=W9；`lcd_rst`=Y9 |
| **Bank34/35 VCCO = 1.35 V（DDR3L）** | `sys_clk`/`sys_rst_n`/`key`/`led`/`beep`/`lcd_bl`/`lcd_rst` **必须 `LVCMOS15`**；写错只在实现阶段报 `[DRC BIVC-1] conflicting VCCOs` |
| 摄像头 | OV5640 800×480 RGB565，8-bit DVP，**2 个 `cam_pclk` / 像素**；`cam_pclk` 周期 **20.833 ns**（厂家的 40 ns 是错的） |
| LCD | ATK-MD0430R-800480：H 128/88/800/40 = **1056**，V 2/33/480/10 = **525**，25 MHz，**DE 模式且 HS/VS 拉高** |
| 网口 | `eth_rxc` 周期 8.000 ns（125 MHz，Y18） |

### 4.1 时钟方案（冻结）

`clk_wiz_0`（**未改 xci**）：`clk_out1` = 200 MHz（MIG + IDELAY 参考）；`clk_out2` = 50 MHz = `clk_cam`；`CLKOUT3_USED=false`。
`clk_lcd` = `clk_out2` ÷2 + BUFG（在 `clk_rst_gen` 内）= 25 MHz。

> ⚠️ **`clk_lcd` 必须手写 `create_generated_clock`**。Vivado 的自动派生**只发生在 MMCM/PLL 输出引脚，不会穿过 fabric 分频寄存器** ⇒ 不写就整个 25 MHz 域**不被时序分析**（静默风险）。XDC 里已写，路径 `u_clk_rst_gen/clk_25m_pre_reg/C|Q`。

### 4.2 CDC 纪律

| 通道 | 机制 |
|---|---|
| CDC-0 | 异步 FIFO（`cam_pclk` → `clk_cam`） |
| CDC-1 | 简单双口 BRAM |
| CDC-2 | 两级同步器 `sync_ff`（慢变统计量） |
| CDC-3 | 异步 FIFO（`clk_cam` → `clk_eth`，多 bit 事件） |

XDC 只保留 `cam_pclk↔sys_clk` 一对 `set_false_path`：**XDC 里 `set_false_path` 的某个对象集为空时 Vivado 会丢掉那个选项、用剩下的继续执行（只报 CRITICAL WARNING）—— `-to` 为空会退化成"X 到所有目的地"，静默过度放宽比不写更危险。**

---

## 5. 已修掉的 18 个真 bug（快速索引，细节见 `docs/交付报告.md`）

> **9 个**是开发期修的（其中 5 个单模块 TB 全绿也照样漏）；**4 个**在最后的冻结窗口修（R1/R2/R3/BugA/BugB/axis_fifo）；
> **3 个**是 2026-10-06 打通以太网通路时修的（ETH-1/2/3，见下 14~16 行，证据在事实登记册 H46~H48）。

| # | 模块 | 一句话 | 暴露方式 |
|---|---|---|---|
| 1 | `clk_rst_gen` | `sys_clk` 同时喂 MMCM + 寄存器 ⇒ `[Synth 8-5535] illegal connections`，**致命** | 综合 |
| 2 | `axis_fifo` | 写满判据自依赖 ⇒ 组合环，**就是那条 `[Synth 8-295] timing loop`** | 满路径+综合 |
| 3 | `axis_fifo` | 满判据用"下一拍位置" ⇒ **容量只有 15**（DEPTH=16） | 满路径判据 |
| 4 | `temporal_diff` | 帧尾地址越界写进 `mem[0]` | 单模块 TB |
| 5 | `stats_counter` | 除法器比较点建在移位前（640048/96 得 4095 而非 6667） | 单模块 TB |
| 6 | `refractory` | 冷却位图清扫相位 ⇒ 相邻两帧连续放行 | 单模块 TB |
| 7 | `udp_merge` | `rd_slot` 被两个 always 块驱动 ⇒ `[Synth 8-6859/6858]` | 综合 |
| 8 | `spatial_lap`/`event_gen` | 把**稀疏 `de`** 当消隐 ⇒ `o_de` 恒 0 | 集成 |
| 9 | `vps_mux` | `sel_r` 只在相机帧边界更新 ⇒ 无相机时自选源切不过去 | 集成 |
| 10 | **R1** `vps_resample`/`vps_pattern_gen` | vsync 与首个像素同拍 ⇒ 每帧 **241 行 × 400 = 96,400**（应 96,000） | 集成 |
| 11 | **R2** `retina_core.first_frame` | 首帧抑制失效 ⇒ **11,920 个假事件** | 集成 |
| 12 | **Bug A** `spatial_lap` | `vs_d <= vs2` 被包进 `if(de2)` ⇒ `o_vsync` **恒 0** | 集成 |
| 13 | **Bug B / R3** | 下游重建坐标+守卫 ΔL ⇒ 原点差 (95px,88行) + 漂移 ≈ **−25 行/帧** | 集成 |
| 14 | **ETH-1** `udp_merge`/`eth_udp` | 数组写放在 `always @(posedge clk or negedge rst_n)` 里 ⇒ Vivado `RAM ... dissolved into registers`（raw_ram 40,960 + ev_ram 1,260 + pkt_ram 16,384 = 58,604 FF）⇒ FF 68,188 / 控制集 5,021 ⇒ `[Place 30-487]` **place 失败** | **综合 + 实现** |
| 15 | **ETH-2** `event_sink`/`top` | `udp_merge.i_tx_ready` 硬接 `1'b1`，顶层 `eth_tx_ready` 悬空 ⇒ `eth_udp` 在 `W_LOAD`/`W_WAIT` 忽略 `i_tx_start` ⇒ **每隔一包静默丢失** | **上板**（0 坏包/整帧数） |
| 16 | **ETH-3** 交付位流 | `ETH_EN=0` ⇒ `event_sink` 的 UDP 输出悬空 ⇒ **`udp_merge` 整块被优化掉**；旧报告 `LUT 15,379 / FF 7,802` 不含 UDP 通路 | 打开交付 `post_synth.dcp` 逐层级核对 |
| 17 | 🔴 ★ **H63** `vps_resample` | 与第 8 条**同一个坑**，但只修了 `spatial_lap` **没修这里**：`else x_cnt <= 0;` 假设 `de` 带消隐，而相机通路的 `de` 是 CDC-0 的**稀疏选通** ⇒ `x_cnt` 永远到不了 799 ⇒ **2×2 抽点被静默旁路** ⇒ 每帧 de 383 999（应 96 000）、`temporal_diff` 参考退化成常数 ⇒ **整条链变成空间边缘检测**、事件 y 到 **254**（越出网格）、事件场**每帧左移 1 像素** | **上板 + 用户现场判定** |
| 18 | ⚠️ **H64** `display_path` | `hud_text` 默认落点 (8,40) 与 `hud_panel` 第 2 行 (y 44…76) **矩形相交** ⇒ 两串白字叠画 | 用户 LCD 拍照 |

> **第 17 条为什么此前所有 TB 都漏**：入口有 **2 条**（相机 / 自检图案），`de` 的形态有 **2 种**
> （稀疏选通 / 连续带消隐），交叉有 4 格 —— 改前只测了"自检图案 × 连续"这一格。
> 补上的 `sim/tb/tb_retina_core_cam.v` 覆盖"相机 × 稀疏"（改前 6 条判据全红）。
> **教训**：写"等价性证明"时必须先列出**被测模块的输入契约**，再问"这个契约在每条入口通路上都成立吗"。

> **为什么 14/15 单模块 TB 全绿也漏**：`tb_udp_merge` / `tb_eth_udp` 只验功能语义，
> 不验"能不能布通"（14 是**工具推断**问题）也不验**顶层连线**（15 是集成问题）。

### 5.1 R3 的架构性裁决（**再改这条链路前务必先看**）

**规矩：坐标/守卫必须随流走，不能在下游重建。**
`spatial_lap` 输出 `o_x[8:0]` / `o_y[7:0]` / `o_dl_c[8:0]`，全部取自**同一组窗口中心寄存器**，与 `o_lap`/`o_de` 同拍；`event_gen` 已删除内部 x/y 计数、删除 `i_vsync`、删除所有 `delay_pipe` 补偿，直接用 `i_dl_c`/`i_x`/`i_y`。

**原因（实测）**：`spatial_lap` 的窗口中心天然晚「3 拍流水 + 1 个 de 间隔」，而**间隔随 de 稀疏度变化（稀疏 5 拍 / 连续 4 拍）⇒ 任何固定 `delay_pipe` 都对不准**。任何"用 vsync 复位 + 数 de 脉冲重建坐标"的方案都是脆的。

**残留契约**：`vps_pattern_gen` / 真实相机**必须把 vsync 放在场消隐期** —— 这是 resample "每行恰好 400" 的前提。

---

## 6. 环境坑速查（会让人误判成"设计问题"）

1. **ModelSim ini 的正确用法**：`MODELSIM` **环境变量**指向 `E:\Programs\modeltech64_2020.4\modelsim.ini`。**别用 `-modelsimini`**（本机实测它会被加上花括号 `{C:\...}` 导致 EINVAL）。
2. **`run_all_sims.ps1 -Only` 必须传逗号分隔的单个字符串**（`pwsh -File` 的参数解析不支持数组，否则报 "A positional parameter cannot be found"）。
3. **实测的 JTAG 坑**：
   - 默认 JTAG 频率太高 ⇒ `[Xicom 50-38]` / `[Labtools 27-3176]`，**必须 `set_property PARAM.FREQUENCY 6000000`**；
   - **不要用 `set_property PROGRAM.FILES`**（报 `[Labtools 27-2151] No bitstream specified`），要 `create_hw_bitstream -hw_device $dev <bit>` 再 `program_hw_devices $dev`；
   - `get_property REGISTER.IDCODE` 与 `REGISTER.CONFIG_STATUS.BITSTREAM_DONE` **在本机不存在**，没包 `catch` 会「**烧成功了却报失败**」。**真正的成功判据是 `[Labtools 27-3164] End of startup status: HIGH`**。
4. **XDC 三条语义**：`read_xdc` 时不解析 `get_ports`（推迟到 elaborate）；XDC 里不允许 `puts`/`if`/`proc`；引用不存在的对象只报 CRITICAL WARNING 不中断（但见 §4.2 的 `set_false_path` 陷阱）。
5. **`set_property source_mgmt_mode None` + 先 `remove_files` 再 `add_files`**：工程默认 `automatic hierarchy update`，`add_files` 对已在工程里的文件被跳过 ⇒ 层次不刷新 ⇒ 顶层"验证不了"、Vivado 自动换顶层 ⇒ `[Synth 8-439] module 'top_retina_event' not found`。
6. **`sim/tb/eth_top_sim_model.v` 与 `ref_original/eth_top.v` 同名互斥**：仿真用前者，综合用后者，**不可同时编译**（已在 `.f` 注释里写明）。
7. **`sim/models/clk_wiz_0_sim.v` / `bufg_sim.v` 是仿真桩**，**绝不能加进 Vivado 源**（会与真 IP 撞名）。
8. **综合层闸门的"假绿"**：Vivado 把 `ERROR:` 写 **stderr**、summary 写 stdout。只解析 stdout 会把 elaborate 失败的顶层报成 OK。`check_synth_warnings.ps1` 已修，自己写解析时注意。
9. **并行跑 Vivado 会偶发抢 `unimacro*.tcl`/`common.tcl`**（`couldn't read file ...` + `synth_design failed`，**无任何 Synth 代码错误**）⇒ 串行重跑即通过，不是代码问题。
10. **★ `synth_design -generic X=1` 会把 `X` 写进 `.xpr`**（实测：构建后 `.xpr` 多出 `<Generic Name="ETH_EN" Val="1"/>`），
    于是**上一次变体构建的参数会污染下一次**。同理 `remove_files`+`add_files` XDC 会把
    `TargetConstrsFile` **掉掉**。`tool/build_inproc.tcl` 现在两处都显式还原/覆盖
    （参数覆盖的**单一来源**改成 fileset 的 `generic` 属性，不再用命令行 `-generic`），
    并在日志里打印 `INPROC_TARGET_CONSTRS` / `INPROC_FILESET_GENERIC` 供核对。
11. **Vivado 打开工程后一定会重写 `.xpr`** —— 本机实测它还会把 `mig_a.prj` 的 `<File>` 条目删掉
    （**文件本身仍在磁盘上**，11,097 B，构建不受影响）。所以 `.xpr` 在 `git diff` 里总会有噪声；
    要让提交只留"机器路径"这一行差异，就 `git checkout -- prj/retina_event.xpr` 后手工改
    `Path="C:/..."` → `Path="E:/..."`。
12. **收包脚本（PC 侧）必须用防火墙允许的解释器**，并且要设大 `SO_RCVBUF`：
    用 DSH 自带 python 会被 inbound `Block` 规则挡掉（socket 收 0 包而网卡计数猛涨）；
    默认 64 KB 缓冲 + 逐位 CRC 只能收到 268 pkt/s（0 整帧）。见 §1.2.1 与 `tool/udp_frame_check.py`。
13. **`-tclargs` 会吞掉 `=`**：`-tclargs --full ETH_EN=1 eth` 传进去变成 `argv = {--full ETH_EN 1 eth}`
    ⇒ `name=value` 一律走环境变量（`RETE_GENERICS` / `RETE_TAG`）。
14. **三参 `catch`**：`catch {…} err` 会把 `--synthonly` 的提前 `return`（TCL_RETURN=2）当失败，
    导致"综合成功却报 `INPROC_RESULT=FAILED`"。已改用 `catch {…} err opts` 判 `-code`。

---

## 7. 已知残留 / 未验证项（**不要当成已完成**）

| 项 | 说明 |
|---|---|
| **`WHS = +0.013 ns`** | 极紧。与 `CLOCK_DEDICATED_ROUTE FALSE` 相关（R4/U18 非专用时钟引脚 ⇒ clock insertion delay 不可预测）。时序**已满足**但余量小，上板若偶发优先怀疑 |
| `DRC PLCK-12 / PLCK-23` | 同上，工具原文 "normally an ERROR but ... set to FALSE allowing your design to continue" |
| `[Synth 8-6896]` `temporal_diff.v:81` | 帧存 95,999 项超 initial 循环上限（65536），初始块被忽略。BRAM 未初始化默认 0，且 `i_first_frame` 本就抑制首帧 |
| `[filemgmt 20-742]` | `open_project` 阶段顶层"验证不了"。要在 `.xpr` 里持久化 `source_mgmt_mode=None` 才能消掉 |
| `luma_log` 的 `USE_ROM_IP=1` | 该 IP 未生成 ⇒ **未验证**（默认 0，不 elaborate） |
| `cam_tap` 的 `SAMPLE_ON_FALL=1` | 无独立激励，仅代码级检查（默认 0，与厂家一致） |
| **`set_input_delay` 的值** | ⚠️ **仍是推断，但输入已被实测收窄**：`-max = T/2 = 10.4165 ns`、`-min = 0`。本轮 ILA 把**时钟周期**从推断变成实测（**20.825 ns / 48.019 MHz**，与 XDC 的 20.833 ns 差 **0.04%** ⇒ 原数值仍成立，事实 **H52**），并用解码图像（H50）+ 显示证据（H53）**功能上证明**这条 DVP 接口是对的。但 **OV5640 的 `tCO`/建立保持窗口本身没被直接测量**（ILA 看到的是已进 FPGA 寄存器的数据）——要真量需示波器，或在 `cam_data` 上加 `IDELAYE2` 做**扫描式眼图**（本设计无 IDELAY 抽头） |
| **~~UDP 上行 / RGMII / ARP~~** | ✅ **2026-10-06 已上板验证通过**（`ETH_EN=1`）：ARP 应答、40~65 个整帧 × 768,000 B、**坏包 0**、1,982 pkt/s、事件段同步解出。复现：`tool/check_eth_onboard.ps1`（退出码 0）。见事实登记册 **H50** |
| **UART 遥测（`UART_EN=1`）** | ❌ **本机无法验证**：只枚举出 FTDI `USB Serial Converter`（A 通道，JTAG），**没有 B 通道的 COM 口** ⇒ 921600 遥测收不到。装好 FTDI B 通道 VCP 驱动后再开 |
| **MIG DDR3 通路** | ✅ **机器判据已通过**（2026-10-06 ILA）：`lcd_de` 占空 **75.0%**（理论 75.8%）、164 µs 内 **4 个行起始**（⇒ 41 µs/行 vs 理论 42.24）、`hud_inject` 输出 `inj_rgb888` 活动期内 **R 16 个不同值 / B 14 个**且两次抓取颜色集合不同 ⇒ **DDR3 读回 → 扫描输出**确实在出真实且会变的画面（事实 **H53**）。UDP 原始段另证明"相机采集 + 写入侧"通了（H50） |
| **LCD 实际画面** | ⚠️ **已由机器证据覆盖**（H53），**仅"与仿真的 PPM 逐像素一致"仍建议肉眼/比对确认**（可选）。UDP 回传的字节流**不受 HUD 影响**（H32） |
| 顶层 `8-295` 在闸门里是 SKIP | MIG 在"非工程流 + `read_ip`"下起不来；**已由全工程构建兜住**（现为 0 critical warning） |

---

## 8. 版本控制状态

- 仓库：`E:\workspace\FPGA_Comp\`（`.git` 在**工作区根**，不在 `retina_event/`）
- 远端：`origin = https://github.com/scissorlight/FPGA_comp.git`，分支 `main`
- **本机 `main` 领先 `origin/main` 4 个提交**（最新 `423de80 交付收尾: 综合层闸门 + 交付报告`）
- 工作区**干净**（`git status --porcelain` 为空）
- 忽略规则：`build/`、`*.cache/`、`*.runs/`、`*.hw/` 等生成物不入库；**RTL / 约束 / 仿真激励 / 脚本 / 文档入库**

### 换机取代码（二选一）

```powershell
# A. 有推送权限：本机先推，再在台式机拉
git -C E:\workspace\FPGA_Comp push origin main
# 台式机：
git clone https://github.com/scissorlight/FPGA_comp.git

# B. 无推送权限 / 内网：整目录拷贝
#    必须拷：retina_event\{src,sim,tool,docs,ref_original,prj}
#    可选拷：retina_event\build\retina_event*.bit    （成品比特流）
#    不要拷：build\sim\**、build\synthprobe 等中间产物（可重建）
```

> ⚠️ 拷 `prj/` 之后**必须**跑 `generate_target all`（见 §2.2b）。

---

## 9. 下一步待办（优先级排序，2026-10-06 修订）

1. ~~上板实测 `ETH_EN=1` / 验 RGMII/ARP/网卡收包~~ ✅ **已完成**（H50，`tool/check_eth_onboard.ps1` 退出码 0）。
2. ~~用 ILA 替换推断的 `set_input_delay`~~ ⚠️ **部分完成**：ILA 已把 **`cam_pclk` 周期实测**（20.825 ns / 48.019 MHz，H52）并把 **LCD/DDR3 读通路**变成机器判据（H53）；但 **OV5640 `tCO` 本身仍需示波器或 `IDELAYE2` 眼图扫描**才能量（见 §7）。
3. ~~肉眼确认 LCD 画面 / DDR3 通路~~ ✅ **已由机器证据覆盖**（H53）；只剩"与仿真 PPM 逐像素一致"这一条**可选**比对。
4. **装 FTDI B 通道 VCP 驱动** → 拿到 COM 口后验 `UART_EN=1` 的 921600 遥测（需管理员）。
5. **长跑丢包率**：把 `tool/udp_frame_check.py` 挂 10 分钟以上，统计 `FRAMES_OK / FRAMES_PARTIAL` 与 `BAD`，作为"921600/千兆长跑无丢字节"的量化证据。
6. **盯 `WHS`**：交付位流 `+0.034 ns`，ILA 变体 `+0.021 ns` —— 仍与非专用时钟路径有关。
7. **把 `source_mgmt_mode=None` 持久化进 `.xpr`**，消掉 `[filemgmt 20-742]`。
8. **补两个未验证分支**：`luma_log` 的 `USE_ROM_IP=1`、`cam_tap` 的 `SAMPLE_ON_FALL=1`。
9. **可选**：把 `check_synth_warnings.ps1` + `check_eth_onboard.ps1` 接进 CI/提交钩子。
10. **可选**：把 `host/`（PC 地面站）接到实板 UDP 流上做 M5 的"分屏 + 实时降低率"演示。

### 9.0 ★ 本次 ILA 变体怎么复现（`ILA_EN=1`）

```powershell
cd E:\workspace\FPGA_Comp\retina_event
# ① 建/更新调试 IP（只做一次；ILA IP 必须关 OOC 综合，否则 [Synth 8-439] module 'ila_dbg' not found）
& 'E:\Programs\Xilinx\Vivado\2020.2\bin\vivado.bat' -mode batch -nolog -nojournal `
    -source tool\create_ila_ip.tcl -log tool\create_ila_ip.log
# ② 构建 ILA 变体（产物在 build\variant_ila\，含 .bit 与 .ltx；**不覆盖交付位流**）
$env:RETE_GENERICS = 'ILA_EN=1'; $env:RETE_TAG = 'ila'
& 'E:\Programs\Xilinx\Vivado\2020.2\bin\vivado.bat' -mode batch -source tool\build_inproc.tcl `
    -log tool\build_ila.log -tclargs --full
# ③ 烧录 → 抓波形 → 自动判定
& 'E:\Programs\Xilinx\Vivado\2020.2\bin\vivado.bat' -mode batch -source tool\program_retina.tcl `
    -log tool\program_ila.log -tclargs build\variant_ila\retina_event.bit
& 'E:\Programs\Xilinx\Vivado\2020.2\bin\vivado.bat' -mode batch -source tool\ila_capture.tcl `
    -log tool\ila_capture.log -tclargs build\variant_ila\retina_event.ltx build\variant_ila
& 'C:\Users\Admin\AppData\Local\Programs\Python\Python314\python.exe' tool\ila_analyze.py --dir build\variant_ila
# ④ ★ 抓完必须把交付位流烧回去（ILA_EN=0）
& 'E:\Programs\Xilinx\Vivado\2020.2\bin\vivado.bat' -mode batch -source tool\program_retina.tcl `
    -log tool\program_final.log -tclargs build\retina_event.bit
```

探针映射（两个实例复用同一个 IP，位宽必须一致 1,1,8,16,16,16,1,8）：

| | ILA-CAM（clk = `cam_pclk`） | ILA-LCD（clk = `clk_lcd`） |
|---|---|---|
| probe0 | `cam_href` | `lcd_de` |
| probe1 | `cam_vsync` | `lcd_vs` |
| probe2 | `cam_data` | `dbg_lcd_rgb888[23:16]` |
| probe3 | `g_ila.dbg_cnt200`（200 MHz 自由计数） | `stat_fcnt_lcd[15:0]` |
| probe4 | — | `{8'd0, dbg_lcd_rgb888[7:0]}` |
| probe5 | — | `stat_ev_pf_lcd[15:0]` |
| probe6 | — | `lcd_hs` |
| probe7 | — | `{7'd0, stat_mode}` |

### 9.1 ★ 变体构建机制（本轮新增，别再用改默认值的土办法）

`tool/build_inproc.tcl` 现在支持**不改 RTL 默认值**就构建参数变体：

```powershell
cd E:\workspace\FPGA_Comp\retina_event
$env:RETE_GENERICS = 'ETH_EN=1'      # 原样透传 synth_design -generic
$env:RETE_TAG      = 'eth'           # 非空 ⇒ 产物写 build\variant_eth\，不覆盖交付位流
& 'E:\Programs\FPGA_Comp\..\Vivado\2020.2\bin\vivado.bat' -mode batch `
    -source tool\build_inproc.tcl -log tool\build_eth.log -tclargs --full
```

> ⚠️ **`name=value` 必须走环境变量，不能走 `-tclargs`**：实测 `-tclargs --full ETH_EN=1 eth`
> 里的 `=` 会被 Vivado 吞掉，脚本收到 `argv = {--full ETH_EN 1 eth}` ⇒ 生成一条**无值**的
> `-generic ETH_EN`。另：`--synthonly` 的提前 `return` 曾把成功误报成 `INPROC_RESULT=FAILED`
> （`catch` 把 TCL_RETURN 当失败），已改用三参 `catch` 修掉。

新增脚本：
| 脚本 | 作用 |
|---|---|
| `tool/check_eth_onboard.ps1` | ★ 上板以太网自检（ARP MAC 门 + UDP 整帧），退出码 0 = FULL_OK |
| `tool/udp_frame_check.py` | 纯 stdlib 收包/拆包/CRC16/整帧重组 + 导出 PPM（可在被防火墙限制的解释器下用系统 Python 3.14 跑） |
| `tool/hier_util.tcl` | 打开任意 checkpoint 出**分层**利用率（定位资源异常用） |
| `tool/ooc_ram_probe.tcl` | 单模块 OOC 综合，看数组是否落成 RAM |
| `tool/run_awake_cmd.ps1` | 通用防待机包装（`run_awake.ps1` 只能包 `fpgab.bat`） |

---

## 10. 流程纪律（上一轮踩过，已固化）

**教训**：出现过"teammate 还在写 RTL 时就烧板子"。虽然构建当时读到的是一份自洽快照（构建前查过 mtime 静默 4 分钟），但**烧录时 `udp_merge.v` 的修复比烧录晚 74 秒**；后来又发现另一个比特流**不含 R1 修复**（`vps_resample.v` 晚 2 分 42 秒）。**同一个错误差点犯两次。**

**固化流程（最终版严格执行）**：
```
① 全体停写 RTL → 发收尾令
② 全量 TB 一次跑完，全绿
③ 查 src/hdl mtime 静默 ≥5 分钟
④ 启动构建
⑤ 构建完再查一次 mtime 没变
⑥ 才烧录
⑦ 保留上一版比特流作回退点
```
最终构建的静默窗口为 **15 分 32 秒**，构建前后 RTL mtime 完全一致（21:37:53）。

**另一条**：扩展工作（超出原任务书的）应当**一开始就写进任务书**，否则面板上看到的长时长里有一大截其实是待命时间，无法对应到实际工作量。

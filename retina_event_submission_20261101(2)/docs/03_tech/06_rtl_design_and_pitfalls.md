# RTL 设计要点与踩坑清单（M9b，2026-10-30）

> **读者**：接 RTL / 跑综合 / 做上板验收的人。本文只记“踩过的坑 + 怎么绕”，不是模块规格；端口级规格看 `retina_event/docs/子模块设计/README.md`。
>
> **证据等级**：每条都标 **实测 / 文档 / 推断**。`实测` = 本机综合/仿真/上板跑过；`文档` = 仓库脚本注释、Vivado 报告、厂家文档写明；`推断` = 由代码/现象分析得出，尚未单独证伪。
>
> **边界**：本文的 781/1461 与 549/626 是 `nn_winstat` **单模块 OOC** 的资源，不是整机；act3c（v5 + byte23）不含 `nn_winstat`，act8（v7b）已含并已烧板。单模块数字不能当成整机资源；本文的优化是否上板以 `sim/nn/EVIDENCE_M3j.md` 的整机报告为准。

---

## 0. 先记住 8 条

| # | 坑 | 一句话处置 |
|---|---|---|
| 1 | RAM/FIFO 写块带异步复位 | 写块**不带复位**；复位只清指针/valid |
| 2 | 权重 ROM 用 `$readmemh` | 生成纯 RTL `initial rom[i]=...`，不用外部 `.mem` |
| 3 | `launch_runs` 本机挂死 | 进程内 synth→opt→place→route→bitstream |
| 4 | TCL 带 BOM / `-tclargs` 不在最后 | TCL/XDC 无 BOM；`-tclargs` 必须是最后一段 |
| 5 | 像素位移直接减在网格坐标 | 像素域减 + clamp，再 `>>3` 到 50×30 网格 |
| 6 | 平移量用“窗间增量” | 用**上一窗质心 − 画面中心**，每窗一个值，不累加 |
| 7 | 窗沿在途事件用错 shift/丢失 | 64 深 FIFO + 1-bit epoch；外部窗沿多等 200 拍 |
| 8 | v7 ROM 布局与 `nn_cfg` 版本错配 | ROM、`nn_cfg`、`nn_engine` 同一版一起换 |

---

## 1. 八条坑：现象 → 根因 → 处置

### 1.1 RAM/FIFO 写块带异步复位，Vivado 把数组拆成寄存器

**现象（实测）**

- Vivado 综合日志出现：

  ```
  RAM is sensitive to asynchronous reset signal. This RAM will be dissolved into registers.
  ```

- `nn_winstat` 第一版 64×19 的数组（存窗口质心/累计量）综合成 **LUT 781 / FF 1461**；功能能跑，但资源明显不对。
- 把写块改成无复位后，同一模块 OOC 综合变成 **LUT 549 / FF 626 / LUTRAM 18 / DSP 0 / BRAM 0**。

**根因（文档 + 实测）**

- 推断 RAM 的写 `always` 块里带了异步复位（或复位信号进了写地址/写数据的敏感列表），Vivado 无法把数组映射成 Block RAM / 分布式 RAM，只能拆成一组触发器；每个 bit 都要 LUT + FF，19 bit × 64 深就放大成上千。
- 这不是“时序约束”问题，是**推断规则**问题；先看综合日志关键词，不要先调时序。

**处置**

1. 存储写块只保留时钟沿，**不写 `if (rst) ...`**；复位只清“读指针/写指针/valid/epoch”等控制寄存器。
2. 需要“上电清内容”时，用单独的一拍清地址（或上电初始化），不要在存储写块里异步清。
3. 用单模块 OOC 先验：`build/ooc_ram_probe.tcl` 看目标数组是否落 RAM；整机综合前就能发现。
4. 回归检查：综合日志里不得再出现 `RAM is sensitive to asynchronous reset`；资源表里目标数组应体现 LUTRAM/BRAM，而不是纯 FF。

**证据**

- `sim/nn/EVIDENCE_M3b.md:195-225`：第一版报错与前后资源对比（781/1461 → 549/626，LUTRAM 18）。
- 同源坑：`retina_event/docs/交付报告.md:39` 的 ETH-1，`udp_merge` 三个数组被拆成 **58,604 FF**，place 失败；修法同样是“存储写块不带异步复位”。
- 结论等级：**实测**（综合器判决 + 资源报告）。

---

### 1.2 权重 ROM 不要用 `$readmemh` / 外部 `.mem`

**现象（文档 + 实测）**

- 早期方案想用 `$readmemh("weights.mem", rom)` 或外部 `.mem` 文件；ModelSim 能读到、Vivado 读不到，或反过来；换工作目录（CWD）后行为变化。
- 典型症状：仿真全 0 / X，或综合报找不到文件；同一份 ROM 在两边不一致。

**根因（文档 + 推断）**

- ModelSim 与 Vivado 对**相对路径**的 CWD 解析不同；`.mem` 文件不在工程根/运行目录时会静默读 0 或报错。
- 仓库脚本注释已明确选择“route B”：不用 `$readmemh`、不用外部 `.mem`，直接生成 RTL。

**处置**

- 用生成器输出**纯 RTL**：`nn_rom_data.v` 里逐字 `initial rom[i] = 32'h...;`（或 case），ROM 内容随源码入库。
- 生成后做两项机读检查：
  1. 文件中不得出现 `$readmemh` / `$readmemb`；
  2. 字数、md5、关键地址段与 `nn/out_*/nn_params_*.json` 对拍。
- 现有检查脚本：`nn/check_rom_2cls.py:96`、`build/rom_check_m2e.py:109`（断言 no_readmemh）；v7 也要沿用同一检查。

**证据**

- `build/nn_gen_placeholder.py:5` 明写“route B：生成 RTL，不用 `$readmemh`、不用外部 `.mem` 文件”。
- `src/rtl/nn/nn_rom_data.v:27` 起为 `initial` 逐字赋值；当前 v5 ROM 5,476 words（md5 `9406a8900640931a51e4f4ed09a259ca`）。
- 结论等级：**文档**（脚本注释/生成器）+ **实测**（源码检查）。

---

### 1.3 `launch_runs` 在本机挂死，构建要进程内跑

**现象（实测）**

- Vivado 的 `launch_runs synth_1 / impl_1` 起不来或永远不返回；`wait_on_run` 卡住。
- 日志/进程侧证据：`rundef.js(121,5) Access denied`；`vrs` 子进程不出工（父进程 20 s CPU 只用了 0.05 s）。
- 不是设计错误，换 TCL 流程可复现；同一工程在进程内跑能过。

**根因（文档 + 推断）**

- 本机 run server 被拦（权限/安全软件/端口），`launch_runs` 依赖的后台 run server 起不来；`wait_on_run` 等一个永远不会来的状态。
- 与 RTL 无关；不要把时间花在改约束上。

**处置**

- 用进程内流程：`synth_design → opt_design → place_design → route_design → write_bitstream`，全部在同一个 Vivado 进程里完成。
- 入口：`build/build_inproc.tcl:2-19` 已写明原因；`build_retina.ps1 --full` 默认走该流程。
- 不要在脚本里混用 `launch_runs` + `wait_on_run` 作为“兜底”；两条路会互相污染 run 目录。

**证据**

- `build/build_inproc.tcl:2-19`（注释直接写“launch_runs 在本机会挂死”）。
- 结论等级：**实测**（本机构建日志/进程行为）+ **文档**（脚本注释）。

---

### 1.4 TCL 必须无 BOM，`-tclargs` 必须放最后

**现象（文档 + 实测）**

- TCL 文件带 UTF-8 BOM 时，Vivado 第一行命令报 invalid command / 乱码；XDC 带 BOM 时约束可能整段不生效。
- `vivado -source xxx.tcl -tclargs a b` 中，`-tclargs` 之后的 token 全被当参数；如果 `-tclargs` 不在最后，后续选项被吞。

**根因（文档）**

- Vivado 的 TCL 解析器不跳过 BOM；`-tclargs` 是“剩余参数”分隔符，不是普通选项。

**处置**

- TCL/XDC 保存为 **UTF-8 无 BOM**；PowerShell 脚本（含中文）反而需要 BOM，两者不要搞反。
- 命令行固定：`vivado -mode batch -source <script>.tcl -tclargs <args...>`，`-tclargs` 之后只放参数。
- 构建前做机读检查：`build_retina.ps1:21-28` 已有 BOM 检查逻辑；`tool/nn_synth_check.tcl:27-28` 同样要求。

**证据**

- `build/build_inproc.tcl:18-19`、`build/build_retina.ps1:21-28`、`build/nn_synth_check.tcl:27-28`。
- 结论等级：**文档**（脚本注释/历史构建记录）；本轮未重新跑 Vivado，故不记为实测。

---

### 1.5 坐标单位：events.csv 是 400×240 像素，网格要 `>>3`

**现象（实测 + 代码证据）**

- `events.csv` 的 `x/y` 是 **400×240 原始像素**（x 0..399，y 0..239），不是 50×30 网格。
- 网格特征 `gx=x>>3`、`gy=y>>3`（`GRID_SHIFT=3`）才是 50×30；如果直接把“像素位移”减在网格坐标上，会变成 **8× 过补偿**。
- 这个错误在 `nn_winstat` 里**真实发生过一次**，被训练侧转换器公式比对时抓到，不是纸上风险。

**根因（代码证据）**

- 两套坐标混用：训练侧 `intwin.py` 先算像素域平移，再 `>>3`；RTL 旧版把 `shift_x/shift_y` 直接加到 `gx/gy`，量纲差 8 倍。
- 表现不是“完全错”，而是动作幅度被放大/缩小，指标看起来“有点效果但不对”，很难靠看波形发现。

**处置**

- 统一公式（RTL 与训练必须逐字同构）：

  ```
  x' = clamp(x - shift_x, 0, 399);   // 像素域
  gx = x' >> 3;                       // 50 网格
  y' = clamp(y - shift_y, 0, 239);
  gy = y' >> 3;                       // 30 网格
  ```

- `shift_x/shift_y` 是**像素单位**；任何“网格位移”必须先 `<<3` 回像素，或只在像素域做。
- 代码评审时把 `intwin.py` 的公式与 `nn_winstat.v` 并排贴；不要只对“结果差不多”。

**证据**

- `src/rtl/nn/nn_winstat.v:8-20` 头注明确记录旧版两错（像素位移减在格坐标 = 8× 过补偿；用窗间增量），并写明修正后的像素域公式。
- `nn/REPORT_v7_数据集.md` §3：x 0..399 / y 0..239，`GRID_SHIFT=3`。
- 结论等级：**实测**（训练侧抓到 + RTL 已改）+ **代码证据**。

---

### 1.6 平移归一化语义：上一窗质心 − 中心，每窗一个值，不累加

**现象（代码 + 仿真）**

- 旧版用“窗间增量 Δ”做平移，或把上一窗的 shift 累加；手缓慢移动时窗口被越推越偏，静止时也会漂。
- 正确做法：每个窗只用**上一有效窗的质心**算一次绝对重新居中：

  ```
  shift_x = pcx - 200;   // 画面中心 400/2
  shift_y = pcy - 120;   // 画面中心 240/2
  ```

- 空窗保持上一质心；首窗没有历史，`Δ=0`；每窗独立，不把上一窗的 shift 再加到本窗。

**根因（代码证据）**

- “重新居中”是**绝对位置**语义，不是“相对上一窗移动了多少”；用 Δ 会把累积漂移带进特征。
- 叠加顺序也容易错：先加 shift 再 clamp，还是先 clamp 再 shift；必须与训练侧 `intwin.py` 完全一致。

**处置**

- RTL 维护 `pcx/pcy`（上一有效窗质心），每窗算一次 `shift_x/shift_y`；空窗不更新质心。
- 事件在像素域做 `clamp(x - shift_x)`，再 `>>3`；不要先转网格再减。
- 回归：TB 107/107 PASS（`EVIDENCE_M3b.md:47 / :236`）；再加“缓慢平移 + 静止 + 首窗/空窗”四类用例。

**证据**

- `src/rtl/nn/nn_winstat.v:8-20`；`nn/v7/intwin.py:14-16 / 113-127`（训练侧同公式）。
- 结论等级：**代码证据 + 仿真实测**。

---

### 1.7 窗沿在途事件：shift 串行算，事件不能丢也不能用旧值

**现象（推断 + 代码证据）**

- 窗口边界到达时，新窗的 `shift_x/shift_y` 还在串行除法/开方里算（约 52 拍），但事件已经进来了。
- 若直接用旧 shift：窗沿后少量事件被错误平移；若丢掉：每窗固定丢几个事件，长期指标偏低。
- 外部窗沿还需要等 `nn_feat` 把在途事件排空，`o_win_end` 比真实窗沿晚 `NN_EXT_FLUSH_CYC=200` 拍（50 MHz 下 4 µs）。

**根因（代码证据）**

- 平移量依赖上一窗质心，是**跨窗串行依赖**；窗沿不是瞬时的。
- 64 深 FIFO 如果没有 epoch/tag，就分不清“这事件属于新窗还是旧窗”。

**处置**

- `nn_winstat`：64 深 FIFO + 1-bit epoch；事件 tag == 当前 epoch 用 `shift_cur`，否则用 `shift_prev`；保证窗沿事件不丢、不用错。
- `nn_feat`：外部窗沿后等 200 拍（`NN_EXT_FLUSH_CYC`）再冻结；`o_win_end` 相应后移 200 拍。验收/仿真时不要把 `o_win_end` 当“精确窗沿”，要按设计延迟补偿。
- 回归：在 TB 里专门在窗沿前 1–2 拍注入事件，检查归属；不要只跑平稳段。

**证据**

- `src/rtl/nn/nn_winstat.v` 头注（FIFO/epoch/串行除法）、`src/rtl/nn/nn_top.v` 头注（`NN_EXT_FLUSH_CYC`、`o_win_end` 延迟）。
- 结论等级：**代码证据 + 推断**（具体拍数由 RTL 参数推得；未单独上板测）。

---

### 1.8 ROM 布局与 `nn_cfg`/`nn_engine` 必须同版本

**现象（实测）**

- 当前源 `src/rtl/nn/nn_rom_data.v` 是 **v5 两分类 5,476 words**；`nn_cfg.vh:103` 的 `NN_NUM_CLASSES=2`，但 `nn_cfg` 的 ROM 布局仍是 v5（卷积权重、`WFC` 从 4896 起）。
- v7 的 `nn/out_v7/nn_rom_data_v7.v`（2026-10-30 23:33）是 **5,652 words**，`g1 16×7` 从 4896–5008、`fc 2×256` 从 5008–5520（`nn_params_v7.json` 同口径）。**但** `results_v7_hw2.json` 的 `final` 是 **5,668 words**，`g1 16×8` 从 4896–5024、`fc` 从 5024–5536；同目录两份口径不一致。**只换 ROM 文件、不换 `nn_cfg/nn_engine`，地址会错位；换之前必须先确认用哪份 params，并让生成器同时产出 ROM 与 `nn_cfg`。**
- v7 的全局特征口径在同目录也不一致：`nn_params_v7.json` 是 **7 路**（`n_div16 / prev_n_div16 / pol_bal / dx / dy / dx_rel / dy_rel`，无 `speed_rel`，g1 112），`results_v7_hw2.json` 是 **8 路**（含 `speed_rel`，g1 128）。`nn_top` 当前只把 17 路打到 `o_glob_bus`，`nn_engine` 没有全局量输入；实现/验收以最终 params 为准，**不要把 7 或 8 写死**。

**根因（实测）**

- ROM 是“扁平地址 + 生成器布局”的硬约定；权重布局与 RTL 的 `W1/W2/...` 基地址必须同版本生成。
- 只替换 ROM 是“看起来换了权重”，实际读到的地址段错位，输出不可解释。

**处置**

- 构建 v7 时按顺序：
  1. 用 `nn/out_v7/nn_params_v7.json` 重新生成 `nn_cfg.vh`（所有基地址/字数）；
  2. 换 `nn_rom_data.v` 为 v7 当前生成物（按 `nn_params_v7.json` 的 `rom_words`；2026-10-30 23:33 为 5,652，**不要抄 `results_v7_hw2.json` 的 5,668**，那是另一版布局）；
  3. 改 `nn_engine` 支持 `g1`（路数以最终 params 为准，当前有 7/8 两版）+ 全局量 concat + `fc 2×256`；
  4. 跑 ROM 检查（字数/md5/关键地址段）+ 逐位一致（golden vectors）；
  5. 再综合/上板。
- 检查命令（只读）：`grep -n "NN_NUM_CLASSES\|WFC\|G1\|FC" src/rtl/nn/nn_cfg.vh`；与 `nn/out_v7/nn_params_v7.json` 的 `layout` 对比。

**证据**

- 源 ROM：5,476 words，md5 `9406a8900640931a51e4f4ed09a259ca`。
- v7 当前生成物：`nn/out_v7/nn_rom_data_v7.v` **5,652 words**（文件头自述；197,178 B），`nn_params_v7.json` 同为 5,652；`results_v7_hw2.json` 的 `final` 为 5,668 words（`g1` 128 而非 112）——两处**不是同一版布局**。
- `nn/out_v7/results_v7_hw2.json` 的 `final` 还有：`feat_names` 8 个、`contract_errors:[]`、`rom_sha256=527d7710…`；但 `nn/out_v7/` 还没有 `INT8_CONTRACT.md` / `golden_vectors.json`（QAT 未定稿）。
- 结论等级：**实测**（文件字数/md5/JSON 字段）+ **推断**（地址错位后果，未构建 v7 位流验证）。

---

## 2. 上线前检查清单（逐项打勾）

- [ ] 综合日志无 `RAM is sensitive to asynchronous reset`；目标数组落 LUTRAM/BRAM，不是纯 FF。
- [ ] ROM 生成物无 `$readmemh` / `$readmemb`；字数、md5、关键地址段与 params JSON 一致。
- [ ] TCL/XDC 无 BOM；`-tclargs` 是命令行最后一段；PS1 含中文时 BOM 正确。
- [ ] 构建走进程内流程（`build_retina.ps1 --full`），没有 `launch_runs` 残留。
- [ ] `nn_cfg.vh` 的 ROM 布局与 `nn_rom_data.v` **同版本**（v5 对 v5 / v7 对 v7）。
- [ ] `nn_engine` 真的消费最终 params 的全局量路数（不是只有 `o_glob_bus` 观测口；当前 7/8 两版）；`g1`/`fc` 已接。
- [ ] 平移归一化：像素域 `clamp(x-shift_x)` 再 `>>3`；shift = 上一窗质心 − (200,120)，每窗一次、不累加。
- [ ] 窗沿在途事件：FIFO/epoch 逻辑在 TB 里用“窗沿前 1–2 拍注入”验过；`o_win_end` 的 200 拍延迟已补偿。
- [ ] 整机资源在预算内（Slices 是最紧项；参考 2026-10-29 G 位流 LUT 26,334 / FF 16,703 / Slices 9,133 / BRAM 80.5 / DSP 7）。
- [ ] 位流 md5、构建日志、WNS/WHS 入库；烧板后先用行为反证（ACTION 计数、逐窗回放）确认引擎身份，再谈指标。

---

## 3. 资源与证据边界

| 项 | 数值 | 说明 |
|---|---:|---|
| `nn_winstat` 第一版（带异步复位） | LUT 781 / FF 1461 | OOC 单模块，**不是整机** |
| `nn_winstat` 修正版（无复位写块） | LUT 549 / FF 626 / LUTRAM 18 / DSP 0 / BRAM 0 | 同上；TB 107/107 PASS |
| 2026-10-29 G 位流整机基线 | LUT 26,334 (41.54%) / FF 16,703 (13.17%) / Slices 9,133 (57.62%) / BRAM 80.5 (59.63%) / DSP 7 (2.92%) / WNS +0.243 | 旧 M5 方案附录 B；**不含 v7 前端/全局 MLP** |
| 当前 act3c | 2,890,875 B / md5 `a5fff751e20019d7e80a3a953f7f8c5a` / WNS +0.306 | v5 两分类 + byte23；**不含** `nn_winstat` |

- 781/1461 与 549/626 是 `nn_winstat` OOC 的前后对比，不能直接加到整机资源上；整机 v7 资源要重新综合才知道。
- 本文的“坑 1–4”多数是**工具/流程**坑，不是算法坑；“坑 5–7”是**数值语义**坑，必须 RTL 与训练同构。
- 本文未重新跑 Vivado（只读源码/报告）；引用综合数字时以原始报告为准。证据等级：**文档/实测（历史）**，不是本轮新实测。

---

## 4. 相关文件

- `src/rtl/nn/nn_winstat.v`：平移归一化前端（像素域、FIFO/epoch、shift 语义）。
- `src/rtl/nn/nn_top.v`：`u_ws` / `u_feat` / `u_eng` 例化与 `o_glob_bus`。
- `src/rtl/nn/nn_cfg.vh`：ROM 布局/类别数/基地址。
- `src/rtl/nn/nn_rom_data.v`：当前 v5 ROM；v7 生成物在 `nn/out_v7/nn_rom_data_v7.v`。
- `build/build_inproc.tcl`、`build_retina.ps1`、`nn_synth_check.tcl`：构建/BOM/参数顺序。
- `sim/nn/EVIDENCE_M3b.md`：RAM 异步复位与 781/1461 → 549/626 的原始证据。
- `nn/v7/intwin.py`、`nn/v7/emit_contract.py`：训练侧平移公式与部署契约。

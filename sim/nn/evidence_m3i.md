WINFEAT_FUZZ_OK=1
# M3i 特征前端随机差分测试证据（task-68）

结论：7 路 int8 特征（n_div16 / prev_n_div16 / pol_bal / dx / dy / dx_rel / dy_rel）在
固定 seed 的 16 组 / 75 窗 / 9266 事件上，RTL 与训练侧真值函数逐值完全一致；
CHECK 1500 条全 PASS、失配 0 条；负向突变测试证明 TB 非空过。

首行判据：WINFEAT_FUZZ_OK=1

## 1. 范围与方法

- 对象（只读，未改任何 RTL）：`src/hdl/nn/nn_winstat.v` + `src/hdl/nn/nn_winfeat.v` 级联。
  TB 把 `u_ws` 的 `o_snap_*` 直连 `u_feat` 的快照输入（真实数据通路，TB 不伪造快照）。
- 真值：`temp_test/rtl/fuzz/gen_winfeat_fuzz_vectors.py` 直接
  `import intwin as IW`（nn/v7/intwin.py）与 `import v7_feats as F`（nn/v7/v7_feats.py），
  用 `IW.window_stats(...)` 得到窗统计、再用 `F.python_row(row, False)` 得到 7 路期望值。
  **公式没有在生成器里重写**，只在 intwin 输出行上按部署语义取列：
  pcx/pcy = 上一窗 cx/cy（首窗 200/120），prev_n = 上一窗 n（首窗 0）——即 intwin 自己的
  `[200]+cx[:-1]` / `[0]+n[:-1]` 定义。
- 100 ms 非重叠映射：真实 RTL 每 100 ms 一个 bin；intwin 的 STRIDE_MS 固定 50 ms。
  生成器把第 k 个 100 ms 窗的事件整体放进合成 50 ms 网格的偶数子块（子块 2k），
  奇数子块留空，再调 `window_stats(sub, 2*B)`，取偶数窗即得与 RTL 完全一致的
  "now=本窗、prev=上一窗" 语义（不重写任何统计/特征公式）。
- 事件坐标域（Lead 指定坑）：生成器断言 `0<=x<=511`、`0<=y<=255`、`pol in {0,1}`，
  vector 里按 18 bit {pol, y[7:0], x[8:0]} 无符号打包；刻意包含 x=511/y=255 用例
  （见 §3 bnd_coimg / bnd_single）。

## 2. 产物

| 文件 | 说明 |
|---|---|
| `temp_test/rtl/fuzz/gen_winfeat_fuzz_vectors.py` | 生成器（import 真值函数；固定 seed；打印 seed/组数/窗数/事件数） |
| `sim/tb/tb_nn_winfeat_fuzz.vh` | 生成物 58,016 B（442 行），含 FUZZ_EV/FUZZ_EXP/FUZZ_SNAP/FUZZ_CLAMP/FUZZ_TAG |
| `sim/tb/tb_nn_winfeat_fuzz.v` | TB 325 行，例化 nn_winstat + nn_winfeat 级联，逐窗 20 项判决 |
| `sim/tb/tb_nn_winfeat_fuzz.f` | 2 行：src/hdl/nn/nn_winstat.v、src/hdl/nn/nn_winfeat.v |
| `temp_test/rtl/fuzz/mutate_check.py` | 负向测试（改写 vector，注入 2 个错误） |
| `temp_test/rtl/fuzz/fuzz_windows.json` / `fuzz_coverage.md` | 逐窗快照/期望/覆盖统计 |
| `build/fuzz_timing.txt` / `fuzz_final.out` | 回归计时与最终干净通过日志 |

## 3. 用例规模与边界覆盖（生成器实测）

```
FUZZ_GEN_OK=1 seed=20261031 groups=16 windows=75 events=9266 max_n=2100
VH_BYTES=58016 EV_BITS=166788
```

| 覆盖类 | 实测窗数 | 要求 | 对应任务卡边界项 |
|---|---|---|---|
| random | 40 | >=40 | 随机用例（8 组 × 5 窗） |
| empty | 6 | >=3 | n=0 空窗（含首窗空、连续空、空后有效） |
| single | 9 | >=3 | n=1 |
| near_limit | 3 | >=3 | n 接近上限（2031/2032/2100/2047） |
| centroid_out | 5 | >=3 | cx/cy 超出 [0,399]/[0,239] 被 clamp |
| pol_pos | 14 | >=1 | on≫off（pol_bal 饱和 +127） |
| pol_neg | 11 | >=1 | off≫on（pol_bal 饱和 -127） |
| var_zero | 24 | >=3 | sx=0 或 sy=0（S=max(...,8)） |
| s_floor8 | 31 | >=3 | S 落到下限 8 |
| rel_pos / rel_neg | 17 / 19 | >=1 | dx_rel/dy_rel 正向/负向饱和 |
| nonsquare | 51 | >=3 | 非完全平方方差（验证 floor 开方而非四舍五入） |
| floor_div | 32 | >=3 | dx_rel/dy_rel 负余数 floor 除法 |
| clamp_events | 249 | >=10 | 网格 clamp 事件总数 |

组与每窗 n（生成器 `fuzz_windows.json`）：rnd0 [3,35,3,20,20]、rnd1 [0,35,12,5,12]、
rnd2 [8,60,3,12,20]、rnd3 [12,2,1,20,2]、rnd4 [12,20,1,100,8]、rnd5 [12,8,100,1,2]、
rnd6 [8,20,20,2,2]、rnd7 [0,2,1,12,35]、bnd_empty [0,0,6,0,0,3]、
bnd_single [1,1,1,1,1]、bnd_nlimit [2031,2032,2100,2047]、bnd_coimg [40,40,30,20]、
bnd_polbal [40,40,40,5]、bnd_var0 [20,20,12,10]、bnd_relsat [10,10,10,10]、
bnd_nonsq [7,9,5,13]。

代表窗实测（日志 `build/sim/tb_nn_winfeat_fuzz/vsim.log`，格式：
n_div16,prev_n_div16,pol_bal,dx,dy,dx_rel,dy_rel）：

```
# INFO W0  rnd0_w0        n=3    rtl=0,0,-42,19,-13,69,-23   exp=0,0,-42,19,-13,69,-23   clamp=0  cyc=504
# INFO W40 bnd_empty_w0   n=0    rtl=0,0,0,0,0,0,0          exp=0,0,0,0,0,0,0          clamp=0  cyc=1
# INFO W52 bnd_nlimit_w1  n=2032 rtl=127,126,0,0,0,0,0      exp=127,126,0,0,0,0,0      clamp=0  cyc=504
# INFO W53 bnd_nlimit_w2  n=2100 rtl=127,127,0,0,0,0,0      exp=127,127,0,0,0,0,0      clamp=0  cyc=504
# INFO W55 bnd_coimg_w0   n=40   rtl=2,0,0,66,-12,127,-36   exp=2,0,0,66,-12,127,-36   clamp=40 cyc=504
# INFO W60 bnd_polbal_w1  n=40   rtl=2,2,-127,0,0,0,0       exp=2,2,-127,0,0,0,0       clamp=0  cyc=504
# INFO W61 bnd_polbal_w2  n=40   rtl=2,2,0,0,0,0,0          exp=2,2,0,0,0,0,0          clamp=0  cyc=504
# INFO W64 bnd_var0_w1    n=20   rtl=1,1,0,-21,0,-127,8     exp=1,1,0,-21,0,-127,8     clamp=0  cyc=504
# INFO W65 bnd_var0_w2    n=12   rtl=0,1,0,32,15,127,127    exp=0,1,0,32,15,127,127    clamp=0  cyc=504
# INFO W68 bnd_relsat_w1  n=10   rtl=0,0,0,-100,-120,-127,-127 exp=0,0,0,-100,-120,-127,-127 clamp=10 cyc=504
# INFO W74 bnd_nonsq_w3   n=13   rtl=0,0,-48,11,33,92,127   exp=0,0,-48,11,33,92,127   clamp=2  cyc=504
```

判读：空窗 7 路全 0 且 carry 不污染（W40/W41/W43）；n_div16/prev_n_div16 双路饱和到 127
（W53/W54）；全画面外坐标（x∈400..511）clamp 计数 40、dx_rel 饱和；ON/OFF 均衡 pol_bal=0、
全 ON=+127、全 OFF=-127；sy=0 时 dy_rel=+8（S=8 生效）；同一格 12 事件 dx_rel/dy_rel 双 +127；
(399,239)↔(0,0) 交替双 -127 且 clamp=10；非完全平方窗（W74）dx_rel=92 为 floor 结果。

## 4. 判定项与结果

每窗 20 条 CHECK：12 条快照（WS_N/ON/OFF/SX/SY/SX2/SY2/CX/CY/PCX/PCY/PREVN）
+ 7 条特征（NDIV16/PREVN16/POLBAL/DX/DY/DXREL/DYREL）+ 1 条 CLAMP（o_clamp_cnt 窗内增量）。
命名 `G<组>W<窗>_<字段>`，失配打印 got/exp。

```
# TEST_RESULT=PASS
# INFO_NEV_USED=9266
# INFO_CHECK_TOTAL=1500
# INFO_ERRORS=0
```

- 75 窗 × 20 = 1500 条 CHECK，PASS 1500 / FAIL 0（`grep -ac "CHECK=.*PASS"` = 1500，
  FAIL = 0），日志末行 TEST_RESULT=PASS，退出码 0。
- 非空窗 winfeat 固定 504 拍、空窗 1 拍（`cyc=` 字段），仿真结束时刻 1,208,420 ns。

## 5. 负向突变测试（证明 TB 不是空过）

`temp_test/rtl/fuzz/mutate_check.py 0` 对第 0 窗注入 2 个错误：
`FUZZ_EXP[0]` 异或 bit0、`FUZZ_SNAP[0]` 的 n 字段 +1。
重跑 TB → 退出码 1、恰好 2 条 FAIL：

```
# CHECK=G0W0_WS_N FAIL got=3 exp=4
# CHECK=G0W0_DYREL FAIL got=-23 exp=-24
# TEST_RESULT=FAIL
```

随后重新生成干净 vector（`GEN2_RC=0`）复跑 → 1500 PASS / TEST_RESULT=PASS。
即快照通路与特征通路各自都被真实比对，失配会同时触发诊断打印与非零退出码。

## 6. 复现命令与耗时（本机实测）

```
# 生成（工程根 E:/workspace/FPGA_Comp）
<bundled python> temp_test/rtl/fuzz/gen_winfeat_fuzz_vectors.py     # RC=0, 约 1 s
# bundled python = C:/Users/Admin/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe
# （Python 3.12.14 + numpy 2.3.5；系统 PATH 的 MinGW python import numpy 会段错误 rc=139）

cd retina_event
pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_nn_winfeat_fuzz   # RC=0, 4.9 s
pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_nn_winfeat        # RC=0, 3.7 s
pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_nn_integ          # RC=0, 4.5 s
```

回归（既有判据未被破坏，日志 `build/fuzz_timing.txt`）：

```
TB=tb_nn_winfeat  RC=0  SEC=3.7  PASSCHK=410  FAILCHK=0
TB=tb_nn_integ    RC=0  SEC=4.5  PASSCHK=62   FAILCHK=0
TB=tb_nn_winfeat_fuzz RC=0 SEC=4.9 PASSCHK=1500 FAILCHK=0
```

可行性：固定 seed、同一 Python/numpy 版本下 vector 值逐字节可复现
（排除 `Generated UTC` 注释行后 sha256 两次一致
`ad5de64f48e73a1e5a6ca323930c1d05913cb350075e23daf3a803e2c5a4a6cf`；
含时间戳的 .vh sha256 `ed3e3a27b3a74cdb4b0a6cd18eb90a94e0c3a339d30112c2b5f0c2aab942d2d8`）。

## 7. 坑与处置

1. **系统 python 段错误**：Git Bash 的 `python` 为 MinGW 构建，`import numpy` 直接
   rc=139（numpy 2.3.5 "built with MINGW-W64 … experimental"）。改用 DS bundled python
   （3.12.14 + numpy 2.3.5）后正常。生成与突变脚本统一用它。
2. **Verilog-2001 include 位置**：`include` 在 module 之外时报
   `vlog-2155 Global declarations are illegal in Verilog 2001 syntax` 与
   `vlog-13069 … unexpected initial`；必须放在 module 内部。
3. **Verilog-2001 函数至少要 1 个输入**：生成器原先发 `F_NG()/F_NW()` 零输入函数被
   vlog 拒绝；改为 TB 直接用 ` `FUZZ_NG ` 宏做循环上界。
4. **.vh 含 UTC 时间戳**：两次生成的整体 sha256 不同，但排除第 3 行注释后值完全一致
   （用于确定性证据）；比对时应剔除时间戳行。

## 8. 说明与限制

- 本卡只读 RTL，未编辑任何 `src/hdl/**` 文件；RTL 侧 `git status` 中的 M/?? 均为前序
  task-51 等任务的现场。
- CLAMP 一项验证的是 `nn_winstat` 的网格 clamp 计数增量（o_clamp_cnt），不是特征值本身；
  特征侧不含 clamp 逻辑（部署语义如此），两者共同覆盖"画面外坐标"路径。
- 本卡不覆盖 nn_feat / nn_top 的事件流与窗时基（属 task-51/54/59 范围）。
- 生成器与 `.vh` 均在写域白名单内（retina_event/sim、temp_test/rtl）。

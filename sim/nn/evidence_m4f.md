# EVIDENCE_M4F — ACK/心跳包头 BYTE23 补动作字节（task-27）

ACT3_CTRLHDR_OK=1

- 任务：task-27（M4f RTL，rev2，owner rtl2）
- 日期：2026-10-30
- 结论：downlink_cmd.v 的 pkt_byte() 在 idx=23 时改为输出 act_byte_s（与数据帧
  byte23 / TLV 0x92 同源）。心跳(0xF0)与 SET_PARAM ACK 的 BYTE23 随动作字节变化：
  class=1/conf=17 ⇒ 0xC5；ACT_IDLE_CYC 空窗（1.0 s）后 ⇒ 0x00；两包 CRC16 由 TB
  独立复算一致，且删除 idx=23 后的 CRC 与线上 CRC 不等 ⇒ BYTE23 确实在 CRC 覆盖率内（R8）。
- 本任务**未做**综合/实现/bitstream/烧板（按任务卡要求，等阈值标定后一起构建）。

## 0. 改动清单（RTL 只有 1 个文件）

| 文件 | 行 | 改动 |
|---|---|---|
| src/rtl/comms/downlink_cmd.v | 652-656 | pkt_byte() 新增 `7'd23: pkt_byte = act_byte_s;`（含 4 行 M4f 说明注释）；原 idx=23 落到 `default: 8'h00` |
| sim/tb/tb_act3_ctrlhdr.v | 新建 | M4f 专用 TB（21 checks） |
| sim/tb/tb_act3_ctrlhdr.f | 新建 | 依赖：downlink_cmd.v / act_state_cdc.v / cdc_tog_word.v |

- downlink_cmd.v md5 = 35955c0e389a6c8889552046105744c7
- tb_act3_ctrlhdr.v md5 = 256043499a9eaf658de00b4f96e5d22a
- 未改：top_retina_event.v、udp_merge.v、act_state_cdc.v、event_sink.v、nn/**、
  pin.xdc、prj/**、tool/build_inproc.tcl、host/**、docs/**。
- 既有 TB 期望值**零改动**（tb_act3_hdr / tb_act3_tlv / tb_act3_idleclr 未编辑；
  它们只断言数据帧 byte23 或 ACK 尾 TLV 0x92，不检查 CTRL 头 byte23；ACK CRC 由
  TB 用收到的字节自适应重算，故无需更新期望）。

## 1. (a) 静态证明：pkt_byte 7'd23 分支返回 act_byte_s

命令：

```
cd /e/workspace/FPGA_Comp/retina_event
grep -n "act_byte_s" src/hdl/comms/downlink_cmd.v
```

原始输出：

```
221:    wire [7:0] act_byte_s = i_act_byte;
585:                            default: tlv_byte = act_byte_s;  // 直读同源锁存值（不另存快照）
656:                    7'd23: pkt_byte = act_byte_s;
```

pkt_byte 片段（:651-658）：

```
7'd22: pkt_byte = 8'h00;          // EV_REC_BYTES=0（无事件段）
// ★ M4f：BYTE23 = 动作字节（契约 §2.1「每包都带 byte23」）。
//   CTRL/心跳头同样携带，否则上位机每收心跳会重置 VALID 边沿
//   状态机 ⇒ 同一次动作被记两次。与数据帧/TLV 0x92 同源
//   （act_state_cdc 过域锁存，clk_eth 域慢变，只读不写）。
7'd23: pkt_byte = act_byte_s;
default: pkt_byte = 8'h00;        // RSVD=0
```

R8（byte23 先写、再进 CRC）在构包器里的证据（:931-940）：

```
931:                B_RUN: begin
933:                    o_ctrl_data  <= pkt_byte(b_idx);
935:                    b_crc        <= crc16_step(b_crc, pkt_byte(b_idx));
942:                B_CRC1: begin                       // 尾部 CRC 高字节
```

⇒ 第 idx 字节（含 idx=23）在 B_RUN 逐字节输出并同拍进入 crc16_step；CRC 在 B_CRC1/
B_CRC2 才追加，没有"CRC 后补写"、没有绕开 hdr_byte/pkt_byte、没有扩包头。

## 2. (b) 新 TB：tb_act3_ctrlhdr（21 checks 全 PASS，RC=0）

命令（唯一仿真入口）：

```
cd/e/workspace/FPGA_Comp/retina_event && pwsh -NoProfile -ExecutionPolicy Bypass \
  -File tool/run_sim.ps1 -Tb tb_act3_ctrlhdr
```

结果：`[PASS] tb_act3_ctrlhdr`，退出码 **0**，日志
`build/sim/tb_act3_ctrlhdr/vsim.log`，
仿真结束时间 1,050,000,972 ns（Elapsed 1:20），`TEST_RESULT=PASS`，
`# Errors: 0, Warnings: 0`。

TB 结构：act_state_cdc（clk_cam，`ACT_IDLE_CYC=50_000_000` = 1.0 s @50 MHz）→
downlink_cmd（clk_eth，`HEARTBEAT_CYC=3_125_000` = 25 ms，仅为缩短仿真时间；
生产默认 125_000_000 不变）。动作注入 class=1/conf=17（0xC5）。
ACT_IDLE_CYC/HEARTBEAT_CYC 均为 TB 参数覆盖，RTL 默认值未改。

CHECK 与实测（原始日志节选）：

```
P0_HB_FOUND PASS              (pkt=0 op=f0 clen=25)
P0_HB_BYTE23_00 PASS          byte23=00 hdr0..7=f0 5a a5 30 03 18 8c 00
P0_HB_CRC_OK PASS             TB 独立复算 CRC16 覆盖 [0..30+clen-1]
P1_ACT_CDC_C5 PASS            act_state_cdc 过域后 = C5
P2_ACK_FOUND PASS             (pkt=1 op=01 clen=26)
P2_ACK_BYTE23_C5 PASS         SET_PARAM ACK byte23=C5
P2_ACK_STATUS_OK PASS         status=00
P2_ACK_CRC_OK PASS
P2_CRC_INCLUDES_BYTE23 PASS   跳过 idx=23 重算 CRC 与线上 CRC 不等 ⇒ byte23 在覆盖率内
P3_HB_FOUND PASS              (pkt=2 op=f0 clen=25)
P3_HB_BYTE23_C5 PASS          heartbeat byte23=C5
P3_HB_CRC_OK PASS
P4_NO_EARLY_CLEAR PASS        ACT_IDLE_CYC-2000 拍时仍为 C5（未提前清零）
P4_IDLE_CLEAR_00 PASS         空窗后锁存=00
P4_WINDOW_CYC PASS            实测窗口 = 50000003 clk_cam 拍（50_000_000 + 3 拍 CDC 延迟）
P5_ACK_FOUND PASS             (pkt=42 op=01 clen=26)
P5_ACK_BYTE23_00 PASS         清零后 SET_PARAM ACK byte23=00
P5_ACK_CRC_OK PASS
P6_HB_FOUND PASS              (pkt=43 op=f0 clen=25)
P6_HB_BYTE23_00 PASS          清零后心跳 byte23=00
P6_HB_CRC_OK PASS
TEST_RESULT=PASS
```

说明：
- 心跳 opcode 0xF0 与 SET_PARAM ACK（opcode 0x01）两类的 byte23 都被覆盖；
- "1.0 s 空窗"用生产默认 ACT_IDLE_CYC=50_000_000 拍（50 MHz ⇒ 1.0 s）实测，
  实测窗口 50,000,003 拍（多出的 3 拍是 cdc_tog_word 的过域延迟，属预期）；
- 两条包的 CRC16 均由 TB 独立复算（不是读 RTL 内部 CRC），且额外做
  "删掉 byte23 再算"的负项检查，证明 byte23 确实参与 CRC16（R8）。

## 3. (c) 13 个既有 TB 回归：全部 RC=0

命令（逐个跑，日志 `build/regress_m4f.log`，共 387 行）：

```
cd /e/workspace/FPGA_Comp/retina_event
for tb in tb_act3_hdr tb_act3_tlv tb_nn_feat tb_nn_engine tb_nn_top tb_udp_merge \
          tb_wire_v3 tb_downlink_cmd tb_uart_baud tb_uart_link tb_stall_repro \
          tb_udp_mtu_cap tb_top_retina_event; do
  pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb $tb
done
```

| TB | RC | TEST_RESULT |
|---|---|---|
| tb_act3_hdr | 0 | PASS |
| tb_act3_tlv | 0 | PASS |
| tb_nn_feat | 0 | PASS |
| tb_nn_engine | 0 | PASS |
| tb_nn_top | 0 | PASS (31 checks) |
| tb_udp_merge | 0 | PASS |
| tb_wire_v3 | 0 | PASS |
| tb_downlink_cmd | 0 | PASS |
| tb_uart_baud | 0 | PASS |
| tb_uart_link | 0 | PASS |
| tb_stall_repro | 0 | PASS |
| tb_udp_mtu_cap | 0 | PASS |
| tb_top_retina_event | 0 | PASS |

统计：`TEST_RESULT=PASS` 13 次、`TEST_RESULT=FAIL` 0 次、`[FAIL]` 行 0 条。
新增 TB 也 RC=0，合计 14/14。

期望值改动说明：**无**。tb_act3_hdr 断言的是 udp_merge 数据帧 byte23（本任务未动）；
tb_act3_tlv 断言 GET_STATUS ACK 的 CTRL_LEN=71 与尾 TLV 0x92，并自适应重算 CRC
（头 byte23 变化后 CRC 随之变化属预期，重算即通过）；tb_act3_idleclr 只测
act_state_cdc。三者文件未被编辑，CHECK 未删未改。

## 4. (d) TOP_ELAB：全树 vlog + top elaboration，Errors 0

目录：`build/sim/top_elab27`（files.f 56 行 = src/hdl 全树 54 个 .v
+ sim/models/clk_wiz_0_sim.v + sim/models/bufg_sim.v，绝对 Windows 路径）。

```
vlib work                                   -> VLOG_LIB_RC=0
vlog -quiet -work work -f files.f           -> VLOG_RC=0
vsim -c -voptargs=+acc -gSIM=1 -gUSE_DDR3=0 -gETH_EN=0 -gUART_EN=0 \
     -do "quit -f" work.top_retina_event     -> VSIM_RC=0
```

原始输出：

```
# Loading work.top_retina_event(fast)
# Errors: 0, Warnings: 4
```

4 条 Warning 均为既有 event_sink 调试端口未接（与 M4d 相同）：
top_retina_event.v(618) u_event_sink Expected 49, found 46 / Missing connection for
o_ev_dbg_valid / o_ev_dbg_y / o_ev_dbg_x。无新增 warning。

## 5. 边界与未做事项

- 未运行 Vivado 综合/实现/bitstream，未烧板（任务卡要求；待阈值标定后统一构建）。
- 未做 git 写操作；未装依赖；未改白名单外文件。
- 打包 CRC 仍由构包器按 idx 顺序计算（R8 未变），ACK 全包长度/字段布局不变
  （SET_PARAM ACK CTRL_LEN=26、心跳 CTRL_LEN=25、GET_STATUS ACK CTRL_LEN=71）。

## 6. 结论

ACT3_CTRLHDR_OK=1：心跳(0xF0)与 SET_PARAM ACK 的 BYTE23 现在等于同一 clk_eth 域
动作字节（class=1/conf=17 ⇒ 0xC5；1.0 s 空窗后 ⇒ 0x00），CRC16 由 TB 独立复算通过
且证明覆盖 byte23；13 个既有 TB 全 RC=0；全树 elaboration Errors 0。

M4F_OK=1

# M4b RTL 证据 — offset23 动作字节锁存 + TLV 0x92 回传（task-11）

- 日期：2026-10-29
- 工程：E:/workspace/FPGA_Comp/retina_event（Vivado 2020.2 / xc7a100tfgg484-2 / 达芬奇Pro）
- 仿真器：ModelSim SE 2020.4（E:/Programs/modeltech64_2020.4/win64）
- 契约：docs/03_tech/05_action_uplink_contract.md
  byte23 = bit7 VALID | bit6..2 CONF(0..31) | bit1..0 CLASS(0=无动作/1=手合/2=横挥/3=保留)；
  未启用 = 0x00；class=2,conf=17 ⇒ 0x80|(17<<2)|2 = 8'hC6。

## 0. 改动落点（RTL 清单）

| 文件 | 位置 | 改动 |
|---|---|---|
| src/hdl/subsys/act_state_cdc.v | 新增（76 行） | clk_cam 域动作判定 → clk_eth 单寄存器锁存过域；例化 cdc_tog_word #(.WIDTH(8),.STAGES(2),.SETTLE(3))；上电 0x00，判定后保持，不清零 |
| src/hdl/comms/udp_merge.v | :134 | 新增端口 i_act_byte[7:0] |
| 同上 | :223-225 | reg act_byte_q（帧锁存）；wire act_byte_s = i_act_byte（直连） |
| 同上 | :572 | 复位 act_byte_q <= 8'h00（上电 VALID=0） |
| 同上 | :604-608 | 帧边界锁存：IS_V3 && state==S_IDLE && chunk_idx==0 && n_full==0 ⇒ act_byte_q <= act_byte_s（与 mode_q 同条件；帧后不清零） |
| 同上 | :498 | hdr_byte() 5'd23 = act_byte_q（v3 分支；default 仍 0x00，v2 分支不动） |
| 同上 | S_HDR（约 :664-668） | o_tx_byte <= hdr_byte(hdr_idx); crc_reg <= crc16_step(crc_reg, hdr_byte(hdr_idx)); ⇒ byte23 与 CRC 同拍写入，CRC 覆盖含 byte23 的整包头 |
| src/hdl/subsys/event_sink.v | :88, :250 | 新增 i_act_byte 端口并透传给 u_udp_merge |
| src/hdl/comms/downlink_cmd.v | :115 | 新增 i_act_byte[7:0] 端口 |
| 同上 | :213 | localparam U_ACTION = 8'h92 |
| 同上 | :221 | wire act_byte_s = i_act_byte（直连；原防 X 防护已按 Lead 指示去掉） |
| 同上 | :422 | OP_GET_STATUS ctrl_len_of = 16'd71（原 68） |
| 同上 | :583-585 | GET_STATUS TLV 尾部 3 B：7'd68=0x92、7'd69=0x01、default=act_byte_s（直读同源值，不重算/不另锁存） |
| src/hdl/top/top_retina_event.v | :574-585 | wire act_byte_eth；唯一 act_state_cdc 实例（i_act_* 暂 tie 常量，TODO(task-20)）；:618 event_sink、:705 downlink_cmd 各接 .i_act_byte(act_byte_eth) |
| sim/tb/tb_top_retina_event.f | 第 42 行 | 编译清单加入 src/hdl/subsys/act_state_cdc.v |

## 1. ACT3_HDR_OK = 1（数据帧 byte23 锁存）

命令（退出码 0）：

    cd /e/workspace/FPGA_Comp/retina_event
    pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_act3_hdr

判据与日志（build/sim/tb_act3_hdr/vsim.log）：

    CHECK=ACT3_HDR_F1_6PKTS PASS
    CHECK=ACT3_HDR_INIT_ZERO PASS
    CHECK=ACT3_HDR_INIT_CRC PASS
    CHECK=ACT3_HDR_INIT_HDRLEN PASS
    CHECK=ACT3_HDR_F2_6PKTS PASS
    CHECK=ACT3_HDR_BYTE23_C6 PASS
    CHECK=ACT3_HDR_C6_CRC PASS
    CHECK=ACT3_HDR_FRAME_IDX_F2 PASS
    CHECK=ACT3_HDR_F3_6PKTS PASS
    CHECK=ACT3_HDR_BYTE23_FD PASS
    CHECK=ACT3_HDR_FD_CRC PASS
    CHECK=ACT3_HDR_FRAME_IDX PASS
    CHECK=ACT3_HDR_NO_DROP PASS
    TEST_RESULT=PASS

关键 INFO（每帧取第 0 分片包；每帧 6 包，包长 1306 = 24 头 + 1280 raw + 2 CRC）：

    # INFO pkt=0  len=1306 frame=0 chunk=0 byte23=00 hdr0..7=f0 5a a5 30 03 18 2d 00 crc_calc=7499 crc_pkt=7499
    # INFO pkt=6  len=1306 frame=1 chunk=0 byte23=c6 hdr0..7=f0 5a a5 30 03 18 2d 00 crc_calc=3821 crc_pkt=3821
    # INFO pkt=12 len=1306 frame=2 chunk=0 byte23=fd hdr0..7=f0 5a a5 30 03 18 2d 00 crc_calc=d466 crc_pkt=d466

- 帧 1（未注入判定）：byte23=0x00（VALID=0）。
- 帧 2（clk_cam 域注入 i_act_pulse 1 拍，class=2 / conf=17）：byte23=0xC6 = 0x80|(17<<2)|2，与契约期望一致。
- 帧 3（class=1 / conf=31）：byte23=0xFD = 0x80|(31<<2)|1。
- TB 对每帧全部 6 个分片包逐一断言 byte23 相同、FRAME_IDX 递增 0/1/2、且独立复算 CRC16 覆盖 [0..len-3]（含 byte23）与包尾 2 B 相同（crc_calc==crc_pkt）。⇒ R8 硬约束（先写 byte23 再进 CRC、同帧一致、不扩包头）由端到端抓包证明。
- 帧间判定更新只影响下一帧（帧边界锁存），未被本帧中途改写。

## 2. ACT3_TLV_OK = 1（GET_STATUS ACK 尾部 TLV 0x92）

命令（退出码 0）：

    cd /e/workspace/FPGA_Comp/retina_event
    pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb tb_act3_tlv

判据与日志（build/sim/tb_act3_tlv/vsim.log）：

    CHECK=ACT3_TLV_ZERO_103B PASS
    CHECK=ACT3_TLV_C6_103B PASS
    CHECK=ACT3_TLV_FD_103B PASS
    CHECK=ACT3_TLV_LEGACY PASS
    TEST_RESULT=PASS

关键 INFO（CTRL 抓包，三次 GET_STATUS(0x04)）：

    # INFO ack pn=0 clen=71 total=103 tail=920100 hdr0..7=f05aa53003188c00 crc=8d71/8d71
    # INFO ack pn=1 clen=71 total=103 tail=9201c6 hdr0..7=f05aa53003188c00 crc=c5f7/c5f7
    # INFO ack pn=2 clen=71 total=103 tail=9201fd hdr0..7=f05aa53003188c00 crc=41fa/41fa

- 无动作：尾 3 B = 92 01 00（value=0x00）。
- class=2/conf=17：92 01 C6。
- class=1/conf=31：92 01 FD。
- 三次 ACK 均 CTRL_LEN=71、整包 103 B、CRC16 独立复算覆盖 [0..100] 与尾 2 B 一致、头 F0 5A A5 30 / VER 03 / HDR_LEN 0x18 / FLAGS.bit7=1。
- ACT3_TLV_LEGACY：旧 TLV 绝对偏移不变（30=0x81 MODE、72=0x8A FW、77=0x8C EV_EN、80=0x8D EV_RES、83=0x8E SER_STATE、88=0x8F NET_STATE、91=0x90 EXP_CAP、95=0x91 BAUD），新增 0x92 只在尾部追加 ⇒ 旧 68 B 解析器仍可解析（多出的 3 B 作为未知 tag 跳过）。

## 3. TOP_ELAB_OK = 1（top 全 RTL 编译 + elaboration）

编译（全 RTL 树 54 个 .v + 2 个仿真模型 = 56 文件）：

    cd /e/workspace/FPGA_Comp/build/sim/top_elab_all
    vlog.exe -quiet <src/hdl 全树 *.v> <sim/models/*.v>
    # VLOG_ALL_RC=0

elaboration（以 top 为根，参数取工程顶层 TB 同款 SIM 配置）：

    vsim.exe -c -voptargs=+acc -gSIM=1 -gUSE_DDR3=0 -gETH_EN=0 -gUART_EN=0 -do "quit -f" work.top_retina_event
    # VSIM_TOP_FULL_RC=0
    # Loading work.top_retina_event(fast)
    # Loading work.act_state_cdc(fast)
    # Loading work.event_sink(fast)
    # Loading work.downlink_cmd(fast)
    # Errors: 0, Warnings: 4

说明：
- 4 条 Warning 是 top 既有问题（top_retina_event.v:590 event_sink 例化少接 3 个 o_ev_dbg_* 端口，Expected 49 / found 46），与本任务改动无关；i_act_byte 连接存在，无端口告警。
- 默认参数（USE_DDR3=1/ETH_EN=1）无法在本机以 top 为根 elaboration：display_path 引用的厂商模块（picture_size / ov5640_dri / ddr3_top / rd_id / lcd_driver）不在仓库内、eth_udp 未列入默认综合清单；这与工程既有 TB 的配置声明一致（tb_top_retina_event.v：SIM=1, USE_DDR3=0, ETH_EN=0, UART_EN=0）。因此 TOP_ELAB 采用与顶层 TB 完全相同的配置，覆盖全部自研 RTL（含 M4b 新增 act_state_cdc）。
- 另在 tb_top_retina_event 的完整编译清单（46 文件）上运行 vsim work.tb_top_retina_event 亦为 rc=0、Errors: 0（见 build/sim/top_elab/vsim.log）。

## 4. 103 B ACK 逐段构成（GET_STATUS）

| 段 | 绝对字节偏移 | 长度 | 内容 |
|---|---|---|---|
| v3 上行头 | [0..23] | 24 B | F0 5A A5 30 / VER=03 / HDR_LEN=18 / FLAGS / MODE / CHUNK_IDX(2) / FRAME_IDX(2) / RAW_LEN(2) / EV_LEN(2) / TS_US(6) / EV_REC_BYTES / byte23=ACTION_STATE |
| 控制头 | [24..29] | 6 B | OP / STATUS / SEQ(2, BE) / CTRL_LEN(2, BE)=71 |
| TLV 既有段 | [30..97] | 68 B | 0x81 MODE 3 + 0x82 THETA 4 + 0x83 MIN_DL 4 + 0x84 TS_OFFSET 8 + 0x85 RTT 4 + 0x86 TS_FLAGS 3 + 0x87 FRAME_IDX 4 + 0x88 DROP 6 + 0x89 BOOT_ID 6 + 0x8A FW 5 + 0x8C EV_EN 3 + 0x8D EV_RES 3 + 0x8E SER_STATE 5 + 0x8F NET_STATE 3 + 0x90 EXP_CAP 4 + 0x91 BAUD 3 |
| TLV 新增段 | [98..100] | 3 B | 92 01 <byte23>（tag=0x92 ACTION_STATE, len=1, value=byte23） |
| CRC16 | [101..102] | 2 B | CRC-16/CCITT-FALSE（poly 0x1021, init 0xFFFF）覆盖 [0..100] |

合计 24 + 6 + 71 + 2 = 103 B；CTRL_LEN = 71 = 68 + 3 ⇒ b_total = 32 + CTRL_LEN = 103。
其余 ACK 长度不变：SET_PARAM 26 / SET_MODE 3 / TIME_SYNC 11 / EV_EN 3 / 心跳 25。

## 5. 既有 TB 回归（全部退出码 0）

命令：对 sim/tb 下每个既有 tb 逐个执行
pwsh -NoProfile -ExecutionPolicy Bypass -File tool/run_sim.ps1 -Tb <tb>（每个 900 s 超时包裹），
判据 = 日志含 TEST_RESULT=PASS 且无 TEST_RESULT=FAIL ⇒ 退出码 0。

结果：63/63 既有 TB 退出码 0（另有本任务新增 tb_act3_hdr、tb_act3_tlv 也均为 0，合计 65/65）：

    tb_axis_fifo 0, tb_cam_tap 0, tb_chain_probe 0, tb_clk_rst_gen 0, tb_delay_pipe 0,
    tb_disp_mux 0, tb_downlink_cmd 0, tb_edge_detect 0, tb_eth_udp 0, tb_event_gen 0,
    tb_event_render 0, tb_font_rom 0, tb_fps_meter 0, tb_hud_event_layer 0, tb_hud_grid 0,
    tb_hud_inject 0, tb_hud_panel 0, tb_hud_sprite 0, tb_hud_stack 0, tb_hud_status 0,
    tb_hud_text 0, tb_lcd_scanout 0, tb_line_buffer 0, tb_link_detect 0, tb_luma_log 0,
    tb_mode_cdc 0, tb_nn_engine 0, tb_nn_feat 0, tb_nn_top 0, tb_ov5640_timing_ovr 0,
    tb_probe 0, tb_px_luma 0, tb_raw_phase 0, tb_raw_phase_field 0, tb_raw_phase_seam 0,
    tb_refractory 0, tb_retina_core 0, tb_retina_core_cam 0, tb_retina_core_wp 0,
    tb_sccb_ila_dump 0, tb_sccb_patch 0, tb_seam_linkdrop 0, tb_spatial_lap 0,
    tb_stall_repro 0, tb_stats_counter 0, tb_sync_ff 0, tb_sys_ctrl 0, tb_temporal_diff 0,
    tb_top_retina_event 0, tb_ts_gen 0, tb_uart_baud 0, tb_uart_ev_tap 0, tb_uart_link 0,
    tb_uart_tap_sat 0, tb_uart_telemetry 0, tb_uart_tx_frame 0, tb_udp_decim_stall 0,
    tb_udp_merge 0, tb_udp_mtu_cap 0, tb_vps_mux 0, tb_vps_pattern_gen 0,
    tb_vps_resample 0, tb_wire_v3 0

与 M4b 直接相关的重点回归：tb_wire_v3（byte23=0x00 断言）、tb_udp_merge、tb_udp_mtu_cap、
tb_udp_decim_stall、tb_downlink_cmd（GET_STATUS clen=71 + 92 01 00）、tb_uart_baud（P5/P7 103 B）、
tb_uart_link（L5 103 B）、tb_stall_repro、tb_top_retina_event（top 端到端）。

收尾（tie-off 防 X 防护改直连）后，复跑以下 8 个受影响 TB 均退出码 0：
tb_act3_hdr、tb_act3_tlv、tb_wire_v3、tb_downlink_cmd、tb_udp_merge、tb_udp_mtu_cap、
tb_uart_baud、tb_uart_link。

## 6. 已知事项 / 后续（M4C 集成）

- 按 Lead 指示，已把 udp_merge.v:225 与 downlink_cmd.v:221 的
  (^i_act_byte === 1'bx) ? 8'h00 : i_act_byte 防 X 防护简化为直连 wire [7:0] act_byte_s = i_act_byte;
  （上电 0x00 由 act_state_cdc 复位保证；复跑 8 个受影响 TB 均 0，见 §5 末尾）。
- 数据帧 byte23 与 TLV 0x92 同源：均来自 act_state_cdc 的单一 o_act_byte 电平寄存器；
  CTRL 路径不按 class/conf 重算、不另设锁存。数据帧按契约 2.5 节在帧边界再锁存一次
  （act_byte_q），保证同一 frame_idx 的所有分片包 byte23 相同。

M4RTL_OK=1

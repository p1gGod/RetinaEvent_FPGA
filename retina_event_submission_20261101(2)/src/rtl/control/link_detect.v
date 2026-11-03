//==============================================================================
// link_detect.v —— 通信接口检测器（WIRE-U1 §5，R3）
//
// 目的：给出"网口可用"的**单一真值** `o_net_ok`，供
//   ① 下行 CTRL 心跳 TLV 0x8F NET_STATE 上报（上位机状态徽标）；
//   ② 事件帧/串口链路的"只事件回传"裁决（§5.3）。
//
// 判据两层（§5.1）：
//   L1 物理层 eth_plug：PHY 自协商 link up。当前 RTL 无 MDIO 读出 ⇒ 按设计
//      §5.1 允许"缺省恒 1"（顶层 tie 1），探测开销仅每秒一帧 UDP。
//   L2 应用层：最近 T_HOLD 内收到过 ≥1 条**合法下行帧**（i_dl_valid 来自
//      downlink_cmd.o_dl_accepted：MAGIC_D+VER+CRC16 过+OPCODE 白名单）。
//
// 状态机与全部超时数字（§5.2，**逐条照抄设计**，参数可在 TB 缩小）：
//
//   上电 ──5 s（FIRST_MS，避开 PHY 自协商）──► 探测轮
//   探测轮：发 TIME_SYNC_REQ(0x83) ×3（PROBE_N），间隔 1 s（PROBE_GAP_MS），
//           每次等应答 800 ms（PROBE_WAIT_MS）
//      ├─ 任一次收到合法下行 ──► NET_UP
//      └─ 3 次全无应答 ────────► NET_DOWN（在第 3 次 800 ms 超时即判，总时长 ≤8 s）
//   NET_UP  ：10 s（HOLD_MS）内有合法下行则保持；连续 10 s 无 ⇒ NET_DOWN（滞回）
//   NET_DOWN：每 60 s（RECHECK_MS）重探一轮；任何时刻收到合法下行 ⇒ NET_UP
//   eth_plug=0：不发探针，直接 NET_DOWN（省 ARP 等待）
//
// 探针复用现成通道（§5.2"零新增命令"）：o_probe_req 1 拍脉冲 → 顶层与
//   downlink_cmd.o_force_cal 相或 → ts_gen.i_force_cal → 0x83 CTRL 包。
//
// 状态编码与 TLV 0x8F 一致：0=DOWN / 1=UP / 2=UNKNOWN（上电 5~8 s 期间 UNKNOWN；
//   此期间不阻塞任何通路——检测器只增能力，不先扣能力）。
//
// 时钟域：clk_eth（与 downlink_cmd/ts_gen 同域）。
//==============================================================================
`timescale 1ns / 1ps

module link_detect #(
    parameter CLK_HZ        = 125_000_000,  // clk_eth 频率
    parameter FIRST_MS      = 5000,         // 上电首判延时（§5.2）
    parameter PROBE_N       = 3,            // 每轮探针次数
    parameter PROBE_GAP_MS  = 1000,         // 探针间隔
    parameter PROBE_WAIT_MS = 800,          // 单次等应答超时
    parameter HOLD_MS       = 10000,        // NET_UP 维持窗口（滞回）
    parameter RECHECK_MS    = 60000         // NET_DOWN 重探周期
)(
    input  wire        clk_eth,
    input  wire        rst_n_eth,
    // ---- L1：PHY link（缺省恒 1，见文件头）----
    input  wire        i_eth_plug,
    // ---- L2：合法下行帧脉冲（downlink_cmd.o_dl_accepted，同域）----
    input  wire        i_dl_valid,
    // ---- 探针请求（→ ts_gen.i_force_cal 通道，1 拍脉冲）----
    output reg         o_probe_req,
    // ---- 结论 ----
    output wire        o_net_ok,        // = (state == UP)
    output reg  [1:0]  o_net_state,     // 0=DOWN / 1=UP / 2=UNKNOWN（= TLV 0x8F 取值）
    output reg         o_state_chg      // 状态变化 1 拍脉冲（→ 即时插发 CTRL）
);

    localparam [1:0] N_DOWN = 2'd0, N_UP = 2'd1, N_UNK = 2'd2;
    // Verilog-2001 不允许对 parameter 直接位选（ts_gen.v 同注）⇒ 预先取位
    localparam [1:0] PROBE_N2 = PROBE_N;

    //--------------------------------------------------------------------------
    // 1 ms 节拍（CLK_HZ/1000 拍；TB 用同比例小 CLK_HZ 即可缩短）
    //--------------------------------------------------------------------------
    localparam MS_DIV = (CLK_HZ / 1000 < 1) ? 1 : (CLK_HZ / 1000);
    localparam MW = $clog2(MS_DIV + 1);

    reg [MW-1:0] ms_cnt;
    wire         ms_tick = (ms_cnt == (MS_DIV - 1));

    always @(posedge clk_eth or negedge rst_n_eth) begin
        if (!rst_n_eth) ms_cnt <= {MW{1'b0}};
        else            ms_cnt <= ms_tick ? {MW{1'b0}} : (ms_cnt + 1'b1);
    end

    //--------------------------------------------------------------------------
    // 状态机
    //--------------------------------------------------------------------------
    localparam [2:0] S_BOOT=3'd0, S_PROBE=3'd1, S_WAIT=3'd2, S_GAP=3'd3,
                     S_UP=3'd4,   S_DOWN=3'd5;

    localparam PW = 20;                 // ms 计数位宽（60000 ms 需 16 位，留裕量）
    // S_GAP 需补齐的毫秒数（探针间隔 - 等应答窗口）
    localparam GAP2_MS = (PROBE_GAP_MS > PROBE_WAIT_MS) ? (PROBE_GAP_MS - PROBE_WAIT_MS) : 1;

    reg [2:0]  sstate;
    reg [PW-1:0] wait_cnt;              // 各阶段 ms 计数
    reg [1:0]  probe_left;              // 本轮剩余探针数（含当前这次）
    reg [1:0]  state_d;

    always @(posedge clk_eth or negedge rst_n_eth) begin
        if (!rst_n_eth) begin
            sstate      <= S_BOOT;
            wait_cnt    <= {PW{1'b0}};
            probe_left  <= PROBE_N2;
            o_probe_req <= 1'b0;
            o_net_state <= N_UNK;       // 上电 UNKNOWN（§5.3 不确定性处理）
            o_state_chg <= 1'b0;
            state_d     <= N_UNK;
        end
        else begin
            o_probe_req <= 1'b0;        // 默认 1 拍脉冲
            state_d     <= o_net_state;
            o_state_chg <= (o_net_state != state_d);   // 变化沿 1 拍

            case (sstate)
                //--------------------------------------------------------------
                S_BOOT: begin
                    if (ms_tick) begin
                        if (wait_cnt >= (FIRST_MS - 1)) begin
                            wait_cnt <= {PW{1'b0}};
                            if (!i_eth_plug) begin
                                // eth_plug=0：不发探针，直接 NET_DOWN
                                o_net_state <= N_DOWN;
                                probe_left  <= {2{1'b0}};
                                sstate      <= S_DOWN;
                            end
                            else begin
                                probe_left <= (PROBE_N >= 1) ? PROBE_N2 : 2'd1;
                                sstate     <= S_PROBE;
                            end
                        end
                        else wait_cnt <= wait_cnt + 1'b1;
                    end
                end
                //--------------------------------------------------------------
                S_PROBE: begin                 // 发探针，随即进入等应答
                    o_probe_req <= 1'b1;
                    wait_cnt    <= {PW{1'b0}};
                    sstate      <= S_WAIT;
                end
                //--------------------------------------------------------------
                S_WAIT: begin                  // 等应答 800 ms
                    if (i_dl_valid) begin
                        // 任一次收到合法下行 ⇒ NET_UP（§5.2）
                        o_net_state <= N_UP;
                        sstate      <= S_UP;
                        wait_cnt    <= {PW{1'b0}};
                    end
                    else if (ms_tick) begin
                        if (wait_cnt >= (PROBE_WAIT_MS - 1)) begin
                            wait_cnt <= {PW{1'b0}};
                            if (probe_left <= 2'd1) begin
                                // 3 次全无应答 ⇒ NET_DOWN（≤8 s 出结论）
                                o_net_state <= N_DOWN;
                                probe_left  <= {2{1'b0}};
                                sstate      <= S_DOWN;
                            end
                            else begin
                                probe_left <= probe_left - 2'd1;
                                sstate     <= S_GAP;   // 补齐到 1 s 间隔再探下一发
                            end
                        end
                        else wait_cnt <= wait_cnt + 1'b1;
                    end
                end
                //--------------------------------------------------------------
                S_GAP: begin                   // 探针间隔补齐（间隔 1 s）
                    if (i_dl_valid) begin
                        o_net_state <= N_UP;
                        sstate      <= S_UP;
                        wait_cnt    <= {PW{1'b0}};
                    end
                    else if (ms_tick) begin
                        // 已等 PROBE_WAIT_MS，再补 (PROBE_GAP_MS-PROBE_WAIT_MS)
                        if (wait_cnt >= (GAP2_MS - 1)) begin
                            wait_cnt <= {PW{1'b0}};
                            sstate   <= S_PROBE;
                        end
                        else wait_cnt <= wait_cnt + 1'b1;
                    end
                end
                //--------------------------------------------------------------
                S_UP: begin                    // 维持判据：T_HOLD 内必须有合法下行
                    if (i_dl_valid) begin
                        wait_cnt <= {PW{1'b0}};              // 刷新维持窗口
                    end
                    else if (ms_tick) begin
                        if (wait_cnt >= (HOLD_MS - 1)) begin
                            o_net_state <= N_DOWN;           // 滞回：连续 10 s 无 ⇒ DOWN
                            wait_cnt    <= {PW{1'b0}};
                            sstate      <= S_DOWN;
                        end
                        else wait_cnt <= wait_cnt + 1'b1;
                    end
                end
                //--------------------------------------------------------------
                S_DOWN: begin                  // 退避 60 s 重探一轮
                    if (i_dl_valid) begin
                        o_net_state <= N_UP;                 // 任何时刻合法下行 ⇒ UP
                        wait_cnt    <= {PW{1'b0}};
                        sstate      <= S_UP;
                    end
                    else if (ms_tick) begin
                        if (wait_cnt >= (RECHECK_MS - 1)) begin
                            wait_cnt <= {PW{1'b0}};
                            if (i_eth_plug) begin
                                probe_left <= (PROBE_N >= 1) ? PROBE_N2 : 2'd1;
                                sstate     <= S_PROBE;
                            end
                            // eth_plug=0：不起新轮（省 ARP 等待），留在 S_DOWN
                        end
                        else wait_cnt <= wait_cnt + 1'b1;
                    end
                end
                default: sstate <= S_BOOT;
            endcase
        end
    end

    assign o_net_ok = (o_net_state == N_UP);

endmodule

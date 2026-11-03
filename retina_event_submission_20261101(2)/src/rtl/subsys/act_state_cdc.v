//==============================================================================
// act_state_cdc —— 动作判定结果锁存 + 空窗清零 + clk_cam -> clk_eth 跨域
//   （M4b / task-11 建立；M4d / task-23 增加 ACT_IDLE_CYC 空窗清零）
//
// 【契约】docs/03_tech/05_action_uplink_contract.md §2.5 / §3
//   byte23 = bit7 VALID | bit6..2 CONF(0..31) | bit1..0 CLASS
//   raw    = (VALID<<7) | ((CONF & 5'h1F) << 2) | (CLASS & 2'b11)
//   · 上电/复位后 = 8'h00（VALID=0，无动作）。
//   · 语义 = "最近一次有效判定后的 class/conf + VALID=1"，并保持到
//     **空窗超时**：距最近一次 i_act_pulse 连续 ACT_IDLE_CYC 拍（默认
//     50_000_000 = 1.0 s @ 50 MHz）没有新判定，则 byte23 自动回 8'h00
//     （VALID=0）。这样每次动作都产生一个 VALID 上升沿，上位机可按
//     "VALID 由 0 变 1" 计数（M5 的 >=100 次统计依赖此语义）。
//   · 相邻两次判定间隔 < ACT_IDLE_CYC 时计数器在 pulse 当拍清零重装，
//     不会提前清零；清零只发生一次（act_tog_s 只在值真正变化时翻转），
//     不会在总线上抖动。
//   · 清零翻转一次 act_tog_s，与值同拍更新，经 cdc_tog_word 成对过域；
//     过域后 o_act_byte 也只有一次有效变化（无中间态）。
//   · 同一个锁存值同时供两条上行通道：数据帧 byte23（udp_merge 每帧锁存一份）
//     与 GET_STATUS ACK 的 TLV 0x92（downlink_cmd 直读）⇒ 同源快照，契约 §3 末段。
//   · 位域 / TLV 长度 / 包长 / CRC 通路均不受本模块影响。
//
// 【为什么是 cdc_tog_word 而不是两条 sync_ff】
//   源域（clk_cam）动作值 act_byte_s 与 toggle act_tog_s 同拍更新；用两条独立
//   sync_ff 过域时，目标域对两组信号独立判决，可能"toggle 先到、值晚 1 拍"
//   ⇒ 采到旧值且不会再补（toggle 是电平式一次性）——正是 F3-20261013 的根因。
//   cdc_tog_word 检到 toggle 变化沿后重装 SETTLE=3 拍静默窗，窗口最后一拍
//   **同拍**提交值与 toggle ⇒ 下游沿采值必得新值（见 cdc_tog_word.v 头注释）。
//
// 【CDC 约定】
//   · cdc_tog_word 没有源域复位端口 ⇒ act_byte_s / act_tog_s / idle_cnt 的源域
//     复位在本模块完成（上电后 tog 从 0 起，首条判定的翻转必被识别为变化沿）；
//   · 动作判定是慢变事件（≥ 帧级），远慢于目标域时钟，符合"慢变命令专用"约束；
//   · 清零也是慢变事件（1 Hz 量级），与判定同等安全。
//   · 本模块只做锁存/空窗计时/过域，不做判定、不做去抖（判定在 nn_top 侧）。
//==============================================================================
`timescale 1ns / 1ps

module act_state_cdc #(
    // 空窗清零门限（clk_cam 拍数）：50_000_000 = 1.0 s @ 50 MHz
    parameter integer ACT_IDLE_CYC = 50_000_000
) (
    // ---- 源域：动作判定输出（clk_cam，nn_top 引擎侧）----
    input  wire        clk_cam,
    input  wire        rst_n_cam,
    input  wire        i_act_pulse,     // 1 拍脉冲：本拍 class/conf 有效（o_act_pulse）
    input  wire [1:0]  i_act_class,     // 0=无动作 1=手部开合 2=横向挥手 3=保留
    input  wire [4:0]  i_act_conf,      // 置信度 0..31
    // ---- 目标域：以太网发送侧（clk_eth）----
    input  wire        clk_eth,
    input  wire        rst_n_eth,
    output wire [7:0]  o_act_byte       // 锁存后的动作字节（VALID 保持至空窗超时）
);

    // 50_000_000 < 2^26，计数器 26 位足够；改小 ACT_IDLE_CYC（TB）也安全
    localparam integer IDLE_CNT_W = 26;
    localparam [IDLE_CNT_W-1:0] IDLE_CYC_M1 = ACT_IDLE_CYC - 1;

    //--------------------------------------------------------------------------
    // 源域锁存 + 空窗清零：
    //   有判定 ⇒ 更新 class/conf/VALID=1 并翻转 tog、计数器清零；
    //   无判定且计数到 ACT_IDLE_CYC-1 ⇒ 下一拍清零（值真正为 0 时不再翻转）。
    //--------------------------------------------------------------------------
    reg [7:0]  act_byte_s;
    reg        act_tog_s;
    reg [IDLE_CNT_W-1:0] idle_cnt;

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            act_byte_s <= 8'h00;        // 上电无动作 ⇒ VALID=0
            act_tog_s  <= 1'b0;         // 与 cdc_tog_word 复位值一致
            idle_cnt   <= {IDLE_CNT_W{1'b0}};
        end
        else if (i_act_pulse) begin
            // ★ 编码：VALID=1 | CONF<<2 | CLASS（契约 §2.5）
            act_byte_s <= {1'b1, i_act_conf, i_act_class};
            act_tog_s  <= ~act_tog_s;    // 与值同拍翻转（cdc_tog_word 靠它握手）
            idle_cnt   <= {IDLE_CNT_W{1'b0}};   // 空窗计时器在每次判定时重置
        end
        else if (idle_cnt == IDLE_CYC_M1) begin
            // ★ 空窗超时：VALID 回 0；只在值非 0 时翻转一次 tog，避免抖动
            if (act_byte_s != 8'h00) begin
                act_byte_s <= 8'h00;
                act_tog_s  <= ~act_tog_s;
            end
            // 计数值保持饱和，等待下一次 pulse 重置
        end
        else begin
            idle_cnt <= idle_cnt + 1'b1;
        end
    end

    //--------------------------------------------------------------------------
    // 值 + toggle 成对过域：2 级同步 + 3 拍静默窗后同拍提交
    //--------------------------------------------------------------------------
    cdc_tog_word #(
        .WIDTH  (8),
        .STAGES (2),
        .SETTLE (3)
    ) u_act_cdc (
        .dst_clk   (clk_eth),
        .dst_rst_n (rst_n_eth),
        .i_src_val (act_byte_s),
        .i_src_tog (act_tog_s),
        .o_dst_val (o_act_byte),
        .o_dst_tog ()
    );

endmodule

//==============================================================================
// cdc_tog_word —— "命令值 + toggle" 成对跨域原语（L1 基础原语）
//
// 引入背景：★ 修复 F3-20261013（SET_MODE 偶发写不生效 ≈2/44）
//
// 【为什么需要它（根因，代码级）】
//   源域（clk_eth）的命令寄存器与 toggle 在**同一拍**翻转：
//       o_mode_set <= s_mode[1:0];  o_mode_set_upd <= ~o_mode_set_upd;   // downlink_cmd.v
//   跨域若用**两条互相独立的 sync_ff**（值一条、toggle 一条），虽然级数相同，
//   但一级触发器在同一目标域时钟沿对两组信号**独立判决**（亚稳/建立余量各自）
//   ⇒ 观察到"值新 / toggle 新"的时刻最多可差 **1 个目标域周期**。
//   下游消费侧按 toggle 变化沿采值（sys_ctrl.v:169）：
//       else if (i_mode_set_upd ^ mode_upd_d) o_mode <= i_mode_set_val;
//   toggle 链先到 ⇒ 该沿采到**旧值**，而 toggle 是电平式（只翻一次）⇒
//   **该次写永久丢失**（不是延迟生效）。现场符合度：SET_MODE 5 轮丢 1（轮4）、
//   项6 66.1 s 一条 ACK ok:true 但读回 mode=1（旧值）—— 命令确已下发到跨域口。
//
// 【修复原理（"toggle 握手确认后再采 value"）】
//   · 值 2 级同步 + toggle 2 级同步（均带 ASYNC_REG，让工具链布局到相邻 slice）；
//   · 目标域检到 toggle **变化沿**后，重装 SETTLE 拍**静默窗**（值链此时必然已稳定），
//     窗口结束时**同拍**更新 o_dst_val 与 o_dst_tog ⇒ "命令值与标志严格同拍到达"；
//   · 下游 sys_ctrl 一字不改（仍是"toggle 沿采值"语义，只是现在采到的一定是新值）。
//
// 【静默窗量化（为什么 SETTLE=3 够）】
//   目标域跑 50 MHz（T=20 ns）；最坏错拍 = 值链比 toggle 链晚 **1 个目标域周期**
//   （20 ns，两条链独立判决差的上界）。提交发生在"检到变化沿"后第 3 拍，
//   即采到的是 (变化沿 + 2 拍) 时刻的值 ⇒ 对 1 拍滞后留 **2 拍余量**；
//   换算：可容忍值链滞后至 3 个目标域周期（60 ns）。
//   （TB：tb_mode_cdc 的 K1 用例把 Δ 打到 +20 ns 复现，修复前 FAIL / 修复后 PASS。）
//
// 【接口约定】
//   · i_dst_rst_n 是 **目标域（dst_clk）的同步复位**（与 sync_ff 的复位约定一致）；
//   · 源域侧值必须"稳定后才允许再翻 toggle"（本设计的 downlink_cmd 是命令寄存器，
//     每次命令只写一次、写完保持 ⇒ 天然满足）；
//   · ❌ 禁止用本模块传**快变数据总线**（那必须走 axis_fifo）——本模块是慢变命令专用；
//   · 上电约定：源域 toggle 与目标域 o_dst_tog 都从 0 开始（同一复位）⇒ 首条命令
//     的翻转一定被识别为"变化沿"。
//==============================================================================
`timescale 1ns / 1ps

module cdc_tog_word #(
    parameter WIDTH  = 8,       // 1~32
    parameter STAGES = 2,       // 同步级数 2~4（与 sync_ff 一致）
    parameter SETTLE = 3        // toggle 变化沿后的静默窗（目标域拍数，有效 2~15）
)(
    input  wire             dst_clk,
    input  wire             dst_rst_n,
    input  wire [WIDTH-1:0] i_src_val,     // 源域稳定值
    input  wire             i_src_tog,     // 源域 toggle（每次写入翻转）
    output reg  [WIDTH-1:0] o_dst_val,     // 目标域值（与 o_dst_tog 同拍提交）
    output reg              o_dst_tog      // 目标域 toggle（变化沿 = 一次新值已提交）
);

    localparam [3:0] SETTLE_N = (SETTLE < 2) ? 4'd2 : ((SETTLE > 15) ? 4'd15 : SETTLE[3:0]);

    (* ASYNC_REG = "TRUE" *) reg [WIDTH-1:0] val_q [0:STAGES-1];
    (* ASYNC_REG = "TRUE" *) reg [STAGES-1:0] tog_q;
    reg       tog_d;            // 上一拍 toggle 同步输出（变化沿检测）
    reg [3:0] wait_cnt;         // 静默窗计数：0 = 空闲
    integer   k;

    always @(posedge dst_clk) begin
        if (!dst_rst_n) begin
            for (k = 0; k < STAGES; k = k + 1)
                val_q[k] <= {WIDTH{1'b0}};
            tog_q    <= {STAGES{1'b0}};
            tog_d    <= 1'b0;
            wait_cnt <= 4'd0;
            o_dst_val <= {WIDTH{1'b0}};
            o_dst_tog <= 1'b0;
        end
        else begin
            // ---- 两级（或更多级）同步 ----
            val_q[0] <= i_src_val;
            for (k = 1; k < STAGES; k = k + 1)
                val_q[k] <= val_q[k-1];
            tog_q <= {tog_q[STAGES-2:0], i_src_tog};
            tog_d <= tog_q[STAGES-1];

            // ---- 变化沿 → 静默窗 → 同拍提交（值 + toggle）----
            if (tog_q[STAGES-1] ^ tog_d) begin
                // 检到新命令：重装静默窗（窗口期内再来的沿只刷新窗口，最终发最新值 --
                // 与源域 last-writer-wins 语义一致；实测命令间隔 ≫ 窗口，不会合并）
                wait_cnt <= SETTLE_N;
            end
            else if (wait_cnt != 4'd0) begin
                wait_cnt <= wait_cnt - 4'd1;
                if (wait_cnt == 4'd1) begin
                    // ★ 静默窗结束：值与 toggle 在**同一拍**更新（下游沿采值必得新值）
                    o_dst_val <= val_q[STAGES-1];
                    o_dst_tog <= ~o_dst_tog;
                end
            end
        end
    end

endmodule

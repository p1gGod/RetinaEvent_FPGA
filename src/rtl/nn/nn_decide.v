//==============================================================================
// nn_decide —— 时序决策（clk_cam 域）：argmax(3) + margin 门槛 + 连续 N 窗 + refractory
//
// 【契约（见 nn_cfg.vh / task-6）】
//   · 每窗一次：对 3 个 int8 logit 做 argmax；margin = logit[c] - max(其余两个)；
//   · class != 0 且 margin >= MARGIN_MIN 记一次"命中"；
//   · **连续 N_CONSEC 个窗**都是同一类别才锁存：o_act_pulse 单拍、
//     o_act_class=该类别、o_act_conf=min(margin,31)；
//   · 锁存后在 REFRACTORY_CYC 内不再上报，且 refractory 期间的命中**不累计**
//     （防止"刚过期就补报"的抖动；实现口径写进 EVIDENCE_M3.md）；
//   · class 0 永不产生 pulse。
//
// 【输入握手（三路结果同源 CDC）】
//   3 路 logit 各自由一个 cdc_tog_word(WIDTH=8) 从 200 MHz 域送过来，三路的
//   i_src_tog 是**同一个** o_res_tog ⇒ 正常情况下 3 个 toggle 同拍提交。
//   本模块逐路按 toggle 变化沿锁存，凑齐 3 路（got==111）后**下一拍**才开始决策
//   （这样 argmax 组合逻辑看到的是已稳定的锁存值，不会出现"半新半旧"）。
//   若某路 CDC 因亚稳态晚 1 拍，也只表现为本次决策晚 1 拍，不会用混合值决策。
//==============================================================================
`timescale 1ns / 1ps
`include "nn_cfg.vh"

module nn_decide #(
    parameter integer REFRACTORY_CYC = `NN_REFRACTORY_CYC,
    parameter integer MARGIN_MIN     = `NN_MARGIN_MIN,
    parameter integer N_CONSEC       = `NN_N_CONSEC
)(
    input  wire        clk,
    input  wire        rst_n,

    // ---- 三路 logit + 提交标志（clk_cam 域，来自 3 个 cdc_tog_word）----
    input  wire [7:0]  i_l0,
    input  wire [7:0]  i_l1,
    input  wire [7:0]  i_l2,
    input  wire [2:0]  i_tog,          // [0]=l0, [1]=l1, [2]=l2

    // ---- 决策输出 ----
    output reg         o_act_pulse,    // 单拍
    output reg  [1:0]  o_act_class,
    output reg  [4:0]  o_act_conf,     // min(margin,31)

    // ---- 调试（TB / ILA 用；o_dbg_cnt/o_dbg_refr 比内部晚 1~2 拍）----
    output reg  [1:0]  o_dbg_class,    // 最近一次 argmax 类别
    output reg  [7:0]  o_dbg_margin,   // 最近一次 margin（饱和到 8 bit）
    output reg  [2:0]  o_dbg_cnt,      // 连续命中计数
    output reg         o_dbg_hit,      // 最近一次是否命中
    output reg         o_dbg_refr      // 处于 refractory
);

    //--------------------------------------------------------------------------
    // 输入锁存 / 提交检测
    //--------------------------------------------------------------------------
    reg [7:0] lat0, lat1, lat2;
    reg [2:0] tog_seen;
    reg [2:0] got;              // 三路各自"本次已锁存"标志

    // 进入 argmax 的稳定副本
    reg signed [7:0] s0, s1, s2;
    reg              res_vld;   // 三路齐后的下一拍：本拍做决策

    //--------------------------------------------------------------------------
    // 决策状态
    //--------------------------------------------------------------------------
    reg [1:0]  last_c;          // 连续命中序列的类别
    reg [2:0]  hit_cnt;         // 连续命中窗数（0 = 无序列）
    reg [31:0] refr_cnt;        // refractory 倒计时

    //--------------------------------------------------------------------------
    // 组合 argmax + margin（signed）
    //   margin 定义为 logit[c] - 次大 logit ⇒ 恒 >= 0（平局时 argmax 取小编号）
    //--------------------------------------------------------------------------
    reg [1:0]        cmb_c;
    reg signed [9:0] cmb_m;

    always @(*) begin
        if ((s0 >= s1) && (s0 >= s2)) begin
            cmb_c = 2'd0;
            cmb_m = s0 - ((s1 > s2) ? s1 : s2);
        end else if (s1 >= s2) begin
            cmb_c = 2'd1;
            cmb_m = s1 - ((s0 > s2) ? s0 : s2);
        end else begin
            cmb_c = 2'd2;
            cmb_m = s2 - ((s0 > s1) ? s0 : s1);
        end
    end

    wire cmb_hit = (cmb_c != 2'd0) && (cmb_m >= MARGIN_MIN);

    // 本次命中后新的连续计数：同类别续上，否则从 1 开始
    wire [2:0] cnt_new = ((hit_cnt != 3'd0) && (last_c == cmb_c)) ? (hit_cnt + 3'd1)
                                                                 : 3'd1;
    wire       pulse_now = (refr_cnt == 32'd0) && cmb_hit && (cnt_new >= N_CONSEC);

    //--------------------------------------------------------------------------
    // 主时序
    //--------------------------------------------------------------------------
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            lat0 <= 8'd0; lat1 <= 8'd0; lat2 <= 8'd0;
            tog_seen <= 3'd0; got <= 3'd0;
            s0 <= 8'sd0; s1 <= 8'sd0; s2 <= 8'sd0;
            res_vld <= 1'b0;
            last_c  <= 2'd0;
            hit_cnt <= 3'd0;
            refr_cnt <= 32'd0;
            o_act_pulse <= 1'b0;
            o_act_class <= 2'd0;
            o_act_conf  <= 5'd0;
            o_dbg_class <= 2'd0;
            o_dbg_margin <= 8'd0;
            o_dbg_cnt   <= 3'd0;
            o_dbg_hit   <= 1'b0;
            o_dbg_refr  <= 1'b0;
        end else begin
            o_act_pulse <= 1'b0;
            res_vld     <= 1'b0;

            // -------------------- 1) 逐路锁存 --------------------
            if (i_tog[0] != tog_seen[0]) begin
                lat0 <= i_l0; tog_seen[0] <= i_tog[0]; got[0] <= 1'b1;
            end
            if (i_tog[1] != tog_seen[1]) begin
                lat1 <= i_l1; tog_seen[1] <= i_tog[1]; got[1] <= 1'b1;
            end
            if (i_tog[2] != tog_seen[2]) begin
                // ★ NUM_CLASSES=2（两分类回退）时没有第 3 类：把 logit2 钉成 int8
                //   最小值 8'sh80(-128) ⇒ argmax 判据里 s1>=s2 恒成立，class2 永不
                //   胜出；NUM_CLASSES=3（默认）时行为与原实现逐位相同。
                lat2 <= (`NN_NUM_CLASSES >= 3) ? i_l2 : 8'sh80;
                tog_seen[2] <= i_tog[2]; got[2] <= 1'b1;
            end

            // -------------------- 2) 三路齐 → 下一拍决策 --------------------
            if (got == 3'b111) begin
                s0 <= lat0; s1 <= lat1; s2 <= lat2;
                res_vld <= 1'b1;
                got <= 3'b000;
            end

            // -------------------- 3) 决策 --------------------
            if (res_vld) begin
                o_dbg_class  <= cmb_c;
                o_dbg_margin <= (cmb_m > 10'sd127) ? 8'd127 : cmb_m[7:0];
                o_dbg_hit    <= cmb_hit;

                if (refr_cnt != 32'd0) begin
                    // refractory：只倒计时，命中不累计（也绝不 pulse）
                    refr_cnt <= refr_cnt - 32'd1;
                    hit_cnt  <= 3'd0;
                end else if (cmb_hit) begin
                    if (pulse_now) begin
                        o_act_pulse <= 1'b1;
                        o_act_class <= cmb_c;
                        o_act_conf  <= (cmb_m > 10'sd31) ? 5'd31 : cmb_m[4:0];
                        refr_cnt    <= REFRACTORY_CYC - 1;
                        hit_cnt     <= 3'd0;      // 上报后重新计数
                        last_c      <= cmb_c;
                    end else begin
                        hit_cnt <= cnt_new;
                        if (!((hit_cnt != 3'd0) && (last_c == cmb_c))) last_c <= cmb_c;
                    end
                end else begin
                    hit_cnt <= 3'd0;              // 本窗未命中 ⇒ 连续序列断开
                end
            end else if (refr_cnt != 32'd0) begin
                refr_cnt <= refr_cnt - 32'd1;
            end

            // -------------------- 调试镜像 --------------------
            o_dbg_cnt  <= hit_cnt;
            o_dbg_refr <= (refr_cnt != 32'd0);
        end
    end

endmodule

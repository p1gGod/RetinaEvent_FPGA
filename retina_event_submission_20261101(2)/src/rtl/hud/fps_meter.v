//==============================================================================
// fps_meter.v —— LCD 帧率表（用户需求 2026-10-11，v3 设计未覆盖的补充项）
//
// 需求（lead 转达）：
//   画面为"事件 / 原画+事件"模式时显示**事件帧率**；纯原始画面时显示**采集帧率**。
//
// 语义（本板架构下的可测定义，实现报告有完整说明）：
//   采集帧率 = i_frame_cnt（retina_core 帧计数 = 相机帧）每秒增量；
//   事件帧率 = 每秒内"该帧实际产生了 ≥1 条事件"的帧数
//            （i_ev_per_frame 在帧边界处非零的次数）。
//   i_show_ev=1（事件/合成画面）⇒ 输出事件帧率；=0（纯原始）⇒ 输出采集帧率。
//
// 实现要点：
//   - 1 s 窗口计数（CLK_FREQ_HZ 分频），输出每秒刷新一次、准静态 ⇒ 用 sync_ff
//     过域即可（调用方负责 CDC-2 到 clk_lcd）。
//   - 帧边界 = i_frame_cnt 变化沿（计数器每帧 +1，不依赖 vsync 极性）。
//   - 帧率饱和到 255，MODE 标签原样寄存输出（给 hud_panel 的 1 字符模式行）。
//==============================================================================
`timescale 1ns / 1ps

module fps_meter #(
    parameter CLK_FREQ_HZ = 50000000
)(
    input  wire        clk_cam,
    input  wire        rst_n_cam,
    input  wire [31:0] i_frame_cnt,      // 采集/引擎帧计数（每帧 +1）
    input  wire [23:0] i_ev_per_frame,   // 最近一帧的事件数
    input  wire        i_show_ev,        // 1 = 当前显示事件/合成画面（选事件帧率）
    input  wire [1:0]  i_mode,           // v3 回传模式（LCD 模式标签来源）
    output reg  [7:0]  o_fps,            // 帧/秒（饱和 255，1 Hz 刷新）
    output reg  [1:0]  o_mode_tag        // 0=RAW_EV(R+E) 1=RAW_ONLY(R) 2=EV_ONLY(E)
);

    localparam SEC_CYC = CLK_FREQ_HZ;               // 1 s 窗口（50 MHz ⇒ 26 bit）
    localparam CNT_W   = $clog2(SEC_CYC + 1);

    reg [CNT_W-1:0] sec_cnt;
    reg [31:0] fcnt_d;              // 帧计数前一拍（沿检测 + 窗口快照）
    reg [31:0] fcnt_snap;           // 窗口起点快照
    reg [7:0]  ev_frames;           // 本窗口内"有事件的帧"数
    reg        ev_frame_d;          // 上一帧是否已计数（一帧只计一次）

    wire frame_strobe = (i_frame_cnt != fcnt_d);

    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            sec_cnt    <= {CNT_W{1'b0}};
            fcnt_d     <= 32'd0;
            fcnt_snap  <= 32'd0;
            ev_frames  <= 8'd0;
            ev_frame_d <= 1'b0;
            o_fps      <= 8'd0;
            o_mode_tag <= 2'd0;
        end
        else begin
            fcnt_d <= i_frame_cnt;

            // ---- 帧边界：事件帧计数（一帧只计一次）----
            if (frame_strobe) begin
                if (!ev_frame_d && (i_ev_per_frame != 24'd0) && (ev_frames != 8'hFF))
                    ev_frames <= ev_frames + 8'd1;
                ev_frame_d <= 1'b1;
            end
            else ev_frame_d <= 1'b0;

            // ---- 1 s 窗口 ----
            if (sec_cnt == SEC_CYC[CNT_W-1:0] - 1) begin
                sec_cnt   <= {CNT_W{1'b0}};
                // 采集帧率 = 窗口内帧计数增量；事件模式选事件帧率
                o_fps     <= i_show_ev ? ev_frames
                                       : ((i_frame_cnt - fcnt_snap) > 32'd255 ?
                                          8'hFF : i_frame_cnt[7:0] - fcnt_snap[7:0]);
                fcnt_snap <= i_frame_cnt;
                ev_frames <= 8'd0;
            end
            else sec_cnt <= sec_cnt + 1'b1;

            o_mode_tag <= i_mode;
        end
    end

endmodule

//==============================================================================
// refractory -- 事件流不应期抑制（L2 事件引擎，P1 可旁路）
//
// 规格：retina_event/docs/子模块设计/L2_事件引擎/refractory.md §2/§3/§4/§6
//   两级抑制（均可配、可旁路）：
//     B1~B4 每像素跨帧不应期：冷却位图（400×240×1bit = 96,000 bit）
//            按 8 像素/字节打包成 12,000 × 8bit ⇒ 综合约 3 块 BRAM36（文档 §7）
//            每 REFRACT_FRAMES 帧在 vsync 后整体清扫一遍（12000 拍，消隐期内完成）
//     B5    全局最小间隔：放行后计数器置 MIN_GAP_CLK，减到 0 前不再放行
//     B6    i_bypass = 1 时**零额外延迟纯直通**（doc §6）
//
// 流水线（非旁路路径，延迟 2 拍）：
//   cycle t   : 输入事件 → 计算字节地址/位号，发同步读
//   cycle t+1 : 读回值 + 上一拍写回旁路 → 判决 pass1（写回冷却位 + 放行）
//   cycle t+2 : o_ev_* 输出寄存
//
//   ⚠️ "上一拍写回旁路"（we_d1/aw_d1/wd_d1）解决同一字节内相邻两拍事件读到陈旧位的
//      竞态：若本拍要读的字节正是上一拍刚判决要写的字节，直接用新值而非读口旧值。
//
// ⚠️ §9.2 位图地址必须严格 = x + y·IMG_W（本实现：pix = y·IMG_W + x，字节 = pix>>3）。
// ⚠️ §9.5 不应期独立成链上一级，别做进 event_gen（本模块可整体旁路）。
//
// 参数 REFRACT_FRAMES = 1 时每帧都清扫 ⇒ "冷却位存活 1 帧" = 不额外抑制（§9.1 建议）。
//==============================================================================
`timescale 1ns / 1ps

module refractory #(
    parameter REFRACT_FRAMES = 2,       // 每像素不应期（帧数，1~8）
    parameter MIN_GAP_CLK    = 0,       // 全局最小事件间隔（0 = 关闭）
    parameter IMG_W          = 400,     // 冷却位图宽度
    parameter IMG_H          = 240      // 冷却位图高度
)(
    input  wire       clk_cam,
    input  wire       rst_n_cam,
    input  wire       i_vsync,          // 帧边界（冷却位图衰减）
    input  wire       i_bypass,         // 1 = 直通（不抑制）
    input  wire       i_ev_valid,
    input  wire [8:0] i_ev_x,
    input  wire [7:0] i_ev_y,
    input  wire       i_ev_pol,
    output wire       o_ev_valid,
    output wire [8:0] o_ev_x,
    output wire [7:0] o_ev_y,
    output wire       o_ev_pol
);

    function integer clog2;
        input integer value;
        integer i;
        begin
            clog2 = 0;
            for (i = value - 1; i > 0; i = i >> 1) clog2 = clog2 + 1;
        end
    endfunction

    localparam PIX = IMG_W * IMG_H;             // 96,000
    localparam NBA = (PIX + 7) / 8;             // 12,000 字节
    localparam AW  = (clog2(NBA) < 1) ? 1 : clog2(NBA);   // 14
    localparam RAW = (clog2(PIX) < 4) ? 4 : clog2(PIX);   // 17

    localparam [15:0] GAP_INIT = MIN_GAP_CLK;

    // 冷却位图衰减调度（⚠️ 相位很关键）：
    //   §4 B4 允许"每 REFRACT_FRAMES 帧整体清 0"，但**首次清扫必须比帧率晚 1 帧**，
    //   否则"清扫紧接在事件前一拍"会让同一像素在相邻两帧都放行，违反 §8 V1
    //   （实测：首版在 vsync#2 就清扫，帧1/帧2 连续放行）。
    //   本实现：第 (REFRACT_FRAMES+1) 个 vsync 首次清扫，此后每 REFRACT_FRAMES 个 vsync 一次
    //   ⇒ REFRACT_FRAMES=2 时序列为 放行/抑制/放行/抑制 ✓
    //   REFRACT_FRAMES=1 时退化为"每帧清扫"（= 每像素每帧最多 1 个事件）。
    localparam [3:0] CLR_THRESH = (REFRACT_FRAMES > 1) ? REFRACT_FRAMES[3:0]     : 4'd0;
    localparam [3:0] CLR_RELOAD = (REFRACT_FRAMES > 1) ? (REFRACT_FRAMES[3:0]-1) : 4'd0;

    //--------------------------------------------------------------------------
    // B1：冷却位图（8 像素/字节 ⇒ 综合约 3 块 BRAM36）
    //--------------------------------------------------------------------------
    (* ram_style = "block" *) reg [7:0] cool_mem [0:NBA-1];
    integer k;
    initial begin
        for (k = 0; k < NBA; k = k + 1) cool_mem[k] = 8'h00;
    end

    //--------------------------------------------------------------------------
    // B2：像素索引 → 字节地址 + 位号（常数乘 IMG_W，零变量除法 —— 事实 H23）
    //--------------------------------------------------------------------------
    wire [RAW-1:0] pix_idx = (i_ev_y * IMG_W) + i_ev_x;
    wire [AW-1:0]  a0      = pix_idx[RAW-1:3];
    wire [2:0]     b0      = pix_idx[2:0];

    //--------------------------------------------------------------------------
    // 寄存器：stage1 / 写回旁路 / 输出 / 全局间隔 / 清扫
    //--------------------------------------------------------------------------
    reg             ev1;
    reg [8:0]       x1;
    reg [7:0]       y1;
    reg             p1;
    reg [AW-1:0]    a1;
    reg [2:0]       b1;

    reg             we_d1;
    reg [AW-1:0]    aw_d1;
    reg [7:0]       wd_d1;

    reg [7:0]       rd_q;

    reg             o_v_q;
    reg [8:0]       o_x_q;
    reg [7:0]       o_y_q;
    reg             o_p_q;

    reg [15:0]      gap_cnt;

    reg             vs_d1;
    reg             clr_active;
    reg [AW-1:0]    clr_ptr;
    reg [3:0]       vs_cnt;

    wire vs_rise = i_vsync & ~vs_d1;

    //--------------------------------------------------------------------------
    // B2/B3/B4：读口 + 判决 + 写回（组合部分）
    //--------------------------------------------------------------------------
    // 读口数据 + 上一拍写回旁路（同一字节时用新值）
    wire [7:0] cool1 = (we_d1 && (aw_d1 == a1)) ? wd_d1 : rd_q;

    wire       hit1   = cool1[b1];                              // 冷却位 = 1 ⇒ 抑制
    wire       gap_ok = (MIN_GAP_CLK == 0) || (gap_cnt == 16'd0);
    wire       pass1  = ev1 & ~hit1 & gap_ok & ~i_bypass;       // 放行
    wire [7:0] wd1    = cool1 | (8'd1 << b1);                   // 置冷却位
    wire       we1    = ev1 & ~hit1 & ~i_bypass;                // 写回（与 gap 无关）

    //--------------------------------------------------------------------------
    // 主时序块
    //--------------------------------------------------------------------------
    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            ev1        <= 1'b0;
            x1         <= 9'd0;
            y1         <= 8'd0;
            p1         <= 1'b0;
            a1         <= {AW{1'b0}};
            b1         <= 3'd0;
            we_d1      <= 1'b0;
            aw_d1      <= {AW{1'b0}};
            wd_d1      <= 8'h00;
            rd_q       <= 8'h00;
            o_v_q      <= 1'b0;
            o_x_q      <= 9'd0;
            o_y_q      <= 8'd0;
            o_p_q      <= 1'b0;
            gap_cnt    <= 16'd0;
            vs_d1      <= 1'b0;
            clr_active <= 1'b0;
            clr_ptr    <= {AW{1'b0}};
            vs_cnt     <= 4'd0;
        end else begin
            // ---- 读端口（同步读 + 上一拍写回旁路）----
            rd_q <= (we_d1 && (aw_d1 == a0)) ? wd_d1 : cool_mem[a0];

            // ---- 写端口（清扫优先；自动清扫期间的事件写回让位 1 拍，可接受）----
            if (clr_active)   cool_mem[clr_ptr] <= 8'h00;
            else if (we1)     cool_mem[a1]      <= wd1;

            // ---- stage1 ----
            ev1  <= i_ev_valid;
            x1   <= i_ev_x;
            y1   <= i_ev_y;
            p1   <= i_ev_pol;
            a1   <= a0;
            b1   <= b0;

            // ---- 写回旁路寄存器（本拍判决 → 下一拍可见）----
            we_d1 <= we1;
            aw_d1 <= a1;
            wd_d1 <= wd1;

            // ---- 输出寄存（放行判定后 1 拍）----
            o_v_q <= pass1;
            o_x_q <= x1;
            o_y_q <= y1;
            o_p_q <= p1;

            // ---- B5：全局最小间隔 ----
            if (i_bypass)              gap_cnt <= 16'd0;
            else if (pass1)            gap_cnt <= GAP_INIT;
            else if (gap_cnt != 16'd0) gap_cnt <= gap_cnt - 1'b1;

            // ---- B4：冷却位图衰减（每 REFRACT_FRAMES 帧在帧边界整体清扫）----
            vs_d1 <= i_vsync;
            if (clr_active) begin
                if (clr_ptr == NBA - 1) clr_active <= 1'b0;
                else                    clr_ptr    <= clr_ptr + 1'b1;
            end
            if (vs_rise) begin
                if (vs_cnt >= CLR_THRESH) begin
                    clr_active <= 1'b1;
                    clr_ptr    <= {AW{1'b0}};
                    vs_cnt     <= CLR_RELOAD;
                end else begin
                    vs_cnt <= vs_cnt + 1'b1;
                end
            end
        end
    end

    //--------------------------------------------------------------------------
    // B6：旁路 = 纯直通（零额外延迟）
    //--------------------------------------------------------------------------
    assign o_ev_valid = i_bypass ? i_ev_valid : o_v_q;
    assign o_ev_x     = i_bypass ? i_ev_x     : o_x_q;
    assign o_ev_y     = i_bypass ? i_ev_y     : o_y_q;
    assign o_ev_pol   = i_bypass ? i_ev_pol   : o_p_q;

endmodule

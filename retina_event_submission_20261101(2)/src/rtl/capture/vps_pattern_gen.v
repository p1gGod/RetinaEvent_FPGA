//==============================================================================
// vps_pattern_gen -- 无相机条件下的自检 VPS 图案发生器（L2 采集，P0 解耦工具）
//
// 规格：retina_event/docs/子模块设计/L2_采集/vps_pattern_gen.md §2/§3/§4/§6
//   输出与真实相机 VPS **接口完全一致**（1 px/clk、vsync/de/data），可无缝替换。
//   MODE 0 = 水平灰度斜坡；1 = 棋盘格；2 = 运动方块；3 = 均匀场
//
// 扫描时序（B1/B2，与 LCD 同构）：
//   x_cnt 0..H_TOTAL-1，y_cnt 0..V_TOTAL-1 自由扫描（不被 i_en 阻塞）
//   de    = (x_cnt < IMG_W) && (y_cnt < IMG_H)
//   vsync = (x_cnt == 0) && (y_cnt == 0)，1 拍脉冲（VPS 契约："1 拍高 = 一帧起始"）
//   三者与图案打包**统一寄存 1 拍**输出，保证同拍对齐
//
// i_en = 0 时 o_vsync/o_de 强制 0、o_data 强制 0（§2"输出全 0 且 de=0"）。
//
// 图案算式（§4 B4，全部零乘法/零除法）：
//   MODE0 斜坡  lum = x_cnt[9:2]                 → 0..199（IMG_W=800 时跨满水平方向）
//   MODE1 棋盘  lum = (x_cnt[4] ^ y_cnt[4]) ? FF : 00   → 16×16 块
//   MODE2 方块  bx = 100 + frame_cnt[7:0]；方块 [bx,bx+64) × [200,264)，亮块 FF / 背景 20
//   MODE3 均匀  lum = 80
//   RGB565 打包 = {lum[7:3], lum[7:2], lum[7:3]}（灰度 → RGB565）
//
// ⚠️ §9.2：均匀场模式必须逐帧完全相同（本实现与 frame_cnt 无关 ⇒ 天然满足），
//    这样才能用"事件率 = 0"检验暗区量化噪声。
//==============================================================================
`timescale 1ns / 1ps

module vps_pattern_gen #(
    parameter IMG_W     = 800,      // 有效行宽
    parameter IMG_H     = 480,      // 有效行数
    parameter H_TOTAL   = 1056,     // 含消隐的行总周期（与 LCD 时序一致）
    parameter V_TOTAL   = 525,      // 含消隐的帧总行数
    parameter FRAME_DIV = 1         // 每多少帧推进一次图案（运动方块用）
)(
    input  wire        clk_cam,
    input  wire        rst_n_cam,
    input  wire [1:0]  i_mode,      // 图案模式（来自 RGS）
    input  wire        i_en,        // 使能（0 → 输出全 0 且 de=0）
    output reg         o_vsync,
    output reg         o_de,
    output reg  [15:0] o_data
);

    function integer clog2;
        input integer value;
        integer i;
        begin
            clog2 = 0;
            for (i = value - 1; i > 0; i = i >> 1) clog2 = clog2 + 1;
        end
    endfunction

    localparam XW = (clog2(H_TOTAL) < 1) ? 1 : clog2(H_TOTAL);   // 1056 → 11
    localparam YW = (clog2(V_TOTAL) < 1) ? 1 : clog2(V_TOTAL);   // 525  → 10

    reg [XW-1:0]  x_cnt;
    reg [YW-1:0]  y_cnt;
    reg [15:0]    frame_cnt;     // 已推进的"图案帧"序号
    reg [15:0]    div_cnt;       // FRAME_DIV 分频计数

    //--------------------------------------------------------------------------
    // B1/B2/B3：自由扫描计数器 + 帧计数
    //--------------------------------------------------------------------------
    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            x_cnt     <= {XW{1'b0}};
            y_cnt     <= {YW{1'b0}};
            frame_cnt <= 16'd0;
            div_cnt   <= 16'd0;
        end else if (x_cnt == H_TOTAL - 1) begin
            x_cnt <= {XW{1'b0}};
            if (y_cnt == V_TOTAL - 1) begin
                y_cnt <= {YW{1'b0}};
                if (div_cnt == FRAME_DIV - 1) begin
                    div_cnt   <= 16'd0;
                    frame_cnt <= frame_cnt + 1'b1;
                end else begin
                    div_cnt   <= div_cnt + 1'b1;
                end
            end else begin
                y_cnt <= y_cnt + 1'b1;
            end
        end else begin
            x_cnt <= x_cnt + 1'b1;
        end
    end

    wire de_w    = (x_cnt < IMG_W) && (y_cnt < IMG_H);

    // vsync 放在**场消隐期**（最后一条消隐行的行首）——与真实 OV5640 / LCD 时序一致。
    //
    // ⚠️ R1 修复（Lead 裁决，2026-10-03）：原来 vsync 与 (0,0) 有效像素**同拍**，
    //    下游 vps_resample 在 "i_vsync 当拍不出像素" 的纪律下会丢掉那一个像素
    //    ⇒ 该行只有 IN_W−1 个被计数的像素 ⇒ 行回绕（x_cnt==IN_W−1）永不成立
    //    ⇒ y_cnt 少进一次 ⇒ 每帧多出一整行（实测 96,400/帧 = 241 行 × 400）。
    //    真实相机的 vsync 本来就在消隐期，故这里按真实时序改：
    //    vsync 之后才是第一行第一列 (0,0)。
    wire vsync_w = (x_cnt == {XW{1'b0}}) && (y_cnt == V_TOTAL - 1);

    //--------------------------------------------------------------------------
    // B3/B4：运动方块定位（零乘法/零除法）
    //--------------------------------------------------------------------------
    wire [XW-1:0] bx = 11'd100 + frame_cnt[7:0];   // 100..355，截断到 XW 位
    wire in_block = (x_cnt >= bx) && (x_cnt < (bx + 64)) &&
                    (y_cnt >= 200) && (y_cnt < 264);

    //--------------------------------------------------------------------------
    // B4：四种图案（纯组合，零 DSP）
    //--------------------------------------------------------------------------
    reg [7:0] lum;

    always @(*) begin
        case (i_mode)
            2'd0:    lum = x_cnt[9:2];                                  // 水平灰度斜坡
            2'd1:    lum = (x_cnt[4] ^ y_cnt[4]) ? 8'hFF : 8'h00;       // 16×16 棋盘格
            2'd2:    lum = in_block ? 8'hFF : 8'h20;                    // 运动方块
            default: lum = 8'h80;                                       // 均匀场（静态）
        endcase
    end

    //--------------------------------------------------------------------------
    // B5：RGB565 打包（灰度复制到 R/G/B） + 1 拍输出寄存
    //--------------------------------------------------------------------------
    wire [15:0] px565 = {lum[7:3], lum[7:2], lum[7:3]};
    wire        out_en = de_w & i_en;

    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            o_vsync <= 1'b0;
            o_de    <= 1'b0;
            o_data  <= 16'h0000;
        end else begin
            o_vsync <= vsync_w & i_en;
            o_de    <= out_en;
            o_data  <= out_en ? px565 : 16'h0000;
        end
    end

endmodule

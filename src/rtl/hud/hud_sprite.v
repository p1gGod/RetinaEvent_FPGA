// ============================================================================
// hud_sprite.v -- OVL 平面 5（优先级最高）：通用图标 / 精灵
//
// 规格来源：docs/子模块设计/L2_屏上UI/hud_sprite.md（§2 端口 / §3 参数 / §8 判据）
//   文档 §9.2：索引 0 = **透明**（不要用"颜色等于某色则透明"）。
//
// 与文档的偏离（已在报告列出）：
//   文档 §4 B3/B4 描述的是"精灵点阵 ROM"。本模块改用**程序化几何生成** 4 个
//   32x32 图标（圆环 / 圆点 / 右箭头 / 方框）：不手写点阵、不占 BRAM/SRL、
//   改图形只改公式（§9.4「别手写点阵」的精神一致）。SPR_W/SPR_H 仍按参数生效
//   （包围盒 + 局部坐标），几何公式按 32x32 中心 16 设计。
//
// 时序：组合判定 + 默认 PIPE=1 寄存 1 拍（与其余 4 个平面在 hud_stack 入口对齐）。
// ============================================================================
module hud_sprite (
    input  wire        clk_lcd,
    input  wire        rst_n_lcd,
    input  wire [10:0] px_x,
    input  wire [10:0] px_y,
    input  wire        px_de,
    input  wire        ovl_en,
    output wire        ovl_hit,
    output wire [23:0] ovl_rgb,
    input  wire [3:0]  i_sprite_id,   // 精灵编号（RGS，已过 CDC-2）
    input  wire [10:0] i_sprite_x,    // 精灵左上角
    input  wire [10:0] i_sprite_y,
    input  wire [47:0] i_palette      // 4 色 x 12bit（4:4:4）
);

    parameter [5:0] SPR_W     = 6'd32;
    parameter [5:0] SPR_H     = 6'd32;
    parameter [3:0] N_SPRITES = 4'd4;
    parameter [1:0] SCALE     = 2'd1;    // 1 或 2
    parameter [2:0] BPP       = 3'd4;    // 4bit 索引（本实现用 1..4 号色 + 0 号透明）
    parameter       PIPE      = 1;

    localparam [10:0] BOX_W = SPR_W * SCALE;
    localparam [10:0] BOX_H = SPR_H * SCALE;

    // ---- B1 命中包围盒 + B2 局部坐标（整数放大：丢弃低位）------------------
    wire in_box = (px_x >= i_sprite_x) && (px_x < (i_sprite_x + BOX_W)) &&
                  (px_y >= i_sprite_y) && (px_y < (i_sprite_y + BOX_H));

    wire [10:0] lx11 = px_x - i_sprite_x;
    wire [10:0] ly11 = px_y - i_sprite_y;
    wire [5:0]  lx   = (SCALE == 2'd1) ? lx11[5:0] : lx11[6:1];
    wire [5:0]  ly   = (SCALE == 2'd1) ? ly11[5:0] : ly11[6:1];

    // ---- B3/B4 形状求值（程序化，替代点阵 ROM）-----------------------------
    wire signed [6:0]  dxs = $signed({1'b0, lx}) - 7'sd16;   // 32x32 中心 = 16
    wire signed [6:0]  dys = $signed({1'b0, ly}) - 7'sd16;
    wire signed [13:0] d2  = dxs * dxs + dys * dys;
    wire [5:0]         ady = dys[6] ? (6'd0 - dys[5:0]) : dys[5:0];   // |dy|

    wire shape0 = (d2 >= 14'sd36)  && (d2 <= 14'sd144);      // 圆环 r=6..12
    wire shape1 = (d2 <= 14'sd49);                           // 实心圆点 r=7
    wire shape2 = ((lx >= 6'd12) && (lx < 6'd27) && (ady <= (6'd27 - lx))) ||
                  ((lx >= 6'd4)  && (lx < 6'd12) && (ady <= 6'd3));   // 右箭头
    wire shape3 = (lx < 6'd4) || (lx >= 6'd28) ||
                  (ly < 6'd4) || (ly >= 6'd28);              // 方框（4px 边）

    reg [2:0] pidx;   // 0 = 透明；1..4 = 调色板索引
    always @(*) begin
        case (i_sprite_id)
            4'd0:    pidx = shape0 ? 3'd1 : 3'd0;
            4'd1:    pidx = shape1 ? 3'd2 : 3'd0;
            4'd2:    pidx = shape2 ? 3'd3 : 3'd0;
            4'd3:    pidx = shape3 ? 3'd4 : 3'd0;
            default: pidx = 3'd0;                       // 无此精灵 -> 全透明
        endcase
    end

    // ---- B5 调色板（索引 -> RGB888，4:4:4 位复制）--------------------------
    reg [11:0] pcol;
    always @(*) begin
        case (pidx)
            3'd1: pcol = i_palette[11:0];
            3'd2: pcol = i_palette[23:12];
            3'd3: pcol = i_palette[35:24];
            3'd4: pcol = i_palette[47:36];
            default: pcol = 12'h000;
        endcase
    end

    wire [23:0] rgb_c = {pcol[11:8], pcol[11:8],
                         pcol[7:4],  pcol[7:4],
                         pcol[3:0],  pcol[3:0]};

    // ---- B6 命中（索引 0 = 透明）-------------------------------------------
    wire hit_c = in_box & px_de & ovl_en & (pidx != 3'd0);

    // ★ 命中与颜色一起寄存（只寄存 hit 会让颜色错开 1 拍）
    generate
        if (PIPE == 0) begin : g_p0
            assign ovl_hit = hit_c;
            assign ovl_rgb = rgb_c;
        end else begin : g_pN
            reg        hit_r;
            reg [23:0] rgb_r;
            always @(posedge clk_lcd) begin
                if (!rst_n_lcd) begin
                    hit_r <= 1'b0;
                    rgb_r <= 24'h000000;
                end else begin
                    hit_r <= hit_c;
                    rgb_r <= rgb_c;
                end
            end
            assign ovl_hit = hit_r;
            assign ovl_rgb = rgb_r;
        end
    endgenerate

endmodule

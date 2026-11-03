// ============================================================================
// hud_text.v -- OVL 平面 4：固定文案（页眉/标签）逐像素渲染
//
// 规格来源：docs/子模块设计/L2_屏上UI/hud_text.md（§2 端口 / §3 参数 / §4 结构）
//   ★ 只做 ASCII（陷阱 13：片上字库不上中文）。文案由参数 TEXT_STR 给出，
//     **不手写字符 case**（§9.3）。
//
// 与文档的偏离（Lead 已裁决）：
//   1) `font_rom` 按 Lead 裁决**例化在本模块内部**（每平面一个实例，自洽），
//      因此文档 §2 的输入端口 `i_glyph_bits[7:0]` 取消（改为内部连线）；
//   2) 保留/新增观察端口 `o_char_code[6:0]` / `o_char_row[3:0]`（接到内部 font_rom，
//      TB 可直接观察，也是"谁在取哪个字形"的证据）。
//
// ★ H40 回归点：SCALE=2 时一个字符占 16x32，字形**行号必须取 dy[4:1]**。
//   早期实现写成 `sel_row = dy`（4 bit，值域 0..31 被截断成 dy mod 16），
//   字形会上下重复画两遍。本模块用 dy[4:1]（4 bit，正好 0..15）。
//
// 延迟：内部 font_rom 为 ROM_LATENCY=0（组合查表）⇒ 判定组合完成；
//       默认 PIPE=1 把 ovl_hit 寄存 1 拍，与其余 4 个平面在 hud_stack 入口对齐。
// ============================================================================
module hud_text (
    input  wire        clk_lcd,
    input  wire        rst_n_lcd,
    input  wire [10:0] px_x,
    input  wire [10:0] px_y,
    input  wire        px_de,
    input  wire        ovl_en,
    output wire        ovl_hit,
    output wire [23:0] ovl_rgb,
    output wire [6:0]  o_char_code,   // 观察端口：送内部 font_rom 的字符码
    output wire [3:0]  o_char_row     // 观察端口：字形行号 0..15
);

    parameter [10:0]  TEXT_X  = 11'd8;         // 文案左上角
    parameter [10:0]  TEXT_Y  = 11'd40;
    parameter [5:0]   CHAR_W  = 6'd8;          // 字形尺寸
    parameter [5:0]   CHAR_H  = 6'd16;
    parameter [1:0]   SCALE   = 2'd2;          // 放大倍数（2 => 每字 16x32）
    parameter [5:0]   MAX_CHARS = 6'd32;       // 文案最大字符数
    parameter [23:0]  FG_COLOR  = 24'hFFFFFF;  // 白（避开事件红/蓝）
    parameter         PIPE      = 1;

    // 32 字符文案（正好 32 个字符；改文案时同步改 TEXT_LEN）
    //   "RETINA EVENT HUD  ON/OFF 400x240"
    parameter [255:0] TEXT_STR  = "RETINA EVENT HUD  ON/OFF 400x240";
    localparam [5:0]  TEXT_LEN  = 6'd32;

    localparam [10:0] CELL_W = CHAR_W * SCALE;              // 16
    localparam [10:0] CELL_H = CHAR_H * SCALE;              // 32
    localparam [10:0] X_END  = TEXT_X + MAX_CHARS * CELL_W; // 8 + 512
    localparam [10:0] Y_END  = TEXT_Y + CELL_H;             // 40 + 32

    // ---- B1/B2/B3 字符格定位 + 字内偏移 ------------------------------------
    wire        in_area = (px_x >= TEXT_X) && (px_x < X_END) &&
                          (px_y >= TEXT_Y) && (px_y < Y_END);
    wire [10:0] dx = px_x - TEXT_X;
    wire [10:0] dy = px_y - TEXT_Y;

    wire [5:0]  cx_raw = dx[9:4];                              // / CELL_W(16)
    wire [5:0]  cx     = (cx_raw > (TEXT_LEN - 6'd1)) ? (TEXT_LEN - 6'd1) : cx_raw;
    wire [2:0]  col    = dx[4:1];                              // (dx % 16) / SCALE(2)
    wire [3:0]  row    = dy[4:1];                              // ★ (dy % 32) / SCALE(2) —— H40

    // ---- B4 文案 ROM：packed 字符串按字符索引 ------------------------------
    //   字符串字面量的第 0 个字符在**最高字节** ⇒ 第 i 个字符 = [(31-i)*8 +: 8]
    wire [7:0] cc8 = TEXT_STR[(31 - cx) * 8 +: 8];

    // ---- 内部字库（文档 §2 的 i_glyph_bits 输入改为内部连线）-------------------
    wire [7:0] glyph;
    font_rom u_font_rom (
        .clk_lcd (clk_lcd),
        .i_char  (cc8[6:0]),
        .i_row   (row),
        .o_bits  (glyph)
    );

    assign o_char_code = cc8[6:0];
    assign o_char_row  = row;

    // ---- B5/B6 点阵取位 + 命中 --------------------------------------------
    wire bit_on = glyph[7 - col];          // bit7 = 最左像素
    wire hit_c  = in_area & bit_on;
    wire [23:0] rgb_c = FG_COLOR;

    generate
        if (PIPE == 0) begin : g_p0
            assign ovl_hit = hit_c & px_de & ovl_en;
        end else begin : g_pN
            reg hit_r;
            always @(posedge clk_lcd) begin
                if (!rst_n_lcd) hit_r <= 1'b0;
                else            hit_r <= hit_c & px_de & ovl_en;
            end
            assign ovl_hit = hit_r;
        end
    endgenerate

    assign ovl_rgb = rgb_c;

endmodule

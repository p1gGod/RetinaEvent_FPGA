// ============================================================================
// hud_panel.v -- OVL 平面 3：仪表盘 / 统计条（把 stats_counter 的数字变成图形）
//
// 规格来源：docs/子模块设计/L2_屏上UI/hud_panel.md（§2 端口 / §3 参数 / §4 结构 / §8 判据）
//
// 面板内容（PANEL_X/Y/W/H = 8/8/320/152）：
//   * 深色背景板（整块矩形命中，不透明）
//   * 4 行文字（8x16 字形 x TEXT_SCALE=2 ⇒ 每字 16x32）
//       line0 "EV/FR:" + 6 位十进制（i_ev_per_frame）
//       line1 "CRX10:" + 6 位十进制（i_cr_x10，降低倍数 x10）
//       line2 "RHO:"   + 3 位十进制 + "%"（i_activity_q16 / 65536 的百分比）
//       line3 "MODE:R+E FPS:026"（v3.1：1 字符回传模式标签 + 帧率，用户需求 2026-10-11）
//         模式标签：i_mode_tag 0→"R+E"（RAW_EV）1→"R"（RAW_ONLY）2→"E"（EV_ONLY）
//         帧率来源：事件/合成画面 ⇒ 事件帧率；纯原始 ⇒ 采集帧率（fps_meter.v 选择）
//   * 事件率条形图：条长 = ρ × BAR_MAX_W，ρ = i_activity_q16 / 65536
//
// 十进制转换用**常数除法**（v/10、v/100…，综合器优化成乘加，无变量除法，
// 符合事实 H23）——见 §4 B3。
//
// 与文档的偏离（Lead 已裁决）：
//   1) `font_rom` 例化在本模块内部 ⇒ 文档 §2 的输入 `i_font_bitmap[7:0]` 取消；
//   2) 新增观察输出 `o_char_code[6:0]`/`o_char_row[3:0]`（文档 §2 遗漏：没有这两个
//      端口就没人能告诉 font_rom 取哪个字符哪一行）；
//   3) PANEL_H 120→152、新增 line3 与输入 i_mode_tag/i_fps（v3.1 帧率/模式标签，
//      2026-10-11 用户需求；tb_hud_panel 的几何镜像同步更新）。
//
// ★ §9.1/§9.2：统计值是**跨域**数据，本模块只做显示寄存器语义——调用方必须喂
//   CDC-2 之后、帧边界锁存的稳定值，否则数字会闪。本模块内部不再加锁存
//   （i_* 输入即"本拍要显示的稳定值"），保持纯组合 + 1 拍输出寄存。
// ============================================================================
module hud_panel (
    input  wire        clk_lcd,
    input  wire        rst_n_lcd,
    input  wire [10:0] px_x,
    input  wire [10:0] px_y,
    input  wire        px_de,
    input  wire        ovl_en,
    output wire        ovl_hit,
    output wire [23:0] ovl_rgb,
    input  wire [15:0] i_activity_q16,   // ρ × 65536（CDC-2 同步后）
    input  wire [23:0] i_ev_per_frame,   // 每帧事件数
    input  wire [23:0] i_cr_x10,         // 降低倍数 ×10
    input  wire [31:0] i_frame_cnt,      // 总帧数（保留：留给 fps 显示扩展）
    input  wire [1:0]  i_mode_tag,       // ★ v3.1：回传模式标签 0=R+E 1=R 2=E
    input  wire [7:0]  i_fps,            // ★ v3.1：帧率（事件/合成=事件帧率，纯原画=采集帧率）
    output wire [6:0]  o_char_code,      // 观察端口
    output wire [3:0]  o_char_row
);

    parameter [10:0] PANEL_X = 11'd8;
    parameter [10:0] PANEL_Y = 11'd8;
    parameter [10:0] PANEL_W = 11'd320;
    parameter [10:0] PANEL_H = 11'd152;   // ★ v3.1: 120 → 152（新增 line3）
    parameter [10:0] BAR_MAX_W = 11'd200;

    parameter [23:0] BG_COLOR      = 24'h101820;   // 深底
    parameter [23:0] FG_COLOR      = 24'hFFFFFF;   // 亮字
    parameter [23:0] BAR_COLOR     = 24'hE04040;   // 事件率条
    parameter [23:0] BAR_TRACK     = 24'h202830;   // 条槽
    parameter [1:0]  TEXT_SCALE    = 2'd2;
    parameter        PIPE          = 1;

    // ---- 版面常数（面板局部坐标）------------------------------------------
    localparam [10:0] CELL_W  = 11'd16;                 // CHAR_W(8) * TEXT_SCALE(2)
    localparam [10:0] CELL_H  = 11'd32;                 // CHAR_H(16) * TEXT_SCALE(2)
    localparam [10:0] LINE0_Y = 11'd4;
    localparam [10:0] LINE1_Y = 11'd36;                 // LINE0_Y + CELL_H
    localparam [10:0] LINE2_Y = 11'd68;
    localparam [10:0] LINE3_Y = 11'd100;                // ★ v3.1：MODE/FPS 行
    localparam [10:0] TX_OFF  = 11'd8;                  // 文字左边距
    localparam [10:0] BAR_XOFF= 11'd8;                  // 条左起点
    localparam [10:0] BAR_Y0  = PANEL_H - 11'd14;       // 138
    localparam [10:0] BAR_Y1  = PANEL_H - 11'd4;        // 148
    localparam [10:0] BAR_W   = PANEL_W - 11'd16;       // 304（条槽宽）

    // ---- B1 面板命中 -------------------------------------------------------
    wire in_panel = (px_x >= PANEL_X) && (px_x < (PANEL_X + PANEL_W)) &&
                    (px_y >= PANEL_Y) && (px_y < (PANEL_Y + PANEL_H));
    wire [10:0] lx = px_x - PANEL_X;    // 面板内局部坐标
    wire [10:0] ly = px_y - PANEL_Y;

    // ---- B3 数字排版：24bit -> 十进制（常数除法）---------------------------
    function [3:0] dig0; input [23:0] v; dig0 = (v / 100000) % 10; endfunction
    function [3:0] dig1; input [23:0] v; dig1 = (v /  10000) % 10; endfunction
    function [3:0] dig2; input [23:0] v; dig2 = (v /   1000) % 10; endfunction
    function [3:0] dig3; input [23:0] v; dig3 = (v /    100) % 10; endfunction
    function [3:0] dig4; input [23:0] v; dig4 = (v /     10) % 10; endfunction
    function [3:0] dig5; input [23:0] v; dig5 =  v            % 10; endfunction

    // 数字位数命名：dig0 = 最高位（十万位），dig5 = 个位
    //   ⇒ 显示位置 cx=6 放最高位，cx=11 放个位（否则数字会左右倒过来）
    wire [3:0] ev0 = dig0(i_ev_per_frame);
    wire [3:0] ev1 = dig1(i_ev_per_frame);
    wire [3:0] ev2 = dig2(i_ev_per_frame);
    wire [3:0] ev3 = dig3(i_ev_per_frame);
    wire [3:0] ev4 = dig4(i_ev_per_frame);
    wire [3:0] ev5 = dig5(i_ev_per_frame);

    wire [3:0] cr0 = dig0(i_cr_x10);
    wire [3:0] cr1 = dig1(i_cr_x10);
    wire [3:0] cr2 = dig2(i_cr_x10);
    wire [3:0] cr3 = dig3(i_cr_x10);
    wire [3:0] cr4 = dig4(i_cr_x10);
    wire [3:0] cr5 = dig5(i_cr_x10);

    // ρ 百分比（0..99）：q16 * 100 >> 16（常数乘法）
    wire [31:0] pct_prod = i_activity_q16 * 32'd100;
    wire [7:0]  pct      = pct_prod[23:16];
    wire [3:0]  pc2 = dig3({16'd0, pct});
    wire [3:0]  pc1 = dig4({16'd0, pct});
    wire [3:0]  pc0 = dig5({16'd0, pct});

    // ★ v3.1 帧率 3 位十进制（0..255）：常数除法，同 dig 系列
    //   （本模块 dig 命名：dig3=百位、dig4=十位、dig5=个位 —— 与 RHO 行一致）
    wire [3:0] fp2 = dig3({16'd0, i_fps});              // 百位（/100）
    wire [3:0] fp1 = (i_fps / 32'd10) % 32'd10;         // 十位
    wire [3:0] fp0 = dig5({16'd0, i_fps});              // 个位

    // ---- B2 条形区域：条长 = ρ × BAR_MAX_W ---------------------------------
    wire [31:0] bar_prod = i_activity_q16 * BAR_MAX_W;
    wire [10:0] bar_len  = bar_prod[26:16];             // /65536

    // ---- 行定位 + 字内偏移 -------------------------------------------------
    wire [1:0]  line_sel  = (ly >= LINE3_Y) ? 2'd3 :
                            ((ly >= LINE2_Y) ? 2'd2 : ((ly >= LINE1_Y) ? 2'd1 : 2'd0));
    wire [10:0] line_base = (line_sel == 2'd0) ? LINE0_Y :
                            ((line_sel == 2'd1) ? LINE1_Y :
                            ((line_sel == 2'd2) ? LINE2_Y : LINE3_Y));
    wire [10:0] dy_line   = ly - line_base;
    wire        in_line_y = (ly >= LINE0_Y) && (ly < (LINE3_Y + CELL_H));

    wire [10:0] tx  = lx - TX_OFF;
    wire        in_tx = (lx >= TX_OFF);
    wire [4:0]  cx  = tx[8:4];        // / CELL_W(16) -> 0..19
    wire [2:0]  col = tx[4:1];        // (tx % 16) / 2
    wire [3:0]  row = dy_line[4:1];   // (dy % 32) / 2  —— 与 hud_text 同一 H40 修法

    wire in_text = in_panel & in_line_y & in_tx;

    // ---- 字符码选择（每行 = 标签 + 数字；不手写点阵，只做 ASCII 代码映射）----
    reg [7:0] cc8;
    always @(*) begin
        cc8 = 8'h20;                                   // 默认空格（= 不点亮）
        case (line_sel)
            2'd0: begin
                case (cx)
                    5'd0: cc8 = "E";   5'd1: cc8 = "V";   5'd2: cc8 = "/";
                    5'd3: cc8 = "F";   5'd4: cc8 = "R";   5'd5: cc8 = ":";
                    5'd6:  cc8 = 8'h30 + ev0;   5'd7:  cc8 = 8'h30 + ev1;
                    5'd8:  cc8 = 8'h30 + ev2;   5'd9:  cc8 = 8'h30 + ev3;
                    5'd10: cc8 = 8'h30 + ev4;   5'd11: cc8 = 8'h30 + ev5;
                    default: cc8 = 8'h20;
                endcase
            end
            2'd1: begin
                case (cx)
                    5'd0: cc8 = "C";   5'd1: cc8 = "R";   5'd2: cc8 = "X";
                    5'd3: cc8 = "1";   5'd4: cc8 = "0";   5'd5: cc8 = ":";
                    5'd6:  cc8 = 8'h30 + cr0;   5'd7:  cc8 = 8'h30 + cr1;
                    5'd8:  cc8 = 8'h30 + cr2;   5'd9:  cc8 = 8'h30 + cr3;
                    5'd10: cc8 = 8'h30 + cr4;   5'd11: cc8 = 8'h30 + cr5;
                    default: cc8 = 8'h20;
                endcase
            end
            default: begin
                case (cx)
                    5'd0: cc8 = "R";   5'd1: cc8 = "H";   5'd2: cc8 = "O";
                    5'd3: cc8 = ":";
                    5'd4: cc8 = 8'h30 + pc2;   5'd5: cc8 = 8'h30 + pc1;
                    5'd6: cc8 = 8'h30 + pc0;   5'd7: cc8 = "%";
                    default: cc8 = 8'h20;
                endcase
            end
            2'd3: begin
                // ★ v3.1：MODE:R+E / R / E  FPS:nnn（模式标签与上行包 MODE 同源）
                case (cx)
                    5'd0: cc8 = "M";   5'd1: cc8 = "O";   5'd2: cc8 = "D";
                    5'd3: cc8 = "E";   5'd4: cc8 = ":";
                    5'd5: cc8 = (i_mode_tag == 2'd2) ? "E" : "R";            // 标签首字符
                    5'd6: cc8 = (i_mode_tag == 2'd0) ? "+" : " ";
                    5'd7: cc8 = (i_mode_tag == 2'd0) ? "E" : " ";
                    5'd8: cc8 = " ";
                    5'd9:  cc8 = "F";  5'd10: cc8 = "P";  5'd11: cc8 = "S";
                    5'd12: cc8 = ":";
                    5'd13: cc8 = 8'h30 + fp2;   5'd14: cc8 = 8'h30 + fp1;
                    5'd15: cc8 = 8'h30 + fp0;
                    default: cc8 = 8'h20;
                endcase
            end
        endcase
    end

    // ---- B4 字形读取（内部 font_rom，全局共用实例由各平面自持）-------------
    wire [7:0] glyph;
    font_rom u_font_rom (
        .clk_lcd (clk_lcd),
        .i_char  (cc8[6:0]),
        .i_row   (row),
        .o_bits  (glyph)
    );

    assign o_char_code = cc8[6:0];
    assign o_char_row  = row;

    wire bit_on   = glyph[7 - col];
    wire text_pix = in_text & bit_on;

    // ---- 条形区域 ----------------------------------------------------------
    wire bar_track = (lx >= BAR_XOFF) && (lx < (BAR_XOFF + BAR_W)) &&
                     (ly >= BAR_Y0) && (ly < BAR_Y1);
    wire bar_fill  = bar_track && ((lx - BAR_XOFF) < bar_len);

    // ---- B5 颜色合成（文字 > 条形 > 背景板）-------------------------------
    wire [23:0] rgb_c = text_pix  ? FG_COLOR   :
                        bar_fill  ? BAR_COLOR  :
                        bar_track ? BAR_TRACK  : BG_COLOR;

    wire hit_c = in_panel & px_de & ovl_en;

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
                    rgb_r <= BG_COLOR;
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

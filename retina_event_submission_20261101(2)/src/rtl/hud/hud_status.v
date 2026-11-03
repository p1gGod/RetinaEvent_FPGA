// ============================================================================
// hud_status.v -- OVL 平面 p6：右侧半透明参数 HUD（★ HUD，KEY2 面板位控制）
//
// 规格来源：docs/05_experiments/串口提速与屏上状态_20261017/接口约定.md §2
//   §2.1 遮罩 x∈[560,792)、y∈[280,424)（232×144），压暗 50%（bg>>1，每通道）；
//        文字 font_rom 8×16、白 0xFFFFFF、右对齐到 x=788、行距 20、
//        首行顶部 y=304、共 5 行；文字处白覆盖（不压暗）。
//   §2.2 五行格式：
//        行1 SRC R+E / SRC R / SRC E            <- i_mode_tag(0/1/2)
//        行2 TH <θ> DL <minDl>                  <- i_theta(12b) / i_min_dl(9b)
//        行3 TX R+E / TX R / TX E / TX ---      <- i_cfg_mode + i_ev_en
//        行4 LINK NET+UART / LINK NET           <- i_uart_en
//        行5 BAUD 115200/230400/460800/921600   <- i_baud_sel（UART 关则 BAUD ---）
//   §2.4 UART 未使能或波特率未接线 => 行4/5 显示 LINK NET / BAUD ---，不得出现 X
//        （本模块对所有可能悬空的输入统一用 === 量化，Z 一律当「无效」处理）
//
// ★ 定宽右对齐的实现（不用桶形移位、不用变量除法）：
//   每行 16 个字符格（16x8 = 128 px），行左缘 = TEXT_RIGHT - 128 = 660。
//   设 r = 15 - ci（ci = 距行左缘的字符序号）：r = 0 就是行内最右字符。
//     - 行1/3/4/5：整行内容编成 128-bit 常量串（左侧补空格补齐 16 字符），
//       直接用 l_xxx[(15-ci)*8 +: 8] 取字符 —— 天然右对齐、天然定宽。
//     - 行2 的数字位数可变（θ 1~4 位、minDl 1~3 位）：用右相对位置拼字符，
//       位数 lm/lt 只决定位置偏移，不需要移位器（见 B2 的 p_* 常量）。
//
// 复位取值：o_text_hit/o_band_hit = 0、o_text_rgb = 0（即使 KEY2 打开，复位瞬间
// 也只是「不点亮」，不会出现 X）。
// ============================================================================
module hud_status (
    input  wire        clk_lcd,
    input  wire        rst_n_lcd,
    input  wire [10:0] px_x,          // 当前扫描坐标（clk_lcd 域）
    input  wire [10:0] px_y,
    input  wire        px_de,         // 坐标有效
    input  wire        i_en,          // HUD 使能 = cfg_layer_en[2]（KEY2 面板位）
    input  wire [1:0]  i_mode_tag,    // 行1：0=R+E 1=R 2=E 其它=--
    input  wire [11:0] i_theta,       // 行2：θ 阈值
    input  wire [8:0]  i_min_dl,      // 行2：minDl
    input  wire        i_ev_en,       // 行3：事件支路总使能（EV_EN）
    input  wire [1:0]  i_cfg_mode,    // 行3：0=RAW_EV 1=RAW_ONLY 2=EV_ONLY
    input  wire        i_uart_en,     // 行4/5：UART_LINK_EN
    input  wire [1:0]  i_baud_sel,    // 行5：生效波特率档位 0..3
    output reg         o_text_hit,    // 文字命中（-> hud_stack p6_hit）
    output reg  [23:0] o_text_rgb,    // 文字颜色（-> hud_stack p6_rgb）
    output reg         o_band_hit     // 遮罩命中（-> hud_stack i_dim）
);

    // ---- 几何参数（全部可覆盖，默认值 = 契约 §2.1）-------------------------
    parameter [10:0] BAND_X0    = 11'd560;    // 遮罩左缘（含）
    parameter [10:0] BAND_X1    = 11'd792;    // 遮罩右缘（不含）
    parameter [10:0] BAND_Y0    = 11'd280;    // 遮罩上缘（含）
    parameter [10:0] BAND_Y1    = 11'd424;    // 遮罩下缘（不含）
    parameter [10:0] TEXT_RIGHT = 11'd788;    // 文字右缘（不含）= 右对齐基准
    parameter [10:0] LINE0_Y    = 11'd304;    // 首行顶部
    parameter [10:0] LINE_STEP  = 11'd20;     // 行距
    parameter [3:0]  N_LINES    = 4'd5;       // 行数
    parameter [4:0]  N_CHARS    = 5'd16;      // 每行字符数（定宽）
    parameter [23:0] FG_COLOR   = 24'hFFFFFF; // 文字颜色（白）
    parameter        PIPE       = 1;          // 输出寄存级数

    localparam [10:0] TEXT_W  = N_CHARS * 8;                        // 128 px
    localparam [10:0] TEXT_X0 = TEXT_RIGHT - TEXT_W;                // 660
    localparam [10:0] TEXT_Y1 = LINE0_Y + (N_LINES - 1) * LINE_STEP + 16;  // 400
    localparam [3:0]  LAST_IDX = N_CHARS - 5'd1;                    // 15

    // ========================================================================
    // B1 区域判决 + 屏幕/行/字符几何
    // ========================================================================
    wire in_band_x = (px_x >= BAND_X0) && (px_x < BAND_X1);
    wire in_band_y = (px_y >= BAND_Y0) && (px_y < BAND_Y1);
    wire in_band   = in_band_x & in_band_y;

    wire in_text_x = (px_x >= TEXT_X0) && (px_x < TEXT_RIGHT);
    wire in_text_y = (px_y >= LINE0_Y) && (px_y < TEXT_Y1);

    // 行号 / 行内行 / 字符格 / 字内列
    wire [10:0] dy       = px_y - LINE0_Y;                       // 仅 in_text_y 时有效
    wire [2:0]  line_sel = (dy >= 11'd80) ? 3'd4 :
                           (dy >= 11'd60) ? 3'd3 :
                           (dy >= 11'd40) ? 3'd2 :
                           (dy >= 11'd20) ? 3'd1 : 3'd0;
    // line_base = line_sel * 20 = (line_sel<<4) + (line_sel<<2)（常数乘法展开）
    wire [10:0] line_base = ({8'd0, line_sel} << 4) + ({8'd0, line_sel} << 2);
    wire [10:0] row_w = dy - line_base;                          // 0..19（>=16 为行间空隙）
    wire [3:0]  row   = row_w[3:0];
    wire        in_glyph_row = (row_w < 11'd16);

    wire [10:0] dx  = px_x - TEXT_X0;                            // 仅 in_text_x 时有效
    wire [3:0]  ci  = dx[6:3];                                   // 字符格 = 8 px
    wire [2:0]  col = dx[2:0];                                   // 字内列
    wire [3:0]  r   = LAST_IDX - ci;                             // 距行尾的字符数（0=最右）

    // ========================================================================
    // B2 行内容（5:1 选行）
    // ========================================================================
    // ---- 行1：SRC（按 i_mode_tag）------------------------------------------
    // Z 防御：i_mode_tag 悬空（z）时量化成 2'd3 -> "SRC --"
    wire [1:0]  mtag_s = (i_mode_tag === 2'b00) ? 2'd0 :
                         (i_mode_tag === 2'b01) ? 2'd1 :
                         (i_mode_tag === 2'b10) ? 2'd2 : 2'd3;
    wire [127:0] l_src = (mtag_s == 2'd0) ? {{9{8'h20}},  "SRC R+E"} :
                         (mtag_s == 2'd1) ? {{11{8'h20}}, "SRC R"}   :
                         (mtag_s == 2'd2) ? {{11{8'h20}}, "SRC E"}   :
                                            {{10{8'h20}}, "SRC --"};

    // ---- 行3：TX（= 实际回传内容；EV_EN=0 时事件支路不发 => E 消失）-------
    //   R_on = 模式含 RAW（0/1）；E_on = 模式含 EV（0/2）且 EV_EN=1
    //   行1 SRC 只用 mode_tag（EV_EN 只是输出门控，不改「源」的定义），
    //   两行的差异即「源能力」与「实际回传」的差异。
    wire [1:0]  cmode_s = (i_cfg_mode === 2'b00) ? 2'd0 :
                          (i_cfg_mode === 2'b01) ? 2'd1 :
                          (i_cfg_mode === 2'b10) ? 2'd2 : 2'd3;
    wire ev_on = (i_ev_en === 1'b1);
    wire r_on  = (cmode_s == 2'd0) || (cmode_s == 2'd1);
    wire e_on  = ((cmode_s == 2'd0) || (cmode_s == 2'd2)) && ev_on;
    wire [127:0] l_tx = (r_on &&  e_on) ? {{10{8'h20}}, "TX R+E"} :
                        (r_on && !e_on) ? {{12{8'h20}}, "TX R"}   :
                        (!r_on && e_on) ? {{12{8'h20}}, "TX E"}   :
                                          {{10{8'h20}}, "TX ---"};

    // ---- 行4：LINK（UART 使能则 NET+UART）----------------------------------
    wire uart_on = (i_uart_en === 1'b1);
    wire [127:0] l_link = uart_on ? {{3{8'h20}}, "LINK NET+UART"} :
                                   {{8{8'h20}}, "LINK NET"};

    // ---- 行5：BAUD（四档数值；UART 关/档位无效 => ---）--------------------
    wire [1:0]  bsel_s  = (i_baud_sel === 2'b00) ? 2'd0 :
                          (i_baud_sel === 2'b01) ? 2'd1 :
                          (i_baud_sel === 2'b10) ? 2'd2 : 2'd3;
    wire        bsel_ok = uart_on && ((i_baud_sel === 2'b00) || (i_baud_sel === 2'b01) ||
                                      (i_baud_sel === 2'b10) || (i_baud_sel === 2'b11));
    wire [127:0] l_baud = !bsel_ok         ? {{8{8'h20}}, "BAUD ---"}    :
                          (bsel_s == 2'd0) ? {{5{8'h20}}, "BAUD 115200"} :
                          (bsel_s == 2'd1) ? {{5{8'h20}}, "BAUD 230400"} :
                          (bsel_s == 2'd2) ? {{5{8'h20}}, "BAUD 460800"} :
                                             {{5{8'h20}}, "BAUD 921600"};

    // ---- 行2：TH <θ> DL <minDl>（右相对位置拼字符，位数自适应）------------
    // 常数除法取十进制位（综合器展开成乘加，无变量除法、无 DSP）
    function [3:0] dth0; input [11:0] v; dth0 = v % 10;          endfunction // 个位
    function [3:0] dth1; input [11:0] v; dth1 = (v / 10) % 10;   endfunction // 十位
    function [3:0] dth2; input [11:0] v; dth2 = (v / 100) % 10;  endfunction // 百位
    function [3:0] dth3; input [11:0] v; dth3 = (v / 1000) % 10; endfunction // 千位
    function [3:0] dmd0; input [8:0]  v; dmd0 = v % 10;          endfunction // 个位
    function [3:0] dmd1; input [8:0]  v; dmd1 = (v / 10) % 10;   endfunction // 十位
    function [3:0] dmd2; input [8:0]  v; dmd2 = (v / 100) % 10;  endfunction // 百位

    wire [3:0] lt = (i_theta  >= 12'd1000) ? 4'd4 :
                    (i_theta  >= 12'd100)  ? 4'd3 :
                    (i_theta  >= 12'd10)   ? 4'd2 : 4'd1;   // θ 的十进制位数
    wire [3:0] lm = (i_min_dl >= 9'd100)   ? 4'd3 :
                    (i_min_dl >= 9'd10)    ? 4'd2 : 4'd1;   // minDl 的十进制位数
    // 右相对位置（r 从 0 = 最右字符往左数）
    wire [3:0] p_sp1 = lm;                  // minDl 左侧空格（默认空格，无需显式判）
    wire [3:0] p_L   = lm + 4'd1;           // 'L'
    wire [3:0] p_D   = lm + 4'd2;           // 'D'
    wire [3:0] p_sp2 = lm + 4'd3;           // 'DL' 左侧空格
    wire [3:0] p_tlo = lm + 4'd4;           // θ 个位
    wire [3:0] p_thi = lm + 4'd3 + lt;      // θ 最高位
    wire [3:0] p_sp3 = lm + 4'd4 + lt;      // θ 左侧空格
    wire [3:0] p_H   = lm + 4'd5 + lt;      // 'H'
    wire [3:0] p_T   = lm + 4'd6 + lt;      // 'T'

    wire [3:0] ot_dig = r - p_tlo;          // θ 数字偏移（0=个位）
    wire [3:0] md_dig = (r == 4'd0) ? dmd0(i_min_dl) :
                        (r == 4'd1) ? dmd1(i_min_dl) : dmd2(i_min_dl);
    wire [3:0] th_dig = (ot_dig == 4'd0) ? dth0(i_theta) :
                        (ot_dig == 4'd1) ? dth1(i_theta) :
                        (ot_dig == 4'd2) ? dth2(i_theta) : dth3(i_theta);

    reg [7:0] c_row2;
    always @(*) begin
        c_row2 = 8'h20;                                        // 默认空格（右对齐补齐）
        if (r < lm)                          c_row2 = {4'h3, md_dig};  // minDl 数字
        else if (r == p_L)                   c_row2 = "L";
        else if (r == p_D)                   c_row2 = "D";
        else if (r >= p_tlo && r <= p_thi)   c_row2 = {4'h3, th_dig};  // θ 数字
        else if (r == p_H)                   c_row2 = "H";
        else if (r == p_T)                   c_row2 = "T";
    end

    // ---- 行选择：128-bit 常量按字符格取字节（每行 1 个 16:1 字节 mux）----
    wire [7:0] c_src  = l_src [(LAST_IDX - ci)*8 +: 8];
    wire [7:0] c_tx   = l_tx  [(LAST_IDX - ci)*8 +: 8];
    wire [7:0] c_link = l_link[(LAST_IDX - ci)*8 +: 8];
    wire [7:0] c_baud = l_baud[(LAST_IDX - ci)*8 +: 8];

    wire [7:0] cgy = (line_sel == 3'd0) ? c_src  :
                     (line_sel == 3'd1) ? c_row2 :
                     (line_sel == 3'd2) ? c_tx   :
                     (line_sel == 3'd3) ? c_link : c_baud;

    // ========================================================================
    // B3 字模查表 + 命中
    // ========================================================================
    wire [7:0] glyph;
    font_rom u_font_rom (
        .clk_lcd (clk_lcd),
        .i_char  (cgy[6:0]),
        .i_row   (row),
        .o_bits  (glyph)
    );

    wire bit_on = glyph[7 - col];                 // bit7 = 字模最左列

    wire en_s       = (i_en === 1'b1);
    wire text_hit_c = in_band & in_text_x & in_text_y & in_glyph_row & bit_on & px_de & en_s;
    wire band_hit_c = in_band & px_de & en_s;

    // ========================================================================
    // B4 输出寄存（hit 与颜色必须同拍寄存，否则颜色错开 1 拍）
    // ========================================================================
    generate
        if (PIPE == 0) begin : g_p0
            always @(*) begin
                o_text_hit = text_hit_c;
                o_text_rgb = text_hit_c ? FG_COLOR : 24'd0;
                o_band_hit = band_hit_c;
            end
        end else begin : g_pN
            always @(posedge clk_lcd) begin
                if (!rst_n_lcd) begin
                    o_text_hit <= 1'b0;
                    o_text_rgb <= 24'd0;
                    o_band_hit <= 1'b0;
                end else begin
                    o_text_hit <= text_hit_c;
                    o_text_rgb <= text_hit_c ? FG_COLOR : 24'd0;
                    o_band_hit <= band_hit_c;
                end
            end
        end
    endgenerate

endmodule

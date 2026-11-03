// ============================================================================
// lcd_scanout.v -- 800x480 DE 模式 LCD 时序发生器 + OVL 坐标基准
//
// 规格来源：docs/子模块设计/L2_显示/lcd_scanout.md（§2 端口 / §3 参数 / §6 契约）
// 硬事实  ：doc/FPGA_board/07_4.3寸RGB_LCD触摸模块/README.md §5.1
//           屏 ATK-MD0430R-800480（屏 ID 0x4384）：H 128/88/800/40 = 1056
//                                              V 2/33/480/10    = 525，像素时钟 25 MHz
//           ★ 已与厂家上板跑通的 lcd_driver.v（0x4384 参数组）逐字交叉核对一致
//
// 契约（与 hud_* / event_render 的延迟联动，见 hud_stack.md §9.2）：
//   * o_pixel_xpos / o_pixel_ypos / 基准 de 恒为「基准拍」——三者同拍有效
//   * i_pixel_data -> o_lcd_rgb565 与 o_lcd_de 一起延迟 PIPE 拍
//       PIPE = 0（默认）：o_lcd_de、坐标、o_lcd_rgb565 三者同拍（§6 契约原样）
//       PIPE = N      ：颜色通路本身有 N 拍延迟时（disp_mux/hud_inject/平面），
//                       把「引脚侧的 de」补偿 N 拍使 de 与颜色重新对齐；
//                       坐标输出**不**延迟（它是所有 OVL 平面的基准拍）
//
// HS/VS：本屏用 DE 模式，厂家 lcd_driver.v 把 lcd_hs / lcd_vs **恒拉高**
//        （原文注释「RGB LCD 采用数据输入使能信号同步时，行场同步信号需要拉高」）。
//        默认 HSVS_DE_MODE=1 复刻厂家做法；=0 时按计数器输出同步区脉冲（备选屏用）。
//
// 三态红线：本模块**不**接触 lcd_rgb（inout，开机读屏 ID，事实 H33）——
//          颜色注入在 hud_inject，三态结构在 lcd_rgb_top_ovl 里保持原样。
// ============================================================================
module lcd_scanout (
    input  wire        clk_lcd,       // 25 MHz（clk_wiz_0 的 clk_25m）
    input  wire        rst_n_lcd,     // 本域低有效同步复位
    input  wire [15:0] i_pixel_data,  // 待显示像素 RGB565（来自 hud_inject）
    output wire        o_lcd_de,      // 数据有效（DE 模式）
    output wire        o_lcd_hs,      // 行同步
    output wire        o_lcd_vs,      // 场同步
    output wire        o_lcd_pclk,    // 像素时钟（直连 clk_lcd）
    output wire [15:0] o_lcd_rgb565,  // 与 de 对齐的像素
    output wire [10:0] o_pixel_xpos,  // 当前 X 0..799（与基准 de 同拍）
    output wire [10:0] o_pixel_ypos   // 当前 Y 0..479（与基准 de 同拍）
);

    // ---- 行/场时序参数（厂家 lcd_driver.v 的 0x4384 参数组，已上板跑通）----
    parameter [10:0] H_SYNC  = 11'd128;
    parameter [10:0] H_BACK  = 11'd88;
    parameter [10:0] H_VALID = 11'd800;
    parameter [10:0] H_FRONT = 11'd40;

    parameter [10:0] V_SYNC  = 11'd2;
    parameter [10:0] V_BACK  = 11'd33;
    parameter [10:0] V_VALID = 11'd480;
    parameter [10:0] V_FRONT = 11'd10;

    parameter        PIPE        = 0;   // de / rgb565 相对基准拍的补偿级数
    parameter        HSVS_DE_MODE = 1;  // 1 = DE 模式（HS/VS 常高，厂家做法）

    localparam [11:0] H_TOTAL = H_SYNC + H_BACK + H_VALID + H_FRONT;  // 1056
    localparam [11:0] V_TOTAL = V_SYNC + V_BACK + V_VALID + V_FRONT;  //  525
    localparam [11:0] H_START = H_SYNC + H_BACK;                      //  216
    localparam [11:0] H_END   = H_START + H_VALID;                    // 1016
    localparam [11:0] V_START = V_SYNC + V_BACK;                      //   35
    localparam [11:0] V_END   = V_START + V_VALID;                    //  515

    reg [11:0] h_cnt;   // 0 .. H_TOTAL-1
    reg [11:0] v_cnt;   // 0 .. V_TOTAL-1

    // ---- B1 行/场计数器 ----------------------------------------------------
    always @(posedge clk_lcd) begin
        if (!rst_n_lcd)                       h_cnt <= 12'd0;
        else if (h_cnt == H_TOTAL - 12'd1)    h_cnt <= 12'd0;
        else                                  h_cnt <= h_cnt + 12'd1;
    end

    always @(posedge clk_lcd) begin
        if (!rst_n_lcd) v_cnt <= 12'd0;
        else if (h_cnt == H_TOTAL - 12'd1) begin
            if (v_cnt == V_TOTAL - 12'd1) v_cnt <= 12'd0;
            else                          v_cnt <= v_cnt + 12'd1;
        end
    end

    // ---- B3 DE 生成（基准拍）----------------------------------------------
    wire act = (h_cnt >= H_START) && (h_cnt < H_END) &&
               (v_cnt >= V_START) && (v_cnt < V_END);

    // ---- B4 坐标输出（与基准 de 同拍；消隐期输出 0，同厂家 pixel_xpos 口径）----
    assign o_pixel_xpos = act ? h_cnt[10:0] - H_START[10:0] : 11'd0;
    assign o_pixel_ypos = act ? v_cnt[10:0] - V_START[10:0] : 11'd0;

    // ---- 像素时钟 + B2 HS/VS ----------------------------------------------
    assign o_lcd_pclk = clk_lcd;

    generate
        if (HSVS_DE_MODE != 0) begin : g_de_mode
            // DE 模式：行场同步恒高（厂家 lcd_driver.v 原文做法）
            assign o_lcd_hs = 1'b1;
            assign o_lcd_vs = 1'b1;
        end else begin : g_sync_mode
            assign o_lcd_hs = (h_cnt < H_SYNC);
            assign o_lcd_vs = (v_cnt < V_SYNC);
        end
    endgenerate

    // ---- B5 数据对齐：de 与像素一起走 PIPE 级 -------------------------------
    generate
        if (PIPE == 0) begin : g_pipe0
            assign o_lcd_de     = act;
            assign o_lcd_rgb565 = i_pixel_data;
        end else begin : g_pipeN
            reg [PIPE-1:0]    de_p;
            reg [16*PIPE-1:0] rgb_p;
            always @(posedge clk_lcd) begin
                if (!rst_n_lcd) begin
                    de_p  <= {PIPE{1'b0}};
                    rgb_p <= {(16*PIPE){1'b0}};
                end else begin
                    // 位宽 PIPE+1 赋给 PIPE 位寄存器 ⇒ 截掉最高位 = 左移一位
                    de_p  <= {de_p,  act};
                    rgb_p <= {rgb_p, i_pixel_data};
                end
            end
            assign o_lcd_de     = de_p[PIPE-1];
            assign o_lcd_rgb565 = rgb_p[16*PIPE-1 -: 16];
        end
    endgenerate

endmodule

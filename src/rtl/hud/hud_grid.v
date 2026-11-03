// ============================================================================
// hud_grid.v -- OVL 平面 1（优先级最低）：坐标轴 + 等距网格 + 屏幕边框
//
// 规格来源：docs/子模块设计/L2_屏上UI/hud_grid.md（§2 七端口契约 / §3 参数 / §8 判据）
// 全局契约：docs/子模块设计/README.md §2 —— clk_lcd / rst_n_lcd / px_x[10:0] /
//           px_y[10:0] / px_de / ovl_en / ovl_hit / ovl_rgb[23:0]
//
// 等距判据用**常数**取模（GRID_STEP 是参数常数 ⇒ 综合为比较+加法网络，
// 不是变量除法；事实 H23 禁止的是变量除法）。
//
// 延迟：文档 §6 说本平面「纯组合、零延迟」。但 hud_stack.md §9.1 要求
//       「每个平面必须自行对齐到同一拍」——hud_event_layer 因为要读位图 BRAM
//       天然有 1 拍延迟。因此本模块默认 PIPE=1（输出寄存 1 拍），使 5 个平面
//       在 hud_stack 入口**延迟一致 = 1 拍**。需要零延迟时置 PIPE=0 并自行补偿。
// ============================================================================
module hud_grid (
    input  wire        clk_lcd,
    input  wire        rst_n_lcd,
    input  wire [10:0] px_x,       // 扫描坐标（来自 lcd_scanout）
    input  wire [10:0] px_y,
    input  wire        px_de,      // 坐标有效
    input  wire        ovl_en,     // 平面使能（RGS）
    output wire        ovl_hit,    // 命中网格/边框
    output wire [23:0] ovl_rgb     // 网格色 / 边框色
);

    parameter [10:0] GRID_STEP_X  = 11'd40;
    parameter [10:0] GRID_STEP_Y  = 11'd40;
    parameter [23:0] GRID_COLOR   = 24'h202020;   // 深灰（不抢事件点的红蓝）
    parameter [23:0] BORDER_COLOR = 24'h00A0FF;   // 亮蓝边框
    parameter [4:0]  BORDER_W     = 5'd2;         // 边框粗细
    parameter [10:0] H_VALID      = 11'd800;      // 屏宽（边框右边界）
    parameter [10:0] V_VALID      = 11'd480;      // 屏高（边框下边界）
    parameter        PIPE         = 1;            // 0 = 纯组合；1 = 寄存 1 拍（与其余平面对齐）

    // ---- B1/B2 竖线 / 横线判据（常数取模）----------------------------------
    wire [10:0] x_mod = px_x % GRID_STEP_X;
    wire [10:0] y_mod = px_y % GRID_STEP_Y;
    wire        v_line = (x_mod == 11'd0);
    wire        h_line = (y_mod == 11'd0);

    // ---- B3 四条边边框判据 -------------------------------------------------
    wire        border = (px_x < BORDER_W) ||
                         (px_x >= (H_VALID - BORDER_W)) ||
                         (px_y < BORDER_W) ||
                         (px_y >= (V_VALID - BORDER_W));

    // ---- B4/B5 命中合并 + 颜色（边框优先于网格线）--------------------------
    wire        hit_c = px_de & ovl_en & (v_line | h_line | border);
    wire [23:0] rgb_c = border ? BORDER_COLOR : GRID_COLOR;

    // ★ 命中与颜色必须一起寄存：只寄存 hit 而让 rgb 走组合，会让"命中信号"与
    //   "颜色"错开 1 拍（边界处取到相邻像素的颜色）——TB 实测 err_rgb=487。
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
                    rgb_r <= GRID_COLOR;
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

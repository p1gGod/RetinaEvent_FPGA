// ============================================================================
// hud_stack.v -- OVL 平面仲裁器（多平面 -> 单平面）
//
// 规格来源：docs/子模块设计/L2_屏上UI/hud_stack.md（§2 端口 / §3 参数 / §4 优先级链）
//
// ★ 本模块是**纯仲裁器**：平面由 L3 `display_path` 例化，平面各自的
//   ovl_en/ovl_hit/ovl_rgb 作为输入送进来（doc §5「上游 = 5 个 OVL 平面」）。
//
// 优先级（数字大 = 更靠上；后写的覆盖先写的）：
//   p1 hud_grid(1) < p2 hud_event_layer(2) < p3 hud_panel(3) < p4 hud_text(4)
//   < p5 hud_sprite(5) < 遮罩(6) < p6 hud_status 文字(7)
//
// ★ WIRE-U3（2026-10-17，接口约定 §2.3）：新增**平面 6 = hud_status**（参数 HUD）
//   与其专用的半透明遮罩通道。遮罩不是普通平面：它不出颜色，只出 o_dim 一根
//   线，由 hud_inject 把背景色压暗（bg>>1），因此：
//     - 遮罩命中时把 o_hit 清 0（下层平面被遮罩「盖掉」，不参与最终颜色）；
//     - p6 文字命中优先级最高，文字处必须 o_hit=1/o_dim=0（白字，不压暗）。
//   p6/dim 两条通路都包在 `(N_PLANES > 5)` 常量条件里：旧例化（默认 5）不改
//   端口就能编译，且常量条件会被综合器完全剪掉，逐像素行为与改动前等价。
//
// 二值覆盖（不做 alpha、不引入乘法器，§9.3）：命中即整体替换颜色。
// o_hit 还要与 px_de 相与（§8 V3：px_de=0 时 o_hit 必须为 0），
// 并用 px_x/px_y 做一次屏幕范围自查（消隐期坐标是 0，不会误命中）。
// ============================================================================
module hud_stack (
    input  wire        clk_lcd,
    input  wire        rst_n_lcd,
    input  wire [10:0] px_x,       // 当前扫描坐标（来自 lcd_scanout）
    input  wire [10:0] px_y,
    input  wire        px_de,      // 坐标有效

    input  wire        p1_en,      // 平面 1：hud_grid（最低）
    input  wire        p1_hit,
    input  wire [23:0] p1_rgb,

    input  wire        p2_en,      // 平面 2：hud_event_layer
    input  wire        p2_hit,
    input  wire [23:0] p2_rgb,

    input  wire        p3_en,      // 平面 3：hud_panel
    input  wire        p3_hit,
    input  wire [23:0] p3_rgb,

    input  wire        p4_en,      // 平面 4：hud_text
    input  wire        p4_hit,
    input  wire [23:0] p4_rgb,

    input  wire        p5_en,      // 平面 5：hud_sprite
    input  wire        p5_hit,
    input  wire [23:0] p5_rgb,

    input  wire        p6_en,      // 平面 6：hud_status 文字（最高，★ HUD）
    input  wire        p6_hit,
    input  wire [23:0] p6_rgb,
    input  wire        i_dim,      // ★ HUD 半透明遮罩命中（hud_status.o_band_hit）

    output wire        o_hit,      // 是否有平面覆盖该像素
    output wire [23:0] o_rgb,      // 覆盖颜色 RGB888
    output wire        o_dim       // 是否压暗该像素（-> hud_inject.i_dim）
);

    parameter N_PLANES = 5;              // 参与仲裁的平面数（1~6；=6 才启用 p6/dim）
    parameter PIPE     = 1;              // 输出寄存级数（与 hud_inject 一起核算）
    parameter [10:0] H_VALID = 11'd800;
    parameter [10:0] V_VALID = 11'd480;

    // ---- B1/B2 优先级链：从低到高逐级「命中则覆盖」--------------------------
    // ★ p6/dim 的所有输入都做 z 量化：旧 TB 只接 p1..p5，这两组端口悬空是 z，
    //   不量化的话 `z & 1` = z 会顺着 hit_c 污染 o_hit（X 传播到 LCD 输出）。
    wire p6_en_s  = (N_PLANES > 5) && (p6_en  === 1'b1);
    wire p6_hit_s = (N_PLANES > 5) && (p6_hit === 1'b1);
    wire dim_s    = (N_PLANES > 5) && (i_dim   === 1'b1);

    reg        hit_c;
    reg        dim_c;
    reg [23:0] rgb_c;
    always @(*) begin
        hit_c = 1'b0;
        dim_c = 1'b0;
        rgb_c = 24'd0;
        if ((N_PLANES > 0) && p1_en && p1_hit) begin hit_c = 1'b1; rgb_c = p1_rgb; end
        if ((N_PLANES > 1) && p2_en && p2_hit) begin hit_c = 1'b1; rgb_c = p2_rgb; end
        if ((N_PLANES > 2) && p3_en && p3_hit) begin hit_c = 1'b1; rgb_c = p3_rgb; end
        if ((N_PLANES > 3) && p4_en && p4_hit) begin hit_c = 1'b1; rgb_c = p4_rgb; end
        if ((N_PLANES > 4) && p5_en && p5_hit) begin hit_c = 1'b1; rgb_c = p5_rgb; end
        // 遮罩：压暗「背景」，下层平面让位（o_hit=0 交给 hud_inject 做 bg>>1）
        if (dim_s) begin hit_c = 1'b0; dim_c = 1'b1; rgb_c = 24'd0; end
        // 平面 6：HUD 文字，最高优先级；文字处不压暗（o_dim=0）
        if (p6_en_s && p6_hit_s) begin hit_c = 1'b1; dim_c = 1'b0; rgb_c = p6_rgb; end
    end

    // ---- B3 有效门控 -------------------------------------------------------
    wire in_frame = (px_x < H_VALID) && (px_y < V_VALID);
    wire hit_g    = px_de & in_frame & hit_c;
    wire dim_g    = px_de & in_frame & dim_c;

    // ---- B4 输出寄存 -------------------------------------------------------
    generate
        if (PIPE == 0) begin : g_p0
            assign o_hit = hit_g;
            assign o_rgb = rgb_c;
            assign o_dim = dim_g;
        end else begin : g_pN
            reg [PIPE-1:0]    hit_p;
            reg [PIPE-1:0]    dim_p;
            reg [24*PIPE-1:0] rgb_p;
            always @(posedge clk_lcd) begin
                if (!rst_n_lcd) begin
                    hit_p <= {PIPE{1'b0}};
                    dim_p <= {PIPE{1'b0}};
                    rgb_p <= {(24*PIPE){1'b0}};
                end else begin
                    // 位宽 +1 赋给 PIPE 位寄存器 ⇒ 左移一位
                    hit_p <= {hit_p, hit_g};
                    dim_p <= {dim_p, dim_g};
                    rgb_p <= {rgb_p, rgb_c};
                end
            end
            assign o_hit = hit_p[PIPE-1];
            assign o_rgb = rgb_p[24*PIPE-1 -: 24];
            assign o_dim = dim_p[PIPE-1];
        end
    endgenerate

endmodule

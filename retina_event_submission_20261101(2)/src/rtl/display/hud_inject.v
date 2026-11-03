// ============================================================================
// hud_inject.v -- 在 LCD 输出的「颜色」一级注入叠加层（OVL 消费方）
//
// 规格来源：docs/子模块设计/L2_显示/hud_inject.md（§2 端口 / §3 参数 / §4 结构）
//
// ★★ 三态红线（事实 H33 / skill 陷阱 12）★★
//   真正的引脚三态在 lcd_rgb_top_ovl.v 里：
//       assign lcd_rgb = lcd_de ? final_color : {24{1'bz}};
//   本模块**只负责算出 final_color 这一项**，绝不接触 lcd_rgb / lcd_de 的
//   三态结构，也不参与 rd_id 的开机读屏 ID 动作。三态判断一个字都不能动。
//
// 数据流：i_bg_rgb565（disp_mux 选中背景）--565->888--> 与 i_ovl_rgb 二选一
//         hit=1 -> 叠加色；hit=0 -> 背景色          （二值覆盖，无 alpha、无乘法）
//
// ★ WIRE-U3（2026-10-17，接口约定 §2.3）：新增 i_dim（HUD 半透明遮罩命中）。
//   三级 mux：hit ? 叠加色 : (dim ? bg>>1 : bg)
//   半透明 = 每通道算术右移 1 位（丢最低位），等效 50% 压暗，不引入乘法器/alpha
//   通道。i_dim 悬空（z）一律量化成 0 ⇒ 与改动前逐像素等价（旧 TB 不必改端口）。
//   注意 dim 与颜色必须走同一组 PIPE 寄存器（只寄存 hit 会让颜色错开 1 拍）。
//
// de：原样透传（不参与叠加判决），但走同一组 PIPE 寄存器，保证 de 与颜色同拍。
//     PIPE=0 时就是字面意义的 assign 透传。
// ============================================================================
module hud_inject (
    input  wire        clk_lcd,
    input  wire        rst_n_lcd,
    input  wire [15:0] i_bg_rgb565,   // 背景（来自 disp_mux）
    input  wire        i_bg_de,
    input  wire        i_ovl_hit,     // 叠加层（来自 hud_stack）
    input  wire [23:0] i_ovl_rgb,
    input  wire        i_dim,         // ★ HUD 半透明遮罩（来自 hud_stack.o_dim）
    output wire [23:0] o_rgb888,      // 最终颜色 -> lcd_rgb_top_ovl 的三态逻辑
    output wire        o_de
);

    parameter PIPE = 1;               // 输出寄存级数 0~3

    // ---- B1 565 -> 888：位复制法（厂家 lcd_rgb_top.v 写法）-----------------
    //   R[4:0] -> 8bit = {R[4:0], R[4:2]}
    //   G[5:0] -> 8bit = {G[5:0], G[5:4]}
    //   B[4:0] -> 8bit = {B[4:0], B[4:2]}
    wire [23:0] bg888 = {i_bg_rgb565[15:11], i_bg_rgb565[13:11],
                         i_bg_rgb565[10:5],  i_bg_rgb565[9:8],
                         i_bg_rgb565[4:0],   i_bg_rgb565[2:0]};

    // ---- B2 叠加判决（二值覆盖 + 遮罩压暗）--------------------------------
    // 每通道 >>1：丢最低位即 50% 压暗（8bit -> {1'b0, v[7:1]}，无乘法器）
    wire [23:0] bg_dim = {1'b0, bg888[23:17], 1'b0, bg888[15:9], 1'b0, bg888[7:1]};
    wire        dim_s  = (i_dim === 1'b1);          // z/x 一律当「不压暗」
    wire [23:0] rgb_c  = i_ovl_hit ? i_ovl_rgb : (dim_s ? bg_dim : bg888);
    wire        de_c   = i_bg_de;

    // ---- B3/B4 延迟对齐 + 输出 --------------------------------------------
    generate
        if (PIPE == 0) begin : g_p0
            assign o_rgb888 = rgb_c;
            assign o_de     = de_c;
        end else begin : g_pN
            reg [PIPE-1:0]    de_p;
            reg [24*PIPE-1:0] rgb_p;
            always @(posedge clk_lcd) begin
                if (!rst_n_lcd) begin
                    de_p  <= {PIPE{1'b0}};
                    rgb_p <= {(24*PIPE){1'b0}};
                end else begin
                    // 位宽 +1 赋给 PIPE 位寄存器 ⇒ 左移一位
                    de_p  <= {de_p,  de_c};
                    rgb_p <= {rgb_p, rgb_c};
                end
            end
            assign o_de     = de_p[PIPE-1];
            assign o_rgb888 = rgb_p[24*PIPE-1 -: 24];
        end
    endgenerate

endmodule

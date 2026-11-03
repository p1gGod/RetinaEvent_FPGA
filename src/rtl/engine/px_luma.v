//==============================================================================
// px_luma -- RGB565 → 8bit 亮度 Y（L2 事件引擎）
//
// 规格：retina_event/docs/子模块设计/L2_事件引擎/px_luma.md §2/§3/§4/§6
//   Y = (COEF_R·R8 + COEF_G·G8 + COEF_B·B8) >> 8，系数默认 77/150/29（和 = 256）
//   与厂家 rgb2ycbcr.v 一致（实测核对过）
//
// ⚠️ §9.1：RGB565→8bit 用**位复制**（{r,r[4:2]}），不是左移补 0（左移会明显变暗）
// ⚠️ §9.3：控制信号必须与数据**同拍**（固定 1 拍延迟），差一拍会让下游行缓存整体错位
//
// USE_DSP 参数分支：1 = 允许推断 DSP48（(* use_dsp = "yes" *)）；
//                   0 = 强制 LUT 实现（(* use_dsp = "no" *)）。
//                   ModelSim 忽略综合属性，两条分支**功能 bit-exact 相同**。
//==============================================================================
`timescale 1ns / 1ps

module px_luma #(
    parameter COEF_R  = 77,         // 灰度系数（和必须 = 256，>>8 才是不溢出归一化）
    parameter COEF_G  = 150,
    parameter COEF_B  = 29,
    parameter USE_DSP = 1           // 1 = 允许 DSP48；0 = 强制 LUT
)(
    input  wire        clk_cam,
    input  wire        rst_n_cam,
    input  wire        i_vsync,
    input  wire        i_de,
    input  wire [15:0] i_data,      // RGB565 {R[4:0], G[5:0], B[4:0]}
    output reg         o_vsync,
    output reg         o_de,
    output reg  [7:0]  o_y          // 亮度 Y
);

    //--------------------------------------------------------------------------
    // B1：RGB565 → RGB888 位扩展（位复制，非左移补 0）
    //   ⚠️ 与厂家 rgb2ycbcr.v 逐字一致（已核对
    //      doc/FPGA_board/05_参考代码/.../53_ov5640_lcd_yuv/rtl/rgb2ycbcr.v 第 66~68 行）：
    //          rgb888_r = {img_red  , img_red[4:2]  } = {i_data[15:11], i_data[15:13]}
    //          rgb888_g = {img_green, img_green[5:4]} = {i_data[10: 5], i_data[10: 9]}
    //          rgb888_b = {img_blue , img_blue[4:2] } = {i_data[ 4: 0], i_data[ 4: 2]}
    //      px_luma.md §4 写的 {i_data[15:11], i_data[13:12]}（仅 7 bit）与
    //      {i_data[10:5], i_data[6:5]} 是**文档笔误**：前者会让白色只到 202，
    //      后者取错了 G 的复制位。本模块按厂家源码实现（已列入交付报告偏离说明）。
    //--------------------------------------------------------------------------
    wire [7:0] r8 = {i_data[15:11], i_data[15:13]};
    wire [7:0] g8 = {i_data[10: 5], i_data[10: 9]};
    wire [7:0] b8 = {i_data[ 4: 0], i_data[ 4: 2]};

    //--------------------------------------------------------------------------
    // B2/B3：三路常数乘 + 加法 + >>8（常数乘 ⇒ 无变量除法，事实 H23）
    //   系数和 = 256 ⇒ 最大 256×255 = 65280 < 2^16，16 bit 足够
    //--------------------------------------------------------------------------
    wire [15:0] sum;

    generate
        if (USE_DSP != 0) begin : g_dsp
            (* use_dsp = "yes" *) wire [15:0] sum_i =
                COEF_R * r8 + COEF_G * g8 + COEF_B * b8;
            assign sum = sum_i;
        end else begin : g_lut
            (* use_dsp = "no" *) wire [15:0] sum_i =
                COEF_R * r8 + COEF_G * g8 + COEF_B * b8;
            assign sum = sum_i;
        end
    endgenerate

    //--------------------------------------------------------------------------
    // B4：控制打拍（固定 1 拍，与数据同拍）
    //--------------------------------------------------------------------------
    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            o_vsync <= 1'b0;
            o_de    <= 1'b0;
            o_y     <= 8'h00;
        end else begin
            o_vsync <= i_vsync;
            o_de    <= i_de;
            o_y     <= sum[15:8];
        end
    end

endmodule

//==============================================================================
// ov5640_timing_ovr -- OV5640 扫描时序覆盖层（参数化旁路开关）
//
// 作用：插在 picture_size 与 ov5640_dri 之间，**只覆盖**
//       total_h_pixel / total_v_pixel 两条 13bit 网线，用于抬高 OV5640 帧率。
//       其余端口/逻辑一概不碰。
//
// 判据（默认构建行为必须与改动前完全一致）：
//       OVL_EN = 0（默认）⇒ generate 直连 i_* → o_*，纯旁路，综合结果等同一根线。
//       OVL_EN = 1        ⇒ 用扫描点常量覆盖（受 clk 同步、rst_n 异步复位清零）。
//
// 扫描点（lead 已定，HTS=total_h_pixel, VTS=total_v_pixel）：
//       SCAN_SEL=1 → A = (1800, 750)
//       SCAN_SEL=2 → B = (1800, 600)
//       SCAN_SEL=3 → C = (1800, 520)
//       SCAN_SEL=0 → 直用 OVL_HTS / OVL_VTS generic（默认 1800/750 = A）
//       D=(1600,500) 本方案不做：HTS=1600 < 内部水平窗宽 2624，很可能非法。
//       ⚠️ 曝光上限（0x3a02/03/14/15=5904）本步不改：先实测 A/B/C 的 fps 与亮度，
//          若帧率不升或变暗，再由下一步做 I2C 补写。
//
// 位宽：13 位（对齐 display_path.v:140 的 wire [12:0] 与
//       i2c_ov5640_rgb565_cfg.v:351-357 的 13bit 常量写法）。
//
// 规格：retina_event/docs/05_experiments/帧率实验设计_20261007/3_覆盖层实现.md
//==============================================================================
`timescale 1ns / 1ps

module ov5640_timing_ovr #(
    parameter OVL_EN   = 0,          // 0=纯旁路（默认，位流不变）; 1=覆盖
    parameter SCAN_SEL = 0,          // 0=用 OVL_HTS/OVL_VTS; 1=A; 2=B; 3=C
    parameter [12:0] OVL_HTS = 13'd1800,
    parameter [12:0] OVL_VTS = 13'd750
)(
    input  wire         clk,
    input  wire         rst_n,
    input  wire [12:0]  i_hts,       // 来自 picture_size.total_h_pixel
    input  wire [12:0]  i_vts,       // 来自 picture_size.total_v_pixel
    input  wire         i_ovl_en,    // 运行期使能（默认由顶层接 OVL_EN 恒值）
    output wire [12:0]  o_hts,       // 送 ov5640_dri.total_h_pixel
    output wire [12:0]  o_vts        // 送 ov5640_dri.total_v_pixel
);

    // ---- 扫描点查表（综合期常量）----
    function [12:0] scan_hts(input integer sel);
        case (sel)
            1:       scan_hts = 13'd1800;   // A
            2:       scan_hts = 13'd1800;   // B
            3:       scan_hts = 13'd1800;   // C
            default: scan_hts = OVL_HTS;
        endcase
    endfunction

    function [12:0] scan_vts(input integer sel);
        case (sel)
            1:       scan_vts = 13'd750;    // A
            2:       scan_vts = 13'd600;    // B
            3:       scan_vts = 13'd520;    // C
            default: scan_vts = OVL_VTS;
        endcase
    endfunction

    localparam [12:0] HTS_CONST = scan_hts(SCAN_SEL);
    localparam [12:0] VTS_CONST = scan_vts(SCAN_SEL);

    generate
    // ----------------------------------------------------------------------
    // OVL_EN=0：纯旁路。不实例化任何寄存器，综合后等同 wire。
    // ----------------------------------------------------------------------
    if (OVL_EN == 0) begin : g_bypass
        assign o_hts = i_hts;
        assign o_vts = i_vts;
    end
    // ----------------------------------------------------------------------
    // OVL_EN=1：覆盖。使能经 clk 同步、rst_n 异步清零 ⇒ 复位期间自动回到旁路。
    //         数据通路**组合**输出，避免给 picture_size→ov5640_dri 增加延迟。
    // ----------------------------------------------------------------------
    else begin : g_override
        reg en_r;
        always @(posedge clk or negedge rst_n) begin
            if (!rst_n) en_r <= 1'b0;
            else        en_r <= i_ovl_en;
        end

        assign o_hts = en_r ? HTS_CONST : i_hts;
        assign o_vts = en_r ? VTS_CONST : i_vts;
    end
    endgenerate

endmodule

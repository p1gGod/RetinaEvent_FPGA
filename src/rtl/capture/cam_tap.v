//==============================================================================
// cam_tap -- OV5640 DVP 只读并联抓取 + 8bit→16bit(RGB565) 组包（L2 采集）
//
// 规格：retina_event/docs/子模块设计/L2_采集/cam_tap.md
//   §2 端口表逐字实现；§3 参数；§4 组包逻辑与厂家 cmos_capture_data.v 一致
//
// 事实依据：
//   H42  cam_data[7:0] 上 **每 2 个 cam_pclk 才是一个像素**（800×480 RGB565）
//   H41  行宽确定 = 800（不做自适应）
//   H30  与厂家显示通路【并联 tap】，本模块**只读、绝不驱动任何 cam_* 引脚**
//
// 与文档的两处工程性细化（已在交付报告里声明）：
//   1) §4 B5 说用 edge_detect 检测 vsync/href 沿。本模块在 cam_pclk 域内**内联**
//      1 拍寄存 + 沿比较（语义与 edge_detect 完全一致），以免 P0 模块依赖 P1 原语。
//   2) §4 B4 写作 o_px_valid = href & byte_flag_d0。若带 href 门控，每行**最后一个像素**
//      （第 1600 个字节所在拍打包、下一拍才出 valid）会在 href 已拉低时被吞掉，
//      导致一帧只有 800×480−480 个脉冲，违反 §8 V3 的"一帧计数 = 800×480"。
//      故 o_px_valid 取**寄存后的 byte_flag**（不含 href 门控），保证每行 800 个脉冲。
//
// 组包时序（byte_flag 每拍翻转 ⇒ 2 拍/像素；高字节先到）：
//   拍 c1(c1=行内第1个字节): byte_flag=0 → 不打包, byte_flag<=1
//   拍 c2(第2个字节)        : byte_flag=1 → px<={data_d0,data}, o_px_valid 于 c3 置 1
//   拍 c3(第3个字节)        : byte_flag=0 → 不打包（c3 的 valid 对应 c2 的像素）
//   ... 每行 1600 字节 ⇒ 800 个 valid 脉冲
//==============================================================================
`timescale 1ns / 1ps

module cam_tap #(
    parameter MSB_FIRST      = 1,   // 1 = RGB565 高字节先到（与 OV5640 一致）
    parameter SAMPLE_ON_FALL = 0    // 1 = 在 cam_pclk 下降沿采样（默认上升沿，与厂家一致）
)(
    input  wire        cam_pclk,
    input  wire        rst_n_pclk,      // 由 rst_n_cam 经 sync_ff 同步到 cam_pclk 域
    input  wire [7:0]  i_cam_data,      // DVP 数据（引脚，只读）
    input  wire        i_cam_vsync,     // 场同步（引脚，只读）
    input  wire        i_cam_href,      // 行有效（引脚，只读）
    output wire        o_px_valid,      // 1 拍/像素（每 2 个 cam_pclk 一次）
    output wire [15:0] o_px_data,       // RGB565
    output wire        o_frame_start,   // vsync 上升沿 → 1 拍
    output wire        o_line_start     // href  上升沿 → 1 拍
);

    //--------------------------------------------------------------------------
    // 采样沿选择（B1 的等效实现）
    //   SAMPLE_ON_FALL=1 时先在下降沿把总线取进寄存器，再统一在上升沿处理。
    //   对"下降沿之后才变化的 DVP 总线"两种取法等价；默认 0 时不额外消耗 FF。
    //--------------------------------------------------------------------------
    wire [7:0] src_data;
    wire       src_vsync;
    wire       src_href;

    generate
        if (SAMPLE_ON_FALL != 0) begin : g_fall
            reg [7:0] d_f;
            reg       v_f;
            reg       h_f;
            always @(negedge cam_pclk) begin
                if (!rst_n_pclk) begin
                    d_f <= 8'h00;
                    v_f <= 1'b0;
                    h_f <= 1'b0;
                end else begin
                    d_f <= i_cam_data;
                    v_f <= i_cam_vsync;
                    h_f <= i_cam_href;
                end
            end
            assign src_data  = d_f;
            assign src_vsync = v_f;
            assign src_href  = h_f;
        end else begin : g_rise
            assign src_data  = i_cam_data;
            assign src_vsync = i_cam_vsync;
            assign src_href  = i_cam_href;
        end
    endgenerate

    //--------------------------------------------------------------------------
    // B1~B4：字节标志 + 组包 + 像素使能
    //--------------------------------------------------------------------------
    reg        byte_flag;
    reg [7:0]  data_d0;
    reg [15:0] px_r;
    reg        px_valid_r;

    // B5：帧/行起始（内联 1 拍沿检测）
    reg        vsync_d1;
    reg        href_d1;

    always @(posedge cam_pclk) begin
        if (!rst_n_pclk) begin
            byte_flag  <= 1'b0;
            data_d0    <= 8'h00;
            px_r       <= 16'h0000;
            px_valid_r <= 1'b0;
            vsync_d1   <= 1'b0;
            href_d1    <= 1'b0;
        end else begin
            vsync_d1 <= src_vsync;
            href_d1  <= src_href;

            if (src_href) begin
                byte_flag  <= ~byte_flag;               // B2：每拍翻转
                data_d0    <= src_data;                 // B1：稳定采样
                if (byte_flag) begin                    // B3：两个字节拼一个像素
                    px_valid_r <= 1'b1;
                    if (MSB_FIRST != 0) px_r <= {data_d0, src_data};
                    else                px_r <= {src_data, data_d0};
                end else begin
                    px_valid_r <= 1'b0;
                end
            end else begin
                byte_flag  <= 1'b0;                     // 行间复位字节相位
                px_valid_r <= 1'b0;
            end
        end
    end

    // B4：像素使能（= 寄存后的 byte_flag，每 2 拍一次）
    assign o_px_valid  = px_valid_r;
    assign o_px_data   = px_r;

    // B5：帧/行起始脉冲
    assign o_frame_start = src_vsync & ~vsync_d1;
    assign o_line_start  = src_href  & ~href_d1;

endmodule

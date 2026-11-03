//==============================================================================
// edge_detect -- 本域上升/下降沿检测（L1 基础原语，无业务语义）
//
// 规格：retina_event/docs/子模块设计/L1_基础原语/edge_detect.md
//   - 打 1 拍寄存 + 比较前后值，输出**恰好 1 拍宽**的脉冲
//   - ❌ 不做跨域边沿检测：异步输入必须先经 sync_ff 同步
//   - ⚠️ RST_LEVEL 要与信号的实际复位电平一致，否则上电会出现一次假沿
//      （本板按键低有效、复位期间为 1 ⇒ RST_LEVEL 必须给 1）
//==============================================================================
`timescale 1ns / 1ps

module edge_detect #(
    parameter RST_LEVEL = 1     // 复位期间 i_sig 的假定电平（0/1）
)(
    input  wire clk,
    input  wire rst_n,
    input  wire i_sig,
    output wire o_rise,
    output wire o_fall,
    output wire o_any
);

    reg sig_d1;

    // B3: 复位时把 sig_d1 置为 RST_LEVEL，避免上电假沿
    always @(posedge clk) begin
        if (!rst_n) sig_d1 <= RST_LEVEL;
        else        sig_d1 <= i_sig;
    end

    // B2: 沿比较
    assign o_rise =  i_sig & ~sig_d1;
    assign o_fall = ~i_sig &  sig_d1;
    assign o_any  =  i_sig ^  sig_d1;

endmodule

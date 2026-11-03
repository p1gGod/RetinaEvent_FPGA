//==============================================================================
// delay_pipe -- 参数化延迟对齐（L1 基础原语，无业务语义）
//
// 规格：retina_event/docs/子模块设计/L1_基础原语/delay_pipe.md
//   - 纯寄存器打拍链，LATENCY 可配；LATENCY=0 时为纯组合直通
//   - ⚠️ 对齐是"延迟控制信号"而不是"延迟数据"：de/vsync 必须与数据走同样的延迟
//   - ⚠️ LATENCY 改了要同步检查所有例化点，否则会引入 ±1 拍错位
//==============================================================================
`timescale 1ns / 1ps

module delay_pipe #(
    parameter WIDTH   = 1,  // 1~64
    parameter LATENCY = 1   // 0~32（0 = 直通，不产生寄存器）
)(
    input  wire             clk,
    input  wire             rst_n,
    input  wire [WIDTH-1:0] i_data,
    output wire [WIDTH-1:0] o_data
);

    generate
        if (LATENCY == 0) begin : g_pass
            // B1: 零延迟直通
            assign o_data = i_data;
        end else begin : g_delay
            // B2: 移位链
            reg [WIDTH-1:0] pipe [0:LATENCY-1];
            integer k;

            always @(posedge clk) begin
                if (!rst_n) begin
                    for (k = 0; k < LATENCY; k = k + 1)
                        pipe[k] <= {WIDTH{1'b0}};
                end else begin
                    pipe[0] <= i_data;
                    for (k = 1; k < LATENCY; k = k + 1)
                        pipe[k] <= pipe[k-1];
                end
            end

            assign o_data = pipe[LATENCY-1];
        end
    endgenerate

endmodule

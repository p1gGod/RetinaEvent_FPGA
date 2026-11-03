//==============================================================================
// sync_ff -- 通用 CDC 同步器（L1 基础原语，无业务语义）
//
// 规格：retina_event/docs/子模块设计/L1_基础原语/sync_ff.md
//   - STAGES 级触发器串，把源域信号安全采到目标域
//   - 只保证"最终稳定"，不保证过渡期无毛刺
//   - ❌ 禁止用本模块传快变数据总线（那必须走 axis_fifo）
//   - ❌ 本模块不含异步复位同步器（那是 clk_rst_gen 的职责）
//
// 时钟/复位约定（README §2.4）：dest_rst_n 是 dest_clk 域的**同步**复位。
//==============================================================================
`timescale 1ns / 1ps

module sync_ff #(
    parameter WIDTH  = 1,   // 1~32
    parameter STAGES = 2    // 2~4
)(
    input  wire             dest_clk,
    input  wire             dest_rst_n,
    input  wire [WIDTH-1:0] i_src,
    output wire [WIDTH-1:0] o_dst
);

    // B3: ASYNC_REG 让 Vivado 把同步链布局到相邻 slice，缩短 MTBF 相关路径
    (* ASYNC_REG = "TRUE" *) reg [WIDTH-1:0] sync_q [0:STAGES-1];

    integer k;

    always @(posedge dest_clk) begin
        if (!dest_rst_n) begin
            for (k = 0; k < STAGES; k = k + 1)
                sync_q[k] <= {WIDTH{1'b0}};
        end else begin
            sync_q[0] <= i_src;
            for (k = 1; k < STAGES; k = k + 1)
                sync_q[k] <= sync_q[k-1];
        end
    end

    // B2: 输出取末级
    assign o_dst = sync_q[STAGES-1];

endmodule

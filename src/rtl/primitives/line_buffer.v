//==============================================================================
// line_buffer -- 参数化单行缓存（L1 基础原语，无业务语义）
//
// 规格：retina_event/docs/子模块设计/L1_基础原语/line_buffer.md
//   - 单端口写 + 单端口读的环形行缓存，容量 = 一行像素数
//   - **读延迟固定 1 拍**（B3）；对齐时别忘了
//   - ⚠️ IMG_W 必须与实际行宽一致，写错 = 整幅图错位（事实 H20）
//   - ⚠️ 边界：首行读到的是初值 0 ⇒ spatial_lap 的"边界补 0"语义天然成立
//
// 读优先语义（关键）：
//   使用方式是"边写本行、边读同址取上一行"，写指针与读地址在锁步时**完全重合**。
//   因此本模块必须是 **READ_FIRST**（先读旧值再写新值）：
//       o_rd_data <= mem[i_rd_addr];        // 读到的是旧内容
//       if (i_wr_en) mem[wr_ptr] <= i_wr_data;
//   Verilog 非阻塞赋值的"右侧取旧值"语义天然给出 READ_FIRST，两条语句顺序无关。
//
// 行内指针：文档 B4 说"行起始时 wr_ptr <= 0"，但本模块**没有行起始端口**（端口表冻结），
//   故按 IMG_W 自动回绕：写满一行自动归零，等价于每行起始复位。
//==============================================================================
`timescale 1ns / 1ps

module line_buffer #(
    parameter IMG_W    = 400,       // 一行像素数（必须与实际行宽一致）
    parameter DATA_W   = 8,         // 1~16
    parameter ADDR_W   = 9,         // 默认按 IMG_W=400 取 9；换行宽时同步改
    parameter USE_BRAM = 1          // 1 = 强制 BRAM；0 = 强制 LUTRAM/SRL
)(
    input  wire                clk,
    input  wire                rst_n,
    input  wire                i_wr_en,
    input  wire [DATA_W-1:0]   i_wr_data,
    input  wire [ADDR_W-1:0]   i_rd_addr,
    output reg  [DATA_W-1:0]   o_rd_data
);

    localparam [ADDR_W-1:0] WRAP = IMG_W - 1;

    reg [ADDR_W-1:0] wr_ptr;

    // B4: 行内写指针，写满一行自动回绕（= 行起始复位）
    always @(posedge clk) begin
        if (!rst_n) begin
            wr_ptr <= {ADDR_W{1'b0}};
        end else if (i_wr_en) begin
            if (wr_ptr == WRAP) wr_ptr <= {ADDR_W{1'b0}};
            else                wr_ptr <= wr_ptr + 1'b1;
        end
    end

    // B1/B2/B3: 存储体 + 写口 + 读口（READ_FIRST）
    generate
        if (USE_BRAM) begin : g_bram
            (* ram_style = "block" *) reg [DATA_W-1:0] mem [0:IMG_W-1];
            integer k;
            // 仿真初值：不引入复位逻辑（否则 BRAM 无法推断），综合按 BRAM 初始化处理
            initial begin
                for (k = 0; k < IMG_W; k = k + 1) mem[k] = {DATA_W{1'b0}};
            end
            always @(posedge clk) begin
                o_rd_data <= mem[i_rd_addr];            // READ_FIRST
                if (i_wr_en) mem[wr_ptr] <= i_wr_data;
            end
        end else begin : g_lut
            (* ram_style = "distributed" *) reg [DATA_W-1:0] mem [0:IMG_W-1];
            integer k;
            initial begin
                for (k = 0; k < IMG_W; k = k + 1) mem[k] = {DATA_W{1'b0}};
            end
            always @(posedge clk) begin
                o_rd_data <= mem[i_rd_addr];            // READ_FIRST
                if (i_wr_en) mem[wr_ptr] <= i_wr_data;
            end
        end
    endgenerate

endmodule

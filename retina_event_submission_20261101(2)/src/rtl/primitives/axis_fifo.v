//==============================================================================
// axis_fifo -- 异步 FIFO（L1 基础原语，CDC 通道 CDC-0 / CDC-3）
//
// 规格：retina_event/docs/子模块设计/L1_基础原语/axis_fifo.md
//   - 跨异步时钟域传递快变数据流（像素/事件），提供空满保护
//   - 写侧按 i_wr_en 收数据；FWFT=1 时 o_rd_data 在 o_empty=0 时即有效，
//     读使能与数据**同拍**（读延迟 0）
//   - 深度必须为 2 的幂
//
// 实现说明（两条路径，默认走纯 RTL）：
//   USE_XPM=0（默认）：纯 RTL 格雷码指针异步 FIFO，**不依赖任何未生成的 IP**，
//     因此单模块仿真可独立跑通。存储体用"寄存器读"写法，综合会推断为 BRAM
//     （2048x16 ⇒ 1 块 BRAM36，与文档 §7 一致）。
//   USE_XPM=1：例化 Xilinx XPM 原语 xpm_fifo_async（正式构建可选，仿真需 xpm 库）。
//
// 读侧实现要点（FWFT 为什么能零延迟）：
//   前视读——本拍就把"下一拍该出的那个字"预取进输出寄存器：
//       cycle N-1: dout_r <= mem[rd_ptr(N)]      // 由 rd_ptr_next 提前算好
//       cycle N  : o_rd_data == mem[rd_ptr(N)]   // 与 o_empty=0 同拍有效
//   上电首拍由一个 primed 标志保证：未 primed 时地址取 rd_ptr 本身（装载首字），
//   且 o_empty 强制为 1，消费方不会在数据未就绪时取走。
//
// 复位：wr_rst_n 属 wr_clk 域、rd_rst_n 属 rd_clk 域，**必须分域**（文档 §9 陷阱 4）。
//==============================================================================
`timescale 1ns / 1ps

module axis_fifo #(
    parameter DATA_W  = 16,             // 1~64
    parameter DEPTH   = 2048,           // 必须为 2 的幂
    parameter ADDR_W  = $clog2(DEPTH),  // 地址位宽（自动推导，可覆盖）
    parameter FWFT    = 1,              // 1 = 首字直通（读延迟 0）
    parameter USE_XPM = 0               // 1 = 例化 XPM 原语
)(
    // ---- 写域 ----
    input  wire                wr_clk,
    input  wire                wr_rst_n,
    input  wire                i_wr_en,
    input  wire [DATA_W-1:0]   i_wr_data,
    output wire                o_full,
    output wire [ADDR_W:0]     o_wr_level,
    // ---- 读域 ----
    input  wire                rd_clk,
    input  wire                rd_rst_n,
    input  wire                i_rd_en,
    output wire [DATA_W-1:0]   o_rd_data,
    output wire                o_empty,
    output wire [ADDR_W:0]     o_rd_level
);

    localparam PW = ADDR_W + 1;         // 格雷码指针多一位用于判满

    generate
    // ==========================================================================
    // 路径 A：纯 RTL（默认）—— 不依赖任何 IP
    // 说明：下面所有声明都放在本 generate 块的最前面，满足"先声明后使用"。
    // ==========================================================================
    if (USE_XPM == 0) begin : g_rtl

        reg  [DATA_W-1:0] mem [0:DEPTH-1];

        // ---- 写域 ----
        reg  [PW-1:0] wr_ptr_bin;
        reg  [PW-1:0] wr_ptr_gray;
        wire [PW-1:0] wr_ptr_bin_next;
        wire [PW-1:0] wr_ptr_gray_next;
        reg  [PW-1:0] rd_gray_s1;
        reg  [PW-1:0] rd_gray_s2;       // 写域看到的读指针（格雷）
        wire          wr_full;
        reg  [PW-1:0] rd_bin_sync;      // 格雷→二进制（组合）

        // ---- 读域 ----
        reg  [PW-1:0] rd_ptr_bin;
        reg  [PW-1:0] rd_ptr_gray;
        wire [PW-1:0] rd_ptr_bin_next;
        wire [PW-1:0] rd_ptr_look;      // 送给存储体的读地址
        reg  [PW-1:0] wr_gray_s1;
        reg  [PW-1:0] wr_gray_s2;       // 读域看到的写指针（格雷）
        reg  [PW-1:0] wr_bin_sync;      // 格雷→二进制
        wire          ptr_empty;
        reg           primed;
        reg  [DATA_W-1:0] dout_r;
        wire          rd_adv;

        integer j;

        // ---------------- 写域 ----------------
        // ⚠️ P0 修复（Lead 落，由 verify-dev 的满路径判据暴露）：
        //    首版写的是
        //        assign wr_full = (wr_ptr_gray_next == {~rd_s2[PW-1:PW-2], rd_s2[PW-3:0]});
        //    而 wr_ptr_gray_next 又由 wr_ptr_bin_next 算出，wr_ptr_bin_next 里含 ~wr_full：
        //        wr_full → wr_ptr_bin_next → wr_ptr_gray_next → wr_full      ← **组合环**
        //    写指针距满 1 格且 i_wr_en=1 时，两组取值互为反相（0⇒前进⇒满⇒1⇒不动⇒不满⇒0…）
        //    ⇒ ModelSim 同一时间步无限迭代：
        //         # ** Error (vsim-3601) Iteration limit 10000000 reached
        //         Loop: #ASSIGN#87 / #ALWAYS#158  Signal: wr_full @ sub-iteration 2
        //    ⇒ 综合侧就是那个悬了很久的
        //         CRITICAL WARNING: [Synth 8-295] found timing loop. [top_retina_event.v:19]
        //    （报点在顶层模块声明附近、无精确定位，正是这根网表的环。）
        //
        //    修法 = **标准格雷码满判据，且必须用"当前已寄存的指针"**：
        //        满 ⟺ 当前写指针已领先读指针一整圈（存了 DEPTH 个字）。
        //    ⚠️ 这里**不能用 `wr_ptr_gray_inc`**（"再写一格后的位置"）——那是 Cummings
        //       结构里 **寄存型 `wfull`** 的语义（它反映的是"这次写完之后"的状态）。
        //       本模块的 `wr_full` 是**组合线**、同拍就去门 `i_wr_en`，用 inc 版会**早一格**：
        //       实测 `wr_cnt=15`（16 深只能存 15 个）、`o_wr_level` 永远到不了 DEPTH。
        //       改用当前 `wr_ptr_gray` 后：wbin=15 时不判满 ⇒ 允许第 16 次写 ⇒ wbin=16
        //       ⇒ 判满，容量恰好 16。依赖项只有已寄存的 `wr_ptr_gray` 与 `rd_gray_s2`，
        //       仍然**无环**。
        assign wr_full          = (wr_ptr_gray == {~rd_gray_s2[PW-1:PW-2], rd_gray_s2[PW-3:0]});
        assign wr_ptr_bin_next  = wr_ptr_bin + (i_wr_en & ~wr_full);
        assign wr_ptr_gray_next = (wr_ptr_bin_next >> 1) ^ wr_ptr_bin_next;

        always @(posedge wr_clk) begin
            if (!wr_rst_n) begin
                wr_ptr_bin  <= {PW{1'b0}};
                wr_ptr_gray <= {PW{1'b0}};
            end else begin
                wr_ptr_bin  <= wr_ptr_bin_next;
                wr_ptr_gray <= wr_ptr_gray_next;
            end
        end

        // 读指针 → 写域（两级同步）
        always @(posedge wr_clk) begin
            if (!wr_rst_n) begin
                rd_gray_s1 <= {PW{1'b0}};
                rd_gray_s2 <= {PW{1'b0}};
            end else begin
                rd_gray_s1 <= rd_ptr_gray;
                rd_gray_s2 <= rd_gray_s1;
            end
        end

        // 格雷 → 二进制（写侧水位）
        always @(*) begin
            rd_bin_sync[PW-1] = rd_gray_s2[PW-1];
            for (j = PW-2; j >= 0; j = j - 1)
                rd_bin_sync[j] = rd_bin_sync[j+1] ^ rd_gray_s2[j];
        end

        // ---------------- 读域 ----------------
        assign ptr_empty       = (rd_ptr_gray == wr_gray_s2);
        assign rd_adv          = i_rd_en & primed & ~ptr_empty;
        assign rd_ptr_bin_next = rd_ptr_bin + rd_adv;
        assign rd_ptr_look     = rd_ptr_bin + (((FWFT != 0) && primed) ? rd_adv : 1'b0);

        always @(posedge rd_clk) begin
            if (!rd_rst_n) begin
                rd_ptr_bin  <= {PW{1'b0}};
                rd_ptr_gray <= {PW{1'b0}};
                primed      <= 1'b0;
            end else begin
                rd_ptr_bin  <= rd_ptr_bin_next;
                rd_ptr_gray <= (rd_ptr_bin_next >> 1) ^ rd_ptr_bin_next;
                primed      <= 1'b1;
            end
        end

        // 写指针 → 读域（两级同步）
        always @(posedge rd_clk) begin
            if (!rd_rst_n) begin
                wr_gray_s1 <= {PW{1'b0}};
                wr_gray_s2 <= {PW{1'b0}};
            end else begin
                wr_gray_s1 <= wr_ptr_gray;
                wr_gray_s2 <= wr_gray_s1;
            end
        end

        // 读延迟 1 拍（综合推断 BRAM）
        always @(posedge rd_clk) begin
            dout_r <= mem[rd_ptr_look[ADDR_W-1:0]];
        end

        always @(posedge wr_clk) begin
            if (i_wr_en & ~wr_full) mem[wr_ptr_bin[ADDR_W-1:0]] <= i_wr_data;
        end

        // 格雷 → 二进制（读侧水位）
        always @(*) begin
            wr_bin_sync[PW-1] = wr_gray_s2[PW-1];
            for (j = PW-2; j >= 0; j = j - 1)
                wr_bin_sync[j] = wr_bin_sync[j+1] ^ wr_gray_s2[j];
        end

        // ---------------- 输出 ----------------
        // primed 未置位前强制"空"，保证 dout_r 已装载首字
        assign o_full     = wr_full;
        assign o_wr_level = wr_ptr_bin - rd_bin_sync;
        assign o_empty    = ~primed | ptr_empty;
        assign o_rd_level = wr_bin_sync - rd_ptr_bin;
        assign o_rd_data  = dout_r;

    // ==========================================================================
    // 路径 B：XPM 原语（正式构建可选）
    // ==========================================================================
    end else begin : g_xpm

        xpm_fifo_async #(
            .FIFO_MEMORY_TYPE  ("block"),
            .FIFO_WRITE_DEPTH  (DEPTH),
            .WRITE_DATA_WIDTH  (DATA_W),
            .READ_DATA_WIDTH   (DATA_W),
            .READ_MODE         (FWFT ? "fwft" : "std"),
            .CDC_SYNC_STAGES   (2),
            .RELATED_CLOCKS    (0),
            .FIFO_READ_LATENCY (FWFT ? 0 : 1)
        ) u_xpm_fifo_async (
            .wr_clk         (wr_clk),
            .wr_rst         (~wr_rst_n),
            .wr_en          (i_wr_en),
            .din            (i_wr_data),
            .full           (o_full),
            .wr_data_count  (o_wr_level),
            .almost_full    (),
            .overflow       (),
            .wr_ack         (),
            .prog_full      (),
            .rd_clk         (rd_clk),
            .rd_rst         (~rd_rst_n),
            .rd_en          (i_rd_en),
            .dout           (o_rd_data),
            .empty          (o_empty),
            .rd_data_count  (o_rd_level),
            .almost_empty   (),
            .underflow      (),
            .prog_empty     (),
            .sbiterr        (),
            .dbiterr        (),
            .injectdbiterr  (1'b0),
            .injectsbiterr  (1'b0),
            .sleep          (1'b0)
        );

    end
    endgenerate

endmodule

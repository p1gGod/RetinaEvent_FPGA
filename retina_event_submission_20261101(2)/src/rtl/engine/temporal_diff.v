//==============================================================================
// temporal_diff -- 一阶时间差分 ΔL = L(本帧) − L(上一帧)（L2 事件引擎）
//
// 规格：retina_event/docs/子模块设计/L2_事件引擎/temporal_diff.md §2/§3/§4/§6
//   帧存 400×240×8bit = 768,000 bit（文档 §7：按 4K×9 打包 ≈ 24 块 BRAM36）
//   行为级双口写法：同一 always 块内「读端口 + 写端口」，
//     - 读 mem[addr] 用非阻塞 ⇒ READ_FIRST，同址时读回**上一帧**的值（正是所需）
//     - 写用 addr/data 延迟 1 拍（B4），与读同址，天然无冲突
//   综合（Vivado）会推断为简单双口 BRAM（SDP）。仿真不依赖任何 IP。
//
// ⚠️ §9.1 BRAM 读有 1 拍延迟 ⇒ 写地址/数据必须相应延迟 1 拍，否则会把"当前 L"
//    写到"下一像素的地址"，全图错乱。
// ⚠️ §9.3 首帧保护：帧存上电为 0/未知，不加保护第一帧会因"从 0 跳变"产生满屏假事件。
//    本实现：i_first_frame（打 1 拍对齐后）期间 o_de 强制 0、o_dl 强制 0。
// ⚠️ §9.4 IMG_W 必须与 vps_resample 的 OUT_W 一致（都是 400）。
//
// 时钟域语义：内部行列计数用 de 边界（i_de 低电平时列计数清零），不依赖 vsync 相位，
//   故 i_vsync 只用于可靠复位行列计数。
//==============================================================================
`timescale 1ns / 1ps

module temporal_diff #(
    parameter IMG_W     = 400,          // 帧存行宽（必须与事件引擎分辨率一致）
    parameter IMG_H     = 240,          // 帧存行数
    parameter ADDR_W    = 17,           // 地址位宽 = ceil(log2(IMG_W*IMG_H))
    parameter BRAM_PACK = "4Kx9"        // 打包方式（综合提示，见文档 §7）
)(
    input  wire       clk_cam,
    input  wire       rst_n_cam,
    input  wire       i_vsync,
    input  wire       i_de,
    input  wire [7:0] i_l,              // 当前像素的对数亮度 L
    input  wire       i_first_frame,    // 首帧标志（帧存未初始化，抑制假事件）
    output wire       o_vsync,
    output wire       o_de,
    output wire [8:0] o_dl              // 有符号 ΔL（S9，[−255,+255]）
);

    function integer clog2;
        input integer value;
        integer i;
        begin
            clog2 = 0;
            for (i = value - 1; i > 0; i = i >> 1) clog2 = clog2 + 1;
        end
    endfunction

    localparam XW   = (clog2(IMG_W) < 1) ? 1 : clog2(IMG_W);   // 400 → 9
    localparam YW   = (clog2(IMG_H) < 1) ? 1 : clog2(IMG_H);   // 240 → 8
    localparam PIX  = IMG_W * IMG_H;                           // 96,000

    //--------------------------------------------------------------------------
    // B1：帧内线性像素地址（0 .. IMG_W·IMG_H−1）
    //   ⚠️ 文档 §4 B1 写的是 addr = y·IMG_W + x。本实现改为**帧内线性计数**（等价，
    //      且严格更稳健）：行列计数在"帧尾最后 1 拍 + 消隐"期间会发生 x 回绕 / y 越界，
    //      使 addr 跳出 [0,PIX−1]（y=IMG_H 时 y·IMG_W 越界并被 ADDR_W 截断回 0），
    //      而 de 延迟链仍为 1 ⇒ 会把最后一个像素写到错误地址（实测踩到：
    //      帧尾把 pattern(127) 写进了 mem[0]，导致下一帧首像素 ΔL 错误）。
    //   线性计数器只在 de 时递增并在 PIX−1 饱和 ⇒ (addr_d1, l_d1, de_d1) 三元组恒一致。
    //--------------------------------------------------------------------------
    reg [ADDR_W-1:0] pix_cnt;

    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            pix_cnt <= {ADDR_W{1'b0}};
        end else if (i_vsync) begin
            pix_cnt <= {ADDR_W{1'b0}};
        end else if (i_de) begin
            if (pix_cnt != PIX - 1) pix_cnt <= pix_cnt + 1'b1;   // 饱和，防越界
        end
    end

    wire [ADDR_W-1:0] addr = pix_cnt;

    //--------------------------------------------------------------------------
    // B2/B4：帧存（行为级简单双口：非阻塞读 = READ_FIRST，写用延迟 1 拍的地址/数据）
    //--------------------------------------------------------------------------
    (* ram_style = "block" *) reg [7:0] frame_mem [0:PIX-1];
    integer k;
    initial begin
        for (k = 0; k < PIX; k = k + 1) frame_mem[k] = 8'h00;
    end

    // 写端口用「上一拍」的地址/数据/使能，与读端口同址 ⇒ 读回旧值、写入新值
    reg               de_d1;
    reg [ADDR_W-1:0]  addr_d1;
    reg [7:0]         l_d1;
    reg               vs_d1;
    reg               ff_d1;

    // 读端口（同步读，1 拍延迟）
    reg [7:0] l_prev;

    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            de_d1   <= 1'b0;
            addr_d1 <= {ADDR_W{1'b0}};
            l_d1    <= 8'h00;
            vs_d1   <= 1'b0;
            ff_d1   <= 1'b0;
            l_prev  <= 8'h00;
        end else begin
            de_d1   <= i_de;
            addr_d1 <= addr;
            l_d1    <= i_l;
            vs_d1   <= i_vsync;
            ff_d1   <= i_first_frame;
            l_prev  <= frame_mem[addr];         // READ_FIRST：同址时取旧值
            if (de_d1) frame_mem[addr_d1] <= l_d1;   // 把本帧 L 写回（用延迟 1 拍的地址）
        end
    end

    //--------------------------------------------------------------------------
    // B3/B5/B6：差分 + 首帧保护 + 控制对齐（固定 1 拍）
    //--------------------------------------------------------------------------
    wire [8:0] dl_raw = {1'b0, l_d1} - {1'b0, l_prev};      // S9：l_d1 − l_prev

    assign o_vsync = vs_d1;
    assign o_de    = de_d1 & ~ff_d1;                         // 首帧强制 0
    assign o_dl    = ff_d1 ? 9'd0 : dl_raw;                  // 首帧强制 0

endmodule

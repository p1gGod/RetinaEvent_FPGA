//==============================================================================
// clk_rst_gen -- 时钟生成 + 复位同步释放（L0 板级基础）
//
// 规格：retina_event/docs/子模块设计/L0_板级基础/clk_rst_gen.md
//
// 频率方案（★ 实现阶段冻结，见下方"为什么"）：
//   sys_clk(R4) 50 MHz ─► clk_wiz_0 ─┬─ clk_out1 = 200 MHz ─► o_clk_200m   （MIG + 以太网 IDELAY 参考）
//                                    ├─ clk_out2 =  50 MHz ─► o_clk_cam    （事件引擎主时钟）
//                                    └─ clk_out2 ÷2 + BUFG ─► o_clk_lcd    （25 MHz，LCD 像素时钟）
//
// 为什么这样分（而不是把 25 MHz 也交给 MMCM）：
//   现有 `clk_wiz_0.xci`（厂家例程 37 / 合并工程两份完全一致）已经是
//   `PRIM_IN_FREQ=50`、`MMCM_CLKFBOUT_MULT_F=20`（VCO=1000 MHz）、
//   `CLKOUT1=200 MHz(div 20)`、`CLKOUT2=50 MHz(div 1)`、**`CLKOUT3_USED=false`**。
//   复用它可以**完全不碰 IP**，`mig_7series_0` 的 OOC 综合 run 也原样保留 ⇒ 构建风险最低。
//   50 MHz 二分频用 fabric 翻转 FF 是厂家 `clk_div.v` 已在**本板上板跑通**的写法，可靠。
//
// 复位：异步置位 + 每域同步释放（文档 B3 标准写法）。
//   rst_n_async = sys_rst_n & locked
//
// ⚠️ 仿真：本模块例化 `clk_wiz_0` 与 `BUFG` 两个 Xilinx 原语/IP。
//    ModelSim 下由 `sim/models/clk_wiz_0_sim.v` + `sim/models/bufg_sim.v` 提供行为级替身
//    （**只用于仿真**；Vivado 工程里不要加 sim/ 目录，否则与真 IP 重名冲突）。
//==============================================================================
`timescale 1ns / 1ps

module clk_rst_gen #(
    parameter RST_SYNC_STAGES = 3       // 2~4；复位同步释放链级数
)(
    input  wire sys_clk,                // 引脚 R4，50 MHz（⚠️ 非专用时钟引脚）
    input  wire sys_rst_n,              // 引脚 U7，低有效（⚠️ Bank34 1.35V ⇒ LVCMOS15）

    output wire o_clk_200m,             // 200 MHz
    output wire o_clk_lcd,              // 25 MHz
    output wire o_clk_cam,              // 50 MHz

    output wire o_locked,               // MMCM 锁定指示（sys_clk 域）

    output wire o_rst_n_200m,           // clk_200m 域，同步释放
    output wire o_rst_n_lcd,            // clk_lcd  域，同步释放
    output wire o_rst_n_cam             // clk_cam  域，同步释放
);

    // ------------------------------------------------------------------
    // B1: MMCM（clk_wiz_0）：200 MHz + 50 MHz
    // ------------------------------------------------------------------
    wire clk_200m_raw;
    wire clk_50m_raw;
    wire locked_raw;

    clk_wiz_0 u_clk_wiz_0 (
        .clk_out1 (clk_200m_raw),       // 200 MHz
        .clk_out2 (clk_50m_raw),        // 50 MHz
        .reset    (1'b0),
        .locked   (locked_raw),
        .clk_in1  (sys_clk)
    );

    assign o_clk_200m = clk_200m_raw;
    assign o_clk_cam  = clk_50m_raw;

    // ------------------------------------------------------------------
    // B1b: 50 MHz → 25 MHz（fabric 二分频 + BUFG）
    //       无复位（时钟源本身，鸡生蛋问题）⇒ 用初值把仿真定在确定态
    // ------------------------------------------------------------------
    reg clk_25m_pre = 1'b0;
    always @(posedge clk_50m_raw) clk_25m_pre <= ~clk_25m_pre;

    BUFG u_bufg_lcd (
        .I (clk_25m_pre),
        .O (o_clk_lcd)
    );

    // ------------------------------------------------------------------
    // B2: 复位与门（异步置位源）
    // ------------------------------------------------------------------
    wire rst_n_async = sys_rst_n & locked_raw;

    // ------------------------------------------------------------------
    // B3: 每域复位同步释放 —— 异步置位 / 同步释放
    // ------------------------------------------------------------------
    reg [RST_SYNC_STAGES-1:0] rst_sync_200m;
    always @(posedge clk_200m_raw or negedge rst_n_async) begin
        if (!rst_n_async) rst_sync_200m <= {RST_SYNC_STAGES{1'b0}};
        else              rst_sync_200m <= {rst_sync_200m[RST_SYNC_STAGES-2:0], 1'b1};
    end
    assign o_rst_n_200m = rst_sync_200m[RST_SYNC_STAGES-1];

    reg [RST_SYNC_STAGES-1:0] rst_sync_cam;
    always @(posedge clk_50m_raw or negedge rst_n_async) begin
        if (!rst_n_async) rst_sync_cam <= {RST_SYNC_STAGES{1'b0}};
        else              rst_sync_cam <= {rst_sync_cam[RST_SYNC_STAGES-2:0], 1'b1};
    end
    assign o_rst_n_cam = rst_sync_cam[RST_SYNC_STAGES-1];

    // clk_lcd 由 clk_50m_raw 二分频而来，复位链用 clk_50m_raw 打拍后再用即可
    //（同一时钟源，25 MHz 是它的分频，二者相位关系确定）
    reg [RST_SYNC_STAGES-1:0] rst_sync_lcd;
    always @(posedge clk_50m_raw or negedge rst_n_async) begin
        if (!rst_n_async) rst_sync_lcd <= {RST_SYNC_STAGES{1'b0}};
        else              rst_sync_lcd <= {rst_sync_lcd[RST_SYNC_STAGES-2:0], 1'b1};
    end
    assign o_rst_n_lcd = rst_sync_lcd[RST_SYNC_STAGES-1];

    // ------------------------------------------------------------------
    // B4: 锁定指示
    //
    // ⚠️ 集成修复（Lead，2026-10-03）：**这里不能再写 `always @(posedge sys_clk)`**。
    //    首版把 locked 同步到 sys_clk 域，结果 `sys_clk` 同时驱动
    //      ① clk_wiz_0 的 clk_in1（经一个 IBUF）
    //      ② 本寄存器的时钟脚（Vivado 又会给它插一个 IBUF）
    //    ⇒ 综合直接报（实测原始报错）：
    //       ERROR: [Synth 8-5535] port <sys_clk> has illegal connections.
    //              It is illegal to have a port connected to an input buffer and other components.
    //       ERROR: [Synth 8-2918] Failing due to illegal port connections
    //       ERROR: synthesis optimization failed, fatal insert_io failure.
    //    修法：`o_locked` 直连 MMCM 的 locked（它只驱动 LED，不需要同步）。
    //    若将来确实要打拍，请在 **MMCM 输出域**（如 clk_cam）里打，不要在 sys_clk 上再挂负载。
    // ------------------------------------------------------------------
    assign o_locked = locked_raw;

endmodule

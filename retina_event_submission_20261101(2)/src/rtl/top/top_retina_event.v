//==============================================================================
// top_retina_event -- 顶层（L4）：**只做连接**
//
// 规格：retina_event/docs/子模块设计/L3_L4_集成/top_retina_event.md
//
// 红线（文档 §1 §9）：
//   ❌ 零业务逻辑 —— 本文件只有例化、位宽拼装与 assign 直连；
//      唯一的两处"逻辑"是 (a) 域的复位同步释放、(b) RGS 配置位跨域 CDC，
//      两者都是**结构性的、不含任何业务判断**，且都只用 L1 原语实现。
//   ❌ 不在顶层"抢" lcd_rgb inout（三态完全在 display_path 内）。
//   ❌ 不直接驱动 cam_* / ddr3_*（那是 display_path 的职责）。
//
// 引脚（XDC：src/constraints/retina_event.xdc）：
//   ⚠️ Bank34/35 是 1.35 V（DDR3L）⇒ sys_clk(R4)/sys_rst_n(U7)/key/led/beep/
//      lcd_bl(W9)/lcd_rst(Y9) 一律 LVCMOS15；写 33 会在**实现阶段**报 [DRC BIVC-1]。
//==============================================================================
`timescale 1ns / 1ps

module top_retina_event #(
    parameter SIM      = 0,         // 1 = 仿真（屏蔽/替换厂商原语，由 TB 提供桩）
    parameter ILA_EN   = 0,         // 最终构建必须为 0（否则资源统计不准）
    parameter USE_DDR3 = 1,         // 1 = 厂家 DDR3 显示通路；0 = 备选方案 B（自产图案）
    parameter CFG_SRC  = 2'd0,      // retina_core 视频源：0 = 相机，1 = 自检图案（无相机演示/仿真）
    parameter ETH_EN   = 1,         // 1 = 例化以太网 UDP 回传
                                    //   ★ 2026-10-06 起默认置 1：已上板实测通过
                                    //     （ARP 应答 + 40/65 整帧 768000 B + 0 坏包，
                                    //      见事实登记册 H46~H48、tool/check_eth_onboard.ps1）
                                    //   ⚠️ 置 0 时 event_sink 的 UDP 输出悬空，Vivado 会把
                                    //      udp_merge 整块优化掉 —— 交付报告里 15,379/7,802
                                    //      那组数字**不含 UDP 通路**，别拿它当 ETH_EN=1 的基线
    parameter UART_EN  = 0,         // 1 = 例化串口遥测（未验证：本机没有 FTDI B 通道 COM 口）
    // ---- ★ WIRE-U1 串口事件回传链路（默认 0 = 与现状逐比特一致）----
    parameter UART_LINK_EN = 0,     // 1 = 例化 uart_link/uart_ev_tap/uart_dl_bridge/link_detect
    parameter UART_BAUD    = 115200,// 115200（默认兼容档）/ 460800（回退档）/ 921600（演示档）
    // ---- 帧率实验点：透传到 display_path 的 OV5640 时序覆盖层 ----
    //   ★ 默认值必须与 src/hdl/subsys/display_path.v 完全一致（纯旁路）
    //   ★ 命令行选实验点（fileset generic，见 tool/ 下的综合脚本）：
    //       -generic OVL_TIMING_EN=1 -generic OVL_SCAN_SEL=1 -generic OVL_HTS=1852 -generic OVL_VTS=760
    parameter OVL_TIMING_EN = 0,    // 0=旁路（默认）; 1=启用覆盖
    parameter OVL_SCAN_SEL  = 0,    // 0=用 OVL_HTS/OVL_VTS; 1=A; 2=B; 3=C
    parameter OVL_HTS       = 1800, // total_h_pixel 覆盖值（13bit）
    parameter OVL_VTS       = 750,  // total_v_pixel 覆盖值（13bit）
    // ---- ★ sccb_patch 曝光上限补写（与 display_path 默认值必须一致）----
    //   ★ 默认 1 = 交付档：补写使能，写入值 = **下行命令运行时可写寄存器**
    //     （复位默认 = OVL_EXP_CAP_LINES = 0x1710 = 厂家基线原值 ⇒ "补写等于不改"）；
    //     E0~E6 的 cap 档扫档全部走 SET_PARAM tag 0x0B，无需重构建。
    //   置 0 = 完全旁路（消融档，行为等价于集成前 e746270f 位流）。
    parameter OVL_EXP_CAP_EN    = 1,        // 1=启用补写（默认，交付档）; 0=旁路（消融档）
    parameter [15:0] OVL_EXP_CAP_LINES = 16'h1710,  // 构建期档位 = 运行时寄存器复位默认
    // ★ 实验档（2026-10-13 曝光生效验证）：1 = 补写序列**先**加写 0x3A00=0x7C（夜视模式开），
    //   使 4 条"曝光上限"寄存器真正生效（手册 §4.6.1.3：上限只在 Night mode 开时被 AEC 使用）。
    //   默认 0 = 交付行为不变（只写 4 条上限）。
    parameter OVL_AEC_CTRL_EN   = 0,
    // ★ 实验档：1 = 追加 3 条手动曝光写（0x3503/0x3501/0x3502）作"正向对照"
    parameter OVL_MAN_EXP_EN    = 0
)(
    // ---- 时钟/复位  Bank34 ⇒ LVCMOS15 ----
    input  wire        sys_clk      ,   // R4   50 MHz
    input  wire        sys_rst_n    ,   // U7   低有效
    // ---- 按键/LED/蜂鸣器  Bank34 ⇒ LVCMOS15 ----
    input  wire [3:0]  key          ,   // T4 T3 R6 T6（低有效：按下 = 0）
    output wire [3:0]  led          ,   // V9 Y8 Y7 W7
    output wire        beep         ,   // V7
    // ---- 串口遥测  LVCMOS33 ----
    input  wire        uart_rxd     ,   // E14
    output wire        uart_txd     ,   // D17
    // ---- OV5640 摄像头  LVCMOS33 ----
    input  wire        cam_pclk     ,   // U18
    input  wire        cam_vsync    ,   // P14
    input  wire        cam_href     ,   // N14
    input  wire [7:0]  cam_data     ,   // P17 P15 R16 R17 P16 V17 W17 U17
    output wire        cam_rst_n    ,   // N17
    output wire        cam_pwdn     ,   // AB18
    output wire        cam_scl      ,   // N13
    inout  wire        cam_sda      ,   // R14
    // ---- DDR3 ----
    inout  wire [31:0] ddr3_dq      ,
    inout  wire [3:0]  ddr3_dqs_n   ,
    inout  wire [3:0]  ddr3_dqs_p   ,
    output wire [13:0] ddr3_addr    ,
    output wire [2:0]  ddr3_ba      ,
    output wire        ddr3_ras_n   ,
    output wire        ddr3_cas_n   ,
    output wire        ddr3_we_n    ,
    output wire        ddr3_reset_n ,
    output wire [0:0]  ddr3_ck_p    ,
    output wire [0:0]  ddr3_ck_n    ,
    output wire [0:0]  ddr3_cke     ,
    output wire [0:0]  ddr3_cs_n    ,
    output wire [3:0]  ddr3_dm      ,
    output wire [0:0]  ddr3_odt     ,
    // ---- RGB LCD ----
    inout  wire [23:0] lcd_rgb      ,   // 3.3V 组；开机读屏 ID，顶层**别抢** inout
    output wire        lcd_hs       ,   // H18
    output wire        lcd_vs       ,   // J17
    output wire        lcd_de       ,   // K17
    output wire        lcd_pclk     ,   // H17
    output wire        lcd_bl       ,   // W9   ★ LVCMOS15（Bank34）
    output wire        lcd_rst      ,   // Y9   ★ LVCMOS15（Bank34）
    // ---- 千兆以太网 RGMII（底板 GE1 口）----
    input  wire        eth_rxc      ,   // Y18
    input  wire        eth_rx_ctl   ,   // Y21
    input  wire [3:0]  eth_rxd      ,   // Y22 AB21 AB22 Y19
    output wire        eth_txc      ,   // W19
    output wire        eth_tx_ctl   ,   // W20
    output wire [3:0]  eth_txd      ,   // W22 W21 T20 P20
    output wire        eth_rst_n        // N20
);

    // ========================================================================
    // B1: 时钟/复位（clk_rst_gen）
    //   clk_cam = 50 MHz、clk_lcd = 25 MHz、clk_200m = 200 MHz
    // ========================================================================
    wire clk_cam, clk_lcd, clk_200m;
    wire locked;
    wire rst_n_cam, rst_n_lcd, rst_n_200m;

    clk_rst_gen #(.RST_SYNC_STAGES(3)) u_clk_rst_gen (
        .sys_clk      (sys_clk),
        .sys_rst_n    (sys_rst_n),
        .o_clk_200m   (clk_200m),
        .o_clk_lcd    (clk_lcd),
        .o_clk_cam    (clk_cam),
        .o_locked     (locked),
        .o_rst_n_200m (rst_n_200m),
        .o_rst_n_lcd  (rst_n_lcd),
        .o_rst_n_cam  (rst_n_cam)
    );

    // ---- cam_pclk 域的复位：异步置位 / 同步释放（结构性，无业务判断）----
    reg [1:0] rst_pclk_sync;
    always @(posedge cam_pclk or negedge rst_n_cam) begin
        if (!rst_n_cam) rst_pclk_sync <= 2'b00;
        else            rst_pclk_sync <= {rst_pclk_sync[0], 1'b1};
    end
    wire rst_n_pclk = rst_pclk_sync[1];

    // ========================================================================
    // ★ v3 公共网线（先声明后使用：B2 的 CDC 与 B3 的 display_path 都会引用）
    // ========================================================================
    wire clk_eth;                   // = eth_rxc（PHY 提供，125 MHz，B5 赋值）
    wire rst_n_eth;                 // = rst_n_200m（结构性命中，B5 赋值）
    // ---- v3.1 LCD 帧率 / 模式标签 ----
    wire [7:0]  fps_val;
    wire [1:0]  mode_tag_cam;
    wire [7:0]  fps_lcd;
    wire [1:0]  mode_tag_lcd;

    // ========================================================================
    // B2: 系统控制（sys_ctrl → RGS；v3 起含三模式与下行写入通道）
    // ========================================================================
    wire        cfg_disp_mode;
    wire [1:0]  cfg_mode;               // ★ v3：回传模式 0=RAW_EV 1=RAW_ONLY 2=EV_ONLY
    wire [1:0]  cfg_theta_sel;
    wire [3:0]  cfg_layer_en;
    wire        cfg_ev_en;
    wire [11:0] cfg_theta;
    wire [8:0]  cfg_min_dl;
    wire        stat_mode;
    wire [3:0]  key_pressed;

    // ---- v3 下行命令写入通道（downlink_cmd clk_eth → sys_ctrl clk_cam）----
    // ★ 修复 F3-20261013（SET_MODE 偶发写不生效 ≈2/44）：改用 cdc_tog_word 成对过域 ——
    //   原实现是**两条互相独立的 sync_ff**（值一条、toggle 一条，级数相同），一级触发器
    //   在同一目标域沿对两组信号独立判决 ⇒ 观察到"值新/toggle 新"最多差 1 个目标域周期；
    //   sys_ctrl 按 toggle 变化沿采值（sys_ctrl.v:169）⇒ toggle 先到时采到旧值、toggle
    //   已被消费 ⇒ **该次写永久丢失**。cdc_tog_word 检到 toggle 变化沿后先等静默窗
    //   （值链必然已稳定），再**同拍**更新值与 toggle ⇒ 下游一字不改即得新值。
    //   ⚠️ 8 组命令通道（mode/theta/minDl/evEn/evRes/serDecim/serAgg/serFlush）同源同险，
    //      故 16 个 sync_ff 全部替换；线名与 sys_ctrl 端口保持不变（零下游改动）。
    wire [11:0] dl_theta;        wire dl_theta_upd;
    wire [8:0]  dl_min_dl;       wire dl_min_dl_upd;
    wire [1:0]  dl_mode_set;     wire dl_mode_set_upd;
    wire        dl_ev_en_set;    wire dl_ev_en_set_upd;

    wire [11:0] theta_set_cam;   wire theta_set_cam_upd;
    wire [8:0]  min_dl_set_cam;  wire min_dl_set_cam_upd;
    wire [1:0]  mode_set_cam;    wire mode_set_cam_upd;
    wire        ev_en_set_cam;   wire ev_en_set_cam_upd;
    // ---- ★ WIRE-U1 串口参数写入通道（downlink_cmd clk_eth → sys_ctrl clk_cam）----
    wire [1:0]  dl_ev_res;        wire dl_ev_res_upd;
    wire [7:0]  dl_ser_decim;     wire dl_ser_decim_upd;
    wire [1:0]  dl_ser_agg;       wire dl_ser_agg_upd;
    wire [15:0] dl_ser_flush;     wire dl_ser_flush_upd;
    wire [1:0]  ev_res_set_cam;   wire ev_res_set_cam_upd;
    wire [7:0]  ser_decim_set_cam;wire ser_decim_set_cam_upd;
    wire [1:0]  ser_agg_set_cam;  wire ser_agg_set_cam_upd;
    wire [15:0] ser_flush_set_cam;wire ser_flush_set_cam_upd;
    wire [1:0]  cfg_ev_res;
    wire [7:0]  cfg_ser_decim;
    wire [1:0]  cfg_ser_agg;
    wire [15:0] cfg_ser_flush_ms;
    // ---- ★ 曝光上限运行时可写（downlink_cmd clk_eth → sys_ctrl clk_cam → display_path）----
    wire [15:0] dl_exp_cap;        wire dl_exp_cap_upd;
    wire [15:0] exp_cap_set_cam;   wire exp_cap_set_cam_upd;
    wire [15:0] cfg_exp_cap;       wire cfg_exp_cap_upd;
    // ---- ★ WIRE-U2 串口波特率档位（downlink_cmd clk_eth → uart_link clk_cam）----
    wire [1:0]  dl_ser_baud_sel;   wire dl_ser_baud_commit;

    // ---- ★ WIRE-U3 HUD 参数（sys_ctrl clk_cam / 参数常量 → display_path clk_lcd）----
    //   为什么在这里声明：uart_baud_cur 由下方 g_uart_link / g_no_uart_link 两个
    //   generate 分支分别驱动，而 hud_* 的 2FF 在 B2 里（源信号必须先声明）。
    localparam UART_LINK_ON = (UART_LINK_EN != 0);   // HUD 行4/5 的 UART 使能
    wire [1:0]  uart_baud_cur;          // uart_link 当前生效档位（UART 关闭时恒 0）
    wire [11:0] hud_theta_lcd;          // 行2：θ 阈值
    wire [8:0]  hud_min_dl_lcd;         // 行2：minDl
    wire [1:0]  hud_mode_lcd;           // 行3：回传模式
    wire        hud_ev_en_lcd;          // 行3：EV_EN
    wire [1:0]  hud_baud_lcd;           // 行5：波特率档位

    // ★ F3 修复：8 组命令通道一律用 cdc_tog_word（值 + toggle 成对过域，静默窗后同拍提交）
    cdc_tog_word #(.WIDTH(12), .STAGES(2), .SETTLE(3)) u_cdc2_theta (
        .dst_clk (clk_cam), .dst_rst_n (rst_n_cam),
        .i_src_val (dl_theta),     .i_src_tog (dl_theta_upd),
        .o_dst_val (theta_set_cam), .o_dst_tog (theta_set_cam_upd));
    cdc_tog_word #(.WIDTH(9), .STAGES(2), .SETTLE(3)) u_cdc2_mindl (
        .dst_clk (clk_cam), .dst_rst_n (rst_n_cam),
        .i_src_val (dl_min_dl),     .i_src_tog (dl_min_dl_upd),
        .o_dst_val (min_dl_set_cam), .o_dst_tog (min_dl_set_cam_upd));
    cdc_tog_word #(.WIDTH(2), .STAGES(2), .SETTLE(3)) u_cdc2_mode (
        .dst_clk (clk_cam), .dst_rst_n (rst_n_cam),
        .i_src_val (dl_mode_set),     .i_src_tog (dl_mode_set_upd),
        .o_dst_val (mode_set_cam),   .o_dst_tog (mode_set_cam_upd));
    cdc_tog_word #(.WIDTH(1), .STAGES(2), .SETTLE(3)) u_cdc2_even (
        .dst_clk (clk_cam), .dst_rst_n (rst_n_cam),
        .i_src_val (dl_ev_en_set),     .i_src_tog (dl_ev_en_set_upd),
        .o_dst_val (ev_en_set_cam),   .o_dst_tog (ev_en_set_cam_upd));
    // ---- ★ WIRE-U1 SER 参数组（同款成对过域）----
    cdc_tog_word #(.WIDTH(2), .STAGES(2), .SETTLE(3)) u_cdc2_evres (
        .dst_clk (clk_cam), .dst_rst_n (rst_n_cam),
        .i_src_val (dl_ev_res),     .i_src_tog (dl_ev_res_upd),
        .o_dst_val (ev_res_set_cam), .o_dst_tog (ev_res_set_cam_upd));
    cdc_tog_word #(.WIDTH(8), .STAGES(2), .SETTLE(3)) u_cdc2_decim (
        .dst_clk (clk_cam), .dst_rst_n (rst_n_cam),
        .i_src_val (dl_ser_decim),     .i_src_tog (dl_ser_decim_upd),
        .o_dst_val (ser_decim_set_cam), .o_dst_tog (ser_decim_set_cam_upd));
    cdc_tog_word #(.WIDTH(2), .STAGES(2), .SETTLE(3)) u_cdc2_agg (
        .dst_clk (clk_cam), .dst_rst_n (rst_n_cam),
        .i_src_val (dl_ser_agg),     .i_src_tog (dl_ser_agg_upd),
        .o_dst_val (ser_agg_set_cam), .o_dst_tog (ser_agg_set_cam_upd));
    cdc_tog_word #(.WIDTH(16), .STAGES(2), .SETTLE(3)) u_cdc2_flush (
        .dst_clk (clk_cam), .dst_rst_n (rst_n_cam),
        .i_src_val (dl_ser_flush),     .i_src_tog (dl_ser_flush_upd),
        .o_dst_val (ser_flush_set_cam), .o_dst_tog (ser_flush_set_cam_upd));
    // ---- ★ 曝光上限运行时可写（SET_PARAM tag 0x0B）：与上述 8 组同款成对过域 ----
    cdc_tog_word #(.WIDTH(16), .STAGES(2), .SETTLE(3)) u_cdc2_expcap (
        .dst_clk (clk_cam), .dst_rst_n (rst_n_cam),
        .i_src_val (dl_exp_cap),     .i_src_tog (dl_exp_cap_upd),
        .o_dst_val (exp_cap_set_cam), .o_dst_tog (exp_cap_set_cam_upd));

    sys_ctrl #(
        .CLK_FREQ_HZ (50000000),        // = clk_cam
        .DEBOUNCE_MS (20),
        .EXP_CAP_DEF (OVL_EXP_CAP_LINES) // ★ 曝光上限寄存器复位默认 = 构建期档位
    ) u_sys_ctrl (
        .clk_cam         (clk_cam),
        .rst_n_cam       (rst_n_cam),
        .i_key           (key),
        .i_mode_set_val  (mode_set_cam),
        .i_mode_set_upd  (mode_set_cam_upd),
        .i_theta_set_val (theta_set_cam),
        .i_theta_set_upd (theta_set_cam_upd),
        .i_min_dl_set_val(min_dl_set_cam),
        .i_min_dl_set_upd(min_dl_set_cam_upd),
        .i_ev_en_set_val (ev_en_set_cam),
        .i_ev_en_set_upd (ev_en_set_cam_upd),
        // ★ WIRE-U1 SER 参数组写入
        .i_ev_res_set_val    (ev_res_set_cam),
        .i_ev_res_set_upd    (ev_res_set_cam_upd),
        .i_ser_decim_set_val (ser_decim_set_cam),
        .i_ser_decim_set_upd (ser_decim_set_cam_upd),
        .i_ser_agg_set_val   (ser_agg_set_cam),
        .i_ser_agg_set_upd   (ser_agg_set_cam_upd),
        .i_ser_flush_set_val (ser_flush_set_cam),
        .i_ser_flush_set_upd (ser_flush_set_cam_upd),
        // ★ 曝光上限运行时可写（SET_PARAM tag 0x0B）
        .i_exp_cap_set_val   (exp_cap_set_cam),
        .i_exp_cap_set_upd   (exp_cap_set_cam_upd),
        .o_cfg_disp_mode (cfg_disp_mode),
        .o_mode          (cfg_mode),
        .o_cfg_theta_sel (cfg_theta_sel),
        .o_cfg_layer_en  (cfg_layer_en),
        .o_cfg_ev_en     (cfg_ev_en),
        .o_cfg_theta     (cfg_theta),
        .o_cfg_min_dl    (cfg_min_dl),
        .o_stat_mode     (stat_mode),
        .o_key_pressed   (key_pressed),
        .o_ev_res        (cfg_ev_res),
        .o_ser_decim     (cfg_ser_decim),
        .o_ser_agg       (cfg_ser_agg),
        .o_ser_flush_ms  (cfg_ser_flush_ms),
        .o_exp_cap       (cfg_exp_cap),      // ★ → display_path → sccb_patch
        .o_exp_cap_upd   (cfg_exp_cap_upd)
    );

    // ---- ★ v3：模式/事件使能 电平跨域（clk_cam → clk_eth，准静态，两级同步）----
    wire [1:0] cfg_mode_eth;
    wire       cfg_ev_en_eth;

    sync_ff #(.WIDTH(2), .STAGES(2)) u_cdc2_mode_eth (
        .dest_clk (clk_eth), .dest_rst_n (rst_n_eth),
        .i_src (cfg_mode), .o_dst (cfg_mode_eth));
    sync_ff #(.WIDTH(1), .STAGES(2)) u_cdc2_even_eth (
        .dest_clk (clk_eth), .dest_rst_n (rst_n_eth),
        .i_src (cfg_ev_en), .o_dst (cfg_ev_en_eth));

    // ---- RGS 配置位跨域（CDC-2：慢变同拍更新，两级同步器即可）----
    wire cfg_disp_mode_lcd;
    wire [3:0] cfg_layer_en_lcd;

    sync_ff #(.WIDTH(1), .STAGES(2)) u_cdc2_disp (
        .dest_clk (clk_lcd), .dest_rst_n (rst_n_lcd),
        .i_src    (cfg_disp_mode), .o_dst (cfg_disp_mode_lcd)
    );

    sync_ff #(.WIDTH(4), .STAGES(2)) u_cdc2_layer (
        .dest_clk (clk_lcd), .dest_rst_n (rst_n_lcd),
        .i_src    (cfg_layer_en), .o_dst (cfg_layer_en_lcd)
    );

    // ---- ★ WIRE-U3 HUD 参数的跨域（clk_cam → clk_lcd，慢变参数，两级同步即可）----
    //   这 5 个都是「用户按下按键/下发命令后才变」的慢变量，2FF 足够（与
    //   cfg_disp_mode/cfg_layer_en 同一纪律）。display_path 内部保持**单时钟域**。
    sync_ff #(.WIDTH(12), .STAGES(2)) u_cdc2_hud_theta (
        .dest_clk (clk_lcd), .dest_rst_n (rst_n_lcd),
        .i_src    (cfg_theta), .o_dst (hud_theta_lcd)
    );
    sync_ff #(.WIDTH(9), .STAGES(2)) u_cdc2_hud_mindl (
        .dest_clk (clk_lcd), .dest_rst_n (rst_n_lcd),
        .i_src    (cfg_min_dl), .o_dst (hud_min_dl_lcd)
    );
    sync_ff #(.WIDTH(2), .STAGES(2)) u_cdc2_hud_mode (
        .dest_clk (clk_lcd), .dest_rst_n (rst_n_lcd),
        .i_src    (cfg_mode), .o_dst (hud_mode_lcd)
    );
    sync_ff #(.WIDTH(1), .STAGES(2)) u_cdc2_hud_even (
        .dest_clk (clk_lcd), .dest_rst_n (rst_n_lcd),
        .i_src    (cfg_ev_en), .o_dst (hud_ev_en_lcd)
    );
    sync_ff #(.WIDTH(2), .STAGES(2)) u_cdc2_hud_baud (
        .dest_clk (clk_lcd), .dest_rst_n (rst_n_lcd),
        .i_src    (uart_baud_cur), .o_dst (hud_baud_lcd)
    );

    // ========================================================================
    // B3: 显示子系统（厂家 DDR3 通路 + 显示源选择 + HUD 叠加）
    // ========================================================================
    wire [15:0] bmp_rd_addr;
    wire [7:0]  bmp_rd_data;

    wire [15:0] stat_activity_lcd;
    wire [23:0] stat_ev_pf_lcd;
    wire [23:0] stat_cr_lcd;
    wire [31:0] stat_fcnt_lcd;

    wire raw_px_valid;
    wire [15:0] raw_px_data;
    wire raw_px_frame_start;        // ★ SEAM-LINKDROP：每帧首像素 1 拍（→ event_sink 第 17 bit）
    wire [23:0] dbg_lcd_rgb888;     // 真正送到 LCD 引脚的颜色（IOBUF 之前；仅 ILA 观测用）
    wire [32:0] dbg_sccb;           // ★ 实验档：SCCB 总线观测 bundle（仅 ILA 观测用，见 display_path 端口注释）

    display_path #(
        .LCD_W    (800),
        .LCD_H    (480),
        .EV_W     (400),
        .EV_H     (240),
        .USE_DDR3 (USE_DDR3),
        // ---- 帧率实验点（默认纯旁路）----
        .OVL_TIMING_EN (OVL_TIMING_EN),
        .OVL_SCAN_SEL  (OVL_SCAN_SEL),
        .OVL_HTS       (OVL_HTS),
        .OVL_VTS       (OVL_VTS),
        // ---- ★ sccb_patch 曝光上限补写（默认关）----
        .OVL_EXP_CAP_EN    (OVL_EXP_CAP_EN),
        .OVL_EXP_CAP_LINES (OVL_EXP_CAP_LINES),
        .OVL_AEC_CTRL_EN   (OVL_AEC_CTRL_EN),
        .OVL_MAN_EXP_EN    (OVL_MAN_EXP_EN)
    ) u_display_path (
        .clk_50m            (clk_cam),
        .rst_n_50m          (rst_n_cam),
        .clk_200m           (clk_200m),
        .clk_lcd            (clk_lcd),
        .rst_n_lcd          (rst_n_lcd),
        .i_exp_cap_val      (cfg_exp_cap),      // ★ 运行时可写 cap
        .i_exp_cap_upd      (cfg_exp_cap_upd),  // ★ 沿 = 重跑补写序列
        .cam_pclk           (cam_pclk),
        .cam_vsync          (cam_vsync),
        .cam_href           (cam_href),
        .cam_data           (cam_data),
        .cam_rst_n          (cam_rst_n),
        .cam_pwdn           (cam_pwdn),
        .cam_scl            (cam_scl),
        .cam_sda            (cam_sda),
        .ddr3_dq            (ddr3_dq),
        .ddr3_dqs_n         (ddr3_dqs_n),
        .ddr3_dqs_p         (ddr3_dqs_p),
        .ddr3_addr          (ddr3_addr),
        .ddr3_ba            (ddr3_ba),
        .ddr3_ras_n         (ddr3_ras_n),
        .ddr3_cas_n         (ddr3_cas_n),
        .ddr3_we_n          (ddr3_we_n),
        .ddr3_reset_n       (ddr3_reset_n),
        .ddr3_ck_p          (ddr3_ck_p),
        .ddr3_ck_n          (ddr3_ck_n),
        .ddr3_cke           (ddr3_cke),
        .ddr3_cs_n          (ddr3_cs_n),
        .ddr3_dm            (ddr3_dm),
        .ddr3_odt           (ddr3_odt),
        .lcd_rgb            (lcd_rgb),
        .lcd_hs             (lcd_hs),
        .lcd_vs             (lcd_vs),
        .lcd_de             (lcd_de),
        .lcd_pclk           (lcd_pclk),
        .lcd_bl             (lcd_bl),
        .lcd_rst            (lcd_rst),
        .cfg_disp_mode      (cfg_disp_mode_lcd),
        .cfg_layer_en       (cfg_layer_en_lcd),
        .cfg_beep_sel       (4'h0),
        .i_bmp_rd_data      (bmp_rd_data),
        .o_bmp_rd_addr      (bmp_rd_addr),
        .i_stat_activity_q16(stat_activity_lcd),
        .i_stat_ev_per_frame(stat_ev_pf_lcd),
        .i_stat_cr_x10      (stat_cr_lcd),
        .i_stat_frame_cnt   (stat_fcnt_lcd),
        .i_mode_tag         (mode_tag_lcd),     // ★ v3.1 LCD 模式标签
        .i_fps              (fps_lcd),          // ★ v3.1 LCD 帧率
        // ★ WIRE-U3 HUD 5 行参数（全部已在 clk_lcd 域）
        .i_theta            (hud_theta_lcd),
        .i_min_dl           (hud_min_dl_lcd),
        .i_ev_en            (hud_ev_en_lcd),
        .i_cfg_mode         (hud_mode_lcd),
        .i_uart_en          (UART_LINK_ON),
        .i_baud_sel         (hud_baud_lcd),
        .o_raw_px_valid     (raw_px_valid),
        .o_raw_px_data      (raw_px_data),
        .o_raw_frame_start  (raw_px_frame_start),
        .o_dbg_lcd_rgb888   (dbg_lcd_rgb888),
        .o_dbg_sccb         (dbg_sccb)          // ★ 实验档：SCCB 观测 bundle（ILA_EN=0 时未接 ⇒ 被裁掉）
    );

    // ========================================================================
    // B4: 事件引擎（retina_core；只读并联 tap）
    // ========================================================================
    wire        ev_valid;
    wire [8:0]  ev_x;
    wire [7:0]  ev_y;
    wire        ev_pol;

    wire [23:0] stat_ev_pf;
    wire [15:0] stat_activity;
    wire [23:0] stat_cr;
    wire [31:0] stat_fcnt;
    wire [31:0] stat_ev_total;
    wire [15:0] stat_ev_ovf;
    wire [15:0] stat_px_ovf;

    retina_core #(
        .IN_W (800),
        .IN_H (480),
        .EV_W (400),
        .EV_H (240)
    ) u_retina_core (
        .cam_pclk          (cam_pclk),
        .rst_n_pclk        (rst_n_pclk),
        .i_cam_data        (cam_data),
        .i_cam_vsync       (cam_vsync),
        .i_cam_href        (cam_href),
        .clk_cam           (clk_cam),
        .rst_n_cam         (rst_n_cam),
        .clk_lcd           (clk_lcd),
        .i_cfg_ev_en       (cfg_ev_en),
        .i_cfg_theta       (cfg_theta),
        .i_cfg_min_dl      (cfg_min_dl),
        .i_cfg_src         (CFG_SRC),           // 上板默认相机；无相机演示/仿真时置 1（自检图案）
        .i_cfg_pattern_mode(2'd2),
        .i_cfg_decay_en    (1'b1),
        .i_cfg_decay_step  (3'd1),
        .i_cfg_refr_bypass (1'b0),
        .o_ev_valid        (ev_valid),
        .o_ev_x            (ev_x),
        .o_ev_y            (ev_y),
        .o_ev_pol          (ev_pol),
        .i_bmp_rd_addr     (bmp_rd_addr),
        .o_bmp_rd_data     (bmp_rd_data),
        .o_stat_ev_per_frame(stat_ev_pf),
        .o_stat_activity_q16(stat_activity),
        .o_stat_cr_x10     (stat_cr),
        .o_stat_frame_cnt  (stat_fcnt),
        .o_stat_ev_total   (stat_ev_total),
        .o_stat_ev_fifo_ovf(stat_ev_ovf),
        .o_stat_px_fifo_ovf(stat_px_ovf)
    );

    // ========================================================================
    // ★ M4c：动作识别引擎（nn_top，单时钟 clk_cam）
    //   ev 线从 u_retina_core 输出**并联 tap**（与 event_sink 消费的是同一份线，
    //   不插 FIFO/门控/改动原有连接）。nn_top 内部特征累积/推理全部在 clk_cam，
    //   clk_200m/rst_n_200m 端口保留但 v2 不再使用（接顶层同源时钟/复位即可）。
    //   动作结果 → act_state_cdc（本文件下方唯一实例）→ act_byte_eth → byte23/TLV。
    // ========================================================================
    wire        nn_act_pulse;
    wire [1:0]  nn_act_class;
    wire [4:0]  nn_act_conf;

    nn_top u_nn_top (
        .clk_cam     (clk_cam),
        .rst_n_cam   (rst_n_cam),
        .i_ev_valid  (ev_valid),
        .i_ev_x      (ev_x),
        .i_ev_y      (ev_y),
        .i_ev_pol    (ev_pol),
        .o_act_pulse (nn_act_pulse),
        .o_act_class (nn_act_class),
        .o_act_conf  (nn_act_conf),
        .o_dbg_win   (),
        .o_dbg_busy  (),
        .clk_200m    (clk_200m),
        .rst_n_200m  (rst_n_200m)
    );

    // ========================================================================
    // B5: 事件分发（event_sink → UDP / HUD 统计 / 串口）
    // ========================================================================
    assign clk_eth   = eth_rxc;         // RGMII RX 时钟（PHY 提供，125 MHz）
    assign rst_n_eth = rst_n_200m;      // 结构性命中：以太网域复位取 200m 同步释放链

    wire        udp_tx_start;
    wire [7:0]  udp_tx_byte;
    wire        udp_tx_byte_en;
    wire [15:0] udp_tx_len;
    wire [15:0] udp_drop_px;
    wire [15:0] udp_drop_ev;
    wire [15:0] udp_ev_ovf;
    // ---- ★ v3 ----
    wire        udp_ctrl_empty;
    wire [15:0] udp_frame_idx;
    wire        dl_ctrl_wr_en;
    wire [7:0]  dl_ctrl_data;
    wire        dl_ctrl_commit;
    wire [7:0]  dl_frame_decim;
    wire [23:0] dl_ev_flush_cyc;
    wire [47:0] ts_aligned_us;      // udp_merge.i_ts_us（包头 TS 字段）
    wire [47:0] ts_local_us;        // 板端本机 µs（TIME_SYNC 的 t4）
    wire [47:0] ts_offset_us;       // offset_reg（TLV 0x84）
    wire        ts_valid_w, ts_cal_w, ts_stale_w;
    wire [15:0] ts_rtt_w;
    wire [31:0] boot_id_w;
    wire        ts_cal_req;
    wire [15:0] ts_cal_seq;
    wire [47:0] ts_board_ts;
    wire        ts_sync_matched;
    wire        ts_period_wr;
    wire [16:0] ts_period_s;
    wire        ts_force_cal;
    wire        ts_off_wr;
    wire [47:0] ts_off_data;
    // eth_udp 的反压（ETH_EN=0 时由下面的 generate 恒接 1'b1）
    // ⚠️ 实测缺陷修复（2026-10-06）：原实现把 event_sink 的 .i_tx_ready 硬接 1'b1，
    //    而 eth_udp.o_tx_ready 只在 wstate==W_IDLE 时为高。udp_merge 于是在 eth_udp
    //    仍处 W_LOAD/W_WAIT 时抢发下一包，而 eth_udp 在这两个状态**完全忽略 i_tx_start**
    //    ⇒ 每隔一包静默丢失（600 包/帧根本拼不回整帧）。反压必须接回来。
    wire eth_tx_ready;

    // ---- ★ WIRE-U1 串口链路公共线（UART_LINK_EN=0 时由下方 generate 显式置空）----
    wire        eth_rx_valid_w;         // 以太网 RX 字节流（FWFT valid）
    wire [7:0]  eth_rx_data_w;
    wire        eth_rx_rd_en;           // 以太网 RX FIFO 读使能（=0 分支恒 1）
    wire        dl_rx_valid;            // 合流后送共用解析器的字节流
    wire [7:0]  dl_rx_data;
    wire        dl_rx_pkt_done;
    wire        dl_rx_stream;           // 1 = 本拍字节来自串口
    wire        dl_ctrl_empty;          // UDP + 串口两侧 CTRL 消费者都就绪
    wire        udp_ctrl_rdy;           // UDP 侧 CTRL 就绪（ETH_EN=0 时恒 1）
    wire        dl_accepted_w;          // 合法下行帧被接受（link_detect L2）
    wire        ts_probe_req;           // link_detect 探针脉冲
    wire        ts_force_all;           // 下行 tag 0x06 / 探针 相或
    wire [1:0]  net_state_w;            // 0=DOWN/1=UP/2=UNKNOWN（TLV 0x8F）
    wire        net_ok_w;
    wire        net_chg_w;
    wire [7:0]  uart_ev_drop8;          // uartEvDrop[7:0]（clk_cam 域）
    wire [7:0]  ser_drop_sync;          // 跨到 clk_eth（两级同步，TLV 0x8E 第 3 字节）
    // 事件帧源（uart_ev_tap → uart_link）
    wire        ev_frdy, ev_fbusy, ev_fvalid, ev_fack, ev_fstart;
    wire [7:0]  ev_fdata;
    // CTRL 字节流（uart_dl_bridge → uart_link，clk_cam 读侧）
    wire        ctrl_valid, ctrl_eop, ctrl_rd_en;
    wire [7:0]  ctrl_data;
    // 串口 RX 字节流（uart_link → uart_dl_bridge）
    wire        urx_valid, urx_ack;
    wire [7:0]  urx_data;

    assign ts_force_all = ts_force_cal | ts_probe_req;   // 结构性相或（无业务判断）

    //========================================================================
    // ★ M4b：动作字节锁存 + clk_cam → clk_eth 跨域（task-11）
    //   唯一实例：同一份锁存值同时供数据帧 byte23（event_sink→udp_merge）与
    //   GET_STATUS ACK 的 TLV 0x92（downlink_cmd）⇒ 两通道严格同快照（契约 §3）。
    //   ★ M4c：输入已实接 u_nn_top.o_act_pulse/o_act_class/o_act_conf（clk_cam 域）；
    //   nn_top 复位后未判定时 act_byte=0x00（VALID=0），判定后锁存"最近一次有效
    //   class/conf + VALID=1"，不在每帧后清零（契约 §2.5）。
    //========================================================================
    wire [7:0] act_byte_eth;

    act_state_cdc u_act_state_cdc (
        .clk_cam     (clk_cam),
        .rst_n_cam   (rst_n_cam),
        .i_act_pulse (nn_act_pulse),// ★ M4c: u_nn_top.o_act_pulse（clk_cam 域单拍）
        .i_act_class (nn_act_class),// ★ M4c: u_nn_top.o_act_class
        .i_act_conf  (nn_act_conf), // ★ M4c: u_nn_top.o_act_conf
        .clk_eth     (clk_eth),
        .rst_n_eth   (rst_n_eth),
        .o_act_byte  (act_byte_eth)
    );

    event_sink #(
        .EV_W (400), .EV_H (240),
        .WIRE_VER (3)                   // ★ v3（回退改 2 = v2 13B 包头）
    ) u_event_sink (
        .cam_pclk           (cam_pclk),
        .rst_n_pclk         (rst_n_pclk),
        .i_raw_valid        (raw_px_valid),
        .i_raw_data         (raw_px_data),
        .i_raw_frame_start  (raw_px_frame_start),   // ★ SEAM-LINKDROP
        .clk_cam            (clk_cam),
        .rst_n_cam          (rst_n_cam),
        .i_ev_valid         (ev_valid),
        .i_ev_x             (ev_x),
        .i_ev_y             (ev_y),
        .i_ev_pol           (ev_pol),
        .i_stat_ev_per_frame(stat_ev_pf),
        .i_stat_activity_q16(stat_activity),
        .i_stat_cr_x10      (stat_cr),
        .i_stat_frame_cnt   (stat_fcnt),
        .i_stat_ev_total    (stat_ev_total),
        .i_cfg_en           (cfg_ev_en),
        .clk_eth            (clk_eth),
        .rst_n_eth          (rst_n_eth),
        .i_tx_ready         (eth_tx_ready),
        .i_mode             (cfg_mode_eth),
        .i_ts_us            (ts_aligned_us),
        .i_ts_valid         (ts_valid_w),
        .i_ts_calibrated    (ts_cal_w),
        .i_ev_en            (cfg_ev_en_eth),
        .i_frame_decim      (dl_frame_decim),
        .i_ev_flush_cyc     (dl_ev_flush_cyc),
        .i_act_byte         (act_byte_eth),         // ★ M4b：byte23 来源（每帧锁存）
        .i_ctrl_wr_en       (dl_ctrl_wr_en),
        .i_ctrl_data        (dl_ctrl_data),
        .i_ctrl_commit      (dl_ctrl_commit),
        .o_ctrl_empty       (udp_ctrl_empty),
        .o_frame_idx        (udp_frame_idx),
        .o_tx_start         (udp_tx_start),
        .o_tx_byte          (udp_tx_byte),
        .o_tx_byte_en       (udp_tx_byte_en),
        .o_tx_len           (udp_tx_len),
        .o_stat_drop_px     (udp_drop_px),
        .o_stat_drop_ev     (udp_drop_ev),
        .o_stat_ev_fifo_ovf (udp_ev_ovf),
        .clk_lcd            (clk_lcd),
        .rst_n_lcd          (rst_n_lcd),
        .o_stat_ev_per_frame_lcd(stat_ev_pf_lcd),
        .o_stat_activity_q16_lcd(stat_activity_lcd),
        .o_stat_cr_x10_lcd  (stat_cr_lcd),
        .o_stat_frame_cnt_lcd(stat_fcnt_lcd)
    );

    //========================================================================
    // B5.1: ★ v3 板端时间戳发生器（ts_gen，clk_eth 域，与 udp_merge 同域无 CDC）
    //========================================================================
    ts_gen #(
        .CLK_DIV        (125),          // 125 MHz ÷ 125 = 1 µs（§4.1 精确整除）
        .FIRST_CAL_US   (48'd5_000_000),
        .CAL_PERIOD_S   (17'd600),
        .BOOT_ID        (32'h5254_4E41) // "RTNA"（无 NV，见报告遗留问题）
    ) u_ts_gen (
        .clk_eth        (clk_eth),
        .rst_n_eth      (rst_n_eth),
        .i_off_wr_en    (ts_off_wr),
        .i_off_data     (ts_off_data),
        .i_period_wr_en (ts_period_wr),
        .i_period_s     (ts_period_s),
        .i_force_cal    (ts_force_all),   // ★ WIRE-U1：下行 tag 0x06 或检测器探针
        .i_sync_matched (ts_sync_matched),
        .o_cal_req      (ts_cal_req),
        .o_cal_seq      (ts_cal_seq),
        .o_board_ts_us  (ts_board_ts),
        .o_ts_local_us  (ts_local_us),
        .o_ts_aligned_us(ts_aligned_us),
        .o_ts_valid     (ts_valid_w),
        .o_ts_calibrated(ts_cal_w),
        .o_ts_stale     (ts_stale_w),
        .o_offset_reg   (ts_offset_us),
        .o_rtt_us       (ts_rtt_w),
        .o_boot_id      (boot_id_w)
    );

    //========================================================================
    // B5.2: ★ v3 下行命令解析 / ACK 构包（downlink_cmd，clk_eth 域）
    //========================================================================
    wire        rx_rd_valid;
    wire [7:0]  rx_rd_data;
    wire        rx_pkt_done;
    wire [15:0] rx_ovf_cnt;

    downlink_cmd #(
        .HEARTBEAT_CYC (125_000_000),   // 1 Hz 心跳（§6.3.5）
        .FW_VER        (16'h0003),
        .WIRE_VER_B    (8'h03)
    ) u_downlink_cmd (
        .clk_eth        (clk_eth),
        .rst_n_eth      (rst_n_eth),
        .i_rx_valid     (dl_rx_valid),      // ★ WIRE-U1：UDP/串口合流后的字节流
        .i_rx_data      (dl_rx_data),
        .o_rx_rd_en     (),
        .i_rx_pkt_done  (dl_rx_pkt_done),
        .i_rx_stream    (dl_rx_stream),     // ★ 串口流（逐字节重同步）
        .i_net_state    (net_state_w),      // ★ link_detect 状态（TLV 0x8F）
        .i_net_chg      (net_chg_w),        // ★ 状态变化 ⇒ 即时插发 CTRL
        .i_ser_drop     (ser_drop_sync),    // ★ uartEvDrop（TLV 0x8E 第 3 字节）
        .i_mode         (cfg_mode_eth),
        .i_ts_us        (ts_aligned_us),
        .i_ts_local_us  (ts_local_us),
        .i_ts_offset    (ts_offset_us),
        .i_ts_valid     (ts_valid_w),
        .i_ts_calibrated(ts_cal_w),
        .i_ts_stale     (ts_stale_w),
        .i_rtt_us       (ts_rtt_w),
        .i_boot_id      (boot_id_w),
        .i_frame_idx    (udp_frame_idx),
        .i_drop_px      (udp_drop_px),
        .i_drop_ev      (udp_drop_ev),
        .i_ev_en        (cfg_ev_en_eth),
        .i_act_byte     (act_byte_eth),     // ★ M4b：TLV 0x92（与 byte23 同源）
        .i_cal_req      (ts_cal_req),
        .i_cal_seq      (ts_cal_seq),
        .i_board_ts     (ts_board_ts),
        .o_sync_matched (ts_sync_matched),
        .o_theta        (dl_theta),
        .o_theta_upd    (dl_theta_upd),
        .o_min_dl       (dl_min_dl),
        .o_min_dl_upd   (dl_min_dl_upd),
        .o_mode_set     (dl_mode_set),
        .o_mode_set_upd (dl_mode_set_upd),
        .o_ev_en        (dl_ev_en_set),
        .o_ev_en_upd    (dl_ev_en_set_upd),
        .o_frame_decim  (dl_frame_decim),
        .o_ev_flush_cyc (dl_ev_flush_cyc),
        // ★ WIRE-U1 SER 参数组（→ sys_ctrl 的 toggle+值 CDC）
        .o_ev_res       (dl_ev_res),
        .o_ev_res_upd   (dl_ev_res_upd),
        .o_ser_decim    (dl_ser_decim),
        .o_ser_decim_upd(dl_ser_decim_upd),
        .o_ser_agg      (dl_ser_agg),
        .o_ser_agg_upd  (dl_ser_agg_upd),
        .o_ser_flush_ms (dl_ser_flush),
        .o_ser_flush_upd(dl_ser_flush_upd),
        // ★ 曝光上限（SET_PARAM tag 0x0B）—— 2026-10-13 曝光生效验证任务修复：
        //   这两条**原先漏接**（`dl_exp_cap`/`dl_exp_cap_upd` 只有声明与下游 CDC 的
        //   消费端，没有驱动源）⇒ 命令永远到不了 sys_ctrl ⇒ sccb_patch 永不重触发
        //   （板会 E4 负向对照不复现的直接原因）。ModelSim 判据原文：
        //     vopt-2685 Too few port connections for 'u_downlink_cmd'. Expected 60, found 58.
        //     vopt-2718 Missing connection for port 'o_exp_cap_upd' / 'o_exp_cap'
        .o_exp_cap      (dl_exp_cap),
        .o_exp_cap_upd  (dl_exp_cap_upd),
        // ★ WIRE-U2：波特率档位（commit 只在 ACK 整包进 CTRL FIFO 后翻一次）
        .o_ser_baud_sel    (dl_ser_baud_sel),
        .o_ser_baud_commit (dl_ser_baud_commit),
        .o_dl_accepted  (dl_accepted_w),
        .o_period_wr    (ts_period_wr),
        .o_period_s     (ts_period_s),
        .o_force_cal    (ts_force_cal),
        .o_off_wr       (ts_off_wr),
        .o_off_data     (ts_off_data),
        .o_ctrl_wr_en   (dl_ctrl_wr_en),
        .o_ctrl_data    (dl_ctrl_data),
        .o_ctrl_commit  (dl_ctrl_commit),
        .i_ctrl_empty   (dl_ctrl_empty),    // ★ WIRE-U1：UDP+串口两侧都腾空才开新包
        .o_stat_dl_crc_fail  (),
        .o_stat_dl_bad_opcode(),
        .o_stat_dl_reject    ()
    );

    //========================================================================
    // B5.3: ★ v3.1 LCD 帧率表（用户需求 2026-10-11）
    //   事件/合成画面 → 事件帧率；纯原始画面 → 采集帧率（fps_meter 内选择）
    //========================================================================
    fps_meter #(
        .CLK_FREQ_HZ (50000000)
    ) u_fps_meter (
        .clk_cam        (clk_cam),
        .rst_n_cam      (rst_n_cam),
        .i_frame_cnt    (stat_fcnt),
        .i_ev_per_frame (stat_ev_pf),
        .i_show_ev      (cfg_disp_mode),
        .i_mode         (cfg_mode),
        .o_fps          (fps_val),
        .o_mode_tag     (mode_tag_cam)
    );

    sync_ff #(.WIDTH(8), .STAGES(2)) u_cdc2_fps (
        .dest_clk (clk_lcd), .dest_rst_n (rst_n_lcd),
        .i_src (fps_val), .o_dst (fps_lcd));
    sync_ff #(.WIDTH(2), .STAGES(2)) u_cdc2_mtag (
        .dest_clk (clk_lcd), .dest_rst_n (rst_n_lcd),
        .i_src (mode_tag_cam), .o_dst (mode_tag_lcd));

    // ========================================================================
    // B6: 通信（以太网 / 串口）—— P1，可裁剪
    // ========================================================================
    generate
    if (ETH_EN != 0) begin : g_eth
        // eth_udp 封装厂家 ARP/UDP/RGMII 协议栈，并负责 o_tx_ready 反压
        // （eth_tx_ready 已在顶层声明，并接到 event_sink.i_tx_ready）
        eth_udp u_eth_udp (
            .clk_eth        (clk_eth),
            .rst_n_eth      (rst_n_eth),
            .clk_ref_200m   (clk_200m),
            .eth_rxc        (eth_rxc),
            .eth_rx_ctl     (eth_rx_ctl),
            .eth_rxd        (eth_rxd),
            .eth_txc        (eth_txc),
            .eth_tx_ctl     (eth_tx_ctl),
            .eth_txd        (eth_txd),
            .eth_rst_n      (eth_rst_n),
            .i_tx_start     (udp_tx_start),
            .i_tx_byte      (udp_tx_byte),
            .i_tx_byte_en   (udp_tx_byte_en),
            .i_tx_len       (udp_tx_len),
            .o_tx_ready     (eth_tx_ready),
            // ★ v3 下行 RX 通路 → downlink_cmd
            .o_rx_rd_valid  (rx_rd_valid),
            .o_rx_rd_data   (rx_rd_data),
            .i_rx_rd_en     (eth_rx_rd_en),     // ★ WIRE-U1：由合流器给读使能（默认分支恒 1）
            .o_rx_pkt_done  (rx_pkt_done),
            .o_rx_ovf       (rx_ovf_cnt)
        );
    end else begin : g_no_eth
        assign eth_txc    = 1'b0;
        assign eth_tx_ctl = 1'b0;
        assign eth_txd    = 4'h0;
        assign eth_rst_n  = 1'b1;
        assign eth_tx_ready = 1'b1;      // 无以太网 ⇒ udp_merge 不受反压
        // ★ v3：无以太网 ⇒ 下行解析器保持空闲（无 X 传播）
        assign rx_rd_valid  = 1'b0;
        assign rx_rd_data   = 8'h00;
        assign rx_pkt_done  = 1'b0;
        assign rx_ovf_cnt   = 16'd0;
    end
    endgenerate

    // ========================================================================
    // B6.1: ★ WIRE-U1 串口事件回传链路（UART_LINK_EN=1 才例化；默认 0 零影响）
    //
    //   uart_ev_tap  事件抽点/聚合 → v3 事件帧（clk_cam）
    //   uart_link    波特发生器 + TX/RX + 遥测帧/ASCII + 三路仲裁（clk_cam）
    //   uart_dl_bridge  CTRL 出/串口 RX 入的跨域 FIFO + 与 UDP 合流（双时钟）
    //   link_detect  网口可用性检测（clk_eth；探针经 ts_gen 的 0x83 通道）
    // ========================================================================
    generate
    if (UART_LINK_EN != 0) begin : g_uart_link

        // ---- CTRL 流出（downlink_cmd → 串口）----
        wire       ctrl_fifo_empty_eth;
        // ---- 检测器 ----
        // ---- 事件支路 ----
        uart_ev_tap #(
            .CLK_HZ      (50000000),
            .EV_MAX_PACK (289)
        ) u_uart_ev_tap (
            .clk             (clk_cam),
            .rst_n           (rst_n_cam),
            .i_ev_valid      (ev_valid),
            .i_ev_x          (ev_x),
            .i_ev_y          (ev_y),
            .i_ev_pol        (ev_pol),
            .i_frame_cnt     (stat_fcnt),        // 与 UDP 路线同源帧计数
            .i_mode          (cfg_mode),
            .i_ev_en         (cfg_ev_en),
            .i_ser_decim     (cfg_ser_decim),
            .i_ev_res        (cfg_ev_res),
            .i_ser_agg       (cfg_ser_agg),
            .i_ser_flush_ms  (cfg_ser_flush_ms),
            .o_frdy          (ev_frdy),
            .o_fbusy         (ev_fbusy),
            .o_fvalid        (ev_fvalid),
            .o_fdata         (ev_fdata),
            .i_fack          (ev_fack),
            .i_fstart        (ev_fstart),
            .o_stat_drop     (uart_ev_drop8)
        );

        // ---- ★ WIRE-U2：波特率档位跨域（clk_eth → clk_cam）----
        //   与 F3 修复同源：值 + toggle 成对过域（cdc_tog_word 静默窗后同拍提交），
        //   避免两条独立 2FF 链各自判决导致"档位旧 / commit 新"（会把旧档重写一遍）。
        wire [1:0] baud_sel_cam;
        wire       baud_tog_cam;
        cdc_tog_word #(.WIDTH(2), .STAGES(2), .SETTLE(3)) u_cdc2_baud (
            .dst_clk  (clk_cam),          .dst_rst_n (rst_n_cam),
            .i_src_val(dl_ser_baud_sel),  .i_src_tog (dl_ser_baud_commit),
            .o_dst_val(baud_sel_cam),     .o_dst_tog (baud_tog_cam));
        reg baud_tog_d;
        always @(posedge clk_cam or negedge rst_n_cam) begin
            if (!rst_n_cam) baud_tog_d <= 1'b0;
            else            baud_tog_d <= baud_tog_cam;
        end
        wire baud_pend_pulse = baud_tog_cam ^ baud_tog_d;   // 1 拍：新档位到达

        // ---- 串口链路（TX/RX + 遥测 + 仲裁）----
        uart_link #(
            .CLK_HZ          (50000000),
            .BAUD            (UART_BAUD),
            .OS              (16),
            .TELEM_PERIOD_MS (250),
            .CRC8_POLY       (8'h07),
            .ASCII_TELEM     (1)
        ) u_uart_link (
            .clk_cam            (clk_cam),
            .rst_n_cam          (rst_n_cam),
            .uart_rxd           (uart_rxd),
            .uart_txd           (uart_txd),
            .i_stat_ev_per_frame(stat_ev_pf),
            .i_stat_activity_q16(stat_activity),
            .i_stat_cr_x10      (stat_cr),
            .i_stat_frame_cnt   (stat_fcnt),
            .i_stat_mode        (stat_mode),
            .i_key_pressed      (key_pressed),
            .i_cfg_ev_en        (cfg_ev_en),
            .i_frdy             (ev_frdy),
            .i_fbusy            (ev_fbusy),
            .i_fvalid           (ev_fvalid),
            .i_fdata            (ev_fdata),
            .o_fack             (ev_fack),
            .o_fstart           (ev_fstart),
            .i_ctrl_valid       (ctrl_valid),
            .i_ctrl_data        (ctrl_data),
            .i_ctrl_eop         (ctrl_eop),
            .o_ctrl_rd_en       (ctrl_rd_en),
            .o_urx_valid        (urx_valid),
            .o_urx_data         (urx_data),
            .i_urx_ack          (urx_ack),
            .o_stat_b_cmd       (),
            .o_stat_rx_drop     (),
            // ★ WIRE-U2：4 档波特率（uart_link 内部等"真空闲"才真正换分频）
            .i_baud_sel         (baud_sel_cam),
            .i_baud_pending     (baud_pend_pulse),
            .o_baud_cur         (uart_baud_cur)     // ★ WIRE-U3：喂 HUD 行5
        );

        // ---- 跨域桥 + 与 UDP 字节流合流到共用解析器 ----
        uart_dl_bridge #(
            .CTRL_DEPTH (256),
            .URX_DEPTH  (256)
        ) u_uart_dl_bridge (
            .clk_cam        (clk_cam),
            .rst_n_cam      (rst_n_cam),
            .clk_eth        (clk_eth),
            .rst_n_eth      (rst_n_eth),
            .i_ctrl_wr_en   (dl_ctrl_wr_en),
            .i_ctrl_data    (dl_ctrl_data),
            .i_ctrl_commit  (dl_ctrl_commit),
            .o_ctrl_full    (),
            .i_ctrl_rd_en   (ctrl_rd_en),
            .o_ctrl_valid   (ctrl_valid),
            .o_ctrl_data    (ctrl_data),
            .o_ctrl_eop     (ctrl_eop),
            .o_ctrl_empty_eth(ctrl_fifo_empty_eth),
            .i_urx_valid    (urx_valid),
            .i_urx_data     (urx_data),
            .o_urx_ack      (urx_ack),
            .i_eth_valid    (rx_rd_valid),
            .i_eth_data     (rx_rd_data),
            .o_eth_rd_en    (eth_rx_rd_en),
            .i_eth_pkt_done (rx_pkt_done),
            .o_dl_valid     (dl_rx_valid),
            .o_dl_data      (dl_rx_data),
            .o_dl_stream    (dl_rx_stream),
            .o_dl_pkt_done  (dl_rx_pkt_done),
            .o_stat_urx_ovf (),
            .o_stat_ctrl_ovf()
        );

        // ---- 网口可用性检测（§5；探针 = ts_gen 的 0x83 REQ 通道）----
        link_detect #(
            .CLK_HZ        (125_000_000),
            .FIRST_MS      (5000),
            .PROBE_N       (3),
            .PROBE_GAP_MS  (1000),
            .PROBE_WAIT_MS (800),
            .HOLD_MS       (10000),
            .RECHECK_MS    (60000)
        ) u_link_detect (
            .clk_eth        (clk_eth),
            .rst_n_eth      (rst_n_eth),
            .i_eth_plug     (1'b1),             // L1 缺省恒 1（设计 §5.1 允许）
            .i_dl_valid     (dl_accepted_w),
            .o_probe_req    (ts_probe_req),
            .o_net_ok       (net_ok_w),
            .o_net_state    (net_state_w),
            .o_state_chg    (net_chg_w)
        );

        // CTRL 就绪：UDP 侧 + 串口侧都腾空才允许开新包（控制器级串行化）
        assign udp_ctrl_rdy  = (ETH_EN != 0) ? udp_ctrl_empty : 1'b1;
        assign dl_ctrl_empty = udp_ctrl_rdy & ctrl_fifo_empty_eth;

        // uartEvDrop 跨域（8 bit 电平，两级同步；计数快变时单次读回可能瞬时不一致）
        sync_ff #(.WIDTH(8), .STAGES(2)) u_cdc2_drop (
            .dest_clk (clk_eth), .dest_rst_n (rst_n_eth),
            .i_src (uart_ev_drop8), .o_dst (ser_drop_sync));

    end else begin : g_no_uart_link
        // 默认分支：与改动前逐比特一致（UDP 直连解析器、串口 TX 空闲）
        assign eth_rx_rd_en  = 1'b1;
        assign dl_rx_valid   = rx_rd_valid;
        assign dl_rx_data    = rx_rd_data;
        assign dl_rx_pkt_done= rx_pkt_done;
        assign dl_rx_stream  = 1'b0;
        assign udp_ctrl_rdy  = 1'b1;
        assign dl_ctrl_empty = udp_ctrl_empty;
        assign ser_drop_sync = 8'h00;
        assign net_ok_w      = 1'b0;
        // 未例化检测器：NET_STATE 报 UNKNOWN（2）——"未判定"，不冒充 DOWN
        assign net_state_w   = 2'd2;
        assign net_chg_w     = 1'b0;
        assign ts_probe_req  = 1'b0;
        assign uart_ev_drop8 = 8'h00;
        assign uart_baud_cur = 2'd0;            // ★ WIRE-U3：无 UART ⇒ HUD 显示 BAUD ---
        assign ev_frdy = 1'b0; assign ev_fbusy = 1'b0; assign ev_fvalid = 1'b0;
        assign ev_fdata = 8'h00; assign ev_fack = 1'b0; assign ev_fstart = 1'b0;
        assign ctrl_valid = 1'b0; assign ctrl_eop = 1'b0; assign ctrl_data = 8'h00;
        assign ctrl_rd_en = 1'b0;
        assign urx_valid = 1'b0; assign urx_data = 8'h00;
    end
    endgenerate

    generate
    if ((UART_LINK_EN == 0) && (UART_EN != 0)) begin : g_uart
        uart_telemetry u_uart_telemetry (
            .clk_cam            (clk_cam),
            .rst_n_cam          (rst_n_cam),
            .uart_rxd           (uart_rxd),
            .uart_txd           (uart_txd),
            .i_stat_ev_per_frame(stat_ev_pf),
            .i_stat_activity_q16(stat_activity),
            .i_stat_cr_x10      (stat_cr),
            .i_stat_frame_cnt   (stat_fcnt),
            .i_stat_mode        (stat_mode),
            .i_key_pressed      (key_pressed),
            .i_cfg_ev_en        (cfg_ev_en)
        );
    end else if ((UART_LINK_EN == 0) && (UART_EN == 0)) begin : g_no_uart
        assign uart_txd = 1'b1;         // 空闲高
    end
    // ★ WIRE-U1：UART_LINK_EN != 0 时 uart_txd 由 B6.1 的 u_uart_link 驱动
    endgenerate

    // ========================================================================
    // B7: 板级指示（纯位置指示，无业务逻辑）
    // ========================================================================
    assign led[0] = locked;             // MMCM 锁定
    assign led[1] = stat_mode;          // 显示源：0 = 原始画面，1 = 事件画面
    assign led[2] = cfg_ev_en;          // 事件支路使能
    assign led[3] = stat_fcnt[24];      // 心跳（帧计数高位翻转）

    assign beep = 1'b0;                 // 本期不发声

    // ========================================================================
    // B8: 调试用 ILA（只有 ILA_EN=1 才例化；**交付构建必须为 0**，否则资源统计不准）
    //
    // 目的（2026-10-06）——把两件"只能靠人/靠推断"的事变成机器证据：
    //   ① ILA-CAM（clk = cam_pclk）：探 cam_href / cam_vsync / cam_data + 一个
    //      **200 MHz 自由计数器** ⇒ 相邻样本的计数差 = 一个 cam_pclk 周期里有多少个
    //      200 MHz 拍 ⇒ **cam_pclk 周期的直接实测值**（分辨率 5 ns，足够把 XDC 里
    //      推断的 20.833 ns 与厂家笔误的 40 ns 区分开），同时可核对 DVP 行/场结构。
    //   ② ILA-LCD（clk = clk_lcd）：探 lcd_de / lcd_hs / lcd_vs / lcd_rgb / 帧计数 /
    //      eth_tx_ctl ⇒ 用机器证据证明"DDR3 读回 → LCD 扫描输出"确实在跑，
    //      替代"必须站在板子前看屏"这一步。
    //
    // 两个实例复用同一个 IP（`tool/create_ila_ip.tcl` 建的 ila_dbg），
    // 因此两边**探针位宽必须一致**：1,1,8,16,16,16,1,8（共 67 bit）。
    // ========================================================================
    generate
    if (ILA_EN != 0) begin : g_ila

        // 200 MHz 自由计数器（仅调试用；ILA-CAM 每拍采一次 ⇒ 差值是周期实测）
        reg [15:0] dbg_cnt200;
        always @(posedge clk_200m) dbg_cnt200 <= dbg_cnt200 + 16'd1;

        // ---- ① 相机域：cam_pclk 周期实测 + DVP 结构 ----
        ila_dbg u_ila_cam (
            .clk    (cam_pclk),
            .probe0 (cam_href),
            .probe1 (cam_vsync),
            .probe2 (cam_data),
            .probe3 (dbg_cnt200),
            .probe4 (16'd0),
            .probe5 (16'd0),
            .probe6 (1'b0),
            .probe7 (8'd0)
        );

        // ---- ② 显示域：LCD 扫描输出是否在跑 + 内容是否在变 ----
        //   ⚠️ 不能直接探 `lcd_rgb`（inout 的 IOBUF pad 侧）或 `eth_tx_ctl`
        //      （ODDR 输出）：实测会触发
        //        [DRC REQP-1582] iobuf_io_loaded ...
        //        [DRC REQP-1884] ODDR_has_invalid_load ...
        //      导致 place_design 直接不跑。所以颜色取 IOBUF 之前的 `dbg_lcd_rgb888`
        //      （= `hud_inject` 的输出，也就是真正被三态送到引脚的那一个）。
        //   ⚠️ 别探 `ovl_rgb`（HUD **叠加层自己**的颜色，只在 ovl_hit 像素上有效）——
        //      实测探它只得到调色板常量（R∈{0x00,0x20}、B∈{0x00,0xff}），
        //      会误判成"画面是死的"。
        ila_dbg u_ila_lcd (
            .clk    (clk_lcd),
            .probe0 (lcd_de),
            .probe1 (lcd_vs),
            .probe2 (dbg_lcd_rgb888[23:16]),   // R（真正送屏的颜色，fabric 侧）
            .probe3 (stat_fcnt_lcd[15:0]),      // 相机帧计数（证明整条链在推进）
            .probe4 ({8'd0, dbg_lcd_rgb888[7:0]}), // B（真正送屏的颜色）
            .probe5 (stat_ev_pf_lcd[15:0]),     // 每帧事件数（低 16 位）
            .probe6 (lcd_hs),
            .probe7 ({7'd0, stat_mode})         // KEY0 选的显示源
        );

        // ---- ③ 串口域：`uart_txd` 引脚波形（证明真的在按 921600 8N1 发）----
        //   本机只枚举出 FTDI **A** 通道（= JTAG），没有 B 通道的 COM 口 ⇒ "板子→PC"
        //   那一段无法在本机验证；但可以在**引脚上**把波形抓下来解码，量出位周期
        //   （= 波特率）并逐帧校验 8N1 结构。这是该项能拿到的最强机器证据。
        ila_dbg u_ila_uart (
            .clk    (clk_cam),
            .probe0 (uart_txd),
            .probe1 (uart_rxd),
            .probe2 (8'd0),
            .probe3 (dbg_cnt200),
            .probe4 (16'd0),
            .probe5 (16'd0),
            .probe6 (1'b0),
            .probe7 (8'd0)
        );

        // ---- ④ ★ SCCB 域（2026-10-13 曝光生效验证任务）：EXP_CAP 补写的真实总线波形 ----
        //   独立 IP `ila_sccb`（不是 ila_dbg）：**深度 32768** @ 50 MHz = 655 µs 窗口，
        //   才装得下整条补写序列（4 条事务 ≈ 612 µs；ila_dbg 的 4096 = 82 µs 连一条
        //   事务都装不下）。13 个探针 / 共 33 bit，全部来自 display_path 的 `o_dbg_sccb`
        //   观测 bundle（**不含任何 inout pad 网**，规避 [DRC REQP-1582]）。
        //   触发建议（tool/ila_capture_sccb.tcl）：
        //     · probe0 patch_owner 上升沿        → 抓整条序列（trigger position 置 0）
        //     · probe10 done_cnt == 2（掩码比较）→ 抓后半段（前一次窗口不够时的兜底）
        ila_sccb u_ila_sccb (
            .clk    (clk_cam),
            .probe0 (dbg_sccb[0]),          // patch_owner
            .probe1 (dbg_sccb[1]),          // patch_scl
            .probe2 (dbg_sccb[2]),          // dbg_sda_pad_r（pad SDA 电平）
            .probe3 (dbg_sccb[3]),          // patch_sda_oe
            .probe4 (dbg_sccb[4]),          // patch_sda（输出值）
            .probe5 (dbg_sccb[5]),          // dri_scl（厂家 SCL）
            .probe6 (dbg_sccb[6]),          // cam_init_done_w
            .probe7 (dbg_sccb[7]),          // patch_done
            .probe8 (dbg_sccb[8]),          // dbg_capupd_s2（命令 toggle）
            .probe9 (dbg_sccb[9]),          // dbg_txn_mark（事务结束标记）
            .probe10(dbg_sccb[12:10]),      // patch_done_cnt[2:0]
            .probe11(dbg_sccb[15:13]),      // patch_ack_cnt[2:0]
            .probe12(dbg_sccb[31:16])       // i_exp_cap_val[15:0]
        );

    end
    endgenerate

endmodule

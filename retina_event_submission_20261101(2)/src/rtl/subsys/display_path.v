//==============================================================================
// display_path -- 显示子系统（L3）：摄像头→DDR3→LCD 底座 + 显示源选择 + HUD 叠加
//
// 规格：retina_event/docs/子模块设计/L3_L4_集成/display_path.md
//
// ★ 两条实现路径（由 USE_DDR3 选择）：
//
//   USE_DDR3=1（默认，上板）—— 厂家已验证的显示通路，**一个字节不改**：
//       picture_size → ov5640_dri → ddr3_top(MIG) → lcd_driver
//     我们只在**"颜色"这一级**插进去：
//       lcd_driver 输出的 16bit 原画 ─┐
//                                    ├─► disp_mux（KEY0 选源）─► hud_inject（OVL 叠加）─► lcd_rgb inout
//       event_render 出的事件画面 ───┘
//     ⚠️ 为什么保留厂家 `lcd_driver` 而不是换成自研 `lcd_scanout`：
//       `lcd_driver` 与 `ddr3_top` 之间是 **data_req/rddata 请求式握手**，
//       而 `lcd_scanout` 只有固定速率像素流、没有该握手。换掉它就要重新验证
//       DDR3 读通路的取数时序 + `lcd_rgb` inout 的开机读 ID 纪律（H33），
//       风险落在整条显示链最贵的地方。故：**动颜色，不动时序与握手**。
//       `lcd_scanout` 在 USE_DDR3=0 路径里使用（见下），并在集成仿真里被端到端跑到。
//
//   USE_DDR3=0（备选方案 B / 集成仿真）—— 不碰 DDR3、不碰摄像头：
//       vps_pattern_gen(clk_lcd, 1056×525) + lcd_scanout 自产 800×480 时序
//     ⇒ 事件链 + HUD + 事件画面全部可以端到端仿真，无需 MIG 模型。
//
// ⚠️ `lcd_rgb` 是 inout：`lcd_de=0` 时必须释放（{24{1'bz}}），否则开机读屏 ID 会坏。
//    本模块保持厂家写法，只在 `lcd_de=1` 时驱动颜色。
//
// ⚠️ 位图 B 口仲裁：`retina_core` 的位图 BRAM 只有一路 B 口读接口，
//    `event_render`（全屏事件画面）与 `hud_event_layer`（HUD 里的事件小图）都想读。
//    ⇒ 按 `cfg_disp_mode` 分时：事件画面模式给 event_render，原始画面模式给 hud_event_layer。
//       另一方 `ovl_en` 被门控，读到的是无效数据但不使用。
//==============================================================================
`timescale 1ns / 1ps

module display_path #(
    parameter LCD_W     = 800,
    parameter LCD_H     = 480,
    parameter EV_W      = 400,
    parameter EV_H      = 240,
    parameter USE_DDR3  = 1,
    parameter H_TOTAL   = 1056,
    parameter V_TOTAL   = 525,
    // ---- 帧率实验：时序覆盖层（默认全关 ⇒ 位流行为与改动前一致）----
    parameter OVL_TIMING_EN = 0,    // 0=旁路（默认）; 1=启用覆盖
    parameter OVL_SCAN_SEL  = 0,    // 0=用 OVL_HTS/OVL_VTS; 1=A; 2=B; 3=C
    parameter OVL_HTS       = 1800, // total_h_pixel 覆盖值（13bit）
    parameter OVL_VTS       = 750,  // total_v_pixel 覆盖值（13bit）
    // ---- ★ sccb_patch 曝光上限补写（默认关 ⇒ 位流行为与改动前一致）----
    //   OVL_EXP_CAP_EN=1 时：厂家初始化完成（cam_init_done）且总线空闲后，
    //   经同一 SCCB 总线补写 0x3a02/0x3a03/0x3a14/0x3a15 = cap。
    //   cap 来源 = **下行命令运行时可写寄存器** i_exp_cap_val（复位默认 =
    //   OVL_EXP_CAP_LINES = 0x1710 = 厂家基线档），改值经 i_exp_cap_upd 的
    //   toggle 沿触发重跑整个写序列 —— 见 sccb_patch.v 文件头 §7。
    //   依据：docs/05_experiments/曝光补写_20261011/sccb_patch实现报告.md §5
    //   ★ 默认值 1（交付档）：E0~E6 的 cap 档**全部改成下行命令可切**，不需要重构建；
    //     复位默认 cap = OVL_EXP_CAP_LINES = 0x1710 = 厂家原值 ⇒ **"补写等于不改"**
    //     （写到芯片里的 4 条与厂家初始化表完全相同，只多花一次总线占用 ~0.62 ms）。
    //     置 0 = 完全旁路（消融/对照档；与集成前的 e746270f 位流行为等价）。
    parameter OVL_EXP_CAP_EN    = 1,        // 1=启用补写（默认，交付档）; 0=旁路（消融档）
    parameter [15:0] OVL_EXP_CAP_LINES = 16'h1710, // 构建期档位 = 运行时寄存器的复位默认
    // ★ 实验档（2026-10-13 曝光生效验证）：1 = 补写序列先写 0x3A00=0x7C（夜视模式开），
    //   让 4 条曝光上限真正被 AEC 使用（手册 §4.6.1.3）。默认 0 = 交付行为不变。
    parameter OVL_AEC_CTRL_EN   = 0,
    // ★ 实验档：1 = 追加手动曝光写（正向对照，见 sccb_patch.MAN_EXP_EN）
    parameter OVL_MAN_EXP_EN    = 0
)(
    // ---------------- 时钟/复位 ----------------
    input  wire         clk_50m,            // = clk_cam，50 MHz（厂商通路 sys_clk）
    input  wire         rst_n_50m,
    input  wire         clk_200m,           // MIG 参考
    input  wire         clk_lcd,            // 25 MHz
    input  wire         rst_n_lcd,

    // ---------------- ★ 曝光上限运行时可写（来自 sys_ctrl，clk_50m 域）----
    input  wire [15:0]  i_exp_cap_val,      // 命令写入的 cap（行，4..5904）
    input  wire         i_exp_cap_upd,      // toggle：沿 = 重触发补写序列

    // ---------------- 摄像头引脚（SCCB 与采集通路独占；事件支路另在 retina_core 只读）----
    input  wire         cam_pclk,
    input  wire         cam_vsync,
    input  wire         cam_href,
    input  wire [7:0]   cam_data,
    output wire         cam_rst_n,
    output wire         cam_pwdn,
    output wire         cam_scl,
    inout  wire         cam_sda,

    // ---------------- DDR3 引脚（MIG 独占）----------------
    inout  wire [31:0]  ddr3_dq,
    inout  wire [3:0]   ddr3_dqs_n,
    inout  wire [3:0]   ddr3_dqs_p,
    output wire [13:0]  ddr3_addr,
    output wire [2:0]   ddr3_ba,
    output wire         ddr3_ras_n,
    output wire         ddr3_cas_n,
    output wire         ddr3_we_n,
    output wire         ddr3_reset_n,
    output wire [0:0]   ddr3_ck_p,
    output wire [0:0]   ddr3_ck_n,
    output wire [0:0]   ddr3_cke,
    output wire [0:0]   ddr3_cs_n,
    output wire [3:0]   ddr3_dm,
    output wire [0:0]   ddr3_odt,

    // ---------------- LCD 引脚 ----------------
    inout  wire [23:0]  lcd_rgb,
    output wire         lcd_hs,
    output wire         lcd_vs,
    output wire         lcd_de,
    output wire         lcd_pclk,
    output wire         lcd_bl,
    output wire         lcd_rst,

    // ---------------- RGS ----------------
    input  wire         cfg_disp_mode,      // KEY0：0 = 原始画面，1 = 事件画面
    input  wire [3:0]   cfg_layer_en,       // {事件, 面板, 文字, 网格}
    input  wire [3:0]   cfg_beep_sel,       // 未用（保持接口整洁）

    // ---------------- 事件位图 B 口（来自 retina_core）----------------
    input  wire [7:0]   i_bmp_rd_data,
    output wire [15:0]  o_bmp_rd_addr,

    // ---------------- 统计（CDC-2 后，clk_lcd 域）----------------
    input  wire [15:0]  i_stat_activity_q16,
    input  wire [23:0]  i_stat_ev_per_frame,
    input  wire [23:0]  i_stat_cr_x10,
    input  wire [31:0]  i_stat_frame_cnt,
    // ★ v3.1：模式标签 + 帧率（top 内 fps_meter 产出、sync_ff 过域，clk_lcd 域）
    input  wire [1:0]   i_mode_tag,          // 0=RAW_EV(R+E) 1=RAW_ONLY(R) 2=EV_ONLY(E)
    input  wire [7:0]   i_fps,               // 事件/合成画面=事件帧率，纯原始=采集帧率

    // ---------------- ★ HUD 参数（WIRE-U3，全部已在 top 里 2FF 到 clk_lcd 域）----
    //   为什么 2FF 放 top 而不在本模块里做：本模块**单时钟域**（clk_lcd）是既定纪律，
    //   跨域同步与既有 CDC-2（u_cdc2_layer 等）同处一地，便于一处审阅全部跨域点。
    input  wire [11:0]  i_theta,             // 行2：θ 阈值
    input  wire [8:0]   i_min_dl,            // 行2：minDl
    input  wire         i_ev_en,             // 行3：事件支路总使能（EV_EN）
    input  wire [1:0]   i_cfg_mode,          // 行3：0=RAW_EV 1=RAW_ONLY 2=EV_ONLY
    input  wire         i_uart_en,           // 行4/5：UART_LINK_EN（参数常量）
    input  wire [1:0]   i_baud_sel,          // 行5：生效波特率档位 0..3

    // ---------------- 相机原始像素 tap（cam_pclk 域，只读引出给 UDP 回传）----------------
    output wire         o_raw_px_valid,
    output wire [15:0]  o_raw_px_data,
    // ★ SEAM-LINKDROP-20261017：每帧**首像素** 1 拍脉冲（与 o_raw_px_data 同拍同域）
    //   用途：经 event_sink 的 raw CDC FIFO 第 17 bit 一起过到 clk_eth，让 udp_merge
    //   在**任何丢像素/丢包**之后都能重新对齐帧相位（原来帧相位只在 clk_eth 侧自己数，
    //   一旦丢像素就永久错开 ⇒ 水平拼接/错位复发，见 task-31）。
    output wire         o_raw_frame_start,

    // ---------------- ★ 调试观测口：真正送到 LCD 引脚的颜色（fabric 侧，仅 ILA 用）----------------
    //   为什么需要它（实测 2026-10-06）：`lcd_rgb` 是 inout，顶层那一端是 **IOBUF 的
    //   pad 侧**；把 ILA 直接接上去会被 DRC 判为
    //       [DRC REQP-1582] iobuf_io_loaded: ... pin IO drives one or more invalid loads
    //   ⇒ place 直接不跑。所以要把 IOBUF **之前**的颜色引出来给 ILA 看。
    //
    //   ⚠️ 必须是 `inj_rgb888`（`hud_inject` 的输出，即 `assign lcd_rgb = lcd_de_v ?
    //      inj_rgb888 : {24{1'bz}}` 里那一个），**不是 `ovl_rgb`**：
    //      `ovl_rgb` 只是 HUD **叠加层自己的颜色**（只在 `ovl_hit=1` 的像素上有效），
    //      实测探它得到的是调色板常量（R∈{0x00,0x20}、B∈{0x00,0xff}），
    //      看起来像"画面是死的"，会得出错误结论。
    output wire [23:0]  o_dbg_lcd_rgb888,

    // ---------------- ★ 实验档（ILA 观测）：SCCB 总线 bundle（仅 ILA 用）----------------
    //   为什么需要它（2026-10-13 曝光生效验证任务）：要实证"EXP_CAP 命令后 SCCB 总线上
    //   的真实波形 + 传感器响应"，但
    //     (a) `cam_sda` 是 inout，顶层那一端是 IOBUF 的 pad 侧 ⇒ 直接接 ILA 会触发
    //         [DRC REQP-1582] iobuf_io_loaded（事实 H54(a)，place 直接不跑）；
    //     (b) `patch_owner/patch_scl/patch_done_cnt/patch_ack_cnt/...` 都是本模块
    //         `g_ddr3` 内的局部线网，顶层看不到。
    //   ⇒ 在本模块内把这些**已经存在的信号**（pad SDA 用一拍寄存采样，仍属 fabric 侧）
    //     打包成一个 33 bit 观测口引到顶层，只给 ILA 探针用。
    //   ⚠️ 纯观测：**功能路径一个字节都不引用**；`ILA_EN=0`（交付构建）时顶层不接，
    //      整块观测逻辑被综合器裁掉（零面积代价）。
    //   位映射（与 top_retina_event.v 的 `u_ila_sccb` 探针一一对应）：
    //     [0]      patch_owner          —— 补写器是否占总线
    //     [1]      patch_scl            —— 补写 SCL（owner=1 时即 pad 上的 SCL）
    //     [2]      dbg_sda_pad_r        —— cam_sda pad 电平（寄存 1 拍）
    //     [3]      patch_sda_oe         —— 补写 SDA 驱动使能（0 = 第 9 位释放给从机）
    //     [4]      patch_sda_out        —— 补写 SDA 数据（推挽输出值）
    //     [5]      dri_scl              —— 厂家侧 SCL（总线是否空闲的旁证）
    //     [6]      cam_init_done_w      —— 厂家初始化完成（补写器的武装源）
    //     [7]      patch_done           —— 4/4 写完且已释放（sticky）
    //     [8]      dbg_capupd_s2        —— i_exp_cap_upd 在 clk_50m 域 2 拍同步后的电平
    //     [9]      dbg_txn_mark         —— patch_done_cnt 变化沿（每条事务结束的 1 拍标记）
    //     [12:10]  patch_done_cnt[2:0]  —— 已完成事务数
    //     [15:13]  patch_ack_cnt[2:0]   —— 4 字节 Don't-Care 位全 0 的事务数（= 从机应答证据）
    //     [31:16]  i_exp_cap_val[15:0]  —— 本域看到的 cap 命令值
    //     [32]     保留（0）
    output wire [32:0]  o_dbg_sccb
);

    // ========================================================================
    // 底座：两路实现，产出统一的 "base" 像素流 + 扫描坐标
    //   base_rgb565 / base_de / px_x / px_y  —— 全部 clk_lcd 域
    // ========================================================================
    wire [15:0] base_rgb565;
    wire        base_de;
    wire [10:0] px_x, px_y;

    // 时序发生器给出的"基准 de"（仅供 OVL 平面做坐标基准）
    wire        lcd_de_raw;
    // 驱动到 LCD 引脚、且与颜色对齐的 de（见下方"颜色对齐"说明）
    wire        lcd_de_v;

    generate
    // ----------------------------------------------------------------------
    // 路径 1：厂家 DDR3 通路（上板用）
    // ----------------------------------------------------------------------
    if (USE_DDR3 != 0) begin : g_ddr3

        wire [15:0] lcd_id;
        wire [12:0] h_disp, v_disp, total_h_pixel, total_v_pixel;
        // picture_size 的**原始**时序输出；total_* 为覆盖层之后的最终值（默认旁路时二者相同）
        wire [12:0] total_h_pixel_raw, total_v_pixel_raw;
        wire [12:0] y_addr_st, y_addr_end;
        wire [27:0] ddr3_addr_max;
        wire [15:0] wrdata, rddata;
        wire        rdata_req;
        wire        cmos_frame_vsync, cmos_frame_valid;
        wire        init_calib_complete;
        wire        sys_init_done;
        wire [15:0] lcd_rgb_565_int;
        wire [23:0] lcd_rgb_i;
        wire        rd_vsync;       // ⚠️ 必须先声明（ddr3_top 的 rd_load 要用它）

        // ---- ★ sccb_patch：厂家驱动侧引出线 + 补写器输出（mux 在 IOBUF 之前）----
        //   dri_sda 是**内部三态网**（i2c_dri.v:77 `assign sda = dir ? out : 1'bz`）。
        //   已实测（build/sccb_integ_20261013/probe）：Vivado 2020.2 会把
        //   "厂家三态 + 补写分支" 的网络正确塌缩为 pad 上**唯一**的 IOBUF
        //   （I=两分支 mux、T=两分支使能之或），不产生内部三态/multi-driven
        //   （grep 8-6858 / 8-6859 零命中）。
        //   ⚠️ 副作用（已核源码，无功能影响）：厂家侧 sda 回读（sda_in→i2c_ack/data_r）
        //     在改动后不再拿到 pad 电平；但 ov5640_dri **只用写事务**
        //     （i2c_rh_wl 在 init_reg_cnt==2 后恒 0，见 i2c_ov5640_rgb565_cfg.v:80-85），
        //     且它**未连接** i2c_ack —— 该回读路径在现设计里无任何消费者。
        wire        cam_init_done_w;    // ★ 补接：ov5640_dri.cam_init_done（原先悬空）
        wire        dri_scl;
        wire        dri_sda;
        wire        patch_owner, patch_scl, patch_sda, patch_sda_oe;
        wire [2:0]  patch_done_cnt, patch_ack_cnt;
        wire        patch_done;

        assign sys_init_done = init_calib_complete;

        // ---- 分辨率选择（读屏 ID 决定）----
        picture_size u_picture_size (
            .rst_n          (rst_n_50m),
            .clk            (clk_50m),
            .lcd_id         (lcd_id),
            .cmos_h_pixel   (h_disp),
            .cmos_v_pixel   (v_disp),
            .total_h_pixel  (total_h_pixel_raw),
            .total_v_pixel  (total_v_pixel_raw),
            .y_addr_st      (y_addr_st),
            .y_addr_end     (y_addr_end),
            .ddr3_addr_max  (ddr3_addr_max)
        );

        // ---- 时序覆盖层（帧率实验）：只覆盖 total_h_pixel / total_v_pixel 两条网线 ----
        //  OVL_TIMING_EN=0（默认）⇒ 子模块 generate 直连，行为与改动前完全一致。
        //  实验点：OVL_TIMING_EN=1 + OVL_SCAN_SEL=1/2/3 → A(1800,750)/B(1800,600)/C(1800,520)
        ov5640_timing_ovr #(
            .OVL_EN   (OVL_TIMING_EN),
            .SCAN_SEL (OVL_SCAN_SEL),
            .OVL_HTS  (OVL_HTS),
            .OVL_VTS  (OVL_VTS)
        ) u_ov5640_timing_ovr (
            .clk      (clk_50m),
            .rst_n    (rst_n_50m),
            .i_hts    (total_h_pixel_raw),
            .i_vts    (total_v_pixel_raw),
            .i_ovl_en (OVL_TIMING_EN != 0),
            .o_hts    (total_h_pixel),
            .o_vts    (total_v_pixel)
        );

        // ---- 摄像头驱动（SCCB 独占；引脚经下方 mux 送 pad）----
        ov5640_dri u_ov5640_dri (
            .clk                (clk_50m),
            .rst_n              (rst_n_50m),
            .cam_pclk           (cam_pclk),
            .cam_vsync          (cam_vsync),
            .cam_href           (cam_href),
            .cam_data           (cam_data),
            .cam_rst_n          (cam_rst_n),
            .cam_pwdn           (cam_pwdn),
            .cam_scl            (dri_scl),          // ★ 改接内部网（pad 由 mux 单点驱动）
            .cam_sda            (dri_sda),          // ★ 同上
            .cam_init_done      (cam_init_done_w),  // ★ 补接（原先该输出悬空，见 sccb 集成清单）
            .capture_start      (init_calib_complete),
            .cmos_h_pixel       (h_disp),
            .cmos_v_pixel       (v_disp),
            .total_h_pixel      (total_h_pixel),
            .total_v_pixel      (total_v_pixel),
            .y_addr_st          (y_addr_st),
            .y_addr_end         (y_addr_end),
            .cmos_frame_vsync   (cmos_frame_vsync),
            .cmos_frame_href    (),
            .cmos_frame_valid   (cmos_frame_valid),
            .cmos_frame_data    (wrdata)
        );

        // ---- ★ SCCB 曝光上限补写（sccb_patch；EN=0 时综合为常量直通，零资源）----
        //   clk/rst_n 与厂家 i2c_dri 同源（clk_50m/rst_n_50m），单时钟无 CDC；
        //   i_vts 取**覆盖后**的 total_v_pixel（CAP_FROM_VTS 档用；命令档不用）。
        sccb_patch #(
            .EN            (OVL_EXP_CAP_EN),
            .EXP_CAP_LINES (OVL_EXP_CAP_LINES),
            .CAP_FROM_VTS  (1'b0),
            .CAP_FROM_CMD  (OVL_EXP_CAP_EN),    // 使能即"运行时可写"档（复位默认=OVL_EXP_CAP_LINES）
            .WR_AEC_CTRL   (OVL_AEC_CTRL_EN),   // ★ 实验档：先写 0x3A00=0x7C
            .AEC_CTRL_VAL  (8'h7c),
            .MAN_EXP_EN    (OVL_MAN_EXP_EN)
        ) u_sccb_patch (
            .clk          (clk_50m),
            .rst_n        (rst_n_50m),
            .init_done    (cam_init_done_w),
            .i_vts        (total_v_pixel),
            .i_cap_val    (i_exp_cap_val),      // ★ 下行命令运行时可写
            .i_cap_upd    (i_exp_cap_upd),      // ★ 沿 = 重跑写序列
            .i_dri_scl    (dri_scl),
            .i_dri_sda    (dri_sda),
            .i_sda        (cam_sda),            // pad 回读（第 9 位 Don't-Care 观测）
            .o_owner      (patch_owner),
            .o_scl        (patch_scl),
            .o_sda_out    (patch_sda),
            .o_sda_oe     (patch_sda_oe),
            .o_done_cnt   (patch_done_cnt),
            .o_ack_cnt    (patch_ack_cnt),
            .o_patch_done (patch_done)
        );

        // ---- ★ 引脚 mux（补写方案 §5 第 7 条原句；pad 只由 mux 一个源驱动）----
        //   patch_owner=0（默认）⇒ 与改动前逐比特一致（cam_scl≡dri_scl、
        //   cam_sda≡dri_sda）；EN=0 时 patch_owner 恒 0。
        assign cam_scl = patch_owner ? patch_scl : dri_scl;
        assign cam_sda = patch_owner ? (patch_sda_oe ? patch_sda : 1'bz) : dri_sda;

        // ==================================================================
        // ★ 实验档：SCCB 总线监视（纯观测，功能路径不引用；见端口注释位映射）
        //   目的（2026-10-13 曝光生效验证）：把"补写器到底有没有在真实总线上
        //   跑完 4 条写事务、从机有没有应答"变成 ILA 可抓的机器证据。
        //   ⚠️ 只读 `cam_sda`（pad 回读，与 sccb_patch 的 i_sda 同一读法）打一拍，
        //      **不把 pad 网直接接 ILA**（否则 [DRC REQP-1582]）。
        // ==================================================================
        reg        dbg_sda_pad_r;
        reg        dbg_capupd_s1, dbg_capupd_s2;
        reg [2:0]  dbg_done_d;
        always @(posedge clk_50m) begin
            dbg_sda_pad_r <= cam_sda;          // pad 电平（1 拍延迟，20 ns ≪ 4 µs 位宽）
            dbg_capupd_s1 <= i_exp_cap_upd;    // 命令 toggle 2 拍同步（同域，防御性）
            dbg_capupd_s2 <= dbg_capupd_s1;
            dbg_done_d    <= patch_done_cnt;   // 事务计数打拍 ⇒ 变化沿 = 事务结束标记
        end
        wire dbg_txn_mark = (patch_done_cnt != dbg_done_d);

        assign o_dbg_sccb = { 1'b0,            // [32]    保留
                              i_exp_cap_val,   // [31:16] 本域 cap 命令值
                              patch_ack_cnt,   // [15:13] 应答事务数
                              patch_done_cnt,  // [12:10] 已完成事务数
                              dbg_txn_mark,    // [9]     事务结束标记
                              dbg_capupd_s2,   // [8]     cap 命令 toggle（本域）
                              patch_done,      // [7]     4/4 完成
                              cam_init_done_w, // [6]     厂家初始化完成
                              dri_scl,         // [5]     厂家 SCL
                              patch_sda,       // [4]     补写 SDA 输出值
                              patch_sda_oe,    // [3]     补写 SDA 驱动使能
                              dbg_sda_pad_r,   // [2]     pad SDA 电平（寄存）
                              patch_scl,       // [1]     补写 SCL
                              patch_owner };   // [0]     总线归属

        // ---- DDR3 通路（MIG + 乒乓）----
        ddr3_top u_ddr3_top (
            .rst_n              (rst_n_50m),
            .init_calib_complete(init_calib_complete),
            .app_addr_rd_min    (28'd0),
            .app_addr_rd_max    (ddr3_addr_max[27:1]),
            .rd_bust_len        (h_disp[10:4]),
            .app_addr_wr_min    (28'd0),
            .app_addr_wr_max    (ddr3_addr_max[27:1]),
            .wr_bust_len        (h_disp[10:4]),
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
            .sys_clk_i          (clk_200m),
            .clk_ref_i          (clk_200m),
            .ddr3_read_valid    (1'b1),
            .ddr3_pingpang_en   (1'b1),
            .wr_clk             (cam_pclk),
            .wr_load            (cmos_frame_vsync),
            .wr_en              (cmos_frame_valid),
            .wrdata             (wrdata),
            .rd_clk             (clk_lcd),
            .rd_load            (rd_vsync),
            .rddata             (rddata),
            .rdata_req          (rdata_req)
        );

        // ---- 读屏 ID ----
        rd_id u_rd_id (
            .clk        (clk_50m),
            .rst_n      (rst_n_50m),
            .lcd_rgb    (lcd_rgb_i),
            .lcd_id     (lcd_id)
        );

        // ---- LCD 时序 + DDR3 取数握手（厂家原件，一字不改）----
        lcd_driver u_lcd_driver (
            .lcd_clk        (clk_lcd),
            .rst_n          (rst_n_lcd & sys_init_done),
            .lcd_id         (lcd_id),
            .lcd_hs         (lcd_hs),
            .lcd_vs         (lcd_vs),
            .lcd_de         (lcd_de_raw),
            .lcd_rgb        (lcd_rgb_565_int),
            .lcd_bl         (),
            .lcd_rst        (),
            .lcd_pclk       (lcd_pclk),
            .pixel_data     (rddata),
            .data_req       (rdata_req),
            .out_vsync      (rd_vsync),
            .h_disp         (),
            .v_disp         (),
            .pixel_xpos     (px_x),
            .pixel_ypos     (px_y)
        );

        assign base_rgb565 = lcd_rgb_565_int;
        assign base_de     = lcd_de_raw;
        assign lcd_rgb_i   = lcd_rgb;

        // 原始像素 tap（供事件支路/UDP 回传；纯读出，不影响显示通路）
        assign o_raw_px_valid = cmos_frame_valid;
        assign o_raw_px_data  = wrdata;

        // ---- ★ SEAM-LINKDROP-20261017：帧首 marker（每帧恰好 1 拍）----
        //   为什么必须由**源侧**产生：udp_merge 的帧相位（px_frame/pix_in_frame）原来是
        //   clk_eth 侧自己数的，网线拔掉 ⇒ 环满 ⇒ 像素被丢 ⇒ 源侧和 eth 侧的"帧内偏移"
        //   从此永久差一个固定量（现场表现：画面水平拼接复发）。把"帧首"随像素一起
        //   **同拍写进同一个 FIFO**，读写指针天然对齐，marker 与像素不可能脱钩。
        //   raw_fs_pending：vsync 置 1 → 该帧第一个有效像素处清零 ⇒ 整帧只出 1 拍。
        //   ⚠️ cam_pclk 域在本模块内没有本地复位端口（原 tap 是纯直通），这里用静态初值；
        //   该寄存器每个 vsync 都会被重新置位，功能上与复位等价（FPGA 上为 INIT=0 的 FF）。
        reg raw_fs_pending = 1'b0;
        always @(posedge cam_pclk) begin
            if (cmos_frame_vsync)      raw_fs_pending <= 1'b1;
            else if (cmos_frame_valid) raw_fs_pending <= 1'b0;
        end
        assign o_raw_frame_start = cmos_frame_valid && raw_fs_pending;

        // 背光/复位：与厂家已验证行为一致（恒开、不复位）
        assign lcd_bl  = 1'b1;
        assign lcd_rst = 1'b1;

    // ----------------------------------------------------------------------
    // 路径 2：无 DDR3（备选方案 B / 集成仿真）
    // ----------------------------------------------------------------------
    end else begin : g_noddr

        // ------------------------------------------------------------------
        // 自检图案：**直接由 lcd_scanout 的扫描坐标合成**（相位天然锁定）
        //
        // ⚠️ 集成修复（Lead）：首版用 `vps_pattern_gen` + `lcd_scanout` 两个独立计数器，
        //    结果**相位错开**：pattern 的有效窗是 x∈[0,800)/行∈[0,480)，
        //    而 lcd_scanout 的有效窗是 h_cnt∈[216,1016)、v_cnt∈[35,515)（H_BACK/V_BACK 的偏移）。
        //    实测后果：每行只有右边 584 像素有图，其余**全黑**；帧底部 35 行也全黑
        //    （PPM 逐行分析：y=470 整行 0x000000、y=5 的 x≥600 为 0x000000）。
        //    ⇒ 改为"从扫描坐标算颜色"，不需要第二套计数器，也不可能再错相位。
        //
        //    残影：这个 bug **只影响 USE_DDR3=0 的仿真/无摄像头演示路径**；
        //    上板走 USE_DDR3=1（厂家 DDR3 通路），不受影响。
        // ------------------------------------------------------------------
        reg [7:0] pat_frame;
        always @(posedge clk_lcd) begin
            if (!rst_n_lcd) pat_frame <= 8'd0;
            else if (lcd_de_raw && (px_x == 11'd799) && (px_y == 11'd479))
                pat_frame <= pat_frame + 8'd1;      // 每帧 +1（方块每帧右移 1 px）
        end

        wire [10:0] pat_bx = 11'd100 + {3'b000, pat_frame};
        wire        pat_in_sq = (px_x >= pat_bx) && (px_x < (pat_bx + 11'd64)) &&
                                (px_y >= 11'd200) && (px_y < 11'd264);

        // 灰度 → RGB565（与 px_luma/luma 的口径一致：R/B 取高 5 bit、G 取高 6 bit）
        wire [7:0]  pat_lum = pat_in_sq ? 8'hFF : 8'h14;   // 方块亮 / 背景暗
        wire [15:0] pat_rgb565 = {pat_lum[7:3], pat_lum[7:2], pat_lum[7:3]};

        wire [15:0] scan_rgb565;

        lcd_scanout u_lcd_scanout (
            .clk_lcd        (clk_lcd),
            .rst_n_lcd      (rst_n_lcd),
            .i_pixel_data   (pat_rgb565),
            .o_lcd_de       (lcd_de_raw),
            .o_lcd_hs       (lcd_hs),
            .o_lcd_vs       (lcd_vs),
            .o_lcd_pclk     (lcd_pclk),
            .o_lcd_rgb565   (scan_rgb565),
            .o_pixel_xpos   (px_x),
            .o_pixel_ypos   (px_y)
        );

        assign base_rgb565 = scan_rgb565;
        assign base_de     = lcd_de_raw;

        // 备选路径没有 cam_pclk 域的原始流 ⇒ tap 置空（帧首 marker 一并置 0）
        assign o_raw_px_valid     = 1'b0;
        assign o_raw_px_data      = 16'h0000;
        assign o_raw_frame_start  = 1'b0;

        // 无摄像头时这些引脚保持空闲态
        assign cam_rst_n = 1'b1;
        assign cam_pwdn  = 1'b0;
        assign cam_scl   = 1'b0;
        assign cam_sda   = 1'bz;

        // 备选路径没有 SCCB 补写器 ⇒ 观测口全 0
        assign o_dbg_sccb = 33'd0;

        assign lcd_bl  = 1'b1;
        assign lcd_rst = 1'b1;

    end
    endgenerate

    // ========================================================================
    // 事件画面（×2 放大渲染，读事件位图）
    // ========================================================================
    wire [15:0] er_bmp_addr;
    wire        er_de;
    wire [15:0] er_data;

    // 事件画面模式才由 event_render 占上位图 B 口
    wire er_own_bmp = cfg_disp_mode;

    event_render #(
        .EV_W (EV_W),
        .EV_H (EV_H)
    ) u_event_render (
        .clk_lcd         (clk_lcd),
        .rst_n_lcd       (rst_n_lcd),
        .i_px_x          (px_x),
        .i_px_y          (px_y),
        .i_px_de         (base_de),
        .o_bmp_rd_addr   (er_bmp_addr),
        .i_bmp_rd_data   (i_bmp_rd_data),
        .o_de            (er_de),
        .o_data          (er_data)
    );

    // ========================================================================
    // display_path 侧 5 个 OVL 平面（hud_stack 只做仲裁，平面在本模块例化）
    // ========================================================================
    wire        g_hit, e_hit, p_hit, t_hit, s_hit;
    wire [23:0] g_rgb, e_rgb, p_rgb, t_rgb, s_rgb;

    wire [15:0] hel_bmp_addr;
    wire        hel_own_bmp = ~cfg_disp_mode;

    // 位图 B 口仲裁：事件画面模式 → event_render；原始画面模式 → hud_event_layer
    assign o_bmp_rd_addr = er_own_bmp ? er_bmp_addr : hel_bmp_addr;

    hud_grid u_hud_grid (
        .clk_lcd   (clk_lcd),
        .rst_n_lcd (rst_n_lcd),
        .px_x      (px_x),
        .px_y      (px_y),
        .px_de     (base_de),
        .ovl_en    (cfg_layer_en[0]),
        .ovl_hit   (g_hit),
        .ovl_rgb   (g_rgb)
    );

    hud_event_layer #(
        .EV_W (EV_W),
        .EV_H (EV_H)
    ) u_hud_event_layer (
        .clk_lcd        (clk_lcd),
        .rst_n_lcd      (rst_n_lcd),
        .px_x           (px_x),
        .px_y           (px_y),
        .px_de          (base_de),
        .ovl_en         (cfg_layer_en[3] & hel_own_bmp),
        .ovl_hit        (e_hit),
        .ovl_rgb        (e_rgb),
        .o_bmp_rd_addr  (hel_bmp_addr),
        .i_bmp_rd_data  (i_bmp_rd_data)
    );

    hud_panel u_hud_panel (
        .clk_lcd            (clk_lcd),
        .rst_n_lcd          (rst_n_lcd),
        .px_x               (px_x),
        .px_y               (px_y),
        .px_de              (base_de),
        .ovl_en             (cfg_layer_en[2]),
        .ovl_hit            (p_hit),
        .ovl_rgb            (p_rgb),
        .i_activity_q16     (i_stat_activity_q16),
        .i_ev_per_frame     (i_stat_ev_per_frame),
        .i_cr_x10           (i_stat_cr_x10),
        .i_frame_cnt        (i_stat_frame_cnt),
        .i_mode_tag         (i_mode_tag),        // ★ v3.1
        .i_fps              (i_fps),             // ★ v3.1
        .o_char_code        (),
        .o_char_row         ()
    );

    // ★★ H64 修复（2026-10-07）：hud_text 原来用默认 TEXT_X=8 / TEXT_Y=40，
    //    而 hud_panel 的面板是 (8,8) 320×120、三行文字在绝对 y = 12 / 44 / 76。
    //    ⇒ 文案行（y 40..72、x 8..520）**正好压在面板第 2 行**（y 44..76）上，
    //      两串白字重合（用户拍照可见"元素都叠在一起"）。
    //    这里改成右下角页脚：x 288..800（= 8 px 右边距）、y 440..472，
    //    与面板（y ≤ 128）完全不相交。层优先级不变（文字仍在面板之上，只是不再重叠）。
    hud_text #(
        .TEXT_X (11'd288),
        .TEXT_Y (11'd440)
    ) u_hud_text (
        .clk_lcd    (clk_lcd),
        .rst_n_lcd  (rst_n_lcd),
        .px_x       (px_x),
        .px_y       (px_y),
        .px_de      (base_de),
        .ovl_en     (cfg_layer_en[1]),
        .ovl_hit    (t_hit),
        .ovl_rgb    (t_rgb),
        .o_char_code(),
        .o_char_row ()
    );

    hud_sprite u_hud_sprite (
        .clk_lcd     (clk_lcd),
        .rst_n_lcd   (rst_n_lcd),
        .px_x        (px_x),
        .px_y        (px_y),
        .px_de       (base_de),
        .ovl_en      (1'b0),            // P2，本期不启用
        .ovl_hit     (s_hit),
        .ovl_rgb     (s_rgb),
        .i_sprite_id (4'd0),
        .i_sprite_x  (11'd20),
        .i_sprite_y  (11'd20),
        .i_palette   (48'hF00_0F0_00F_FF0)  // hud_sprite 的 4 色×12bit RGB444 调色板
    );

    // ========================================================================
    // ★ WIRE-U3（2026-10-17，接口约定 §2）：平面 6 = HUD（最高）
    //   232×144 半透明遮罩 + 5 行右对齐白字。开关取 KEY2 的「面板」位
    //   cfg_layer_en[2]：sys_ctrl 的 KEY2 预设是 {事件, 面板, 文字, 网格}，没有
    //   独立的 HUD 位；HUD 与仪表盘同属「参数面板」，合成一位符合用户语义
    //   （1111/0111 显示，0011/0001 整块隐藏）。
    // ========================================================================
    wire        hud_t_hit;
    wire [23:0] hud_t_rgb;
    wire        hud_band;

    hud_status u_hud_status (
        .clk_lcd    (clk_lcd),
        .rst_n_lcd  (rst_n_lcd),
        .px_x       (px_x),
        .px_y       (px_y),
        .px_de      (base_de),
        .i_en       (cfg_layer_en[2]),
        .i_mode_tag (i_mode_tag),
        .i_theta    (i_theta),
        .i_min_dl   (i_min_dl),
        .i_ev_en    (i_ev_en),
        .i_cfg_mode (i_cfg_mode),
        .i_uart_en  (i_uart_en),
        .i_baud_sel (i_baud_sel),
        .o_text_hit (hud_t_hit),
        .o_text_rgb (hud_t_rgb),
        .o_band_hit (hud_band)
    );

    wire        ovl_hit;
    wire [23:0] ovl_rgb;
    wire        ovl_dim;

    hud_stack #(
        .N_PLANES (6)                   // ★ 6 = 启用 p6 + 遮罩通道（默认 5 = 旧行为）
    ) u_hud_stack (
        .clk_lcd   (clk_lcd),
        .rst_n_lcd (rst_n_lcd),
        .px_x      (px_x),
        .px_y      (px_y),
        .px_de     (base_de),
        .p1_en     (cfg_layer_en[0]), .p1_hit(g_hit), .p1_rgb(g_rgb),   // 网格（最底）
        .p2_en     (cfg_layer_en[3] & hel_own_bmp), .p2_hit(e_hit), .p2_rgb(e_rgb), // 事件小图
        .p3_en     (1'b0),            .p3_hit(s_hit), .p3_rgb(s_rgb),   // 精灵（未启用）
        .p4_en     (cfg_layer_en[2]), .p4_hit(p_hit), .p4_rgb(p_rgb),   // 仪表盘
        .p5_en     (cfg_layer_en[1]), .p5_hit(t_hit), .p5_rgb(t_rgb),   // 文字
        .p6_en     (cfg_layer_en[2]), .p6_hit(hud_t_hit), .p6_rgb(hud_t_rgb), // ★ HUD（最顶）
        .i_dim     (hud_band),                                          // ★ 遮罩
        .o_hit     (ovl_hit),
        .o_rgb     (ovl_rgb),
        .o_dim     (ovl_dim)
    );

    // ========================================================================
    // 显示源选择 + 叠加注入（只换"颜色"，不碰时序/握手/三态）
    // ========================================================================
    wire        mux_de;
    wire [15:0] mux_data;

    disp_mux u_disp_mux (
        .clk_lcd       (clk_lcd),
        .rst_n_lcd     (rst_n_lcd),
        .cfg_disp_mode (cfg_disp_mode),
        .a_de          (base_de),       // 0 = 原始画面
        .a_data        (base_rgb565),
        .b_de          (er_de),         // 1 = 事件画面
        .b_data        (er_data),
        .o_de          (mux_de),
        .o_data        (mux_data)
    );

    wire [23:0] inj_rgb888;
    wire        inj_de;

    hud_inject u_hud_inject (
        .clk_lcd     (clk_lcd),
        .rst_n_lcd   (rst_n_lcd),
        .i_bg_rgb565 (mux_data),
        .i_bg_de     (mux_de),
        .i_ovl_hit   (ovl_hit),
        .i_ovl_rgb   (ovl_rgb),
        .i_dim       (ovl_dim),                 // ★ HUD 遮罩：背景压暗 50%
        .o_rgb888    (inj_rgb888),
        .o_de        (inj_de)
    );

    // 调试观测：真正送到引脚的颜色（IOBUF 之前的 `inj_rgb888`）。仅 ILA 使用，
    // 生产构建里无人引用时会被综合优化掉，零代价。
    assign o_dbg_lcd_rgb888 = inj_rgb888;

    // ------------------------------------------------------------------------
    // ★ 颜色 / DE 对齐（实现阶段集成决策，务必看懂再改）
    //
    // 厂家原设计的叠加是**纯组合**的（lcd_overlay_axes），所以 `lcd_de` 与颜色天然同拍。
    // 本工程的叠加链有寄存器级延迟：
    //     disp_mux(PIPE=1) → 5 个平面(PIPE=1) → hud_stack(PIPE=1) → hud_inject(PIPE=1)
    // 若仍用**未延迟的** `lcd_de` 去门控三态，则每行开头的若干像素会被驱动成"上一拍的颜色"，
    // 表现为**整幅画面水平左移若干像素**（画面内容错位，不是黑屏，很容易被误当成"屏正常"）。
    //
    // 修法：**用与颜色同拍的 `inj_de` 作为 LCD 的 DE 引脚**。
    //   · DE 与颜色严格同拍 ⇒ 数据不再错位；
    //   · DE 的**形状不变**（每行仍恰好 800 拍、行间距不变），只是整体相位平移几拍
    //     —— DE 模式下屏按"DE 高了多少拍"计像素，相位平移不影响成像；
    //   · `base_de`（供 OVL 平面算坐标）**保持未延迟**，坐标基准不被破坏；
    //   · 复位/开机期间 `inj_de=0` ⇒ 引脚高阻，读屏 ID 的纪律不变（事实 H33）。
    // ------------------------------------------------------------------------
    assign lcd_de_v = inj_de;
    assign lcd_de   = lcd_de_v;

    // ⚠️ 三态纪律：lcd_de=0（含开机读屏 ID 期间）必须释放引脚
    assign lcd_rgb = lcd_de_v ? inj_rgb888 : {24{1'bz}};

    // cfg_beep_sel 保留给蜂鸣器策略（当前不参与显示）
    wire _unused = &{1'b0, cfg_beep_sel};

endmodule

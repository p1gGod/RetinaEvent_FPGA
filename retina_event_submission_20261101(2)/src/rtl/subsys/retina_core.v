//==============================================================================
// retina_core -- 事件引擎子系统（L3，★ 作品核心）
//
// 规格：retina_event/docs/子模块设计/L3_L4_集成/retina_core.md
//
// 数据流：
//   OV5640 引脚(只读) ─► cam_tap ─► axis_fifo(CDC-0, cam_pclk→clk_cam) ─┐
//                                                                        ├─► vps_mux ─► vps_resample(÷2×÷2)
//   vps_pattern_gen ────────────────────────────────────────────────────┘        │
//                                                                                ▼
//        px_luma → luma_log → temporal_diff → spatial_lap → event_gen → refractory
//                                                                        │
//                            ┌─────────────── 事件位图 BRAM（本模块持有）─┘
//                            │   A 口 clk_cam：事件 RMW + 帧末衰减扫描
//                            │   B 口 clk_lcd：只读，供 display_path 渲染
//                            ▼
//                       EVS → event_sink / stats_counter
//
// ⚠️ 实现阶段的两处**架构性决策**（与文档 §4 B7 的逐像素 RMW 等价但更简单、更鲁棒）：
//
//  1. **事件写入不再依赖"流水线延迟对齐"**：文档 B7 设想 RMW 与像素流同拍走，
//     但这要求知道整条流水线的精确拍数（px_luma/luma_log/temporal_diff/spatial_lap/
//     event_gen 各自的内部延迟之和）。本实现改为：**只按 event_gen 输出的 (x,y) 写**
//     —— 事件自带的坐标是绝对正确的，与延迟无关。
//
//  2. **余晖衰减改为"帧末扫描"而不是"逐像素衰减"**：
//     vsync 之后启动一次全位图扫描（48,000 字 × 2 拍 = 96,000 拍 ≈ 1.92 ms @50 MHz，
//     占一帧 37.9 ms 的 5%），把每个 4bit 单元减 DECAY_STEP（到 0 为止）。
//     扫描速率快于像素流 ⇒ 总是"先扫描、后写事件"，于是一个事件恰好存活 ~1 帧后衰减
//     —— 与逐像素衰减的视觉效果一致，但没有"必须与流水线同拍"的脆弱前提。
//     扫描期间事件写入**优先**，扫描暂停（事件稀疏，暂停代价可忽略）。
//
//  3. 位图位宽按实现阶段勘误为 **16 bit 地址 / 8 bit 数据**（2 px/字，48,000 字）——
//     文档三处写的 15/4 装不下（2^15=32768）。
//==============================================================================
`timescale 1ns / 1ps

module retina_core #(
    parameter IN_W       = 800,         // 相机分辨率
    parameter IN_H       = 480,
    parameter EV_W       = 400,         // 事件分辨率
    parameter EV_H       = 240,
    parameter DECAY_EN   = 1,           // 是否做余晖衰减
    parameter DECAY_STEP = 1,           // 每次扫描衰减档数（1~3）
    parameter EVF_DEPTH  = 32,          // 事件写缓存深度（必须 2 的幂）
    parameter PIPE_LAT   = 12           // vps_vsync/de 延迟对齐（仅用于帧边界/统计，不敏感）
)(
    // ---------------- cam_pclk 域（摄像头只读）----------------
    input  wire        cam_pclk,
    input  wire        rst_n_pclk,      // rst_n_cam 同步到 cam_pclk 域（由顶层提供）
    input  wire [7:0]  i_cam_data,
    input  wire        i_cam_vsync,
    input  wire        i_cam_href,

    // ---------------- clk_cam 域（事件引擎）----------------
    input  wire        clk_cam,
    input  wire        rst_n_cam,

    // ---------------- clk_lcd 域（位图 B 口只读）----------------
    input  wire        clk_lcd,

    // ---------------- RGS 参数 ----------------
    input  wire        i_cfg_ev_en,         // 事件支路总使能（0 ⇒ 事件不再输出，画面照常）
    input  wire [11:0] i_cfg_theta,         // 阈值（下发给 event_gen）
    input  wire [8:0]  i_cfg_min_dl,        // 最小亮度守卫
    input  wire [1:0]  i_cfg_src,           // 视频源：0 = 相机，1 = 自检图案
    input  wire [1:0]  i_cfg_pattern_mode,  // 自检图案模式
    input  wire        i_cfg_decay_en,      // 余晖使能（运行时可关）
    input  wire [2:0]  i_cfg_decay_step,    // 余晖衰减档
    input  wire        i_cfg_refr_bypass,   // 不应期旁路

    // ---------------- EVS 事件流（clk_cam）----------------
    output wire        o_ev_valid,
    output wire [8:0]  o_ev_x,
    output wire [7:0]  o_ev_y,
    output wire        o_ev_pol,

    // ---------------- 事件位图 B 口（clk_lcd 只读）----------------
    input  wire [15:0] i_bmp_rd_addr,
    output wire [7:0]  o_bmp_rd_data,

    // ---------------- 统计（clk_cam）----------------
    output wire [23:0] o_stat_ev_per_frame,
    output wire [15:0] o_stat_activity_q16,
    output wire [23:0] o_stat_cr_x10,
    output wire [31:0] o_stat_frame_cnt,
    output wire [31:0] o_stat_ev_total,
    output wire [15:0] o_stat_ev_fifo_ovf,  // 事件写缓存溢出次数（健康度）
    output wire [15:0] o_stat_px_fifo_ovf   // CDC-0 像素丢弃次数（健康度）
);

    // ------------------------------------------------------------------------
    // 常量
    // ------------------------------------------------------------------------
    localparam BMP_WORDS = EV_W * EV_H / 2;         // 48,000 个 8bit 字（2 px/字）
    localparam BMP_AW    = 16;
    localparam WPL       = EV_W / 2;                // 每行 200 字
    localparam EVF_AW    = $clog2(EVF_DEPTH);
    localparam FIFO_AW   = 11;                      // CDC-0：2048 深

    integer i;

    // ========================================================================
    // B1: cam_tap —— 只读并联抓取 + 8→16 组包（cam_pclk 域）
    // ========================================================================
    wire        tap_px_valid;
    wire [15:0] tap_px_data;
    wire        tap_frame_start;
    wire        tap_line_start;

    cam_tap u_cam_tap (
        .cam_pclk       (cam_pclk),
        .rst_n_pclk     (rst_n_pclk),
        .i_cam_data     (i_cam_data),
        .i_cam_vsync    (i_cam_vsync),
        .i_cam_href     (i_cam_href),
        .o_px_valid     (tap_px_valid),
        .o_px_data      (tap_px_data),
        .o_frame_start  (tap_frame_start),
        .o_line_start   (tap_line_start)
    );

    // ========================================================================
    // B2: CDC-0 异步 FIFO（cam_pclk → clk_cam）
    //     数据 = {帧起始标志, RGB565}；写侧只在 px_valid 时写
    //     ⚠️ ★ H63：读侧 de **不是** `!empty` 直接当 VPS 数据使能用。
    //        因为 FIFO 抹掉了行/场消隐，`~empty` 只是"本拍有一个像素可读"的
    //        **稀疏选通**（clk_cam 50MHz 快于像素率 24MHz ⇒ 大部分拍是空的）。
    //        下游按 VPS 契约（行内连续 de、行间有干净空隙）写的地方会因此错，
    //        详见 vps_resample.v 的 H63 说明与 B2 末尾的呈现逻辑。
    // ========================================================================
    reg frame_pending;
    always @(posedge cam_pclk) begin
        if (!rst_n_pclk)                     frame_pending <= 1'b0;
        else if (tap_frame_start)            frame_pending <= 1'b1;
        else if (tap_px_valid)               frame_pending <= 1'b0;
    end

    wire             cdc0_full;
    wire [FIFO_AW:0] cdc0_wr_level;
    wire [16:0]      cdc0_rd_data;
    wire             cdc0_empty;
    wire [FIFO_AW:0] cdc0_rd_level;

    // ------------------------------------------------------------------------
    // ★★ H63 修复（2026-10-07）：CDC-0 的"帧起始标记"必须作为**消隐期的 vsync 拍**
    //    呈现，不能与第一个像素同拍。
    //
    //    为什么必须这样（两个独立的后果，第二个是隐蔽的坐标相位错位）：
    //      1) vps_resample 的 `o_de_next` 含 `~i_vsync` ⇒ 同拍的那个像素会被丢掉；
    //      2) 更关键的是 i_vsync 同拍复位 x_cnt ⇒ x_cnt=0 被分配给**输入 x=1**，
    //         于是抽点保留的是**奇数列**；而 vps_pattern_gen 通路（vsync 在消隐期、
    //         不丢像素）保留的是**偶数列**，上位机 engine.ts 也是 `sx = 2*x`（偶数列）。
    //         ⇒ 相机通路比"已逐事件对拍验证过的" pattern 通路整体错开 1 个输入像素，
    //           抽点相位与上位机不一致，坐标无法逐条对齐。
    //
    //    做法：队头若带帧标记，就**先单独出一拍 vsync（此时 de=0，正好是"消隐拍"）、
    //    且这一拍不弹出**；下一拍再弹出那一条，作为本帧第一个像素（de=1, vsync=0）。
    //    ⇒ 相机通路从此与 pattern 通路**结构完全一致**，`~i_vsync` 不再吞像素。
    //    （时序：cdc0_rd_data/o_empty 都是 FIFO 内部寄存器的输出，i_rd_en 只影响
    //      下一拍的读指针 ⇒ 无组合环。）
    // ------------------------------------------------------------------------
    reg  vs_tag_pending;                 // 本帧的 vsync 拍已经比像素早一拍呈现过

    wire cdc0_head_valid = ~cdc0_empty;
    wire cdc0_head_is_vs = cdc0_rd_data[16];
    wire cdc0_vs_shot    = cdc0_head_valid & cdc0_head_is_vs & ~vs_tag_pending;
    wire cdc0_pop        = cdc0_head_valid & ~cdc0_vs_shot;

    always @(posedge clk_cam) begin
        if (!rst_n_cam)        vs_tag_pending <= 1'b0;
        else if (cdc0_vs_shot) vs_tag_pending <= 1'b1;
        else if (cdc0_pop)     vs_tag_pending <= 1'b0;
    end

    axis_fifo #(
        .DATA_W (17),
        .DEPTH  (2048),
        .FWFT   (1)
    ) u_cdc0_fifo (
        .wr_clk     (cam_pclk),
        .wr_rst_n   (rst_n_pclk),
        .i_wr_en    (tap_px_valid & ~cdc0_full),
        .i_wr_data  ({frame_pending, tap_px_data}),
        .o_full     (cdc0_full),
        .o_wr_level (cdc0_wr_level),
        .rd_clk     (clk_cam),
        .rd_rst_n   (rst_n_cam),
        .i_rd_en    (cdc0_pop),          // ★ H63：帧标记那一拍不弹，先出 vsync
        .o_rd_data  (cdc0_rd_data),
        .o_empty    (cdc0_empty),
        .o_rd_level (cdc0_rd_level)
    );

    // CDC-0 像素丢弃计数（满时写入失败）
    reg [15:0] px_ovf_cnt;
    always @(posedge cam_pclk) begin
        if (!rst_n_pclk)                                px_ovf_cnt <= 16'd0;
        else if (tap_px_valid && cdc0_full)             px_ovf_cnt <= px_ovf_cnt + 16'd1;
    end
    assign o_stat_px_fifo_ovf = px_ovf_cnt;

    // ★ H63：de = "本拍弹出一个像素"；vsync = 单独的消隐拍（两者互斥）
    wire        vps_de_cam     = cdc0_pop;
    wire [15:0] vps_data_cam   = cdc0_rd_data[15:0];
    wire        vps_vsync_cam  = cdc0_vs_shot;

    // ========================================================================
    // B3: 视频源自选（相机 / 自检图案）
    // ========================================================================
    wire        pat_vsync, pat_de;
    wire [15:0] pat_data;

    vps_pattern_gen #(
        .IMG_W (IN_W),
        .IMG_H (IN_H)
    ) u_pattern_gen (
        .clk_cam   (clk_cam),
        .rst_n_cam (rst_n_cam),
        .i_mode    (i_cfg_pattern_mode),
        .i_en      (i_cfg_src == 2'd1),
        .o_vsync   (pat_vsync),
        .o_de      (pat_de),
        .o_data    (pat_data)
    );

    wire        mux_vsync, mux_de;
    wire [15:0] mux_data;

    vps_mux u_vps_mux (
        .clk_cam   (clk_cam),
        .rst_n_cam (rst_n_cam),
        .i_sel     (i_cfg_src),
        .a_vsync   (vps_vsync_cam),
        .a_de      (vps_de_cam),
        .a_data    (vps_data_cam),
        .b_vsync   (pat_vsync),
        .b_de      (pat_de),
        .b_data    (pat_data),
        .o_vsync   (mux_vsync),
        .o_de      (mux_de),
        .o_data    (mux_data)
    );

    // ========================================================================
    // B4: 抽点 800×480 → 400×240
    // ========================================================================
    wire        rs_vsync, rs_de;
    wire [15:0] rs_data;

    vps_resample #(
        .IN_W    (IN_W),
        .IN_H    (IN_H),
        .X_DECIM (2),
        .Y_DECIM (2),
        .OUT_W   (EV_W),
        .OUT_H   (EV_H)
    ) u_resample (
        .clk_cam   (clk_cam),
        .rst_n_cam (rst_n_cam),
        .i_vsync   (mux_vsync),
        .i_de      (mux_de),
        .i_data    (mux_data),
        .o_vsync   (rs_vsync),
        .o_de      (rs_de),
        .o_data    (rs_data)
    );

    // ========================================================================
    // B5: 事件引擎链（全部 clk_cam 域，1 px/clk）
    //   px_luma → luma_log → temporal_diff → spatial_lap → event_gen
    // ========================================================================
    // 首帧标志：帧存未初始化，抑制首帧假事件
    //
    // ⚠️ R2 修复（Lead 落，由 verify-dev 的独立复核 + 变异实验给出根因）：
    //    首版写 `else if (rs_vsync) first_frame <= 1'b0;` —— **不行**。
    //    因为 `rs_vsync` 与"第一个有效像素"是**同拍**的，而 first_frame 要到下一个
    //    clk_cam 才生效 ⇒ 第一个像素进 temporal_diff 时 ff_d1 已经是 0 ⇒ 首帧没被抑制。
    //    实测：首个像素帧产生 **11920 个假事件**（期望 0）。
    //
    //    verify-dev 的变异实验还证明了"改成第 2 个 vsync 清 0"**同样不够**：
    //    "不带像素的 vsync"（复位后的空帧 / 真实硬件消隐期的 vsync）不该算一帧。
    //    ⇒ 正解是**只把"带过像素的帧"计作第一帧**：
    //       rs_de 置位 vs_had_px；rs_vsync 时若本帧有过像素，才认定"第一帧已过"。
    //    变异验证：把抑制延长到"第 2 个带像素的 vsync 之后" ⇒ A1 判据 PASS，
    //    说明该判据可证伪、且根因就是这一处。
    reg first_frame;
    reg vs_had_px;
    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            first_frame <= 1'b1;
            vs_had_px   <= 1'b0;
        end else begin
            if (rs_de) vs_had_px <= 1'b1;
            if (rs_vsync) begin
                if (vs_had_px) first_frame <= 1'b0;
                vs_had_px <= 1'b0;
            end
        end
    end

    wire        l1_vsync, l1_de;
    wire [7:0]  l1_y;

    px_luma u_px_luma (
        .clk_cam   (clk_cam),
        .rst_n_cam (rst_n_cam),
        .i_vsync   (rs_vsync),
        .i_de      (rs_de),
        .i_data    (rs_data),
        .o_vsync   (l1_vsync),
        .o_de      (l1_de),
        .o_y       (l1_y)
    );

    wire        l2_vsync, l2_de;
    wire [7:0]  l2_l;

    luma_log #(
        .ROM_LATENCY (1),
        .USE_ROM_IP  (0)
    ) u_luma_log (
        .clk_cam   (clk_cam),
        .rst_n_cam (rst_n_cam),
        .i_vsync   (l1_vsync),
        .i_de      (l1_de),
        .i_y       (l1_y),
        .o_vsync   (l2_vsync),
        .o_de      (l2_de),
        .o_l       (l2_l)
    );

    wire        l3_vsync, l3_de;
    wire [8:0]  l3_dl;

    temporal_diff #(
        .IMG_W (EV_W),
        .IMG_H (EV_H)
    ) u_temporal_diff (
        .clk_cam        (clk_cam),
        .rst_n_cam      (rst_n_cam),
        .i_vsync        (l2_vsync),
        .i_de           (l2_de),
        .i_l            (l2_l),
        .i_first_frame  (first_frame),
        .o_vsync        (l3_vsync),
        .o_de           (l3_de),
        .o_dl           (l3_dl)
    );

    wire         l4_vsync, l4_de;
    wire [11:0]  l4_lap;
    // 🔧 R3 + Bug B 集成重连（Lead）：spatial_lap 现在把**窗口中心的语义随流输出**
    //    —— 列/行坐标 + 该中心的 ΔL。event_gen 直接使用，**不再自己数 de 重建坐标**、
    //    也不再需要任何 delay_pipe 去猜"窗口中心那一拍"。
    //    这是 R3（坐标原点错位+逐帧漂移 ≈ −25 行/帧）与 Bug B（守卫 ΔL 取到别的像素）
    //    的共同根治方案：**信息随流走，不在下游重建**。
    wire [8:0]   l4_x;
    wire [7:0]   l4_y;
    wire [8:0]   l4_dl_c;

    spatial_lap #(
        .IMG_W (EV_W),
        .EDGE_MODE (0)
    ) u_spatial_lap (
        .clk_cam   (clk_cam),
        .rst_n_cam (rst_n_cam),
        .i_vsync   (l3_vsync),
        .i_de      (l3_de),
        .i_dl      (l3_dl),
        .o_vsync   (l4_vsync),
        .o_de      (l4_de),
        .o_lap     (l4_lap),
        .o_x       (l4_x),
        .o_y       (l4_y),
        .o_dl_c    (l4_dl_c)
    );

    wire        eg_ev_valid;
    wire [8:0]  eg_ev_x;
    wire [7:0]  eg_ev_y;
    wire        eg_ev_pol;

    event_gen u_event_gen (
        .clk_cam    (clk_cam),
        .rst_n_cam  (rst_n_cam),
        .i_de       (l4_de),
        .i_lap      (l4_lap),
        .i_dl_c     (l4_dl_c),          // 🔧 同像素的 ΔL（原为 l3_dl，错位 5~6 拍）
        .i_x        (l4_x),             // 🔧 坐标随流走（原为 event_gen 内部计数）
        .i_y        (l4_y),
        .i_theta    (i_cfg_theta),
        .i_min_dl   (i_cfg_min_dl),
        .o_ev_valid (eg_ev_valid),
        .o_ev_x     (eg_ev_x),
        .o_ev_y     (eg_ev_y),
        .o_ev_pol   (eg_ev_pol)
    );

    // ========================================================================
    // B6: 不应期抑制（可旁路）
    // ========================================================================
    wire        rf_ev_valid;
    wire [8:0]  rf_ev_x;
    wire [7:0]  rf_ev_y;
    wire        rf_ev_pol;

    refractory #(
        .IMG_W (EV_W),
        .IMG_H (EV_H)
    ) u_refractory (
        .clk_cam     (clk_cam),
        .rst_n_cam   (rst_n_cam),
        .i_vsync     (l4_vsync),
        .i_bypass    (i_cfg_refr_bypass),
        .i_ev_valid  (eg_ev_valid),
        .i_ev_x      (eg_ev_x),
        .i_ev_y      (eg_ev_y),
        .i_ev_pol    (eg_ev_pol),
        .o_ev_valid  (rf_ev_valid),
        .o_ev_x      (rf_ev_x),
        .o_ev_y      (rf_ev_y),
        .o_ev_pol    (rf_ev_pol)
    );

    // ========================================================================
    // B7: 事件位图 BRAM（16 bit 地址 / 8 bit 数据，2 px/字）
    //     A 口 clk_cam：事件 RMW（优先） + 帧末衰减扫描
    //     B 口 clk_lcd：只读
    // ========================================================================
    reg [7:0] bmp_mem [0:BMP_WORDS-1];

    // 仿真初值（综合时作为 BRAM INIT，不引入复位逻辑）
    initial begin
        for (i = 0; i < BMP_WORDS; i = i + 1) bmp_mem[i] = 8'h00;
    end

    // ---- 事件写缓存（小同步 FIFO，clk_cam）----
    reg  [17:0] evf_mem [0:EVF_DEPTH-1];
    reg  [EVF_AW:0] evf_wp, evf_rp;

    wire evf_empty = (evf_wp == evf_rp);
    wire evf_full  = ((evf_wp - evf_rp) == EVF_DEPTH[EVF_AW:0]);

    wire        ev_push = rf_ev_valid & i_cfg_ev_en;
    wire [17:0] ev_head = evf_mem[evf_rp[EVF_AW-1:0]];
    wire        ev_sel_now = ~evf_empty;            // 有事件待写

    // ---- 统一 RMW 状态机（事件优先，衰减扫描让路）----
    localparam S_IDLE = 1'b0;
    localparam S_WR   = 1'b1;

    reg        rmw_state;
    reg [15:0] rmw_addr;
    reg        rmw_is_ev;
    reg        rmw_sel;
    reg        rmw_pol;

    // 衰减扫描
    reg        sw_active;
    reg [15:0] sw_addr;

    // ⚠️ 这两根线必须在"用到它们的 always 块"之前声明（Verilog 不允许先用后声明）
    wire ev_pop = (rmw_state == S_IDLE) & ev_sel_now;   // 弹出队头事件

    // 扫描让路条件：有事件待写 / 正在写，都必须停
    wire sw_run = sw_active & ~ev_sel_now & (rmw_state == S_IDLE);

    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            evf_wp <= 0;
            evf_rp <= 0;
        end else begin
            if (ev_push && !evf_full) evf_mem[evf_wp[EVF_AW-1:0]] <= {rf_ev_x, rf_ev_y, rf_ev_pol};
            if (ev_push && !evf_full) evf_wp <= evf_wp + 1'b1;
            if (ev_pop)               evf_rp <= evf_rp + 1'b1;
        end
    end

    reg [15:0] evf_ovf;
    always @(posedge clk_cam) begin
        if (!rst_n_cam)                                evf_ovf <= 16'd0;
        else if (ev_push && evf_full)                  evf_ovf <= evf_ovf + 16'd1;
    end
    assign o_stat_ev_fifo_ovf = evf_ovf;

    // 本拍要发起的读地址（IDLE 拍组合给出，下一拍数据到位）
    wire [8:0]  ev_head_x   = ev_head[17:9];
    wire [7:0]  ev_head_y   = ev_head[8:1];
    wire        ev_head_pol = ev_head[0];
    wire [15:0] ev_head_addr = {8'b0, ev_head_y} * WPL[15:0] + {8'b0, ev_head_x[8:1]};

    wire [15:0] rd_addr_now = (rmw_state == S_IDLE) ?
                              (ev_sel_now ? ev_head_addr : sw_addr) : 16'h0000;

    reg [7:0] bmp_rd_a;
    always @(posedge clk_cam) begin
        if (rmw_state == S_IDLE) bmp_rd_a <= bmp_mem[rd_addr_now[BMP_AW-1:0]];
    end

    // 合并新旧 4bit 单元
    wire [2:0] dstep = ((DECAY_EN != 0) && i_cfg_decay_en)
                     ? (i_cfg_decay_step[2:0] == 3'd0 ? 3'd1 : i_cfg_decay_step[2:0])
                     : 3'd0;
    wire [3:0] old_lo = bmp_rd_a[3:0];
    wire [3:0] old_hi = bmp_rd_a[7:4];
    wire [3:0] dec_lo = (old_lo > {1'b0, dstep}) ? (old_lo - {1'b0, dstep}) : 4'h0;
    wire [3:0] dec_hi = (old_hi > {1'b0, dstep}) ? (old_hi - {1'b0, dstep}) : 4'h0;
    wire [3:0] ev_nib = {rmw_pol, 3'b111};

    wire [3:0] new_lo = rmw_is_ev ? (rmw_sel ? old_lo : ev_nib) : dec_lo;
    wire [3:0] new_hi = rmw_is_ev ? (rmw_sel ? ev_nib : old_hi) : dec_hi;
    wire [7:0] new_word = {new_hi, new_lo};

    // 帧边界 → 触发一次全位图衰减扫描（取上升沿，避免 vsync 是电平时反复触发）
    wire align_vsync_w, align_de_w, align_dummy_w;
    wire sw_start_pulse;

    delay_pipe #(
        .WIDTH   (3),
        .LATENCY (PIPE_LAT)
    ) u_align_pipe (
        .clk    (clk_cam),
        .rst_n  (rst_n_cam),
        .i_data ({rs_vsync, rs_de, 1'b0}),
        .o_data ({align_vsync_w, align_de_w, align_dummy_w})
    );

    edge_detect #(.RST_LEVEL(0)) u_frame_edge (
        .clk    (clk_cam),
        .rst_n  (rst_n_cam),
        .i_sig  (align_vsync_w),
        .o_rise (sw_start_pulse),
        .o_fall (),
        .o_any  ()
    );

    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            rmw_state <= S_IDLE;
            rmw_addr  <= 16'h0000;
            rmw_is_ev <= 1'b0;
            rmw_sel   <= 1'b0;
            rmw_pol   <= 1'b0;
            sw_active <= 1'b0;
            sw_addr   <= 16'h0000;
        end else begin
            case (rmw_state)
                S_IDLE: begin
                    if (ev_sel_now) begin
                        rmw_addr  <= ev_head_addr;
                        rmw_is_ev <= 1'b1;
                        rmw_sel   <= ev_head_x[0];
                        rmw_pol   <= ev_head_pol;
                        rmw_state <= S_WR;
                    end else if (sw_active) begin
                        rmw_addr  <= sw_addr;
                        rmw_is_ev <= 1'b0;
                        rmw_state <= S_WR;
                        if (sw_addr >= (BMP_WORDS - 1)) begin
                            sw_active <= 1'b0;
                            sw_addr   <= 16'h0000;
                        end else begin
                            sw_addr   <= sw_addr + 16'd1;
                        end
                    end
                end

                S_WR: begin
                    rmw_state <= S_IDLE;
                end

                default: rmw_state <= S_IDLE;
            endcase

            // 帧边界触发下一次衰减扫描（等上一轮扫完再触发）
            if (sw_start_pulse && !sw_active) begin
                sw_active <= 1'b1;
                sw_addr   <= 16'h0000;
            end
        end
    end

    // 写端口：S_WR 拍写回（单一写口，事件与衰减共用）
    always @(posedge clk_cam) begin
        if (rmw_state == S_WR) begin
            bmp_mem[rmw_addr[BMP_AW-1:0]] <= new_word;
        end
    end

    // ---- 位图 B 口（clk_lcd 只读，1 拍延迟）----
    reg [7:0] bmp_rd_b;
    always @(posedge clk_lcd) begin
        bmp_rd_b <= bmp_mem[i_bmp_rd_addr[BMP_AW-1:0]];
    end
    assign o_bmp_rd_data = bmp_rd_b;

    // ========================================================================
    // B8: 统计（事件计数 / 活动率 / 数据量降低率）
    //     i_vsync 用上面已算好的 align_vsync_w（帧级对齐即可，不敏感）
    // ========================================================================
    stats_counter #(
        .IMG_W (EV_W),
        .IMG_H (EV_H)
    ) u_stats (
        .clk_cam          (clk_cam),
        .rst_n_cam        (rst_n_cam),
        .i_vsync          (align_vsync_w),
        .i_ev_valid       (rf_ev_valid & i_cfg_ev_en),
        .i_px_valid       (align_de_w),
        .o_ev_per_frame   (o_stat_ev_per_frame),
        .o_activity_q16   (o_stat_activity_q16),
        .o_cr_x10         (o_stat_cr_x10),
        .o_frame_cnt      (o_stat_frame_cnt),
        .o_ev_total       (o_stat_ev_total)
    );

    // ========================================================================
    // B9: 事件输出（EVS）
    // ========================================================================
    assign o_ev_valid = rf_ev_valid & i_cfg_ev_en;
    assign o_ev_x     = rf_ev_x;
    assign o_ev_y     = rf_ev_y;
    assign o_ev_pol   = rf_ev_pol;

endmodule

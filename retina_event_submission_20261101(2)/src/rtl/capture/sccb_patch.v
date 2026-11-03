//==============================================================================
// sccb_patch -- OV5640 曝光上限 SCCB 补写模块（独立新增，不改任何既有文件）
//
// 背景（docs/05_experiments/帧率实验设计_20261007/5_曝光上限补写方案.md）：
//   厂家初始化表 i2c_ov5640_rgb565_cfg.v:363-366 把 AEC 曝光上限写成常量
//   0x3a02/0x3a03 = 0x1710（60Hz max exposure，5904 行）、
//   0x3a14/0x3a15 = 0x1710（50Hz max exposure，5904 行）。
//   时序覆盖层把 VTS 压到 900/750/600/520 后，曝光上限 5904 > VTS，
//   AEC 可请求超出帧长的曝光 ⇒ 帧率不升/画面变暗/停流。
//   本模块在厂家 250 条初始化完成（init_done）且总线空闲后，经同一 SCCB
//   总线**追加**写入这 4 条寄存器（先高字节后低字节），然后永久释放总线。
//
// 设计要点：
//   1. 独立模块：不修改、不例化厂家 i2c_dri（其 sda 为 inout 三态， bury 在
//      子模块内部会形成 Vivado 不支持的内部三态网）。改为自含一个**只写**
//      SCCB 主机，位时序完全沿用厂家约定：SCL = I2C_FREQ（默认 250 kHz，
//      与 ov5640_dri.v:53 一致），1 bit = CLK_FREQ/I2C_FREQ 个 clk，SCL 高/
//      低各占一半，数据在 SCL 低电平期更新、SCL 高电平期被从机采样，
//      MSB 先行，16 位寄存器地址（bit_ctrl=1 等价），SLAVE_ADDR=7'h3c。
//   2. 输出全部为 2 态（o_scl / o_sda_out / o_sda_oe），SDA 在每个字节的
//      第 9 位（SCCB 规范 3.2.3 的 Don't-Care 位）主动释放（o_sda_oe=0），
//      供从机应答；写完成与否以 STOP 收尾判定（SCCB 规范：master 不检查
//      写传输错误），ACK 仅作为 o_ack_cnt 观测量，不作为成功条件。
//   3. 集成侧（将来改 display_path.v，本模块不管）按 5_曝光上限补写方案.md
//      §5 做引脚 mux：
//        assign cam_scl = patch_owner ? patch_scl : dri_scl;
//        assign cam_sda = patch_owner ? (patch_sda_oe ? patch_sda : 1'bz) : dri_sda;
//      并把 cam_sda（pad）接回本模块 i_sda 做 ACK 采样。
//      EN=0（默认）时本模块完全惰性：o_owner 恒 0、o_sda_oe 恒 0，
//      mux 永远停在厂家分支，位流行为与不加本模块等价。
//   4. 接管时机三重判定（对齐方案 §2.1.2 的 C1/C2/C3）：
//      C1 init_done 上升沿（2 拍同步 + 沿检测）；C2 再等 ARM_STABLE_CYC 拍；
//      C3 厂家侧 i_dri_scl/i_dri_sda 双高连续 BUS_IDLE_CYC 拍（≥1 个厂家
//      dri_clk 周期，覆盖 init_done 那拍厂家 i2c_dri 仍在 st_stop 的情形）。
//      释放前同样保持 REL_HOLD_CYC 拍双高。
//   5. 曝光上限值来源三选一（cap 在接管时刻锁存 cap_q，运行期变化不影响本次序列）：
//        · CAP_FROM_CMD=1（集成档）：用 i_cap_val（下行动态写入的运行时可写寄存器，
//          由 top 的 sys_ctrl 保持，复位默认 = 构建期 OVL_EXP_CAP_LINES = 0x1710），
//          钳位到 [EXP_CAP_MIN, EXP_CAP_MAX]。
//        · CAP_FROM_CMD=0 且 CAP_FROM_VTS=1：cap = clamp(i_vts - CAP_GUARD, MIN, MAX)。
//        · CAP_FROM_CMD=0 且 CAP_FROM_VTS=0（默认，与既有 TB 逐比特一致）：用
//          参数 EXP_CAP_LINES（默认 16'h1710 = 5904 行 = 当前基线档）。
//   6. 复位/重入：rst_n 低 → 立即释放总线（owner=0、oe=0、SCL 高），不会把
//      总线拉死；init_done 每次上升沿重新武装一遍（厂家重新初始化后自动补写）。
//   7. ★ 运行时可写重触发（CAP_FROM_CMD=1 档的新增语义）：
//      i_cap_upd 是"写入脉冲的 toggle 沿"信号（与 i_cap_val 同域，另加 2 拍同步
//      防御），其上升沿 = "cap 已被改" ⇒ 重新武装，本模块再完整重跑一遍 4 条写序列
//      （3a02/3a03/3a14/3a15 全部按新值重写，不是只改一条）。
//      若重触发落在本模块**运行期间**，置 rearm_pending 挂起，等本轮写完并释放
//      总线后自动补跑一轮（不会打断在途事务，也不会丢这次写入）。
//      init_done 沿与 i_cap_upd 沿的优先级一致（都只是"武装"），两者同时到达只跑一轮。
//
// 时钟域：单时钟 clk（与厂家 i2c_dri 的 clk 同源 50 MHz），无 CDC。
//         输出 o_owner/o_patch_done 等为 clk 域寄存器，集成侧按常规 2 拍同步使用。
//
// 规格：docs/05_experiments/帧率实验设计_20261007/5_曝光上限补写方案.md §2.1
//==============================================================================
`timescale 1ns / 1ps

module sccb_patch #(
    parameter        EN            = 1'b0,          // 0=完全惰性（默认，集成安全）; 1=使能补写
    parameter        SLAVE_ADDR    = 7'h3c,         // OV5640 SCCB 器件地址（写=0x78）
    parameter        CLK_FREQ      = 27'd50_000_000,// clk 频率（与厂家 i2c_dri 一致）
    parameter        I2C_FREQ      = 18'd250_000,   // SCL 频率（与厂家 ov5640_dri 一致，<=400kHz）
    parameter [15:0] EXP_CAP_LINES = 16'h1710,      // 曝光上限（行）：默认 = 厂家基线 5904（0x1710）
    parameter [15:0] EXP_CAP_MAX   = 16'h1710,      // 上钳：不放宽厂家原上限（5904）
    parameter [15:0] EXP_CAP_MIN   = 16'd4,         // 下钳：至少 4 行
    parameter        CAP_FROM_VTS  = 1'b0,          // 0=用 EXP_CAP_LINES; 1=用 i_vts-CAP_GUARD 推导
    parameter        CAP_FROM_CMD  = 1'b0,          // ★ 1=用 i_cap_val（运行时可写命令值），钳位后使用
    parameter [12:0] CAP_GUARD     = 13'd4,         // VTS 模式余量：cap = VTS - 4
    // ---- ★ 实验档（2026-10-13 曝光生效验证任务，默认 0 = 与既有 TB 逐比特一致）----
    //   背景（手册 + 实测，见 docs/05_experiments/曝光生效验证_20261013/）：
    //     `0x3a02/03`（60Hz）与 `0x3a14/15`（50Hz）是 **AEC 的"夜视模式曝光上限"**
    //     （OV5640 数据手册 §4.6.1.3 / §7.8），只有 `0x3A00 bit[2]`（Night mode）为 1
    //     时才被 AEC 当作上限；`0x3A00` 复位默认 `0x78`（bit[2]=0）且厂家初始化表
    //     **不写 0x3A00** ⇒ 只写 4 条上限**在板上无任何效果**（ILA 已证写到了芯片）。
    //   ⇒ 本参数 = 1 时，先补写一条 `0x3A00 = AEC_CTRL_VAL`（默认 0x7C = 夜视模式开，
    //     与厂家应用指南 §4.2 的自动帧率档一致），**再**写 4 条上限 ⇒ 上限才生效。
    //   ⚠️ 0x7C 打开夜视模式 = 允许跨帧长曝光（暗场景会自动降帧）；这是实验档，
    //      交付默认 0（不加这条写），是否采用由项目决定。
    parameter        WR_AEC_CTRL   = 1'b0,          // 1 = 追加写 0x3A00 = AEC_CTRL_VAL
    parameter [7:0]  AEC_CTRL_VAL  = 8'h7c,         // 0x3A00 值（0x7C: bit[2]=Night mode 开）
    //   ★ 正向对照档：1 = 追加 3 条"手动曝光"写（0x3503 / 0x3501 / 0x3502）。
    //     cap = EXP_CAP_MAX 时写 0x3503=0x00（AEC 自动 = 恢复）；否则 0x3503=0x01 +
    //     固定 4 行曝光 ⇒ 画面应当**显著变暗**。用于把"上限寄存器不生效"归因到寄存器
    //     语义（而不是"写根本没进芯片"或"亮度测量不灵敏"）。默认 0 = 交付行为不变。
    parameter        MAN_EXP_EN    = 1'b0,
    parameter integer ARM_STABLE_CYC = 8,            // C2：init_done 沿后稳定等待（clk 拍）
    parameter integer BUS_IDLE_CYC   = 64,           // C3：双高连续拍数（>=1 个厂家 dri_clk 周期）
    parameter integer REL_HOLD_CYC   = 16,           // 释放前双高保持拍数
    parameter integer TX_GAP_CYC     = 20            // 两条事务之间的空闲拍数
)(
    input  wire        clk,          // 50 MHz 系统时钟（厂家 i2c_dri.clk 同源）
    input  wire        rst_n,        // 低有效复位
    input  wire        init_done,    // 厂家 ov5640_dri.cam_init_done（sticky）
    input  wire [12:0] i_vts,        // 覆盖后的 total_v_pixel（CAP_FROM_VTS=1 时用）
    // ---- ★ 运行时可写曝光上限（CAP_FROM_CMD=1 档；与 clk 同域，另加 2 拍同步）----
    input  wire [15:0] i_cap_val,    // 命令写入的 cap（行），复位默认由上层寄存器给出（0x1710）
    input  wire        i_cap_upd,    // toggle：每到一次"已接受的 cap 写入"翻转一次 ⇒ 上升沿 = 重触发
    input  wire        i_dri_scl,    // 厂家驱动侧 SCL（pad 前），空闲判定用
    input  wire        i_dri_sda,    // 厂家驱动侧 SDA（pad 前），空闲判定用
    input  wire        i_sda,        // SDA 回读（集成侧接 cam_sda pad），ACK 采样用
    output wire        o_owner,      // 1 = 本模块占总线（mux 选择信号）
    output wire        o_scl,        // 补写 SCL（推挽）
    output wire        o_sda_out,    // 补写 SDA 数据（配 o_sda_oe 用）
    output wire        o_sda_oe,     // 补写 SDA 驱动使能（0=释放，Don't-Care 位）
    output wire [2:0]  o_done_cnt,   // 已完成事务数 0..4
    output wire [2:0]  o_ack_cnt,    // 4 个字节 Don't-Care 位均读到 0 的事务数（仅观测）
    output wire        o_patch_done  // 4/4 全部写完且总线已释放（sticky，供回传使能联动）
);

    // ------------------------------------------------------------------
    // EN=0：完全惰性。无任何寄存器，o_owner/o_sda_oe 恒 0（不驱动总线）。
    // ------------------------------------------------------------------
    generate
    if (EN == 0) begin : g_inert
        assign o_owner       = 1'b0;
        assign o_scl         = 1'b1;
        assign o_sda_out     = 1'b1;
        assign o_sda_oe      = 1'b0;
        assign o_done_cnt    = 3'd0;
        assign o_ack_cnt     = 3'd0;
        assign o_patch_done  = 1'b0;
    end
    else begin : g_patch

    // ---- 位时序参数 ------------------------------------------------------
    localparam integer PH_PER_BIT  = CLK_FREQ / I2C_FREQ;                 // 每 bit 的 clk 数（默认 200 = 4us）
    localparam integer PH_MID      = PH_PER_BIT >> 1;                     // SCL 翻转中点
    localparam integer PH_ACK_SAMP = (PH_PER_BIT > 64) ? (PH_PER_BIT - 20)// Don't-Care 位采样点（SCL 高电平后段）
                                                       : (PH_PER_BIT >> 1);
    // ★ 事务总数（顺序：4 条上限 → [0x3A00] → [0x3503/0x3501/0x3502]）
    localparam [3:0] LAST_TX = MAN_EXP_EN    ? 4'd7 :
                               WR_AEC_CTRL   ? 4'd4 : 4'd3;

    // ---- 状态机 ----------------------------------------------------------
    localparam [3:0] S_IDLE  = 4'd0;  // 空闲，等 init_done 上升沿武装
    localparam [3:0] S_ARM   = 4'd1;  // C2/C3：稳定等待 + 厂家侧双高确认
    localparam [3:0] S_TAKE  = 4'd2;  // 接管总线（owner=1），锁存 cap
    localparam [3:0] S_START = 4'd3;  // 起始位（SCL 高时 SDA 1->0）
    localparam [3:0] S_BIT   = 4'd4;  // 数据位（8 位循环）
    localparam [3:0] S_ACK   = 4'd5;  // 第 9 位（释放 SDA，采样 Don't-Care）
    localparam [3:0] S_STOP  = 4'd6;  // 停止位（SCL 高时 SDA 0->1）
    localparam [3:0] S_GAP   = 4'd7;  // 事务间空闲
    localparam [3:0] S_REL   = 4'd8;  // 补写完成，释放前双高保持
    localparam [3:0] S_DONE  = 4'd9;  // 置 done，回 IDLE

    reg  [3:0]  state;
    reg         owner_r;
    reg         scl_r;
    reg         sda_out_r;
    reg         sda_oe_r;
    reg  [3:0]  tx_idx;        // 事务序号 0..7（见 LAST_TX；默认档只用到 0..3）
    reg  [1:0]  byte_idx;      // 事务内字节序号 0..3
    reg  [3:0]  bit_idx;       // 字节内位序号 0..7，8=Don't-Care 槽
    reg  [15:0] ph;
    reg  [7:0]  shifter;       // 当前发送字节（MSB 先行）
    reg  [15:0] cap_q;         // 接管时刻锁存的曝光上限
    reg         txn_ack_ok;    // 本事务 4 个 Don't-Care 位是否全为 0
    reg  [15:0] arm_cnt, idle_cnt, gap_cnt, rel_cnt;
    reg         init_s1, init_s2, init_s3;
    reg         armed;
    reg         rearm_pending;   // ★ 运行时可写 cap 的重触发挂号（busy 期间到达也不丢）
    reg         run_done;
    reg  [2:0]  done_cnt_r, ack_cnt_r;

    // ---- cap 计算（组合，接管时锁存）------------------------------------
    // CAP_FROM_CMD=1：用运行时可写寄存器值 i_cap_val，钳位到 [MIN, MAX]
    //   （下行动态写入侧已做过值域校验；这里的钳位是"纵深防御"，防上层误配）。
    // CAP_FROM_CMD=0 且 CAP_FROM_VTS=0：直接用参数（综合期常量）。
    // CAP_FROM_CMD=0 且 CAP_FROM_VTS=1：cap = clamp(i_vts - CAP_GUARD, MIN, MAX)。
    wire [15:0] vts_sub   = {3'd0, i_vts} - {3'd0, CAP_GUARD};
    wire [15:0] floor_thr = {3'd0, CAP_GUARD} + EXP_CAP_MIN;
    wire [15:0] vts_cap   = ({3'd0, i_vts} <= floor_thr) ? EXP_CAP_MIN :
                            (vts_sub > EXP_CAP_MAX)      ? EXP_CAP_MAX : vts_sub;
    wire [15:0] cmd_cap   = (i_cap_val < EXP_CAP_MIN) ? EXP_CAP_MIN :
                            (i_cap_val > EXP_CAP_MAX) ? EXP_CAP_MAX : i_cap_val;
    wire [15:0] cap_calc  = CAP_FROM_CMD ? cmd_cap :
                            CAP_FROM_VTS ? vts_cap : EXP_CAP_LINES;

    // ---- 寄存器写序列（顺序固定，靠 LAST_TX 决定写到哪一条）----
    //   idx 0..3 : 4 条曝光上限（60Hz 高/低 -> 50Hz 高/低，先高字节后低字节）
    //   idx 4    : 0x3A00（仅 WR_AEC_CTRL=1）—— 夜视模式开
    //   idx 5..7 : 手动曝光（仅 MAN_EXP_EN=1）—— 0x3503 / 0x3501 / 0x3502
    //              ★ 这是"正向对照"：cap = EXP_CAP_MAX 时写 0x3503=0x00（AEC 自动，
    //                用于恢复），否则写 0x3503=0x01（AEC 手动）+ 固定小曝光
    //                （0x3501=0x00, 0x3502=0x40 ⇒ 快门 = 0x3500<<12+0x3501<<4+0x3502>>4 = 4 行）
    //                ⇒ 若画面**因此变暗**，就证明"SCCB 写能真的改变传感器曝光"
    //                  （从而把"4 条上限不生效"干净地归因到寄存器语义）。
    reg [23:0] tx_word;
    wire man_auto = (cap_q == EXP_CAP_MAX);         // 恢复档：AEC 交回自动
    always @(*) begin
        case (tx_idx)
            4'd0:    tx_word = {16'h3a02, cap_q[15:8]}; // 60Hz max exposure 高
            4'd1:    tx_word = {16'h3a03, cap_q[7:0]};  // 60Hz max exposure 低
            4'd2:    tx_word = {16'h3a14, cap_q[15:8]}; // 50Hz max exposure 高
            4'd3:    tx_word = {16'h3a15, cap_q[7:0]};  // 50Hz max exposure 低
            4'd4:    tx_word = {16'h3a00, AEC_CTRL_VAL};// AEC CTRL00（bit[2]=Night mode）
            4'd5:    tx_word = {16'h3503, man_auto ? 8'h00 : 8'h01}; // AEC 手动/自动
            4'd6:    tx_word = {16'h3501, 8'h00};       // 曝光 [15:8]（行）
            default: tx_word = {16'h3502, 8'h40};       // 曝光 [7:0]（低 4 位 = 1/16 行）
        endcase
    end

    // ---- init_done 2 拍同步 + 上升沿检测 ---------------------------------
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            init_s1 <= 1'b0; init_s2 <= 1'b0; init_s3 <= 1'b0;
        end else begin
            init_s1 <= init_done;
            init_s2 <= init_s1;
            init_s3 <= init_s2;
        end
    end
    wire init_rise = init_s2 & ~init_s3;

    // ---- ★ 运行时可写 cap 的重触发沿（i_cap_upd 为 toggle）----------------
    // 同域使用，仍走 2 拍同步（防御上层将来跨域或抖动），再取"变化沿"。
    reg cap_tog_s1, cap_tog_s2, cap_tog_s3;
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            cap_tog_s1 <= 1'b0; cap_tog_s2 <= 1'b0; cap_tog_s3 <= 1'b0;
        end else begin
            cap_tog_s1 <= i_cap_upd;
            cap_tog_s2 <= cap_tog_s1;
            cap_tog_s3 <= cap_tog_s2;
        end
    end
    wire cap_upd_rise = cap_tog_s2 ^ cap_tog_s3;

    // ---- 主状态机（单时钟，无 CDC）---------------------------------------
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state      <= S_IDLE;
            owner_r    <= 1'b0;
            scl_r      <= 1'b1;
            sda_out_r  <= 1'b1;
            sda_oe_r   <= 1'b0;      // 复位即释放 SDA，不把总线拉死
            tx_idx     <= 4'd0;
            byte_idx   <= 2'd0;
            bit_idx    <= 4'd0;
            ph         <= 16'd0;
            shifter    <= 8'hff;
            cap_q      <= 16'h1710;
            txn_ack_ok <= 1'b1;
            arm_cnt    <= 16'd0;
            idle_cnt   <= 16'd0;
            gap_cnt    <= 16'd0;
            rel_cnt    <= 16'd0;
            armed      <= 1'b0;
            rearm_pending <= 1'b0;
            run_done   <= 1'b0;
            done_cnt_r <= 3'd0;
            ack_cnt_r  <= 3'd0;
        end else begin
            // ★ 运行时可写 cap 的重触发挂号：任何状态（含 busy）到达都记下
            if (cap_upd_rise) rearm_pending <= 1'b1;
            case (state)
                // -------- 空闲：等武装请求 --------
                S_IDLE: begin
                    owner_r   <= 1'b0;
                    scl_r     <= 1'b1;
                    sda_out_r <= 1'b1;
                    sda_oe_r  <= 1'b0;
                    if (init_rise)
                        armed <= 1'b1;
                    if (armed || rearm_pending) begin
                        armed         <= 1'b0;
                        rearm_pending <= 1'b0;
                        arm_cnt  <= 17'd0;
                        idle_cnt <= 17'd0;
                        state    <= S_ARM;
                    end
                end
                // -------- C2 稳定等待 + C3 厂家侧双高确认 --------
                S_ARM: begin
                    if (arm_cnt < ARM_STABLE_CYC)
                        arm_cnt <= arm_cnt + 16'd1;
                    if (i_dri_scl === 1'b1 && i_dri_sda === 1'b1) begin
                        if (idle_cnt < BUS_IDLE_CYC)
                            idle_cnt <= idle_cnt + 16'd1;
                    end else begin
                        idle_cnt <= 16'd0;
                    end
                    if (arm_cnt >= ARM_STABLE_CYC && idle_cnt >= BUS_IDLE_CYC &&
                        i_dri_scl === 1'b1 && i_dri_sda === 1'b1)
                        state <= S_TAKE;
                end
                // -------- 接管：owner 拉高、锁存 cap、清计数 --------
                S_TAKE: begin
                    owner_r    <= 1'b1;
                    scl_r      <= 1'b1;
                    sda_out_r  <= 1'b1;   // 推挽高，与厂家空闲电平无缝衔接
                    sda_oe_r   <= 1'b1;
                    armed      <= 1'b0;
                    run_done   <= 1'b0;
                    done_cnt_r <= 3'd0;
                    ack_cnt_r  <= 3'd0;
                    tx_idx     <= 4'd0;
                    ph         <= 16'd0;
                    cap_q      <= cap_calc;
                    state      <= S_START;
                end
                // -------- 起始位：SCL 高时 SDA 1->0 --------
                S_START: begin
                    if (ph == 16'd0) begin
                        sda_oe_r  <= 1'b1;
                        sda_out_r <= 1'b0;
                        shifter   <= {SLAVE_ADDR, 1'b0};  // 器件地址 + 写位
                        txn_ack_ok<= 1'b1;
                        byte_idx  <= 2'd0;
                        bit_idx   <= 4'd0;
                    end
                    if (ph == PH_MID)
                        scl_r <= 1'b0;
                    if (ph == PH_PER_BIT - 1) begin
                        ph    <= 16'd0;
                        state <= S_BIT;
                    end else begin
                        ph <= ph + 16'd1;
                    end
                end
                // -------- 数据位：SCL 低半更新 SDA，高半被从机采样 --------
                S_BIT: begin
                    if (ph == 16'd0) begin
                        sda_oe_r  <= 1'b1;
                        sda_out_r <= shifter[7];
                        shifter   <= {shifter[6:0], 1'b0};
                    end
                    if (ph == PH_MID)
                        scl_r <= 1'b1;
                    if (ph == PH_PER_BIT - 1) begin
                        scl_r   <= 1'b0;
                        bit_idx <= bit_idx + 4'd1;
                        ph      <= 16'd0;
                        if (bit_idx == 4'd7)
                            state <= S_ACK;
                    end else begin
                        ph <= ph + 16'd1;
                    end
                end
                // -------- 第 9 位：释放 SDA（SCCB Don't-Care），采样观测 --------
                S_ACK: begin
                    if (ph == 16'd0)
                        sda_oe_r <= 1'b0;               // 释放，交给从机
                    if (ph == PH_MID)
                        scl_r <= 1'b1;
                    if (ph == PH_ACK_SAMP) begin
                        if (i_sda !== 1'b0)             // 仅观测，不作成功条件
                            txn_ack_ok <= 1'b0;
                    end
                    if (ph == PH_PER_BIT - 1) begin
                        scl_r   <= 1'b0;
                        sda_oe_r<= 1'b1;
                        bit_idx <= 4'd0;
                        ph      <= 16'd0;
                        if (byte_idx == 2'd3) begin
                            state <= S_STOP;
                        end else begin
                            byte_idx <= byte_idx + 2'd1;
                            shifter  <= (byte_idx == 2'd0) ? tx_word[23:16] :
                                        (byte_idx == 2'd1) ? tx_word[15:8] :
                                                             tx_word[7:0];
                            state    <= S_BIT;
                        end
                    end else begin
                        ph <= ph + 16'd1;
                    end
                end
                // -------- 停止位：SCL 高时 SDA 0->1 --------
                S_STOP: begin
                    if (ph == 16'd0) begin
                        sda_oe_r  <= 1'b1;
                        sda_out_r <= 1'b0;
                    end
                    if (ph == 2'd2)
                        scl_r <= 1'b1;
                    if (ph == PH_MID)
                        sda_out_r <= 1'b1;              // SCL 高时 SDA 上升 = STOP
                    if (ph == PH_PER_BIT - 1) begin
                        ph         <= 16'd0;
                        state      <= S_GAP;
                        gap_cnt    <= 16'd0;
                        done_cnt_r <= tx_idx + 3'd1;
                        if (txn_ack_ok)
                            ack_cnt_r <= ack_cnt_r + 3'd1;
                    end else begin
                        ph <= ph + 16'd1;
                    end
                end
                // -------- 事务间空闲 --------
                S_GAP: begin
                    if (gap_cnt >= TX_GAP_CYC - 1) begin
                        gap_cnt <= 16'd0;
                        if (tx_idx == LAST_TX) begin
                            rel_cnt <= 16'd0;
                            state   <= S_REL;
                        end else begin
                            tx_idx <= tx_idx + 4'd1;
                            state  <= S_START;
                        end
                    end else begin
                        gap_cnt <= gap_cnt + 16'd1;
                    end
                end
                // -------- 释放前双高保持，然后交还总线 --------
                S_REL: begin
                    if (rel_cnt >= REL_HOLD_CYC - 1) begin
                        owner_r   <= 1'b0;
                        sda_oe_r  <= 1'b0;              // 与 owner 同拍释放驱动
                        sda_out_r <= 1'b1;
                        state     <= S_DONE;
                    end else begin
                        rel_cnt <= rel_cnt + 16'd1;
                    end
                end
                // -------- 置 done（sticky），回空闲 --------
                S_DONE: begin
                    run_done <= 1'b1;
                    state    <= S_IDLE;
                end
                default: state <= S_IDLE;
            endcase
        end
    end

    assign o_owner      = owner_r;
    assign o_scl        = scl_r;
    assign o_sda_out    = sda_out_r;
    assign o_sda_oe     = sda_oe_r;
    assign o_done_cnt   = done_cnt_r;
    assign o_ack_cnt    = ack_cnt_r;
    assign o_patch_done = run_done;

    end
    endgenerate

endmodule

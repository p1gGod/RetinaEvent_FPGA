//==============================================================================
// sys_ctrl -- 按键/下行命令 → RGS 参数（L0 板级基础）
//
// 规格：retina_event/docs/子模块设计/L0_板级基础/sys_ctrl.md
// v3 修订（2026-10-11，lead 键位裁决，覆盖 v3 设计 §3.2 的 KEY0 三态循环）：
//   KEY0 → 显示源切换（保持原语义：0 = 原始画面，1 = 事件画面）
//   KEY1 → 工作点轮换 0→1→2→3→0（成对 (θ, 守卫)，见 B5）
//   KEY2 → HUD 图层预设轮换 1111→0111→0011→0001→1111
//   KEY3 → 回传内容模式两态切换 RAW_EV(0) ↔ EV_ONLY(2)（v3 §3.1）
//          ★ 原"事件支路总使能"键位取消；v3.1 增补下行命令 EV_EN（0x05，
//            2026-10-11 lead 批准）接管 o_cfg_ev_en，复位默认 1
//   RAW_ONLY(1) 不绑物理键，仅经下行 SET_MODE（1235）可达（v3 §6.3.2）
//
// 显示源投影（LCD 与上行内容同步的落点，§3.2 单一真值源）：
//   o_cfg_disp_mode = (mode==RAW_ONLY) ? 0        // 仅原始
//                   : (mode==EV_ONLY)  ? 1        // 只显示事件画面
//                   : KEY0 的两态锁存                   // RAW_EV：KEY0 拍板
//
// 按键语义（★ 本板实测事实）：
//   - 引脚 T4/T3/R6/T6，**低有效**（按下 = 0），Bank34 ⇒ XDC 必须 LVCMOS15
//   - 必须消抖（20 ms）；要"按一下锁存切换"，取消抖后电平的下降沿
//
// ⚠️ CLK_FREQ_HZ 必须与 clk_rst_gen 实际产出的 clk_cam 一致（50 MHz）。
//==============================================================================
`timescale 1ns / 1ps

module sys_ctrl #(
    parameter CLK_FREQ_HZ   = 50000000,                 // clk_cam 频率（必须与实际一致）
    parameter DEBOUNCE_MS   = 20,                       // 消抖时间（ms）
    parameter CNT_MAX       = CLK_FREQ_HZ/1000*DEBOUNCE_MS,
    parameter THETA_ENTRIES = 4,                        // 工作点档位数（= HOST_PRESETS 条数）
    // ---- ★ 曝光上限运行时可写寄存器的复位默认值（构建期档位）----
    //   默认 16'h1710 = 5904 行 = 厂家基线档（与 sccb_patch 的 EXP_CAP_LINES 参数默认一致）
    parameter [15:0] EXP_CAP_DEF = 16'h1710
)(
    input  wire       clk_cam,
    input  wire       rst_n_cam,
    input  wire [3:0] i_key,            // 低有效：按下 = 0

    // ---- 下行命令写入通道（top 内 sync_ff 过域；toggle 沿触发，last-writer-wins）----
    input  wire [1:0]  i_mode_set_val,  // v3 SET_MODE 写入值（0/1/2）
    input  wire        i_mode_set_upd,  // v3 SET_MODE 翻转标志
    input  wire [11:0] i_theta_set_val, // v3 SET_PARAM tag 0x01
    input  wire        i_theta_set_upd,
    input  wire [8:0]  i_min_dl_set_val,// v3 SET_PARAM tag 0x02
    input  wire        i_min_dl_set_upd,
    input  wire        i_ev_en_set_val, // v3.1 EV_EN（0x05）写入值
    input  wire        i_ev_en_set_upd, // v3.1 EV_EN 翻转标志
    // ---- ★ WIRE-U1 串口参数写入通道（downlink_cmd → toggle+sync_ff 过域）----
    input  wire [1:0]  i_ev_res_set_val,     // SET_PARAM tag 0x07（0/1/2）
    input  wire        i_ev_res_set_upd,
    input  wire [7:0]  i_ser_decim_set_val,  // tag 0x08（1..255）
    input  wire        i_ser_decim_set_upd,
    input  wire [1:0]  i_ser_agg_set_val,    // tag 0x09（0/1/2）
    input  wire        i_ser_agg_set_upd,
    input  wire [15:0] i_ser_flush_set_val,  // tag 0x0A（5..1000 ms）
    input  wire        i_ser_flush_set_upd,
    // ---- ★ 曝光上限运行时可写（SET_PARAM tag 0x0B → 16 bit 值 + toggle）----
    input  wire [15:0] i_exp_cap_set_val,    // tag 0x0B（4..5904 行，行=0x3a02/03 口径）
    input  wire        i_exp_cap_set_upd,    // 每次"已接受的写入"翻转一次

    output reg        o_cfg_disp_mode,  // 显示源（投影后）：0 = 原始，1 = 事件
    output reg  [1:0] o_mode,           // ★ v3 回传模式：0=RAW_EV 1=RAW_ONLY 2=EV_ONLY
    output reg  [1:0] o_cfg_theta_sel,  // KEY1：阈值档位（可被 SET_PARAM 覆盖语义）
    output reg  [3:0] o_cfg_layer_en,   // KEY2：HUD 图层使能 {事件, 面板, 文字, 网格}
    output reg        o_cfg_ev_en,      // 事件支路总使能（★ v3 起恒 1，见文件头）

    output reg  [11:0] o_cfg_theta,     // B5 译码/下行写入后的**实际阈值**（event_gen）
    output reg  [8:0]  o_cfg_min_dl,    // 同上（最小亮度守卫）

    output reg        o_stat_mode,      // 回读：当前显示源（投影后）
    output reg  [3:0] o_key_pressed,    // 消抖后按键状态：1 = 该键处于按下
    // ---- ★ WIRE-U1 串口参数寄存器组（设计 §3.7 默认：0 / 32 / 0 / 20 ms）----
    output reg  [1:0]  o_ev_res,        // 回传分辨率档（0/1/2）
    output reg  [7:0]  o_ser_decim,     // 串口事件均匀抽点比（1..255）
    output reg  [1:0]  o_ser_agg,       // 串口编码档（0=RAW / 1=GRID8x6 / 2=GRID16x12）
    output reg  [15:0] o_ser_flush_ms,  // 串口短帧看门狗（ms）
    // ---- ★ 曝光上限运行时可写寄存器（→ display_path → sccb_patch）----
    output reg  [15:0] o_exp_cap,       // 当前 cap（行）；复位默认 = EXP_CAP_DEF = 0x1710
    output reg         o_exp_cap_upd    // toggle：沿 = "cap 已改" ⇒ 补写序列重跑
);

    // ----------------------------------------------------------------------
    // 工作点档位（θ, 守卫）—— **与上位机 HOST_PRESETS 同一套**（2026-10-06 适配）
    // （成对档位的完整理由见 git 历史版本 / 子模块设计文档 B5 节）
    // ----------------------------------------------------------------------
    localparam [1:0] PRESET_REGION = 2'd0;  // 运动区域（★ 上电默认）
    localparam [1:0] PRESET_LEAN   = 2'd1;  // 区域·省流
    localparam [1:0] PRESET_EDGE   = 2'd2;  // 运动边缘
    localparam [1:0] PRESET_LEGACY = 2'd3;  // 旧板端默认（对照用，非可用工作点）

    // v3 回传模式（§3.1）
    localparam [1:0] MODE_RAW_EV   = 2'd0;
    localparam [1:0] MODE_RAW_ONLY = 2'd1;
    localparam [1:0] MODE_EV_ONLY  = 2'd2;

    localparam CNT_W = $clog2(CNT_MAX + 2);

    genvar gi;

    // ------------------------------------------------------------------
    // B1: 异步按键 → clk_cam 域（两级同步器）
    // ------------------------------------------------------------------
    wire [3:0] key_sync;
    sync_ff #(.WIDTH(4), .STAGES(2)) u_key_sync (
        .dest_clk   (clk_cam),
        .dest_rst_n (rst_n_cam),
        .i_src      (i_key),
        .o_dst      (key_sync)
    );

    // ------------------------------------------------------------------
    // B2: 每键独立消抖计数器（电平稳定 >= CNT_MAX 拍才更新）
    // ------------------------------------------------------------------
    wire [3:0] key_deb;

    generate
        for (gi = 0; gi < 4; gi = gi + 1) begin : g_deb
            reg [CNT_W-1:0] cnt;
            reg             stb;

            always @(posedge clk_cam) begin
                if (!rst_n_cam) begin
                    cnt <= {CNT_W{1'b0}};
                    stb <= 1'b1;                       // 低有效 ⇒ 空闲电平为 1
                end else if (key_sync[gi] != stb) begin
                    if (cnt >= (CNT_MAX - 1)) begin
                        cnt <= {CNT_W{1'b0}};
                        stb <= key_sync[gi];           // 电平稳定够久 ⇒ 认可
                    end else begin
                        cnt <= cnt + 1'b1;
                    end
                end else begin
                    cnt <= {CNT_W{1'b0}};              // 电平回到一致 ⇒ 计数清零
                end
            end

            assign key_deb[gi] = stb;
        end
    endgenerate

    // ------------------------------------------------------------------
    // B3: 取"消抖后电平的下降沿"（低有效 ⇒ 下降沿 = 按下瞬间）
    // ------------------------------------------------------------------
    wire [3:0] key_fall;

    generate
        for (gi = 0; gi < 4; gi = gi + 1) begin : g_edge
            edge_detect #(.RST_LEVEL(1)) u_ed (
                .clk    (clk_cam),
                .rst_n  (rst_n_cam),
                .i_sig  (key_deb[gi]),
                .o_rise (),
                .o_fall (key_fall[gi]),
                .o_any  ()
            );
        end
    endgenerate

    // ------------------------------------------------------------------
    // B4: 锁存 / 切换逻辑
    //   KEY0：显示源两态（v3 修订：保持原语义不动）
    //   KEY3：回传模式两态 RAW_EV ↔ EV_ONLY（RAW_ONLY 仅下行可达）
    //   下行写入：toggle 沿触发（top 已 sync_ff 过域），last-writer-wins
    // ------------------------------------------------------------------
    reg disp_toggle;            // KEY0 的两态锁存（RAW_EV 模式下的显示源）
    reg mode_upd_d;             // 下行 SET_MODE toggle 的前一拍（沿检测）

    always @(posedge clk_cam) begin
        if (!rst_n_cam)                 disp_toggle <= 1'b0;
        else if (key_fall[0])           disp_toggle <= ~disp_toggle;
    end

    always @(posedge clk_cam) begin
        if (!rst_n_cam)                 o_mode <= MODE_RAW_EV;   // 上电默认 RAW_EV（§3.1）
        else if (key_fall[3])           o_mode <= (o_mode == MODE_EV_ONLY) ? MODE_RAW_EV
                                                                         : MODE_EV_ONLY;
        else if (i_mode_set_upd ^ mode_upd_d) o_mode <= i_mode_set_val;   // 下行 SET_MODE
    end

    always @(posedge clk_cam) begin
        if (!rst_n_cam) mode_upd_d <= 1'b0;
        else            mode_upd_d <= i_mode_set_upd;
    end

    always @(posedge clk_cam) begin
        if (!rst_n_cam)                 o_cfg_theta_sel <= PRESET_REGION;   // ★ 上电默认 = 已验证工作点
        else if (key_fall[1]) begin
            if (o_cfg_theta_sel >= (THETA_ENTRIES - 1)) o_cfg_theta_sel <= 2'd0;
            else                                        o_cfg_theta_sel <= o_cfg_theta_sel + 2'd1;
        end
    end

    always @(posedge clk_cam) begin
        if (!rst_n_cam)                 o_cfg_layer_en <= 4'b1111;
        else if (key_fall[2]) begin
            case (o_cfg_layer_en)
                4'b1111: o_cfg_layer_en <= 4'b0111;
                4'b0111: o_cfg_layer_en <= 4'b0011;
                4'b0011: o_cfg_layer_en <= 4'b0001;
                default: o_cfg_layer_en <= 4'b1111;
            endcase
        end
    end

    // ----------------------------------------------------------------------
    // B5: 实际工作点寄存器（θ / 守卫）
    //   KEY1 轮换 ⇒ 按"下一档位"成对写入（板上手动）—— 必须译码 sel 的下一值：
    //   sel 与 θ 寄存器同拍更新，若采样旧 sel 译码会把**上一档**的值写进去。
    //   下行 SET_PARAM ⇒ 直接写入（last-writer-wins，§6.3.1 写后 ACK 读回）
    //   上电默认 = 档位 0（θ=1 / 守卫=20），与 HOST_PRESETS[0] 一致
    // ----------------------------------------------------------------------
    function [11:0] theta_dec;      // 档位 → θ（与 hostparams.ts HOST_PRESETS 一致）
        input [1:0] s;
        begin
            case (s)
                PRESET_REGION: theta_dec = 12'd1;     // θ=1   运动区域
                PRESET_LEAN:   theta_dec = 12'd1;     // θ=1   区域·省流
                PRESET_EDGE:   theta_dec = 12'd3;     // θ=3   运动边缘
                default:       theta_dec = 12'd44;    // θ=44  旧板端默认（对照）
            endcase
        end
    endfunction

    function [8:0] min_dl_dec;      // 档位 → 守卫
        input [1:0] s;
        begin
            case (s)
                PRESET_REGION: min_dl_dec = 9'd20;    // 守卫=20
                PRESET_LEAN:   min_dl_dec = 9'd32;    // 守卫=32
                PRESET_EDGE:   min_dl_dec = 9'd18;    // 守卫=18
                default:       min_dl_dec = 9'd1;     // 守卫=1
            endcase
        end
    endfunction

    wire [1:0] sel_nxt = (o_cfg_theta_sel >= (THETA_ENTRIES - 1)) ? 2'd0
                                                                  : (o_cfg_theta_sel + 2'd1);
    reg [11:0] theta_q;     // 当前档位译码（观测用）
    reg [8:0]  min_dl_q;
    reg        theta_upd_d, min_dl_upd_d;

    always @(*) theta_q   = theta_dec(o_cfg_theta_sel);
    always @(*) min_dl_q  = min_dl_dec(o_cfg_theta_sel);

    always @(posedge clk_cam) begin
        if (!rst_n_cam)                       o_cfg_theta <= 12'd1;
        else if (key_fall[1])                 o_cfg_theta <= theta_dec(sel_nxt);
        else if (i_theta_set_upd ^ theta_upd_d) o_cfg_theta <= i_theta_set_val;
    end

    always @(posedge clk_cam) begin
        if (!rst_n_cam)                         o_cfg_min_dl <= 9'd20;
        else if (key_fall[1])                   o_cfg_min_dl <= min_dl_dec(sel_nxt);
        else if (i_min_dl_set_upd ^ min_dl_upd_d) o_cfg_min_dl <= i_min_dl_set_val;
    end

    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            theta_upd_d <= 1'b0;
            min_dl_upd_d <= 1'b0;
        end else begin
            theta_upd_d <= i_theta_set_upd;
            min_dl_upd_d <= i_min_dl_set_upd;
        end
    end

    // ------------------------------------------------------------------
    // B6: 状态汇总（遥测/调试）
    //   显示源投影：RAW_ONLY ⇒ 原始；EV_ONLY ⇒ 事件；RAW_EV ⇒ KEY0 拍板。
    //   这一行是"LCD 与上行包内容同步"的结构落点（§3.2 单一真值源）。
    // ------------------------------------------------------------------
    always @(*) begin
        case (o_mode)
            MODE_RAW_ONLY: o_cfg_disp_mode = 1'b0;
            MODE_EV_ONLY:  o_cfg_disp_mode = 1'b1;
            default:       o_cfg_disp_mode = disp_toggle;
        endcase
    end

    always @(*) o_stat_mode   = o_cfg_disp_mode;
    always @(*) o_key_pressed = ~key_deb;      // 1 = 按下

    // 事件支路总使能：KEY3 键位已取消（v3.1 起由下行 EV_EN 命令控制，复位默认 1）
    reg ev_en_q;
    reg ev_en_upd_d;
    always @(posedge clk_cam) begin
        if (!rst_n_cam)                        ev_en_q <= 1'b1;
        else if (i_ev_en_set_upd ^ ev_en_upd_d) ev_en_q <= i_ev_en_set_val;
    end
    always @(posedge clk_cam) begin
        if (!rst_n_cam) ev_en_upd_d <= 1'b0;
        else            ev_en_upd_d <= i_ev_en_set_upd;
    end
    always @(*) o_cfg_ev_en = ev_en_q;

    // ------------------------------------------------------------------
    // B7: ★ WIRE-U1 串口参数寄存器组（EV_RES / SER_DECIM / SER_AGG /
    //     SER_EV_FLUSH_MS）——与 θ/δL 同一套 toggle 沿写入（top 内 sync_ff 过域），
    //     last-writer-wins；复位默认取设计 §3.7 的出厂值。
    //     ⚠️ 未接端口（Z）时 `upd ^ d` = X ⇒ if 取假 ⇒ 不写，保持默认（仿真安全）。
    // ------------------------------------------------------------------
    reg ev_res_upd_d, decim_upd_d, agg_upd_d, flush_upd_d;

    always @(posedge clk_cam) begin
        if (!rst_n_cam)                        o_ev_res <= 2'd0;
        else if (i_ev_res_set_upd ^ ev_res_upd_d)     o_ev_res <= i_ev_res_set_val;
    end

    always @(posedge clk_cam) begin
        if (!rst_n_cam)                        o_ser_decim <= 8'd32;
        else if (i_ser_decim_set_upd ^ decim_upd_d)   o_ser_decim <= i_ser_decim_set_val;
    end

    always @(posedge clk_cam) begin
        if (!rst_n_cam)                        o_ser_agg <= 2'd0;
        else if (i_ser_agg_set_upd ^ agg_upd_d)       o_ser_agg <= i_ser_agg_set_val;
    end

    always @(posedge clk_cam) begin
        if (!rst_n_cam)                        o_ser_flush_ms <= 16'd20;
        else if (i_ser_flush_set_upd ^ flush_upd_d)   o_ser_flush_ms <= i_ser_flush_set_val;
    end

    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            ev_res_upd_d <= 1'b0;
            decim_upd_d  <= 1'b0;
            agg_upd_d    <= 1'b0;
            flush_upd_d  <= 1'b0;
        end else begin
            ev_res_upd_d <= i_ev_res_set_upd;
            decim_upd_d  <= i_ser_decim_set_upd;
            agg_upd_d    <= i_ser_agg_set_upd;
            flush_upd_d  <= i_ser_flush_set_upd;
        end
    end

    // ------------------------------------------------------------------
    // B8: ★ 曝光上限运行时可写寄存器（SET_PARAM tag 0x0B）
    //   与 θ/δL/SER 同一套 toggle 沿写入（top 内 cdc_tog_word 过域，last-writer-wins）。
    //   复位默认 = EXP_CAP_DEF（构建期档位，默认 0x1710 = 厂家基线）。
    //   o_exp_cap_upd 是**重触发 toggle**：每次本寄存器被改都翻转一次，供
    //   display_path 里的 sccb_patch 取沿重跑 4 条 SCCB 写序列（值也随同更新）。
    //   ⚠️ 等值写入不翻转（与 SET_MODE/EV_EN 的"等值写入零副作用"一致）——但
    //      值本身仍会写入（同值，无副作用）。
    //   ⚠️ 未接端口（Z）时 `upd ^ d` = X ⇒ if 取假 ⇒ 不写，保持默认（仿真安全）。
    // ------------------------------------------------------------------
    reg exp_cap_upd_d;

    always @(posedge clk_cam) begin
        if (!rst_n_cam)                            o_exp_cap <= EXP_CAP_DEF;
        else if (i_exp_cap_set_upd ^ exp_cap_upd_d) o_exp_cap <= i_exp_cap_set_val;
    end

    always @(posedge clk_cam) begin
        if (!rst_n_cam)                            exp_cap_upd_d <= 1'b0;
        else                                       exp_cap_upd_d <= i_exp_cap_set_upd;
    end

    // 重触发 toggle：只在"本次采到的新值与当前值不同"时翻转（等值写入零副作用）
    always @(posedge clk_cam) begin
        if (!rst_n_cam)
            o_exp_cap_upd <= 1'b0;
        else if ((i_exp_cap_set_upd ^ exp_cap_upd_d) &&
                 (i_exp_cap_set_val != o_exp_cap))
            o_exp_cap_upd <= ~o_exp_cap_upd;
    end

endmodule

//==============================================================================
// tb_sccb_patch -- sccb_patch 单元测试（ModelSim SE 2020.4，纯 Verilog-2001）
//
// 被测件：src/hdl/capture/sccb_patch.v（OV5640 曝光上限 SCCB 补写模块）
// 规格：docs/05_experiments/帧率实验设计_20261007/5_曝光上限补写方案.md
//
// TB 结构：
//   - 每个被测 DUT 挂一条独立 "总线"：TB 复刻集成侧引脚 mux（方案 §5 第 7 条）
//     + 上拉 + SCCB 从机模型（第 9 位 Don't-Care 可选拉低）+ 协议监视器。
//   - DUT_A：EN=1、其余参数全默认（EXP_CAP_LINES=0x1710=5904，CAP_FROM_VTS=0，
//     i_vts 接 999 干扰值验证参数模式不受 VTS 影响）。
//       A0：init_done 在厂家侧"忙"（SCL/SDA 翻转）期间到达 → 不得接管；
//           总线转双高后 ~1.4us 内接管（C2=8 拍 + C3=64 拍）。
//       A1：4 条事务按序 (3a02,17)(3a03,10)(3a14,17)(3a15,10)，协议零违例，
//           done/ack 计数、done 晚于 owner 释放、释放后 pad 回厂家侧。
//       静默 200us：无多余事务。
//       A2：init_done 再给一个上升沿 → 自动重跑一轮（4/4 再次成立）。
//   - DUT_B：EN=1、CAP_FROM_VTS=1，三个相位（各带复位）：
//       B1 VTS=750  → cap=746=0x02EA；从机正常应答 → ack_cnt=4
//       B2 VTS=6000 → 上钳 5904=0x1710；从机不应答（纯 SCCB Don't-Care）
//                     → 事务照常完成（ack_cnt=0），验证完成不依赖 ACK
//       B3 VTS=2    → 下钳 EXP_CAP_MIN=4=0x0004
//   - DUT_C：EN=0（默认）→ 完全惰性：owner/done 恒 0，SCL 恒高，SDA 永不驱动。
//   - DUT_D（★ SCCB 集成新增，2026-10-13）：EN=1 + CAP_FROM_CMD=1（**运行时可写**档）
//       D1：复位默认 cap=0x1710（= 厂家基线档，与下行寄存器复位默认一致）
//           + cam_init_done 上升沿 → 补写 4 条 0x1710（"cam_init_done 后补写触发"）
//       D2：命令改 cap=746（0x02EA，E3/A 档）经 i_cap_upd **toggle 沿** ⇒ 不等新
//           init_done、模块自动重跑整条 4 条序列，值逐条正确
//       D3：命令改 cap=896（0x0380，900 档）⇒ 再重跑一轮
//       D4：★在补写**进行中**改 cap=516（0x0204）⇒ 在途那一轮保持旧值写完，
//           挂起的新值在释放总线后自动补跑一轮（不打断事务、也不丢这次写入）
//       D5：越界值纵深防御：65535 → 上钳 0x1710；0 → 下钳 0x0004
//
// 断言覆盖（对应任务判据）：
//   ① 触发时机：A_PREINIT_QUIET / A_ARMED_BUSY_HOLD / A_TAKEOVER_LATENCY /
//      D1_TAKEOVER_INITDONE / D2/D3/D4_*（运行时可写重触发）/
//      C_INERT_*（EN=0 永不动总线）+ 全程连续不变量（非 owner 期间不得驱动）
//   ② 寄存器序列：A_TXN1..4 / A_ADDR_ORDER / A_REARM_VALS / B1/B2/B3_VALS
//      （TB 在 pad 上按位解码地址+数据，与参数推导值逐条比对）
//   ③ SCCB 时序：监视器断言 start/stop 形态、字节长度、ID 地址、SCL 高电平
//      期 SDA 稳定、位周期 4us±25%、高电平 2us±25%，以及第 9 位主机释放
//      SDA（从机拉低能被看见 = 主机未抢驱）
//
// 判定约定（tool/run_sim.ps1）：逐条 CHECK=<名> <PASS|FAIL>，收口恰好一行
//   TEST_RESULT=PASS|FAIL。$display 一律 ASCII（ModelSim 控制台 GBK）。
//==============================================================================
`timescale 1ns / 1ps

//------------------------------------------------------------------------------
// sccb_bus_mon -- SCCB 从机模型 + 协议监视器（仅 TB 使用）
//
// 时序期望按 DUT 参数 CLK_FREQ=50MHz / I2C_FREQ=250kHz 写死：
//   位周期 4000ns（高/低各约 2000ns）。
//------------------------------------------------------------------------------
module sccb_bus_mon #(
    parameter [8*8-1:0] TAGP    = "MON",
    parameter        SLAVE_ADDR = 7'h3c,
    parameter integer PERIOD_MIN = 3000,  // ns，SCL 上升沿间隔下限
    parameter integer PERIOD_MAX = 5000,  // ns，SCL 上升沿间隔上限
    parameter integer HIGHW_MIN  = 1500,  // ns，SCL 高电平宽度下限
    parameter integer HIGHW_MAX  = 2500,  // ns，SCL 高电平宽度上限
    parameter integer LOWW_MIN   = 1500   // ns，低于它的低电平段视为 STOP 序列时钟
)(
    input  wire        clk,
    input  wire        rst_n,      // 相位级复位（清捕获/错误/ACK 驱动）
    input  wire        mon_en,     // 1=监视+ACK 生效（接 DUT o_owner）
    input  wire        ack_en,     // 1=从机第 9 位拉低 SDA；0=浮空（SCCB Don't-Care）
    input  wire        scl,
    inout  wire        sda,
    output reg  [3:0]  txn_cnt,    // 收尾事务数（含非法的，配合 err_* 判读）
    output reg  [15:0] last_addr,
    output reg  [7:0]  last_data,
    output reg  [3:0]  start_cnt,
    output reg  [3:0]  stop_cnt,
    output reg         err_start,  // 事务中 SCL 高时 SDA 下降（本设计不用 repeated start）
    output reg         err_len,    // STOP 时字节数 != 4，或多于 4 字节
    output reg         err_addr,   // ID 字节 != {SLAVE_ADDR, W=0}
    output reg         err_stab,   // 非事务期 SCL 高时 SDA 上升（非法形态）
    output reg         err_period, // SCL 位周期越界
    output reg         err_highw   // SCL 高电平宽度越界
);
    pullup(sda);

    reg        in_txn;
    reg  [3:0] bit_idx;     // 0..7 数据位，8=Don't-Care 槽
    reg  [2:0] byte_cnt;    // 已收字节数 0..4
    reg  [7:0] shifter;
    reg  [7:0] id_byte, acc_hi, acc_lo, acc_dat;
    reg        ack_drv;
    reg  [1:0] ack_wait;
    reg        had_rise;    // t_rise 有效（可做周期/高宽检查）
    time       t_rise, t_fall;
    time       d_per, d_hi, d_lo;

    // ---- 从机 ACK 驱动（开漏）----
    // 第 8 个数据位收完且 SCL 低后延迟 2 拍拉低（避开主机释放前的驱动冲突），
    // 保持整个第 9 位，在位 idx 回 0 后的 SCL 下降沿释放。
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            ack_drv  <= 1'b0;
            ack_wait <= 2'd0;
        end else begin
            if (mon_en && in_txn && bit_idx == 4'd8 && scl == 1'b0) begin
                if (ack_wait < 2'd2)
                    ack_wait <= ack_wait + 2'd1;
                else if (ack_en)
                    ack_drv <= 1'b1;
            end else if (!mon_en || !in_txn) begin
                ack_drv  <= 1'b0;
                ack_wait <= 2'd0;
            end
        end
    end
    always @(negedge scl or negedge rst_n) begin
        if (!rst_n) begin
            ack_drv  <= 1'b0;
            ack_wait <= 2'd0;
        end else if (in_txn && bit_idx == 4'd0) begin
            ack_drv  <= 1'b0;
            ack_wait <= 2'd0;
        end
    end
    assign sda = ack_drv ? 1'b0 : 1'bz;

    // ---- START：非事务期 SCL 高时 SDA 下降 ----
    always @(negedge sda or negedge rst_n) begin
        if (!rst_n) begin
            in_txn <= 1'b0; byte_cnt <= 3'd0; bit_idx <= 4'd0;
            had_rise <= 1'b0; start_cnt <= 4'd0; err_start <= 1'b0;
        end else if (mon_en && sda === 1'b0 && scl === 1'b1) begin
            if (in_txn) begin
                err_start <= 1'b1;
                $display("%0s ERR %0t illegal SDA fall while SCL high in txn", TAGP, $time);
            end else begin
                in_txn    <= 1'b1;
                byte_cnt  <= 3'd0;
                bit_idx   <= 4'd0;
                had_rise  <= 1'b0;
                start_cnt <= start_cnt + 4'd1;
            end
        end
    end

    // ---- STOP：事务期 SCL 高时 SDA 上升；非事务期同形态为非法 ----
    always @(posedge sda or negedge rst_n) begin
        if (!rst_n) begin
            stop_cnt <= 4'd0; txn_cnt <= 4'd0; last_addr <= 16'hffff;
            last_data <= 8'hff; err_len <= 1'b0; err_addr <= 1'b0; err_stab <= 1'b0;
        end else if (mon_en && sda === 1'b1 && scl === 1'b1) begin
            if (in_txn) begin
                stop_cnt  <= stop_cnt + 4'd1;
                txn_cnt   <= txn_cnt + 4'd1;
                if (byte_cnt == 3'd4) begin
                    last_addr <= {acc_hi, acc_lo};
                    last_data <= acc_dat;
                    if (id_byte != {SLAVE_ADDR, 1'b0})
                        err_addr <= 1'b1;
                end else begin
                    err_len <= 1'b1;
                end
                in_txn   <= 1'b0;
                byte_cnt <= 3'd0;
                bit_idx  <= 4'd0;
                had_rise <= 1'b0;
                $display("%0s TXN %0t n=%0d id=%02h bytes=%0d addr=%04h data=%02h",
                         TAGP, $time, txn_cnt + 4'd1, id_byte, byte_cnt, {acc_hi, acc_lo}, acc_dat);
            end else begin
                err_stab <= 1'b1;
                $display("%0s ERR %0t unexpected SDA rise while SCL high (not in txn)", TAGP, $time);
            end
        end
    end

    // ---- SCL 上升沿：位采样 + 周期检查 ----
    always @(posedge scl or negedge rst_n) begin
        if (!rst_n) begin
            shifter <= 8'h00; id_byte <= 8'h00; acc_hi <= 8'h00; acc_lo <= 8'h00;
            acc_dat <= 8'h00; err_period <= 1'b0;
        end else if (mon_en && in_txn) begin
            d_lo = $time - t_fall;
            if (d_lo >= LOWW_MIN) begin
                if (had_rise) begin
                    d_per = $time - t_rise;
                    if (d_per < PERIOD_MIN || d_per > PERIOD_MAX)
                        err_period <= 1'b1;
                end
                had_rise <= 1'b1;
                t_rise   = $time;
            end else begin
                had_rise <= 1'b0;   // STOP 序列的短低电平时钟，不参与周期统计
            end
            if (bit_idx < 4'd8) begin
                shifter <= {shifter[6:0], (sda === 1'b0) ? 1'b0 : 1'b1};
                bit_idx <= bit_idx + 4'd1;
            end else begin
                case (byte_cnt)
                    3'd0:    id_byte <= shifter;
                    3'd1:    acc_hi  <= shifter;
                    3'd2:    acc_lo  <= shifter;
                    default: acc_dat <= shifter;
                endcase
                if (byte_cnt < 3'd4) byte_cnt <= byte_cnt + 3'd1;
                else                 err_len <= 1'b1;   // 超过 4 字节
                bit_idx <= 4'd0;
            end
        end else begin
            had_rise <= 1'b0;
        end
    end

    // ---- SCL 下降沿：高电平宽度检查 + 记录低电平起点 ----
    always @(negedge scl or negedge rst_n) begin
        if (!rst_n) begin
            t_fall = 0;
            err_highw <= 1'b0;
        end else begin
            t_fall = $time;
            if (mon_en && in_txn && had_rise) begin
                d_hi = $time - t_rise;
                if (d_hi < HIGHW_MIN || d_hi > HIGHW_MAX)
                    err_highw <= 1'b1;
            end
        end
    end

endmodule

//==============================================================================
// 主 TB
//==============================================================================
module tb_sccb_patch;

    // ---- 时钟与计分 ----
    reg clk = 1'b0;
    always #10 clk = ~clk;      // 50 MHz

    integer errors = 0;
    integer checks = 0;
    integer kk;
    integer poll_n;
    reg    poll_ok;

    task chk;
        input [8*32-1:0] nm;
        input            ok;
        begin
            checks = checks + 1;
            if (ok === 1'b1) begin
                $display("CHECK=%0s PASS", nm);
            end else begin
                errors = errors + 1;
                $display("CHECK=%0s FAIL", nm);
            end
        end
    endtask

    // ---- 复位与全局激励 ----
    reg rst_n = 1'b0;

    //==========================================================================
    // DUT_A：EN=1、其余参数全默认（EXP_CAP_LINES=0x1710，CAP_FROM_VTS=0）
    //==========================================================================
    reg         init_done_a = 1'b0;
    reg [12:0]  vts_a = 13'd999;      // 干扰值：参数模式必须无视它
    reg         tb_scl_a = 1'b1;      // 厂家驱动侧模型（pad 前）
    reg         tb_sda_a = 1'b1;
    reg         ack_en_a = 1'b1;
    reg         mon_rst_a = 1'b0;
    wire        own_a, sclp_a, sdao_a, sdoe_a, pdone_a;
    wire [2:0]  done_a, ackc_a;
    wire        sda_a, scl_a;

    sccb_patch #(.EN(1'b1)) u_dut_a (
        .clk(clk), .rst_n(rst_n),
        .init_done(init_done_a), .i_vts(vts_a),
        .i_cap_val(16'h1710), .i_cap_upd(1'b0),   // CAP_FROM_CMD=0 ⇒ 这两个口不影响行为
        .i_dri_scl(tb_scl_a), .i_dri_sda(tb_sda_a), .i_sda(sda_a),
        .o_owner(own_a), .o_scl(sclp_a), .o_sda_out(sdao_a), .o_sda_oe(sdoe_a),
        .o_done_cnt(done_a), .o_ack_cnt(ackc_a), .o_patch_done(pdone_a)
    );

    // 集成侧引脚 mux（照抄 5_曝光上限补写方案.md §5 第 7 条）
    assign scl_a = own_a ? sclp_a : tb_scl_a;
    assign sda_a = own_a ? (sdoe_a ? sdao_a : 1'bz) : tb_sda_a;

    wire [3:0]  ma_txn, ma_start, ma_stop;
    wire [15:0] ma_addr;
    wire [7:0]  ma_data;
    wire ma_e_start, ma_e_len, ma_e_addr, ma_e_stab, ma_e_per, ma_e_hw;

    sccb_bus_mon #(.TAGP("MON_A"), .SLAVE_ADDR(7'h3c)) u_mon_a (
        .clk(clk), .rst_n(mon_rst_a), .mon_en(own_a), .ack_en(ack_en_a),
        .scl(scl_a), .sda(sda_a),
        .txn_cnt(ma_txn), .last_addr(ma_addr), .last_data(ma_data),
        .start_cnt(ma_start), .stop_cnt(ma_stop),
        .err_start(ma_e_start), .err_len(ma_e_len), .err_addr(ma_e_addr),
        .err_stab(ma_e_stab), .err_period(ma_e_per), .err_highw(ma_e_hw)
    );

    //==========================================================================
    // DUT_B：EN=1、CAP_FROM_VTS=1（cap 由 i_vts 推导，三个相位）
    //==========================================================================
    reg         rst_n_b = 1'b0;
    reg         init_done_b = 1'b0;
    reg [12:0]  vts_b = 13'd750;
    reg         tb_scl_b = 1'b1;
    reg         tb_sda_b = 1'b1;
    reg         ack_en_b = 1'b1;
    reg         mon_rst_b = 1'b0;
    wire        own_b, sclp_b, sdao_b, sdoe_b, pdone_b;
    wire [2:0]  done_b, ackc_b;
    wire        sda_b, scl_b;

    sccb_patch #(.EN(1'b1), .CAP_FROM_VTS(1'b1)) u_dut_b (
        .clk(clk), .rst_n(rst_n_b),
        .init_done(init_done_b), .i_vts(vts_b),
        .i_cap_val(16'h1710), .i_cap_upd(1'b0),   // VTS 档：命令口不参与
        .i_dri_scl(tb_scl_b), .i_dri_sda(tb_sda_b), .i_sda(sda_b),
        .o_owner(own_b), .o_scl(sclp_b), .o_sda_out(sdao_b), .o_sda_oe(sdoe_b),
        .o_done_cnt(done_b), .o_ack_cnt(ackc_b), .o_patch_done(pdone_b)
    );

    assign scl_b = own_b ? sclp_b : tb_scl_b;
    assign sda_b = own_b ? (sdoe_b ? sdao_b : 1'bz) : tb_sda_b;

    wire [3:0]  mb_txn, mb_start, mb_stop;
    wire [15:0] mb_addr;
    wire [7:0]  mb_data;
    wire mb_e_start, mb_e_len, mb_e_addr, mb_e_stab, mb_e_per, mb_e_hw;

    sccb_bus_mon #(.TAGP("MON_B"), .SLAVE_ADDR(7'h3c)) u_mon_b (
        .clk(clk), .rst_n(mon_rst_b), .mon_en(own_b), .ack_en(ack_en_b),
        .scl(scl_b), .sda(sda_b),
        .txn_cnt(mb_txn), .last_addr(mb_addr), .last_data(mb_data),
        .start_cnt(mb_start), .stop_cnt(mb_stop),
        .err_start(mb_e_start), .err_len(mb_e_len), .err_addr(mb_e_addr),
        .err_stab(mb_e_stab), .err_period(mb_e_per), .err_highw(mb_e_hw)
    );

    //==========================================================================
    // DUT_C：EN=0（默认）→ 必须完全惰性
    //==========================================================================
    reg        init_done_c = 1'b0;
    wire       own_c, sclp_c, sdao_c, sdoe_c, pdone_c;
    wire [2:0] done_c, ackc_c;
    wire       sda_c;
    pullup(sda_c);

    sccb_patch #(.EN(1'b0)) u_dut_c (
        .clk(clk), .rst_n(rst_n),
        .init_done(init_done_c), .i_vts(13'd0),
        .i_cap_val(16'h1710), .i_cap_upd(1'b0),
        .i_dri_scl(1'b1), .i_dri_sda(1'b1), .i_sda(sda_c),
        .o_owner(own_c), .o_scl(sclp_c), .o_sda_out(sdao_c), .o_sda_oe(sdoe_c),
        .o_done_cnt(done_c), .o_ack_cnt(ackc_c), .o_patch_done(pdone_c)
    );

    //==========================================================================
    // DUT_D：★ 运行时可写档（CAP_FROM_CMD=1）——命令改 cap ⇒ 重跑整条写序列
    //==========================================================================
    reg         init_done_d = 1'b0;
    reg  [15:0] cap_d       = 16'h1710;      // 复位默认 = 基线档（与下行寄存器一致）
    reg         cap_upd_d   = 1'b0;          // toggle：沿 = "cap 已改"
    reg         tb_scl_d = 1'b1;
    reg         tb_sda_d = 1'b1;
    reg         ack_en_d = 1'b1;
    reg         mon_rst_d = 1'b0;
    wire        own_d, sclp_d, sdao_d, sdoe_d, pdone_d;
    wire [2:0]  done_d, ackc_d;
    wire        sda_d, scl_d;

    sccb_patch #(.EN(1'b1), .CAP_FROM_CMD(1'b1)) u_dut_d (
        .clk(clk), .rst_n(rst_n),
        .init_done(init_done_d), .i_vts(13'd0),   // 命令档：VTS 不参与
        .i_cap_val(cap_d), .i_cap_upd(cap_upd_d),
        .i_dri_scl(tb_scl_d), .i_dri_sda(tb_sda_d), .i_sda(sda_d),
        .o_owner(own_d), .o_scl(sclp_d), .o_sda_out(sdao_d), .o_sda_oe(sdoe_d),
        .o_done_cnt(done_d), .o_ack_cnt(ackc_d), .o_patch_done(pdone_d)
    );

    assign scl_d = own_d ? sclp_d : tb_scl_d;
    assign sda_d = own_d ? (sdoe_d ? sdao_d : 1'bz) : tb_sda_d;

    wire [3:0]  md_txn, md_start, md_stop;
    wire [15:0] md_addr;
    wire [7:0]  md_data;
    wire md_e_start, md_e_len, md_e_addr, md_e_stab, md_e_per, md_e_hw;

    sccb_bus_mon #(.TAGP("MON_D"), .SLAVE_ADDR(7'h3c)) u_mon_d (
        .clk(clk), .rst_n(mon_rst_d), .mon_en(own_d), .ack_en(ack_en_d),
        .scl(scl_d), .sda(sda_d),
        .txn_cnt(md_txn), .last_addr(md_addr), .last_data(md_data),
        .start_cnt(md_start), .stop_cnt(md_stop),
        .err_start(md_e_start), .err_len(md_e_len), .err_addr(md_e_addr),
        .err_stab(md_e_stab), .err_period(md_e_per), .err_highw(md_e_hw)
    );

    // 命令侧助手：值 + toggle **同拍**更新（与 downlink_cmd/sys_ctrl 的行为一致）
    task set_cap_d;
        input [15:0] v;
        begin
            cap_d     = v;
            cap_upd_d = ~cap_upd_d;
        end
    endtask

    // DUT_D 不变量：非 owner 期间不得驱动总线
    reg inv_oe_d = 0, inv_scl_d = 0, inv_out_d = 0;
    always @(posedge clk) begin
        if (rst_n) begin
            if (own_d !== 1'b1 && sdoe_d !== 1'b0) inv_oe_d  <= 1'b1;
            if (own_d !== 1'b1 && sclp_d !== 1'b1) inv_scl_d <= 1'b1;
            if (own_d !== 1'b1 && sdao_d !== 1'b1) inv_out_d <= 1'b1;
        end
    end

    // ---- DUT_D 事务捕获队列 + 接管轮次计数 ----
    // ⚠️ 监视器自身的 txn_cnt/start_cnt 是 4 bit，24/28 条会回绕 ⇒ 不能拿来判"第几条"；
    //    这里用 STOP 计数变化逐条入队（dq_addr/dq_data），并以 owner 上升沿数轮次。
    integer d_rounds = 0;
    integer dq_n = 0;
    reg [15:0] dq_addr [0:31];
    reg [7:0]  dq_data [0:31];
    reg [3:0]  md_stop_q = 4'd0;
    always @(posedge clk) begin
        if (rst_n) begin
            md_stop_q <= md_stop;
            if (md_stop !== md_stop_q) begin
                if (dq_n < 32) begin
                    dq_addr[dq_n] = md_addr;
                    dq_data[dq_n] = md_data;
                end
                dq_n = dq_n + 1;
            end
        end
    end
    always @(posedge own_d) d_rounds = d_rounds + 1;

    task wait_dq;                       // 等 dq_n >= n（事务已收尾）
        input integer n;
        input integer to_us;
        integer k;
        begin
            poll_ok = 1'b0; k = 0;
            while (k < to_us && !poll_ok) begin
                poll_ok = (dq_n >= n);
                if (!poll_ok) #1000;
                k = k + 1;
            end
        end
    endtask

    //==========================================================================
    // 连续不变量（整个仿真期间生效）
    //==========================================================================
    reg  a_busy_win = 0;
    time t_rel_a = 0, t_pd_a = 0;
    integer clk_cnt = 0;
    integer cyc_busy_end = 0, cyc_own = 0;
    // 非 owner 期间：SDA 不得使能驱动、SCL 必须恒高、SDA 数据端必须为 1
    reg inv_oe_a = 0, inv_scl_a = 0, inv_out_a = 0;
    reg inv_oe_b = 0, inv_scl_b = 0, inv_out_b = 0;
    reg busy_err_a = 0;                 // init_done 已到但总线仍忙 → 不得接管
    always @(posedge clk) begin
        if (rst_n) begin
            if (own_a !== 1'b1 && sdoe_a !== 1'b0) inv_oe_a  <= 1'b1;
            if (own_a !== 1'b1 && sclp_a !== 1'b1) inv_scl_a <= 1'b1;
            if (own_a !== 1'b1 && sdao_a !== 1'b1) inv_out_a <= 1'b1;
            if (a_busy_win && own_a !== 1'b0)      busy_err_a <= 1'b1;
        end
        if (rst_n_b) begin
            if (own_b !== 1'b1 && sdoe_b !== 1'b0) inv_oe_b  <= 1'b1;
            if (own_b !== 1'b1 && sclp_b !== 1'b1) inv_scl_b <= 1'b1;
            if (own_b !== 1'b1 && sdao_b !== 1'b1) inv_out_b <= 1'b1;
        end
    end

    // EN=0 惰性检查
    reg c_scl_fall = 0, c_oe_active = 0;
    always @(negedge sclp_c) c_scl_fall = 1'b1;
    always @(sdoe_c) if (sdoe_c !== 1'b0) c_oe_active = 1'b1;

    // 时间戳事件（用 clk 周期计数，避免 $time 单位歧义）
    always @(posedge clk)     clk_cnt = clk_cnt + 1;
    always @(posedge own_a)   cyc_own = clk_cnt;
    always @(negedge own_a)   t_rel_a = $time;
    always @(posedge pdone_a) t_pd_a = $time;

    // 捕获数组
    reg [15:0] a_addr  [0:3];
    reg [7:0]  a_data  [0:3];
    reg [15:0] a2_addr [0:3];
    reg [7:0]  a2_data [0:3];
    reg [15:0] b_addr  [0:3];
    reg [7:0]  b_data  [0:3];

    // ---- 轮询助手（1us 步进，防挂死）----
    task poll_a;   // sel: 1=owner 2=patch_done 3=txn>=poll_n 0=owner 回 0
        input integer sel;
        input integer to_us;
        integer k;
        begin
            poll_ok = 1'b0; k = 0;
            while (k < to_us && !poll_ok) begin
                case (sel)
                    1:       poll_ok = (own_a   === 1'b1);
                    2:       poll_ok = (pdone_a === 1'b1);
                    3:       poll_ok = (ma_txn  >= poll_n);
                    default: poll_ok = (own_a   === 1'b0);
                endcase
                if (!poll_ok) #1000;
                k = k + 1;
            end
        end
    endtask

    task poll_b;
        input integer sel;
        input integer to_us;
        integer k;
        begin
            poll_ok = 1'b0; k = 0;
            while (k < to_us && !poll_ok) begin
                case (sel)
                    1:       poll_ok = (own_b   === 1'b1);
                    2:       poll_ok = (pdone_b === 1'b1);
                    3:       poll_ok = (mb_txn  >= poll_n);
                    default: poll_ok = (own_b   === 1'b0);
                endcase
                if (!poll_ok) #1000;
                k = k + 1;
            end
        end
    endtask

    task poll_d;
        input integer sel;
        input integer to_us;
        integer k;
        begin
            poll_ok = 1'b0; k = 0;
            while (k < to_us && !poll_ok) begin
                case (sel)
                    1:       poll_ok = (own_d   === 1'b1);
                    2:       poll_ok = (pdone_d === 1'b1);
                    3:       poll_ok = (md_txn  >= poll_n);
                    4:       poll_ok = (own_d   === 1'b0 && md_txn >= poll_n);
                    default: poll_ok = (own_d   === 1'b0);
                endcase
                if (!poll_ok) #1000;
                k = k + 1;
            end
        end
    endtask

    //==========================================================================
    // 主序列
    //==========================================================================
    initial begin : main
        $display("=== tb_sccb_patch start ===");

        // 复位就位
        rst_n = 1'b0;
        mon_rst_a = 1'b0;
        init_done_a = 1'b0;
        tb_scl_a = 1'b1; tb_sda_a = 1'b1;
        #200;
        rst_n = 1'b1; mon_rst_a = 1'b1;
        #1000;

        //--------------------------------------------------------------------
        // A0：init_done 在厂家侧"忙"期间到达（t=20us），忙到 t=60us
        //--------------------------------------------------------------------
        a_busy_win = 1'b1;
        for (kk = 0; kk < 120; kk = kk + 1) begin
            tb_scl_a = ~tb_scl_a;               // 1MHz 方波：任何双高窗口 < 0.5us << 64 拍
            if (kk[0]) tb_sda_a = ~tb_sda_a;    // 500kHz 数据摆动
            if (kk == 40) init_done_a = 1'b1;   // 忙碌中途武装（t=21.2us）
            #500;
        end
        tb_scl_a = 1'b1; tb_sda_a = 1'b1;
        a_busy_win  = 1'b0;
        cyc_busy_end = clk_cnt;

        chk("A_PREINIT_QUIET", (own_a === 1'b0 && inv_oe_a === 1'b0 &&
                                inv_scl_a === 1'b0 && inv_out_a === 1'b0));
        chk("A_ARMED_BUSY_HOLD", (busy_err_a === 1'b0));

        //--------------------------------------------------------------------
        // A1：总线转双高后接管并补写 4 条（默认参数 = 0x1710）
        //--------------------------------------------------------------------
        poll_a(1, 100);
        chk("A_TAKEOVER_AFTER_BUSY", poll_ok);
        // C2(8 拍) + C3(64 拍) + 同步余量：约 66~72 个 clk
        chk("A_TAKEOVER_LATENCY", ((cyc_own - cyc_busy_end) >= 40 &&
                                   (cyc_own - cyc_busy_end) <= 400));

        for (kk = 0; kk < 4; kk = kk + 1) begin
            poll_n = kk + 1;
            poll_a(3, 3000);
            a_addr[kk] = ma_addr;
            a_data[kk] = ma_data;
        end
        chk("A_TXN1_3A02_HI", (a_addr[0] === 16'h3a02 && a_data[0] === 8'h17));
        chk("A_TXN2_3A03_LO", (a_addr[1] === 16'h3a03 && a_data[1] === 8'h10));
        chk("A_TXN3_3A14_HI", (a_addr[2] === 16'h3a14 && a_data[2] === 8'h17));
        chk("A_TXN4_3A15_LO", (a_addr[3] === 16'h3a15 && a_data[3] === 8'h10));
        chk("A_ADDR_ORDER", (a_addr[0] === 16'h3a02 && a_addr[1] === 16'h3a03 &&
                             a_addr[2] === 16'h3a14 && a_addr[3] === 16'h3a15));
        chk("A_VTS_IGNORED", (a_data[0] === 8'h17));   // 参数模式不受 i_vts=999 影响
        chk("A_START_STOP_CNT4", (ma_start === 4'd4 && ma_stop === 4'd4));
        chk("A_PROTO_CLEAN", (ma_e_start === 1'b0 && ma_e_len === 1'b0 &&
                              ma_e_addr === 1'b0 && ma_e_stab === 1'b0 &&
                              ma_e_per === 1'b0 && ma_e_hw === 1'b0));

        poll_a(2, 1000);
        chk("A_PATCH_DONE", poll_ok);
        // done_cnt/ack_cnt 在 STOP 收尾后 100 clk 才落位，放到 patch_done 之后判
        chk("A_DONE_CNT4", (done_a === 3'd4));
        chk("A_ACK_CNT4", (ackc_a === 3'd4));
        poll_a(0, 1000);
        chk("A_BUS_RELEASED", poll_ok && scl_a === 1'b1 && sda_a === 1'b1);
        chk("A_DONE_AFTER_RELEASE", (t_pd_a >= t_rel_a));

        #200000;
        chk("A_QUIET_200US", (ma_txn === 4'd4 && own_a === 1'b0 && pdone_a === 1'b1));

        //--------------------------------------------------------------------
        // A2：init_done 再来一个上升沿 → 自动重跑一轮
        //--------------------------------------------------------------------
        init_done_a = 1'b0;
        #5000;
        init_done_a = 1'b1;
        poll_a(1, 100);
        chk("A_REARM_TAKEOVER", poll_ok);
        for (kk = 0; kk < 4; kk = kk + 1) begin
            poll_n = 5 + kk;
            poll_a(3, 3000);
            a2_addr[kk] = ma_addr;
            a2_data[kk] = ma_data;
        end
        chk("A_REARM_VALS", (a2_addr[0] === 16'h3a02 && a2_data[0] === 8'h17 &&
                             a2_addr[1] === 16'h3a03 && a2_data[1] === 8'h10 &&
                             a2_addr[2] === 16'h3a14 && a2_data[2] === 8'h17 &&
                             a2_addr[3] === 16'h3a15 && a2_data[3] === 8'h10));
        chk("A_REARM_COUNT8", (ma_txn === 4'd8));
        chk("A_REARM_STARTSTOP8", (ma_start === 4'd8 && ma_stop === 4'd8));
        chk("A_REARM_PROTO_CLEAN", (ma_e_start === 1'b0 && ma_e_len === 1'b0 &&
                                    ma_e_addr === 1'b0 && ma_e_stab === 1'b0 &&
                                    ma_e_per === 1'b0 && ma_e_hw === 1'b0));
        poll_a(2, 1000);
        chk("A_REARM_DONE", poll_ok);
        #200000;
        chk("A_REARM_QUIET", (ma_txn === 4'd8 && own_a === 1'b0));
        chk("A_INVARIANTS", (inv_oe_a === 1'b0 && inv_scl_a === 1'b0 && inv_out_a === 1'b0));

        //--------------------------------------------------------------------
        // B1：CAP_FROM_VTS=1，VTS=750 → cap=746=0x02EA，从机正常应答
        //--------------------------------------------------------------------
        init_done_b = 1'b0;
        rst_n_b = 1'b0; mon_rst_b = 1'b0;
        vts_b = 13'd750; ack_en_b = 1'b1;
        #200;
        rst_n_b = 1'b1; mon_rst_b = 1'b1;
        #1000;
        init_done_b = 1'b1;
        poll_b(1, 100);
        chk("B1_TAKEOVER", poll_ok);
        for (kk = 0; kk < 4; kk = kk + 1) begin
            poll_n = kk + 1;
            poll_b(3, 3000);
            b_addr[kk] = mb_addr;
            b_data[kk] = mb_data;
        end
        chk("B1_VALS_VTS750", (b_addr[0] === 16'h3a02 && b_data[0] === 8'h02 &&
                               b_addr[1] === 16'h3a03 && b_data[1] === 8'hEA &&
                               b_addr[2] === 16'h3a14 && b_data[2] === 8'h02 &&
                               b_addr[3] === 16'h3a15 && b_data[3] === 8'hEA));
        poll_b(2, 1000);
        chk("B1_DONE", poll_ok);
        chk("B1_ACK_CNT4", (ackc_b === 3'd4));
        chk("B1_PROTO_CLEAN", (mb_e_start === 1'b0 && mb_e_len === 1'b0 &&
                               mb_e_addr === 1'b0 && mb_e_stab === 1'b0 &&
                               mb_e_per === 1'b0 && mb_e_hw === 1'b0));

        //--------------------------------------------------------------------
        // B2：VTS=6000 → 上钳 5904=0x1710；从机不应答（SCCB Don't-Care）
        //     ⇒ 事务必须照常完成（完成判据不依赖 ACK）
        //--------------------------------------------------------------------
        init_done_b = 1'b0;
        rst_n_b = 1'b0; mon_rst_b = 1'b0;
        vts_b = 13'd6000; ack_en_b = 1'b0;
        #200;
        rst_n_b = 1'b1; mon_rst_b = 1'b1;
        #1000;
        init_done_b = 1'b1;
        poll_b(1, 100);
        chk("B2_TAKEOVER", poll_ok);
        for (kk = 0; kk < 4; kk = kk + 1) begin
            poll_n = kk + 1;
            poll_b(3, 3000);
            b_addr[kk] = mb_addr;
            b_data[kk] = mb_data;
        end
        chk("B2_VALS_CLAMP_HI", (b_addr[0] === 16'h3a02 && b_data[0] === 8'h17 &&
                                 b_addr[1] === 16'h3a03 && b_data[1] === 8'h10 &&
                                 b_addr[2] === 16'h3a14 && b_data[2] === 8'h17 &&
                                 b_addr[3] === 16'h3a15 && b_data[3] === 8'h10));
        poll_b(2, 1000);
        chk("B2_DONE_DESPITE_NACK", poll_ok && done_b === 3'd4);
        chk("B2_ACK_CNT0", (ackc_b === 3'd0));
        chk("B2_PROTO_CLEAN", (mb_e_start === 1'b0 && mb_e_len === 1'b0 &&
                               mb_e_addr === 1'b0 && mb_e_stab === 1'b0 &&
                               mb_e_per === 1'b0 && mb_e_hw === 1'b0));

        //--------------------------------------------------------------------
        // B3：VTS=2 → 下钳 EXP_CAP_MIN=4=0x0004
        //--------------------------------------------------------------------
        init_done_b = 1'b0;
        rst_n_b = 1'b0; mon_rst_b = 1'b0;
        vts_b = 13'd2; ack_en_b = 1'b1;
        #200;
        rst_n_b = 1'b1; mon_rst_b = 1'b1;
        #1000;
        init_done_b = 1'b1;
        poll_b(1, 100);
        chk("B3_TAKEOVER", poll_ok);
        for (kk = 0; kk < 4; kk = kk + 1) begin
            poll_n = kk + 1;
            poll_b(3, 3000);
            b_addr[kk] = mb_addr;
            b_data[kk] = mb_data;
        end
        chk("B3_VALS_CLAMP_LO", (b_addr[0] === 16'h3a02 && b_data[0] === 8'h00 &&
                                 b_addr[1] === 16'h3a03 && b_data[1] === 8'h04 &&
                                 b_addr[2] === 16'h3a14 && b_data[2] === 8'h00 &&
                                 b_addr[3] === 16'h3a15 && b_data[3] === 8'h04));
        poll_b(2, 1000);
        chk("B3_DONE", poll_ok);
        chk("B3_PROTO_CLEAN", (mb_e_start === 1'b0 && mb_e_len === 1'b0 &&
                               mb_e_addr === 1'b0 && mb_e_stab === 1'b0 &&
                               mb_e_per === 1'b0 && mb_e_hw === 1'b0));
        chk("B_INVARIANTS", (inv_oe_b === 1'b0 && inv_scl_b === 1'b0 && inv_out_b === 1'b0));

        //--------------------------------------------------------------------
        // C：EN=0（默认）→ 完全惰性
        //--------------------------------------------------------------------
        init_done_c = 1'b1;
        #300000;
        chk("C_INERT_OWNER", (own_c === 1'b0));
        chk("C_INERT_DONE", (done_c === 3'd0 && ackc_c === 3'd0 && pdone_c === 1'b0));
        chk("C_INERT_SDA", (sdoe_c === 1'b0 && c_oe_active === 1'b0));
        chk("C_INERT_SCL", (sclp_c === 1'b1 && c_scl_fall === 1'b0));

        //--------------------------------------------------------------------
        // D：★ 运行时可写档（CAP_FROM_CMD=1）
        //--------------------------------------------------------------------
        cap_d = 16'h1710; cap_upd_d = 1'b0;
        mon_rst_d = 1'b0;
        #200;
        mon_rst_d = 1'b1;
        #1000;

        // D1：cam_init_done 上升沿 + 复位默认 cap=0x1710 ⇒ 补写 4 条 0x1710
        init_done_d = 1'b1;
        poll_d(1, 100);
        chk("D1_TAKEOVER_INITDONE", poll_ok);
        wait_dq(4, 3000);
        chk("D1_VALS_DEFAULT_1710", (dq_addr[0] === 16'h3a02 && dq_data[0] === 8'h17 &&
                                     dq_addr[1] === 16'h3a03 && dq_data[1] === 8'h10 &&
                                     dq_addr[2] === 16'h3a14 && dq_data[2] === 8'h17 &&
                                     dq_addr[3] === 16'h3a15 && dq_data[3] === 8'h10));
        poll_d(0, 1000);
        chk("D1_RELEASED", poll_ok);

        // D2：命令改 cap=746（0x02EA，E3/A 档）⇒ 不等 init_done，自动重跑整条序列
        set_cap_d(16'd746);
        poll_d(1, 100);
        chk("D2_REARM_TAKEOVER", poll_ok);
        wait_dq(8, 3000);
        chk("D2_VALS_746", (dq_addr[4] === 16'h3a02 && dq_data[4] === 8'h02 &&
                            dq_addr[5] === 16'h3a03 && dq_data[5] === 8'hEA &&
                            dq_addr[6] === 16'h3a14 && dq_data[6] === 8'h02 &&
                            dq_addr[7] === 16'h3a15 && dq_data[7] === 8'hEA));
        poll_d(0, 1000);
        chk("D2_ROUND2", (d_rounds === 2));

        // D3：命令改 cap=896（0x0380，900 档）⇒ 再重跑一轮
        set_cap_d(16'd896);
        wait_dq(12, 3000);
        chk("D3_VALS_896", (dq_addr[8]  === 16'h3a02 && dq_data[8]  === 8'h03 &&
                            dq_addr[9]  === 16'h3a03 && dq_data[9]  === 8'h80 &&
                            dq_addr[10] === 16'h3a14 && dq_data[10] === 8'h03 &&
                            dq_addr[11] === 16'h3a15 && dq_data[11] === 8'h80));
        poll_d(0, 1000);
        chk("D3_ROUND3", (d_rounds === 3));

        // D4：★在补写**进行中**改 cap ⇒ 在途这轮用旧值写完，挂起的新值随后自动补跑
        //     第 4 轮 cap=516（0x0204），跑到一半改 cap=596（0x0254，B 档）
        set_cap_d(16'd516);
        poll_d(1, 100);                       // 第 4 轮接管（off 已在 S_TAKE 锁存 516）
        chk("D4_ROUND4_TAKEOVER", poll_ok);
        set_cap_d(16'd596);                   // 运行中途改 → 挂起
        wait_dq(16, 3000);
        chk("D4_INFLIGHT_KEPT_516", (dq_addr[12] === 16'h3a02 && dq_data[12] === 8'h02 &&
                                     dq_addr[13] === 16'h3a03 && dq_data[13] === 8'h04 &&
                                     dq_addr[14] === 16'h3a14 && dq_data[14] === 8'h02 &&
                                     dq_addr[15] === 16'h3a15 && dq_data[15] === 8'h04));
        wait_dq(20, 3000);                    // 挂起轮（不打断、也不丢）
        chk("D4_PENDING_VALS_596", (dq_addr[16] === 16'h3a02 && dq_data[16] === 8'h02 &&
                                    dq_addr[17] === 16'h3a03 && dq_data[17] === 8'h54 &&
                                    dq_addr[18] === 16'h3a14 && dq_data[18] === 8'h02 &&
                                    dq_addr[19] === 16'h3a15 && dq_data[19] === 8'h54));
        poll_d(0, 1000);
        chk("D4_ROUNDS5", (d_rounds === 5));

        // D5：纵深防御——越界值被钳位（命令侧已有 BAD_VALUE，这一层防上层误配）
        set_cap_d(16'hFFFF);                  // → 上钳 0x1710
        wait_dq(24, 3000);
        chk("D5_CLAMP_HI_1710", (dq_data[20] === 8'h17 && dq_data[21] === 8'h10 &&
                                 dq_data[22] === 8'h17 && dq_data[23] === 8'h10));
        poll_d(0, 1000);
        set_cap_d(16'd0);                     // → 下钳 0x0004
        wait_dq(28, 3000);
        chk("D5_CLAMP_LO_0004", (dq_data[24] === 8'h00 && dq_data[25] === 8'h04 &&
                                 dq_data[26] === 8'h00 && dq_data[27] === 8'h04));
        poll_d(0, 1000);
        chk("D5_ROUNDS7", (d_rounds === 7));
        chk("D_TXN_TOTAL28", (dq_n === 28));
        chk("D_DONE_CNT4", (done_d === 3'd4));
        chk("D_PROTO_CLEAN", (md_e_start === 1'b0 && md_e_len === 1'b0 &&
                              md_e_addr === 1'b0 && md_e_stab === 1'b0 &&
                              md_e_per === 1'b0 && md_e_hw === 1'b0));
        chk("D_ACK_CNT4", (ackc_d === 3'd4));
        chk("D_INVARIANTS", (inv_oe_d === 1'b0 && inv_scl_d === 1'b0 && inv_out_d === 1'b0));

        //--------------------------------------------------------------------
        // 收口
        //--------------------------------------------------------------------
        $display("=== checks=%0d errors=%0d ===", checks, errors);
        if (errors == 0) begin
            $display("SCCB_PATCH_TB=PASS");
            $display("TEST_RESULT=PASS");
        end else begin
            $display("SCCB_PATCH_TB=FAIL errors=%0d", errors);
            $display("TEST_RESULT=FAIL");
        end
        $finish;
    end

    // 超时保护：仿真卡死也必须给出 FAIL
    initial begin
        #25000000;   // 25 ms 仿真时间（★SCCB 集成新增 DUT_D 7 轮补写后放宽）
        $display("CHECK=WATCHDOG FAIL (sim did not finish in 25 ms)");
        $display("SCCB_PATCH_TB=FAIL timeout");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule

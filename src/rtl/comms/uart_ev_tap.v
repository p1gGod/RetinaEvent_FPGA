//==============================================================================
// uart_ev_tap.v —— 串口事件支路抽点/量化/聚合与 v3 事件帧组装（WIRE-U1 §3，R2）
//
// 设计依据：docs/05_experiments/UART路线设计_20261011/UART回传协议设计.md
//   §3.2 事件帧 = v3 24 B 包头逐字节同构（RAW_LEN=0 / EV_REC_BYTES=5）+ 尾部
//        CRC16（CCITT-FALSE，覆盖 [0 .. 24+EV_LEN-1]）
//   §3.3 事件记录 5 B：{X_LO, {7'b0,X8}, Y, {计数[6:0], POL}, 0}
//   §3.5 三档编码：0=RAW（DECIM 均匀抽点后 5 B 直传）/ 1=GRID 8×6 每帧 /
//        2=GRID 16×12 每 4 帧（块内极性占优 + 计数饱和 127）
//   §6.2 EV_RES 分辨率档：0=400×240 / 1=200×120 / 2=100×60（**坐标量化**；
//        同格合并计数为遗留项，见实现报告 §2.6 D2）
//   §3.4 满包 289 条即发；SER_EV_FLUSH_MS 看门狗短帧（RAW 档）；帧缓冲 2 KB；
//        发送能力不足时丢帧并累计 uartEvDrop（8 bit 饱和，进 TLV 0x8E）
//
// 结构：
//   · 3 × 2 KB 帧缓冲（bank0/1/2，共 6 KB BRAM）：collect / ready(待发) /
//     stream(正在串出) 三态互不冲突；三者都被占用时丢**新**帧并计数
//   · 事件入口：SER_DECIM 均匀抽点（每 N 条取 1）→ 32 深吸收 FIFO → PE
//     （RAW 写 5 B 记录 / GRID 块累加）
//   · 封帧：24 B 头（FLAGS/FRAME_IDX/TS/EV_LEN）→ 回读记录算 CRC16 → 尾 2 B
//   · 封帧期间到达的事件进吸收 FIFO，封帧完成后排空——正常速率下不丢事件
//
// 时钟域：clk_cam（事件流/50 MHz 时基），无 CDC。
//==============================================================================
`timescale 1ns / 1ps

module uart_ev_tap #(
    parameter CLK_HZ      = 50_000_000,
    parameter EV_MAX_PACK = 289,        // v3 EV_MAX（= 1445/5）
    parameter BANK_BYTES  = 2048,       // 每 bank 字节数（2 KB ≥ 24+1445+2）
    parameter CRC_POLY    = 16'h1021
)(
    input  wire        clk,
    input  wire        rst_n,
    // ---- 事件流（clk_cam 域；retina_core 输出 / event_gen 同域）----
    input  wire        i_ev_valid,
    input  wire [8:0]  i_ev_x,          // 0..399
    input  wire [7:0]  i_ev_y,          // 0..239
    input  wire        i_ev_pol,        // 1=ON / 0=OFF
    input  wire [31:0] i_frame_cnt,     // 相机帧计数（= stat_fcnt），变化 = 帧边界
    input  wire [1:0]  i_mode,          // 0=RAW_EV 1=RAW_ONLY 2=EV_ONLY（MODE1 不发事件帧）
    input  wire        i_ev_en,         // 事件支路使能（0 时不采集）
    // ---- 配置（sys_ctrl 输出；设计 §6.3：帧边界生效）----
    input  wire [7:0]  i_ser_decim,     // 1..255（每 N 条取 1）
    input  wire [1:0]  i_ev_res,        // 0/1/2
    input  wire [1:0]  i_ser_agg,       // 0=RAW / 1=GRID8x6 / 2=GRID16x12
    input  wire [15:0] i_ser_flush_ms,  // 5..1000
    // ---- TX 侧（uart_link 三路仲裁：CTRL > 遥测 > 事件帧）----
    output reg         o_frdy,          // 有整帧待发
    output wire        o_fbusy,         // 该待发帧正在串出（= stream_valid）
    output reg         o_fvalid,        // o_fdata 有效（电平；i_fack 消费）
    output reg  [7:0]  o_fdata,
    input  wire        i_fack,
    input  wire        i_fstart,        // 开始串出待发帧（1 拍）
    // ---- 统计 ----
    output reg  [7:0]  o_stat_drop      // uartEvDrop（8 bit 饱和）
);

    //==========================================================================
    // 常量 / 参数化
    //==========================================================================
    localparam US_DIV = (CLK_HZ / 1000000) < 1 ? 1 : (CLK_HZ / 1000000);
    localparam UW = $clog2(US_DIV + 1);

    localparam [1:0] AGG_RAW = 2'd0, AGG_G1 = 2'd1, AGG_G2 = 2'd2;
    localparam [9:0] EV_MAX  = EV_MAX_PACK[9:0];
    localparam GA2_NBLK = 192;              // 16×12

    localparam [1:0] PE_IDLE = 2'd0, PE_SET = 2'd1, PE_WR = 2'd2, PE_AGG = 2'd3;

    localparam [2:0] SL_IDLE = 3'd0, SL_EMIT = 3'd1, SL_HDR = 3'd2,
                     SL_CRC  = 3'd3, SL_TAIL = 3'd4, SL_DONE = 3'd5,
                     SL_SCRUB= 3'd6;

    localparam [1:0] TS_OFF = 2'd0, TS_ADDR = 2'd1, TS_DATA = 2'd2, TS_ACK = 2'd3;

    //==========================================================================
    // 寄存器声明（先声明后使用）
    //==========================================================================
    // ---- 时基 ----
    reg [UW-1:0] us_div;
    reg [47:0]   ts_us;

    // ---- 帧边界 / 配置快照 ----
    reg  [31:0] fcnt_d;
    reg [7:0]  decim_q;
    reg [1:0]  res_q;
    reg [1:0]  agg_q;
    reg [15:0] flush_ms_q;
    reg        sent_in_frame;
    reg [1:0]  sub_cnt;

    // ---- bank 管理 ----
    reg  [1:0]  bank_collect, bank_ready, bank_stream;
    reg         ready_valid, stream_valid;

    reg  [13:0] wr_addr;
    reg  [7:0]  wr_data;
    reg         wr_en;

    reg  [13:0] fb_rd_addr;
    reg  [7:0]  fb_rd_data;

    // ---- 收集状态 ----
    reg [9:0]  rec_cnt;
    reg        grid_nonzero;
    reg [47:0] buf_ts;
    reg [1:0]  mode_lat;
    reg [15:0] frame_lat;
    reg        first_lat, last_lat;
    reg [31:0] flush_cnt;
    reg [7:0]  dec_cnt;

    // ---- 吸收 FIFO ----
    reg [17:0] afifo [0:31];
    reg [4:0]  af_wr, af_rd;
    reg [5:0]  af_cnt;

    // ---- PE ----
    reg [1:0]  pe;
    reg [8:0]  pe_x;
    reg [7:0]  pe_y;
    reg        pe_pol;
    reg [2:0]  pe_wj;
    reg [13:0] pe_woff;

    // ---- SL ----
    reg [2:0]  sl;
    reg        seal_last;
    reg [5:0]  hdr_i;
    reg [15:0] crc_s;
    reg [10:0] ev_bytes;
    reg [10:0] crc_i;
    reg [1:0]  crc_ph;
    reg        tail_ph;
    reg [10:0] flen;
    reg [10:0] ready_len;
    reg [7:0]  ei;
    reg [7:0]  eblk_on, eblk_off;
    reg [2:0]  ebi;
    reg        eblk_hit;

    // ---- TX 串出 ----
    reg [1:0]  tst;
    reg [10:0] str_ptr;
    reg [10:0] str_len;
    reg [13:0] str_base;

    // ---- GRID 块累加器 ----
    (* ram_style = "distributed" *) reg [6:0] blk_on  [0:GA2_NBLK-1];
    (* ram_style = "distributed" *) reg [6:0] blk_off [0:GA2_NBLK-1];

    // ---- 帧缓冲 ----
    (* ram_style = "block" *) reg [7:0] fbuf [0:3*BANK_BYTES-1];

    // 存储体写口（无复位：Vivado 才会推成 BRAM，见 udp_merge 同款注释）
    // 读口 1 拍延迟：本拍给地址，下一拍 fb_rd_data 有效（封帧 CRC 回读 / TX 串出共用）
    always @(posedge clk) begin
        if (wr_en) fbuf[wr_addr] <= wr_data;
        fb_rd_data <= fbuf[fb_rd_addr];
    end

    //==========================================================================
    // 函数
    //==========================================================================
    // v → v/w 的商（w 为调用点常量 ⇒ 综合为常量比较器；返回 0..15）
    function [3:0] divw;
        input [8:0] v;
        input [8:0] w;
        integer k;
        begin
            divw = 4'd0;
            for (k = 1; k < 16; k = k + 1)
                if (v >= (w * k)) divw = k[3:0];
        end
    endfunction

    // CRC-16/CCITT-FALSE（与 udp_merge / downlink_cmd / 上位机同一套）
    function [15:0] crc16_step;
        input [15:0] crc;
        input [7:0]  dat;
        integer i;
        reg [15:0] c;
        begin
            c = crc ^ {dat, 8'h00};
            for (i = 0; i < 8; i = i + 1)
                c = c[15] ? ((c << 1) ^ CRC_POLY) : (c << 1);
            crc16_step = c;
        end
    endfunction

    // 8 bit 饱和加法（丢帧计数合计）
    function [7:0] sat_add;
        input [7:0]  a;
        input [9:0]  n;
        reg   [8:0]  s;
        begin
            s = {1'b0, a} + ((n > 10'd255) ? 9'd255 : {1'b0, n[7:0]});
            sat_add = (s > 9'd255) ? 8'd255 : s[7:0];
        end
    endfunction

    // 24 B 头第 i 字节（依赖封帧起点锁存的 mode_lat/frame_lat/first_lat/last_lat）
    function [7:0] hdr_byte;
        input [5:0] i;
        begin
            case (i)
                6'd0 : hdr_byte = 8'hF0;
                6'd1 : hdr_byte = 8'h5A;
                6'd2 : hdr_byte = 8'hA5;
                6'd3 : hdr_byte = 8'h30;
                6'd4 : hdr_byte = 8'h03;                        // VER=3
                6'd5 : hdr_byte = 8'h18;                        // HDR_LEN=24
                6'd6 : hdr_byte = {1'b0, last_lat, first_lat,  // bit7 / bit6=LAST / bit5=FIRST
                                   1'b0, 1'b1, 1'b1, 1'b1, 1'b0}; // bit4=TS_CAL / bit3=TS_VALID /
                                                                // bit2=CRC / bit1=EV / bit0=0
                6'd7 : hdr_byte = {6'd0, mode_lat};             // MODE 原样透传
                6'd8 : hdr_byte = 8'h00;                        // CHUNK_IDX[15:8]
                6'd9 : hdr_byte = 8'h00;                        // CHUNK_IDX[7:0]
                6'd10: hdr_byte = frame_lat[15:8];              // FRAME_IDX
                6'd11: hdr_byte = frame_lat[7:0];
                6'd12: hdr_byte = 8'h00;                        // RAW_LEN=0
                6'd13: hdr_byte = 8'h00;
                6'd14: hdr_byte = ev_bytes[10:8];               // EV_LEN = N*5
                6'd15: hdr_byte = ev_bytes[7:0];
                6'd16: hdr_byte = buf_ts[47:40];                // TS_US
                6'd17: hdr_byte = buf_ts[39:32];
                6'd18: hdr_byte = buf_ts[31:24];
                6'd19: hdr_byte = buf_ts[23:16];
                6'd20: hdr_byte = buf_ts[15:8];
                6'd21: hdr_byte = buf_ts[7:0];
                6'd22: hdr_byte = 8'h05;                        // EV_REC_BYTES
                default: hdr_byte = 8'h00;                      // RSVD
            endcase
        end
    endfunction

    function [13:0] bank_base;
        input [1:0] b;
        begin
            case (b)
                2'd0: bank_base = 14'd0;
                2'd1: bank_base = 14'd2048;
                default: bank_base = 14'd4096;
            endcase
        end
    endfunction

    //==========================================================================
    // 组合逻辑
    //==========================================================================
    wire frame_edge = (i_frame_cnt != fcnt_d);
    wire gated      = (i_mode == 2'd1) || (!i_ev_en);

    wire agg2_due = (agg_q == AGG_G2) && (sub_cnt == 2'd3);

    wire [1:0] cand1 = (bank_collect == 2'd2) ? 2'd0 : (bank_collect + 2'd1);
    wire [1:0] cand2 = (cand1 == 2'd2) ? 2'd0 : (cand1 + 2'd1);
    wire c1_busy = (ready_valid  && (bank_ready  == cand1)) ||
                   (stream_valid && (bank_stream == cand1));
    wire c2_busy = (ready_valid  && (bank_ready  == cand2)) ||
                   (stream_valid && (bank_stream == cand2));
    wire [1:0] new_collect = (!c1_busy) ? cand1 : cand2;
    wire       have_free   = (!c1_busy) || (!c2_busy);

    wire [31:0] flush_lim = {16'd0, flush_ms_q} * (CLK_HZ / 1000);

    wire ev_take = i_ev_valid && !gated && (dec_cnt == (decim_q - 8'd1));

    wire af_empty = (af_cnt == 6'd0);
    wire af_full  = (af_cnt == 6'd32);

    // 吸收 FIFO 的入/出必须合并成一次计数更新。push 在"事件入口"块、pop 在"PE"块，
    // 两者写在同一个 always 里：同拍发生时后写者胜，会丢掉一次 +1，使 af_cnt 持续偏低
    // ⇒ af_full 永不成立 ⇒ 写指针覆盖未读项（饱和实测每次封帧丢数条，读回的是几十
    // 毫秒前的旧记录，序号倒退；CRC 仍然正确，主机侧看不出）。
    wire ev_push = ev_take && !af_full;
    wire pe_pop  = (pe == PE_IDLE) && !af_empty && (sl == SL_IDLE);

    // 记录坐标（EV_RES 量化：1 → ÷2；2 → ÷4；0 → 原样）
    wire [8:0] q_x = (res_q == 2'd2) ? {2'b0, pe_x[8:2]} :
                     (res_q == 2'd1) ? {1'b0, pe_x[8:1]} : pe_x;
    wire [7:0] q_y = (res_q == 2'd2) ? {2'b0, pe_y[7:2]} :
                     (res_q == 2'd1) ? {1'b0, pe_y[7:1]} : pe_y;

    // GRID 块序号（PE_AGG 拍组合计算；pe_x/pe_y 已稳定）
    //   8×6 ：idx = (y/40)*8  + (x/50)      16×12：idx = (y/20)*16 + (x/25)
    //   ⚠️ 必须用显式移位加权：早前写成 {y_idx,1'b0,x_idx} 的拼接会因截位把
    //      y 的权重变成 32（TB 抓到，见实现报告）
    wire [7:0] ix_g1 = {4'd0, divw(pe_x, 9'd50)};
    wire [7:0] iy_g1 = {4'd0, divw(pe_y, 9'd40)};
    wire [7:0] ix_g2 = {4'd0, divw(pe_x, 9'd25)};
    wire [7:0] iy_g2 = {4'd0, divw(pe_y, 9'd20)};
    wire [7:0] agg_blk = (agg_q == AGG_G2) ? ((iy_g2 << 4) + ix_g2)
                                           : ((iy_g1 << 3) + ix_g1);

    // GRID 发射扫描：块坐标 / 块心 / 块总数
    wire [3:0] ei_bx = (agg_q == AGG_G2) ? ei[3:0] : {1'b0, ei[2:0]};
    wire [3:0] ei_by = (agg_q == AGG_G2) ? ei[7:4] : ei[6:3];
    wire [8:0] ei_cx = (agg_q == AGG_G2) ? (ei_bx * 9'd25 + 9'd12)
                                         : (ei_bx * 9'd50 + 9'd25);
    wire [7:0] ei_cy = (agg_q == AGG_G2) ? (ei_by * 8'd20 + 8'd10)
                                         : (ei_by * 8'd40 + 8'd20);
    wire [7:0] nblk  = (agg_q == AGG_G2) ? 8'd192 : 8'd48;

    wire [7:0] eblk_cnt = (eblk_on >= eblk_off) ? eblk_on : eblk_off;
    wire       eblk_pol = (eblk_on >= eblk_off);

    wire busy = (sl != SL_IDLE);

    // 读口仲裁（2026-10-17 饱和损坏修复）：
    // fbuf 只有一套读口，封帧 CRC 回读（SL_CRC）与 TX 串出共用；tst 的 case 在本
    // always 块中位于 sl 之后 ⇒ 同拍 TX 必赢。若 SL_CRC 在 TX 取口那一拍照旧发地址
    // （发址本身在同一 posedge），TX 刚装好的地址会被顶掉，CRC 回读读到别的 bank
    // ⇒ 尾部 CRC 字段错而线上字节流全对（现场"framing 完好 + 主机 CRC 错"）。
    // 因此 TX 取口那一拍 SL_CRC 让行，下一拍重试。
    wire tx_port_take = ((tst == 2'd3) && i_fack) ||
                        ((tst == 2'd0) && i_fstart && ready_valid);

    wire full_seal  = (sl == SL_IDLE) && (agg_q == AGG_RAW) && (rec_cnt >= EV_MAX);
    wire flush_seal = (sl == SL_IDLE) && (agg_q == AGG_RAW) && (rec_cnt != 10'd0) &&
                      (flush_ms_q != 16'd0) && (flush_cnt >= flush_lim);
    wire grid_seal  = (sl == SL_IDLE) && (agg_q != AGG_RAW) && frame_edge &&
                      grid_nonzero && ((agg_q == AGG_G1) || agg2_due);

    //==========================================================================
    // 主时序
    //==========================================================================
    integer zi;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            us_div       <= {UW{1'b0}};
            ts_us        <= 48'd0;
            fcnt_d       <= 32'd0;
            decim_q      <= 8'd32;      // 出厂默认（设计 §3.7）
            res_q        <= 2'd0;
            agg_q        <= AGG_RAW;
            flush_ms_q   <= 16'd20;
            sent_in_frame<= 1'b0;
            sub_cnt      <= 2'd0;
            bank_collect <= 2'd0;
            bank_ready   <= 2'd0;
            bank_stream  <= 2'd0;
            ready_valid  <= 1'b0;
            stream_valid <= 1'b0;
            wr_addr      <= 14'd24;
            wr_data      <= 8'd0;
            wr_en        <= 1'b0;
            fb_rd_addr   <= 14'd0;
            rec_cnt      <= 10'd0;
            grid_nonzero <= 1'b0;
            buf_ts       <= 48'd0;
            mode_lat     <= 2'd0;
            frame_lat    <= 16'd0;
            first_lat    <= 1'b1;
            last_lat     <= 1'b0;
            flush_cnt    <= 32'd0;
            dec_cnt      <= 8'd0;
            af_wr        <= 5'd0;
            af_rd        <= 5'd0;
            af_cnt       <= 6'd0;
            pe           <= PE_IDLE;
            pe_x         <= 9'd0;
            pe_y         <= 8'd0;
            pe_pol       <= 1'b0;
            pe_wj        <= 3'd0;
            pe_woff      <= 14'd24;
            sl           <= SL_IDLE;
            seal_last    <= 1'b0;
            hdr_i        <= 6'd0;
            crc_s        <= 16'hFFFF;
            ev_bytes     <= 11'd0;
            crc_i        <= 11'd0;
            crc_ph       <= 2'd0;
            tail_ph      <= 1'b0;
            flen         <= 11'd0;
            ready_len    <= 11'd0;
            ei           <= 8'd0;
            eblk_on      <= 8'd0;
            eblk_off     <= 8'd0;
            ebi          <= 3'd0;
            eblk_hit     <= 1'b0;
            tst          <= TS_OFF;
            str_ptr      <= 11'd0;
            str_len      <= 11'd0;
            str_base     <= 14'd0;
            o_frdy       <= 1'b0;
            o_fvalid     <= 1'b0;
            o_fdata      <= 8'd0;
            o_stat_drop  <= 8'd0;
            for (zi = 0; zi < GA2_NBLK; zi = zi + 1) begin
                blk_on[zi]  <= 7'd0;
                blk_off[zi] <= 7'd0;
            end
        end
        else begin
            wr_en <= 1'b0;

            //==================================================================
            // 1 µs 时基
            //==================================================================
            if (us_div == (US_DIV - 1)) begin
                us_div <= {UW{1'b0}};
                ts_us  <= ts_us + 48'd1;
            end
            else us_div <= us_div + 1'b1;

            //==================================================================
            // 帧边界 / 配置快照 / 窗口计数
            //==================================================================
            fcnt_d <= i_frame_cnt;
            if (frame_edge) begin
                decim_q     <= (i_ser_decim == 8'd0) ? 8'd1 : i_ser_decim;
                res_q       <= i_ev_res;
                agg_q       <= i_ser_agg;
                flush_ms_q  <= i_ser_flush_ms;
                sub_cnt     <= agg2_due ? 2'd0 : (sub_cnt + 2'd1);
                sent_in_frame <= 1'b0;
            end

            //==================================================================
            // 抽点计数
            //==================================================================
            if (gated) dec_cnt <= 8'd0;
            else if (i_ev_valid) begin
                if (dec_cnt == (decim_q - 8'd1)) dec_cnt <= 8'd0;
                else                             dec_cnt <= dec_cnt + 8'd1;
            end

            //==================================================================
            // 看门狗
            //==================================================================
            if (busy || gated || (agg_q != AGG_RAW)) flush_cnt <= 32'd0;
            else if (flush_cnt != 32'hFFFFFFFF)      flush_cnt <= flush_cnt + 32'd1;

            //==================================================================
            // 事件入口 → 吸收 FIFO
            //==================================================================
            if (ev_take) begin
                if (ev_push) begin
                    afifo[af_wr] <= {i_ev_pol, i_ev_x, i_ev_y};
                    af_wr        <= af_wr + 5'd1;
                end
                else o_stat_drop <= (o_stat_drop == 8'd255) ? 8'd255
                                                           : (o_stat_drop + 8'd1);
            end

            // 唯一的 af_cnt 驱动点（push/pop 同拍净变化）
            af_cnt <= af_cnt + (ev_push ? 6'd1 : 6'd0) - (pe_pop ? 6'd1 : 6'd0);

            //==================================================================
            // 封帧触发（SL_IDLE）
            //==================================================================
            if (sl == SL_IDLE) begin
                if (gated) begin
                    // MODE1 / 事件关闭：丢弃未封帧与待发帧（按模式不发，不计 drop）
                    if (rec_cnt != 10'd0) rec_cnt <= 10'd0;
                    if (ready_valid)      ready_valid <= 1'b0;
                    if (grid_nonzero) begin
                        ei <= 8'd0;
                        sl <= SL_SCRUB;
                    end
                end
                else if (full_seal) begin
                    seal_last <= 1'b0;              // 满包 ⇒ LAST=0
                    first_lat <= ~sent_in_frame;    // 本相机帧首个串口帧
                    last_lat  <= 1'b0;
                    mode_lat  <= i_mode;
                    frame_lat <= i_frame_cnt[15:0];
                    sent_in_frame <= 1'b1;
                    ev_bytes  <= rec_cnt * 5;
                    hdr_i     <= 6'd0;
                    crc_s     <= 16'hFFFF;
                    flen      <= 11'd0;
                    sl        <= SL_HDR;
                end
                else if (flush_seal) begin
                    seal_last <= 1'b1;              // 看门狗短帧 ⇒ LAST=1
                    first_lat <= ~sent_in_frame;
                    last_lat  <= 1'b1;
                    mode_lat  <= i_mode;
                    frame_lat <= i_frame_cnt[15:0];
                    sent_in_frame <= 1'b1;
                    ev_bytes  <= rec_cnt * 5;
                    hdr_i     <= 6'd0;
                    crc_s     <= 16'hFFFF;
                    flen      <= 11'd0;
                    sl        <= SL_HDR;
                end
                else if (grid_seal) begin
                    // GRID：完整窗口报告 ⇒ FIRST=LAST=1；TS = 发射时刻
                    seal_last <= 1'b1;
                    first_lat <= 1'b1;
                    last_lat  <= 1'b1;
                    mode_lat  <= i_mode;
                    frame_lat <= i_frame_cnt[15:0];
                    sent_in_frame <= 1'b1;
                    buf_ts      <= ts_us;
                    pe_woff     <= bank_base(bank_collect) + 14'd24;
                    ei          <= 8'd0;
                    ebi         <= 3'd0;
                    sl          <= SL_EMIT;
                end
            end

            //==================================================================
            // PE：事件处理（RAW 5 拍写 / GRID 1 拍累加）
            //==================================================================
            case (pe)
                PE_IDLE: begin
                    // 只在"采集"期间取记录（sl == SL_IDLE）：
                    // 封帧期间 PE 若继续写，pe_woff 会越过 BANK_BYTES 写进下一个 bank，
                    // 把还在发送/待发的帧头与载荷覆盖（饱和时实测 2.8M 次越界写），
                    // 且同拍与 SL_HDR/TAIL 争写口（SL 在后必赢，PE 字节静默丢失）。
                    // 只在 sl==SL_IDLE 取记录后：封帧期不再起新记录；满包封帧那一拍
                    // 刚取走的记录落在 rec_cnt>=EV_MAX 之后（payload 之外），不影响载荷。
                    if (pe_pop) begin
                        pe_x   <= afifo[af_rd][16:8];   // {pol,x[8:0],y[7:0]}
                        pe_y   <= afifo[af_rd][7:0];
                        pe_pol <= afifo[af_rd][17];
                        af_rd  <= af_rd + 5'd1;
                        pe     <= PE_SET;
                    end
                end
                PE_SET: begin
                    pe    <= (agg_q == AGG_RAW) ? PE_WR : PE_AGG;
                    pe_wj <= 3'd0;                   // 每条记录从 byte0 起写
                end
                PE_WR: begin
                    wr_en   <= 1'b1;
                    wr_addr <= pe_woff + {11'd0, pe_wj};
                    case (pe_wj)
                        3'd0: wr_data <= q_x[7:0];
                        3'd1: wr_data <= {7'b0, q_x[8]};
                        3'd2: wr_data <= q_y;
                        3'd3: wr_data <= {7'b0, pe_pol};
                        default: wr_data <= 8'h00;
                    endcase
                    if (pe_wj == 3'd4) begin
                        pe_woff <= pe_woff + 14'd5;
                        if (rec_cnt == 10'd0) buf_ts <= ts_us;   // 首条事件时刻
                        rec_cnt <= rec_cnt + 10'd1;
                        flush_cnt <= 32'd0;                  // 看门狗 = 距最后一条记录
                        pe      <= PE_IDLE;
                    end
                    else pe_wj <= pe_wj + 3'd1;
                end
                default: begin   // PE_AGG
                    if (pe_pol) begin
                        if (blk_on[agg_blk] != 7'd127)
                            blk_on[agg_blk] <= blk_on[agg_blk] + 7'd1;
                    end
                    else begin
                        if (blk_off[agg_blk] != 7'd127)
                            blk_off[agg_blk] <= blk_off[agg_blk] + 7'd1;
                    end
                    grid_nonzero <= 1'b1;
                    pe <= PE_IDLE;
                end
            endcase

            //==================================================================
            // 封帧状态机
            //==================================================================
            case (sl)
                SL_IDLE: ;
                //--------------------------------------------------------------
                SL_EMIT: begin
                    if (ebi == 3'd0) begin
                        if (ei >= nblk) begin
                            sl        <= SL_HDR;
                            hdr_i     <= 6'd0;
                            crc_s     <= 16'hFFFF;
                            ev_bytes  <= rec_cnt * 5;
                            flen      <= 11'd0;
                            grid_nonzero <= 1'b0;   // 扫过的块已清零，重新起算
                        end
                        else begin
                            eblk_on  <= {1'b0, blk_on[ei]};
                            eblk_off <= {1'b0, blk_off[ei]};
                            eblk_hit <= ((blk_on[ei] | blk_off[ei]) != 7'd0) &&
                                        (rec_cnt < EV_MAX);
                            ebi      <= 3'd1;
                        end
                    end
                    else begin
                        if (eblk_hit) begin
                            wr_en   <= 1'b1;
                            wr_addr <= pe_woff + {11'd0, (ebi - 3'd1)};
                            case (ebi)
                                3'd1: wr_data <= ei_cx[7:0];
                                3'd2: wr_data <= {7'b0, ei_cx[8]};
                                3'd3: wr_data <= ei_cy;
                                3'd4: wr_data <= {eblk_cnt[6:0], eblk_pol};
                                default: wr_data <= 8'h00;
                            endcase
                        end
                        if (ebi == 3'd5) begin
                            if (eblk_hit) begin
                                pe_woff <= pe_woff + 14'd5;
                                rec_cnt <= rec_cnt + 10'd1;
                                blk_on[ei]  <= 7'd0;    // 发射即清零（下一窗口重累加）
                                blk_off[ei] <= 7'd0;
                            end
                            ei  <= ei + 8'd1;
                            ebi <= 3'd0;
                        end
                        else ebi <= ebi + 3'd1;
                    end
                end
                //--------------------------------------------------------------
                SL_HDR: begin
                    wr_en   <= 1'b1;
                    wr_addr <= bank_base(bank_collect) + {8'd0, hdr_i};
                    wr_data <= hdr_byte(hdr_i);
                    crc_s   <= crc16_step(crc_s, hdr_byte(hdr_i));
                    if (hdr_i == 6'd23) begin
                        hdr_i  <= 6'd0;
                        crc_i  <= 11'd0;
                        crc_ph <= 2'd0;
                        sl     <= SL_CRC;
                    end
                    else hdr_i <= hdr_i + 6'd1;
                end
                //--------------------------------------------------------------
                SL_CRC: begin
                    // 3 拍/字节：发地址 / 等 BRAM 输出 / 归并 CRC
                    case (crc_ph)
                        2'd0: begin
                            if (!tx_port_take) begin
                                fb_rd_addr <= bank_base(bank_collect) + 14'd24 + {3'd0, crc_i};
                                crc_ph     <= 2'd1;
                            end
                        end
                        2'd1: crc_ph <= 2'd2;
                        default: begin
                            crc_s  <= crc16_step(crc_s, fb_rd_data);
                            crc_ph <= 2'd0;
                            if (crc_i + 11'd1 >= ev_bytes) begin
                                tail_ph <= 1'b0;
                                sl      <= SL_TAIL;
                            end
                            else crc_i <= crc_i + 11'd1;
                        end
                    endcase
                end
                //--------------------------------------------------------------
                SL_TAIL: begin
                    wr_en   <= 1'b1;
                    wr_addr <= bank_base(bank_collect) + 14'd24 + {3'd0, ev_bytes} +
                               {13'd0, tail_ph};
                    wr_data <= tail_ph ? crc_s[7:0] : crc_s[15:8];
                    if (tail_ph) begin
                        flen       <= 11'd24 + ev_bytes + 11'd2;
                        ready_len  <= 11'd24 + ev_bytes + 11'd2;
                        sl         <= SL_DONE;
                    end
                    else tail_ph <= 1'b1;
                end
                //--------------------------------------------------------------
                SL_DONE: begin
                    if (!ready_valid && have_free) begin
                        bank_ready   <= bank_collect;
                        ready_valid  <= 1'b1;
                        bank_collect <= new_collect;
                        pe_woff      <= bank_base(new_collect) + 14'd24;
                        rec_cnt      <= 10'd0;
                        buf_ts       <= 48'd0;
                        sl           <= SL_IDLE;
                    end
                    else begin
                        // 无空闲 bank（streaming+ready 同时占用）⇒ 丢本帧并计数
                        o_stat_drop  <= sat_add(o_stat_drop, rec_cnt);
                        pe_woff      <= bank_base(bank_collect) + 14'd24;
                        rec_cnt      <= 10'd0;
                        buf_ts       <= 48'd0;
                        sl           <= SL_IDLE;
                    end
                end
                //--------------------------------------------------------------
                SL_SCRUB: begin
                    blk_on[ei]  <= 7'd0;
                    blk_off[ei] <= 7'd0;
                    if (ei >= 8'd191) begin
                        grid_nonzero <= 1'b0;
                        sl           <= SL_IDLE;
                    end
                    else ei <= ei + 8'd1;
                end
                default: sl <= SL_IDLE;
            endcase

            //==================================================================
            // TX 串出（3 拍/字节：发址 / 等数据 / 呈现）
            //==================================================================
            case (tst)
                TS_OFF: begin
                    o_fvalid <= 1'b0;
                    if (i_fstart && ready_valid) begin
                        str_base     <= bank_base(bank_ready);
                        str_len      <= ready_len;
                        str_ptr      <= 11'd0;
                        fb_rd_addr   <= bank_base(bank_ready) + 14'd0;
                        ready_valid  <= 1'b0;   // o_frdy 统一由末尾 ready_valid 驱动
                        stream_valid <= 1'b1;
                        bank_stream  <= bank_ready;
                        tst          <= TS_ADDR;
                    end
                end
                TS_ADDR: tst <= TS_DATA;            // 等 BRAM 输出寄存器装载
                TS_DATA: begin
                    o_fdata  <= fb_rd_data;
                    o_fvalid <= 1'b1;
                    tst      <= TS_ACK;
                end
                default: begin                      // TS_ACK：等待 i_fack
                    if (i_fack) begin
                        o_fvalid <= 1'b0;
                        if (str_ptr + 11'd1 >= str_len) begin
                            stream_valid <= 1'b0;
                            tst          <= TS_OFF;
                        end
                        else begin
                            fb_rd_addr <= str_base + {3'd0, str_ptr} + 14'd1;
                            str_ptr    <= str_ptr + 11'd1;
                            tst        <= TS_ADDR;
                        end
                    end
                end
            endcase

            o_frdy <= ready_valid;
        end
    end

    assign o_fbusy = stream_valid;

endmodule

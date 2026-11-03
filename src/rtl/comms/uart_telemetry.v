//==============================================================================
// uart_telemetry.v —— 串口遥测（921600 8N1，16× 过采样）
//
// 规格：docs/子模块设计/L2_通信/uart_telemetry.md（§2 端口 / §3 参数 / §4 报文格式 /
//       §5 结构 / §8 验证要点 / §9 陷阱）
// 接口：以 lead 冻结的顶层接口为准（2026-09-27 广播）—— 时钟是 clk_cam（50 MHz），
//       `clk_uart` 由本模块内部用**分数分频**产生（见下）。
// 语言：Verilog-2001，ANSI 端口，单文件单模块（TX/RX/格式化全在本模块内）
//
//------------------------------------------------------------------------------
// 为什么不用"14.7456 MHz 时钟 + 整数分频"
//------------------------------------------------------------------------------
//   50 MHz 无法用 MMCM 精确产生 14.7456 MHz（14.7456/50 = 9216/31250，分母太大；
//   最接近的分数分频输出误差 ~0.006%，对 UART 来说完全够用，但整数分频做不出来）。
//   本模块改用**波特率累加器**：每拍 acc += BAUD×OS，acc ≥ CLK_HZ 时减 CLK_HZ 并出一个
//   "过采样 tick"。平均位速率 = BAUD **精确无误差**（0 ppm），与 CLK_HZ 是否整除无关。
//   50 MHz 下 921600×16 = 14,745,600 ⇒ 平均 3.39 拍一个 tick，16 个 tick 一位。
//
//------------------------------------------------------------------------------
// 报文格式（本设计的协议约定，与文档 §4 一致的部分已标注）
//------------------------------------------------------------------------------
//   A. 遥测帧（默认每 250 ms 一帧；收到 'B'(0x42) 立即补发一帧）
//        AA 55 54 4D | 16 字节载荷 | CRC8          ← 文档 §4 的帧头/长度/CRC8
//        载荷（大端 BE，共 16 B）：
//          [0:3]   frame_cnt        (u32)   帧计数
//          [4:6]   ev_per_frame     (u24)   每帧事件数  ← "事件率" = ev_per_frame × fps
//          [7:8]   activity_q16     (u16)   活跃度 Q16（0..65535 = 0..1）
//          [9:11]  cr_x10           (u24)   压缩比/降低率 ×10 ← "降低率"（如 876 = 87.6%）
//          [12]    {7'b0, mode}             当前模式位
//          [13]    {4'b0, key_pressed}      按键状态
//          [14]    {7'b0, ev_en}            事件支路使能
//          [15]    8'h01                    协议版本（改字段必须 +1）
//        CRC8：poly 0x07 / init 0x00 / MSB-first / 不反射，
//              覆盖范围 = **帧头 4 B + 载荷 16 B = 共 20 B**（不含 CRC 自身）
//
//   B. ASCII 行（紧随遥测帧之后发一行，方便任何串口助手直接看）
//        "T fr=<u32> ev=<u24> act=<u16> cr=<u24> mode=<0|1> key=<0..15> en=<0|1>\r\n"
//        （十进制，无前导零；cr 是 ×10 的值）
//
//------------------------------------------------------------------------------
// 与文档 §2 的差异（已报 lead）
//------------------------------------------------------------------------------
//   · 端口名以 lead 冻结接口为准：clk_cam/rst_n_cam（不是 clk_uart/rst_n_uart），
//     uart_rxd/uart_txd（不带 i_/o_ 前缀），统计量按冻结接口的位宽（24/16/24/32 位）。
//   · 文档 §2 的帧存读口（i_frame_rd_*，'F' 命令回传一帧）**冻结接口里没有**，
//     因此本期不实现 'F' 帧回传路径（需要时再加端口；UDP 通路已能回传原始帧）。
//   · 文档 §4 的遥测载荷字段（最大行宽/行数/pclk…）属早期工程；本期载荷按冻结接口
//     的统计量定义（事件率/降低率/活跃度/帧计数…），版本号 0x01 已写进载荷。
//   · "过采样 16" 保留，但过采样时钟由分数累加器产生（原因见上），不是 14.7456 MHz 整数分频。
//==============================================================================

module uart_telemetry #(
    parameter CLK_HZ          = 50000000,   // clk_cam 频率
    parameter BAUD            = 921600,     // 波特率（固定 921600）
    parameter OS              = 16,         // 过采样倍数
    parameter TELEM_PERIOD_MS = 250,        // 遥测周期（ms）
    parameter CRC8_POLY       = 8'h07,      // CRC8 多项式
    parameter ASCII_TELEM     = 1           // 1 = 遥测帧后附一行 ASCII
)(
    input  wire        clk_cam,
    input  wire        rst_n_cam,
    input  wire        uart_rxd,           // E14（LVCMOS33）；'B' = 立即补发遥测
    output wire        uart_txd,           // D17（LVCMOS33）
    // ---- RGS 状态输入（clk_cam 域，CDC 由 event_sink 负责）----
    input  wire [23:0] i_stat_ev_per_frame,
    input  wire [15:0] i_stat_activity_q16,
    input  wire [23:0] i_stat_cr_x10,
    input  wire [31:0] i_stat_frame_cnt,
    input  wire        i_stat_mode,
    input  wire [3:0]  i_key_pressed,
    input  wire        i_cfg_ev_en
);

    //--------------------------------------------------------------------------
    // 常量
    //--------------------------------------------------------------------------
    localparam [26:0] OS_STEP   = BAUD * OS;              // 14,745,600
    localparam [26:0] CLK_W    = CLK_HZ;
    localparam [7:0]  OS_LAST  = OS - 1;
    localparam [4:0]  OS_HALF  = OS / 2;
    localparam [7:0]  OS_HALF8 = OS / 2;
    localparam [23:0] TELEM_DIV = (TELEM_PERIOD_MS * (CLK_HZ / 1000));   // 12,500,000
    localparam [7:0]  MAGIC0 = 8'hAA, MAGIC1 = 8'h55, MAGIC2 = 8'h54, MAGIC3 = 8'h4D;
    localparam [7:0]  PROTO_VER = 8'h01;

    //--------------------------------------------------------------------------
    // 波特率过采样 tick（分数累加器，平均位速率精确 = BAUD）
    //--------------------------------------------------------------------------
    reg  [26:0] os_acc;
    reg         os_tick;

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            os_acc  <= 27'd0;
            os_tick <= 1'b0;
        end
        else begin
            if (os_acc + OS_STEP >= CLK_W) begin
                os_acc  <= os_acc + OS_STEP - CLK_W;
                os_tick <= 1'b1;
            end
            else begin
                os_acc  <= os_acc + OS_STEP;
                os_tick <= 1'b0;
            end
        end
    end

    //--------------------------------------------------------------------------
    // UART 发送（16× 过采样：每位 OS 个 tick）
    //--------------------------------------------------------------------------
    reg  [7:0] tx_shift;
    reg  [4:0] tx_bit;          // 0 = 起始位，1..8 = 数据 LSB→MSB，9 = 停止位
    reg  [7:0] tx_os;
    reg        tx_busy;
    reg        txd_r;
    reg  [7:0] tx_byte_i;       // 发送方给出的字节（先声明，TX 状态机要用）
    reg        tx_req;          // 发送方请求发一字节（电平，TX 收到后由发送方撤）

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            tx_shift <= 8'd0;
            tx_bit   <= 5'd0;
            tx_os    <= 8'd0;
            tx_busy  <= 1'b0;
            txd_r    <= 1'b1;
        end
        else if (os_tick) begin
            if (!tx_busy) begin
                txd_r <= 1'b1;
                if (tx_req) begin
                    tx_busy  <= 1'b1;
                    tx_bit   <= 5'd0;
                    tx_os    <= 8'd0;
                    tx_shift <= tx_byte_i;
                    txd_r    <= 1'b0;              // 起始位
                end
            end
            else if (tx_os == OS_LAST) begin
                tx_os <= 8'd0;
                if (tx_bit == 5'd9) begin
                    tx_busy <= 1'b0;               // 停止位发完
                    txd_r   <= 1'b1;
                end
                else begin
                    tx_bit <= tx_bit + 5'd1;
                    // 下一位输出：bit1..8 = 数据位，bit9 = 停止位
                    if (tx_bit < 5'd8) txd_r <= tx_shift[tx_bit];   // 起始位之后取 bit0..
                    else               txd_r <= 1'b1;
                end
            end
            else tx_os <= tx_os + 8'd1;
        end
    end
    // 说明：tx_bit 计数 0→9；进入 bit b 时输出该位。tx_bit=0 时输出起始位 0；
    //       tx_bit=1..8 输出 tx_shift[tx_bit-1]；tx_bit=9 输出停止位 1。
    //       上面"txd_r <= tx_shift[tx_bit]"是在**离开** bit b 时装载 b+1 位的电平，
    //       由于 tx_bit 尚未自增，索引正好是 b（= (b+1)-1）✓

    assign uart_txd = txd_r;

    //--------------------------------------------------------------------------
    // UART 接收（16× 过采样，采样比特中点，'B' 命令立即补发遥测）
    //--------------------------------------------------------------------------
    reg  [1:0]  rxd_sync;
    reg         rxd_d;
    reg  [2:0]  rx_state;       // 0 空闲 / 1 起始位 / 2 数据 / 3 停止位
    reg  [7:0]  rx_os;
    reg  [2:0]  rx_bit;
    reg  [7:0]  rx_shift;
    reg         rx_done;
    reg  [7:0]  rx_byte;
    reg         cmd_b;          // 收到 'B' → 立即补发

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            rxd_sync <= 2'b11;
            rxd_d    <= 1'b1;
            rx_state <= 3'd0;
            rx_os    <= 8'd0;
            rx_bit   <= 3'd0;
            rx_shift <= 8'd0;
            rx_done  <= 1'b0;
            rx_byte  <= 8'd0;
            cmd_b    <= 1'b0;
        end
        else begin
            rxd_sync <= {rxd_sync[0], uart_rxd};
            rxd_d    <= rxd_sync[1];
            rx_done  <= 1'b0;
            cmd_b    <= 1'b0;

            if (os_tick) begin
                case (rx_state)
                    3'd0: begin
                        if (rxd_d && !rxd_sync[1]) begin   // 起始位下降沿
                            rx_state <= 3'd1;
                            rx_os    <= 8'd0;
                        end
                    end
                    3'd1: begin
                        if (rx_os == OS_HALF8) begin
                            if (!rxd_sync[1]) begin         // 中点仍为低 ⇒ 真起始位
                                rx_state <= 3'd2;
                                rx_bit   <= 3'd0;
                            end
                            else rx_state <= 3'd0;          // 假起始位
                            rx_os <= 8'd0;
                        end
                        else rx_os <= rx_os + 8'd1;
                    end
                    3'd2: begin
                        // ⚠️ 2026-10-12 修复（UART 路线实现中发现）：数据位采样间隔
                        //    原为 OS_HALF8（0.5 bit）⇒ 每半位采一次、收到的字节与真值
                        //    无关（'B' 命令实际从未生效）。改为 OS_LAST = 1 bit 步进，
                        //    采样点 = 起始位中点 + k×1.0 bit（每位中心）。
                        if (rx_os == OS_LAST) begin
                            rx_shift <= {rxd_sync[1], rx_shift[7:1]};
                            rx_os    <= 8'd0;
                            if (rx_bit == 3'd7) rx_state <= 3'd3;
                            else                rx_bit   <= rx_bit + 3'd1;
                        end
                        else rx_os <= rx_os + 8'd1;
                    end
                    3'd3: begin
                        if (rx_os == OS_LAST) begin
                            rx_os   <= 8'd0;
                            rx_state<= 3'd0;
                            if (rxd_sync[1]) begin          // 停止位正确
                                rx_byte <= rx_shift;
                                rx_done <= 1'b1;
                                if (rx_shift == 8'h42) cmd_b <= 1'b1;   // 'B'
                            end
                        end
                        else rx_os <= rx_os + 8'd1;
                    end
                    default: rx_state <= 3'd0;
                endcase
            end
        end
    end

    //--------------------------------------------------------------------------
    // CRC8：poly 0x07 / init 0x00 / MSB-first
    //--------------------------------------------------------------------------
    function [7:0] crc8_step;
        input [7:0] crc;
        input [7:0] dat;
        integer i;
        reg [7:0] c;
        begin
            c = crc ^ dat;
            for (i = 0; i < 8; i = i + 1)
                c = c[7] ? ((c << 1) ^ CRC8_POLY) : (c << 1);
            crc8_step = c;
        end
    endfunction

    //--------------------------------------------------------------------------
    // 遥测周期 / 触发
    //--------------------------------------------------------------------------
    reg  [23:0] telem_cnt;
    reg         tele_go;

    wire tele_tick = (telem_cnt == TELEM_DIV);

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            telem_cnt <= 24'd0;
            tele_go   <= 1'b0;
        end
        else begin
            tele_go <= 1'b0;
            if (tele_tick) telem_cnt <= 24'd0;
            else           telem_cnt <= telem_cnt + 24'd1;

            if (cmd_b) begin                 // 'B' 立即补发（并复位周期）
                tele_go   <= 1'b1;
                telem_cnt <= 24'd0;
            end
            else if (tele_tick) tele_go <= 1'b1;
        end
    end

    //--------------------------------------------------------------------------
    // 遥测帧字节源（21 B：4 帧头 + 16 载荷 + 1 CRC8）
    //--------------------------------------------------------------------------
    reg  [7:0]  bin_idx;
    reg  [7:0]  bin_crc;
    reg  [31:0] st_fr, st_ev, st_cr;
    reg  [15:0] st_act;
    reg         st_mode, st_en;
    reg  [3:0]  st_key;

    // 载荷第 k 字节
    function [7:0] pay_byte;
        input [3:0] k;
        begin
            case (k)
                4'd0 : pay_byte = st_fr[31:24];
                4'd1 : pay_byte = st_fr[23:16];
                4'd2 : pay_byte = st_fr[15:8];
                4'd3 : pay_byte = st_fr[7:0];
                4'd4 : pay_byte = st_ev[23:16];
                4'd5 : pay_byte = st_ev[15:8];
                4'd6 : pay_byte = st_ev[7:0];
                4'd7 : pay_byte = st_act[15:8];
                4'd8 : pay_byte = st_act[7:0];
                4'd9 : pay_byte = st_cr[23:16];
                4'd10: pay_byte = st_cr[15:8];
                4'd11: pay_byte = st_cr[7:0];
                4'd12: pay_byte = {7'b0, st_mode};
                4'd13: pay_byte = {4'b0, st_key};
                4'd14: pay_byte = {7'b0, st_en};
                default: pay_byte = PROTO_VER;
            endcase
        end
    endfunction

    wire [7:0] bin_byte_w = (bin_idx < 8'd4) ? ((bin_idx == 8'd0) ? MAGIC0 :
                                               (bin_idx == 8'd1) ? MAGIC1 :
                                               (bin_idx == 8'd2) ? MAGIC2 : MAGIC3)
                                             : (bin_idx < 8'd20) ? pay_byte(bin_idx[3:0] - 4'd4)
                                             : bin_crc;

    //--------------------------------------------------------------------------
    // 发送序列：遥测帧(21B) → ASCII 行(line_len B)
    //--------------------------------------------------------------------------
    localparam [1:0] T_IDLE = 2'd0, T_BIN = 2'd1, T_WAIT = 2'd2, T_ASC = 2'd3;

    reg  [1:0]  t_state;        // 先声明：格式化 FSM 要用它判断"发送侧是否空闲"
    reg  [7:0]  t_idx;
    reg  [7:0]  send_len;

    //--------------------------------------------------------------------------
    // ASCII 行格式化（十进制，逐位试减式串行除法；与遥测帧并行进行）
    //--------------------------------------------------------------------------
    reg  [7:0]  line_buf [0:95];
    reg  [6:0]  line_len;
    reg         line_ready;

    reg  [3:0]  f_state;
    reg  [4:0]  f_phase;        // 偶 = 字面量，奇 = 数字
    reg  [4:0]  f_lit_i;
    reg  [31:0] f_val, f_q;
    reg  [4:0]  f_rem;
    reg  [5:0]  f_bit;
    reg  [3:0]  f_dig [0:11];
    reg  [3:0]  f_ndig;
    reg  [3:0]  f_ei;
    reg         f_started;
    reg  [7:0]  f_val_lat;      // 当前数字的"有效位数"（用于跳过前导零）

    localparam [3:0] F_IDLE = 4'd0, F_LIT = 4'd1, F_DIV = 4'd2,
                     F_STORE= 4'd3, F_EMIT= 4'd4, F_NEXT= 4'd5;

    // 字面量长度
    function [4:0] lit_len;
        input [2:0] li;
        begin
            case (li)
                3'd0: lit_len = 5'd5;   // "T fr="
                3'd1: lit_len = 5'd4;   // " ev="
                3'd2: lit_len = 5'd5;   // " act="
                3'd3: lit_len = 5'd4;   // " cr="
                3'd4: lit_len = 5'd6;   // " mode="
                3'd5: lit_len = 5'd5;   // " key="
                3'd6: lit_len = 5'd4;   // " en="
                default: lit_len = 5'd2; // "\r\n"
            endcase
        end
    endfunction

    // 字面量第 i 个字符
    function [7:0] lit_byte;
        input [2:0] li;
        input [4:0] i;
        begin
            lit_byte = 8'h20;
            case (li)
                3'd0: case (i) 5'd0: lit_byte = 8'h54; 5'd1: lit_byte = 8'h20;
                              5'd2: lit_byte = 8'h66; 5'd3: lit_byte = 8'h72;
                              5'd4: lit_byte = 8'h3D; default: ; endcase  // "T fr="
                3'd1: case (i) 5'd0: lit_byte = 8'h20; 5'd1: lit_byte = 8'h65;
                              5'd2: lit_byte = 8'h76; 5'd3: lit_byte = 8'h3D;
                              default: ; endcase                          // " ev="
                3'd2: case (i) 5'd0: lit_byte = 8'h20; 5'd1: lit_byte = 8'h61;
                              5'd2: lit_byte = 8'h63; 5'd3: lit_byte = 8'h74;
                              5'd4: lit_byte = 8'h3D; default: ; endcase  // " act="
                3'd3: case (i) 5'd0: lit_byte = 8'h20; 5'd1: lit_byte = 8'h63;
                              5'd2: lit_byte = 8'h72; 5'd3: lit_byte = 8'h3D;
                              default: ; endcase                          // " cr="
                3'd4: case (i) 5'd0: lit_byte = 8'h20; 5'd1: lit_byte = 8'h6D;
                              5'd2: lit_byte = 8'h6F; 5'd3: lit_byte = 8'h64;
                              5'd4: lit_byte = 8'h65; 5'd5: lit_byte = 8'h3D;
                              default: ; endcase                          // " mode="
                3'd5: case (i) 5'd0: lit_byte = 8'h20; 5'd1: lit_byte = 8'h6B;
                              5'd2: lit_byte = 8'h65; 5'd3: lit_byte = 8'h79;
                              5'd4: lit_byte = 8'h3D; default: ; endcase  // " key="
                3'd6: case (i) 5'd0: lit_byte = 8'h20; 5'd1: lit_byte = 8'h65;
                              5'd2: lit_byte = 8'h6E; 5'd3: lit_byte = 8'h3D;
                              default: ; endcase                          // " en="
                default: case (i) 5'd0: lit_byte = 8'h0D;
                                  default: lit_byte = 8'h0A; endcase      // "\r\n"
            endcase
        end
    endfunction

    // 当前 phase 对应的数字值
    function [31:0] phase_val;
        input [4:0] ph;
        begin
            case (ph)
                5'd1 : phase_val = st_fr;
                5'd3 : phase_val = st_ev;
                5'd5 : phase_val = {16'b0, st_act};
                5'd7 : phase_val = st_cr;
                5'd9 : phase_val = {31'b0, st_mode};
                5'd11: phase_val = {28'b0, st_key};
                default: phase_val = {31'b0, st_en};
            endcase
        end
    endfunction

    reg  [4:0] rem2;
    reg  [31:0] q2;

    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            f_state   <= F_IDLE;
            f_phase   <= 5'd0;
            f_lit_i   <= 5'd0;
            f_val     <= 32'd0;
            f_q       <= 32'd0;
            f_rem     <= 5'd0;
            f_bit     <= 6'd0;
            f_ndig    <= 4'd0;
            f_ei      <= 4'd0;
            f_started <= 1'b0;
            line_len  <= 7'd0;
            line_ready<= 1'b0;
            st_fr     <= 32'd0;  st_ev <= 32'd0;  st_cr <= 32'd0;
            st_act    <= 16'd0;  st_mode <= 1'b0; st_key <= 4'd0; st_en <= 1'b0;
        end
        else begin
            case (f_state)
                //--------------------------------------------------------------
                F_IDLE: begin
                    // ⚠️ line_ready 是**粘滞标志**：只在"新一轮格式化开始"时清。
                    //    否则格式化比遥测帧先结束，1 拍脉冲会被发送侧错过，
                    //    ASCII 行被推迟一整个遥测周期（实测踩过：字节周期测出 1 ms）。
                    if (tele_go && (t_state == T_IDLE)) begin
                        // 锁存统计量，保证一行/一帧内的数值一致
                        st_fr   <= i_stat_frame_cnt;
                        st_ev   <= {8'b0, i_stat_ev_per_frame};
                        st_act  <= i_stat_activity_q16;
                        st_cr   <= {8'b0, i_stat_cr_x10};
                        st_mode <= i_stat_mode;
                        st_key  <= i_key_pressed;
                        st_en   <= i_cfg_ev_en;
                        line_len   <= 7'd0;
                        line_ready <= 1'b0;
                        f_phase  <= 5'd0;
                        f_lit_i  <= 5'd0;
                        f_state  <= F_LIT;
                    end
                end
                //--------------------------------------------------------------
                F_LIT: begin
                    if ((f_phase[0] == 1'b0) && (ASCII_TELEM != 0)) begin
                        line_buf[line_len] <= lit_byte(f_phase[4:1], f_lit_i);
                        line_len <= line_len + 7'd1;
                        if (f_lit_i == (lit_len(f_phase[4:1]) - 5'd1)) begin
                            f_lit_i <= 5'd0;
                            f_phase <= f_phase + 5'd1;
                        end
                        else f_lit_i <= f_lit_i + 5'd1;
                    end
                    else if ((f_phase[0] == 1'b0) && (ASCII_TELEM == 0)) begin
                        // 关掉 ASCII：直接进入下一个数字相位
                        f_lit_i <= 5'd0;
                        f_phase <= f_phase + 5'd1;
                    end
                    else begin
                        // 数字相位：初始化除法
                        f_val     <= phase_val(f_phase);
                        f_q       <= 32'd0;
                        f_rem     <= 5'd0;
                        f_bit     <= 6'd0;
                        f_ndig    <= 4'd0;
                        f_started <= 1'b0;
                        f_state   <= F_DIV;
                    end
                end
                //--------------------------------------------------------------
                F_DIV: begin
                    if (f_bit == 6'd32) begin
                        f_state <= F_STORE;
                    end
                    else begin
                        // rem = (rem<<1) | val[31-bit]；q = q<<1；rem>=10 则减 10 并置商 1
                        rem2 = {f_rem[3:0], f_val[5'd31 - f_bit[4:0]]};
                        q2   = {f_q[30:0], 1'b0};
                        if (rem2 >= 5'd10) begin
                            f_rem <= rem2 - 5'd10;
                            f_q   <= q2 | 32'd1;
                        end
                        else begin
                            f_rem <= rem2;
                            f_q   <= q2;
                        end
                        f_bit <= f_bit + 6'd1;
                    end
                end
                //--------------------------------------------------------------
                F_STORE: begin
                    f_dig[f_ndig] <= f_rem[3:0];
                    f_ndig        <= f_ndig + 4'd1;
                    if (f_q == 32'd0) begin
                        f_ei    <= 4'd0;
                        f_state <= F_EMIT;
                    end
                    else begin
                        f_val  <= f_q;
                        f_q    <= 32'd0;
                        f_rem  <= 5'd0;
                        f_bit  <= 6'd0;
                        f_state<= F_DIV;
                    end
                end
                //--------------------------------------------------------------
                F_EMIT: begin
                    if ((f_ei < f_ndig) && (f_dig[f_ndig - 4'd1 - f_ei] != 4'd0 || f_started ||
                                            (f_ei == (f_ndig - 4'd1)))) begin
                        line_buf[line_len] <= 8'h30 + {4'b0, f_dig[f_ndig - 4'd1 - f_ei]};
                        line_len  <= line_len + 7'd1;
                        f_started <= 1'b1;
                    end
                    f_ei <= f_ei + 4'd1;
                    if (f_ei >= f_ndig) begin
                        f_state <= F_NEXT;
                        f_ei    <= 4'd0;
                    end
                end
                //--------------------------------------------------------------
                F_NEXT: begin
                    f_phase <= f_phase + 5'd1;
                    if (f_phase >= 5'd14) begin
                        line_ready <= 1'b1;      // 最后是 "\r\n"（phase 14）
                        f_state    <= F_IDLE;
                    end
                    else f_state <= F_LIT;
                end
                default: f_state <= F_IDLE;
            endcase
        end
    end

    //--------------------------------------------------------------------------
    // 发送序列状态机：遥测帧(21B) → ASCII 行(send_len B)
    //--------------------------------------------------------------------------
    always @(posedge clk_cam or negedge rst_n_cam) begin
        if (!rst_n_cam) begin
            t_state   <= T_IDLE;
            t_idx     <= 8'd0;
            tx_byte_i <= 8'd0;
            tx_req    <= 1'b0;
            bin_idx   <= 8'd0;
            bin_crc   <= 8'd0;
            send_len  <= 8'd0;
        end
        else begin
            case (t_state)
                //--------------------------------------------------------------
                T_IDLE: begin
                    tx_req <= 1'b0;
                    if (tele_go) begin
                        t_state <= T_BIN;
                        t_idx   <= 8'd0;
                        bin_idx <= 8'd0;
                        bin_crc <= 8'd0;
                    end
                end
                //--------------------------------------------------------------
                T_BIN: begin
                    if (!tx_req) begin
                        if (!tx_busy) begin
                            tx_byte_i <= bin_byte_w;
                            tx_req    <= 1'b1;
                        end
                    end
                    else if (tx_busy) begin
                        tx_req <= 1'b0;
                        // CRC 覆盖帧头 + 载荷（前 20 B）
                        if (bin_idx < 8'd20) bin_crc <= crc8_step(bin_crc, bin_byte_w);
                        if (bin_idx == 8'd20) begin
                            bin_idx <= 8'd0;
                            t_state <= T_WAIT;
                        end
                        else begin
                            bin_idx <= bin_idx + 8'd1;
                            t_idx   <= t_idx + 8'd1;
                        end
                    end
                end
                //--------------------------------------------------------------
                T_WAIT: begin                    // 等 ASCII 行格式化完成
                    tx_req <= 1'b0;
                    if (line_ready) begin
                        send_len <= line_len;    // 锁存长度，防格式化重入改写
                        t_idx    <= 8'd0;
                        t_state  <= (ASCII_TELEM != 0) ? T_ASC : T_IDLE;
                    end
                end
                //--------------------------------------------------------------
                T_ASC: begin
                    if (!tx_req) begin
                        if (!tx_busy) begin
                            tx_byte_i <= line_buf[t_idx[6:0]];
                            tx_req    <= 1'b1;
                        end
                    end
                    else if (tx_busy) begin
                        tx_req <= 1'b0;
                        if (t_idx == (send_len - 8'd1)) t_state <= T_IDLE;
                        else t_idx <= t_idx + 8'd1;
                    end
                end
                default: t_state <= T_IDLE;
            endcase
        end
    end

endmodule

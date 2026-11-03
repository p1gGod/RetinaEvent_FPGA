//==============================================================================
// nn_engine —— 单时钟串行 int8 MAC 推理引擎（★ task-51 / v7：CNN + g1 全局量支路）
//
// 【v7 结构】conv1 -> conv2 -> conv3 -> g1 -> fc，五段共用同一套「5 拍像素头 +
//   每 tap 2 拍」的串行 MAC 流水：
//     conv1/2/3：3x3 空间卷积（stride=2, pad=0），激活来源 nn_feat 冻结 bank / bufA / bufB；
//     g1       ：点积层（无 ky/kx），7 路全局量 int8 -> 16 通道，激活来源 = 7 个特征寄存器，
//                输出写 bufC[240+ch]（frozen conv3 flatten 之后，供 fc 拼接）；
//     fc       ：点积层，256 路输入 = conv3 flatten 240 + g1 16，输出 NUM_CLASSES 个 logit。
//   conv 与 g1 接 ReLU（clip(acc>>SH, 0, 127) 等价于「饱和到 int8 后负值清 0」）；
//   fc 不接 ReLU（clip(acc>>SH, -128, 127)）。
//
// 【审计 D2（EVIDENCE_REVIEW_V7.md）】旧实现 layer 只有 2 bit（L1/L2/L3/FC）且
//   case default 直接当 FC ⇒ 无处安放 g1。本版把 layer 扩成 3 bit，并把原先混在
//   一起的 5 处判断拆开：
//     is_dot   = (layer == G1)||(layer == FC)      —— tap 推进 / tap_last / pix_base
//     is_relu  = (layer != FC)                     —— 结果 ReLU 门控
//     ch_base_of(layer,ch)                         —— 只有 conv 层有通道基址
//     S_FIN 写口                                   —— L1/L2/L3/G1/FC 各写各的存储
//   五处解耦后新增一层只动 nn_cfg.vh 的宏与 L_* 组合表，不动流水拍数。
//
// 【一次推理的时序预算（@50 MHz，v7 实测见 EVIDENCE_M3e.md）】
//   conv1 8*336*(5+72)=206,976 / conv2 16*66*(5+144)=157,344
//   conv3 24*10*(5+288)=70,320 / g1 16*(5+14)=304 / fc 2*(5+512)=1,034
//   ⇒ 合计 435,978 拍 ≈ 8.72 ms（旧 3 类 240 路 fc 为 439,601 拍），预算 ≤442,000。
//
// 【每 tap 2 拍的流水（关键，改这里要连带改 TB 期望）】
//   S_TAP0：组合给出第 n 个 tap 的激活地址（o_feat_addr / 内部 buf 读地址），
//           BRAM 寄存读在拍末采样；
//   S_TAP1：i_feat_data（nn_feat 的外部寄存读口）或内部 act_q 已有效，
//           ROM 的权重（地址在上一拍已发）也有效 ⇒ 当拍做 1 次 MAC；
//           拍末发下一个 tap 的权重地址（o_rom_addr <= +1）。
//   nn_rom 的口是 2 拍延迟（本模块 o_rom_addr 寄存 + nn_rom_data 的 BRAM 寄存读），
//   SH/bias 的读也按 2 拍排队（S_PIX0/1、S_PIX2/3）。
//
// 【激活存储（全部 BRAM，禁止落寄存器）】
//   L1 输入：nn_feat 的冻结 bank（外部口 o_feat_addr / i_feat_data）；
//   L1 输出：bufA[0:NN_L1_COUT*NN_L1_OUTHW-1]（8*336=2688 字）；
//   L2 输出：bufB[0:NN_L2_COUT*NN_L2_OUTHW-1]（16*66=1056 字）；
//   L3 输出：bufC[0:239]（24*10=240 字）；
//   g1 输出：bufC[240:255]（★审计 D3：bufC 从 240 扩到 256 字，
//            这样 fc 的 256 路输入是同一块 RAM 的连续地址，不需要第二份存储/拼接 mux）；
//   fc 输入：bufC[0:NN_FC_CIN-1]，地址 = cin。
//   三个数组的写口都在「无异步复位」的 always 块里、每数组一条写语句（Vivado RAM
//   推断硬规则：异步复位/多写口会导致数组被拆成寄存器）。
//
// 【地址算式（stride=2, pad=0, k=3）】
//   conv: cell_in = (oy*2+ky)*W_in + (ox*2+kx)，其中 pix_base=(oy*2)*W+ox*2、
//         ky_off = ky*W ⇒ 地址 = ch_base + pix_base + ky_off + kx；
//   L1 的 ch_base = bank(i_bank_now - ch/2)*BANK_DEPTH + (ch[0] ? CELLS : 0)
//        （通道映射 ch(2i+pol)=bin(now-i)，K=2 时就是 [ON_now,OFF_now,ON_prev,OFF_prev]）；
//   L2 的 ch_base = cin*NN_L2_HW，L3 的 ch_base = cin*NN_L3_HW；
//   fc 的激活地址 = cin（bufC 按 [och][cell] 连续排，共 256 字）；
//   g1 的激活 = 7 个特征寄存器（不带地址，cin 选一路）。
//   输出写地址 = och*OUTHW + oy*WO + ox；g1 的输出写地址 = 240 + och。
//
// 【g1 输入（审计 D5）】nn_top 例化 nn_winfeat，7 路特征按**独立 8 bit 端口**
//   i_g1_f0..i_g1_f6 进入本模块（顺序 = LSB 语义：0=n_div16, 1=prev_n_div16,
//   2=pol_bal, 3=dx, 4=dy, 5=dx_rel, 6=dy_rel，与 g1_w 的 [ch][i] 展平一致），
//   全部有符号 int8（case 分支里按 signed 累加，符号扩展由 mac_a 的 signed 声明保证）。
//==============================================================================
`timescale 1ns / 1ps
`include "nn_cfg.vh"

module nn_engine (
    input  wire                   clk,          // clk_cam（50 MHz 单时钟）
    input  wire                   rst_n,

    input  wire                   i_start,      // 单拍启动（busy 时忽略）
    input  wire [`NN_BANK_AW-1:0] i_bank_now,   // 最新冻结 bin

    output wire [`NN_FRZ_AW-1:0]  o_feat_addr,  // 组合地址，nn_feat 寄存读（1 拍）
    input  wire [`NN_CNT_W-1:0]   i_feat_data,

    // ---- g1 全局量支路：7 路 int8 特征（nn_winfeat 输出；块内 i_start 时锁存）----
    input  wire signed [7:0]      i_g1_f0,      // n_div16
    input  wire signed [7:0]      i_g1_f1,      // prev_n_div16
    input  wire signed [7:0]      i_g1_f2,      // pol_bal
    input  wire signed [7:0]      i_g1_f3,      // dx
    input  wire signed [7:0]      i_g1_f4,      // dy
    input  wire signed [7:0]      i_g1_f5,      // dx_rel
    input  wire signed [7:0]      i_g1_f6,      // dy_rel

    output reg  [`NN_ROM_AW-1:0]  o_rom_addr,   // 寄存器地址，ROM 再寄一拍（共 2 拍）
    input  wire [31:0]            i_rom_data,

    output reg                    o_busy,
    output reg                    o_res_tog,
    output reg  [`NN_CNT_W-1:0]   o_res_l0,
    output reg  [`NN_CNT_W-1:0]   o_res_l1,
    output reg  [`NN_CNT_W-1:0]   o_res_l2
);

    //--------------------------------------------------------------------------
    // 状态机
    //--------------------------------------------------------------------------
    localparam [3:0] S_IDLE = 4'd0,
                     S_PIX0 = 4'd1,   // 发 SH 地址
                     S_PIX1 = 4'd2,   // 收 SH
                     S_PIX2 = 4'd3,   // 发 bias 地址
                     S_PIX3 = 4'd4,   // 收 bias
                     S_PIX4 = 4'd5,   // 发首个权重地址 + 初始化像素内计数器
                     S_TAP0 = 4'd6,   // 组合发激活地址（BRAM 读）
                     S_TAP1 = 4'd7,   // 1 次 MAC + 发下一权重地址
                     S_FIN  = 4'd8,   // 移位/饱和/ReLU + 写激活缓存
                     S_DONE = 4'd9;   // 本次推理结束

    reg [3:0] state;

    // 循环计数器：(och, oy, ox) 逐像素，像素内 (cin, ky, kx) 逐 tap
    // Verilog 要求先声明后用：这些声明必须在使用 layer 的组合块之前。
    reg [2:0] layer;                 // ★ 3 bit（审计 D2）：1/2/3=conv，4=g1，0=fc
    reg [5:0] och;
    reg [4:0] oy;
    reg [5:0] ox;
    reg [8:0] cin;                   // 0..255（fc 256 路）
    reg [1:0] ky, kx;
    // 激活缓存的寄存读输出：每个数组一份（见下方「激活缓存寄存读」块）

    // 层属性（★ 审计 D2：原来混在一起的判断在这里统一拆开）
    wire is_fc   = (layer == `NN_LAYERFC);
    wire is_g1   = (layer == `NN_LAYERG1);
    wire is_dot  = is_fc | is_g1;    // 点积层：无 ky/kx，tap 沿 cin 推进
    wire is_relu = ~is_fc;           // conv1/2/3 + g1 都接 ReLU

    // 层参数（组合，全部由 nn_cfg.vh 推导）
    reg [9:0]  L_CIN, L_T, L_HO, L_WO, L_W, L_OUTHW;
    reg [5:0]  L_COUT;
    reg [`NN_FRZ_AW-1:0] L_WBASE, L_BBASE, L_SBASE;

    always @(*) begin
        case (layer)
        `NN_LAYER1: begin
            L_CIN = `NN_L1_CIN;  L_T = `NN_L1_T;   L_HO = `NN_L1_HO;
            L_WO  = `NN_L1_WO;   L_W = `NN_L1_W;   L_OUTHW = `NN_L1_OUTHW;
            L_COUT = `NN_L1_COUT;
            L_WBASE = `NN_W1_BASE; L_BBASE = `NN_B1_BASE; L_SBASE = `NN_SH1_BASE;
        end
        `NN_LAYER2: begin
            L_CIN = `NN_L2_CIN;  L_T = `NN_L2_T;   L_HO = `NN_L2_HO;
            L_WO  = `NN_L2_WO;   L_W = `NN_L2_W;   L_OUTHW = `NN_L2_OUTHW;
            L_COUT = `NN_L2_COUT;
            L_WBASE = `NN_W2_BASE; L_BBASE = `NN_B2_BASE; L_SBASE = `NN_SH2_BASE;
        end
        `NN_LAYER3: begin
            L_CIN = `NN_L3_CIN;  L_T = `NN_L3_T;   L_HO = `NN_L3_HO;
            L_WO  = `NN_L3_WO;   L_W = `NN_L3_W;   L_OUTHW = `NN_L3_OUTHW;
            L_COUT = `NN_L3_COUT;
            L_WBASE = `NN_W3_BASE; L_BBASE = `NN_B3_BASE; L_SBASE = `NN_SH3_BASE;
        end
        `NN_LAYERG1: begin   // ★ v7 新增：7 路全局量 -> 16 通道
            L_CIN = `NN_G1_CIN;  L_T = `NN_G1_T;   L_HO = 10'd1;
            L_WO  = 10'd1;       L_W = 10'd1;      L_OUTHW = 10'd1;
            L_COUT = `NN_G1_COUT;
            L_WBASE = `NN_WG_BASE; L_BBASE = `NN_BG_BASE; L_SBASE = `NN_SHG_BASE;
        end
        default: begin       // fc：256 -> NUM_CLASSES
            L_CIN = `NN_FC_CIN;  L_T = `NN_FC_T;   L_HO = 10'd1;
            L_WO  = 10'd1;       L_W = 10'd1;      L_OUTHW = 10'd1;
            L_COUT = `NN_FC_COUT;
            L_WBASE = `NN_WFC_BASE; L_BBASE = `NN_BFC_BASE; L_SBASE = `NN_SHFC_BASE;
        end
        endcase
    end

    //--------------------------------------------------------------------------
    // g1 的 7 路特征寄存器（i_start 时锁存；推理期间保持不变）
    //--------------------------------------------------------------------------
    reg signed [7:0] g1_f0, g1_f1, g1_f2, g1_f3, g1_f4, g1_f5, g1_f6;

    reg signed [7:0] feat_sel;
    always @(*) begin
        case (cin[2:0])
        3'd0: feat_sel = g1_f0;
        3'd1: feat_sel = g1_f1;
        3'd2: feat_sel = g1_f2;
        3'd3: feat_sel = g1_f3;
        3'd4: feat_sel = g1_f4;
        3'd5: feat_sel = g1_f5;
        3'd6: feat_sel = g1_f6;
        default: feat_sel = 8'sd0;
        endcase
    end

    //--------------------------------------------------------------------------
    // 激活缓存（三个数组，全部要被推断成 BRAM）
    //--------------------------------------------------------------------------
    // ★ 审计 D3：bufC 从 240 扩到 256（NN_FC_CIN），g1 的 16 个输出写在 [240..255]，
    //   fc 直接按 cin 顺序读，不再需要「conv3 flatten + g1」两路拼接 mux。
    (* ram_style = "block" *) reg [`NN_CNT_W-1:0] bufA [0:`NN_L1_COUT*`NN_L1_OUTHW-1];
    (* ram_style = "block" *) reg [`NN_CNT_W-1:0] bufB [0:`NN_L2_COUT*`NN_L2_OUTHW-1];
    (* ram_style = "block" *) reg [`NN_CNT_W-1:0] bufC [0:`NN_FC_CIN-1];

    //--------------------------------------------------------------------------
    // 激活地址
    //--------------------------------------------------------------------------
    function [`NN_FRZ_AW-1:0] ch_base_of;
        input [2:0] lay;
        input [8:0] ch;
        reg [`NN_BANK_AW-1:0] age, bank;
        begin
            if (lay == `NN_LAYER1) begin
                age  = ch >> 1;                                  // 时间片序号 i
                bank = (i_bank_now >= age) ? (i_bank_now - age)
                                           : (i_bank_now - age + `NN_BANKS);
                ch_base_of = bank * `NN_BANK_DEPTH
                           + (ch[0] ? `NN_CELLS : {`NN_FRZ_AW{1'b0}});
            end else if (lay == `NN_LAYER2) begin
                ch_base_of = ch * `NN_L2_HW;
            end else if (lay == `NN_LAYER3) begin
                ch_base_of = ch * `NN_L3_HW;
            end else begin
                ch_base_of = {`NN_FRZ_AW{1'b0}};   // g1/fc：点积层无空间通道基址
            end
        end
    endfunction

    reg [`NN_FRZ_AW-1:0] ch_base;    // 当前输入通道的基址（通道切换时更新）
    reg [`NN_FRZ_AW-1:0] pix_base;   // (oy*2)*W + ox*2（每像素更新；点积层恒 0）

    wire [15:0] ky_off = ky * L_W;

    wire [`NN_FRZ_AW-1:0] act_addr = is_fc ? {{(`NN_FRZ_AW-9){1'b0}}, cin}
                                   : is_g1 ? {`NN_FRZ_AW{1'b0}}
                                   : (ch_base + pix_base + ky_off + kx);

    assign o_feat_addr = act_addr;

    // 激活缓存寄存读（地址在 S_TAP0 组合给出，数据在 S_TAP1 有效，延迟 1 拍）
    // ★ 每个数组一个独立读寄存器+独立 always 块：Vivado 要求「BRAM 输出直接接
    //   寄存器」才肯推断 block RAM；早期版本把三块 RAM 的输出先过 case 选一路、
    //   再进同一个寄存器，综合只好退回分布式 RAM（LUTRAM，756 LUT）。
    // ★ 复位用同步复位（避免 RAMB 控制脚的 REQP 类告警）。
    reg [`NN_CNT_W-1:0] act_a_q, act_b_q, act_c_q;
    always @(posedge clk) begin
        if (!rst_n) begin
            act_a_q <= {`NN_CNT_W{1'b0}};
            act_b_q <= {`NN_CNT_W{1'b0}};
            act_c_q <= {`NN_CNT_W{1'b0}};
        end else begin
            act_a_q <= bufA[act_addr[11:0]];
            act_b_q <= bufB[act_addr[10:0]];
            act_c_q <= bufC[act_addr[7:0]];   // 256 字（0..239 conv3，240..255 g1）
        end
    end

    // 选一路送进 MAC：选通放在寄存器之后（与原来的 case 选读同拍数，不增加流水级）
    wire [`NN_CNT_W-1:0] act_q = (layer == `NN_LAYER2)  ? act_a_q :
                                 (layer == `NN_LAYER3)  ? act_b_q :
                                 (layer == `NN_LAYERFC) ? act_c_q :
                                                          {`NN_CNT_W{1'b0}};

    // 激活总线：L1 走 nn_feat 外部口，g1 走 7 路特征寄存器，其余走内部 buf 读
    wire [`NN_CNT_W-1:0] act_bus = (layer == `NN_LAYER1)  ? i_feat_data :
                                   (layer == `NN_LAYERG1) ? feat_sel :
                                                            act_q;

    //--------------------------------------------------------------------------
    // 激活缓存写口（无异步复位、每数组一条写语句 ⇒ 可推断 BRAM）
    //--------------------------------------------------------------------------
    reg        bufa_we, bufb_we, bufc_we;
    reg [11:0] bufa_waddr;
    reg [10:0] bufb_waddr;
    reg [7:0]  bufc_waddr;
    reg [`NN_CNT_W-1:0] buf_wdata;

    always @(posedge clk) begin
        if (bufa_we) bufA[bufa_waddr] <= buf_wdata;
        if (bufb_we) bufB[bufb_waddr] <= buf_wdata;
        if (bufc_we) bufC[bufc_waddr] <= buf_wdata;
    end

    //--------------------------------------------------------------------------
    // 乘加数据通路（强制 DSP）
    //--------------------------------------------------------------------------
    reg signed [31:0] macc;
    reg signed [31:0] bias_q;
    reg [7:0]         sh_val;

    wire signed [7:0] mac_a = act_bus;      // g1 段是有符号 int8（符号扩展在此）
    wire signed [7:0] mac_b = i_rom_data[7:0];
    (* use_dsp = "yes" *) wire signed [15:0] mac_p = mac_a * mac_b;

    // 结果处理：int32 累加 -> 算术右移 SH -> 饱和 [-128,127] -> ReLU（fc 不做）
    wire signed [31:0] sh_in  = macc + bias_q;
    wire signed [31:0] sh_res = sh_in >>> sh_val;
    wire signed [8:0]  sat9   = (sh_res > 32'sd127) ? 9'sd127
                              : (sh_res < -32'sd128) ? -9'sd128
                              : sh_res[8:0];
    wire [`NN_CNT_W-1:0] q_out = (is_relu && sat9[8])
                               ? {`NN_CNT_W{1'b0}} : sat9[`NN_CNT_W-1:0];

    //--------------------------------------------------------------------------
    // 主状态机
    //--------------------------------------------------------------------------
    wire tap_last_conv = (cin == L_CIN - 9'd1) && (ky == 2'd2) && (kx == 2'd2);
    wire tap_last_dot  = (cin == L_CIN - 9'd1);
    wire tap_last      = is_dot ? tap_last_dot : tap_last_conv;

    wire pix_last_x    = (ox == L_WO[5:0] - 6'd1);
    wire pix_last_y    = (oy == L_HO[4:0] - 5'd1);
    wire pix_last_och  = (och == L_COUT - 6'd1);

    // ★ 同步复位：本块的状态/地址寄存器组合驱动 bufA/bufB/bufC 的读写口与权重
    //   ROM 地址脚，异步复位会触发 DRC REQP-1839/1840（实测 v1 在 ROM 上触发 20 条）。
    always @(posedge clk) begin
        if (!rst_n) begin
            state       <= S_IDLE;
            layer       <= `NN_LAYER1;
            och         <= 6'd0;
            oy          <= 5'd0;
            ox          <= 6'd0;
            cin         <= 9'd0;
            ky          <= 2'd0;
            kx          <= 2'd0;
            ch_base     <= {`NN_FRZ_AW{1'b0}};
            pix_base    <= {`NN_FRZ_AW{1'b0}};
            macc        <= 32'sd0;
            bias_q      <= 32'sd0;
            sh_val      <= 8'd0;
            bufa_we     <= 1'b0;
            bufb_we     <= 1'b0;
            bufc_we     <= 1'b0;
            bufa_waddr  <= 12'd0;
            bufb_waddr  <= 11'd0;
            bufc_waddr  <= 8'd0;
            buf_wdata   <= {`NN_CNT_W{1'b0}};
            o_rom_addr  <= {`NN_ROM_AW{1'b0}};
            o_busy      <= 1'b0;
            o_res_tog   <= 1'b0;
            o_res_l0    <= {`NN_CNT_W{1'b0}};
            o_res_l1    <= {`NN_CNT_W{1'b0}};
            o_res_l2    <= {`NN_CNT_W{1'b0}};
            g1_f0       <= 8'sd0;
            g1_f1       <= 8'sd0;
            g1_f2       <= 8'sd0;
            g1_f3       <= 8'sd0;
            g1_f4       <= 8'sd0;
            g1_f5       <= 8'sd0;
            g1_f6       <= 8'sd0;
            // 注意：act_q 的复位在「激活缓存寄存读」块里（单一驱动，见上方注释）
        end else begin
            bufa_we <= 1'b0;
            bufb_we <= 1'b0;
            bufc_we <= 1'b0;

            case (state)
            S_IDLE: begin
                if (i_start) begin
                    o_busy <= 1'b1;
                    layer  <= `NN_LAYER1;
                    och    <= 6'd0;
                    oy     <= 5'd0;
                    ox     <= 6'd0;
                    g1_f0  <= i_g1_f0;
                    g1_f1  <= i_g1_f1;
                    g1_f2  <= i_g1_f2;
                    g1_f3  <= i_g1_f3;
                    g1_f4  <= i_g1_f4;
                    g1_f5  <= i_g1_f5;
                    g1_f6  <= i_g1_f6;
                    state  <= S_PIX0;
                end
            end

            // ---- SH 读（ROM 共 2 拍延迟：本拍发地址，2 拍后数据有效）----
            S_PIX0: begin
                o_rom_addr <= L_SBASE + och;
                state      <= S_PIX1;
            end
            S_PIX1: begin
                state <= S_PIX2;
            end
            // ---- 收 SH，同时发 bias 地址 ----
            S_PIX2: begin
                sh_val     <= i_rom_data[7:0];
                o_rom_addr <= L_BBASE + och;
                state      <= S_PIX3;
            end
            S_PIX3: begin
                state <= S_PIX4;
            end

            // ---- 收 bias + 像素启动：算 pix_base / ch_base，发首个权重地址 ----
            S_PIX4: begin
                bias_q     <= i_rom_data;
                cin        <= 9'd0;
                ky         <= 2'd0;
                kx         <= 2'd0;
                macc       <= 32'sd0;
                ch_base    <= ch_base_of(layer, 9'd0);
                // pix_base = (oy*2)*W + ox*2（卷积窗左上角在同层输入图里的线性偏移）
                // 点积层（g1/fc）没有空间维，恒 0（审计 D2）。
                pix_base   <= is_dot
                            ? {`NN_FRZ_AW{1'b0}}
                            : (({{(`NN_FRZ_AW-9){1'b0}}, oy} * 2 * L_W)
                               + {{(`NN_FRZ_AW-9){1'b0}}, ox} * 2);
                o_rom_addr <= L_WBASE + och * L_T;
                state      <= S_TAP0;
            end

            // ---- 每 tap 2 拍 ----
            S_TAP0: begin
                state <= S_TAP1;
            end
            S_TAP1: begin
                macc <= macc + {{16{mac_p[15]}}, mac_p};
                o_rom_addr <= o_rom_addr + 1'b1;
                if (tap_last) begin
                    state <= S_FIN;
                end else if (is_dot) begin
                    cin   <= cin + 9'd1;          // 点积层：cin 前进（无 ky/kx）
                    state <= S_TAP0;
                end else if (kx != 2'd2) begin
                    kx    <= kx + 2'd1;
                    state <= S_TAP0;
                end else if (ky != 2'd2) begin
                    kx    <= 2'd0;
                    ky    <= ky + 2'd1;
                    state <= S_TAP0;
                end else begin
                    kx      <= 2'd0;
                    ky      <= 2'd0;
                    cin     <= cin + 9'd1;
                    ch_base <= ch_base_of(layer, cin + 9'd1);
                    state   <= S_TAP0;
                end
            end

            // ---- 结果处理 + 写激活缓存 ----
            S_FIN: begin
                case (layer)
                `NN_LAYER1: begin
                    bufa_we    <= 1'b1;
                    bufa_waddr <= och * `NN_L1_OUTHW + oy * `NN_L1_WO + ox;
                end
                `NN_LAYER2: begin
                    bufb_we    <= 1'b1;
                    bufb_waddr <= och * `NN_L2_OUTHW + oy * `NN_L2_WO + ox;
                end
                `NN_LAYER3: begin
                    bufc_we    <= 1'b1;
                    bufc_waddr <= och * `NN_L3_OUTHW + oy * `NN_L3_WO + ox;
                end
                `NN_LAYERG1: begin
                    // ★ 审计 D3：g1 的 16 个输出写到 bufC[240..255]
                    bufc_we    <= 1'b1;
                    bufc_waddr <= `NN_FC_CONV_IN + {2'b00, och};
                end
                default: begin
                    if (och == 6'd0) o_res_l0 <= q_out;
                    else if (och == 6'd1) o_res_l1 <= q_out;
                    else if (och == 6'd2) o_res_l2 <= q_out;  // NUM_CLASSES=2 时不会走到这里
                end
                endcase
                buf_wdata <= q_out;

                // 像素推进
                if (!pix_last_x) begin
                    ox    <= ox + 6'd1;
                    state <= S_PIX0;
                end else if (!pix_last_y) begin
                    ox    <= 6'd0;
                    oy    <= oy + 5'd1;
                    state <= S_PIX0;
                end else if (!pix_last_och) begin
                    ox    <= 6'd0;
                    oy    <= 5'd0;
                    och   <= och + 6'd1;
                    state <= S_PIX0;
                end else begin
                    // 本层结束 -> 下一层（conv1->conv2->conv3->g1->fc->DONE）
                    ox  <= 6'd0;
                    oy  <= 5'd0;
                    och <= 6'd0;
                    case (layer)
                    `NN_LAYER1: begin layer <= `NN_LAYER2;  state <= S_PIX0; end
                    `NN_LAYER2: begin layer <= `NN_LAYER3;  state <= S_PIX0; end
                    `NN_LAYER3: begin layer <= `NN_LAYERG1; state <= S_PIX0; end
                    `NN_LAYERG1: begin layer <= `NN_LAYERFC; state <= S_PIX0; end
                    default:    begin state <= S_DONE; end
                    endcase
                end
            end

            S_DONE: begin
                o_busy    <= 1'b0;
                o_res_tog <= ~o_res_tog;
                state     <= S_IDLE;
            end

            default: state <= S_IDLE;
            endcase
        end
    end

endmodule

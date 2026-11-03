//==============================================================================
// luma_log -- Y → L = 对数亮度（256×8 查找表，L2 事件引擎）
//
// 规格：retina_event/docs/子模块设计/L2_事件引擎/luma_log.md §2/§3/§4/§6
//
//   映射公式（本设计的取值，§3）：
//       L = round( 255 · log2(1 + Y/255) )      Y ∈ [0,255] ⇒ L ∈ [0,255]
//       Y=0 → L=0；Y=255 → L=255（无缝饱和，8 bit 刚好放下）
//   阈值换算：1 LSB(L) = ln2/255 自然对数；θ=0.20 → 74 LSB
//
// ⚠️ §9.1：尺度必须用 **255**（不是 256）。用 256·log2(1+Y/255) 时 Y=255 会得到 256，
//    溢出 8 bit。原理文档 §4 里写的 "round(256·log2(Y/255+1))" 是旧口径，
//    本模块按 luma_log.md §3 的 **255** 口径实现（已列入交付报告的偏离说明）。
//
// ⚠️ §9.3：ROM 内容由脚本生成（Python/PowerShell 复算），不要手写 case。
//
// 参数分支：
//   ROM_LATENCY = 0 → 组合读 ROM，控制信号直通（零延迟）
//   ROM_LATENCY = 1 → 同步读 ROM（默认），控制信号同拍打 1 拍
//   USE_ROM_IP  = 0 → 【默认】分布式 ROM（reg 数组 + initial 初值，综合推断 LUTROM）
//   USE_ROM_IP  = 1 → 例化外部块 ROM IP `luma_log_rom_256x8`（需先用 IP Catalog 生成；
//                     256×8 用 BRAM 性价比很低，故默认关闭）
//==============================================================================
`timescale 1ns / 1ps

module luma_log #(
    parameter ROM_LATENCY = 1,      // ROM 读延迟：0 = 组合读，1 = 同步读
    parameter USE_ROM_IP  = 0       // 0 = 分布式 ROM（默认，自包含）；1 = 外部 ROM IP
)(
    input  wire       clk_cam,
    input  wire       rst_n_cam,
    input  wire       i_vsync,
    input  wire       i_de,
    input  wire [7:0] i_y,          // 亮度 Y
    output wire       o_vsync,
    output wire       o_de,
    output wire [7:0] o_l           // 对数亮度 L
);

    //--------------------------------------------------------------------------
    // B1：ROM 256×8（内容由脚本生成：L = round(255·log2(1+Y/255))，饱和到 255）
    //--------------------------------------------------------------------------
    wire [7:0] rom_data;

    generate
        if (USE_ROM_IP != 0) begin : g_ip
            // 外部块 ROM（blk_mem_gen / XPM 封装）；未生成该 IP 时本分支不会被 elaborate
            luma_log_rom_256x8 u_rom (
                .clk    (clk_cam),
                .i_addr (i_y),
                .o_data (rom_data)
            );
        end else begin : g_dist
            (* rom_style = "distributed" *) reg [7:0] rom [0:255];
            initial begin
                rom[  0] = 8'h00; rom[  1] = 8'h01; rom[  2] = 8'h03; rom[  3] = 8'h04;
                rom[  4] = 8'h06; rom[  5] = 8'h07; rom[  6] = 8'h09; rom[  7] = 8'h0A;
                rom[  8] = 8'h0B; rom[  9] = 8'h0D; rom[ 10] = 8'h0E; rom[ 11] = 8'h10;
                rom[ 12] = 8'h11; rom[ 13] = 8'h12; rom[ 14] = 8'h14; rom[ 15] = 8'h15;
                rom[ 16] = 8'h16; rom[ 17] = 8'h18; rom[ 18] = 8'h19; rom[ 19] = 8'h1A;
                rom[ 20] = 8'h1C; rom[ 21] = 8'h1D; rom[ 22] = 8'h1E; rom[ 23] = 8'h20;
                rom[ 24] = 8'h21; rom[ 25] = 8'h22; rom[ 26] = 8'h24; rom[ 27] = 8'h25;
                rom[ 28] = 8'h26; rom[ 29] = 8'h28; rom[ 30] = 8'h29; rom[ 31] = 8'h2A;
                rom[ 32] = 8'h2B; rom[ 33] = 8'h2D; rom[ 34] = 8'h2E; rom[ 35] = 8'h2F;
                rom[ 36] = 8'h31; rom[ 37] = 8'h32; rom[ 38] = 8'h33; rom[ 39] = 8'h34;
                rom[ 40] = 8'h36; rom[ 41] = 8'h37; rom[ 42] = 8'h38; rom[ 43] = 8'h39;
                rom[ 44] = 8'h3B; rom[ 45] = 8'h3C; rom[ 46] = 8'h3D; rom[ 47] = 8'h3E;
                rom[ 48] = 8'h3F; rom[ 49] = 8'h41; rom[ 50] = 8'h42; rom[ 51] = 8'h43;
                rom[ 52] = 8'h44; rom[ 53] = 8'h45; rom[ 54] = 8'h47; rom[ 55] = 8'h48;
                rom[ 56] = 8'h49; rom[ 57] = 8'h4A; rom[ 58] = 8'h4B; rom[ 59] = 8'h4D;
                rom[ 60] = 8'h4E; rom[ 61] = 8'h4F; rom[ 62] = 8'h50; rom[ 63] = 8'h51;
                rom[ 64] = 8'h52; rom[ 65] = 8'h54; rom[ 66] = 8'h55; rom[ 67] = 8'h56;
                rom[ 68] = 8'h57; rom[ 69] = 8'h58; rom[ 70] = 8'h59; rom[ 71] = 8'h5A;
                rom[ 72] = 8'h5B; rom[ 73] = 8'h5D; rom[ 74] = 8'h5E; rom[ 75] = 8'h5F;
                rom[ 76] = 8'h60; rom[ 77] = 8'h61; rom[ 78] = 8'h62; rom[ 79] = 8'h63;
                rom[ 80] = 8'h64; rom[ 81] = 8'h65; rom[ 82] = 8'h67; rom[ 83] = 8'h68;
                rom[ 84] = 8'h69; rom[ 85] = 8'h6A; rom[ 86] = 8'h6B; rom[ 87] = 8'h6C;
                rom[ 88] = 8'h6D; rom[ 89] = 8'h6E; rom[ 90] = 8'h6F; rom[ 91] = 8'h70;
                rom[ 92] = 8'h71; rom[ 93] = 8'h72; rom[ 94] = 8'h73; rom[ 95] = 8'h74;
                rom[ 96] = 8'h76; rom[ 97] = 8'h77; rom[ 98] = 8'h78; rom[ 99] = 8'h79;
                rom[100] = 8'h7A; rom[101] = 8'h7B; rom[102] = 8'h7C; rom[103] = 8'h7D;
                rom[104] = 8'h7E; rom[105] = 8'h7F; rom[106] = 8'h80; rom[107] = 8'h81;
                rom[108] = 8'h82; rom[109] = 8'h83; rom[110] = 8'h84; rom[111] = 8'h85;
                rom[112] = 8'h86; rom[113] = 8'h87; rom[114] = 8'h88; rom[115] = 8'h89;
                rom[116] = 8'h8A; rom[117] = 8'h8B; rom[118] = 8'h8C; rom[119] = 8'h8D;
                rom[120] = 8'h8E; rom[121] = 8'h8F; rom[122] = 8'h90; rom[123] = 8'h91;
                rom[124] = 8'h92; rom[125] = 8'h93; rom[126] = 8'h94; rom[127] = 8'h95;
                rom[128] = 8'h96; rom[129] = 8'h97; rom[130] = 8'h98; rom[131] = 8'h99;
                rom[132] = 8'h99; rom[133] = 8'h9A; rom[134] = 8'h9B; rom[135] = 8'h9C;
                rom[136] = 8'h9D; rom[137] = 8'h9E; rom[138] = 8'h9F; rom[139] = 8'hA0;
                rom[140] = 8'hA1; rom[141] = 8'hA2; rom[142] = 8'hA3; rom[143] = 8'hA4;
                rom[144] = 8'hA5; rom[145] = 8'hA6; rom[146] = 8'hA7; rom[147] = 8'hA7;
                rom[148] = 8'hA8; rom[149] = 8'hA9; rom[150] = 8'hAA; rom[151] = 8'hAB;
                rom[152] = 8'hAC; rom[153] = 8'hAD; rom[154] = 8'hAE; rom[155] = 8'hAF;
                rom[156] = 8'hB0; rom[157] = 8'hB0; rom[158] = 8'hB1; rom[159] = 8'hB2;
                rom[160] = 8'hB3; rom[161] = 8'hB4; rom[162] = 8'hB5; rom[163] = 8'hB6;
                rom[164] = 8'hB7; rom[165] = 8'hB8; rom[166] = 8'hB8; rom[167] = 8'hB9;
                rom[168] = 8'hBA; rom[169] = 8'hBB; rom[170] = 8'hBC; rom[171] = 8'hBD;
                rom[172] = 8'hBE; rom[173] = 8'hBF; rom[174] = 8'hBF; rom[175] = 8'hC0;
                rom[176] = 8'hC1; rom[177] = 8'hC2; rom[178] = 8'hC3; rom[179] = 8'hC4;
                rom[180] = 8'hC4; rom[181] = 8'hC5; rom[182] = 8'hC6; rom[183] = 8'hC7;
                rom[184] = 8'hC8; rom[185] = 8'hC9; rom[186] = 8'hCA; rom[187] = 8'hCA;
                rom[188] = 8'hCB; rom[189] = 8'hCC; rom[190] = 8'hCD; rom[191] = 8'hCE;
                rom[192] = 8'hCE; rom[193] = 8'hCF; rom[194] = 8'hD0; rom[195] = 8'hD1;
                rom[196] = 8'hD2; rom[197] = 8'hD3; rom[198] = 8'hD3; rom[199] = 8'hD4;
                rom[200] = 8'hD5; rom[201] = 8'hD6; rom[202] = 8'hD7; rom[203] = 8'hD7;
                rom[204] = 8'hD8; rom[205] = 8'hD9; rom[206] = 8'hDA; rom[207] = 8'hDB;
                rom[208] = 8'hDB; rom[209] = 8'hDC; rom[210] = 8'hDD; rom[211] = 8'hDE;
                rom[212] = 8'hDF; rom[213] = 8'hDF; rom[214] = 8'hE0; rom[215] = 8'hE1;
                rom[216] = 8'hE2; rom[217] = 8'hE3; rom[218] = 8'hE3; rom[219] = 8'hE4;
                rom[220] = 8'hE5; rom[221] = 8'hE6; rom[222] = 8'hE6; rom[223] = 8'hE7;
                rom[224] = 8'hE8; rom[225] = 8'hE9; rom[226] = 8'hE9; rom[227] = 8'hEA;
                rom[228] = 8'hEB; rom[229] = 8'hEC; rom[230] = 8'hED; rom[231] = 8'hED;
                rom[232] = 8'hEE; rom[233] = 8'hEF; rom[234] = 8'hF0; rom[235] = 8'hF0;
                rom[236] = 8'hF1; rom[237] = 8'hF2; rom[238] = 8'hF3; rom[239] = 8'hF3;
                rom[240] = 8'hF4; rom[241] = 8'hF5; rom[242] = 8'hF6; rom[243] = 8'hF6;
                rom[244] = 8'hF7; rom[245] = 8'hF8; rom[246] = 8'hF8; rom[247] = 8'hF9;
                rom[248] = 8'hFA; rom[249] = 8'hFB; rom[250] = 8'hFB; rom[251] = 8'hFC;
                rom[252] = 8'hFD; rom[253] = 8'hFE; rom[254] = 8'hFE; rom[255] = 8'hFF;
            end
            assign rom_data = rom[i_y];
        end
    endgenerate

    //--------------------------------------------------------------------------
    // B2/B3：读端口 + 控制对齐（ROM_LATENCY 拍）
    //--------------------------------------------------------------------------
    reg [7:0] l_q;
    reg       vs_q;
    reg       de_q;

    generate
        if (ROM_LATENCY == 0) begin : g_comb
            always @(*) begin
                l_q  = rom_data;
                vs_q = i_vsync;
                de_q = i_de;
            end
        end else begin : g_sync
            always @(posedge clk_cam) begin
                if (!rst_n_cam) begin
                    l_q  <= 8'h00;
                    vs_q <= 1'b0;
                    de_q <= 1'b0;
                end else begin
                    l_q  <= rom_data;
                    vs_q <= i_vsync;
                    de_q <= i_de;
                end
            end
        end
    endgenerate

    assign o_l     = l_q;
    assign o_vsync = vs_q;
    assign o_de    = de_q;

endmodule

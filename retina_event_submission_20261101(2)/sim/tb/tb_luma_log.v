//==============================================================================
// tb_luma_log -- luma_log 单模块仿真（L2 事件引擎）
// 判据（文档 §8）：
//   V1  256 个输入值与参考模型逐点一致（参考表 = round(255·log2(1+Y/255))，脚本生成）
//   V2  单调不减（对数单调）
//   V3  Y=255 → L=255（无溢出/无回绕）
//   V4  控制与数据同拍
//   （补）ROM_LATENCY=0 分支（组合读）与 ROM_LATENCY=1 分支都正确
//==============================================================================
`timescale 1ns / 1ps

module tb_luma_log;

    reg clk = 1'b0;
    always #5 clk = ~clk;

    integer errors = 0;
    task chk_pass; input [8*48-1:0] nm; begin $display("CHECK=%0s PASS", nm); end endtask
    task chk_fail; input [8*48-1:0] nm; begin
        $display("CHECK=%0s FAIL", nm); errors = errors + 1;
    end endtask

    reg        rst_n = 1'b0;
    reg        i_vsync = 1'b0;
    reg        i_de    = 1'b0;
    reg  [7:0] i_y     = 8'h00;

    wire       o_vsync, o_de;
    wire [7:0] o_l;

    wire       o_vsync_c, o_de_c;
    wire [7:0] o_l_c;

    luma_log #(.ROM_LATENCY(1), .USE_ROM_IP(0)) u_sync (
        .clk_cam(clk), .rst_n_cam(rst_n),
        .i_vsync(i_vsync), .i_de(i_de), .i_y(i_y),
        .o_vsync(o_vsync), .o_de(o_de), .o_l(o_l)
    );

    luma_log #(.ROM_LATENCY(0), .USE_ROM_IP(0)) u_comb (
        .clk_cam(clk), .rst_n_cam(rst_n),
        .i_vsync(i_vsync), .i_de(i_de), .i_y(i_y),
        .o_vsync(o_vsync_c), .o_de(o_de_c), .o_l(o_l_c)
    );

    // 参考表：L = round(255·log2(1+Y/255))，Y=255 时饱和到 255（脚本生成）
    reg [7:0] ref_l [0:255];
    initial begin
        ref_l[  0]=8'h00; ref_l[  1]=8'h01; ref_l[  2]=8'h03; ref_l[  3]=8'h04;
        ref_l[  4]=8'h06; ref_l[  5]=8'h07; ref_l[  6]=8'h09; ref_l[  7]=8'h0A;
        ref_l[  8]=8'h0B; ref_l[  9]=8'h0D; ref_l[ 10]=8'h0E; ref_l[ 11]=8'h10;
        ref_l[ 12]=8'h11; ref_l[ 13]=8'h12; ref_l[ 14]=8'h14; ref_l[ 15]=8'h15;
        ref_l[ 16]=8'h16; ref_l[ 17]=8'h18; ref_l[ 18]=8'h19; ref_l[ 19]=8'h1A;
        ref_l[ 20]=8'h1C; ref_l[ 21]=8'h1D; ref_l[ 22]=8'h1E; ref_l[ 23]=8'h20;
        ref_l[ 24]=8'h21; ref_l[ 25]=8'h22; ref_l[ 26]=8'h24; ref_l[ 27]=8'h25;
        ref_l[ 28]=8'h26; ref_l[ 29]=8'h28; ref_l[ 30]=8'h29; ref_l[ 31]=8'h2A;
        ref_l[ 32]=8'h2B; ref_l[ 33]=8'h2D; ref_l[ 34]=8'h2E; ref_l[ 35]=8'h2F;
        ref_l[ 36]=8'h31; ref_l[ 37]=8'h32; ref_l[ 38]=8'h33; ref_l[ 39]=8'h34;
        ref_l[ 40]=8'h36; ref_l[ 41]=8'h37; ref_l[ 42]=8'h38; ref_l[ 43]=8'h39;
        ref_l[ 44]=8'h3B; ref_l[ 45]=8'h3C; ref_l[ 46]=8'h3D; ref_l[ 47]=8'h3E;
        ref_l[ 48]=8'h3F; ref_l[ 49]=8'h41; ref_l[ 50]=8'h42; ref_l[ 51]=8'h43;
        ref_l[ 52]=8'h44; ref_l[ 53]=8'h45; ref_l[ 54]=8'h47; ref_l[ 55]=8'h48;
        ref_l[ 56]=8'h49; ref_l[ 57]=8'h4A; ref_l[ 58]=8'h4B; ref_l[ 59]=8'h4D;
        ref_l[ 60]=8'h4E; ref_l[ 61]=8'h4F; ref_l[ 62]=8'h50; ref_l[ 63]=8'h51;
        ref_l[ 64]=8'h52; ref_l[ 65]=8'h54; ref_l[ 66]=8'h55; ref_l[ 67]=8'h56;
        ref_l[ 68]=8'h57; ref_l[ 69]=8'h58; ref_l[ 70]=8'h59; ref_l[ 71]=8'h5A;
        ref_l[ 72]=8'h5B; ref_l[ 73]=8'h5D; ref_l[ 74]=8'h5E; ref_l[ 75]=8'h5F;
        ref_l[ 76]=8'h60; ref_l[ 77]=8'h61; ref_l[ 78]=8'h62; ref_l[ 79]=8'h63;
        ref_l[ 80]=8'h64; ref_l[ 81]=8'h65; ref_l[ 82]=8'h67; ref_l[ 83]=8'h68;
        ref_l[ 84]=8'h69; ref_l[ 85]=8'h6A; ref_l[ 86]=8'h6B; ref_l[ 87]=8'h6C;
        ref_l[ 88]=8'h6D; ref_l[ 89]=8'h6E; ref_l[ 90]=8'h6F; ref_l[ 91]=8'h70;
        ref_l[ 92]=8'h71; ref_l[ 93]=8'h72; ref_l[ 94]=8'h73; ref_l[ 95]=8'h74;
        ref_l[ 96]=8'h76; ref_l[ 97]=8'h77; ref_l[ 98]=8'h78; ref_l[ 99]=8'h79;
        ref_l[100]=8'h7A; ref_l[101]=8'h7B; ref_l[102]=8'h7C; ref_l[103]=8'h7D;
        ref_l[104]=8'h7E; ref_l[105]=8'h7F; ref_l[106]=8'h80; ref_l[107]=8'h81;
        ref_l[108]=8'h82; ref_l[109]=8'h83; ref_l[110]=8'h84; ref_l[111]=8'h85;
        ref_l[112]=8'h86; ref_l[113]=8'h87; ref_l[114]=8'h88; ref_l[115]=8'h89;
        ref_l[116]=8'h8A; ref_l[117]=8'h8B; ref_l[118]=8'h8C; ref_l[119]=8'h8D;
        ref_l[120]=8'h8E; ref_l[121]=8'h8F; ref_l[122]=8'h90; ref_l[123]=8'h91;
        ref_l[124]=8'h92; ref_l[125]=8'h93; ref_l[126]=8'h94; ref_l[127]=8'h95;
        ref_l[128]=8'h96; ref_l[129]=8'h97; ref_l[130]=8'h98; ref_l[131]=8'h99;
        ref_l[132]=8'h99; ref_l[133]=8'h9A; ref_l[134]=8'h9B; ref_l[135]=8'h9C;
        ref_l[136]=8'h9D; ref_l[137]=8'h9E; ref_l[138]=8'h9F; ref_l[139]=8'hA0;
        ref_l[140]=8'hA1; ref_l[141]=8'hA2; ref_l[142]=8'hA3; ref_l[143]=8'hA4;
        ref_l[144]=8'hA5; ref_l[145]=8'hA6; ref_l[146]=8'hA7; ref_l[147]=8'hA7;
        ref_l[148]=8'hA8; ref_l[149]=8'hA9; ref_l[150]=8'hAA; ref_l[151]=8'hAB;
        ref_l[152]=8'hAC; ref_l[153]=8'hAD; ref_l[154]=8'hAE; ref_l[155]=8'hAF;
        ref_l[156]=8'hB0; ref_l[157]=8'hB0; ref_l[158]=8'hB1; ref_l[159]=8'hB2;
        ref_l[160]=8'hB3; ref_l[161]=8'hB4; ref_l[162]=8'hB5; ref_l[163]=8'hB6;
        ref_l[164]=8'hB7; ref_l[165]=8'hB8; ref_l[166]=8'hB8; ref_l[167]=8'hB9;
        ref_l[168]=8'hBA; ref_l[169]=8'hBB; ref_l[170]=8'hBC; ref_l[171]=8'hBD;
        ref_l[172]=8'hBE; ref_l[173]=8'hBF; ref_l[174]=8'hBF; ref_l[175]=8'hC0;
        ref_l[176]=8'hC1; ref_l[177]=8'hC2; ref_l[178]=8'hC3; ref_l[179]=8'hC4;
        ref_l[180]=8'hC4; ref_l[181]=8'hC5; ref_l[182]=8'hC6; ref_l[183]=8'hC7;
        ref_l[184]=8'hC8; ref_l[185]=8'hC9; ref_l[186]=8'hCA; ref_l[187]=8'hCA;
        ref_l[188]=8'hCB; ref_l[189]=8'hCC; ref_l[190]=8'hCD; ref_l[191]=8'hCE;
        ref_l[192]=8'hCE; ref_l[193]=8'hCF; ref_l[194]=8'hD0; ref_l[195]=8'hD1;
        ref_l[196]=8'hD2; ref_l[197]=8'hD3; ref_l[198]=8'hD3; ref_l[199]=8'hD4;
        ref_l[200]=8'hD5; ref_l[201]=8'hD6; ref_l[202]=8'hD7; ref_l[203]=8'hD7;
        ref_l[204]=8'hD8; ref_l[205]=8'hD9; ref_l[206]=8'hDA; ref_l[207]=8'hDB;
        ref_l[208]=8'hDB; ref_l[209]=8'hDC; ref_l[210]=8'hDD; ref_l[211]=8'hDE;
        ref_l[212]=8'hDF; ref_l[213]=8'hDF; ref_l[214]=8'hE0; ref_l[215]=8'hE1;
        ref_l[216]=8'hE2; ref_l[217]=8'hE3; ref_l[218]=8'hE3; ref_l[219]=8'hE4;
        ref_l[220]=8'hE5; ref_l[221]=8'hE6; ref_l[222]=8'hE6; ref_l[223]=8'hE7;
        ref_l[224]=8'hE8; ref_l[225]=8'hE9; ref_l[226]=8'hE9; ref_l[227]=8'hEA;
        ref_l[228]=8'hEB; ref_l[229]=8'hEC; ref_l[230]=8'hED; ref_l[231]=8'hED;
        ref_l[232]=8'hEE; ref_l[233]=8'hEF; ref_l[234]=8'hF0; ref_l[235]=8'hF0;
        ref_l[236]=8'hF1; ref_l[237]=8'hF2; ref_l[238]=8'hF3; ref_l[239]=8'hF3;
        ref_l[240]=8'hF4; ref_l[241]=8'hF5; ref_l[242]=8'hF6; ref_l[243]=8'hF6;
        ref_l[244]=8'hF7; ref_l[245]=8'hF8; ref_l[246]=8'hF8; ref_l[247]=8'hF9;
        ref_l[248]=8'hFA; ref_l[249]=8'hFB; ref_l[250]=8'hFB; ref_l[251]=8'hFC;
        ref_l[252]=8'hFD; ref_l[253]=8'hFE; ref_l[254]=8'hFE; ref_l[255]=8'hFF;
    end

    integer n;
    integer bad_v1;
    integer bad_v2;
    integer bad_comb;

    initial begin
        repeat (4) @(negedge clk);
        rst_n = 1'b1;
        @(negedge clk);

        bad_v1   = 0;
        bad_v2   = 0;
        bad_comb = 0;

        //======================================================================
        // V1/V4：遍历 256 个输入
        //   驱动后 #1 观察组合实例（ROM_LATENCY=0）；再过一个 posedge 观察同步实例
        //======================================================================
        for (n = 0; n < 256; n = n + 1) begin
            @(negedge clk);
            i_de = 1'b1;
            i_y  = n[7:0];
            #1;
            if (o_l_c !== ref_l[n[7:0]]) bad_comb = bad_comb + 1;      // 组合分支
            if (o_de_c !== 1'b1)        bad_comb = bad_comb + 1;
            @(negedge clk);
            if (o_l !== ref_l[n[7:0]]) bad_v1 = bad_v1 + 1;            // 同步分支
            if (o_de !== 1'b1)         bad_v1 = bad_v1 + 1;
            // V2：单调不减
            if (n > 0) if (ref_l[n[7:0]] < ref_l[(n-1)]) bad_v2 = bad_v2 + 1;
        end
        if (bad_v1 == 0) chk_pass("V1_lut_matches_reference"); else begin
            chk_fail("V1_lut_matches_reference");
            $display("      mismatches = %0d", bad_v1);
        end
        if (bad_comb == 0) chk_pass("V4_rom_latency0_branch"); else chk_fail("V4_rom_latency0_branch");
        if (bad_v2 == 0) chk_pass("V2_monotonic_nondecreasing"); else chk_fail("V2_monotonic_nondecreasing");

        //======================================================================
        // V3：Y=255 → L=255
        //======================================================================
        @(negedge clk);
        i_y = 8'hFF;
        #1;
        if (o_l_c === 8'hFF) chk_pass("V3_y255_l255_comb"); else chk_fail("V3_y255_l255_comb");
        @(negedge clk);
        if (o_l === 8'hFF) chk_pass("V3_y255_l255"); else chk_fail("V3_y255_l255");

        //======================================================================
        // V4：控制对齐（同步分支固定 1 拍）
        //======================================================================
        @(negedge clk);
        i_de    = 1'b0;
        i_vsync = 1'b1;
        @(negedge clk);
        if (o_de === 1'b0 && o_vsync === 1'b1) chk_pass("V4_ctrl_align_1clk");
        else                                   chk_fail("V4_ctrl_align_1clk");
        i_vsync = 1'b0;
        @(negedge clk);
        if (o_vsync === 1'b0) chk_pass("V4_vsync_pulse_1clk"); else chk_fail("V4_vsync_pulse_1clk");

        if (errors == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL errors=%0d", errors);
        $finish;
    end

    initial begin
        #200000;
        $display("CHECK=timeout FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule

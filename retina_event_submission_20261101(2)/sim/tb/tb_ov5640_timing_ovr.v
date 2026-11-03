//==============================================================================
// tb_ov5640_timing_ovr -- ov5640_timing_ovr 单元测试（ModelSim SE 2020.4）
//
// 覆盖：① OVL_EN=0 纯旁路（含 13bit 边界值全 1）
//       ② 各扫描点常量：A(1800,750) / B(1800,600) / C(1800,520)
//       ③ SCAN_SEL=0 直用 OVL_HTS/OVL_VTS generic
//       ④ 复位行为：rst_n=0 期间回到旁路，释放后生效
//       ⑤ 运行期 i_ovl_en=0 时回到旁路
//       ⑥ 位宽：常量与直通都在 13bit 内，无截断
//
// 判据（run_sim.ps1 约定）：每条 CHECK=<名称> <PASS|FAIL>，收口一行
//   TEST_RESULT=PASS|FAIL；另打印机读汇总 TB_OVR=PASS|FAIL。
//==============================================================================
`timescale 1ns / 1ps

module tb_ov5640_timing_ovr;

    reg         clk = 0;
    reg         rst_n = 0;
    reg  [12:0] i_hts, i_vts;
    reg         i_ovl_en;

    wire [12:0] hts_byp, vts_byp;
    wire [12:0] hts_a,   vts_a;
    wire [12:0] hts_b,   vts_b;
    wire [12:0] hts_c,   vts_c;
    wire [12:0] hts_gen, vts_gen;

    integer errors = 0;
    integer checks = 0;

    // ---- DUT ①：默认配置（OVL_EN=0，应为纯旁路）----
    ov5640_timing_ovr #(
        .OVL_EN(0), .SCAN_SEL(0), .OVL_HTS(13'd1800), .OVL_VTS(13'd750)
    ) u_byp (
        .clk(clk), .rst_n(rst_n),
        .i_hts(i_hts), .i_vts(i_vts), .i_ovl_en(i_ovl_en),
        .o_hts(hts_byp), .o_vts(vts_byp)
    );

    // ---- DUT ②③④：扫描点 A / B / C ----
    ov5640_timing_ovr #(.OVL_EN(1), .SCAN_SEL(1)) u_a (
        .clk(clk), .rst_n(rst_n), .i_hts(i_hts), .i_vts(i_vts), .i_ovl_en(i_ovl_en),
        .o_hts(hts_a), .o_vts(vts_a));
    ov5640_timing_ovr #(.OVL_EN(1), .SCAN_SEL(2)) u_b (
        .clk(clk), .rst_n(rst_n), .i_hts(i_hts), .i_vts(i_vts), .i_ovl_en(i_ovl_en),
        .o_hts(hts_b), .o_vts(vts_b));
    ov5640_timing_ovr #(.OVL_EN(1), .SCAN_SEL(3)) u_c (
        .clk(clk), .rst_n(rst_n), .i_hts(i_hts), .i_vts(i_vts), .i_ovl_en(i_ovl_en),
        .o_hts(hts_c), .o_vts(vts_c));

    // ---- DUT ⑤：SCAN_SEL=0 + 显式 generic ----
    ov5640_timing_ovr #(
        .OVL_EN(1), .SCAN_SEL(0), .OVL_HTS(13'd1600), .OVL_VTS(13'd500)
    ) u_gen (
        .clk(clk), .rst_n(rst_n), .i_hts(i_hts), .i_vts(i_vts), .i_ovl_en(i_ovl_en),
        .o_hts(hts_gen), .o_vts(vts_gen));

    always #5 clk = ~clk;   // 100 MHz，只为推进使能同步拍

    // CHECK=<名称> <PASS|FAIL>
    task chk;
        input [255:0] nm;
        input [12:0]  got;
        input [12:0]  exp;
        begin
            checks = checks + 1;
            if (got !== exp) begin
                errors = errors + 1;
                $display("CHECK=%0s FAIL got=%0d(13'h%04h) exp=%0d(13'h%04h)", nm, got, got, exp, exp);
            end else begin
                $display("CHECK=%0s PASS (val=%0d)", nm, got);
            end
        end
    endtask

    task tick; begin @(negedge clk); @(negedge clk); end endtask

    initial begin
        $display("=== tb_ov5640_timing_ovr start ===");
        // i_ovl_en 从 1 开始：这样"复位期间必须旁路"才真正被检验
        i_hts = 13'd2624; i_vts = 13'd1968; i_ovl_en = 1'b1; rst_n = 1'b0;
        repeat (3) @(negedge clk);

        // ① 旁路：OVL_EN=0 为 generate 直连，与 rst/en 无关
        chk("bypass_hts",    hts_byp, 13'd2624);
        chk("bypass_vts",    vts_byp, 13'd1968);

        // ④ 复位期间：OVL_EN=1 且 i_ovl_en=1 时也必须回旁路
        chk("rstlow_A_hts",  hts_a,   13'd2624);
        chk("rstlow_A_vts",  vts_a,   13'd1968);

        rst_n = 1'b1;
        tick();

        // ② 扫描点常量
        chk("scanA_hts", hts_a, 13'd1800);
        chk("scanA_vts", vts_a, 13'd750);
        chk("scanB_hts", hts_b, 13'd1800);
        chk("scanB_vts", vts_b, 13'd600);
        chk("scanC_hts", hts_c, 13'd1800);
        chk("scanC_vts", vts_c, 13'd520);

        // ③ SCAN_SEL=0 ⇒ 用显式 generic
        chk("generic_hts", hts_gen, 13'd1600);
        chk("generic_vts", vts_gen, 13'd500);

        // ⑤ 运行期使能拉低/拉高
        i_ovl_en = 1'b0; tick();
        chk("en_off_A_hts",   hts_a,   13'd2624);
        chk("en_off_gen_vts", vts_gen, 13'd1968);
        i_ovl_en = 1'b1; tick();
        chk("en_on_A_vts",    vts_a,   13'd750);

        // ⑥ 位宽：13bit 全 1 直通不截断；覆盖值都在 13bit 内
        i_hts = 13'h1FFF; i_vts = 13'h1FFF;
        #1;                          // 组合直通需让连续赋值在本时间步内传播完
        chk("width_bypass_hts", hts_byp, 13'h1FFF);
        chk("width_bypass_vts", vts_byp, 13'h1FFF);
        tick();
        chk("width_ovr_hts", hts_a, 13'd1800);
        chk("width_ovr_vts", vts_c, 13'd520);

        // 复位再次生效
        rst_n = 1'b0; tick();
        chk("rst_again_A_hts", hts_a, 13'h1FFF);

        $display("=== checks=%0d errors=%0d ===", checks, errors);
        if (errors == 0) begin
            $display("TB_OVR=PASS");
            $display("TEST_RESULT=PASS");
        end else begin
            $display("TB_OVR=FAIL errors=%0d", errors);
            $display("TEST_RESULT=FAIL");
        end
        $finish;
    end

    // 超时保护：仿真卡死时也必须给出 FAIL
    initial begin
        #100000;
        $display("TB_OVR=FAIL timeout");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule

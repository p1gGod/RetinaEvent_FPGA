// ============================================================================
// tb_hud_stack.v -- OVL 平面仲裁器：优先级链 + 使能门控
//
// 判据（hud_stack.md §8）：
//   CHECK=PRIORITY_CHAIN  任意"低+高同时命中" -> 输出高优先级颜色（19 组向量）
//   CHECK=SINGLE_PLANE    每个平面单独命中 -> 输出自己的颜色
//   CHECK=NO_HIT          全不命中 -> o_hit=0
//   CHECK=DE_GATE         px_de=0 时 o_hit 恒为 0
//   CHECK=EN_GATE         en=0 的平面即使 hit=1 也不参与
//   CHECK=LATENCY_PIPE1   输出恰为输入延迟 1 拍（PIPE=1）
//   CHECK=OUT_OF_FRAME    坐标超出 800x480（消隐期）不命中
//
// ★ WIRE-U3（2026-10-17，接口约定 §2.3）新增 p6（HUD 文字）与遮罩 dim：
//   CHECK=P6_DIM_PRIORITY p6 文字 > 遮罩 > p5..p1；遮罩命中时 o_hit=0/o_dim=1；
//                         p6 文字命中时 o_hit=1/o_dim=0；p6_en=0 时 p6_hit 无效；
//                         dim/p6 也受 px_de 与屏幕范围门控；o_dim 与 o_hit 同拍。
//
// 端口顺序（与 hud_stack.md §2 逐字一致，供 L3 抄）：
//   clk_lcd, rst_n_lcd, px_x, px_y, px_de,
//   p1_en,p1_hit,p1_rgb, p2_en,p2_hit,p2_rgb, p3_en,p3_hit,p3_rgb,
//   p4_en,p4_hit,p4_rgb, p5_en,p5_hit,p5_rgb,
//   p6_en,p6_hit,p6_rgb, i_dim, o_hit, o_rgb, o_dim
//
// 本 TB 用 N_PLANES=6 例化：旧 22 个用例把 p6en/p6hit/dim 恒置 0，
// 因此它们仍然是"5 平面"的行为（等价性校验），新用例才动 p6/dim。
// ============================================================================
`timescale 1ns/1ps

module tb_hud_stack;

    localparam C1 = 24'h111111, C2 = 24'h222222, C3 = 24'h333333;
    localparam C4 = 24'h444444, C5 = 24'h555555;

    reg         clk, rst_n;
    reg  [10:0] px_x, px_y;
    reg         px_de;
    reg  [4:0]  pen, phit;      // bit0 = p1 ... bit4 = p5
    reg         p6en, p6hit;    // ★ 平面 6（HUD 文字）
    reg         dim;            // ★ 遮罩（hud_status.o_band_hit）
    wire        o_hit;
    wire [23:0] o_rgb;
    wire        o_dim;          // ★ 压暗标志 -> hud_inject.i_dim

    integer n_fail, n_case;
    initial begin n_fail = 0; n_case = 0; end
    task chk;
        input [255:0] nm;
        input         cond;
        begin
            if (cond) $display("CHECK=%0s PASS", nm);
            else begin $display("CHECK=%0s FAIL", nm); n_fail = n_fail + 1; end
        end
    endtask

    localparam C6 = 24'h666666;   // p6（HUD 文字）颜色

    hud_stack #(
        .N_PLANES (6)             // ★ 6 = 启用 p6 + 遮罩（默认 5 = 旧行为）
    ) u_dut (
        .clk_lcd(clk), .rst_n_lcd(rst_n),
        .px_x(px_x), .px_y(px_y), .px_de(px_de),
        .p1_en(pen[0]), .p1_hit(phit[0]), .p1_rgb(C1),
        .p2_en(pen[1]), .p2_hit(phit[1]), .p2_rgb(C2),
        .p3_en(pen[2]), .p3_hit(phit[2]), .p3_rgb(C3),
        .p4_en(pen[3]), .p4_hit(phit[3]), .p4_rgb(C4),
        .p5_en(pen[4]), .p5_hit(phit[4]), .p5_rgb(C5),
        .p6_en(p6en), .p6_hit(p6hit), .p6_rgb(C6), .i_dim(dim),
        .o_hit(o_hit), .o_rgb(o_rgb), .o_dim(o_dim)
    );

    initial clk = 1'b0;
    always #20 clk = ~clk;

    initial begin
        #200_000;
        $display("CHECK=TIMEOUT FAIL");
        $display("TEST_RESULT=FAIL");
        $finish;
    end

    integer err_prio, err_single, err_gate, err_nohit, err_frame;
    integer grp_single, grp_prio, grp_gate, grp_nohit, grp_frame;
    integer lat_err;

    initial begin
        err_prio = 0; err_single = 0; err_gate = 0; err_nohit = 0; err_frame = 0;
        grp_single = 0; grp_prio = 0; grp_gate = 0; grp_nohit = 0; grp_frame = 0;
        lat_err = 0;
    end

    // PIPE=1 延迟契约：o_hit/o_dim 应为输入判定的 1 拍延迟（独立算式，不看 DUT 内部）
    //   参考优先级：p6 文字 > 遮罩 > p5..p1；遮罩命中时 o_hit 必须为 0。
    reg hit_q, dim_q;
    wire in_frame_q = (px_x < 800) && (px_y < 480);
    wire p6_on_q    = p6en & p6hit;
    wire dim_on_q   = dim;
    wire low_hit_q  = (pen[0]&phit[0])|(pen[1]&phit[1])|(pen[2]&phit[2])|
                      (pen[3]&phit[3])|(pen[4]&phit[4]);
    wire hit_ref_q  = p6_on_q | (~dim_on_q & low_hit_q);
    wire dim_ref_q  = dim_on_q & ~p6_on_q;
    always @(posedge clk) begin
        if (!rst_n) begin
            hit_q <= 1'b0;
            dim_q <= 1'b0;
        end else begin
            hit_q <= px_de && in_frame_q && hit_ref_q;
            dim_q <= px_de && in_frame_q && dim_ref_q;
            if (o_hit !== hit_q) lat_err = lat_err + 1;
            if (o_dim !== dim_q) lat_err = lat_err + 1;
        end
    end

    // ---- 单向量测试 ---------------------------------------------------------
    task tc;
        input [4:0] en_v;
        input [4:0] hit_v;
        input       de_v;
        input [10:0] xv;
        input [10:0] yv;
        input       eh;
        input [23:0] ec;
        input [255:0] nm;
        input [2:0]  grp;      // 0=single 1=prio 2=gate 3=nohit 4=frame
        begin
            @(negedge clk);
            pen = en_v; phit = hit_v; px_de = de_v; px_x = xv; px_y = yv;
            p6en = 1'b0; p6hit = 1'b0; dim = 1'b0;   // 旧 22 用例 = 纯 5 平面行为
            @(posedge clk);
            #1;
            n_case = n_case + 1;
            if (o_hit !== eh || (eh && o_rgb !== ec)) begin
                $display("CHECK=%0s FAIL (en=%b hit=%b de=%b got_hit=%b got_rgb=%h exp_hit=%b exp_rgb=%h)",
                         nm, en_v, hit_v, de_v, o_hit, o_rgb, eh, ec);
                n_fail = n_fail + 1;
                case (grp)
                    3'd0: grp_single = grp_single + 1;
                    3'd1: grp_prio   = grp_prio + 1;
                    3'd2: grp_gate   = grp_gate + 1;
                    3'd3: grp_nohit  = grp_nohit + 1;
                    default: grp_frame = grp_frame + 1;
                endcase
            end else begin
                $display("CHECK=%0s PASS", nm);
            end
        end
    endtask

    integer err_p6;
    initial err_p6 = 0;

    // ---- ★ WIRE-U3：p6/遮罩向量 -------------------------------------------------
    task tc6;
        input        en6, hit6, dimv, de_v;
        input [10:0] xv, yv;
        input [4:0]  en_v, hit_v;
        input        eh, dh;
        input [23:0] ec;
        input [255:0] nm;
        begin
            @(negedge clk);
            p6en = en6; p6hit = hit6; dim = dimv;
            pen = en_v; phit = hit_v; px_de = de_v; px_x = xv; px_y = yv;
            @(posedge clk);
            #1;
            n_case = n_case + 1;
            if (o_hit !== eh || o_dim !== dh || (eh && o_rgb !== ec)) begin
                $display("CHECK=%0s FAIL (p6en=%b p6hit=%b dim=%b de=%b got_hit=%b got_dim=%b got_rgb=%h exp_hit=%b exp_dim=%b exp_rgb=%h)",
                         nm, en6, hit6, dimv, de_v, o_hit, o_dim, o_rgb, eh, dh, ec);
                n_fail = n_fail + 1;
                err_p6 = err_p6 + 1;
            end else begin
                $display("CHECK=%0s PASS", nm);
            end
        end
    endtask

    localparam [4:0] ALL = 5'b11111;
    localparam [4:0] P1  = 5'b00001, P2 = 5'b00010, P3 = 5'b00100,
                     P4  = 5'b01000, P5 = 5'b10000;

    initial begin
        rst_n = 1'b0; pen = 5'd0; phit = 5'd0; px_de = 1'b0;
        px_x = 11'd0; px_y = 11'd0;
        repeat (5) @(negedge clk);
        rst_n = 1'b1;
        repeat (2) @(negedge clk);

        // ---- 单平面命中（V4：各平面单独使能/关闭）----
        tc(ALL, P1, 1'b1, 11'd10, 11'd10, 1'b1, C1, "SINGLE_P1", 3'd0);
        tc(ALL, P2, 1'b1, 11'd10, 11'd10, 1'b1, C2, "SINGLE_P2", 3'd0);
        tc(ALL, P3, 1'b1, 11'd10, 11'd10, 1'b1, C3, "SINGLE_P3", 3'd0);
        tc(ALL, P4, 1'b1, 11'd10, 11'd10, 1'b1, C4, "SINGLE_P4", 3'd0);
        tc(ALL, P5, 1'b1, 11'd10, 11'd10, 1'b1, C5, "SINGLE_P5", 3'd0);

        // ---- 全不命中（V2）----
        tc(ALL, 5'd0, 1'b1, 11'd10, 11'd10, 1'b0, 24'h000000, "NO_HIT", 3'd3);

        // ---- 优先级：任意两两组合，输出序号大的 ----
        tc(ALL, P1|P2, 1'b1, 11'd10, 11'd10, 1'b1, C2, "PRIO_1_2", 3'd1);
        tc(ALL, P1|P3, 1'b1, 11'd10, 11'd10, 1'b1, C3, "PRIO_1_3", 3'd1);
        tc(ALL, P1|P4, 1'b1, 11'd10, 11'd10, 1'b1, C4, "PRIO_1_4", 3'd1);
        tc(ALL, P1|P5, 1'b1, 11'd10, 11'd10, 1'b1, C5, "PRIO_1_5", 3'd1);
        tc(ALL, P2|P3, 1'b1, 11'd10, 11'd10, 1'b1, C3, "PRIO_2_3", 3'd1);
        tc(ALL, P2|P4, 1'b1, 11'd10, 11'd10, 1'b1, C4, "PRIO_2_4", 3'd1);
        tc(ALL, P2|P5, 1'b1, 11'd10, 11'd10, 1'b1, C5, "PRIO_2_5", 3'd1);
        tc(ALL, P3|P4, 1'b1, 11'd10, 11'd10, 1'b1, C4, "PRIO_3_4", 3'd1);
        tc(ALL, P3|P5, 1'b1, 11'd10, 11'd10, 1'b1, C5, "PRIO_3_5", 3'd1);
        tc(ALL, P4|P5, 1'b1, 11'd10, 11'd10, 1'b1, C5, "PRIO_4_5", 3'd1);

        // ---- 全部命中：最高（p5）胜 ----
        tc(ALL, ALL, 1'b1, 11'd10, 11'd10, 1'b1, C5, "PRIO_ALL", 3'd1);

        // ---- 使能门控：p4/p5 关掉，p3 胜 ----
        tc(5'b00111, ALL, 1'b1, 11'd10, 11'd10, 1'b1, C3, "EN_MASK_123", 3'd2);
        tc(5'b00000, ALL, 1'b1, 11'd10, 11'd10, 1'b0, 24'h000000, "EN_ALL_OFF", 3'd2);

        // ---- px_de 门控（V3）----
        tc(ALL, ALL, 1'b0, 11'd10, 11'd10, 1'b0, 24'h000000, "DE_GATE", 3'd2);

        // ---- 屏外坐标（消隐期）不命中 ----
        tc(ALL, ALL, 1'b1, 11'd900, 11'd10, 1'b0, 24'h000000, "OUT_OF_FRAME_X", 3'd4);
        tc(ALL, ALL, 1'b1, 11'd10, 11'd600, 1'b0, 24'h000000, "OUT_OF_FRAME_Y", 3'd4);

        // ---- ★ WIRE-U3：p6 文字 / 遮罩优先级（接口约定 §2.3）----
        //   p6 文字 > 遮罩 > p5..p1
        tc6(1'b1, 1'b1, 1'b1, 1'b1, 11'd10, 11'd10, ALL, ALL, 1'b1, 1'b0, C6, "P6_OVER_DIM_AND_PLANES");
        // 只有遮罩：下层平面全部命中也要让位（o_hit=0 / o_dim=1）
        tc6(1'b0, 1'b0, 1'b1, 1'b1, 11'd10, 11'd10, ALL, ALL, 1'b0, 1'b1, 24'h000000, "DIM_HIDES_PLANES");
        // 遮罩 + p6 使能但未命中 => 仍是遮罩
        tc6(1'b1, 1'b0, 1'b1, 1'b1, 11'd10, 11'd10, ALL, ALL, 1'b0, 1'b1, 24'h000000, "DIM_WINS_IF_NO_TEXT");
        // p6 命中但 p6_en=0 => 无效，落到 p5
        tc6(1'b0, 1'b1, 1'b0, 1'b1, 11'd10, 11'd10, ALL, ALL, 1'b1, 1'b0, C5, "P6_EN_GATE");
        // 无遮罩 + p6 命中 => 只出 p6
        tc6(1'b1, 1'b1, 1'b0, 1'b1, 11'd10, 11'd10, 5'd0, 5'd0, 1'b1, 1'b0, C6, "P6_ONLY");
        // 两者都关 => 旧行为（p5 胜）
        tc6(1'b0, 1'b0, 1'b0, 1'b1, 11'd10, 11'd10, ALL, ALL, 1'b1, 1'b0, C5, "P6_DIM_BOTH_OFF");
        // px_de 门控
        tc6(1'b1, 1'b1, 1'b1, 1'b0, 11'd10, 11'd10, ALL, ALL, 1'b0, 1'b0, 24'h000000, "P6_DE_GATE");
        // 屏外坐标门控
        tc6(1'b1, 1'b1, 1'b1, 1'b1, 11'd900, 11'd10, ALL, ALL, 1'b0, 1'b0, 24'h000000, "P6_OUT_OF_FRAME");

        // ---- 延迟契约（连续跑 20 拍）----
        @(negedge clk);
        pen = ALL; phit = ALL; px_de = 1'b1; px_x = 11'd1; px_y = 11'd1;
        repeat (20) @(negedge clk);

        chk("PRIORITY_CHAIN", grp_prio   == 0);
        chk("SINGLE_PLANE",   grp_single == 0);
        chk("NO_HIT",         grp_nohit  == 0);
        chk("DE_GATE",        grp_gate   == 0);
        chk("EN_GATE",        grp_gate   == 0);
        chk("OUT_OF_FRAME",   grp_frame  == 0);
        chk("LATENCY_PIPE1",  lat_err == 0);
        chk("P6_DIM_PRIORITY", err_p6 == 0);
        chk("CASE_COUNT",     n_case == 30);

        $display("INFO=cases=%0d lat_err=%0d total_fail=%0d", n_case, lat_err, n_fail);
        if (n_fail == 0) $display("TEST_RESULT=PASS");
        else             $display("TEST_RESULT=FAIL");
        $finish;
    end

endmodule

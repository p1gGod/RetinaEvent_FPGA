//==============================================================================
// spatial_lap -- 四邻域拉普拉斯近似"中心-周边"感受野（L2 事件引擎）
//
// 规格：retina_event/docs/子模块设计/L2_事件引擎/spatial_lap.md §2/§3/§4/§6
//   响应 lap = CENTER_GAIN·c − (u + d + l + r)        （默认 CENTER_GAIN=4）
//   零乘法器、零 DSP（默认 4 为纯移位）；NORM_SHIFT 归一化；EDGE_MODE 边界规则
//
// ── 关键约定 1：de 是**有效限定符，可以稀疏**（集成修复，Lead 2026-10-03）
//    上游 vps_resample 做 x 方向 2 抽 1，o_de 在有效行内**隔一拍才高一次**。
//    因此列计数**按 de 脉冲递增**、只在 vsync 复位，**绝不能在 de 低电平拍清零**：
//    否则 x_cnt 只在 0/1 之间跳、永远到不了 IMG_W−1 ⇒ y_cnt 永不递增 ⇒ o_de 恒 0
//    （实测：输入 771,201 个 de 拍，输出 0 个）。
//
// ── 关键约定 2：三路行流的**列相位**（本模块最容易错的地方）
//    设输入像素在 cycle t 的列为 col0(t)。line_buffer 读延迟 1 拍 ⇒
//        lb0_q(t) = mem0_old[col0(t−1)] → 列 col0(t−1) = col1(t)
//        lb1_q(t) = mem1_old[col1(t−1)] → 列 col0(t−2) = col2(t)
//    ⇒ 在 cycle T 处，三路**同列**（列 = col2(T)）：
//        ROW_D（行 R）   = cur2(T) = dl0(T−2)
//        ROW_C（行 R−1） = up1(T)  = lb0_q(T−1)      ← 用 stage1 寄存器，**不再多打一拍**
//        ROW_U（行 R−2） = lb1_q(T)                  ← 直接用 line_buffer 输出
//    ⚠️ 曾把 up1 再打一拍成 up2 使用，导致中心行比 cur2/lb1_q 滞后 1 列，
//       整个 3×3 窗口错位（golden 模型逐点对拍发现）。lb1 的写数据也必须是
//       **lb0_q**（列 = col1，与写指针锁步），不能是 up1（列滞后 1）。
//
// ── 关键约定 3：列抽头按 **de 脉冲**推进（de-gated），而不是按拍推进
//    de 稀疏且可能不规则 ⇒ 用 "if (de2)" 限定 ct_d1/ct_d2/up_d1/dn_d1 更新，
//    这样每个抽头恰好对应"上一个/上上个有效像素"，与 de 间隔无关。
//
// 流水线（1 px/clk，总延迟 3 拍）：
//   stage0 t     : 输入 S0；lb0 写出、读地址 = col0
//   stage1 t+1   : cur1 = S0 打拍；up1 = lb0_q 打拍；lb1 写 lb0_q、读地址 = col1
//   stage2 t+2   : 三路同列（dn=cur2, ct=up1, up=lb1_q）；de-gated 抽头采样
//   stage3 t+3   : 输出寄存 o_lap / o_de
//   抽头：c=ct_d1（中心列）、l=ct_d2（列−1）、r=ct（列+1）、u=up_d1、d=dn_d1
//
// 窗口中心 = (cy, cx) = (row_prev−1, col_prev)，输出区域 = (IMG_W−1) × (IMG_H−1)：
//   每行第 1 个有效像素（col2 = 0）的"上一个像素"在上一行 ⇒ 整拍抑制（taps_ok）。
//   邻域有效性：u 需 cy≥1；l 需 cx≥1；r 需 cx≤IMG_W−2；d 恒有效。
//   越界抽头按 EDGE_MODE 处理：0 = 补 0；1 = 复制中心值 c。
//
// ── R3 契约：**窗口中心语义随流走**（Lead 裁决，2026-10-03；R3 判据守住）──
//   本模块额外输出三个与 o_lap/o_de **同拍**的信号，全部取自同一个"窗口中心"寄存器组：
//       o_x    = col_prev        （中心像素列，0..IMG_W−2）
//       o_y    = row_prev − 1    （中心像素行，0..IMG_H−2）
//       o_dl_c = ct_d1           （中心像素的 ΔL，S9）
//   为什么必须由本模块给：窗口中心天然比输入流晚「3 拍流水 + 1 个 de 间隔」，而这个间隔
//   **随 de 稀疏度变化**（稀疏 5 拍 / 连续 4 拍）⇒ 下游任何固定 delay_pipe 或"vsync 复位 +
//   数 de 脉冲"的重建方案都对不准（实测：事件坐标偏移 (x−95, y−88) 且逐帧漂移 ≈ −25 行/帧；
//   守卫 ΔL 取错像素 ⇒ 事件被全部门掉）。
//   因此 event_gen **不再自己数坐标、也不再猜 ΔL 延迟**，直接用本模块的 o_x/o_y/o_dl_c。
//
// ⚠️ §9.1 这是**整数拉普拉斯近似**中心-周边，不是 DoG（决策 D6），报告里别写错。
// ⚠️ §9.2 有符号右移是向下取整，会引入 ±1 LSB 偏置（偏向多报 OFF），已在报告声明。
// ⚠️ §9.5 行缓存深度必须 = IMG_W = 400（写成 800 会让整幅图错位）。
//==============================================================================
`timescale 1ns / 1ps

module spatial_lap #(
    parameter IMG_W       = 400,    // 行宽（决定行缓存深度）
    parameter CENTER_GAIN = 4,      // 中心权重（四邻域拉普拉斯为 4）
    parameter NORM_SHIFT  = 2,      // 输出右移归一化拍数；0 = 不归一化
    parameter EDGE_MODE   = 0       // 0 = 边界补 0；1 = 边界复制（replicate）
)(
    input  wire        clk_cam,
    input  wire        rst_n_cam,
    input  wire        i_vsync,
    input  wire        i_de,
    input  wire [8:0]  i_dl,        // ΔL（S9）
    output reg         o_vsync,
    output reg         o_de,
    output reg  [11:0] o_lap,       // 中心-周边响应（有符号 S12）
    output reg  [8:0]  o_x,         // 🔧 R3：窗口中心像素列（随流走）
    output reg  [7:0]  o_y,         // 🔧 R3：窗口中心像素行（随流走）
    output reg  [8:0]  o_dl_c       // 🔧 R3：窗口中心像素的 ΔL（S9，供 event_gen 守卫）
);

    function integer clog2;
        input integer value;
        integer i;
        begin
            clog2 = 0;
            for (i = value - 1; i > 0; i = i >> 1) clog2 = clog2 + 1;
        end
    endfunction

    localparam XW = (clog2(IMG_W) < 1) ? 1 : clog2(IMG_W);   // 400 → 9
    localparam YW = 8;                                       // 240 → 8

    //--------------------------------------------------------------------------
    // 行列计数（**按 de 脉冲递增**，只在 vsync 复位 —— 见"关键约定 1"）
    //--------------------------------------------------------------------------
    reg [XW-1:0] x_cnt;
    reg [YW-1:0] y_cnt;

    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            x_cnt <= {XW{1'b0}};
            y_cnt <= {YW{1'b0}};
        end else if (i_vsync) begin
            x_cnt <= {XW{1'b0}};
            y_cnt <= {YW{1'b0}};
        end else if (i_de) begin
            if (x_cnt == IMG_W - 1) begin
                x_cnt <= {XW{1'b0}};
                y_cnt <= y_cnt + 1'b1;
            end else begin
                x_cnt <= x_cnt + 1'b1;
            end
        end
    end

    //--------------------------------------------------------------------------
    // stage0 + 行缓存（B1）——只读 L1 原语 line_buffer，端口按文档 §2
    //--------------------------------------------------------------------------
    wire               de0  = i_de;
    wire [8:0]         dl0  = i_dl;
    wire [XW-1:0]      col0 = x_cnt;
    wire [YW-1:0]      row0 = y_cnt;

    wire [8:0] lb0_q;   // 上一行同列（列 = col1）
    wire [8:0] lb1_q;   // 上两行同列（列 = col2）

    line_buffer #(.IMG_W(IMG_W), .DATA_W(9), .ADDR_W(XW), .USE_BRAM(1)) u_lb0 (
        .clk       (clk_cam),
        .rst_n     (rst_n_cam),
        .i_wr_en   (de0),
        .i_wr_data (dl0),
        .i_rd_addr (col0),
        .o_rd_data (lb0_q)
    );

    //--------------------------------------------------------------------------
    // stage1（cycle t+1）
    //--------------------------------------------------------------------------
    reg           de1;
    reg [XW-1:0]  col1;
    reg [YW-1:0]  row1;
    reg [8:0]     cur1;     // ROW_D 1 级
    reg [8:0]     up1;      // ROW_C 1 级（= 中心行，列 = col2）
    reg           vs1;

    line_buffer #(.IMG_W(IMG_W), .DATA_W(9), .ADDR_W(XW), .USE_BRAM(1)) u_lb1 (
        .clk       (clk_cam),
        .rst_n     (rst_n_cam),
        .i_wr_en   (de1),
        .i_wr_data (lb0_q),     // ⚠️ 必须是 lb0_q（列 = col1），不能用 up1（滞后 1 列）
        .i_rd_addr (col1),
        .o_rd_data (lb1_q)
    );

    //--------------------------------------------------------------------------
    // stage2（cycle t+2）：三路同列
    //--------------------------------------------------------------------------
    reg           de2;
    reg [XW-1:0]  col2;
    reg [YW-1:0]  row2;
    reg [8:0]     cur2;     // ROW_D
    reg           vs2;

    wire [8:0] row_dn = cur2;       // 行 R
    wire [8:0] row_ct = up1;        // 行 R−1（中心行）
    wire [8:0] row_up = lb1_q;      // 行 R−2

    //--------------------------------------------------------------------------
    // de-gated 列抽头（**只在 de2 有效拍推进**，与 de 间隔无关）
    //--------------------------------------------------------------------------
    reg [8:0]    ct_d1;     // 中心行，上一个有效像素（= 中心抽头）
    reg [8:0]    ct_d2;     // 中心行，上上个有效像素（= 左抽头）
    reg [8:0]    up_d1;     // 上邻域行，上一个有效像素
    reg [8:0]    dn_d1;     // 下邻域行，上一个有效像素
    reg [XW-1:0] col_prev;  // 上一个有效像素的列
    reg [YW-1:0] row_prev;  // 上一个有效像素的行
    reg          vs_d;

    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            de1      <= 1'b0;  col1 <= {XW{1'b0}};  row1 <= {YW{1'b0}};
            cur1     <= 9'd0;  up1  <= 9'd0;        vs1  <= 1'b0;
            de2      <= 1'b0;  col2 <= {XW{1'b0}};  row2 <= {YW{1'b0}};
            cur2     <= 9'd0;  vs2  <= 1'b0;
            ct_d1    <= 9'd0;  ct_d2 <= 9'd0;  up_d1 <= 9'd0;  dn_d1 <= 9'd0;
            col_prev <= {XW{1'b0}};  row_prev <= {YW{1'b0}};
            vs_d     <= 1'b0;
        end else begin
            // stage1
            de1  <= de0;   col1 <= col0;  row1 <= row0;
            cur1 <= dl0;   up1  <= lb0_q; vs1  <= i_vsync;
            // stage2
            de2  <= de1;   col2 <= col1;  row2 <= row1;
            cur2 <= cur1;  vs2  <= vs1;
            // de-gated 列抽头：每个抽头 = 上一个有效像素
            if (de2) begin
                ct_d1    <= row_ct;     // 中心行 @ 上一个像素
                ct_d2    <= ct_d1;      // 中心行 @ 上上个像素
                up_d1    <= row_up;
                dn_d1    <= row_dn;
                col_prev <= col2;
                row_prev <= row2;
            end
            // 🔧 Bug A 修复（Lead 授权，2026-10-03）：**vsync 必须无条件穿透**。
            //    原来这行在 if (de2) 里 ⇒ 消隐期的 vsync（R1 之后 vsync 恒在消隐期）
            //    永远采不到 ⇒ o_vsync 恒 0（实测 5 帧 0 个脉冲）⇒ 下游 vsync 链断。
            vs_d <= vs2;
        end
    end

    //--------------------------------------------------------------------------
    // B6：边界规则（EDGE_MODE）
    //   窗口中心 = (cy, cx) = (row_prev−1, col_prev)
    //--------------------------------------------------------------------------
    wire taps_ok = (col2 != {XW{1'b0}});    // 当前像素不是本行第一个（否则抽头跨行）
    wire cy_ok   = (row_prev != {YW{1'b0}});// cy = row_prev−1 ≥ 0
    wire u_ok    = (row_prev >= 8'd2);      // cy−1 ≥ 0
    wire l_ok    = (col_prev != {XW{1'b0}});// cx−1 ≥ 0
    wire r_ok    = (col_prev <= IMG_W - 2); // cx+1 ≤ IMG_W−1
    // d 恒有效（cy+1 = row_prev ≤ IMG_H−1）

    wire signed [11:0] c = {{3{ct_d1[8]}}, ct_d1};
    wire signed [11:0] l = {{3{ct_d2[8]}}, ct_d2};
    wire signed [11:0] r = {{3{row_ct[8]}}, row_ct};
    wire signed [11:0] u = {{3{up_d1[8]}}, up_d1};
    wire signed [11:0] d = {{3{dn_d1[8]}}, dn_d1};

    wire signed [11:0] fill_lvl = (EDGE_MODE != 0) ? c : 12'sd0;

    wire signed [11:0] u_eff = u_ok ? u : fill_lvl;
    wire signed [11:0] l_eff = l_ok ? l : fill_lvl;
    wire signed [11:0] r_eff = r_ok ? r : fill_lvl;

    //--------------------------------------------------------------------------
    // B4/B5：拉普拉斯 + 归一化（零乘法器：CENTER_GAIN=4 时为纯移位）
    //--------------------------------------------------------------------------
    wire signed [11:0] sum4 = u_eff + d + l_eff + r_eff;        // |·| ≤ 1020
    wire signed [11:0] lap  = (c * CENTER_GAIN) - sum4;         // |·| ≤ 2040（S12 够）
    wire signed [11:0] lap_n = (NORM_SHIFT == 0) ? lap : (lap >>> NORM_SHIFT);

    //--------------------------------------------------------------------------
    // B7：输出寄存（总延迟 3 拍）
    //   o_x / o_y / o_dl_c 与 o_lap / o_de **同拍**，全部取自窗口中心寄存器组
    //   （col_prev / row_prev / ct_d1）⇒ 下游直接使用即可，无需任何延迟补偿。
    //--------------------------------------------------------------------------
    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            o_vsync <= 1'b0;
            o_de    <= 1'b0;
            o_lap   <= 12'sd0;
            o_x     <= 9'd0;
            o_y     <= 8'd0;
            o_dl_c  <= 9'd0;
        end else begin
            o_vsync <= vs_d;
            o_de    <= de2 & taps_ok & cy_ok;
            o_lap   <= lap_n;
            o_x     <= col_prev;            // 中心列 = col2−1（taps_ok 保证 ≥0）
            o_y     <= row_prev - 8'd1;     // 中心行 = row_prev−1（cy_ok 保证 ≥0）
            o_dl_c  <= ct_d1;               // 中心像素的 ΔL
        end
    end

endmodule

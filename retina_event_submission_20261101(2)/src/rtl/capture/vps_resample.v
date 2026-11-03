//==============================================================================
// vps_resample -- 800×480 VPS → 400×240 VPS 的 2×2 抽点（L2 采集）
//
// 规格：retina_event/docs/子模块设计/L2_采集/vps_resample.md §2/§3/§4/§6
//   §4 B1/B2 行/列计数；B3/B4 抽取判据；B5 输出组织
//   §6 输出比输入晚**固定 1 拍**（纯组合判据 + 1 拍寄存）
//
// 关键约束（事实 H23）：**禁止变量除法/乘法**。抽取比取 2 的幂，用位选判据：
//     x_keep = &(~x_cnt[XS-1:0])      （XS = log2(X_DECIM)）
//   本模块零 DSP、零除法器。
//
// 边界语义：
//   x_cnt：**i_de 有效时递增，只在 i_vsync 复位，并在 IN_W−1 回绕**（★ H63 修复）。
//         ⚠️ 绝不能在 i_de=0 时清零 —— 真实相机通路的 i_de 是**稀疏选通**
//         （见下方 B1/B2 处的 H63 说明）。每行第一个"被计数的"像素 x_cnt = 0。
//   y_cnt：i_vsync 清零 + **在 IN_H−1 饱和**；每行最后一个有效像素（x_cnt==IN_W-1）时 +1
//   ⇒ 输出 o_de = 寄存后的 (i_de & x_keep & y_keep & y_in & ~i_vsync)，控制与数据同拍寄存
//
// ── R1 帧级计数契约（Lead 裁决，2026-10-03；tb_vps_resample 的 R1_* 判据守住）──
//   · 每帧恰好 OUT_W×OUT_H = 96,000 个 o_de（不是 96,400）
//   · 每行恰好 OUT_W = 400 个 o_de，行间 ≥1 拍干净间隙
//   · i_vsync 当拍不出像素（`~i_vsync`）
//   · vsync 之后第一行第一列 = (0,0)
//   ⚠️ 前提：**源的 vsync 应落在场消隐期**（真实 OV5640 如此；vps_pattern_gen 已同步修正）。
//      若源把 vsync 与有效像素放在同拍，该像素按上面的纪律被丢弃 ⇒ 那一行只有 399 个
//      输出像素、且行回绕失效（每帧会多一行）。这是"vsync 当拍不出像素"与"每行 400"
//      在源时序违规时的固有取舍；修法是修源（把 vsync 移到消隐期），不是放宽本模块纪律。
//==============================================================================
`timescale 1ns / 1ps

module vps_resample #(
    parameter IN_W    = 800,        // 输入行宽
    parameter IN_H    = 480,        // 输入行数
    parameter X_DECIM = 2,          // 列抽取比（必须为 2 的幂：1/2/4）
    parameter Y_DECIM = 2,          // 行抽取比（必须为 2 的幂：1/2/4）
    parameter OUT_W   = 400,        // 输出行宽（= IN_W / X_DECIM，仅供文档标注）
    parameter OUT_H   = 240         // 输出行数（= IN_H / Y_DECIM，仅供文档标注）
)(
    input  wire        clk_cam,
    input  wire        rst_n_cam,
    input  wire        i_vsync,
    input  wire        i_de,
    input  wire [15:0] i_data,
    output reg         o_vsync,
    output reg         o_de,
    output reg  [15:0] o_data
);

    //--------------------------------------------------------------------------
    // 位宽推导（禁止变量除法 ⇒ 全部用常数函数/局部常量）
    //--------------------------------------------------------------------------
    function integer clog2;
        input integer value;
        integer i;
        begin
            clog2 = 0;
            for (i = value - 1; i > 0; i = i >> 1) clog2 = clog2 + 1;
        end
    endfunction

    localparam XW = (clog2(IN_W) < 1) ? 1 : clog2(IN_W);   // 800 → 10
    localparam YW = (clog2(IN_H) < 1) ? 1 : clog2(IN_H);   // 480 → 9
    localparam XS = (X_DECIM >= 4) ? 2 : ((X_DECIM >= 2) ? 1 : 0);
    localparam YS = (Y_DECIM >= 4) ? 2 : ((Y_DECIM >= 2) ? 1 : 0);

    reg [XW-1:0] x_cnt;
    reg [YW-1:0] y_cnt;

    // B1/B2：列计数（行间清零）与行计数（帧首清零 + **在 IN_H−1 饱和**）
    //
    // ⚠️ R1 修复（Lead 裁决，2026-10-03）：帧级计数必须自洽 ——
    //    每帧恰好 OUT_W×OUT_H = 96,000 个 de、每行恰好 OUT_W = 400 个。
    //    旧写法让 y_cnt 在帧尾从 IN_H−1=479 自增到 IN_H=480（偶数），
    //    于是 y_keep 在"帧尾消隐 + 下一帧 vsync 当拍"又成立一次，
    //    多出整整一行（实测 96,400/帧 = 241 行 × 400）。
    //    修法：y_cnt **饱和在 IN_H−1**（479 为奇数 ⇒ 帧尾/消隐期 y_keep 恒 0）。
    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            x_cnt <= {XW{1'b0}};
            y_cnt <= {YW{1'b0}};
        end else if (i_vsync) begin
            x_cnt <= {XW{1'b0}};
            y_cnt <= {YW{1'b0}};
        end else if (i_de) begin
            if (x_cnt == IN_W - 1) begin
                x_cnt <= {XW{1'b0}};
                if (y_cnt != IN_H - 1) y_cnt <= y_cnt + 1'b1;   // 饱和：帧尾不再多一行
            end else begin
                x_cnt <= x_cnt + 1'b1;
            end
        end
        // ⚠️ ★★ H63 修复（2026-10-07）：**这里原来还有一支 `else x_cnt <= 0;`**
        //    （"行间（消隐）→ 下一行从 0 开始"）。它假设 i_de 是**带消隐的**
        //    VPS 数据使能（行内连续 800 拍高、行间拉低）。
        //
        //    真板上根本不是这样：相机通路是 cam_tap → axis_fifo(CDC-0)，而 CDC-0 抹掉了
        //    消隐信息，retina_core 只能拿 `~cdc0_empty`（= "本拍有数据"的**选通**）当 de。
        //    clk_cam(50MHz) 比像素率(48MHz pclk ÷ 2 = 24MHz)快一倍 ⇒ FIFO 大部分时间是空的
        //    ⇒ de 是"1 拍高 / 1 拍低"的稀疏脉冲串，**每来一个像素前面都有一个 de 低电平拍**。
        //    于是那一支每一拍都在清零 x_cnt：x_cnt 只在 0/1 之间跳，永远到不了 IN_W−1=799
        //    ⇒ y_cnt 永不递增 ⇒ y_keep ≡ 1、x_keep ≡ 1 ⇒ **2×2 抽点被静默旁路**。
        //
        //    实测（build/sim/tb_retina_core_cam）：改前每帧进入 spatial_lap 的 de = 383,999
        //    而不是 400×240 = 96,000；下游 temporal_diff 的 pix_cnt 只数到 96,000 就饱和，
        //    帧存读回一个**常数** ⇒ ΔL 退化成 (L − 常数) ⇒ spatial_lap 变成**纯空间边缘检测**
        //    ⇒ 板上事件场是静态场景的边缘图；spatial_lap 的 8bit y_cnt 还在
        //    383999/400 = 960 行里回绕 ⇒ 事件坐标出现 y = 239..254（越出 400×240 网格）。
        //
        //    修法与 spatial_lap 的"关键约定 1"完全同源：**de 是"有效限定符，可以稀疏"，
        //    行列结构必须由"像素计数回绕 IN_W"给出，绝不能在 de 低电平拍清零**。
        //    行边界本来就靠 `x_cnt == IN_W-1` 回绕（相机每行恒 800 像素，事实 H41/H42），
        //    那一支对**带消隐**的源也是冗余的 ⇒ 删掉它两条源都正确。
        //    （回归：tb_vps_resample 的 V1/R1 判据全部在"行内连续 de"下给出，语义不变；
        //      tb_retina_core_cam 专门覆盖"稀疏 de"，改前 6 条判据全红、改后全绿。）
    end

    // B3/B4：抽取判据（位选，零除法）
    wire x_keep;
    wire y_keep;

    generate
        if (XS == 0) begin : g_xk_all
            assign x_keep = 1'b1;
        end else begin : g_xk_dec
            assign x_keep = ~|x_cnt[XS-1:0];
        end
    endgenerate

    generate
        if (YS == 0) begin : g_yk_all
            assign y_keep = 1'b1;
        end else begin : g_yk_dec
            assign y_keep = ~|y_cnt[YS-1:0];
        end
    endgenerate

    // B5：输出组织（固定 1 拍延迟，控制与数据同拍）
    //   ⚠️ R1 修复：`~i_vsync` 保证 **vsync 当拍不出像素**。
    //      （vps_pattern_gen 的 vsync 与第一个有效像素同拍；若不加这条，
    //        那一拍会用"复位前"的 y_cnt 判 y_keep，可能多出一个越界像素。）
    //   `y_in` 是饱和之外的兜底：行号必须 < IN_H。
    wire y_in      = (y_cnt < IN_H);
    wire o_de_next = i_de & x_keep & y_keep & y_in & ~i_vsync;

    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            o_vsync <= 1'b0;
            o_de    <= 1'b0;
            o_data  <= 16'h0000;
        end else begin
            o_vsync <= i_vsync;
            o_de    <= o_de_next;
            o_data  <= i_data;
        end
    end

endmodule

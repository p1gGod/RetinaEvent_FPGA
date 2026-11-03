// ============================================================================
// hud_event_layer.v -- OVL 平面 2：事件位图的**透明**叠加层（画在原始画面上）
//
// 规格来源：docs/子模块设计/L2_屏上UI/hud_event_layer.md（§2 七端口 + 位图读口）
//
// 与 event_render 的关系：读**同一份**事件位图、同一套地址公式与颜色语义，
//   差别只在「透明(本位图) / 不透明全屏(event_render)」。
//
// 位图接口（跨层冻结，见 task-3 裁决 Fix A）：
//   400x240x4bit，2 px / 8bit 字，200 字/行 ⇒ **16 bit 地址 + 8 bit 数据**
//     addr = ey*200 + (ex>>1)，sel = ex[0]，st = sel ? data[7:4] : data[3:0]
//   ★ 文档 §2 把地址写成了输入 `i_bmp_addr`（方向笔误，读地址必须是输出），
//     已按输出 `o_bmp_rd_addr[15:0]` 实现（Lead 已确认是文档笔误）。
//
// 4bit 单元语义（冻结）：bit[3] = 极性（1=ON），bit[2:0] = 余晖强度（0=无事件）。
//   「位图 = 0xC」⇒ 极性 1 / lvl 4 ⇒ ON 红（对齐 hud_event_layer.md §8 V1）。
//
// 延迟：地址**组合**给出 ⇒ BRAM 1 拍 ⇒ 命中判据/使能用 1 拍前的值对齐
//       ⇒ 本平面总延迟恰好 **1 拍**（与 hud_grid/panel/text/sprite 的 PIPE=1 一致）。
//       命中 = data != 0（**透明**：位图为 0 处不遮挡原图，§8 V2）。
// ============================================================================
module hud_event_layer (
    input  wire        clk_lcd,
    input  wire        rst_n_lcd,
    input  wire [10:0] px_x,
    input  wire [10:0] px_y,
    input  wire        px_de,
    input  wire        ovl_en,
    output wire        ovl_hit,        // 该像素有事件
    output wire [23:0] ovl_rgb,        // 事件色 RGB888
    output wire [15:0] o_bmp_rd_addr,  // 位图 B 口读地址（组合）
    input  wire [7:0]  i_bmp_rd_data   // 位图 B 口数据（1 拍延迟）
);

    parameter [10:0] EV_W  = 11'd400;
    parameter [10:0] EV_H  = 11'd240;
    parameter [1:0]  SCALE = 2'd2;

    parameter [23:0] COLOR_ON     = 24'hFF3030;   // ON 红
    parameter [23:0] COLOR_OFF    = 24'h3080FF;   // OFF 蓝
    parameter [23:0] COLOR_DECAY1 = 24'h902020;   // ON 余晖（暗红）
    parameter [23:0] COLOR_DECAY2 = 24'h204878;   // OFF 余晖（暗蓝）
    parameter [23:0] COLOR_DECAY3 = 24'h404040;   // 最弱余晖（灰）

    parameter [2:0]  LVL_FRESH = 3'd4;
    parameter [2:0]  LVL_MID   = 3'd2;

    localparam [15:0] WORDS_PER_ROW = EV_W / 2;     // 200 字/行

    // ---- B1/B2 坐标降采样 + 位图地址（组合）-------------------------------
    wire [9:0] ex  = px_x[10:1];      // 0..399
    wire [8:0] ey  = px_y[9:1];       // 0..239
    wire       sel = ex[0];

    assign o_bmp_rd_addr = ey * WORDS_PER_ROW + {7'd0, ex[9:1]};

    // ---- B3 读数据（1 拍延迟，由外部 BRAM 提供）----------------------------
    // ★ 地址是**组合**给出的、数据 1 拍后才到 ⇒ sel 必须同样延迟 1 拍，
    //   否则会取到下一像素的 ex[0]（与 event_render 同一个坑）。
    reg sel_d1;
    always @(posedge clk_lcd) begin
        if (!rst_n_lcd) sel_d1 <= 1'b0;
        else            sel_d1 <= sel;
    end
    wire [3:0] st = sel_d1 ? i_bmp_rd_data[7:4] : i_bmp_rd_data[3:0];

    // ---- B4 颜色译码 + B5 命中判据 -----------------------------------------
    reg [23:0] col_c;
    always @(*) begin
        if (st[2:0] >= LVL_FRESH)      col_c = st[3] ? COLOR_ON  : COLOR_OFF;
        else if (st[2:0] >= LVL_MID)   col_c = st[3] ? COLOR_DECAY1 : COLOR_DECAY2;
        else                           col_c = COLOR_DECAY3;
    end
    assign ovl_rgb = col_c;

    // ---- B6 延迟对齐：坐标/使能延迟 1 拍，与 BRAM 数据同拍 ------------------
    reg px_de_d1, ovl_en_d1;
    always @(posedge clk_lcd) begin
        if (!rst_n_lcd) begin
            px_de_d1  <= 1'b0;
            ovl_en_d1 <= 1'b0;
        end else begin
            px_de_d1  <= px_de;
            ovl_en_d1 <= ovl_en;
        end
    end

    // 透明：4bit 状态为 0 时不命中
    assign ovl_hit = px_de_d1 & ovl_en_d1 & (st[2:0] != 3'd0);

endmodule

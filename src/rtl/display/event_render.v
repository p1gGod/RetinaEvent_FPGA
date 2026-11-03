// ============================================================================
// event_render.v -- 事件位图 -> 800x480 不透明「事件画面」（disp_mux 的 B 路）
//
// 规格来源：docs/子模块设计/L2_显示/event_render.md（§2/§3/§4/§6/§8/§9）
//
// 位图接口（跨层冻结，见 task-3 裁决）：
//   组织 = 400x240x4bit，**2 px / 8bit 字**，200 字/行，共 48,000 字 ⇒ 16 bit 地址
//     addr = ey * 200 + (ex >> 1)          ey = px_y/2, ex = px_x/2   （×2 放大取高位）
//     sel  = ex[0]，st = sel ? data[7:4] : data[3:0]
//   ★ 15 bit 地址只能覆盖 32,768 字 < 48,000 字 ⇒ 文档 §2 的 15/4 是抄错的，
//     已按 16bit 地址 + 8bit 数据实现（Lead 裁决 Fix A）。
//
// 4bit 单元语义（冻结，写入端 retina_core 必须逐位对齐）：
//     bit[3]   = 极性：1 = 最后一次事件是 ON，0 = OFF
//     bit[2:0] = 余晖强度：0 = 无事件
//   解码：lvl=0 -> 背景黑；lvl>=LVL_FRESH -> 极性纯色；lvl>=LVL_MID -> 暗档；
//         否则 -> 最暗档。这样「位图 = 0xC」= 极性 1 / lvl 4 ⇒ ON 色（与
//         hud_event_layer.md §8 V1 的期望一致）。
//
// 时序：地址**组合**给出（与 i_px_x/i_px_y 同拍）⇒ 外部 BRAM 1 拍后给出数据
//       ⇒ 本模块把 i_px_de 延迟 1 拍与颜色同拍（§4 B5/B6，§9.1）。
//       颜色译码对 BRAM 输出是**组合**的（不再加寄存器），否则会多出 1 拍、
//       整个事件画面右移一列。
//
// 背景 = 黑且**不透明**（§9.2）：事件画面模式下不会看到原始画面。
// ============================================================================
module event_render (
    input  wire        clk_lcd,
    input  wire        rst_n_lcd,
    input  wire [10:0] i_px_x,        // 扫描 X（来自 lcd_scanout）
    input  wire [10:0] i_px_y,        // 扫描 Y
    input  wire        i_px_de,       // 坐标有效
    output wire [15:0] o_bmp_rd_addr, // 位图 B 口读地址（组合）
    input  wire [7:0]  i_bmp_rd_data, // 位图 B 口数据（1 拍延迟）
    output wire        o_de,          // 输出 DE（延迟 1 拍）
    output wire [15:0] o_data         // 事件画面 RGB565
);

    parameter [10:0] EV_W   = 11'd400;      // 事件分辨率
    parameter [10:0] EV_H   = 11'd240;
    parameter [1:0]  SCALE  = 2'd2;         // 上屏放大（400->800、240->480）

    parameter [15:0] BG_COLOR     = 16'h0000;   // 背景（黑，不透明）
    parameter [15:0] COLOR_ON     = 16'hF800;   // ON 红
    parameter [15:0] COLOR_OFF    = 16'h001F;   // OFF 蓝
    parameter [15:0] COLOR_DECAY0 = 16'h9000;   // ON 余晖（暗红）
    parameter [15:0] COLOR_DECAY1 = 16'h0010;   // OFF 余晖（暗蓝）
    parameter [15:0] COLOR_DECAY2 = 16'h4208;   // 最弱余晖（灰）

    parameter [2:0]  LVL_FRESH = 3'd4;      // lvl >= 4 视为「新事件」
    parameter [2:0]  LVL_MID   = 3'd2;      // lvl >= 2 视为「中等余晖」

    localparam [15:0] WORDS_PER_ROW = EV_W / 2;      // 200 字/行（2 px/字）

    // ---- B1 坐标降采样（×2 放大 = 丢低位）---------------------------------
    wire [9:0] ex  = i_px_x[10:1];     // 0..399
    wire [8:0] ey  = i_px_y[9:1];      // 0..239
    wire       sel = ex[0];            // 字内高低 4 bit

    // ---- B2 地址生成（组合）------------------------------------------------
    assign o_bmp_rd_addr = ey * WORDS_PER_ROW + {7'd0, ex[9:1]};

    // ★ 1 拍读延迟的对齐：地址是**组合**给出的（外部 BRAM 在下一拍给出数据），
    //   所以"字内高低 4bit"的选择位 sel 也必须**跟着延迟 1 拍**，
    //   否则会用到下一像素的 ex[0]（TB 实测：整幅图错位 1 个 event 像素）。
    reg sel_d1;
    always @(posedge clk_lcd) begin
        if (!rst_n_lcd) sel_d1 <= 1'b0;
        else            sel_d1 <= sel;
    end

    // ---- B4 状态译码（4bit -> 颜色，零 BRAM）-------------------------------
    wire [3:0] st = sel_d1 ? i_bmp_rd_data[7:4] : i_bmp_rd_data[3:0];

    reg [15:0] col_c;
    always @(*) begin
        if (st[2:0] == 3'd0)                col_c = BG_COLOR;                       // 无事件
        else if (st[2:0] >= LVL_FRESH)      col_c = st[3] ? COLOR_ON  : COLOR_OFF;  // 新事件
        else if (st[2:0] >= LVL_MID)        col_c = st[3] ? COLOR_DECAY0 : COLOR_DECAY1;
        else                                col_c = COLOR_DECAY2;                   // 最弱余晖
    end

    assign o_data = col_c;

    // ---- B5 延迟对齐：de 延迟 1 拍（= BRAM 读延迟）--------------------------
    reg de_r;
    always @(posedge clk_lcd) begin
        if (!rst_n_lcd) de_r <= 1'b0;
        else            de_r <= i_px_de;
    end

    assign o_de = de_r;

endmodule

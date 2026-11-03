// ============================================================================
// disp_mux.v -- KEY0 显示源选择（原始摄像头画面 ↔ 事件画面）
//
// 规格来源：docs/子模块设计/L2_显示/disp_mux.md（§2 端口 / §3 参数 / §4 结构 / §8 判据）
//
// 语义：
//   cfg_disp_mode = 0 -> 输出 A 路（原始画面，DDR3 读口）
//   cfg_disp_mode = 1 -> 输出 B 路（事件画面，event_render）
//
// 帧边界同步切换（SYNC_SWITCH=1，默认）：
//   两路都是 800x480/clk_lcd/DE 使能的同拍流水线，本模块**不引入额外相位差**；
//   帧边界由「de 上升沿计数 + 每帧 V_VALID 行」判定：
//     * 每个 de 上升沿 row_cnt+1
//     * de 下降沿时若 row_cnt >= V_VALID ⇒ 该下降沿就是「一帧的最后一行结束」⇒ frame_end
//   模式在 frame_end（垂直消隐期内）锁存 ⇒ 屏幕上永远不会出现半帧拼接。
//   注：disp_mux.md §2 端口表里没有 vsync/坐标输入，故边界只能由 de 自行判定，
//       为此新增参数 V_VALID（默认 480）——已在报告里列为偏离。
//
// PIPE：输出寄存级数（§3 默认 1），de 与 data 一起寄存，保持同拍。
// ============================================================================
module disp_mux (
    input  wire        clk_lcd,
    input  wire        rst_n_lcd,
    input  wire        cfg_disp_mode,  // KEY0（已过 CDC-2）：0 = 原始画面，1 = 事件画面
    input  wire        a_de,           // A 路（原始画面）
    input  wire [15:0] a_data,         // RGB565
    input  wire        b_de,           // B 路（事件画面）
    input  wire [15:0] b_data,         // RGB565
    output wire        o_de,
    output wire [15:0] o_data
);

    parameter        SYNC_SWITCH = 1;         // 1 = 只在帧边界切换；0 = 立即切换（调试）
    parameter        PIPE        = 1;         // 输出寄存级数 0~3
    parameter [9:0]  V_VALID     = 10'd480;   // 一帧的 de 行数（帧边界判定用）

    reg        de_d;
    reg [9:0]  row_cnt;
    reg        frame_end;
    reg        mode_r;

    wire de_in   = a_de | b_de;      // 边界检测用哪一路都行，取或更稳
    wire de_rise = de_in & ~de_d;
    wire de_fall = ~de_in & de_d;

    // ---- B1 帧边界检测 -----------------------------------------------------
    always @(posedge clk_lcd) begin
        if (!rst_n_lcd) de_d <= 1'b0;
        else            de_d <= de_in;
    end

    always @(posedge clk_lcd) begin
        if (!rst_n_lcd) begin
            row_cnt   <= 10'd0;
            frame_end <= 1'b0;
        end else begin
            frame_end <= 1'b0;
            if (de_rise) begin
                if (row_cnt < V_VALID) row_cnt <= row_cnt + 10'd1;
            end else if (de_fall) begin
                if (row_cnt >= V_VALID) begin   // 一帧结束，进入垂直消隐
                    frame_end <= 1'b1;
                    row_cnt   <= 10'd0;
                end
            end
        end
    end

    // ---- B2 模式锁存 -------------------------------------------------------
    always @(posedge clk_lcd) begin
        if (!rst_n_lcd)            mode_r <= 1'b0;
        else if (SYNC_SWITCH == 0) mode_r <= cfg_disp_mode;   // 立即切换（调试）
        else if (frame_end)        mode_r <= cfg_disp_mode;   // 帧边界切换
    end

    // ---- B3/B4/B5 两路对齐（同拍）+ 输出选择 + 输出寄存 ---------------------
    generate
        if (PIPE == 0) begin : g_p0
            assign o_de   = mode_r ? b_de   : a_de;
            assign o_data = mode_r ? b_data : a_data;
        end else begin : g_pN
            reg [PIPE-1:0]    de_p;
            reg [16*PIPE-1:0] data_p;
            always @(posedge clk_lcd) begin
                if (!rst_n_lcd) begin
                    de_p   <= {PIPE{1'b0}};
                    data_p <= {(16*PIPE){1'b0}};
                end else begin
                    // 位宽 +1 赋给 PIPE 位寄存器 ⇒ 左移一位
                    de_p   <= {de_p,   (mode_r ? b_de   : a_de)};
                    data_p <= {data_p, (mode_r ? b_data : a_data)};
                end
            end
            assign o_de   = de_p[PIPE-1];
            assign o_data = data_p[16*PIPE-1 -: 16];
        end
    endgenerate

endmodule

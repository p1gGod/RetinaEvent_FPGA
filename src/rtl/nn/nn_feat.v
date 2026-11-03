//==============================================================================
// nn_feat —— 事件累积 + K+1 bank 轮转帧特征（单时钟 clk_cam，M3-fix v2）
//
// 【职责】把 clk_cam 域的 retina 事件流按 WIN_CYC（一个时间片的长度）累积成
//   GRID_W x GRID_H 网格的 2 通道（ON/OFF）NN_CNT_W bit 饱和计数，每个时间片
//   边界把当前累积的"当前片"内容拷进 NN_BANKS 个 bank 之一（frz_mem），供
//   引擎读（M3-fix 起引擎也跑 clk_cam，全设计单时钟）；bank 轮转保证引擎读的
//   最近 K 个时间片不会被覆盖。
//   所有形状量（GRID_W/H、CELLS、BANKS、BANK_DEPTH、计数位宽）都来自
//   nn_cfg.vh，本模块不含这些字面量 —— M2b 改 K_TIME_BINS 不需要改这里。
//
// 【冻结契约（见 nn_cfg.vh）】
//   · cell = (y>>GRID_SHIFT)*GRID_W + (x>>GRID_SHIFT) ∈ [0,CELLS)；事件
//     x∈[0,IMG_W)、y∈[0,IMG_H)、pol 1=ON。
//   · 帧存储 addr = bank*BANK_DEPTH + pol'*CELLS + cell，其中 pol'=0 表示
//     ON(port pol=1)、pol'=1 表示 OFF(port pol=0) —— 即
//     addr_cell = (port_pol ? 0 : CELLS) + cell。
//   · 计数 NN_CNT_W bit 饱和（RMW 时 min(count+1,CNT_MAX)）；引擎侧读口再量化
//     q = min(Q_MAX,count)。
//   · K = K_TIME_BINS 个时间片由 nn_engine 按 bank 号取（ch(2i+pol) = bin(now-i)），
//     本模块只负责"每个片边界冻结一个 bank"，与 K 无关。
//   · 每窗边界：排空旧窗事件 -> 把 cur 拷到 bank -> 清 cur -> 发 o_win_end/o_win_bank
//     -> bank 轮转。o_win_tog 在拷贝完成（bank 内容完整）之后才翻。
//
// 【结构 / 关键坑位备忘】
//   · cur_mem：3000x8 单读口+单写口（简单双口），in-place 累加。读口是**寄存读**
//     （地址打一拍、次拍数据），所以 RMW 必须 3 拍：issue -> wait -> write。
//     ★ 坑：只留 2 拍（issue->write）会读到"上一个事件地址"的旧数据，
//       表现为第二个事件起计数全错（已实测踩过）。
//   · FIFO：512x13 = {gen, addr_cell}，吸收事件突发并解决"窗口边界期间到达的
//     事件归属"：边界翻转 adm_gen 后先进 FIFO，拷贝完成后再排进新窗口，
//     所以关窗过程（约 3000 拍）里的事件也不丢（除 FIFO 满）。
//     边界只排空 gen==旧值 的条目；FIFO 是顺序结构，旧条目一定在新条目之前。
//   · 拷贝 3001 拍：cnt=0 先发地址 0（数据下拍才到），cnt>=1 每拍用 cur_rdata_i
//     （= mem[cnt-1]）写 frz[base+cnt-1] 并清 cur[cnt-1]；地址错开一拍，
//     绝不同地址同拍读写。frz 写 3000 + 清 cur 3000 与读 cur 并行。
//   · frz_mem 读口与写口同在 clk_cam（简单双口 RAM）：引擎只读已经冻结完的 bank，
//     而拷贝写的是下一个窗口要用的那个 bank（不是 now/prev），读写地址不会撞。
//   · WIN_CYC 必须大于一次冻结开销（≈ 3*FIFO_DEPTH + 3001），否则窗口会丢；
//     TB_FEAT 用 8000，TB_TOP 用 70000，产品值 5,000,000。
//
// 【M3c：外部统一窗沿模式（USE_EXT_TICK=1）】
//   nn_top 用**一根** win_tick 同时驱动 nn_feat 的窗口切换与 nn_winstat 的
//   i_win_tick；本模块不再自己数窗（win_cnt 停用），改由 i_win_tick 置 bnd_req。
//   事件此时来自 nn_winstat 的平移后网格（比原始事件晚 2 拍，窗沿计算期更可
//   能积压到窗沿之后），因此每拍事件的窗口归属由 i_ev_par（= nn_winstat 的
//   窗口 epoch）携带，而不是本模块的 adm_gen；边界后先进 ST_FLUSH 等
//   EXT_FLUSH_CYC 拍，让携带旧 epoch 的在途事件全部落地，再排空旧窗条目。
//   效果：平移后网格与原逻辑（USE_EXT_TICK=0 + 原始坐标）在 shift=0 时逐格
//   相同，且窗沿附近的在途事件归属与训练侧时间戳窗口一致（不串窗）。
//   ★ 代价：o_win_end 比旧设计晚 EXT_FLUSH_CYC 拍（默认 200，窗长 5e6 拍）。
//==============================================================================
`timescale 1ns / 1ps
`include "nn_cfg.vh"

module nn_feat #(
    // ---- clk_cam 域：事件输入 + 窗口输出 ----
    parameter WIN_CYC = `NN_WIN_CYC,
    // ---- M3c：外部窗沿模式 ----
    //   USE_EXT_TICK=0（默认，tb_nn_feat 用的旧行为）：内部 win_cnt 产生边界；
    //   USE_EXT_TICK=1：窗口沿由 nn_top 的 win_tick 统一给出（同时喂 nn_winstat），
    //     事件带 i_ev_par 窗口标签；边界后先等 EXT_FLUSH_CYC 拍让在途事件落地。
    parameter USE_EXT_TICK  = 0,
    parameter integer EXT_FLUSH_CYC = `NN_EXT_FLUSH_CYC
)(
    input  wire        clk_cam,
    input  wire        rst_n_cam,
    input  wire        i_ev_valid,
    input  wire [8:0]  i_ev_x,
    input  wire [7:0]  i_ev_y,
    input  wire        i_ev_pol,
    output reg         o_ready        , // 复位清零完成后拉高（窗口计数才开始）
    output reg  [`NN_BANK_AW-1:0] o_win_bank, // 刚冻结完成的 bin 号[0,BANKS)
    output reg         o_win_tog      , // 每个窗口翻转一次（bank 内容已完整）
    output reg         o_win_end      , // 单拍脉冲：窗口冻结完成
    output reg  [15:0] o_dbg_drop     , // 丢弃事件计数（越界 / FIFO 满）

    // ---- 引擎特征读口（同一 clk_cam 域，1 拍寄存读，q=min(Q_MAX,count)）----
    input  wire [`NN_FRZ_AW-1:0]  i_rd_addr,
    output wire [`NN_CNT_W-1:0]   o_rd_q,

    // ---- M3c：统一窗沿（USE_EXT_TICK=1 时使用；=0 时该两端口被忽略）----
    input  wire        i_win_tick,          // 单拍：nn_top 统一的窗口沿（与 nn_winstat 同一根线）
    input  wire        i_ev_par              // 事件所属窗口的 epoch（= nn_winstat.o_grid_par）
);

    //--------------------------------------------------------------------------
    // 常量 / 状态
    //--------------------------------------------------------------------------
    localparam [2:0] ST_CLEAR = 3'd0,   // 上电清零 frz(9000) + cur(3000)
                     ST_RUN   = 3'd1,   // 正常累积（同时排空 FIFO）
                     ST_RD    = 3'd2,   // RMW：地址已发，等 rdata 有效
                     ST_WR    = 3'd3,   // RMW：写回（读到的是本事件地址的数据）
                     ST_DR_ISS= 3'd4,   // 窗口边界：排空旧窗条目 / 转入拷贝
                     ST_COPY  = 3'd5,   // cur -> frz[bank]
                     ST_FRZ   = 3'd6,   // 发窗口事件 + bank 轮转
                     ST_FLUSH = 3'd7;   // 外部窗沿模式：等上一窗在途事件落地（M3c）

    //--------------------------------------------------------------------------
    // 由 nn_cfg.vh 的形状量推导的位宽（本模块不写死 1500/3000/9000/50/30）
    //--------------------------------------------------------------------------
    localparam integer CCLR_AW = $clog2(`NN_FRZ_DEPTH + 1);    // 上电清零计数
    localparam integer CCOPY_AW= $clog2(`NN_BANK_DEPTH + 1);   // 拷贝计数
    localparam integer FIFO_DW = `NN_CELL_AW + 1 + 1;           // {gen, addr_cell}
    localparam integer FCNT_AW = $clog2(`NN_FIFO_DEPTH + 1);
    localparam integer WC_AW   = 24;                            // 窗口计数（WIN_CYC<2^24）
    localparam integer FLUSH_AW= $clog2(EXT_FLUSH_CYC + 1);     // 在途事件等待计数

    //--------------------------------------------------------------------------
    // 存储
    //--------------------------------------------------------------------------
    reg [`NN_CNT_W-1:0] cur_mem [0:`NN_BANK_DEPTH-1];   // 当前 bin 累积（clk_cam）
    reg [`NN_CNT_W-1:0] frz_mem [0:`NN_FRZ_DEPTH-1];    // BANKS 个冻结 bin，clk_cam 读本

    reg [`NN_CNT_W-1:0] frz_q;                       // 读口数据（1 拍延迟）
    reg [`NN_CNT_W-1:0] cur_rdata_i;                 // cur_mem 读数据（1 拍延迟）

    // 事件 FIFO：{gen, addr_cell}
    // 事件 FIFO 的读口是组合读（head 当场比较 gen / 取地址），BRAM 无法推断，
    // 保持 LUTRAM（512x13 只占 ~104 个 LUT）；frz/cur 两块特征存储是寄存读、
    // 强制走 BRAM。
    reg [FIFO_DW-1:0]  fifo_mem [0:`NN_FIFO_DEPTH-1];
    reg [`NN_FIFO_AW-1:0] fifo_wr, fifo_rd;
    reg [FCNT_AW-1:0]  fifo_cnt;

    //--------------------------------------------------------------------------
    // 状态寄存器
    //--------------------------------------------------------------------------
    reg [2:0]  state;
    reg [CCLR_AW-1:0] clr_cnt;              // 上电清零计数
    reg [WC_AW-1:0]   win_cnt;              // 时间片内 clk_cam 计数（仅 USE_EXT_TICK=0）
    reg [FLUSH_AW-1:0] flush_cnt;           // 外部窗沿后等待在途事件的拍数（仅 USE_EXT_TICK=1）
    reg        bnd_req;                     // 时间片边界请求
    reg [`NN_BANK_AW-1:0] bank_wr;           // 当前 bin 要写入的 bank
    reg        adm_gen;                     // 当前 bin 事件的 gen 标记
    reg        old_gen;                     // 关窗时旧 gen 的快照
    reg        dr_mode;                     // 1 = 当前 RMW 属于关窗排空

    reg [`NN_BANK_DEPTH_AW-1:0] cur_raddr;    // cur 读地址
    reg [CCOPY_AW-1:0]          copy_cnt;     // 拷贝计数 0..BANK_DEPTH
    reg [`NN_FRZ_AW-1:0]        bank_base;    // bank_wr * BANK_DEPTH

    //--------------------------------------------------------------------------
    // 组合：事件坐标 -> cell / addr_cell
    //--------------------------------------------------------------------------
    // cell = gy*GRID_W + gx（常量乘法由综合折成移位加法；GRID_W 不是 2 的幂）
    wire [`NN_CELL_AW-1:0] cell_w = (i_ev_y >> `NN_GRID_SHIFT) * `NN_GRID_W
                                   + (i_ev_x >> `NN_GRID_SHIFT);
    wire [`NN_BANK_DEPTH_AW-1:0] addr_w = (i_ev_pol ? {`NN_BANK_DEPTH_AW{1'b0}} : `NN_CELLS)
                                        + cell_w;

    wire ev_ok    = i_ev_valid && (i_ev_x <= `NN_IMG_W - 1) && (i_ev_y <= `NN_IMG_H - 1)
                    && (fifo_cnt != `NN_FIFO_DEPTH);
    wire ev_push  = ev_ok;                  // 任何非清零状态都收（FIFO 兜底）
    wire ev_drop  = i_ev_valid && !ev_push;

    //--------------------------------------------------------------------------
    // RAM 写口（纯组合，取自状态机）：每个 RAM **只有一条写语句/一个写口**
    // ★ Vivado 两条硬规则（都实测踩过，frz_mem 72000 bit 太大无法 dissolve 成
    //   寄存器，直接报 [Synth 8-3391] 综合失败）：
    //   ① 带异步复位的 always 块里写数组 → "RAM is sensitive to asynchronous reset"；
    //   ② 同一个 always 块里对同一数组写多条语句 → "multiple writes via different
    //      ports in same process"。所以：数组写入放在**无复位**块里，且每个数组
    //      只写一条，地址/数据/使能在组合块里先 mux 好。
    //--------------------------------------------------------------------------
    wire rmw_we   = (state == ST_WR);
    wire copy_we  = (state == ST_COPY) && (copy_cnt >= {{(CCOPY_AW-1){1'b0}},1'b1});
    wire clr_we   = (state == ST_CLEAR) && (clr_cnt < `NN_FRZ_DEPTH);
    wire clr_cwe  = (state == ST_CLEAR) && (clr_cnt < `NN_BANK_DEPTH);

    reg        fifo_we;    reg [`NN_FIFO_AW-1:0]        fifo_waddr;
                           reg [FIFO_DW-1:0]            fifo_wdata;
    reg        frz_we;     reg [`NN_FRZ_AW-1:0]          frz_waddr;
                           reg [`NN_CNT_W-1:0]           frz_wdata;
    reg        cur_we;     reg [`NN_BANK_DEPTH_AW-1:0]   cur_waddr;
                           reg [`NN_CNT_W-1:0]           cur_wdata;

    always @(*) begin
        // ---- 事件 FIFO ----
        fifo_we    = ev_push;
        fifo_waddr = fifo_wr;
        // 外部窗沿模式：窗口标签由 nn_winstat 随事件带来（事件经其 FIFO 后到达
        // 本模块时可能已过窗沿，不能再用「到达时刻」的 adm_gen 判归属）
        fifo_wdata = {(USE_EXT_TICK ? i_ev_par : adm_gen), addr_w};

        // ---- 冻结帧：清零优先，其次窗口拷贝 ----
        frz_we = 1'b1;
        if (clr_we) begin
            frz_waddr = clr_cnt[`NN_FRZ_AW-1:0];
            frz_wdata = {`NN_CNT_W{1'b0}};
        end else if (copy_we) begin
            frz_waddr = bank_base + copy_cnt - 1'b1;
            frz_wdata = cur_rdata_i;
        end else begin
            frz_we    = 1'b0;
            frz_waddr = {`NN_FRZ_AW{1'b0}};
            frz_wdata = {`NN_CNT_W{1'b0}};
        end

        // ---- 当前 bin：清零 / RMW 累加 / 拷贝后清零 ----
        cur_we = 1'b1;
        if (clr_cwe) begin
            cur_waddr = clr_cnt[`NN_BANK_DEPTH_AW-1:0];
            cur_wdata = {`NN_CNT_W{1'b0}};
        end else if (rmw_we) begin
            cur_waddr = cur_raddr;
            cur_wdata = (cur_rdata_i >= `NN_CNT_MAX) ? `NN_CNT_MAX
                                                    : (cur_rdata_i + 1'b1);
        end else if (copy_we) begin
            cur_waddr = copy_cnt[`NN_BANK_DEPTH_AW-1:0] - 1'b1;
            cur_wdata = {`NN_CNT_W{1'b0}};
        end else begin
            cur_we    = 1'b0;
            cur_waddr = {`NN_BANK_DEPTH_AW{1'b0}};
            cur_wdata = {`NN_CNT_W{1'b0}};
        end
    end

    // bank_wr -> 基址：bank * BANK_DEPTH（常量乘法，综合折成移位加法）
    function [`NN_FRZ_AW-1:0] bank_base_of;
        input [`NN_BANK_AW-1:0] b;
        begin
            bank_base_of = b * `NN_BANK_DEPTH;
        end
    endfunction

    //--------------------------------------------------------------------------
    // clk_cam：状态机 + cur 读写 + FIFO + 窗口事件
    // ★ 复位必须用同步复位：本块的状态/计数器组合驱动 cur_mem/frz_mem/fifo_mem 的
    //   地址/数据/写使能脚，Vivado 对「带异步复位的寄存器驱动 RAMB 控制脚」会报
    //   DRC REQP-1839（RAMB36 async control check），实测 v1 在 cur_mem 上触发 20 条。
    //--------------------------------------------------------------------------
    always @(posedge clk_cam) begin
        if (!rst_n_cam) begin
            state      <= ST_CLEAR;
            clr_cnt    <= {CCLR_AW{1'b0}};
            win_cnt    <= {WC_AW{1'b0}};
            flush_cnt  <= {FLUSH_AW{1'b0}};
            bnd_req    <= 1'b0;
            bank_wr    <= {`NN_BANK_AW{1'b0}};
            adm_gen    <= 1'b0;
            old_gen    <= 1'b0;
            dr_mode    <= 1'b0;
            o_ready    <= 1'b0;
            o_win_bank <= {`NN_BANK_AW{1'b0}};
            o_win_tog  <= 1'b0;
            o_win_end  <= 1'b0;
            o_dbg_drop <= 16'd0;
            fifo_wr    <= {`NN_FIFO_AW{1'b0}};
            fifo_rd    <= {`NN_FIFO_AW{1'b0}};
            fifo_cnt   <= {FCNT_AW{1'b0}};
            cur_raddr  <= {`NN_BANK_DEPTH_AW{1'b0}};
            copy_cnt   <= {CCOPY_AW{1'b0}};
            bank_base  <= {`NN_FRZ_AW{1'b0}};
        end else begin
            o_win_end <= 1'b0;                  // 默认单拍

            // ---------------- 窗口计时 + 边界请求 ----------------
            // USE_EXT_TICK=1：不看内部计数，直接用 nn_top 的统一窗口沿；bnd_req 锁存，
            //   状态机不在 ST_RUN 时延后到下一个 ST_RUN 处理（窗口长 5M 拍，不会丢窗）
            if (state != ST_CLEAR) begin
                if (USE_EXT_TICK) begin
                    if (i_win_tick) bnd_req <= 1'b1;
                end else begin
                    if (win_cnt == WIN_CYC[WC_AW-1:0] - 1'b1) begin
                        win_cnt <= {WC_AW{1'b0}};
                        if (state == ST_RUN) bnd_req <= 1'b1;
                    end else begin
                        win_cnt <= win_cnt + 1'b1;
                    end
                end
            end

            // ---------------- 事件入 FIFO（任何状态都收）----------------
            if (ev_push) begin
                fifo_wr <= fifo_wr + 1'b1;
            end else if (ev_drop) begin
                o_dbg_drop <= o_dbg_drop + 16'd1;
            end

            // FIFO 计数：push（任何状态）与 pop（ST_WR）可能同拍，
            // ★ 必须合成一次加减；分开写两条非阻塞赋值会让后者覆盖前者（实测踩过）
            fifo_cnt <= fifo_cnt + (ev_push ? {{(FCNT_AW-1){1'b0}},1'b1} : {FCNT_AW{1'b0}})
                                 - ((state == ST_WR) ? {{(FCNT_AW-1){1'b0}},1'b1}
                                                     : {FCNT_AW{1'b0}});

            // ---------------- 主状态机 ----------------
            case (state)
            // 上电：并行清 frz 9000 与 cur 3000，共 9001 拍
            ST_CLEAR: begin
                if (clr_cnt == `NN_FRZ_DEPTH) begin
                    clr_cnt <= {CCLR_AW{1'b0}};
                    win_cnt <= {WC_AW{1'b0}};
                    o_ready <= 1'b1;
                    state   <= ST_RUN;
                end else begin
                    clr_cnt <= clr_cnt + 1'b1;
                end
            end

            // 正常窗口：优先关窗，其次排空 FIFO 做 RMW
            ST_RUN: begin
                if (bnd_req) begin
                    old_gen <= adm_gen;
                    adm_gen <= ~adm_gen;        // 之后到达的事件记到新窗口
                    bnd_req <= 1'b0;
                    flush_cnt <= {FLUSH_AW{1'b0}};
                    state   <= USE_EXT_TICK ? ST_FLUSH : ST_DR_ISS;
                end else if (fifo_cnt != {FCNT_AW{1'b0}}) begin
                    cur_raddr <= fifo_mem[fifo_rd][`NN_CELL_AW+1-1:0];
                    dr_mode   <= 1'b0;
                    state     <= ST_RD;
                end
            end

            // RMW 等待拍：地址在上一个周期发出，本拍的 cur_rdata_i 仍是旧值
            ST_RD: begin
                state <= ST_WR;
            end

            // RMW 写拍：此时 cur_rdata_i = mem[cur_raddr]（寄存读 1 拍）
            ST_WR: begin
                fifo_rd  <= fifo_rd + 9'd1;
                state    <= dr_mode ? ST_DR_ISS : ST_RUN;
            end

            // 外部窗沿：窗沿后等 EXT_FLUSH_CYC 拍，让「携带旧 epoch 的在途网格事件」
            // 全部进 FIFO（nn_winstat 2 拍流水 + 窗沿除法 52 拍 + 队列 64）。
            // 期间到达的新窗事件带新 epoch，排在旧条目之后，不影响本次排空。
            ST_FLUSH: begin
                if (flush_cnt == EXT_FLUSH_CYC - 1) begin
                    flush_cnt <= {FLUSH_AW{1'b0}};
                    state     <= ST_DR_ISS;
                end else begin
                    flush_cnt <= flush_cnt + 1'b1;
                end
            end

            // 关窗：排空旧 gen 条目（FIFO 顺序保证旧条目都在头部）
            ST_DR_ISS: begin
                if ((fifo_cnt != {FCNT_AW{1'b0}}) && (fifo_mem[fifo_rd][FIFO_DW-1] == old_gen)) begin
                    cur_raddr <= fifo_mem[fifo_rd][`NN_CELL_AW+1-1:0];
                    dr_mode   <= 1'b1;
                    state     <= ST_RD;
                end else begin
                    cur_raddr <= {`NN_BANK_DEPTH_AW{1'b0}};
                    copy_cnt  <= {CCOPY_AW{1'b0}};
                    bank_base <= bank_base_of(bank_wr);
                    state     <= ST_COPY;
                end
            end

            // 拷贝：3001 拍；cnt>=1 时 cur_rdata_i = mem[cnt-1]
            ST_COPY: begin
                if (copy_cnt == `NN_BANK_DEPTH) begin
                    state <= ST_FRZ;
                end else begin
                    cur_raddr <= (copy_cnt == `NN_BANK_DEPTH - 1)
                                 ? copy_cnt : (copy_cnt + 1'b1);
                    copy_cnt  <= copy_cnt + 1'b1;
                end
            end

            // 冻结完成：announce bank（内容已完整），轮转
            ST_FRZ: begin
                o_win_bank <= bank_wr;
                o_win_tog  <= ~o_win_tog;
                o_win_end  <= 1'b1;
                bank_wr    <= (bank_wr == `NN_BANKS - 1) ? {`NN_BANK_AW{1'b0}}
                                                        : (bank_wr + 1'b1);
                state      <= ST_RUN;
            end

            default: state <= ST_CLEAR;
            endcase
        end
    end

    //--------------------------------------------------------------------------
    // 三个 RAM 的写口（clk_cam，**无异步复位** —— 依据见 RAM 写口使能处的说明）
    //   fifo_mem : 事件 FIFO
    //   frz_mem  : 冻结帧（3 bank x (ON 1500 + OFF 1500)）
    //   cur_mem  : 当前窗累积
    //--------------------------------------------------------------------------
    always @(posedge clk_cam) begin
        if (fifo_we) fifo_mem[fifo_waddr] <= fifo_wdata;
        if (frz_we)  frz_mem[frz_waddr]   <= frz_wdata;
        if (cur_we)  cur_mem[cur_waddr]   <= cur_wdata;
    end

    //--------------------------------------------------------------------------
    // cur_mem 读口（clk_cam 同域：地址寄存 -> 次拍数据）
    //--------------------------------------------------------------------------
    always @(posedge clk_cam) begin
        cur_rdata_i <= cur_mem[cur_raddr[11:0]];
    end

    //--------------------------------------------------------------------------
    // frz_mem 读口（clk_cam，1 拍延迟；q = min(127,count)）
    //--------------------------------------------------------------------------
    // ★ 读口寄存器只能用**同步**复位：Vivado 无法把异步复位的读寄存器吸收进
    //   BRAM 的输出寄存器，会退化成 "memory pattern not supported" 综合错误
    //   （实测踩过：frz_mem_reg 8x9000 推断失败）。同步复位可正常推断为 BRAM。
    always @(posedge clk_cam) begin
        if (!rst_n_cam) frz_q <= {`NN_CNT_W{1'b0}};
        else            frz_q <= frz_mem[i_rd_addr];
    end
    assign o_rd_q = (frz_q > `NN_Q_MAX) ? `NN_Q_MAX : frz_q;

endmodule

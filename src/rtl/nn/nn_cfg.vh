//==============================================================================
// nn_cfg.vh —— M3 动作识别 int8 CNN（P1 网络）全局配置 / 冻结契约参数源
//
// 【地位】本文件是 M3 冻结契约的唯一参数源：特征网格、窗口/决策时序、P1 各层
//   尺寸、ROM 地址布局全部在这里定义一次；nn_feat / nn_engine / nn_decide /
//   nn_top 一律 `include 本文件，模块里不得再硬编码这些数字。
//
// 【冻结契约（任务书 task-6 照抄，禁止改数）】
//   · 事件源 clk_cam 50 MHz：ev_valid 单拍脉冲、ev_x[8:0]∈[0,400)、
//     ev_y[7:0]∈[0,240)、ev_pol 1=ON。
//   · 特征网格 GRID_SHIFT=3 ⇒ GW=50、GH=30（cell=8x8 像素，x>>3、y>>3）。
//   · 滑窗 WIN_CYC=5,000,000 个 clk_cam 周期（=100 ms）。
//   · 通道顺序固定 [ch0=ON_now, ch1=OFF_now, ch2=ON_prev, ch3=OFF_prev]。
//   · 计数饱和 8 bit，量化 q=min(127,count)（SHIFT_N=0，不右移）。
//   · 引擎 200 MHz、单 MAC/cycle，输出顺序 (och,oy,ox)。
//   · 决策：每窗 argmax(3)+margin，class≠0 且 margin≥MARGIN_MIN 记命中；
//     连续 N=3 窗同类别才锁存 pulse；锁存后 REFRACTORY_CYC 内不再上报。
//
// 【坑位备忘】
//   · 通道顺序：M0 文档 3.2 节写成 [ON_prev,OFF_prev,ON_now,OFF_now]，与任务书
//     [ON_now,OFF_now,ON_prev,OFF_prev] 不一致；以任务书为准（训练侧 M2 必须对齐）。
//   · 权重 ROM 地址布局见第 5 节，nn_rom_data.v 由 tool/nn_gen_placeholder.py
//     生成（5718 字，禁止手写）。
//==============================================================================
`ifndef NN_CFG_VH
`define NN_CFG_VH

//------------------------------------------------------------------------------
// 1. 输入形状参数（★ M2b 唯一要动的就是这一节；RTL 里不得出现这些字面量）
//
//   契约演化（2026-10-29 Lead 消息）：M0 原契约固定「2 帧切片 × 2 极性 = 4 通道」，
//   跨会话评估发现 class2 可辨识性不足，M2b 正在做「K 个时间片 × 2 极性」的对照
//   实验（K=4~8）。所以这里把**所有影响输入形状的量**全部参数化：
//
//     · K_TIME_BINS = 时间片(bin)个数；每片时长 = WIN_CYC（见第 2 节）
//       ⇒ 网络看到的总时长 = K * WIN_CYC（K=4~8 时是 400~800 ms，与 M2b 描述一致）
//     · IN_CH = 2*K = conv1 输入通道数，通道顺序（M3 冻结，K=2 时逐位等于原契约）：
//         ch(2*i + 0) = ON  of bin(now - i)   [i=0 最新]
//         ch(2*i + 1) = OFF of bin(now - i)
//       即 K=2 时 [ch0=ON_now, ch1=OFF_now, ch2=ON_prev, ch3=OFF_prev]（不变）
//     · BANKS = K+1：K 个已冻结 bin + 1 个正在累积的 bin（nn_feat 轮转写入）
//     · 若将来想把"总时长固定、每片更短"（例如总 400 ms、K=4 ⇒ 每片 100 ms），
//       只需设 WIN_CYC = 总时长/K（一行配置）；RTL 不需要改。
//
//   存储布局（nn_feat.frz_mem，BANKS*BANK_DEPTH 个字）：
//      addr = bank*BANK_DEPTH + pol*CELLS + cell ，bank ∈ [0,BANKS) 轮转
//      pol: 0=ON, 1=OFF
//    cell = (y>>GRID_SHIFT)*GRID_W + (x>>GRID_SHIFT) ∈ [0,CELLS)
//------------------------------------------------------------------------------
`define NN_IMG_W           400                       // 事件 x 范围 [0,IMG_W)
`define NN_IMG_H           240                       // 事件 y 范围 [0,IMG_H)
`define NN_GRID_SHIFT      3                         // cell = 8x8 像素
`define NN_GRID_W          (`NN_IMG_W >> `NN_GRID_SHIFT)   // 50
`define NN_GRID_H          (`NN_IMG_H >> `NN_GRID_SHIFT)   // 30
`define NN_GW              `NN_GRID_W                // 兼容旧名
`define NN_GH              `NN_GRID_H                // 兼容旧名
`define NN_CELLS           (`NN_GRID_W * `NN_GRID_H)      // 1500

`define NN_POLN            2                         // 极性通道数（ON/OFF）
`define NN_K_TIME_BINS     2                         // ★ 时间片个数（M2b: 4~8）
`define NN_IN_CH           (`NN_K_TIME_BINS * `NN_POLN)   // = 2K，conv1 输入通道
`define NN_BANKS           (`NN_K_TIME_BINS + 1)          // K 冻结 bin + 1 累积 bin

`define NN_BANK_DEPTH      (`NN_POLN * `NN_CELLS)       // 3000（1 个 bin 的 ON+OFF）
`define NN_FRZ_DEPTH       (`NN_BANKS * `NN_BANK_DEPTH)  // 9000
`define NN_FIFO_DEPTH      512                       // 事件 FIFO（边界冻结期间缓冲）
`define NN_FIFO_AW         9

// 特征计数累积位宽（饱和计数；量化 q = min(Q_MAX,count)）
`define NN_CNT_W           8
`define NN_CNT_MAX         ((1 << `NN_CNT_W) - 1)      // 255
`define NN_Q_MAX           8'd127

// 地址位宽（由深度推导，避免 K 改大时静默截断）
`define NN_CELL_AW         $clog2(`NN_CELLS)           // 11
`define NN_BANK_DEPTH_AW   $clog2(`NN_BANK_DEPTH)      // 12
`define NN_BANK_AW         $clog2(`NN_BANKS)           // K=2 -> 2
`define NN_FRZ_AW          $clog2(`NN_FRZ_DEPTH)       // K=2 -> 14
`define NN_ACT_DEPTH       4096                      // 引擎激活缓存深度

//------------------------------------------------------------------------------
// 2. 时间 / 决策参数（clk_cam 域）
//    WIN_CYC = **单个时间片(bin)** 的长度，同时是窗口边界/推理周期。
//    网络输入总时长 = K_TIME_BINS * WIN_CYC（默认 2*100 ms = 200 ms；
//    M2b 的 K=4~8 对应 400~800 ms，与其实验描述一致）。
//------------------------------------------------------------------------------
`define NN_WIN_CYC         32'd5000000     // 1 bin = 100 ms @50 MHz
`define NN_TOTAL_SPAN_CYC  (`NN_K_TIME_BINS * `NN_WIN_CYC)   // 网络输入总时长
`define NN_REFRACTORY_CYC  32'd75000000    // 1.5 s @50 MHz
`define NN_N_CONSEC        3               // 连续 3 窗同类别
`define NN_MARGIN_MIN      16              // 部署口径：依据 task-63 s100 门限扫描，见 nn/REPORT_v7b_部署口径重训.md；18 组里 16/3 对 8/3 全维占优（open 17/17、wave 1、static 0、empty 0 相同；hardneg 3->2，总 pulses 88->74）
`define NN_CONF_MAX        5'd31           // o_act_conf[4:0]
//
// 【类别语义（用户 2026-10-29 拍板，RTL 只做 argmax，不区分语义）】
//   class0 = 无动作（背景）；class1 = 手部开合（握拳<->张开，任一方向都算）；
//   class2 = 横向挥手。三类 logits 顺序即 class 顺序，训练侧 M2 必须一致。
//
// ★ 类别数是显式参数（M2b 若把 class2 降级/回退成两分类只需改这一行）:
//   NN_NUM_CLASSES = 3 -> M3 契约默认（三类）
//   NN_NUM_CLASSES = 2 -> 两分类（none / 手部开合）：fc 输出 2 个 logit，
//                          nn_decide 把第 3 路钉成 int8 最小值（class2 永不胜出）。
//   切换代价：改本宏 + 用 tool/nn_gen_placeholder.py 按 2 类重新生成 nn_rom_data.v。
`define NN_NUM_CLASSES     2

//------------------------------------------------------------------------------
// 3. P1 层规格（Conv 无 padding、stride=2，尺寸与训练侧 M2 逐字一致）
//    conv1: 4x30x50  -> 8x14x24   k=3 s=2  权重 8*4*9=288
//    conv2: 8x14x24  -> 16x6x11   k=3 s=2  权重 16*8*9=1152
//    conv3: 16x6x11  -> 24x2x5    k=3 s=2  权重 24*16*9=3456
//    fc   : 240      -> 3                  权重 720；conv 后 ReLU，fc 不 ReLU
//    尺寸自检：(30-3)/2+1=14 (50-3)/2+1=24 / (14-3)/2+1=6 (24-3)/2+1=11 /
//              (6-3)/2+1=2 (11-3)/2+1=5 / 24*2*5=240
//------------------------------------------------------------------------------
// 手工推导公式：HO=(H-3)/2+1、WO=(W-3)/2+1（无 padding、stride=2）
`define NN_CV_HO(h)  (((h) - 3) / 2 + 1)
`define NN_CV_WO(w)  (((w) - 3) / 2 + 1)
`define NN_CV_ROWSTEP(h,w,ho,wo) (2 * ((w) - (wo) + 1))

`define NN_L1_CIN   `NN_IN_CH           // ★ 输入通道 = 2K（K=2 -> 4）
`define NN_L1_H     `NN_GRID_H
`define NN_L1_W     `NN_GRID_W
`define NN_L1_COUT  8
`define NN_L1_HO    `NN_CV_HO(`NN_L1_H)                 // 14
`define NN_L1_WO    `NN_CV_WO(`NN_L1_W)                 // 24
`define NN_L1_T     (`NN_L1_CIN * 9)                    // 36 @K=2
`define NN_L1_HW    (`NN_L1_H * `NN_L1_W)               // 1500（激活内存通道步长）
`define NN_L1_OUTHW (`NN_L1_HO * `NN_L1_WO)             // 336
`define NN_L1_ROWSTEP `NN_CV_ROWSTEP(`NN_L1_H,`NN_L1_W,`NN_L1_HO,`NN_L1_WO)  // 54

`define NN_L2_CIN   `NN_L1_COUT
`define NN_L2_H     `NN_L1_HO
`define NN_L2_W     `NN_L1_WO
`define NN_L2_COUT  16
`define NN_L2_HO    `NN_CV_HO(`NN_L2_H)                 // 6
`define NN_L2_WO    `NN_CV_WO(`NN_L2_W)                 // 11
`define NN_L2_T     (`NN_L2_CIN * 9)                    // 72
`define NN_L2_HW    (`NN_L2_H * `NN_L2_W)               // 336
`define NN_L2_OUTHW (`NN_L2_HO * `NN_L2_WO)             // 66
`define NN_L2_ROWSTEP `NN_CV_ROWSTEP(`NN_L2_H,`NN_L2_W,`NN_L2_HO,`NN_L2_WO)  // 28

`define NN_L3_CIN   `NN_L2_COUT
`define NN_L3_H     `NN_L2_HO
`define NN_L3_W     `NN_L2_WO
`define NN_L3_COUT  24
`define NN_L3_HO    `NN_CV_HO(`NN_L3_H)                 // 2
`define NN_L3_WO    `NN_CV_WO(`NN_L3_W)                 // 5
`define NN_L3_T     (`NN_L3_CIN * 9)                    // 144
`define NN_L3_HW    (`NN_L3_H * `NN_L3_W)               // 66
`define NN_L3_OUTHW (`NN_L3_HO * `NN_L3_WO)             // 10
`define NN_L3_ROWSTEP `NN_CV_ROWSTEP(`NN_L3_H,`NN_L3_W,`NN_L3_HO,`NN_L3_WO)  // 14

//  ★ task-51（v7）：conv3 flatten 240 路 + g1 16 路 = 256 路 fc 输入。
//    g1 = 7 路全局量 -> 16 通道（每通道 per-channel SH，ReLU），输出写 bufC[240+ch]。
`define NN_G1_CIN   7                              // n_div16,prev_n_div16,pol_bal,dx,dy,dx_rel,dy_rel
`define NN_G1_COUT  16
`define NN_G1_T     `NN_G1_CIN                     // 点积 taps = 7（无空间维）
`define NN_FC_CONV_IN (`NN_L3_COUT * `NN_L3_OUTHW)   // 240（conv3 flatten，g1 段起始偏移）
`define NN_FC_CIN   (`NN_FC_CONV_IN + `NN_G1_COUT)  // 256 = 240 + 16
`define NN_FC_COUT  `NN_NUM_CLASSES                     // 3（默认）/ 2（回退两分类）
`define NN_FC_T     `NN_FC_CIN

//------------------------------------------------------------------------------
// 4. ROM 地址布局（参数化推导；★ task-51 / v7 定版：K=2、NUM_CLASSES=2 ⇒ 5652 字）
//
//    v7 相对 M3（三类 5476 字）的差别：conv3 权重之后插入 g1 段（16 通道 x 7 路
//    = 112 字），fc 输入 240 -> 256 ⇒ fc 权重 480 -> 512 字；bias/SH 各多出 g1 段。
//    权威文件：nn/out_v7/rom_offsets.json（rom_words=5652、addr_bits=13、
//    rom_sha256=316ba006…）；下面的加法链必须与该文件逐值一致（本卡证据里有核对）。
//
//      W1  = 0
//      W2  = W1  + COUT1*T1      = 8*36   = 288
//      W3  = W2  + COUT2*T2      = 16*72  = 1152
//      WG  = W3  + COUT3*T3      = 24*144 = 3456  -> 4896
//      WFC = WG  + G1_COUT*G1_CIN= 16*7   = 112   -> 5008
//      B1  = WFC + FC_COUT*FC_CIN= 2*256  = 512   -> 5520
//      B2  = B1  + 8  = 5528     B3  = B2 + 16 = 5544
//      BG  = B3  + 24 = 5568     BFC = BG + 16 = 5584
//      SH1 = BFC + FC_COUT = 5586   SH2 = SH1 + 8  = 5594
//      SH3 = SH2 + 16 = 5610        SHG = SH3 + 24 = 5634
//      SHFC= SHG + 16 = 5650        ROM_WORDS = SHFC + FC_COUT = 5652
//
//    v7 逐值（= rom_offsets.json）：
//      conv1_w 0/288   conv2_w 288/1152   conv3_w 1440/3456
//      g1_w 4896/112   fc_w 5008/512
//      conv1_b 5520/8  conv2_b 5528/16    conv3_b 5544/24
//      g1_b 5568/16    fc_b 5584/2
//      conv1_sh 5586/8 conv2_sh 5594/16   conv3_sh 5610/24
//      g1_sh 5634/16   fc_sh 5650/2
//------------------------------------------------------------------------------
// 每层权重字数
`define NN_W1_WORDS    (`NN_L1_COUT * `NN_L1_T)      // 288
`define NN_W2_WORDS    (`NN_L2_COUT * `NN_L2_T)      // 1152
`define NN_W3_WORDS    (`NN_L3_COUT * `NN_L3_T)      // 3456
`define NN_WG_WORDS    (`NN_G1_COUT * `NN_G1_T)      // 112
`define NN_WFC_WORDS   (`NN_FC_COUT * `NN_FC_T)      // 512

`define NN_W1_BASE     (`NN_W1_WORDS * 0)
`define NN_W2_BASE     (`NN_W1_BASE  + `NN_W1_WORDS)
`define NN_W3_BASE     (`NN_W2_BASE  + `NN_W2_WORDS)
`define NN_WG_BASE     (`NN_W3_BASE  + `NN_W3_WORDS)
`define NN_WFC_BASE    (`NN_WG_BASE  + `NN_WG_WORDS)
`define NN_B1_BASE     (`NN_WFC_BASE + `NN_WFC_WORDS)
`define NN_B2_BASE     (`NN_B1_BASE  + `NN_L1_COUT)
`define NN_B3_BASE     (`NN_B2_BASE  + `NN_L2_COUT)
`define NN_BG_BASE     (`NN_B3_BASE  + `NN_L3_COUT)
`define NN_BFC_BASE    (`NN_BG_BASE  + `NN_G1_COUT)
`define NN_SH1_BASE    (`NN_BFC_BASE + `NN_FC_COUT)
`define NN_SH2_BASE    (`NN_SH1_BASE + `NN_L1_COUT)
`define NN_SH3_BASE    (`NN_SH2_BASE + `NN_L2_COUT)
`define NN_SHG_BASE    (`NN_SH3_BASE + `NN_L3_COUT)
`define NN_SHFC_BASE   (`NN_SHG_BASE + `NN_G1_COUT)
`define NN_ROM_WORDS   (`NN_SHFC_BASE + `NN_FC_COUT)
`define NN_ROM_AW      13      // $clog2(5652)=13；nn_rom_data.v 由 nn/v7 脚本生成

//------------------------------------------------------------------------------
// 5. 引擎层号编码（nn_engine 内部 layer 寄存器）
//------------------------------------------------------------------------------
// ★ task-51：layer 从 2 bit 扩成 3 bit，新增 g1 层（审计 D2：原 2 bit 已用满）。
//   conv1/2/3 = 3x3 空间卷积；g1 / fc = 点积模式（无 ky/kx），区别在 is_relu 与
//   激活来源：g1 读 7 路全局量寄存器，fc 读 bufC[0..255]。
`define NN_LAYER1   3'd1
`define NN_LAYER2   3'd2
`define NN_LAYER3   3'd3
`define NN_LAYERG1  3'd4   // g1 点积层：7 路全局量 -> 16 通道（per-ch SH + ReLU）
`define NN_LAYERFC  3'd0   // fc 点积层：256 -> NUM_CLASSES（per-ch SH，不 ReLU）

//------------------------------------------------------------------------------
// 6. nn_winstat（M3b 平移归一化前端）参数 —— ★ task-40 追加，只增不改
//
//   语义（与 src/hdl/nn/nn_winstat.v 头注释一致）：
//     · 平移量 = 上一窗质心位移 Δ，只作用于**下一窗**的事件；
//     · 空窗（n=0）不做除法，质心保持上一有效值（EMPTY_CENTROID_HOLD=1），
//       下一窗平移量归零；
//     · 窗沿串行除法期间（约 52 拍）的事件先入 FIFO，算完后按所属窗口的
//       平移量补发，窗沿附近不丢事件、不串窗。
//------------------------------------------------------------------------------
`define NN_WS_FIFO_DEPTH           64   // 窗沿计算期事件缓冲深度（事件级）
`define NN_WS_FIFO_AW              6    // 与 FIFO_DEPTH=64 配套的地址位宽
`define NN_WS_EMPTY_CENTROID_HOLD  1    // 1=空窗保持上一有效质心（TB 断言依据）

//------------------------------------------------------------------------------
// 7. M3c 统一窗沿 + 平移后网格（nn_top 内部接线）参数 —— ★ task-43 追加，只增不改
//
//   nn_top 只产生一根 win_tick，同时驱动 nn_feat 的窗口切换与 nn_winstat 的
//   i_win_tick。事件要经过 nn_winstat 的 2 拍流水 + 窗沿计算期 FIFO（约 52 拍）
//   才进入 nn_feat，所以窗沿之后必须等足够拍数让「上一窗的在途事件」落地，
//   再开始排空/拷贝；否则窗沿前 1~2 拍的旧窗事件会被记进新窗。
//   取值下界 = nn_winstat FIFO 深（64）+ 窗沿除法（52）+ 流水（2），留余量取 200。
//   代价：o_win_end 比旧设计晚 200 拍（窗长 5,000,000 拍，0.004%）。
//------------------------------------------------------------------------------
`define NN_EXT_FLUSH_CYC          200

`endif // NN_CFG_VH


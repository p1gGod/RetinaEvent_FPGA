# =============================================================================
# retina_event.xdc —— retina_event 工程顶层引脚 / 电平 / 时钟 / CDC 约束
#
# 工程  : E:\workspace\FPGA_Comp\retina_event\prj\retina_event.xpr  (Vivado 2020.2)
# 器件  : xc7a100tfgg484-2   (正点原子 达芬奇Pro / Artix-7 100T FGG484 -2)
# 顶层  : top_retina_event
# 引脚来源: doc\FPGA_board\02_硬件原理图与引脚\DaVinci_Pro_PIN_勘误修正_UTF8.xdc
#           （已修 can_tx 笔误；本工程不用 can，仅作来源声明）
# 以太网引脚来源: 已上板验证的合并顶层 exp_ov5640_lcd_eth（eth_pin.xdc，GE1=Y18 口）
# DDR3 引脚  : **不写在这里** —— 由 MIG 生成的 mig_7series_0.xdc 提供
#             （retina_event.gen\sources_1\ip\mig_7series_0_3\...\constraints\mig_7series_0.xdc，
#               含 70 条 PACKAGE_PIN + SSTL15/DIFF_SSTL15 + IO_BUFFER_TYPE NONE，重复写会冲突）
#
# ⚠️ 三条本板硬约束（写错会以"代码问题"的样子出现，见 top_retina_event.md §9）：
#   1. Bank34/35 的 VCCO = 1.35 V（DDR3L）⇒ sys_clk/sys_rst_n/key/led/beep/lcd_bl/lcd_rst
#      必须是 LVCMOS15。写成 LVCMOS33 综合阶段一路绿灯，实现在 [DRC BIVC-1] conflicting VCCOs 才炸。
#   2. sys_clk(R4) 不是专用时钟引脚 ⇒ 必须 CLOCK_DEDICATED_ROUTE FALSE。
#   3. cam_pclk(U18) 周期是 20.833 ns（≈48 MHz，1 像素 = 2 个 pclk），
#      厂家 XDC 写的 40 ns 是错的（ILA 实测 H41/H42）。
#
# ⚠️ 关于 XDC 的 Tcl 语义（本轮实测，见 build\_xdctest.console.log）：
#   · XDC 在 read_xdc 时**不解析** get_ports/get_clocks；Vivado 把它推迟到 elaborate 时重放。
#   · XDC 里**不允许** puts / if / proc 等普通 Tcl 命令（报 [Designutils 20-1307]）。
#   ⇒ 所以本文件只能写"无条件约束"，不能写守卫。端口对不上时 Vivado 只报
#     [Vivado 12-4739] / [Common 17-55] 级别的 CRITICAL WARNING（不会中断构建），
#     build_retina.tcl 会在读完后显式核对并由 build_retina.ps1 报 BUILD_PORT_UNCONSTRAINED。
#
# 端口契约（build_retina.ps1 解析这些行与顶层 RTL 端口名交叉核对）：
#   RETE_PORT|<port>|<pin>|<iostandard>|<clock_domain/note>
# =============================================================================

# -----------------------------------------------------------------------------
# 0. 端口契约表（= 本文件约束的全部端口；改顶层端口名时同步改这里 + 下面的 set_property）
# -----------------------------------------------------------------------------
# RETE_PORT|sys_clk|R4|LVCMOS15|clk_sys 50MHz
# RETE_PORT|sys_rst_n|U7|LVCMOS15|rst_n
# RETE_PORT|key[0]|T4|LVCMOS15|clk_sys 低有效
# RETE_PORT|key[1]|T3|LVCMOS15|clk_sys 低有效
# RETE_PORT|key[2]|R6|LVCMOS15|clk_sys 低有效
# RETE_PORT|key[3]|T6|LVCMOS15|clk_sys 低有效
# RETE_PORT|led[0]|V9|LVCMOS15|clk_sys
# RETE_PORT|led[1]|Y8|LVCMOS15|clk_sys
# RETE_PORT|led[2]|Y7|LVCMOS15|clk_sys
# RETE_PORT|led[3]|W7|LVCMOS15|clk_sys
# RETE_PORT|beep|V7|LVCMOS15|clk_sys
# RETE_PORT|uart_rxd|E14|LVCMOS33|clk_sys
# RETE_PORT|uart_txd|D17|LVCMOS33|clk_sys
# RETE_PORT|cam_pclk|U18|LVCMOS33|cam_pclk 20.833ns
# RETE_PORT|cam_vsync|P14|LVCMOS33|cam_pclk
# RETE_PORT|cam_href|N14|LVCMOS33|cam_pclk
# RETE_PORT|cam_data[0]|P17|LVCMOS33|cam_pclk
# RETE_PORT|cam_data[1]|P15|LVCMOS33|cam_pclk
# RETE_PORT|cam_data[2]|R16|LVCMOS33|cam_pclk
# RETE_PORT|cam_data[3]|R17|LVCMOS33|cam_pclk
# RETE_PORT|cam_data[4]|P16|LVCMOS33|cam_pclk
# RETE_PORT|cam_data[5]|V17|LVCMOS33|cam_pclk
# RETE_PORT|cam_data[6]|W17|LVCMOS33|cam_pclk
# RETE_PORT|cam_data[7]|U17|LVCMOS33|cam_pclk
# RETE_PORT|cam_rst_n|N17|LVCMOS33|clk_sys
# RETE_PORT|cam_pwdn|AB18|LVCMOS33|clk_sys
# RETE_PORT|cam_scl|N13|LVCMOS33|clk_sys
# RETE_PORT|cam_sda|R14|LVCMOS33|clk_sys (inout)
# RETE_PORT|lcd_rgb[0]|L14|LVCMOS33|lcd_clk (inout 读屏ID)
# RETE_PORT|lcd_rgb[1]|L13|LVCMOS33|lcd_clk (inout 读屏ID)
# RETE_PORT|lcd_rgb[2]|M13|LVCMOS33|lcd_clk (inout 读屏ID)
# RETE_PORT|lcd_rgb[3]|K19|LVCMOS33|lcd_clk (inout 读屏ID)
# RETE_PORT|lcd_rgb[4]|K18|LVCMOS33|lcd_clk (inout 读屏ID)
# RETE_PORT|lcd_rgb[5]|K16|LVCMOS33|lcd_clk (inout 读屏ID)
# RETE_PORT|lcd_rgb[6]|L16|LVCMOS33|lcd_clk (inout 读屏ID)
# RETE_PORT|lcd_rgb[7]|M16|LVCMOS33|lcd_clk (inout 读屏ID)
# RETE_PORT|lcd_rgb[8]|H14|LVCMOS33|lcd_clk
# RETE_PORT|lcd_rgb[9]|J14|LVCMOS33|lcd_clk
# RETE_PORT|lcd_rgb[10]|H15|LVCMOS33|lcd_clk
# RETE_PORT|lcd_rgb[11]|J15|LVCMOS33|lcd_clk
# RETE_PORT|lcd_rgb[12]|J16|LVCMOS33|lcd_clk
# RETE_PORT|lcd_rgb[13]|K14|LVCMOS33|lcd_clk
# RETE_PORT|lcd_rgb[14]|K13|LVCMOS33|lcd_clk
# RETE_PORT|lcd_rgb[15]|L15|LVCMOS33|lcd_clk
# RETE_PORT|lcd_rgb[16]|G17|LVCMOS33|lcd_clk
# RETE_PORT|lcd_rgb[17]|G18|LVCMOS33|lcd_clk
# RETE_PORT|lcd_rgb[18]|G15|LVCMOS33|lcd_clk
# RETE_PORT|lcd_rgb[19]|G16|LVCMOS33|lcd_clk
# RETE_PORT|lcd_rgb[20]|H19|LVCMOS33|lcd_clk
# RETE_PORT|lcd_rgb[21]|J19|LVCMOS33|lcd_clk
# RETE_PORT|lcd_rgb[22]|G13|LVCMOS33|lcd_clk
# RETE_PORT|lcd_rgb[23]|H13|LVCMOS33|lcd_clk
# RETE_PORT|lcd_hs|H18|LVCMOS33|lcd_clk
# RETE_PORT|lcd_vs|J17|LVCMOS33|lcd_clk
# RETE_PORT|lcd_de|K17|LVCMOS33|lcd_clk
# RETE_PORT|lcd_pclk|H17|LVCMOS33|lcd_clk
# RETE_PORT|lcd_bl|W9|LVCMOS15|clk_sys
# RETE_PORT|lcd_rst|Y9|LVCMOS15|clk_sys
# RETE_PORT|eth_rxc|Y18|LVCMOS33|eth_rxc 125MHz (GE1 底板口)
# RETE_PORT|eth_rx_ctl|Y21|LVCMOS33|eth_rxc
# RETE_PORT|eth_rxd[0]|Y22|LVCMOS33|eth_rxc
# RETE_PORT|eth_rxd[1]|AB21|LVCMOS33|eth_rxc
# RETE_PORT|eth_rxd[2]|AB22|LVCMOS33|eth_rxc
# RETE_PORT|eth_rxd[3]|Y19|LVCMOS33|eth_rxc
# RETE_PORT|eth_txc|W19|LVCMOS33|eth_tx_clk
# RETE_PORT|eth_tx_ctl|W20|LVCMOS33|eth_tx_clk
# RETE_PORT|eth_txd[0]|W22|LVCMOS33|eth_tx_clk
# RETE_PORT|eth_txd[1]|W21|LVCMOS33|eth_tx_clk
# RETE_PORT|eth_txd[2]|T20|LVCMOS33|eth_tx_clk
# RETE_PORT|eth_txd[3]|P20|LVCMOS33|eth_tx_clk
# RETE_PORT|eth_rst_n|N20|LVCMOS33|clk_sys

# =============================================================================
# 1. 主时钟（create_clock）
#    · sys_clk 50MHz / cam_pclk 20.833ns / eth_rxc 8ns 是本设计的 3 个独立输入时钟。
#    · 设计文档说的"4 个域"里的 clk_25m / clk_200m / clk_lcd / clk_cam / clk_125m
#      全部由 clk_wiz_0(MMCM) 从 sys_clk 派生 —— 由 Vivado 自动推导，
#      **不要**再用 create_clock 声明（会与自动推导冲突）。
#      实施结果用 build_retina.tcl 的 BUILD_CLOCKS= 打印核对。
# =============================================================================
create_clock -period 20.000  -name sys_clk  [get_ports sys_clk]
# ⚠️ cam_pclk 实测 ≈48 MHz（20.833 ns），不是厂家 XDC 里的 40 ns(25MHz)。
create_clock -period 20.833  -name cam_pclk [get_ports cam_pclk]
create_clock -period 8.000   -name eth_rxc  [get_ports eth_rxc]

# =============================================================================
# 1b. ★ clk_lcd（25 MHz）—— 必须手写，Vivado 不会自动派生
#
#   来源：clk_rst_gen 里 `reg clk_25m_pre` 把 clk_wiz_0 的 clk_out2(50 MHz) 二分频，
#         再经 BUFG 输出 o_clk_lcd。
#   ⚠️ Vivado 的自动 generated-clock 派生**只发生在 MMCM/PLL 的输出引脚**，
#      **不会穿过普通 fabric 寄存器**（实测 report_clocks 里只有
#      clk_out1_clk_wiz_0=200MHz / clk_out2_clk_wiz_0=50MHz，没有 25 MHz）。
#      ⇒ 不写这条的话，LCD 所在的整个 25 MHz 域**不被时序分析**（静默风险）。
#
#   `-quiet` 是刻意的：万一综合后的实例名不同，get_pins 返回空 ⇒ 只出 CRITICAL WARNING、
#   构建不受影响（安全降级）。**必须**用 report_clocks 验证 clk_lcd 真的出现且 period=40.000。
# =============================================================================
create_generated_clock -name clk_lcd \
    -source [get_pins -quiet u_clk_rst_gen/clk_25m_pre_reg/C] \
    -divide_by 2 \
    [get_pins -quiet u_clk_rst_gen/clk_25m_pre_reg/Q]

# =============================================================================
# 2. 时钟布线例外（R4/U18 都不是专用时钟引脚）
#
#    实测（Lead 的 build_inproc.console.log，--full 跑到 route_design）：
#    本约束**确实生效** —— DRC 那两条都被降级成 WARNING，原文是
#      "This is normally an ERROR but the CLOCK_DEDICATED_ROUTE constraint is set to FALSE
#       allowing your design to continue."
#      · [DRC PLCK-23] sys_clk: IBUF(O) 锁在 IOB_X1Y74 → MMCME2_ADV_X0Y0，走非专用路径
#      · [DRC PLCK-12] cam_pclk: IBUF(O) 锁在 IOB_X0Y63 → BUFGCTRL_X0Y4，走非专用路径
#    ⇒ 这是 task-5 硬性要求（R4 不是专用时钟引脚）的**既定代价**，不是缺陷；
#      但必须盯 WNS/WHS —— 非专用路径的 clock insertion delay 不可预测。
#
#    ⚠️ 故意**只写端口网名**：曾经额外写过 [get_nets sys_clk_IBUF] / [get_nets cam_pclk_IBUF]，
#       而这两个网在 XDC 重放（elaborate）时还不存在 ⇒ 每次构建白报 2 条
#       [Common 17-55] 'set_property' expects at least one object（实测命中，已删）。
#       上面两条 PLCK 已经证明端口网名这一条就够。
# =============================================================================
set_property CLOCK_DEDICATED_ROUTE FALSE [get_nets sys_clk]
set_property CLOCK_DEDICATED_ROUTE FALSE [get_nets cam_pclk]

# =============================================================================
# 3. 引脚约束
# =============================================================================

# ---- 3.1 系统时钟 / 复位（Bank34 → LVCMOS15）---------------------------------
set_property -dict {PACKAGE_PIN R4 IOSTANDARD LVCMOS15} [get_ports sys_clk]
set_property -dict {PACKAGE_PIN U7 IOSTANDARD LVCMOS15} [get_ports sys_rst_n]

# ---- 3.2 按键 / LED / 蜂鸣器（Bank34 → LVCMOS15）-----------------------------
# key 低有效：按下 = 0（厂家 11_key_led：4'b1111 = 无键）
set_property -dict {PACKAGE_PIN T4 IOSTANDARD LVCMOS15} [get_ports {key[0]}]
set_property -dict {PACKAGE_PIN T3 IOSTANDARD LVCMOS15} [get_ports {key[1]}]
set_property -dict {PACKAGE_PIN R6 IOSTANDARD LVCMOS15} [get_ports {key[2]}]
set_property -dict {PACKAGE_PIN T6 IOSTANDARD LVCMOS15} [get_ports {key[3]}]
set_property -dict {PACKAGE_PIN V9 IOSTANDARD LVCMOS15} [get_ports {led[0]}]
set_property -dict {PACKAGE_PIN Y8 IOSTANDARD LVCMOS15} [get_ports {led[1]}]
set_property -dict {PACKAGE_PIN Y7 IOSTANDARD LVCMOS15} [get_ports {led[2]}]
set_property -dict {PACKAGE_PIN W7 IOSTANDARD LVCMOS15} [get_ports {led[3]}]
set_property -dict {PACKAGE_PIN V7 IOSTANDARD LVCMOS15} [get_ports beep]

# ---- 3.3 串口遥测（3.3 V 组，**不是** 1.35 V 组）-----------------------------
set_property -dict {PACKAGE_PIN E14 IOSTANDARD LVCMOS33} [get_ports uart_rxd]
set_property -dict {PACKAGE_PIN D17 IOSTANDARD LVCMOS33} [get_ports uart_txd]

# ---- 3.4 OV5640 摄像头（LVCMOS33）--------------------------------------------
# ⚠️ cam_data[*] **故意不再打 IOB TRUE**（原版有，2026-10-03 实测后删）：
#    本设计里 cam_data 同时喂 ① 厂家显示通路（ov5640_dri/cmos_capture_data）
#    ② 自研事件支路 tap ⇒ **一个端口驱动多个 flop**，端口级 IOB 约束在语法上就不成立。
#    实测证据（Lead 的 build_inproc.console.log）：
#      CRITICAL WARNING: [Constraints 18-841] Port cam_data[0..7] has IOB constraint.
#        But it drives multiple flops. ... The IOB constraint on port will be ignored.   ← ×8
#      WARNING: [DRC PLIO-8] Terminal cam_data[0..7] has IOB constraint set to TRUE,
#        but it is either not connected to a FLOP element or the connected FLOP element
#        could not be brought into the I/O.                                            ← ×8
#    ⇒ 留着它只会白报 8 条 CRITICAL WARNING + 8 条 DRC WARNING，**实际被工具忽略**，
#      所以删掉。48 MHz / T=20.833 ns + 下面的 set_input_delay，时序余量充足。
#    ⚠️ 若确实要把输入寄存器塞进 IOB（省 ~1 ns 布线延迟），正确做法是在 **RTL 的具体 flop**
#      上打属性（`(* IOB = "TRUE" *) reg ...`），而不是在端口上 ——
#      那属于 cam_tap / capture 的写域，由对应 owner 决定，本 XDC 不代劳。
set_property -dict {PACKAGE_PIN U18 IOSTANDARD LVCMOS33} [get_ports cam_pclk]
set_property -dict {PACKAGE_PIN P14 IOSTANDARD LVCMOS33} [get_ports cam_vsync]
set_property -dict {PACKAGE_PIN N14 IOSTANDARD LVCMOS33} [get_ports cam_href]
set_property -dict {PACKAGE_PIN P17 IOSTANDARD LVCMOS33} [get_ports {cam_data[0]}]
set_property -dict {PACKAGE_PIN P15 IOSTANDARD LVCMOS33} [get_ports {cam_data[1]}]
set_property -dict {PACKAGE_PIN R16 IOSTANDARD LVCMOS33} [get_ports {cam_data[2]}]
set_property -dict {PACKAGE_PIN R17 IOSTANDARD LVCMOS33} [get_ports {cam_data[3]}]
set_property -dict {PACKAGE_PIN P16 IOSTANDARD LVCMOS33} [get_ports {cam_data[4]}]
set_property -dict {PACKAGE_PIN V17 IOSTANDARD LVCMOS33} [get_ports {cam_data[5]}]
set_property -dict {PACKAGE_PIN W17 IOSTANDARD LVCMOS33} [get_ports {cam_data[6]}]
set_property -dict {PACKAGE_PIN U17 IOSTANDARD LVCMOS33} [get_ports {cam_data[7]}]
set_property -dict {PACKAGE_PIN N17 IOSTANDARD LVCMOS33} [get_ports cam_rst_n]
set_property -dict {PACKAGE_PIN AB18 IOSTANDARD LVCMOS33} [get_ports cam_pwdn]
set_property -dict {PACKAGE_PIN N13 IOSTANDARD LVCMOS33} [get_ports cam_scl]
set_property -dict {PACKAGE_PIN R14 IOSTANDARD LVCMOS33} [get_ports cam_sda]

# ---- 3.5 RGB LCD（lcd_rgb 是 inout：开机先当输入读屏 ID，见 traps §12）--------
set_property -dict {PACKAGE_PIN L14 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[0]}]
set_property -dict {PACKAGE_PIN L13 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[1]}]
set_property -dict {PACKAGE_PIN M13 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[2]}]
set_property -dict {PACKAGE_PIN K19 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[3]}]
set_property -dict {PACKAGE_PIN K18 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[4]}]
set_property -dict {PACKAGE_PIN K16 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[5]}]
set_property -dict {PACKAGE_PIN L16 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[6]}]
set_property -dict {PACKAGE_PIN M16 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[7]}]
set_property -dict {PACKAGE_PIN H14 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[8]}]
set_property -dict {PACKAGE_PIN J14 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[9]}]
set_property -dict {PACKAGE_PIN H15 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[10]}]
set_property -dict {PACKAGE_PIN J15 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[11]}]
set_property -dict {PACKAGE_PIN J16 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[12]}]
set_property -dict {PACKAGE_PIN K14 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[13]}]
set_property -dict {PACKAGE_PIN K13 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[14]}]
set_property -dict {PACKAGE_PIN L15 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[15]}]
set_property -dict {PACKAGE_PIN G17 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[16]}]
set_property -dict {PACKAGE_PIN G18 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[17]}]
set_property -dict {PACKAGE_PIN G15 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[18]}]
set_property -dict {PACKAGE_PIN G16 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[19]}]
set_property -dict {PACKAGE_PIN H19 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[20]}]
set_property -dict {PACKAGE_PIN J19 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[21]}]
set_property -dict {PACKAGE_PIN G13 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[22]}]
set_property -dict {PACKAGE_PIN H13 IOSTANDARD LVCMOS33} [get_ports {lcd_rgb[23]}]
set_property -dict {PACKAGE_PIN H18 IOSTANDARD LVCMOS33} [get_ports lcd_hs]
set_property -dict {PACKAGE_PIN J17 IOSTANDARD LVCMOS33} [get_ports lcd_vs]
set_property -dict {PACKAGE_PIN K17 IOSTANDARD LVCMOS33} [get_ports lcd_de]
set_property -dict {PACKAGE_PIN H17 IOSTANDARD LVCMOS33} [get_ports lcd_pclk]
# lcd_bl / lcd_rst 在 Bank34 ⇒ LVCMOS15（写 33 会在实现期 [DRC BIVC-1]）
set_property -dict {PACKAGE_PIN W9 IOSTANDARD LVCMOS15} [get_ports lcd_bl]
set_property -dict {PACKAGE_PIN Y9 IOSTANDARD LVCMOS15} [get_ports lcd_rst]

# ---- 3.6 千兆以太网 RGMII（LVCMOS33）-----------------------------------------
# ★ 本工程用**底板 GE1**（eth_rxc = Y18）：已上板验证的那块网口，
#   网线插的就是它（exp_ov5640_lcd_eth/tool 记录，2026-09-27 确认）。
#   核心板 GE0 = eth_rxc_0 = U20 是另一个口 —— 插错会"链路灯亮但 0 报文"（事实 H36）。
#   若要改用 GE0，把下面 7 根 rx/tx 引脚换成 errata XDC 里的 eth_*_0 那一组（U20/AA20/AA21/V20/U22/V22 与 V18/V19/T21/U21/P19/R19）。
set_property -dict {PACKAGE_PIN Y18  IOSTANDARD LVCMOS33} [get_ports eth_rxc]
set_property -dict {PACKAGE_PIN Y21  IOSTANDARD LVCMOS33} [get_ports eth_rx_ctl]
set_property -dict {PACKAGE_PIN Y22  IOSTANDARD LVCMOS33} [get_ports {eth_rxd[0]}]
set_property -dict {PACKAGE_PIN AB21 IOSTANDARD LVCMOS33} [get_ports {eth_rxd[1]}]
set_property -dict {PACKAGE_PIN AB22 IOSTANDARD LVCMOS33} [get_ports {eth_rxd[2]}]
set_property -dict {PACKAGE_PIN Y19  IOSTANDARD LVCMOS33} [get_ports {eth_rxd[3]}]
set_property -dict {PACKAGE_PIN W19  IOSTANDARD LVCMOS33} [get_ports eth_txc]
set_property -dict {PACKAGE_PIN W20  IOSTANDARD LVCMOS33} [get_ports eth_tx_ctl]
set_property -dict {PACKAGE_PIN W22  IOSTANDARD LVCMOS33} [get_ports {eth_txd[0]}]
set_property -dict {PACKAGE_PIN W21  IOSTANDARD LVCMOS33} [get_ports {eth_txd[1]}]
set_property -dict {PACKAGE_PIN T20  IOSTANDARD LVCMOS33} [get_ports {eth_txd[2]}]
set_property -dict {PACKAGE_PIN P20  IOSTANDARD LVCMOS33} [get_ports {eth_txd[3]}]
set_property -dict {PACKAGE_PIN N20  IOSTANDARD LVCMOS33} [get_ports eth_rst_n]

# =============================================================================
# 4. CDC 约束
#    cam_pclk(20.833ns) 与 MMCM 派生的 clk_25m(20.000ns) 周期接近整数比，
#    Vivado 会**误判为同步路径** ⇒ 必须显式声明异步。
#    分组用 -include_generated_clocks：把 sys_clk 的全部 MMCM 派生时钟
#    （clk_25m / clk_200m / clk_lcd / clk_cam / clk_125m …）作为一个同步组，
#    与 cam_pclk、eth_rxc 两个独立输入域互斥。
#    覆盖的 CDC：CDC-0(cam_pclk→clk_cam, 异步FIFO) / CDC-1(clk_cam→clk_lcd, 双口BRAM)
#                CDC-2(clk_cam→clk_lcd, 两级同步器) / CDC-3(clk_cam→clk_eth, 异步FIFO)
#    对应文档: docs/01_模块划分与总体框图.md §3
# =============================================================================
set_clock_groups -asynchronous -name rete_async_3grp \
    -group [get_clocks -include_generated_clocks -quiet sys_clk] \
    -group [get_clocks -include_generated_clocks -quiet cam_pclk] \
    -group [get_clocks -include_generated_clocks -quiet eth_rxc]

# 显式 false path（冗余于上面的 clock group，用作"cam_pclk 被误判成同步"的双保险）。
#
# ⚠️⚠️ 写法安全规则（本轮微测试 build\_xdctest.console.log 实测）：
#   XDC 里 `set_false_path -from X -to Y`，若某个对象集为空，Vivado 会
#   **丢掉那个选项、用剩下的选项继续执行**（只报 CRITICAL WARNING [Vivado 12-4739]）。
#   ⇒ 所以 `-to` 为空时会退化成 `set_false_path -from X`（= X 到**所有**目的地），
#     属于"过度放宽、静默掩盖真实违例"，比不写还危险。
#   ⇒ 本节**只保留 cam_pclk ↔ sys_clk** 这一对：这两个时钟是本设计的硬前提
#     （没有 cam_pclk 就没有事件引擎，都不必构建），所以两种写法都不会退化。
#   ⇒ eth_rxc 的跨域**不再写 false_path**，完全交给上面的
#     set_clock_groups -asynchronous（空分组只会报 warning、不会过度放宽，安全）。
#   ⚠️ 若将来顶层不含 cam_pclk，请把本节 4 行一起删掉。
set_false_path -from [get_clocks -include_generated_clocks -quiet cam_pclk] -to [get_clocks -include_generated_clocks -quiet sys_clk]
set_false_path -from [get_clocks -include_generated_clocks -quiet sys_clk]   -to [get_clocks -include_generated_clocks -quiet cam_pclk]

# =============================================================================
# 5. 输入延时：OV5640 DVP 源同步接口（cam_data / cam_href / cam_vsync 相对 cam_pclk）
#
# ⚠️ 出处说明（诚实标注，别当成厂家值抄）：
#   · **厂家例程 37 的 pin.xdc 里没有 set_input_delay** —— 已在全工作区搜索确认
#     （exp_ov5640_lcd37 / doc\FPGA_board / retina_event 下所有 .xdc/.tcl/.ucf
#      里 set_input_delay 命中数 = 0，唯一提到它的是指导手册里的泛化示例行）。
#   · 资料库里也没有 OV5640 数据手册的 tCO / tSU / tHD 数字。
#   ⇒ 下面这组是**按拓扑推出的保守界（推断，非实测）**：
#     OV5640 在 pclk 下降沿更新数据、FPGA 在上升沿采样（ref_original/cmos_capture_data.v
#     用 posedge cam_pclk 采样）⇒ "外部延时必须在半个周期之内"是像素仍属本拍的必要条件。
#     -max = T/2 = 20.833/2 = 10.4165 ns，-min = 0.0 ns。
#     这组值**不会凭空制造违例**（48 MHz、T=20.833 ns，余量充足），但能让
#     cam_pclk 的输入路径真正进入时序分析，而不是被静默忽略。
#   ⚠️ 拿到 OV5640 手册的 tCO 后，请把 max/min 换成真实的 tCO_max / tCO_min。
#   ⚠️ 本节的 cam_pclk 是本设计硬前提（无 cam_pclk 即无事件引擎），不会出现空时钟。
# =============================================================================
set_input_delay -clock [get_clocks cam_pclk] -max 10.4165 [get_ports {cam_data[*]}]
set_input_delay -clock [get_clocks cam_pclk] -min 0.0     [get_ports {cam_data[*]}]
set_input_delay -clock [get_clocks cam_pclk] -max 10.4165 [get_ports cam_href]
set_input_delay -clock [get_clocks cam_pclk] -min 0.0     [get_ports cam_href]
set_input_delay -clock [get_clocks cam_pclk] -max 10.4165 [get_ports cam_vsync]
set_input_delay -clock [get_clocks cam_pclk] -min 0.0     [get_ports cam_vsync]

# =============================================================================
# 6. 备用端口约束（顶层端口名若变才启用；当前**不启用**，保持与冻结的 45 端口契约
#    严格一致，这样构建日志里不会有多余的 CRITICAL WARNING）
#    · key0 = T4：TopName 若用单根 key0 代替 key[3:0]
#      ⚠️ 但 key0 与 key[0] 都是 T4，同一顶层只能出现其中一个。
#    · eth_mdc = M20 / eth_mdio = N22：厂家 eth_top 与 ov5640_lcd_udp.v 都没引出。
# =============================================================================
# set_property -dict {PACKAGE_PIN T4 IOSTANDARD LVCMOS15} [get_ports key0]
# set_property -dict {PACKAGE_PIN M20 IOSTANDARD LVCMOS33} [get_ports eth_mdc]
# set_property -dict {PACKAGE_PIN N22 IOSTANDARD LVCMOS33} [get_ports eth_mdio]

# =============================================================================
# 7. 配置 Flash / 比特流选项（来自厂家板级 XDC，本板 N25Q128 SPIx4；固化 Flash 需要）
# =============================================================================
set_property CFGBVS VCCO                          [current_design]
set_property CONFIG_VOLTAGE 3.3                   [current_design]
set_property CONFIG_MODE SPIx4                    [current_design]
set_property BITSTREAM.CONFIG.CONFIGRATE 50       [current_design]
set_property BITSTREAM.CONFIG.SPI_BUSWIDTH 4      [current_design]
set_property BITSTREAM.CONFIG.SPI_FALL_EDGE YES   [current_design]
set_property BITSTREAM.CONFIG.UNUSEDPIN PULLUP    [current_design]
set_property BITSTREAM.GENERAL.COMPRESS TRUE      [current_design]

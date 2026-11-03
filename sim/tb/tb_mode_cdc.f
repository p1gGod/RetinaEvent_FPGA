# tb_mode_cdc —— F3：SET_MODE 值/toggle 跨域竞态（修复后结构 = cdc_tog_word 静默窗握手）
# 修复前结构复现运行：把最后一行换成 sim/tb/mode_cdc_dut_legacy.v（见 tb_mode_cdc_legacy.f）
src/rtl/primitives/sync_ff.v
src/rtl/primitives/edge_detect.v
src/rtl/primitives/cdc_tog_word.v
src/rtl/control/sys_ctrl.v
sim/tb/mode_cdc_dut_fixed.v

# tb_mode_cdc 的**修复前基线**文件表（复现取证用；不进全量回归）
# 用法：把它作为 sim/tb/tb_mode_cdc.f 运行（或复制覆盖），预期 TEST_RESULT=FAIL
src/rtl/primitives/sync_ff.v
src/rtl/primitives/edge_detect.v
src/rtl/control/sys_ctrl.v
sim/tb/mode_cdc_dut_legacy.v

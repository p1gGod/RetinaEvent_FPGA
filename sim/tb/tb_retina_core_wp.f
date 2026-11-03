# tb_retina_core_wp 依赖清单（一行一个路径，相对工程根 retina_event/）
# 只含"算法链"本身：不含 cam_tap / vps_mux / axis_fifo / stats_counter
# （本 TB 直接由 vps_pattern_gen 驱动，绕开 DVP 时序与帧边界切换）
src/rtl/capture/vps_pattern_gen.v
src/rtl/capture/vps_resample.v
src/rtl/engine/px_luma.v
src/rtl/engine/luma_log.v
src/rtl/engine/temporal_diff.v
src/rtl/engine/spatial_lap.v
src/rtl/engine/event_gen.v
src/rtl/engine/refractory.v
src/rtl/primitives/line_buffer.v

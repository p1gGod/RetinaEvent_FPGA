# tb_retina_core_cam 依赖清单（一行一个路径，相对工程根 retina_event/）
# 与 tb_retina_core 同拓扑：走 cam_tap + CDC-0(axis_fifo) + vps_mux 的真实相机通路
src/rtl/primitives/sync_ff.v
src/rtl/primitives/delay_pipe.v
src/rtl/primitives/edge_detect.v
src/rtl/primitives/line_buffer.v
src/rtl/primitives/axis_fifo.v
src/rtl/capture/cam_tap.v
src/rtl/capture/vps_pattern_gen.v
src/rtl/capture/vps_mux.v
src/rtl/capture/vps_resample.v
src/rtl/engine/px_luma.v
src/rtl/engine/luma_log.v
src/rtl/engine/temporal_diff.v
src/rtl/engine/spatial_lap.v
src/rtl/engine/event_gen.v
src/rtl/engine/refractory.v
src/rtl/engine/stats_counter.v
src/rtl/subsys/retina_core.v

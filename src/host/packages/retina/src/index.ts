// @retina/retina —— 上位机侧的「仿视网膜事件驱动视觉」算法（与 RTL 逐位同构）。
//
// 放在包层（而不是 web 或 gateway 内部）是因为有两个消费者，且必须给出**同一张图**：
//   · gateway：/api/events.png 与"上位机模拟处理"数据源
//   · web    ：L2 事件图层
// 与 @retina/protocol 的分工：protocol 管"线上字节长什么样"，这里管"像素变成事件的算法"。
export * from "./luma.ts";
export * from "./engine.ts";
export * from "./pattern.ts";
export * from "./bitmap.ts";

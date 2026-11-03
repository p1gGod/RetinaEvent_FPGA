// 图层栈合成器：z 序一律取自 protocol 的 LAYER_Z（03 文档 §3 的硬要求：
// 不允许各组件自己写 z-index，否则加一层就会和别的层打架）。
// 为什么把"开关"放在栈里而不是图层里：开关是界面状态、图层是无状态的绘制逻辑，
// 混在一起就会出现"图层自己记住了上次是不是显示"这类幽灵状态。
import { LAYER_Z } from "@retina/protocol";
import type { Layer, LayerKey, RenderEnv } from "./types.ts";

export interface LayerMeta {
  readonly key: LayerKey;
  readonly z: number;
  readonly label: string;
  readonly note: string;
  readonly blend: string;
}

/** 图层栈卡片的显示顺序：自上而下 = z 从大到小（与设计稿一致） */
export const LAYER_META: readonly LayerMeta[] = [
  { key: "INTERACT", z: LAYER_Z.INTERACT, label: "交互标注", note: "游标/测量/选区", blend: "overlay" },
  { key: "POSTPROC", z: LAYER_Z.POSTPROC, label: "后处理结果", note: "检测框/热图", blend: "normal" },
  { key: "HUD", z: LAYER_Z.HUD, label: "HUD 叠加", note: "panel/grid/text", blend: "source-over" },
  { key: "EVENTS", z: LAYER_Z.EVENTS, label: "事件位图", note: "ON/OFF + 余晖", blend: "screen 85%" },
  { key: "RAW", z: LAYER_Z.RAW, label: "原始帧", note: "RGB565 → RGB888", blend: "normal" },
  { key: "BACKGROUND", z: LAYER_Z.BACKGROUND, label: "背景网格", note: "标尺/参考线", blend: "behind" },
];

export const ALL_LAYER_KEYS: readonly LayerKey[] = LAYER_META.map((m) => m.key);

/** 图层预设（快捷键 L 循环）：演示时想录"干净画面"就切"仅原始" */
export const LAYER_PRESETS: readonly { readonly name: string; readonly on: readonly LayerKey[] }[] = [
  { name: "全部", on: ["BACKGROUND", "RAW", "EVENTS", "HUD", "POSTPROC"] },
  { name: "仅原始", on: ["BACKGROUND", "RAW"] },
  { name: "仅事件", on: ["BACKGROUND", "EVENTS"] },
  { name: "仅后处理", on: ["BACKGROUND", "RAW", "POSTPROC"] },
];

export class LayerStack {
  private readonly enabled: Record<LayerKey, boolean>;
  private readonly byKey = new Map<LayerKey, Layer>();
  private ordered: Layer[] = [];

  constructor(enabled: Record<LayerKey, boolean>) {
    this.enabled = enabled;
  }

  add(layer: Layer): void {
    this.byKey.set(layer.key, layer);
    this.ordered = [...this.byKey.values()].sort((a, b) => a.z - b.z); // 加层时排一次，不在每帧排
  }

  isOn(key: LayerKey): boolean {
    return this.enabled[key] === true;
  }

  setOn(key: LayerKey, on: boolean): void {
    this.enabled[key] = on;
  }

  get layers(): readonly Layer[] {
    return this.ordered;
  }

  /**
   * 按 z 序合成。
   * only = 该窗格的图层白名单（null 表示"全部允许"）：全局开关决定"要不要画"，
   * 白名单决定"这个窗格该不该出现这一层"，两者都满足才画。
   */
  draw(env: RenderEnv, only: ReadonlySet<LayerKey> | null = null): void {
    for (const l of this.ordered) {
      if (!this.enabled[l.key]) continue;
      if (only && !only.has(l.key)) continue;
      l.draw(env);
    }
  }
}

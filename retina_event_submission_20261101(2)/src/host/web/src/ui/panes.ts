// 四窗格：舞台的 2×2 布局 + 每个窗格的画布尺寸管理 + 每个窗格的"默认图层构成"。
// 为什么画布要监听 .frame 的尺寸而不是 window：窗格尺寸受侧栏断点、聚焦、滚动条影响，
// 只盯 window 会在断点切换时算错，导致画面被拉伸（设计稿踩坑 #6 的同类问题）。
// 为什么每个窗格有一份 layers 白名单：四窗格的语义就是"同一帧的四种表示"（03 文档 §2.1），
// 所以"原始画面"里不该出现 HUD、"事件画面"里不该出现原始帧；全局图层开关是在此之上的过滤器。
import type { LayerKey } from "../layers/types.ts";
import { el } from "./dom.ts";

export type PaneKind = "raw" | "events" | "overlay" | "post";

export interface PaneSpec {
  readonly id: number;
  readonly kind: PaneKind;
  readonly tag: string;
  readonly tagBg: string;
  readonly tagFg: string;
  readonly title: string;
  readonly meta: string;
  readonly corners: readonly string[];
  readonly badge: string;
  /** 该窗格默认参与的图层（与全局开关取交集） */
  readonly layers: readonly LayerKey[];
  /** 窗格标题右侧的实时元信息（内容由 main.ts 按数据更新） */
  readonly metaRight: string;
}

export const DEFAULT_PANES: readonly PaneSpec[] = [
  {
    id: 1, kind: "raw", tag: "L1", tagBg: "#1b2740", tagFg: "#a9b8ce",
    title: "原始画面", meta: "800×480 · RGB565 · 来自 DDR3 显示通路",
    corners: ["pixel: RGB565 · 高字节在前", "CRC 由以太网 FCS 兜底"],
    badge: "合成演示素材（非上板截图）",
    layers: ["BACKGROUND", "RAW", "INTERACT"], metaRight: "等待数据…",
  },
  {
    id: 2, kind: "events", tag: "L2", tagBg: "#3a1620", tagFg: "#ff9aa8",
    title: "事件画面", meta: "400×240 · 2×2 降采样事件 · ON 红 / OFF 蓝 + 余晖",
    corners: ["pixelated 不插值", "累积位图 · O(变化量)"],
    badge: "与 RTL 同构算式离线计算",
    layers: ["BACKGROUND", "EVENTS", "INTERACT"], metaRight: "等待事件…",
  },
  {
    id: 3, kind: "overlay", tag: "L3", tagBg: "#132a3a", tagFg: "#8fd4ff",
    title: "屏上叠加输出", meta: "与板上 LCD 同构：原始 + 事件 + HUD 平面",
    corners: ["KEY0 = 原始", "HUD 是图层，不烘焙进图像"],
    badge: "L1+L2+L3 合成",
    layers: ["BACKGROUND", "RAW", "EVENTS", "HUD", "INTERACT"], metaRight: "L1+L2+L3 · KEY0 = 原始",
  },
  {
    id: 4, kind: "post", tag: "L4", tagBg: "#33290f", tagFg: "#ffd88a",
    title: "后处理输出", meta: "内置亮区检测（占位）· 真插件待 M5",
    corners: ["检测框坐标 = 原始帧像素", "关掉 L4 即消失"],
    badge: "检测框是独立图层",
    layers: ["BACKGROUND", "RAW", "POSTPROC", "INTERACT"], metaRight: "0 个检测框",
  },
];

export class Pane {
  readonly el: HTMLElement;
  readonly frame: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly meta: HTMLElement;
  readonly metaR: HTMLElement;
  readonly badge: HTMLElement;
  readonly spec: PaneSpec;
  readonly layers: ReadonlySet<LayerKey>;
  /** 画布 CSS 尺寸（绘制坐标用这个；画布后备像素 = CSS × dpr） */
  cw = 0;
  ch = 0;
  dpr = 1;
  /** .frame 的视口坐标（指针换算用；只在尺寸变化时读，避免每帧强制重排） */
  rectLeft = 0;
  rectTop = 0;

  constructor(spec: PaneSpec) {
    this.spec = spec;
    this.layers = new Set(spec.layers);
    const art = el("article", "pane");
    art.dataset["pane"] = String(spec.id);
    const header = el("header");
    const tag = el("span", "tag", spec.tag);
    tag.style.background = spec.tagBg;
    tag.style.color = spec.tagFg;
    const ttl = el("span", "ttl", spec.title);
    this.meta = el("span", "meta", spec.meta);
    this.metaR = el("span", "meta", spec.metaRight);
    const spacer = el("div", "spacer");
    header.append(tag, ttl, this.meta, spacer, this.metaR);

    this.frame = el("div", "frame");
    this.canvas = el("canvas");
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D 画布上下文创建失败（浏览器不支持？）");
    this.ctx = ctx;
    const corner = el("div", "corner");
    for (const c of spec.corners) corner.append(el("span", "c", c));
    this.badge = el("span", "badgex opt", spec.badge);
    this.frame.append(this.canvas, corner, this.badge);
    art.append(header, this.frame);

    this.el = art;
  }

  /** 同步画布后备尺寸；返回是否发生了变化（变化了才需要重绘/清屏） */
  syncSize(): boolean {
    const rect = this.frame.getBoundingClientRect();
    const cw = Math.max(1, Math.round(this.frame.clientWidth));
    const ch = Math.max(1, Math.round(this.frame.clientHeight));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.rectLeft = rect.left;
    this.rectTop = rect.top;
    if (cw === this.cw && ch === this.ch && dpr === this.dpr) return false;
    this.cw = cw;
    this.ch = ch;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cw * dpr));
    this.canvas.height = Math.max(1, Math.round(ch * dpr));
    return true;
  }
}

export function mountPanes(root: HTMLElement, specs: readonly PaneSpec[]): Pane[] {
  const panes = specs.map((s) => new Pane(s));
  for (const p of panes) root.append(p.el);
  return panes;
}

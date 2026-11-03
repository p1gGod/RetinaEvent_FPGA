// 事件率曲线：60 个 1 s 桶的画布折线。
// 为什么不用 SVG：SVG 每秒重建 DOM 节点会让状态栏/侧栏频繁重排；画布只在数据变化时重画一次。
export class Sparkline {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("sparkline 画布上下文创建失败");
    this.ctx = ctx;
    canvas.classList.add("sparkline");
  }

  draw(values: readonly number[]): void {
    const cw = Math.max(1, Math.round(this.canvas.clientWidth));
    const ch = Math.max(1, Math.round(this.canvas.clientHeight));
    if (cw !== this.w || ch !== this.h) {
      this.w = cw;
      this.h = ch;
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, cw, ch);
    if (values.length < 2) return;
    let max = 1;
    for (const v of values) if (v > max) max = v;
    const step = cw / (values.length - 1);
    const yOf = (v: number): number => ch - 2 - (v / max) * (ch - 6);
    ctx.beginPath();
    ctx.moveTo(0, ch);
    for (let i = 0; i < values.length; i++) ctx.lineTo(i * step, yOf(values[i] ?? 0));
    ctx.lineTo(cw, ch);
    ctx.closePath();
    ctx.fillStyle = "rgba(255,77,99,.14)";
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < values.length; i++) {
      const x = i * step;
      const y = yOf(values[i] ?? 0);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#ff4d63";
    ctx.lineWidth = 1.6;
    ctx.stroke();
    // 峰值参考线：让"当前离峰值多远"可见
    ctx.beginPath();
    ctx.moveTo(0, yOf(max));
    ctx.lineTo(cw, yOf(max));
    ctx.strokeStyle = "rgba(59,74,99,.9)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  get peak(): number {
    return this.w > 0 ? this.w : 0;
  }
}

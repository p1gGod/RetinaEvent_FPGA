// 操作反馈条（toast）。
//
// 为什么必须有（2026-10-06 用户反馈）：界面上有一批控件**点了完全没反应** ——
// 有些是刻意只读（v1 没有写参数通路，02 文档 §6），有些是 M2 尚未实现的方法。
// 但"没反应"和"按钮坏了"在用户眼里是同一件事。所以每个会吞掉点击的地方都必须说一句话：
// 要么说"已下发，结果如何"，要么说"为什么不能点"。
//
// 设计：右下角浮层、自动消失、同一条消息不重复堆叠（避免连点刷屏）。
const DEFAULT_MS = 3600;

export type ToastTone = "info" | "ok" | "warn" | "error";

export interface ToastHandle {
  show(message: string, tone?: ToastTone, ms?: number): void;
}

const TONE_CLASS: Record<ToastTone, string> = {
  info: "toast",
  ok: "toast ok",
  warn: "toast warn",
  error: "toast error",
};

export function mountToast(root: HTMLElement): ToastHandle {
  const wrap = document.createElement("div");
  wrap.className = "toastwrap";
  wrap.setAttribute("role", "status");
  wrap.setAttribute("aria-live", "polite");
  root.append(wrap);

  const live = new Map<string, HTMLElement>();

  function show(message: string, tone: ToastTone = "info", ms = DEFAULT_MS): void {
    // 同一条消息已在屏上：把它的计时器重置，而不是再叠一层
    const existing = live.get(message);
    if (existing) {
      existing.dataset["until"] = String(Date.now() + ms);
      return;
    }
    const el = document.createElement("div");
    el.className = TONE_CLASS[tone];
    el.textContent = message;
    el.dataset["until"] = String(Date.now() + ms);
    wrap.append(el);
    live.set(message, el);
    // 最多同时显示 4 条：多了会把画面挡住
    while (wrap.childElementCount > 4) {
      const first = wrap.firstElementChild;
      if (!(first instanceof HTMLElement)) break;
      live.delete(first.textContent ?? "");
      first.remove();
    }
  }

  // 一个统一的清扫定时器：比每条一个 setTimeout 便宜，也不会在切页时泄漏
  window.setInterval(() => {
    const now = Date.now();
    for (const [msg, el] of [...live.entries()]) {
      if (Number(el.dataset["until"] ?? "0") <= now) {
        el.remove();
        live.delete(msg);
      }
    }
  }, 400);

  return { show };
}

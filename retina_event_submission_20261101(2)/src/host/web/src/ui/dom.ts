// DOM 小工具：这几行能让上层代码只描述组件结构，不重复写 createElement/className 样板。
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * querySelector + 缺失即抛。
 *
 * 为什么单独抽出来：`const x = root.querySelector(...)` 得到的是 `T | null`，
 * 而在**嵌套闭包**里 TypeScript 不会保留 `if (x === null) throw` 的收窄
 * （闭包可能在收窄之外被调用）—— 于是每个用到它的回调里都要写一次 `x!` 或判空。
 * 一旦某处忘了写，就会出现"某个回调里静默不干活"这种最难查的 bug。
 * 这里把"缺失就炸"固定在取值那一行，后面全是非空类型。
 */
export function must<T extends Element>(e: T | null, what: string): T {
  if (e === null) throw new Error("DOM 缺少 " + what + "（index.html 与组件不同步）");
  return e;
}

/** 一张 .stat 卡片：返回值/单位分开，更新时只改文本，不重建 DOM（重建会让数字闪） */
export interface StatBox {
  readonly box: HTMLElement;
  set(value: string, unit?: string, tone?: "" | "on" | "off" | "ok" | "warn"): void;
}

export function statBox(label: string, unit = ""): StatBox {
  const box = el("div", "stat");
  const l = el("div", "l", label);
  const v = el("div", "v");
  const num = el("span", "", "—");
  const u = el("span", "u", unit);
  v.append(num, u);
  box.append(l, v);
  return {
    box,
    set(value, u2, tone = "") {
      num.textContent = value;
      if (u2 !== undefined) u.textContent = u2;
      v.className = tone === "" ? "v" : "v " + tone;
    },
  };
}

/** 一行 kv（定义列表形式，保持与设计稿 .kv 的排版一致） */
export function kvRow(dt: string, ddText = "—"): { dt: HTMLElement; dd: HTMLElement } {
  const dtEl = el("dt", "", dt);
  const ddEl = el("dd", "", ddText);
  return { dt: dtEl, dd: ddEl };
}

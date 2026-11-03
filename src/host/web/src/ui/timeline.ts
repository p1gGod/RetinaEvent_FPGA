// 底栏时间轴：录制状态 / 缓冲覆盖区间 / 播放头 / **选区**。
//
// 为什么播放头位置按"实际录到的时长 ÷ 环形窗口"算：演示时观众会拿它判断"录了多久、还能倒回多久"，
// 写死一个好看的百分比等于骗人（设计稿踩坑 #4 的同类问题：状态与画面必须一致）。
//
// 选区是这个文件在 2026-10-06 新增的能力：导出要能"只导这一段"。
// 之前按钮写着"导出选中片段"却是 disabled，因为**根本没有地方能产生选区** ——
// 一个永远不可用的按钮等于没有这个功能，只是看起来有。现在拖时间轴就能选。
import { el, must } from "./dom.ts";

const EVENT_RING_S = 120;
const FRAME_RING_S = 30;

export interface TimelineInput {
  readonly recording: boolean;
  /** 本次录制已计时（录制中 = now - start；停止后 = 最后一次时长） */
  readonly elapsedMs: number;
  readonly bufferBytes: number;
  readonly frames: number;
  /** 缓冲字节上限（用来画"还剩多少"） */
  readonly capacityBytes: number;
  /** 因超预算被丢掉的帧数（必须能说出来，不能静默丢） */
  readonly evicted: number;
}

/** 帧下标闭区间 [from, to]；null = 没有选区（= 导出全部） */
export type FrameRange = { readonly from: number; readonly to: number };

export interface TimelineHandle {
  update(v: TimelineInput): void;
  /** 当前选区；null = 无选区 */
  selection(): FrameRange | null;
  onSelectionChange(cb: (sel: FrameRange | null) => void): void;
  clearSelection(): void;
}

export function mountTimeline(root: HTMLElement): TimelineHandle {
  // must() 一次拿到非空类型：这些句柄会被下面的闭包（拖拽/渲染）用到，
  // 而收窄在闭包里不保留（见 dom.ts 的注释），在这里必须一次性钉死。
  const track = must(root.querySelector<HTMLElement>("#tlTrack"), "#tlTrack");
  const head = must(root.querySelector<HTMLElement>("#tlHead"), "#tlHead");
  const recInd = must(root.querySelector<HTMLElement>("#recInd"), "#recInd");
  const recTxt = must(root.querySelector<HTMLElement>("#recTxt"), "#recTxt");
  const clock = must(root.querySelector<HTMLElement>("#tlClock"), "#tlClock");
  const right = must(root.querySelector<HTMLElement>("#tlRight"), "#tlRight");
  const selEl = must(root.querySelector<HTMLElement>("#tlSel"), "#tlSel");

  // 两段缓冲：事件环（120 s，长）+ 帧环（30 s，短且更亮），宽度按实际覆盖比例
  const evChunk = el("div", "chunk ev");
  evChunk.title = "事件环形缓冲覆盖区间（默认 " + EVENT_RING_S + " s）";
  const frChunk = el("div", "chunk");
  frChunk.title = "帧环形缓冲覆盖区间（默认 " + FRAME_RING_S + " s）";
  track.insertBefore(evChunk, head);
  track.insertBefore(frChunk, head);

  let frameCount = 0;
  let sel: FrameRange | null = null;
  let dragFrom: number | null = null;
  let dragMoved = false;
  let listeners: readonly ((s: FrameRange | null) => void)[] = [];
  const emit = (): void => {
    for (const cb of listeners) cb(sel);
  };

  /** 画布 x 坐标 → 帧下标（0..frameCount-1）；frameCount=0 时返回 null */
  function indexAt(clientX: number): number | null {
    if (frameCount <= 0) return null;
    const r = track.getBoundingClientRect();
    if (r.width <= 0) return null;
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    // 用 round 而不是 floor：最后一格也要能被选中（floor 永远选不到最后一帧）
    return Math.min(frameCount - 1, Math.max(0, Math.round(f * (frameCount - 1))));
  }

  function applySel(a: number, b: number): void {
    const from = Math.min(a, b);
    const to = Math.max(a, b);
    sel = { from, to };
    const denom = Math.max(1, frameCount - 1);
    selEl.hidden = false;
    selEl.style.left = (from / denom) * 100 + "%";
    // 单帧选区（from==to）宽度为 0，界面上就"看不见选区了" ⇒ 给一个最小值保证可见
    // （导出仍然按"只导这一帧"处理，视觉宽度只是为了别让用户以为没选上）
    selEl.style.width = Math.max(0.4, ((to - from) / denom) * 100) + "%";
    emit();
  }

  function clearSel(): void {
    if (sel === null) return;
    sel = null;
    selEl.hidden = true;
    emit();
  }

  track.addEventListener("pointerdown", (ev) => {
    if (frameCount <= 0) return;
    const i = indexAt(ev.clientX);
    if (i === null) return;
    // 指针捕获必须能失败：合成事件（自动化测试）里没有"活动的 pointer"，
    // setPointerCapture 会抛 NotFoundError。捕获只是"拖出轨道也不丢事件"的便利，
    // 不该因为拿不到它就让整个选区功能挂掉。
    try {
      track.setPointerCapture(ev.pointerId);
    } catch {
      /* 没有活动指针（合成事件）：继续，捕获失败不影响本轨道内的拖动 */
    }
    dragFrom = i;
    dragMoved = false;
    applySel(i, i);
  });
  track.addEventListener("pointermove", (ev) => {
    if (dragFrom === null) return;
    const i = indexAt(ev.clientX);
    if (i === null || i === dragFrom) return;
    dragMoved = true;
    applySel(dragFrom, i);
  });
  const endDrag = (ev: PointerEvent): void => {
    if (dragFrom === null) return;
    dragFrom = null;
    try {
      if (track.hasPointerCapture(ev.pointerId)) track.releasePointerCapture(ev.pointerId);
    } catch {
      /* 同上 */
    }
    // 完全没拖动 = 单击 ⇒ 取消选区，否则用户没法"清掉选区"
    if (!dragMoved) clearSel();
  };
  track.addEventListener("pointerup", endDrag);
  track.addEventListener("pointercancel", endDrag);
  track.addEventListener("lostpointercapture", () => {
    dragFrom = null;
  });

  return {
    selection: () => sel,
    onSelectionChange(cb) {
      listeners = [...listeners, cb];
    },
    clearSelection: clearSel,
    update(v: TimelineInput): void {
      frameCount = v.frames;
      // 缓冲缩短（清空/换源）后旧选区的下标会指向不存在的帧 ⇒ 直接作废，
      // 否则导出时会导出一段"看起来选了其实没有"的区间
      if (sel !== null && (sel.from >= v.frames || sel.to >= v.frames)) clearSel();

      const sec = v.elapsedMs / 1000;
      const evSpan = Math.min(EVENT_RING_S, sec);
      const frSpan = Math.min(FRAME_RING_S, sec);
      evChunk.style.left = Math.max(0, ((EVENT_RING_S - evSpan) / EVENT_RING_S) * 100) + "%";
      evChunk.style.width = (evSpan / EVENT_RING_S) * 100 + "%";
      frChunk.style.left = Math.max(0, ((EVENT_RING_S - frSpan) / EVENT_RING_S) * 100) + "%";
      frChunk.style.width = (frSpan / EVENT_RING_S) * 100 + "%";
      head.style.left = "calc(" + ((evSpan / EVENT_RING_S) * 100).toFixed(2) + "% - 1px)";

      const mm = Math.floor(sec / 60);
      const ss = sec - mm * 60;
      clock.textContent = String(mm).padStart(2, "0") + ":" + ss.toFixed(1).padStart(4, "0");
      recInd.className = v.recording ? "rec live" : "rec";
      recTxt.textContent = v.recording ? "录制中" : "未录制";

      const full = v.capacityBytes > 0 && v.bufferBytes >= v.capacityBytes;
      right.textContent =
        (v.bufferBytes / 1024 / 1024).toFixed(0) + " MB / " + (v.capacityBytes / 1024 / 1024).toFixed(0) + " MB" +
        " · 帧 " + v.frames +
        (v.evicted > 0 ? " · 已丢最旧 " + v.evicted + " 帧" : "") +
        (full ? " · 缓冲已满" : "");
      right.title =
        "帧环形缓冲默认 " + FRAME_RING_S + " s（事件环 " + EVENT_RING_S + " s）。\n" +
        "超过字节上限就从最旧开始丢，丢了多少记在「已丢最旧」里（原则 P6：不允许静默丢数据）。\n" +
        (sel === null
          ? "当前无选区：导出按钮导出整个缓冲。在时间轴上拖动可圈选片段。"
          : "当前选区：帧 " + sel.from + " ~ " + sel.to + "（导出按钮将只导这一段；单击时间轴可取消选区）。");
      if (sel !== null) {
        selEl.title = "选区：帧下标 " + sel.from + " ~ " + sel.to + "（共 " + (sel.to - sel.from + 1) + " 帧）";
      }
    },
  };
}

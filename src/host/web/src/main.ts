// 前端入口：装配数据源 → 图层栈 → 四窗格 → 侧栏/底栏/状态栏，并驱动唯一一条渲染循环。
// 数据流是单向的（03 文档 §5）：Transport → 解码 → 帧/位图 → 界面状态 → 画布。
// 界面状态（图层开关、冻结、聚焦）绝不回写进帧数据 —— 免得出现"画面与状态不一致"的老问题
// （设计稿踩坑 #4：图层栈写着 L5=关，画布上却画了十字线）。
// 视觉规范必须在这里被引用：否则构建/开发都不会注入样式表，
// 页面会退化成普通文档流（body 默认 8px 边距、窗格被拉成整行）——渲染逻辑对了但看起来全错。
import "./style.css";
import { IPC, PIXEL, decodeEvents, decodeRgb565, getProfile } from "@retina/protocol";
import type { Counters, EventRecord, IpcCtrl, IpcEvents, IpcFrameRaw, IpcMessage, IpcStats, Profile, UartTelemFrame, V3StatusView } from "@retina/protocol";
import { EventBitmap } from "./events.ts";
import {
  EV_ONLY_FLAG,
  EV_NO_RAW_FLAG,
  EvOnlyTracker,
  applyEvOnlyBatch,
  evOnlyLegend,
  evOnlyPaneMeta,
  evOnlyRawBadge,
  type EvOnlyView,
} from "./pipeline/evonly.ts";
import { boardTimeOf } from "./frameTimeline.ts";
import { fmtFixed, fmtInt, fmtScale } from "./format.ts";
import {
  HOST_MINDL_FALLBACK,
  HOST_THETA_FALLBACK,
  toHostParamRpc,
} from "./hostparams.ts";
import {
  ACTION_MAP_STORAGE_KEY,
  ACTION_TARGET_EXPORTER,
  actionClassName,
  actionMapRpcParams,
  loadActionMap,
  noteTriggered,
  saveActionMap,
  shouldTrigger,
  type ActionEventLike,
  type ActionMapConfig,
  type ActionMapStorage,
  type ActionOp,
  type ActionTarget,
  type ActionTriggerMemory,
  type ActionView,
} from "./actionmap.ts";
import { GatewayClient, TRANSPORT_SWITCH_TIMEOUT_MS } from "./ipc/client.ts";
import {
  REC_STATUS_POLL_MS,
  fetchRecStatus,
  formatRecStatus,
  recButtonState,
  recToneColor,
  startRec,
  stopRec,
  type RecStatusWire,
} from "./api/rec.ts";
import { createBackgroundLayer } from "./layers/background.ts";
import { EventsLayer } from "./layers/events.ts";
import { createHudLayer, hudEventInfo } from "./layers/hud.ts";
import { createInteractLayer } from "./layers/interact.ts";
import { createPostprocLayer } from "./layers/postproc.ts";
import { RawLayer } from "./layers/raw.ts";
import { LAYER_PRESETS, LayerStack } from "./layers/stack.ts";
import type { LayerKey, RenderEnv, ViewFrame } from "./layers/types.ts";
import { MotionPredictor } from "./predict/motion.ts";
import { detectBright } from "./postproc.ts";
import { Recorder, type RecordedFrame } from "./recorder.ts";
import { eventOnlyRecordedFrame } from "./recordEventOnly.ts";
import { humanBytes, saveBlob, saveBytes, saveText, timestampedName } from "./export/download.ts";
import { encodeVideo, probeVideoEncoding, videoExt } from "./export/mp4.ts";
import { buildPngSequenceZip } from "./export/pngseq.ts";
import { exportTimesMs } from "./export/times.ts";
import {
  EXPORTERS,
  NO_RAW_EXPORT_REASON,
  clipExportState,
  exportAvailabilityForSelection,
  exporterById,
  type ExporterId,
  type ExporterSpec,
} from "./export/registry.ts";
import { EXPORT_TARGETS, canvasToPngBytes, nativeSize, renderRecordedFrame, replayBitmap, type ExportTarget } from "./export/render.ts";
import { buildDetectionsJson } from "./export/detsjson.ts";
import { buildEventsCsv } from "./export/csv.ts";
import { buildRawBin } from "./export/framebin.ts";
import { StatsAggregator } from "./stats.ts";
import { RecordEventPairing } from "./recpair.ts";
import type { Detection, SourceStatus, ViewStats } from "./types.ts";
import { DEFAULT_PANES, mountPanes, type Pane } from "./ui/panes.ts";
import { mountSidebar } from "./ui/sidebar.ts";
import type { BoardParamAckView } from "./ui/sliderlink.ts";
import { parseTransportView, rawRecoverText } from "./transport_labels.ts";
import type { TransportMode, TransportView } from "./transport_labels.ts";
import { CtrlAckTracker } from "./ctrl_ack.ts";
import { mountStatusBar } from "./ui/statusbar.ts";
import { mountTimeline } from "./ui/timeline.ts";
import { mountToast, type ToastHandle } from "./ui/toast.ts";

const VERSION = "前端 " + "v0.1.0";

// ---------- 启动参数（都走 query，方便演示时开两个窗口对比不同 profile） ----------
const qs = new URLSearchParams(location.search);
const profileName = qs.get("profile") ?? "retina-v2-800x480-1280";
const profile: Profile = getProfile(profileName) ?? (getProfile("retina-v2-800x480-1280") as Profile);
const wsUrl = qs.get("ws") ?? "ws://127.0.0.1:8787";

/**
 * 当前**实际生效**的 profile。
 *
 * 为什么不能直接用上面那个常量（2026-10-06 用户报的 bug）：前端原来只认自己那份硬编码 profile，
 * 从不采用网关的 —— 结果"网关跑 legacy-800x480-1280、界面却显示 retina-v2-800x480-e5"，
 * 连"每帧多少段"都是照着自己那份印出来的假数字。以网关为准才是对的：
 * 解析在网关，前端只负责画。
 */
let activeProfile: Profile = profile;

// ---------- DOM 句柄 ----------
/** 缺元素就直接抛：前端比"少一个 id 然后一堆 null 判断"更该在启动时就炸掉 */
function need(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error("index.html 缺少 #" + id);
  return e;
}
function needSel(sel: string): HTMLElement {
  const e = document.querySelector<HTMLElement>(sel);
  if (!e) throw new Error("index.html 缺少 " + sel);
  return e;
}
const app = need("app");
const stage = need("stage");
const side = need("side");
const status = need("status");
const bottom = needSel(".bottom");
const dotConn = need("dotConn");
const txtConn = need("txtConn");
const txtProfile = need("txtProfile");
const dotAlarm = need("dotAlarm");
const txtAlarm = need("txtAlarm");
const srcBadge = need("srcBadge");
const segMode = need("segMode");
const btnPause = need("btnPause");
const btnSide = need("btnSide");
const btnExportFrame = need("btnExportFrame") as HTMLButtonElement;
const btnExportClip = need("btnExportClip") as HTMLButtonElement;
const btnRec = need("btnRec") as HTMLButtonElement;
const expProg = need("expProg");
const btnExpCancel = need("btnExpCancel") as HTMLButtonElement;
const selFrameTarget = need("selFrameTarget") as HTMLSelectElement;
const recIndEl = need("recInd");

/**
 * 长录控件（task-31）：index.html 不在本任务白名单，所以按钮/胶囊在 main.ts 里动态插到底栏。
 *
 * 这里刻意保留两个并列入口，文案必须能区分：
 *   · btnRec 的「录制（缓冲 96 MB）」= 浏览器内存环形缓冲，刷新即丢；
 *   · btnLongRec 的「长录」= 网关 /rec/* 落盘，刷新页面不影响。
 * 长录的真实状态只来自 GET /rec/status，绝不存在 localStorage 或前端布尔里。
 */
btnRec.textContent = "● 录制（缓冲 96 MB）";
const btnLongRec = document.createElement("button");
btnLongRec.type = "button";
btnLongRec.id = "btnLongRec";
btnLongRec.className = "btn ghost";
btnLongRec.textContent = "● 长录";
btnLongRec.title = "开始网关长录（POST /rec/start）：完整帧进 mp4，事件/帧表落 CSV";
btnLongRec.style.marginLeft = "4px";
recIndEl.insertAdjacentElement("afterend", btnLongRec);

const recLongIndEl = document.createElement("span");
recLongIndEl.id = "recLongInd";
recLongIndEl.className = "rec";
recLongIndEl.style.marginLeft = "8px";
recLongIndEl.style.maxWidth = "760px";
recLongIndEl.style.overflow = "hidden";
recLongIndEl.style.whiteSpace = "nowrap";
const recLongDot = document.createElement("i");
// 两行：主行「视频 46.2 MB · 时长 … · 丢帧 … · 磁盘余量 …」，次行「原始 947 MB · 重开 … · 目录」。
// 原始帧字节绝不能当视频体积显示（task-35：否则用户以为一分钟吃 1 GB）。
const recLongCol = document.createElement("span");
recLongCol.style.display = "flex";
recLongCol.style.flexDirection = "column";
recLongCol.style.minWidth = "0";
recLongCol.style.lineHeight = "1.25";
const recLongTxt = document.createElement("span");
recLongTxt.id = "recLongTxt";
recLongTxt.style.overflow = "hidden";
recLongTxt.style.textOverflow = "ellipsis";
recLongTxt.textContent = "长录 正在连接…";
const recLongSub = document.createElement("span");
recLongSub.id = "recLongSub";
recLongSub.style.fontSize = "10.5px";
recLongSub.style.color = "var(--tx3)";
recLongSub.style.overflow = "hidden";
recLongSub.style.textOverflow = "ellipsis";
recLongSub.style.display = "none";
recLongCol.append(recLongTxt, recLongSub);
recLongIndEl.append(recLongDot, recLongCol);
btnLongRec.insertAdjacentElement("afterend", recLongIndEl);

// ---------- 唯一一份共享状态 ----------
const bitmap = new EventBitmap(profile.evGrid.w, profile.evGrid.h, 0.55);
const aggregator = new StatsAggregator();
/**
 * 事件级运动预测（卡尔曼 CV）。只吃 EventRecord：串口 EV_ONLY 没有 raw 也照样工作。
 * 尺寸在 adoptGatewayProfile 里已被限制为"与本地 evGrid 相同"才采用，因此不需要重建。
 */
const motion = new MotionPredictor(profile.evGrid.w, profile.evGrid.h);
const motionConfig = { enabled: true, horizonS: 1.0 };
const layerOn: Record<LayerKey, boolean> = {
  BACKGROUND: true, RAW: true, EVENTS: true, HUD: true, POSTPROC: true, INTERACT: false,
};
const stack = new LayerStack(layerOn);
stack.add(createBackgroundLayer());
stack.add(new RawLayer());
stack.add(new EventsLayer());
stack.add(createHudLayer());
stack.add(createPostprocLayer());
stack.add(createInteractLayer());

let current: ViewFrame | null = null;
let detections: readonly Detection[] = [];
let rgba: Uint8ClampedArray | null = null;
let frozen = false;
let presetIdx = 0;
let renderMs = 0;
let connected = false;
let sourceStatus: SourceStatus = { kind: "synth", connected: false, detail: "初始化…" };

/**
 * A1：事件按 frameIdx 进城。`Map` 的插入序就是到达序，淘汰队头即淘汰最旧的键。
 *
 * 为什么要进城（2026-10-09 KEY3 撕裂）：EVENTS 与 FRAME_RAW 是两条 IPC 消息，
 * 原来 EVENTS 一到就 `bitmap.apply()`，而底图永远是"最新那一帧" ⇒ 屏幕上是
 * 底图(M) + 事件(N∪N-1∪…∪N-k)。进城后**底图与事件在同一个 frameIdx 上写入共享状态**，
 * rAF 一渲染四面板自然同帧。存活条目数给上限：慢客户端/背压时键可能永远等不到自己的帧
 * （网关丢 FRAME_RAW 时事件照推，见 gateway/src/ipc/ws.ts 的 uiDrop 分支）。
 */
const evQueue = new Map<number, EventRecord[]>();
/** 存活键上限（≈ 8 帧 @3.25 fps ≈ 2.5 s 的事件；再多说明帧根本没到，等不到） */
const EV_QUEUE_MAX_KEYS = 8;

function evQueuePush(frameIdx: number, records: readonly EventRecord[]): void {
  if (records.length === 0) return;
  const hit = evQueue.get(frameIdx);
  if (hit === undefined) evQueue.set(frameIdx, records.slice());
  else for (const r of records) hit.push(r);
  while (evQueue.size > EV_QUEUE_MAX_KEYS) {
    const oldest = evQueue.keys().next();
    if (oldest.done === true) break;
    evQueue.delete(oldest.value);
  }
}

/**
 * EV_ONLY（板端 KEY3 第三档）批次追踪：板端 mode=2 时不发 FRAME_RAW，事件批到即上屏（见 pipeline/evonly.ts）。
 * 独立于 evQueue：EV_ONLY 批没有对应的帧，进队列只会白占键位、永远等不到自己的帧。
 */
const evTracker = new EvOnlyTracker();
let evOnlyView: EvOnlyView = evTracker.view(0);
// F1（2026-10-17 六修）：EV_ONLY 与「上位机模拟处理」天生冲突 —— host 模式的事件由原始帧算出，
// 而 EV_ONLY 没有 FRAME_RAW ⇒ 页面必然全黑。检测到板端 EV_ONLY 时自动切到板端事件源，
// 并记住用户原来的选择，RAW_EV 恢复后再还回去（不吞用户意图）。
let evOnlyAutoSource = false;
/** 网关 STATS 报的通道能力：false = 串口 UART-LINK（天生没有原始画面）。null = 还没收到 */
let sourceRawCapable: boolean | null = null;
let evOnlySavedSource: "host" | null = null;

/**
 * A6：rAF 渲染那一刻的"画面所依据的量"。
 *
 * `current` 每帧整体换新对象，所以持有引用就等于持有一份快照。面板标题（5 Hz 的 `refreshUi`）
 * 改读它，就不再出现"标题比画布旧 200 ms"（分析报告 §1.5：截图实测差 2~4 帧）。
 */
let uiSnapshot: { frame: ViewFrame | null; activeCells: number; detections: number } = {
  frame: null, activeCells: 0, detections: 0,
};

// ---------- 录制（内存环形缓冲） ----------
/**
 * 录制的真实内容：**原始帧字节 + 该帧的事件 + 该帧的检测框 + 当时的统计快照**。
 *
 * 之前这里只有 `recording` 一个布尔和两个时间戳 —— 也就是"录制"只是给时间轴计时，
 * 按下 R 什么都不会被保存（2026-10-06 用户反馈"点了导出没反应"时发现的）。
 * 现在按 R 是真的在录：96 MB 上限的环形缓冲 ≈ 3.25 fps 下 30 s（与底栏文案一致）。
 */
const recorder = new Recorder({ maxBytes: 96 * 1024 * 1024, maxFrames: 600 });
let recording = false;
let recStartedAtMs = 0;
let recElapsedMs = 0;
/**
 * 录制侧的事件配对账本（A5 口径：EVENTS(N) 先到、FRAME_RAW(N) 后到、同帧号配对）。
 *
 * 修前的旧写法是 `pendingEventsFor === m.frameIdx`（只有"事件**晚于**同帧 FRAME_RAW 到达"
 * 才补进录制帧）。而 2026-10-09 KEY3 撕裂修复 A5 之后，网关（板源/回放/网关合成源）与
 * 页内合成源都保证事件先到 ⇒ 旧写法一条都配不上，录制帧的 `events` 永远空数组
 * （CSV 只剩表头）。语义与理由见 recpair.ts 的头注释，取证见
 * `docs/05_实验与实测/录制配对修复_20261013/录制配对修复报告.md`。
 *
 * 录制要在 FRAME_RAW 到达时就存像素（否则丢帧），所以账本必须由**这一层**持有并交给
 * 录制记录（同一个数组对象），晚到的事件才能补进同一帧 —— 这是 recorder.ts 的浅拷贝契约。
 */
const recPair = new RecordEventPairing();
let exportTarget: ExportTarget = "overlay";

/** 导出取消标志：导出是异步长任务，用户得有办法中止（96 MB 的 zip 要压好几秒） */
let exportCancelled = false;
let exporting = false;

/** 最近一批事件是不是上位机同构算法算的（IPC 首部的 FLAG_HOST_SIM）—— L2 上要标出来源 */
let hostSimEvents = false;
/**
 * 上位机算法的 θ（只有「上位机模拟处理」档位可调；板端要同步需重编比特流）。
 *
 * 默认值来自 `@retina/retina` 的 `HOST_SIM_DEFAULT_THETA`（当前 1），**故意不等于板端的 44**：
 * 现场实测板端默认 44 在本场景下是 1.1 事件/帧（等于全黑）。理由与实测表见包层注释。
 */
let hostTheta = HOST_THETA_FALLBACK;
/** 上位机算法的守卫（最小 |ΔL|） */
let hostMinDl = HOST_MINDL_FALLBACK;
/** 最近一次 board.setParam 的 ACK 结果（侧栏"板端 θ/δL"下方就地回显；null=还没下发过） */
let boardParamAck: BoardParamAckView | null = null;
let boardParamAckRev = 0;
let stats: ViewStats = aggregator.snapshot(performance.now());
let pointer: { x: number; y: number; down: boolean } | null = null;

/** SET_PARAM 的结果就地回显：只改状态 + 触发一次界面刷新（toast 仍保留给"动作回执"） */
function noteBoardParamAck(ack: BoardParamAckView): void {
  boardParamAck = ack;
  boardParamAckRev += 1;
  refreshUi();
}

// ---------- 动作映射（M4：byte23 → 浏览器映射 → setRecording） ----------
/**
 * localStorage 的安全包装：隐私模式/禁用存储时 getItem 会直接抛。
 * 这里失败不阻断启动 —— 动作识别是辅助功能，不能让整个监控页起不来；
 * 但读失败会由 loadActionMap 转成"默认值 + warning"，写失败在 onActionConfig 里 toast。
 */
const actionStorage: ActionMapStorage = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
};
/** 卡片"已保存到浏览器"提示：只有 localStorage 里真的有 actionMap 键才算 */
let actionSaved = false;
try {
  actionSaved = window.localStorage.getItem(ACTION_MAP_STORAGE_KEY) !== null;
} catch {
  // 读取抛错交给 loadActionMap 的 warning 通路，这里不重复报
}
const actionLoaded = loadActionMap(actionStorage, Date.now());
const actionLoadWarning = actionLoaded.warning;
let actionConfig: ActionMapConfig = actionLoaded.config;
let actionView: ActionView | null = null;
/** 长轮询游标：-1 = 还没初始化（首次只对齐 lastSeq，绝不执行历史事件） */
let actionLastSeq = -1;
/** 最近一条动作事件（卡片状态行用；事件环里的最新一条） */
let actionLastEvent: { seq: number; className: string; tMs: number } | null = null;
/** 本页打开以来的动作识别计数：只数 VALID=1 且 class∈{1,2} 的事件，不受 minConf/边沿/冷却影响 */
/** 网关 /api/action 的累计检测次数（task-24：VALID 上升沿或类别变化；只读） */
let actionGateCount = 0;
/** 网关映射镜像的来源（/api/action/config 读回；浏览器推过 config.set 后应为 ui） */
let actionConfigSource: "ui" | "default" = "default";
/** "上一条已执行结果"：只由执行成功时推进；观察侧不碰 */
const actionTrigMem: ActionTriggerMemory = { lastClass: null, lastExecAtMs: 0 };
/** startAndAutoExport 待办的导出目标：setRecording(false) 分支末尾消费一次 */
let actionAutoExportTarget: ActionTarget | null = null;

// ---------- 组件 ----------
const stageEl = stage;
const panes = mountPanes(stageEl, DEFAULT_PANES);
const sidebar = mountSidebar(side, toggleLayer, rpcFromUi, notify, onHostParam, {
  // —— v3 板端下行（WIRE-V3 §6/§7.2）：全部走 board.* RPC，结果经 TYPE_CTRL/STATS 回显 ——
  onBoardParam: (patch) => {
    void client.rpc("board.setParam", patch).then((r) => {
      const atMs = performance.now();
      if (r === null) {
        noteBoardParamAck({ ok: false, status: null, detail: "网关无响应（3 s 超时）", theta: null, minDl: null, atMs });
        notify("板端参数未下发成功：网关无响应（3 s 超时）", "error");
        return;
      }
      if ("error" in r) {
        noteBoardParamAck({ ok: false, status: null, detail: r.error.message, theta: null, minDl: null, atMs });
        notify("板端参数下发失败：" + r.error.message, "error");
        return;
      }
      const res = r.result as {
        ok?: boolean;
        status?: number;
        detail?: string;
        tlvs?: { theta?: number | null; minDl?: number | null };
      };
      const back = res.tlvs;
      noteBoardParamAck({
        ok: res.ok === true,
        status: typeof res.status === "number" ? res.status : null,
        detail: String(res.detail ?? (res.ok === true ? "" : "未知原因")),
        theta: typeof back?.theta === "number" ? back.theta : null,
        minDl: typeof back?.minDl === "number" ? back.minDl : null,
        atMs,
      });
      if (res.ok === true) {
        notify(
          "板端参数已写入" +
            (back?.theta !== null && back?.theta !== undefined ? " θ=" + back.theta : "") +
            (back?.minDl !== null && back?.minDl !== undefined ? " δL=" + back.minDl : "") +
            "（ACK 读回值）",
          "ok",
        );
      } else {
        notify("板端参数写入被拒：" + String(res.detail ?? "未知原因"), "error");
      }
    });
  },
  onBoardMode: (mode) => {
    void client.rpc("board.setMode", { mode }).then((r) => {
      if (r === null) {
        notify("模式切换未下发成功：网关无响应（3 s 超时）", "error");
        return;
      }
      if ("error" in r) {
        notify("模式切换失败：" + r.error.message, "error");
        return;
      }
      const res = r.result as { ok?: boolean; detail?: string; tlvs?: { mode?: number | null } };
      if (res.ok === true) {
        notify("板端模式已切换：" + modeLabel(res.tlvs?.mode ?? mode) + "（ACK 读回；帧边界生效 ≤2 帧）", "ok");
      } else {
        notify("板端模式切换被拒：" + String(res.detail ?? "未知原因"), "error");
      }
    });
  },
  onBoardCalibrate: () => {
    void client.rpc("board.calibrate", {}).then((r) => {
      if (r === null) {
        notify("校准未下发成功：网关无响应（3 s 超时）", "error");
        return;
      }
      if ("error" in r) {
        notify("校准失败：" + r.error.message, "error");
        return;
      }
      const res = r.result as { ok?: boolean; detail?: string };
      if (res.ok === true) notify("时间校准完成（offset 已写入板端）", "ok");
      else notify("时间校准未完成：" + String(res.detail ?? "ACK 超时"), "warn");
    });
  },
  // 事件支路开关（v3.1 增补 EV_EN=0x05）：状态以板端读回为准（TLV 0x8C，v3.1 对齐）
  onBoardEvEn: (enabled) => {
    void client.rpc("board.evEn", { enabled }).then((r) => {
      if (r === null) {
        notify("事件支路开关未下发成功：网关无响应（3 s 超时）", "error");
        return;
      }
      if ("error" in r) {
        notify("事件支路开关失败：" + r.error.message, "error");
        return;
      }
      const res = r.result as { ok?: boolean; detail?: string; tlvs?: { evEn?: boolean | null } };
      if (res.ok === true) {
        // 板端 ACK 带 TLV 0x8C 写后读回；读回与请求不一致时明确说出（板端是真值源）
        const back = res.tlvs?.evEn;
        const state = (back ?? enabled) ? "使能" : "禁用";
        const mismatch = typeof back === "boolean" && back !== enabled ? "（⚠ 板端读回与请求不一致）" : "";
        const src = typeof back === "boolean" ? "板端读回 TLV 0x8C" : "下发值（ACK 未带读回）";
        notify("事件支路当前为「" + state + "」（" + src + "）" + mismatch, "ok");
      } else {
        notify("事件支路开关被拒：" + String(res.detail ?? "未知原因"), "error");
      }
    });
  },
  onBoardDecim: (v) => {
    void client.rpc("board.setParam", { frameDecim: v }).then((r) => {
      if (r === null) {
        notify("抽帧比未下发成功：网关无响应（3 s 超时）", "error");
        return;
      }
      if ("error" in r) {
        notify("抽帧比下发失败：" + r.error.message, "error");
        return;
      }
      const res = r.result as { ok?: boolean; detail?: string };
      if (res.ok === true) notify("FRAME_DECIM=" + v + " 已写入板端（ACK OK）", "ok");
      else notify("抽帧比写入被拒：" + String(res.detail ?? "未知原因"), "error");
    });
  },
  // 曝光上限（**sccb 集成 tag 0x0B**，sccb 集成报告 §9.1/§9.4）：状态以板端读回为准（TLV 0x90，写后读回 = 本次写入值）
  onBoardExpCap: (v) => {
    void client.rpc("board.setParam", { expCap: v }).then((r) => {
      if (r === null) {
        notify("曝光上限未下发成功：网关无响应（3 s 超时）", "error");
        return;
      }
      if ("error" in r) {
        notify("曝光上限下发失败：" + r.error.message, "error");
        return;
      }
      const res = r.result as { ok?: boolean; detail?: string; tlvs?: { expCap?: number | null } };
      if (res.ok === true) {
        const back = res.tlvs?.expCap;
        const hex = (n: number): string => "0x" + n.toString(16).toUpperCase().padStart(4, "0");
        if (typeof back === "number") {
          const mismatch = back !== v ? "（⚠ 板端读回 " + back + " " + hex(back) + " 与请求不一致）" : "";
          notify("曝光上限已写入 " + back + " 行 " + hex(back) + "（板端读回 TLV 0x90；约 1 ms 内重跑整条曝光寄存器写序列）" + mismatch, "ok");
        } else {
          // 旧固件（ACK 不带 0x90）措辞必须与"读到板端真值"区分开，否则读回缺失会被误当成写成功
          notify("EXP_CAP=" + v + " 已下发（ACK OK，但未带 TLV 0x90 读回 —— 旧固件或读回缺失）", "warn");
        }
      } else {
        notify("曝光上限写入被拒：" + String(res.detail ?? "未知原因"), "error");
      }
    });
  },
}, {
  // —— 传输方式选择（UART 路线 §8.2 H7）：走 config.set {transport, serialPort} ——
  // 网关侧是"先建后拆"：新通道打不开 ⇒ RPC 回 -32000 + 明确文案，**当前通道不动**（不中断画面）
  onSelect: (mode, force) => applyTransport({ transport: mode, ...(force === true ? { force: true } : {}) }),
  onApplyPort: (path) => {
    // 当前在串口档 ⇒ 连通道一起重建（改了口要真的生效）；否则只记下，下次切串口时用
    const onUart = (transportView?.active ?? transportView?.decision?.active) === "uart";
    applyTransport({ serialPort: path, ...(onUart ? { transport: "uart" as TransportMode } : {}) });
  },
  // B：4 档切档（串口主通道走完整重开舞蹈；网口主通道只切板端）
  onSetBaud: (baud) => applySerialBaud(baud),
}, onMotion, {
  // —— 动作映射/文档（M4）：卡片只改本地状态，持久化与 WS 推送都在本文件收口 ——
  onConfig: (cfg) => onActionConfig(cfg),
  onOpenApiDoc: () => openActionApiDoc(),
});

/**
 * 传输切换是否进行中（B1）。
 * 期间禁用档位 chip：切换本身要 2 s（开 COM6 + 3 次握手），现场用户会连点三四次，
 * 每次都在网关侧排队重建通道 —— 状态机自己的响应比手动重试更慢。
 */
let transportSwitching = false;

/**
 * 用网关的**实际状态**回写传输卡（B2）。
 *
 * 为什么失败/超时也要拉一次：网关侧切串口可能是"已经切过去了，只是响应在路上/丢了"
 * （实测 udp→uart 1996 ms，旧 3 s 超时在慢机器上就误判成"网关无响应"）。
 * 界面若停留在旧的"网口"上，而网关在串口档，人看到的就是"画面没了、切回网口也没反应"。
 * config.get 不带 transport（只有 session.snapshot 带），所以这里用 snapshot。
 */
function refreshTransportFromGateway(): void {
  void client.rpc("session.snapshot").then((r) => {
    if (r === null || "error" in r) return;
    const snap = r.result as { transport?: unknown };
    if (snap.transport !== undefined) adoptTransport(snap.transport);
    transportRev++;
    refreshUi();
  });
}

/**
 * 传输方式切换的唯一出口（UDP / UART / 自动 + 串口号）。
 *
 * 为什么失败也要把网关原话弹出来：COM6 打不开是**最常见**的现场故障
 * （驱动没装 / 被串口助手占用 / 口不对），网关给的文案里带着"当前可用串口"清单，
 * 比"切换失败"四个字有用得多。
 * 为什么用 20 s 专用超时：见 ipc/client.ts 的 TRANSPORT_SWITCH_TIMEOUT_MS。
 */
function applyTransport(params: { transport?: TransportMode; serialPort?: string; force?: boolean }): void {
  if (!connected) {
    notify("未连接网关，传输方式未切换", "warn");
    return;
  }
  if (transportSwitching) {
    notify("传输方式正在切换中（最长 20 s），本次点击已忽略", "info");
    return;
  }
  const label = params.transport === undefined
    ? "串口号 " + String(params.serialPort)
    : params.transport === "auto" ? "自动（先网口后串口）" : params.transport === "udp" ? "网口" : "串口";
  // A2：点当前 active 档 = 强制重建；toast 必须说"重新连接"而不是"切换"（用户点的是同一个档）
  if (params.force === true) notify("正在重新连接「" + label + "」…", "info");
  transportSwitching = true;
  transportRev++; // 让传输卡立刻显示"切换中…"（不等切换结果）
  refreshUi();
  void client
    .rpc("config.set", params, TRANSPORT_SWITCH_TIMEOUT_MS)
    .then((r) => {
      if (r === null) {
        // 超时或网关掉线：不能只说"失败" —— 网关可能已经切了，必须回读实际状态
        notify("传输方式切换无响应（已等 20 s）—— 正在用网关实际状态回写界面…", "warn");
        refreshTransportFromGateway();
        return;
      }
      if ("error" in r) {
        notify("传输方式切换失败：" + r.error.message + "（已保持当前通道，未中断数据）", "error");
        refreshTransportFromGateway();
        return;
      }
      const res = r.result as { decision?: unknown; uart?: unknown; probes?: unknown; health?: unknown };
      if (res.decision !== undefined) adoptTransport(res);
      const d = transportView?.decision ?? null;
      const txt = d === null ? label : (d.active === "uart" ? "串口（仅事件回传）" : "网口（三模式全可选）");
      const verb = params.force === true ? "已重新连接 " : "传输方式已切换为 ";
      notify(verb + txt + (d?.degraded ? "；⚠ 降级档：MODE1 只原画不可用" : ""), "ok");
    })
    .catch(() => {
      notify("传输方式切换失败（前端异常）：正在用网关实际状态回写界面…", "error");
      refreshTransportFromGateway();
    })
    .finally(() => {
      transportSwitching = false;
      transportRev++;
      refreshUi();
    });
}
/**
 * B：波特率切档的唯一前端出口。
 * 串口主通道在网关侧要"板端 ACK → 关旧口 → 新档重开 → 3×GET_STATUS 验证"（约 1–4 s），
 * 因此复用传输切换的 20 s 超时和 busy 互斥；失败时网关会回退旧档并把原因放在 error.message。
 * 成功后必须回读 lastBaudSwitch，不能只信"请求已发出"。
 */
function applySerialBaud(baud: number): void {
  if (!connected) {
    notify("未连接网关，波特率未切换", "warn");
    return;
  }
  if (transportSwitching) {
    notify("传输/切档正在进行中，本次点击已忽略", "info");
    return;
  }
  const label = baud + " baud";
  notify("正在切换串口波特率到 " + label + "…（板端确认 + 主机重开串口，最长 20 s）", "info");
  transportSwitching = true;
  transportRev++;
  refreshUi();
  void client
    .rpc("config.set", { serialBaud: baud }, TRANSPORT_SWITCH_TIMEOUT_MS)
    .then((r) => {
      if (r === null) {
        notify("波特率切换无响应（已等 20 s）—— 正在用网关实际状态回写界面…", "warn");
        refreshTransportFromGateway();
        return;
      }
      if ("error" in r) {
        notify("波特率切换失败：" + r.error.message, "error");
        refreshTransportFromGateway();
        return;
      }
      adoptTransport(r.result);
      const sw = transportView?.lastBaudSwitch;
      const uartMain = (transportView?.active ?? null) === "uart";
      if (sw !== undefined && sw.ok) {
        notify(
          "波特率已切换并确认：" + label + (uartMain ? "（串口已按新档重开，握手通过）" : "（板端已确认；主机网口通道不变）"),
          "ok",
        );
      } else {
        notify("板端波特率命令已确认：" + label, "ok");
      }
    })
    .catch(() => {
      notify("波特率切换失败（前端异常）：正在用网关实际状态回写界面…", "error");
      refreshTransportFromGateway();
    })
    .finally(() => {
      transportSwitching = false;
      transportRev++;
      refreshUi();
    });
}

/**
 * 运动预测卡片的唯一入口（开关 / 时域滑条）。
 * 即时生效：不重启、不重连、不重建预测器（轨迹保留，改了时域只改外推长度），下一帧 HUD 就是新值。
 * 时域在前端再夹一次：滑条能输任意数字，0.2–1.5 s 是算法可解释区间（更短看不出趋势，更长外推误差发散）。
 */
function onMotion(cfg: { enabled?: boolean; horizonS?: number }): void {
  if (cfg.enabled !== undefined) motionConfig.enabled = cfg.enabled;
  if (cfg.horizonS !== undefined && Number.isFinite(cfg.horizonS)) {
    motionConfig.horizonS = Math.max(0.2, Math.min(1.5, Math.round(cfg.horizonS * 10) / 10));
  }
  refreshUi();
}

const statusbar = mountStatusBar(status, VERSION);
const timeline = mountTimeline(bottom);
const toast: ToastHandle = mountToast(app);
/** 十修：心跳 ACK 静默；recent 即"最近命令"列表（心跳不进入） */
const ackTracker = new CtrlAckTracker();

/** 统一的"给用户一句话"出口：所有吞掉点击的地方都必须经过它 */
function notify(message: string, tone: "info" | "ok" | "warn" | "error" = "info"): void {
  toast.show(message, tone);
}

// 动作映射读取异常必须在界面启动后立刻说一次（用户要能区分"默认值"与"我配的值丢了"）
if (actionLoadWarning !== null) notify(actionLoadWarning, "warn");

// ---------- 数据源 ----------
/**
 * 切换数据源 / 事件来源时，把"上一份来源的残留"全部清掉。
 *
 * 不清会怎样（2026-10-06 用户报的 bug）：从"合成源"切回"实时"后，
 * 合成源留下的**事件余晖**永远冻在 L2/L3 上（因为衰减只挂在事件消息上，而实时通路可能一个事件都不发），
 * 统计窗口也混着两份来源的数字 —— 界面上看起来就是"切了但没刷新"。
 */
function resetView(reason: string): void {
  bitmap.reset();
  aggregator.reset();
  current = null;
  detections = [];
  rgba = null;
  // 换了数据源就把录制缓冲作废：混着两种来源的帧导出去，事后没人能说清那段视频是什么。
  // （宁可丢掉已录的，也不要产出一份自相矛盾的证据。）
  recorder.clear();
  recPair.clear();
  evQueue.clear();
  evTracker.reset();
  motion.reset();
  evOnlyView = evTracker.view(0);
  notify(reason + (recording ? "（录制缓冲已清空）" : ""), "info");
}

function onMessage(m: IpcMessage): void {
  const now = performance.now();
  if (m.type === "FRAME_RAW") handleFrame(m, now);
  else if (m.type === "EVENTS") handleEvents(m, now);
  else if (m.type === "CTRL") handleCtrl(m);
  else handleStats(m, now);
}

function handleFrame(m: IpcFrameRaw, now: number): void {
  // RAW_EV 恢复：有原始帧就说明板端不再 EV_ONLY，把 F1 自动切走的源还给用户
  noteEvOnlyCleared();
  // 段数是网关的推流单位（profile.chunksPerFrame 段/帧），状态栏"包率"要的是它，不是消息数
  aggregator.addFrameRaw(now, m.raw.length, activeProfile.chunksPerFrame);
  // 真实原始帧到了 ⇒ 配帧通路恢复（切回 KEY3 的 R+E 档），EV_ONLY 角标必须立刻退场
  evTracker.noteRawFrame(now);
  if (frozen) {
    aggregator.bumpUiDrop(); // 冻结期间丢的帧必须计数：原则 P6 不允许静默丢数据
    return;
  }
  // ★ 衰减挂在"每帧"上，不挂在"每条事件消息"上。
  //   v1（legacy）通路没有事件段，若只在 handleEvents 里衰减，旧来源的余晖就永不消散。
  bitmap.step();
  // A3：取本帧那一份事件来置位。**命中即删除；未命中不置位** —— 宁可不画，也不把别的帧的事件画到这一帧上。
  // （A5 让网关把 EVENTS 排在 FRAME_RAW 之前，否则事件永远迟到一帧、本帧必然未命中。）
  const evThisFrame = evQueue.get(m.frameIdx);
  if (evThisFrame !== undefined) {
    evQueue.delete(m.frameIdx);
    if (evThisFrame.length > 0) bitmap.apply(evThisFrame);
  }
  // 比本帧更旧的事件等不到自己的帧了（那几帧已被网关按背压丢掉），清掉，别占着键位
  for (const k of [...evQueue.keys()]) if (k < m.frameIdx) evQueue.delete(k);
  if (!rgba || rgba.length !== m.w * m.h * 4) rgba = new Uint8ClampedArray(m.w * m.h * 4);
  const order = m.pixel === PIXEL.RGB565_LE ? "LE" : "BE";
  decodeRgb565(m.raw, rgba, order);
  detections = detectBright(rgba, m.w, m.h);
  current = {
    frameIdx: m.frameIdx, w: m.w, h: m.h, raw: m.raw, byteOrder: order,
    tArriveMs: m.tArriveMs, synthetic: (m.flags & IPC.FLAG_SYNTHETIC) !== 0, chunks: activeProfile.chunksPerFrame,
  };
  if (recording) {
    // 2026-10-13 录制配对修复：账本按 frameIdx 取 —— 事件先到（A5 序）时它已经攒好，
    // 事件晚到时返回空数组、由 handleEvents 补进同一个数组（见 recpair.ts 的契约）。
    const ev = recPair.attach(m.frameIdx);
    recorder.push({
      frameIdx: m.frameIdx,
      tMs: Date.now(),
      // 板端时间轴（WIRE-V3 §4.3）：v3 帧带、v2 帧/TS_VALID=0 缺省 —— 装配点抽到
      // frameTimeline.ts（F4 起可被单测钉住），导出侧整体择源（export/times.ts）
      ...boardTimeOf(m),
      w: m.w,
      h: m.h,
      pixel: order === "LE" ? "RGB565_LE" : "RGB565_BE",
      raw: m.raw,
      events: ev,
      detections,
      stats: { ...stats },
    });
  }
}

function handleEvents(m: IpcEvents, now: number): void {
  if ((m.flags & EV_ONLY_FLAG) !== 0) noteEvOnlyDetected();
  const dec = decodeEvents(m.data, m.recBytes);
  hostSimEvents = (m.flags & IPC.FLAG_HOST_SIM) !== 0;
  // 运动预测只吃事件：放在 EV_ONLY 分支之前，串口/板端 EV_ONLY（无 raw）与普通配帧模式走同一条路径。
  // frozen 时不喂：冻结是"画面停在这一刻"，轨迹继续动会与画面自相矛盾。
  if (!frozen) motion.feed(dec.records, now);
  // EV_ONLY（板端 KEY3 第三档，mode=2）：板端**不发 FRAME_RAW**，事件包 FRAME_IDX 还冻结不动。
  // 网关已按 ~40 ms 时间窗把纯事件包打成批、给了自增逻辑帧号并置 FLAG_EV_ONLY ⇒ 这里**批到即上屏**：
  // 每批恰好 step 一次（与配帧模式的"每帧一次"同构）+ apply，统计记"批次"。
  // 不进 evQueue（没有帧会来取，攒着只会白占键位并最终被 8 键上限挤掉）；也不进 recPair（没有帧可配对）。
  if ((m.flags & EV_ONLY_FLAG) !== 0) {
    // NO_RAW（串口 UART-LINK）与板端 EV_ONLY 共用"立即上屏"通路，但文案必须区分：串口永远没有原始段
    const noRaw = (m.flags & EV_NO_RAW_FLAG) !== 0;
    applyEvOnlyBatch(bitmap, aggregator, evTracker, now, m.frameIdx, dec.records, m.data.length, frozen, noRaw);
    if (recording) {
      // 事件-only 帧也必须进录制账本：导出按钮的可用性、事件流 CSV、检测结果 JSON
      // 全都看 recorder.frames。以前这里直接 return，于是"录制中"却 0 帧、导出全灰。
      // 只进录制缓冲，不进事件配对账本：这里没有 FRAME_RAW 可配对，配对账本记的是"事件等到的像素帧"。
      recorder.push(eventOnlyRecordedFrame({
        frameIdx: m.frameIdx,
        tMs: Date.now(), // 与 handleFrame 的 tMs 同时间基；now 是 performance.now，不能混轴
        w: activeProfile.frame.w,
        h: activeProfile.frame.h,
        events: dec.records,
      }));
    }
    return;
  }
  let on = 0;
  let off = 0;
  for (const r of dec.records) {
    if (r.pol === 1) on++;
    else off++;
  }
  if (!frozen) {
    // A2/A4：原来在这里"到达即置位"（现为 A1 的 evQueuePush），置位点已挪到 handleFrame，
    // 与底图共用同一个 frameIdx。衰减仍由 handleFrame 做过（每帧一次）。
    evQueuePush(m.frameIdx, dec.records);
  }
  // 补进录制账本。**必须按 frameIdx 配对**：慢客户端丢帧时 EVENTS 可能属于更早的帧，
  // 直接 push 会让"这一帧的事件"错位到别的帧上（画面上完全看不出来，导出的 CSV 却是错的）。
  // A5 之后事件通常**先到**（帧还没到，账本先攒着）；板端解耦事件包则可能晚到
  // （帧已录下，补进同一个数组）。两种顺序由 recPair 统一处理。
  if (recording) recPair.add(m.frameIdx, dec.records);
  aggregator.addEvents(now, dec.records.length, m.data.length, on, off);
}

function handleStats(m: IpcStats, now: number): void {
  // 网关 STATS（F1 ADDITIVE）也会报 boardMode/evOnlyActive：即使本轮 EV_ONLY 批还没到（或全被慢连接丢掉），
  // 前端也能先切事件源，避免用户继续盯着必然全黑的 host 模拟档。
  if (m.evOnlyActive === true || m.boardMode === 2) noteEvOnlyDetected();
  if (typeof m.rawCapable === "boolean") sourceRawCapable = m.rawCapable;
  if (typeof m.clients === "number") gwClients = m.clients;
  if (typeof m.slowClients === "number") gwSlowClients = m.slowClients;
  aggregator.addStats(now, m.stats.packets, m.stats.bytes, m.counters);
  // v3 状态随 STATS 每 1 Hz 刷新（WIRE-V3 §7.2）；网关未启用 v3 时字段缺省
  if (m.v3 !== undefined) adoptV3Status(m.v3);
  // 传输/串口状态同频刷新（UART 路线）：串口卡的定帧健康度/遥测直读靠它
  if (m.transport !== undefined) adoptTransport(m.transport);
}

// ---------- v3 板端状态（WIRE-V3 §7.2） ----------
/**
 * 网关推来的 v3 状态视图：模式徽标 / 校准状态 / 板端参数读回值都从这里来。
 * 只在"值变了"时刷新侧栏，避免 1 Hz 的 STATS 把正在输入的板端参数框拽回去。
 */
let v3Status: V3StatusView | null = null;
let v3StatusRev = 0;
// F2：网关在线客户端/慢连接（STATS ADDITIVE 字段；旧连接残留会在状态条看到）
let gwClients = 0;
let gwSlowClients = 0;

function adoptV3Status(v: V3StatusView): void {
  const prev = v3Status;
  const changed =
    prev === null ||
    prev.mode !== v.mode ||
    prev.tsCalibrated !== v.tsCalibrated ||
    prev.tsStale !== v.tsStale ||
    prev.theta !== v.theta ||
    prev.minDl !== v.minDl ||
    prev.evEn !== v.evEn ||
    // UART 扩展状态（板端实现报告 §3.3）：变化同样要回写侧栏
    prev.evRes !== v.evRes ||
    prev.netState !== v.netState ||
    // 曝光上限读回（sccb 集成 TLV 0x90，2026-10-13）：变了同样要回写侧栏输入框/状态
    prev.expCap !== v.expCap ||
    prev.serState?.decim !== v.serState?.decim ||
    prev.serState?.agg !== v.serState?.agg ||
    prev.serState?.uartEvDrop !== v.serState?.uartEvDrop ||
    prev.calFailures !== v.calFailures ||
    prev.downlinkAvailable !== v.downlinkAvailable;
  v3Status = v;
  if (changed) v3StatusRev++;
}

/**
 * 传输/串口状态（UART 路线）：网关 LiveTransportManager.statusView() 的宽容视图。
 * 只比较"会变的字段"来决定是否 +rev —— 1 Hz STATS 不能反复重写输入框。
 */
let transportView: TransportView | null = null;
let transportRev = 0;
let uartTelem: UartTelemFrame | null = null;

function adoptTransport(raw: unknown): void {
  const next = parseTransportView(raw);
  if (next === null) return;
  const prev = transportView;
  const d = next.decision;
  const p = prev?.decision ?? null;
  const u = next.uart;
  const pu = prev?.uart ?? null;
  const changed =
    prev === null ||
    p === null ||
    d === null ||
    p.mode !== d.mode ||
    p.state !== d.state ||
    p.active !== d.active ||
    p.secondary !== d.secondary ||
    p.degraded !== d.degraded ||
    p.reason !== d.reason ||
    pu === null ||
    u === null ||
    pu.path !== u.path ||
    pu.open !== u.open ||
    pu.handshakeOk !== u.handshakeOk ||
    pu.handshakeDetail !== u.handshakeDetail ||
    pu.deframer?.v3Frames !== u.deframer?.v3Frames ||
    pu.deframer?.resyncs !== u.deframer?.resyncs ||
    pu.deframer?.bytesDropped !== u.deframer?.bytesDropped ||
    pu.deframer?.telemFrames !== u.deframer?.telemFrames ||
    pu.telemetry?.frameCnt !== u.telemetry?.frameCnt ||
    // B3/B4：串口 rx 速率、累计字节、最近收包龄、通道健康都要驱动传输卡刷新
    pu.rxBps !== u.rxBps ||
    pu.rxBytes !== u.rxBytes ||
    pu.lastRxAgeMs !== u.lastRxAgeMs ||
    pu.lastV3FrameAgeMs !== u.lastV3FrameAgeMs ||
    pu.crcFailTotal !== u.crcFailTotal ||
    pu.recent10s?.total !== u.recent10s?.total ||
    pu.recent10s?.v3CrcFail !== u.recent10s?.v3CrcFail ||
    // 十修：1 Hz 心跳的 sent/ack/fail/RTT/最近成功时刻必须驱动"链路"一行刷新
    pu.heartbeat?.enabled !== u.heartbeat?.enabled ||
    pu.heartbeat?.sent !== u.heartbeat?.sent ||
    pu.heartbeat?.ack !== u.heartbeat?.ack ||
    pu.heartbeat?.fail !== u.heartbeat?.fail ||
    pu.heartbeat?.lastAckAtMs !== u.heartbeat?.lastAckAtMs ||
    pu.heartbeat?.lastRttMs !== u.heartbeat?.lastRttMs ||
    // A5：顶层 active（网关实际主通道）与 A4 原始帧恢复进度必须驱动 chip/告警刷新
    (prev.active ?? null) !== (next.active ?? null) ||
    (prev.lastRawFrameAtMs ?? null) !== (next.lastRawFrameAtMs ?? null) ||
    (prev.rawRecoverMs ?? null) !== (next.rawRecoverMs ?? null) ||
    (prev.rawFrames ?? 0) !== (next.rawFrames ?? 0) ||
    (prev.noRaw === true) !== (next.noRaw === true) ||
    (prev.health?.state ?? null) !== (next.health?.state ?? null) ||
    (prev.health?.reason ?? "") !== (next.health?.reason ?? "") ||
    // S7/S8：链路有效性一行与自动回退结果必须驱动传输卡/状态条刷新
    (prev.autoFallback?.count ?? 0) !== (next.autoFallback?.count ?? 0) ||
    (prev.autoFallback?.inFlight ?? false) !== (next.autoFallback?.inFlight ?? false) ||
    (prev.autoFallback?.notice ?? "") !== (next.autoFallback?.notice ?? "") ||
    (prev.autoFallback?.error ?? "") !== (next.autoFallback?.error ?? "") ||
    // B：4 档波特率的实际/板端读回/偏好/扫描命中/上次切档结果都要驱动传输卡
    (prev.baudRate ?? null) !== (next.baudRate ?? null) ||
    (prev.boardBaud ?? null) !== (next.boardBaud ?? null) ||
    (prev.preferredBaud ?? null) !== (next.preferredBaud ?? null) ||
    (prev.baudScan?.hit ?? null) !== (next.baudScan?.hit ?? null) ||
    (prev.baudScan?.tried.join(",") ?? "") !== (next.baudScan?.tried.join(",") ?? "") ||
    (prev.lastBaudSwitch?.ok ?? false) !== (next.lastBaudSwitch?.ok ?? false) ||
    (prev.lastBaudSwitch?.error ?? "") !== (next.lastBaudSwitch?.error ?? "");
  transportView = next;
  if (changed) transportRev++;
}

/** S7/S8：链路降级一句话（状态条/顶栏共用）；正常时 null */
function linkWarning(): { state: "active" | "degraded"; reason: string } | null {
  const t = transportView;
  if (t === null) return null;
  const fb = t.autoFallback;
  if (fb !== null && fb.error !== "") return { state: "degraded", reason: fb.error };
  // A4：切到网口却 3 s 没有 FRAME_RAW 是最容易"看起来切成功了但画面是黑的"的状态，
  // 必须在状态条/顶栏说出来，并配传输卡里的「重试」。
  const raw = rawRecoverText(t);
  if (raw !== null) return { state: "degraded", reason: raw };
  if (fb !== null && fb.notice !== "") return { state: "degraded", reason: fb.notice };
  const h = t.health;
  if (h !== null && h.state === "degraded") return { state: "degraded", reason: h.reason };
  const d = t.decision;
  if (d !== null && d.state === "degraded") return { state: "degraded", reason: d.reason };
  return null;
}

/** 下行命令结果（TYPE_CTRL）：给用户一句话，绝不静默 */
function handleCtrl(m: IpcCtrl): void {
  const kind = m.ctrl["kind"];
  if (kind === "ack") {
    // 十修：九修的 1 Hz 串口链路心跳 ACK 带 heartbeat:true —— 不弹 toast、不进"最近命令"。
    const notice = ackTracker.note(m.ctrl as unknown as Record<string, unknown>, Date.now());
    if (notice === null) {
      console.debug("[ctrl] 心跳 ACK（已静默）", m.ctrl["opcode"], m.ctrl["seq"]);
      return;
    }
    notify(notice.message, notice.tone);
    return;
  }
  if (kind === "timeSyncReq") {
    notify("板端发起时间校准（TIME_SYNC_REQ），已应答", "info");
    return;
  }
  if (kind === "uartTelemetry") {
    // 串口遥测帧（帧型 A，250 ms）：只刷新卡片上的"遥测直读"行，不弹 toast（4 Hz 会刷屏）
    const c = m.ctrl as unknown as UartTelemFrame;
    uartTelem = c;
    transportRev++;
    return;
  }
  if (kind === "uartText") {
    // 板端的人读 ASCII 行（`T fr=…`）：原样留在控制台，界面上不打扰
    console.info("[uart] " + String(m.ctrl["line"] ?? ""));
    return;
  }
  if (kind === "calibrated") {
    const err = m.ctrl["alignErrMs"];
    notify(
      "时间校准完成：offset=" + String(m.ctrl["offsetUs"] ?? "?") + " µs" +
        (typeof err === "number" ? "，单向误差 ≈ " + err.toFixed(2) + " ms" : ""),
      "ok",
    );
  }
}

const client = new GatewayClient({
  url: wsUrl,
  profile,
  onMessage,
  onStatus: (s) => {
    const wasKind = sourceStatus.kind;
    sourceStatus = s;
    connected = s.connected;
    // 数据源种类变了（页内合成 ↔ 网关）就把残留清掉，否则两份来源的数字/余晖会混在屏上
    if (s.kind !== wasKind) resetView(s.kind === "synth" ? "已切到页内合成源" : "已切到网关数据");
  },
  onSnapshot: (snap) => {
    adoptGatewayProfile(snap);
    adoptGatewayConfig(snap);
    const t = (snap as { transport?: unknown }).transport;
    if (t !== undefined) adoptTransport(t);
  },
});

/**
 * 从网关快照里同步**真正在生效的**状态：事件来源 + 上位机算法参数（θ / 守卫）。
 *
 * 为什么要连事件来源一起采用（2026-10-06 截图复核时发现的真 bug）：
 * 网关的 eventSource 是**网关进程的状态**，它比浏览器活得久。前端原来只采用 θ/守卫，
 * 不采用 eventSource —— 于是"网关在跑上位机算法、页面却显示 FPGA 实时处理"，
 * 表现为：顶栏写着「FPGA 实时处理」、侧栏 θ 是只读、事件流卡片写着"legacy/v1 板端不发事件"，
 * 而 L2 上明明有密密麻麻的事件。**三处界面同时在说一件不成立的事。**
 * 采用之后，刷新页面还会把你的档位恢复回来（因为网关记得），比"刷新即丢失"更符合直觉。
 */
function adoptGatewayConfig(snap: unknown): void {
  if (typeof snap !== "object" || snap === null) return;
  const o = snap as { hostTheta?: unknown; hostMinDl?: unknown; eventSource?: unknown };
  if (typeof o.hostTheta === "number" && Number.isFinite(o.hostTheta)) hostTheta = o.hostTheta;
  if (typeof o.hostMinDl === "number" && Number.isFinite(o.hostMinDl)) hostMinDl = o.hostMinDl;
  if (o.eventSource === "board" || o.eventSource === "host") {
    // 只在"网关与界面不一致"时才动：否则每次快照都会 resetView，把画面/统计反复清空。
    // client.setEventSource 是幂等的（网关侧 setEventSource 同值时直接返回），不会来回打。
    if (!client.synthMode && client.eventSource !== o.eventSource) {
      client.setEventSource(o.eventSource);
      resetView("已采用网关的事件来源：" + (o.eventSource === "host" ? "上位机同构算法" : "板端回传"));
    }
  }
}

/**
 * 改上位机算法的参数（只在上位机模拟档位下由侧栏滑动条调用）。
 *
 * 为什么要节流：滑动条一拖就是几十个 input 事件，每个都发一次 RPC 会把 WS 打满，
 * 而且网关每收到一次就要重建算法引擎（重算整帧），反而卡顿。
 * 这里 120 ms 合并一次，拖完后自动补发最后一次。
 *
 * ⚠️ 键名映射是必须的，不能直接把 patch 发出去（2026-10-06 的真实 bug）：
 * 界面上叫 `theta` / `minDl`，网关的配置键叫 `hostTheta` / `hostMinDl`。
 * 之前是直接把 {theta} 发给 config.set，网关把它当成普通配置项、走到
 * `config.set 不支持的键: theta` 那条错分支 ⇒ 滑动条永远下发不成功（弹"参数未下发成功"），
 * 而 θ 一直是 44 ⇒ 事件画面几乎全黑。**一个键名就能让整个功能看起来"没实现"。**
 */
let pendingHostPatch: { theta?: number; minDl?: number } = {};
let hostPatchTimer = 0;
function onHostParam(patch: { theta?: number; minDl?: number }): void {
  if (patch.theta !== undefined) hostTheta = patch.theta;
  if (patch.minDl !== undefined) hostMinDl = patch.minDl;
  pendingHostPatch = { ...pendingHostPatch, ...patch };
  if (hostPatchTimer !== 0) return;
  hostPatchTimer = window.setTimeout(() => {
    hostPatchTimer = 0;
    const p = pendingHostPatch;
    pendingHostPatch = {};
    // 界面键名 → 网关键名（唯一权威映射在 hostparams.ts，有单测钉着）
    const params = toHostParamRpc(p);
    if (Object.keys(params).length === 0) return;
    void client.rpc("config.set", params).then((r) => {
      if (r === null) {
        notify("参数未下发成功：网关无响应（3 s 超时）", "error");
        return;
      }
      if ("error" in r) {
        // 把网关的原话带出来 —— 否则用户只知道"失败了"，没法自己判断
        notify("参数未下发成功：" + r.error.message, "error");
        return;
      }
      adoptGatewayConfig(r.result);
    });
  }, 120);
}

/**
 * 采用网关的 profile（而不是前端自己那份硬编码的）。
 * 解析在网关，前端只负责画 —— 两边 profile 不一致时画出来的东西必然是错的，
 * 所以这里要么采用、要么明确告警，不能默默用自己那份。
 */
function adoptGatewayProfile(snap: unknown): void {
  if (typeof snap !== "object" || snap === null) return;
  const p = (snap as { profile?: { name?: unknown } }).profile;
  const name = p?.name;
  if (typeof name !== "string" || name === activeProfile.name) return;
  const full = getProfile(name);
  if (full === null) {
    notify("网关用的是本前端不认识的 profile：" + name + "（界面仍按 " + activeProfile.name + " 渲染）", "warn");
    return;
  }
  if (full.evGrid.w !== activeProfile.evGrid.w || full.evGrid.h !== activeProfile.evGrid.h) {
    notify("网关 profile " + name + " 的事件栅格与本地不同，请刷新页面", "warn");
    return;
  }
  activeProfile = full;
  resetView("已采用网关 profile：" + name);
}

/** 板端 MODE 值 → 界面标签（WIRE-V3 §3.1 + 2026-10-11 键位修订：KEY3 两态 R+E↔E，R 仅命令可下） */
function modeLabel(mode: number): string {
  return mode === 0
    ? "R+E（原始+事件，KEY3 两态之一）"
    : mode === 1
      ? "R（仅原始，仅上位机命令可下发）"
      : mode === 2
        ? "E（仅事件，KEY3 两态之一）"
        : "MODE " + String(mode);
}

/** RPC 方法 → 给人看的中文名（反馈条上不能出现裸方法名） */
const RPC_LABEL: Readonly<Record<string, string>> = {
  "transport.start": "启动回传",
  "transport.stop": "停止回传",
  "transport.uartGrab": "抓一帧（UART）",
  "flow.pause": "冻结推流",
  "flow.resume": "恢复推流",
};

function rpcFromUi(method: string): void {
  const label = RPC_LABEL[method] ?? method;
  if (!connected) {
    // 以前这里只 console.warn ⇒ 用户看到的是"点了没反应"。现在必须说出来。
    notify("未连接网关，命令未发出：" + label, "warn");
    return;
  }
  void client.rpc(method).then((r) => {
    if (r === null) {
      notify(label + "：网关无响应（3 s 超时）", "error");
      return;
    }
    if ("error" in r) {
      notify(label + "失败：" + r.error.message, "error");
      return;
    }
    notify(label + " 已下发 ✓", "ok");
  });
}

// ---------- 图层开关 / 预设 ----------
function toggleLayer(key: LayerKey): void {
  layerOn[key] = !layerOn[key];
  refreshUi();
}

function applyPreset(idx: number): void {
  const p = LAYER_PRESETS[idx];
  if (!p) return;
  for (const k of Object.keys(layerOn) as LayerKey[]) layerOn[k] = p.on.includes(k);
  refreshUi();
}

// ---------- 渲染：每个窗格一次合成（z 序由 LAYER_Z 决定） ----------
function viewFor(pane: Pane): RenderEnv["view"] {
  const cw = pane.cw;
  const ch = pane.ch;
  if (pane.spec.kind === "events") {
    // 事件图要看出"块"：优先用整数倍放大（每个事件格 = 整数个屏幕像素）。
    // 窗格装不下 2 倍时退回与其它窗格一致的 contain 矩形 —— 否则要么留一大片黑边、
    // 要么裁掉画面（两者都会让"四窗格可比"这件事失效）。
    const k = Math.floor(Math.min(cw / bitmap.w, ch / bitmap.h));
    if (k >= 2) {
      const w = bitmap.w * k;
      const h = bitmap.h * k;
      return { x: (cw - w) / 2, y: (ch - h) / 2, w, h, scale: k * 2, integer: true };
    }
  }
  const s = Math.min(cw / activeProfile.frame.w, ch / activeProfile.frame.h);
  const w = activeProfile.frame.w * s;
  const h = activeProfile.frame.h * s;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h, scale: s, integer: false };
}

function render(): void {
  const t0 = performance.now();
  // EV_ONLY 状态每帧重算一次（纯记账，O(1)）：L1 角标/L2 元信息/L4"无原始帧"都读它
  evOnlyView = evTracker.view(t0);
  // A6：这一 tick 画的就是这些量 —— 5 Hz 的标题/元信息改读它，与画布同源
  uiSnapshot = { frame: current, activeCells: bitmap.activeCells, detections: detections.length };
  // 一次 tick 只算一次预测快照：四个窗格共用同一组目标/同一时域，L3 不会与侧栏数字对不上。
  // 关闭时传 null（不是 undefined）：HUD 据此完全跳过预测绘制，旧像素逐位不变。
  const prediction = motionConfig.enabled ? motion.snapshot(t0, motionConfig.horizonS) : null;
  for (const pane of panes) {
    pane.syncSize();
    if (pane.cw <= 1 || pane.ch <= 1) continue;
    const ctx = pane.ctx;
    ctx.setTransform(pane.dpr, 0, 0, pane.dpr, 0, 0);
    const env: RenderEnv = {
      ctx,
      cw: pane.cw,
      ch: pane.ch,
      view: viewFor(pane),
      frame: current,
      events: bitmap,
      stats,
      profile: activeProfile,
      detections,
      pointer: pointerFor(pane),
      frozen,
      // EV_ONLY 下 L1 保留最后一张完整原始帧，但必须在画面上说清"它已经冻结了"（raw 层负责文案）
      evOnly: evOnlyView.active,
      prediction,
      predictionHorizonS: motionConfig.horizonS,
    };
    stack.draw(env, pane.layers);
  }
  const dt = performance.now() - t0;
  renderMs = renderMs === 0 ? dt : renderMs * 0.9 + dt * 0.1;
  requestAnimationFrame(render);
}

function pointerFor(pane: Pane): RenderEnv["pointer"] {
  if (!pointer) return null;
  return { x: pointer.x - pane.rectLeft, y: pointer.y - pane.rectTop, down: pointer.down };
}

// ---------- 界面刷新（5 Hz：数字/文本不需要 60 fps，但必须够"实时"） ----------
function refreshUi(): void {
  const now = performance.now();
  const snap = aggregator.snapshot(now);
  // 侧栏状态行与 HUD 同源同参数：track 数只算 confirmed（hits>=2），与屏幕上画出来的一致
  const motionView = motion.snapshot(now, motionConfig.horizonS);
  // 相机帧率是反推量（02 §2.7 H31）：回传帧率 × frameDecim，聚合器不认识 profile
  stats = { ...snap, camFps: snap.fps * activeProfile.frameDecim };
  // L3 HUD 第二行必须与"当前这批事件是谁算的"一致（以前写死成板端档位，切档后就是假的）
  const hudMode = currentMode();
  hudEventInfo.text = hudMode === "host"
    ? "θ = " + hostTheta + "（上位机算法）"
    : hudMode === "synth"
      ? "θ — 页内合成事件"
      : activeProfile.wire === "LEGACY"
        ? "θ — legacy/v1 板端不发事件"
        : "θ 由板上 KEY1 档位决定";
  sidebar.update({
    stats, profile: activeProfile, source: sourceStatus, history: aggregator.slotSeries(),
    historyRev: aggregator.seriesRev, layerOn, canRpc: connected,
    hostMode: currentMode() === "host", hostTheta, hostMinDl,
    v3: v3Status, v3Rev: v3StatusRev,
    transport: transportView, transportRev, uartTelem,
    transportBusy: transportSwitching,
    evOnly: evOnlyView,
    boardParamAck,
    boardParamAckRev,
    motion: {
      enabled: motionConfig.enabled,
      horizonS: motionConfig.horizonS,
      trackCount: motionView.tracks.filter((t) => t.hits >= 2).length,
      eventCount: motionView.eventCount,
      updatedAtMs: motionView.updatedAtMs,
    },
    // 动作识别卡片：还没收到第一份快照时用空视图（available=false），卡片自己显示"无数据"
    action: actionView ?? {
      available: false, reason: null, byte23: null, className: "无数据", class: null, conf: null,
      valid: false, mapped: null, lastSeq: Math.max(0, actionLastSeq), lastEvent: actionLastEvent,
      recognizedCount: actionGateCount,
      source: actionConfigSource, saved: actionSaved, config: actionConfig,
    },
  });
  statusbar.update({
    stats, profile: activeProfile, source: sourceStatus, renderMs,
    clients: gwClients, slowClients: gwSlowClients,
    link: linkWarning(),
  });
  updateTopBar();
  updatePaneMeta();
  // 导出按钮的可用状态跟着缓冲/编码器能力走（5 个按钮的判定很便宜，且编码器探测已缓存）
  refreshExportButtons();
}

function updateTopBar(): void {
  txtConn.textContent = sourceStatus.detail.slice(0, 46);
  dotConn.className = connected ? "dot" : "dot warn";
  // 显示**网关实际生效的** profile；若与本地启动参数不同，明确标出来（不要假装一致）
  txtProfile.textContent = activeProfile.name === profile.name
    ? activeProfile.name
    : activeProfile.name + "（网关）";
  const c = stats.counters as Counters;
  const bad: string[] = [];
  const link = linkWarning();
  if (link !== null) bad.push("⚠ " + link.reason);
  for (const k of ["badMagic", "badLength", "aborted", "oversize", "truncated", "crcFail", "idxGap", "dupChunk", "evPartial", "evDrop", "evOrphan"] as const) {
    const n = c[k] ?? 0;
    if (n > 0) bad.push(k + " " + fmtInt(n));
  }
  txtAlarm.textContent = bad.length === 0 ? "链路正常" : bad.slice(0, 2).join(" · ");
  txtAlarm.title = bad.join(" · ");
  dotAlarm.className = bad.length === 0 ? "dot" : "dot warn";
  const mode = currentMode();
  srcBadge.textContent = mode === "synth" ? "页内合成源" : mode === "host" ? "上位机模拟处理" : "FPGA 实时处理";
  srcBadge.className = mode === "synth" ? "srcbadge synth" : "srcbadge";
  btnPause.textContent = frozen ? "继续" : "冻结";
  btnPause.classList.toggle("pri", frozen);
  // F1：EV_ONLY 下「上位机模拟处理」置灰（点了也只会全黑），tooltip 说明原因
  const evOnlyLock = evOnlyView.active || evOnlyAutoSource || (v3Status !== null && v3Status.mode === 2);
  for (const seg of segMode.children) {
    const d = seg as HTMLElement;
    d.classList.toggle("sel", d.dataset["mode"] === mode);
    if (d.dataset["mode"] === "host") {
      d.classList.toggle("disabled", evOnlyLock);
      d.style.opacity = evOnlyLock ? "0.45" : "";
      d.style.pointerEvents = evOnlyLock ? "none" : "";
      d.title = evOnlyLock
        ? "板端只回传事件（EV_ONLY）时没有原始帧，上位机模拟无法计算；已自动切到板端事件源"
        : "用板端同一帧，由上位机同构算法算事件（标准对照）";
    }
  }
}

/** 界面上的三档数据源：板端事件 / 上位机同构算法 / 页内合成 */
type UiMode = "board" | "host" | "synth";

function currentMode(): UiMode {
  if (client.synthMode) return "synth";
  return client.eventSource === "host" ? "host" : "board";
}

/**
 * F1：检测到板端 EV_ONLY（板端只回传事件）。
 * - 当前是「上位机模拟处理」⇒ 必然全黑（host 事件由原始帧算出，而 EV_ONLY 没有 FRAME_RAW）
 *   ⇒ 自动切到板端事件源，并记住用户原选择；
 * - 当前已是板端 ⇒ 只打标记，不改任何设置。
 */
function noteEvOnlyDetected(): void {
  if (client.synthMode) return;
  if (evOnlyAutoSource && evOnlySavedSource !== null) return;
  if (client.eventSource === "host") {
    evOnlySavedSource = "host";
    evOnlyAutoSource = true;
    client.setMode("auto");
    client.setEventSource("board");
    resetView("事件-only：已自动切到板端事件源（上位机模拟没有原始帧可算）");
    notify("事件-only：已自动切到板端事件源", "warn");
    // 一句人话日志：现场 F12 就能看出为什么事件源自己变了（自动化测试也按这行断言）
    console.info("[evonly] 事件-only：已自动切到板端事件源（上位机模拟无原始帧可算）");
    refreshUi();
    return;
  }
  evOnlyAutoSource = true;
}

/** F1：EV_ONLY 结束（第一张原始帧回来）⇒ 把用户原来的事件源还回去（只恢复一次） */
function noteEvOnlyCleared(): void {
  if (!evOnlyAutoSource) return;
  evOnlyAutoSource = false;
  const saved = evOnlySavedSource;
  evOnlySavedSource = null;
  if (saved === "host") {
    client.setEventSource(saved);
    notify("事件-only 结束：已恢复用户原来的「上位机模拟处理」", "ok");
    console.info("[evonly] 事件-only 结束：已恢复用户原来的上位机模拟处理");
    refreshUi();
  }
}

/** 切档：数据源 + 事件来源一起定，并把上一档的残留清掉 */
function applyUiMode(mode: UiMode): void {
  const before = currentMode();
  if (mode === "synth") {
    client.setMode("synth");
    if (before !== "synth") resetView("已切到合成源：页内造数据，不连网关");
  } else {
    client.setMode("auto");
    client.setEventSource(mode);
    if (before !== mode) {
      resetView(
        mode === "host"
          ? "已切到「上位机模拟处理」：用板子送来的同一帧，由上位机同构算法算事件"
          : "已切到「FPGA 实时处理」：用板端发来的事件",
      );
    }
  }
  refreshUi();
}

function updatePaneMeta(): void {
  const p1 = panes[0];
  const p2 = panes[1];
  const p3 = panes[2];
  const p4 = panes[3];
  const snapFrame = uiSnapshot.frame;
  const evOnly = evOnlyView;
  // 串口 UART-LINK（rawCapable=false）即使 EV_ONLY 批还没到，文案也已经能判定"没有原始画面"
  const noRaw = evOnly.active && (evOnly.noRawSource || sourceRawCapable === false);
  const totalCells = bitmap.w * bitmap.h;
  if (snapFrame) {
    const n = activeProfile.chunksPerFrame;
    if (p1) {
      p1.metaR.textContent = "FRAME_IDX " + fmtInt(snapFrame.frameIdx) + " · " + n + " 段/帧" +
        (snapFrame.synthetic ? " · 合成" : "") +
        (evOnly.active ? (noRaw ? " · 串口模式：无原始画面" : " · 原始帧已冻结(EV_ONLY)") : "");
    }
  } else if (evOnly.active) {
    // EV_ONLY 第一现场：一张原始帧都没有过 —— 不能写"等待数据…"（那会让人以为数据没到，其实事件一直在到）
    if (p1) {
      p1.metaR.textContent = noRaw
        ? "串口模式：无原始画面 · 事件批次 " + fmtInt(evOnly.batches)
        : "无原始帧 · EV_ONLY 批次 " + fmtInt(evOnly.batches) + " · 板端只回传事件";
    }
  } else if (p1) {
    p1.metaR.textContent = "等待数据…";
  }
  // L1 角标：区分"有旧帧但已冻结"与"根本没有原始帧"——两者排障方向完全不同
  if (p1) {
    const frozenBadge = evOnlyRawBadge(evOnly, snapFrame !== null);
    p1.badge.textContent = frozenBadge !== ""
      ? frozenBadge
      : currentMode() === "synth"
        ? "合成演示素材（非上板截图）"
        : snapFrame !== null
          ? "FPGA 回传原始帧"
          : "等待原始帧";
    p1.badge.style.color = frozenBadge !== "" ? "var(--warn)" : "";
  }
  const ev = fmtScale(stats.eventRate, 1);
  if (p2) {
    const lit = uiSnapshot.activeCells;
    // EV_ONLY 下没有"每帧"这回事：用**批次**口径（每批点数 / 批次数），绝不能让每帧点数显示 0
    p2.metaR.textContent = evOnly.active
      ? "事件率 " + ev.v + " " + ev.u + "ev/s · " + evOnlyPaneMeta(Math.round(evOnly.lastBatchPoints), lit, totalCells, evOnly)
      : "事件率 " + ev.v + " " + ev.u + "ev/s · 点亮 " + fmtInt(lit) +
        " / " + fmtInt(totalCells) + "（" + fmtFixed((lit / totalCells) * 100, 1) + "%）";
  }
  if (p3) p3.metaR.textContent = "L1+L2+L3 · KEY0 = 原始" +
    (evOnly.active ? (noRaw ? " · 串口模式：无原始画面" : " · 原始帧已冻结(EV_ONLY)") : "");
  if (p4) {
    p4.metaR.textContent = evOnly.active && snapFrame === null
      ? (noRaw ? "串口模式无原始帧 · 检测框不更新" : "无原始帧（EV_ONLY）· 检测框不更新")
      : uiSnapshot.detections + " 个检测框 · 亮区检测（占位）" + (frozen ? " · 已冻结" : "");
    p4.badge.textContent = evOnly.active && snapFrame === null ? (noRaw ? "串口模式" : "无原始帧") : "检测框是独立图层";
  }
  // 事件来源必须写清楚：否则"板端算的"和"上位机算的"看起来一模一样，对照就白做了。
  // 另外这里要**明确说出"这一档本来就没有事件"** —— legacy/v1 通路的包结构里没有事件段，
  // 板端也不跑事件引擎，此时 L2 是一片黑，很容易被误判成"检测坏了"（2026-10-06 用户反馈）。
  if (p2) {
    const mode = currentMode();
    p2.badge.textContent = evOnly.active
      ? (noRaw ? "事件来自：板端事件流（串口模式，不配对原始帧）" : "事件来自：板端 EV_ONLY 批次（不配对原始帧）")
      : mode === "synth"
      ? "事件来自：页内合成源"
      : mode === "host"
        ? "事件来自：上位机同构算法（与板端同一帧）"
        : hostSimEvents
          ? "事件来自：上位机同构算法"
          : activeProfile.wire === "LEGACY"
            ? "本通路（legacy/v1）板端不发事件 ⇒ 想看得切到「上位机模拟处理」"
            : "事件来自：板端回传";
  }
}

// ---------- 交互 ----------
function focusPane(id: number | null): void {
  stageEl.classList.toggle("focusing", id !== null);
  for (const p of panes) p.el.classList.toggle("focus", p.spec.id === id);
}

function setFrozen(v: boolean): void {
  frozen = v;
  if (connected) {
    if (v) client.flowPause();
    else client.flowResume();
  }
  refreshUi();
}

/**
 * 开始/停止录制（R 键与底栏「录制」按钮共用这一个入口）。
 *
 * 为什么开始录制要**清空**缓冲：不清的话缓冲里会混着"上次录的"和"这次录的"两段，
 * 导出的文件无名无姓地把两段时间接在一起 —— 事后没人能说清哪一段是什么参数下录的。
 * 清空的代价只是丢掉上一次没导出的内容，而这个代价用户是按 R 之前就能预期的。
 */
function setRecording(v: boolean): void {
  if (v === recording) return;
  recording = v;
  if (v) {
    recorder.clear();
    recPair.clear();
    recStartedAtMs = Date.now();
    recElapsedMs = 0;
    btnRec.classList.add("pri");
    btnRec.textContent = "■ 停止（缓冲）";
    notify("开始缓冲录制（浏览器内存环形缓冲，不是网关长录）：先清空缓冲，之后每帧进内存（上限 96 MB）", "ok");
  } else {
    recElapsedMs = Date.now() - recStartedAtMs;
    // 配对账目要在停止时说出来（原则 P6 不允许静默丢数据）：导出的 CSV 行数应当等于配对条数
    const pair = recPair.stats;
    const frames = recorder.frames;
    const eventOnlyFrames = frames.filter((f) => f.hasRaw === false);
    const eventOnlyRecords = eventOnlyFrames.reduce((n, f) => n + f.events.length, 0);
    const rawFrames = frames.length - eventOnlyFrames.length;
    btnRec.classList.remove("pri");
    btnRec.textContent = "● 录制（缓冲 96 MB）";
    notify(
      "停止缓冲录制：已缓存 " + frames.length + " 帧" +
        (eventOnlyFrames.length > 0
          ? "（事件-only " + eventOnlyFrames.length + " 帧 / " + eventOnlyRecords + " 条事件；带原始像素 " + rawFrames + " 帧）"
          : "") +
        " / " + humanBytes(recorder.bytes) +
        (recorder.evictionCount > 0 ? "（缓冲满，已丢最旧 " + recorder.evictionCount + " 帧）" : "") +
        " · 事件配对 " + pair.pairedRecords + " 条" +
        (pair.orphanRecords > 0 ? "（错过 " + pair.orphanRecords + " 条：等不到自己的帧）" : "") +
        (eventOnlyFrames.length > 0 && rawFrames === 0
          ? "。事件-only 录制可导出事件流 CSV / 检测结果 JSON；PNG/MP4/原始帧需要原始像素，本段没有"
          : "。现在可以导出，或拖时间轴选片段"),
      "ok",
    );
    // 动作映射 startAndAutoExport：停止后自动导出一次（待办只消费一次，避免每次停止都重复导出）
    if (actionAutoExportTarget !== null) {
      const target = actionAutoExportTarget;
      actionAutoExportTarget = null;
      runAutoActionExport(target);
    }
  }
  refreshUi();
  refreshExportButtons();
}

// ---------- 导出 ----------
/**
 * 导出这一块为什么全在浏览器里做（而不是像 04 文档设想的那样由网关落盘）：
 *   · 网关的职责是"长时间占住 UDP 1234 收流"（用户明确要求那个进程别释放端口），
 *     让它再承担"渲染 800×480 的 PNG 序列 / 编码视频"是把两件事的风险绑在一起；
 *   · 浏览器手里**本来就有**每一帧的原始字节与事件，另开一条网关录制链路等于存两份；
 *   · MP4 需要视频编码器，而 Node 没有内置 H.264 编码器（本机也没装 ffmpeg），
 *     唯一现成的编码器就在浏览器里。
 * 代价（必须说清楚，不假装没有）：**刷新页面会丢缓冲**；导出产物走浏览器下载而不是落盘到固定目录。
 * 所以 export/ 下的写盘逻辑（zip/bin/csv/json）都写成了**不依赖 DOM 的纯函数**，
 * 将来要挪到网关侧（含 ffmpeg）时可以直接搬。
 */
/**
 * **回退**帧率：只在录制帧没有可用 tMs（缺失/非有限）时兜底，正常路径是变帧率。
 *
 * 以前这里是导出节拍的唯一真源（"每 33 ms 提交一帧"），把 26 fps 左右、还带停顿的
 * 回传帧匀速放成 30 fps ⇒ 播放速度与真实时间对不上（快放）。现在节拍由 tMs 决定
 * （见 export/mp4.ts 的 frameGaps），这个常量只剩兜底与"片段太短"换算两种用途。
 */
const EXPORT_FPS = 30;

/** 导出时间轴的真实跨度（ms）：首末帧时间戳之差；乱序/缺失时钳到 0，不返回负数 */
function frameTimespanMs(frames: readonly number[]): number {
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (first === undefined || last === undefined) return 0;
  return Math.max(0, last - first);
}

function manifestBase(range: { readonly from: number; readonly to: number }, frames: readonly RecordedFrame[]): Record<string, unknown> {
  const first = frames[0];
  const last = frames[frames.length - 1];
  return {
    app: VERSION,
    profile: { name: activeProfile.name, wire: activeProfile.wire, w: activeProfile.frame.w, h: activeProfile.frame.h, pixel: "RGB565_BE" },
    exportTarget,
    renderTargets: EXPORT_TARGETS.map((t) => t.id),
    eventSource: currentMode(),
    hostParams: { theta: hostTheta, minDl: hostMinDl },
    range: { from: range.from, to: range.to, count: frames.length, ofBuffer: recorder.frames.length },
    frameIdx: { first: first?.frameIdx ?? null, last: last?.frameIdx ?? null },
    tMs: { first: first?.tMs ?? null, last: last?.tMs ?? null },
    // 板端时间轴（WIRE-V3 §4.3）：v3 帧才带；v2 帧/老缓冲缺省 → 导出侧按"全有才用"择源
    tBoardMs: { first: first?.tBoardMs ?? null, last: last?.tBoardMs ?? null },
    note: "事件/检测框与像素同源：像素是板子/合成源送来的原始 RGB565，事件与检测框是该帧到达时上位机手上的那一份。",
  };
}

/** 把某一帧渲染成目标画面（离屏、原生分辨率），导出与视频共用 */
function renderAt(target: ExportTarget, frames: readonly RecordedFrame[], index: number): HTMLCanvasElement {
  const f = frames[index];
  if (f === undefined) throw new Error("帧下标越界：" + index);
  // ⚠️ 事件位图必须**从缓冲区开头回放**到这个下标：衰减是累积的，只喂当帧会得到一张
  //    "没有余晖"的图，与录的时候在界面上看到的不是同一个东西。
  const bmp = replayBitmap(frames, index, activeProfile);
  return renderRecordedFrame({
    target,
    frame: f,
    events: bmp,
    profile: activeProfile,
    // 用"那一帧当时"的统计快照（HUD 面板上的数字），没有就用当前的 —— 老帧没有快照时
    // 宁可显示"现在"的数字也不能空着，但要在 HUD 上会被看出来，所以录制一定会带上它。
    stats: f.stats ?? stats,
    hudText: hudEventInfo.text,
  });
}

/** 当前（未录制）那一帧 → RecordedFrame；「导出当前帧」用它，走同一套渲染路径 */
function currentAsRecorded(): RecordedFrame | null {
  if (current === null) return null;
  return {
    frameIdx: current.frameIdx,
    tMs: Date.now(),
    w: current.w,
    h: current.h,
    pixel: current.byteOrder === "LE" ? "RGB565_LE" : "RGB565_BE",
    raw: current.raw,
    events: [],
    detections,
    stats: { ...stats },
  };
}

function setExportBusy(busy: boolean, text = ""): void {
  exporting = busy;
  expProg.hidden = !busy;
  expProg.textContent = text;
  btnExpCancel.hidden = !busy;
  if (busy) exportCancelled = false;
  refreshExportButtons();
}

function progressText(done: number, total: number): string {
  return "导出中 " + done + "/" + total + " · " + Math.round((done / total) * 100) + "%";
}

function progressCb(): (done: number, total: number) => boolean {
  return (done, total) => {
    expProg.textContent = progressText(done, total);
    return !exportCancelled;
  };
}

/** 导出结果的一句话反馈（成功给大小 + 文件名，失败给原因；绝不留"点了没反应"） */
function exportDone(spec: ExporterSpec, filename: string, bytes: number, extra = ""): void {
  notify("已导出 " + spec.label + "：" + filename + "（" + humanBytes(bytes) + (extra === "" ? "" : " · " + extra) + "）", "ok");
}

async function runExport(id: ExporterId, frames: readonly RecordedFrame[], range: { from: number; to: number }): Promise<void> {
  const spec = exporterById(id);
  if (frames.length === 0) {
    notify("缓冲区里没有可导出的帧：先按 R（或点「录制」）录一段", "warn");
    return;
  }
  // 混录（同一次录制里既收了事件-only 批、又切回原始帧）时按钮可能仍可点：
  // 选区里只要有一帧没有像素，像素类导出就必须停在这里，而不是让 buildRawBin 半路抛错。
  if ((id === "pngzip" || id === "mp4" || id === "rawbin") && frames.some((f) => f.hasRaw === false)) {
    const noRawFrames = frames.filter((f) => f.hasRaw === false).length;
    notify(
      spec.label + " 导出不可用：" + NO_RAW_EXPORT_REASON +
        (noRawFrames < frames.length ? "（所选范围含 " + noRawFrames + " 帧事件-only）" : ""),
      "warn",
    );
    return;
  }
  const manifest = manifestBase(range, frames);
  const scope = range.from === 0 && range.to === recorder.frames.length - 1 ? "全部" : "选区 " + range.from + "~" + range.to;
  setExportBusy(true, "导出中 0/" + frames.length);
  try {
    if (id === "rawbin") {
      const bytes = buildRawBin(frames, manifest);
      const name = timestampedName(spec.prefix, spec.ext);
      saveBytes(bytes, name, spec.mime);
      exportDone(spec, name, bytes.length, scope + " · " + frames.length + " 帧");
      return;
    }
    if (id === "csv") {
      const text = buildEventsCsv(frames);
      const name = timestampedName(spec.prefix, spec.ext);
      saveText(text, name, spec.mime);
      exportDone(spec, name, new TextEncoder().encode(text).length, scope);
      return;
    }
    if (id === "detsjson") {
      const text = buildDetectionsJson(frames);
      const name = timestampedName(spec.prefix, spec.ext);
      saveText(text, name, spec.mime);
      exportDone(spec, name, new TextEncoder().encode(text).length, scope);
      return;
    }
    if (id === "pngzip") {
      const res = await buildPngSequenceZip({
        frames,
        renderOne: (i) => renderAt(exportTarget, frames, i),
        onProgress: progressCb(),
        manifest,
      });
      const name = timestampedName(spec.prefix, spec.ext);
      saveBytes(res.zip, name, spec.mime);
      exportDone(spec, name, res.zip.length, scope + " · " + frames.length + " 张 PNG（原生分辨率）");
      return;
    }
    // mp4：需要编码器，不可用时要给出**具体原因**而不是"失败"
    const cap = probeVideoEncoding();
    if (!cap.ok || cap.mime === null) {
      notify("视频导出不可用：" + cap.detail, "error");
      return;
    }
    // 时间轴择源（WIRE-V3 任务判据）：优先板端时间戳，缺一个帧就整体回退到达时刻
    // （两种时间基不许混轴，理由见 export/times.ts）；来源写进 manifest 可追溯。
    const times = exportTimesMs(frames);
    const size = nativeSize(exportTarget, frames[0] as RecordedFrame, bitmap);
    const res = await encodeVideo(frames.length, {
      fps: EXPORT_FPS,
      // 变帧率的真源：每帧的长度由"与下一帧的时间差"决定（相邻差为 0/负/超大时在 mp4.ts 里钳到 [1,500] ms）
      timesMs: times.timesMs,
      width: size.w,
      height: size.h,
      mime: cap.mime,
      draw: (i, ctx) => {
        // 每帧现渲染（离屏）再贴到编码画布上：直接渲染进编码画布也行，但图层栈要求
        // canvas 就是"目标尺寸"，中转一层更不容易把尺寸搞错，代价只是多一次 drawImage。
        ctx.drawImage(renderAt(exportTarget, frames, i), 0, 0);
      },
      onProgress: progressCb(),
    });
    const name = timestampedName(spec.prefix, videoExt(res.mime));
    saveBlob(res.blob, name);
    exportDone(
      spec, name, res.blob.size,
      scope + " · " + res.frames + " 帧 · 按帧时间戳变速（时间来源：" + (times.source === "board" ? "板端" : "到达时刻") +
        "，原始跨度 " + (frameTimespanMs(times.timesMs) / 1000).toFixed(1) +
        " s，>0.5 s 的停顿已压缩） · " + res.width + "×" + res.height +
        " · " + (res.elapsedMs / 1000).toFixed(1) + " s" + (res.mime.includes("mp4") ? "" : "（WebM）"),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify(spec.label + " 导出失败：" + msg, "error");
  } finally {
    setExportBusy(false);
  }
}

/** 从按钮进来的统一入口：有选区就导选区，没有就导整个缓冲 */
function exportNow(id: ExporterId): void {
  if (exporting) {
    notify("上一次导出还没结束（可以点「取消导出」）", "warn");
    return;
  }
  const all = recorder.frames;
  if (all.length === 0) {
    notify("录制缓冲是空的：先按 R（或点底栏「录制」）录一段再导出", "warn");
    return;
  }
  const sel = timeline.selection();
  const range = sel === null ? { from: 0, to: all.length - 1 } : { from: sel.from, to: sel.to };
  void runExport(id, all.slice(range.from, range.to + 1), range);
}

// ---------- 动作回传：快照轮询 / 事件长轮询 / 映射执行（契约 §5.6） ----------
// 设计要点（逐条来自契约，别改成"更聪明的"做法）：
//   · 显示路径只读 GET /api/action（500 ms，页面隐藏时暂停）；
//   · 触发路径只走 GET /api/action/events 长轮询，先推进 lastSeq 再执行；
//   · after=-1 的那一次只用于初始化游标，绝不执行历史事件（避免打开页面就清缓冲）；
//   · 恢复可见时丢弃隐藏期间的积压（人已经做完动作了，补执行只会产生垃圾录制）。
const ACTION_SNAPSHOT_POLL_MS = 500;
const ACTION_EVENTS_TIMEOUT_MS = 10_000;

interface ActionSnapshotWire {
  available?: boolean;
  /** task-24：累计检测次数（网关只增不改；旧网关没有该字段） */
  count?: number;
  reason?: string;
  error?: string;
  raw?: number | null;
  valid?: boolean;
  class?: number | null;
  className?: string;
  conf?: number | null;
  mapped?: { action?: string; target?: string } | null;
}

interface ActionEventWire {
  seq?: number;
  tMs?: number;
  valid?: boolean;
  conf?: number;
  class?: number;
  className?: string;
}

interface ActionEventsWire {
  ok?: boolean;
  timeout?: boolean;
  lastSeq?: number;
  events?: ActionEventWire[];
  dropped?: number;
}

let actionPollTimer: number | null = null;
let actionEventsLoopRunning = false;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** 还没收到第一份快照时的兜底视图（sidebar 的 update 不接受 undefined） */
function emptyActionView(): ActionView {
  return {
    available: false, reason: null, byte23: null, className: "无数据", class: null, conf: null,
    valid: false, mapped: null, lastSeq: Math.max(0, actionLastSeq), lastEvent: actionLastEvent,
    recognizedCount: actionGateCount,
    source: actionConfigSource, saved: actionSaved, config: actionConfig,
  };
}

/** 500 ms 轮询：只更新卡片显示，不触发任何动作 */
async function refreshActionSnapshot(): Promise<void> {
  if (document.hidden) return;
  try {
    const res = await fetch("/api/action", { cache: "no-store" });
    if (!res.ok) return;
    const j = (await res.json()) as ActionSnapshotWire;
    if (j.available === true) {
      const cls = j.class === 0 || j.class === 1 || j.class === 2 || j.class === 3 ? j.class : null;
      const mapped = j.mapped === null || j.mapped === undefined
        ? null
        : typeof j.mapped.action === "string" && typeof j.mapped.target === "string"
          ? { action: j.mapped.action as ActionOp, target: j.mapped.target as ActionTarget }
          : null;
      if (typeof j.count === "number") actionGateCount = j.count;
      actionView = {
        available: true, reason: null,
        byte23: typeof j.raw === "number" ? j.raw : null,
        className: typeof j.className === "string" ? j.className : "无数据",
        class: cls,
        conf: typeof j.conf === "number" ? j.conf : null,
        valid: j.valid === true,
        mapped,
        lastSeq: Math.max(0, actionLastSeq), lastEvent: actionLastEvent,
        recognizedCount: actionGateCount,
        source: actionConfigSource, saved: actionSaved, config: actionConfig,
      };
      return;
    }
    // 有帧但不是 v3（v2/合成/回放）：200 + available:false，把 reason 原样带到卡片
    if (typeof j.count === "number") actionGateCount = j.count;
    actionView = {
      ...emptyActionView(),
      reason: typeof j.reason === "string" ? j.reason : typeof j.error === "string" ? j.error : null,
    };
  } catch {
    // 网关重启/页面离线：500 ms 后自己会恢复；这里不 toast，避免把状态区刷成错误墙
  }
}

/** 读一次映射镜像来源（source=ui 表示网关收到过本页的 config.set），失败静默 */
async function refreshActionConfigMirror(): Promise<void> {
  try {
    const res = await fetch("/api/action/config", { cache: "no-store" });
    if (!res.ok) return;
    const j = (await res.json()) as { source?: unknown };
    if (j.source === "ui" || j.source === "default") {
      actionConfigSource = j.source;
    }
  } catch {
    // 与快照同口径：不打扰用户
  }
}

function actionEventFromWire(w: ActionEventWire): (ActionEventLike & { seq: number; className: string; tMs: number }) | null {
  if (typeof w.seq !== "number" || !Number.isInteger(w.seq)) return null;
  if (typeof w.valid !== "boolean") return null;
  if (typeof w.conf !== "number" || !Number.isInteger(w.conf)) return null;
  if (w.class !== 0 && w.class !== 1 && w.class !== 2 && w.class !== 3) return null;
  return {
    seq: w.seq,
    valid: w.valid,
    conf: w.conf,
    class: w.class,
    tMs: typeof w.tMs === "number" ? w.tMs : Date.now(),
    className: typeof w.className === "string" ? w.className : actionClassName(w.class),
  };
}

/** 长轮询事件环：唯一触发执行的地方 */
async function runActionEventsLoop(): Promise<void> {
  if (actionEventsLoopRunning) return;
  actionEventsLoopRunning = true;
  try {
    while (!document.hidden) {
      const after = actionLastSeq;
      let res: Response;
      try {
        res = await fetch(
          "/api/action/events?after=" + String(after) + "&timeoutMs=" + String(ACTION_EVENTS_TIMEOUT_MS),
          { cache: "no-store" },
        );
      } catch {
        await sleepMs(1000);
        continue;
      }
      if (document.hidden) return;
      if (res.status === 503) {
        // 还没收到过完整 v3 帧（契约 §4.4）：1 s 后重试，不弹窗
        await sleepMs(1000);
        continue;
      }
      if (!res.ok) {
        await sleepMs(1000);
        continue;
      }
      let j: ActionEventsWire;
      try {
        j = (await res.json()) as ActionEventsWire;
      } catch {
        await sleepMs(1000);
        continue;
      }
      if (after < 0) {
        // 首次/恢复对齐：只拿游标，绝不执行历史（契约 §5.6 第 3 条）
        if (typeof j.lastSeq === "number") {
          actionLastSeq = j.lastSeq;
        } else {
          await sleepMs(1000);
        }
        continue;
      }
      if (j.timeout === true) continue;
      if (j.ok === false) {
        await sleepMs(1000);
        continue;
      }
      const list: ActionEventWire[] = Array.isArray(j.events) ? j.events : [];
      // 先推进游标再执行：即使下面某条事件执行时抛错，也不会重复消费同一条
      if (typeof j.lastSeq === "number") {
        actionLastSeq = Math.max(actionLastSeq, j.lastSeq);
      }
      for (const w of list) {
        const ev = actionEventFromWire(w);
        if (ev === null) continue;
        // 检测次数以网关 /api/action 的 count 为准（task-24）；这里不再本地自增，避免双计。
        actionLastEvent = { seq: ev.seq, className: ev.className, tMs: ev.tMs };
        executeActionEvent(ev);
      }
    }
  } finally {
    actionEventsLoopRunning = false;
    // 隐藏期间退出是对的；但如果在 fetch 途中切回可见，这里要补一次，否则事件环再也不动
    if (!document.hidden) {
      window.setTimeout(() => {
        if (!document.hidden) void runActionEventsLoop();
      }, 250);
    }
  }
}

function executeActionEvent(ev: ActionEventLike): void {
  if (!shouldTrigger(ev, actionConfig, actionTrigMem, Date.now())) return;
  const key = ev.class === 1 ? "1" : "2";
  const entry = actionConfig.map[key];
  // 先记账再执行：执行本身可能 setRecording → 触发 UI 重建，但边沿状态必须已经推进
  noteTriggered(actionTrigMem, ev, Date.now());
  execAction(entry.action, entry.target);
}

function execAction(op: ActionOp, target: ActionTarget): void {
  if (op === "none") return;
  if (op === "startRecord") {
    setRecording(true);
    return;
  }
  if (op === "stopRecord") {
    setRecording(false);
    return;
  }
  // startAndAutoExport：先置标志再开录，停止分支会消费一次（且只消费一次）
  actionAutoExportTarget = target;
  setRecording(true);
  notify("动作映射：已排入「停止录制后自动导出一次」（目标 " + target + "）", "info");
}

/** 卡片改配置：先写 localStorage（本地立即生效），再镜像到网关（失败不阻塞本地） */
function onActionConfig(cfg: ActionMapConfig): void {
  try {
    actionConfig = saveActionMap(actionStorage, cfg, Date.now());
    actionSaved = true;
  } catch (err) {
    notify("动作映射保存失败：" + (err instanceof Error ? err.message : String(err)), "error");
    return;
  }
  refreshUi();
  void pushActionConfigToGateway();
}

async function pushActionConfigToGateway(): Promise<void> {
  try {
    const r = await client.rpc("config.set", actionMapRpcParams(actionConfig));
    if (r === null) {
      notify("动作映射已保存到浏览器，但网关无响应（3 s 超时）", "warn");
      return;
    }
    if ("error" in r) {
      notify("动作映射已保存到浏览器，但推送到网关失败：" + r.error.message, "warn");
      return;
    }
    actionConfigSource = "ui";
    refreshUi();
  } catch (err) {
    notify("动作映射推送异常：" + (err instanceof Error ? err.message : String(err)), "warn");
  }
}

/** 停止录制后的自动导出（由 setRecording(false) 分支消费） */
function runAutoActionExport(target: ActionTarget): void {
  const exporter = ACTION_TARGET_EXPORTER[target];
  if (exporter !== null) {
    notify("动作映射：停止录制后台导出一次「" + target + "」", "info");
    exportNow(exporter);
    return;
  }
  exportStatsNow();
}

/** statsOnly：轻量统计导出（契约 §5.3），不进 EXPORTERS 的 5 个既有条目 */
function exportStatsNow(): void {
  if (exporting) {
    notify("上一次导出还没结束（可以点「取消导出」）", "warn");
    return;
  }
  const frames = recorder.frames;
  if (frames.length === 0) {
    notify("录制缓冲是空的：动作自动导出需要先录到至少一帧", "warn");
    return;
  }
  const payload = {
    kind: "retina-stats",
    v: 1,
    exportedAt: new Date().toISOString(),
    frameCount: frames.length,
    durationMs: recElapsedMs,
    bufferBytes: recorder.bytes,
    source: { kind: sourceStatus.kind, detail: sourceStatus.detail },
    stats: { ...stats },
    action: actionView === null
      ? null
      : {
        available: actionView.available,
        valid: actionView.valid,
        class: actionView.class,
        className: actionView.className,
        conf: actionView.conf,
        mapped: actionView.mapped,
        lastSeq: actionView.lastSeq,
      },
  };
  const name = timestampedName("retina-stats", "json");
  saveText(JSON.stringify(payload, null, 2), name, "application/json");
  notify("已导出统计：" + name + "（" + String(frames.length) + " 帧摘要，不含像素）", "ok");
}

// —— 「API 文档」弹窗（纯前端，契约 §5.7：内容 = §4 接口表 + 三个 200 示例 + 只读提示） ——
let actionApiDocMask: HTMLDivElement | null = null;

function actionDocPara(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.textContent = text;
  return p;
}

function actionDocPre(value: unknown): HTMLPreElement {
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(value, null, 2);
  return pre;
}

function buildActionApiDoc(): HTMLDivElement {
  const mask = document.createElement("div");
  mask.className = "apidoc-mask";
  mask.style.display = "none";
  mask.addEventListener("click", (e) => {
    if (e.target === mask) closeActionApiDoc();
  });

  const panel = document.createElement("div");
  panel.className = "apidoc";

  const header = document.createElement("header");
  const h3 = document.createElement("h3");
  h3.textContent = "动作回传 API（只读）";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "btn";
  closeBtn.textContent = "关闭";
  closeBtn.addEventListener("click", closeActionApiDoc);
  header.append(h3, closeBtn);

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const h of ["方法 / 路径", "说明"]) {
    const th = document.createElement("th");
    th.textContent = h;
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["GET /api/action", "最近一次动作识别结果（byte23 解码；available=false 表示当前源没有动作字节）"],
    ["GET /api/action/events?after=<seq>&timeoutMs=10000", "长轮询：等 seq 更新的动作事件（类别变化才记一条，环 64，seq 从 1 单调递增）"],
    ["GET /api/action/config", "动作→操作映射的只读镜像（source=ui 表示浏览器推过 config.set）"],
  ];
  for (const [path, note] of rows) {
    const tr = document.createElement("tr");
    const td1 = document.createElement("td");
    td1.textContent = path;
    const td2 = document.createElement("td");
    td2.textContent = note;
    tr.append(td1, td2);
    tbody.append(tr);
  }
  table.append(thead, tbody);

  const snapshotExample = {
    ok: true, uptimeMs: 123456, uiUrl: "http://127.0.0.1:8787/",
    available: true, frameIdx: 1024, tArriveMs: 1790000000000, ageMs: 12,
    raw: 161, valid: true, class: 1, className: "手部开合", conf: 8,
    mapped: { action: "startRecord", target: "raw" },
  };
  const eventsExample = {
    ok: true,
    lastSeq: 7,
    events: [{
      seq: 7, tMs: 1790000000000, frameIdx: 1024, raw: 161,
      valid: true, class: 1, className: "手部开合", conf: 8,
      mapped: { action: "startRecord", target: "raw" },
    }],
    dropped: 0,
  };
  const configExample = {
    ok: true,
    source: "ui",
    updatedAtMs: 1793299200000,
    minConf: 8,
    map: {
      "0": { action: "none", target: "statsOnly" },
      "1": { action: "startRecord", target: "raw" },
      "2": { action: "stopRecord", target: "raw" },
    },
    config: {
      v: 1,
      updatedAtMs: 1793299200000,
      minConf: 8,
      map: {
        "0": { action: "none", target: "statsOnly" },
        "1": { action: "startRecord", target: "raw" },
        "2": { action: "stopRecord", target: "raw" },
      },
    },
  };

  panel.append(
    header,
    actionDocPara("只读接口：只接受 GET/HEAD，其它方法返回 405；所有响应均为 JSON（500 为纯文本）。"),
    actionDocPara("长轮询超时返回 200 {ok:false,timeout:true}；还没收到过完整 v3 帧时返回 503；未知路径 404。"),
    actionDocPara("页面隐藏时前端暂停轮询，恢复可见时丢弃积压事件（只对齐 lastSeq，不补执行）。"),
    table,
    actionDocPara("示例：GET /api/action → 200"),
    actionDocPre(snapshotExample),
    actionDocPara("示例：GET /api/action/events?after=6&timeoutMs=10000 → 200"),
    actionDocPre(eventsExample),
    actionDocPara("示例：GET /api/action/config → 200"),
    actionDocPre(configExample),
  );
  mask.append(panel);
  document.body.append(mask);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && actionApiDocMask !== null && actionApiDocMask.style.display !== "none") {
      closeActionApiDoc();
    }
  });
  return mask;
}

function openActionApiDoc(): void {
  if (actionApiDocMask === null) actionApiDocMask = buildActionApiDoc();
  actionApiDocMask.style.display = "flex";
}

function closeActionApiDoc(): void {
  if (actionApiDocMask !== null) actionApiDocMask.style.display = "none";
}

/** 启动轮询（页面启动时调一次；重复调用幂等） */
function startActionPolling(): void {
  if (actionPollTimer !== null) return;
  actionPollTimer = window.setInterval(() => {
    void refreshActionSnapshot();
  }, ACTION_SNAPSHOT_POLL_MS);
  void refreshActionSnapshot();
  void refreshActionConfigMirror();
  void runActionEventsLoop();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    // 恢复可见：先丢积压，再重新对齐快照/镜像/事件游标（契约 §5.6 第 4 条）
    actionLastSeq = -1;
    void refreshActionSnapshot();
    void refreshActionConfigMirror();
    void runActionEventsLoop();
  });
}

// ---------- 长录（网关 /rec/*）：1 s 轮询 + 按钮 start/stop ----------
// 设计口径（task-31，别改成"更聪明的"做法）：
//   · 状态只信 GET /rec/status；刷新页面后从网关恢复，不写 localStorage；
//   · 1 s 轮询即可（10 Hz 会把网关当状态机用，也会让底栏数字跳得看不清）；
//   · 接口不可达只是"未连接"，不抛异常、不弹错误 toast（旧面板没有 /rec 是正常现场）；
//   · 丢帧优先红、ffmpeg 重开黄；实际 fps 用 counters.frames / durationMs 算，
//     21.5 fps 是合成源真实吞吐，不是坏了。
let longRecStatus: RecStatusWire | null = null;
let longRecBusy = false;
let longRecPollTimer: number | null = null;
let longRecPollInFlight = false;
/** 动作代际：start/stop 发出后让在途的旧 poll 结果作废，避免"刚点停止又跳回录制中" */
let longRecGeneration = 0;

function applyLongRecStatus(status: RecStatusWire | null): void {
  const view = formatRecStatus(status);
  const active = status?.active === true;
  const btn = recButtonState(active, longRecBusy);
  btnLongRec.textContent = btn.label;
  btnLongRec.disabled = btn.disabled;
  btnLongRec.title = btn.title;
  // 长录进行中用红色按钮（与底栏 .rec.live 的红点一致）；空闲时恢复 ghost 虚线
  btnLongRec.style.background = active ? "var(--on)" : "";
  btnLongRec.style.borderColor = active ? "var(--on)" : "";
  btnLongRec.style.color = active ? "#fff" : "";
  recLongIndEl.classList.toggle("live", active);
  recLongTxt.textContent = view.text;
  recLongTxt.style.color = recToneColor(view.tone);
  recLongSub.textContent = view.subText;
  recLongSub.style.display = view.subText === "" ? "none" : "block";
  recLongIndEl.title = view.title;
}

async function refreshLongRecStatus(): Promise<void> {
  if (document.hidden || longRecPollInFlight) return;
  longRecPollInFlight = true;
  const gen = longRecGeneration;
  try {
    const s = await fetchRecStatus();
    // 请求在途时用户点了 start/stop：旧结果不能再覆盖新状态
    if (gen !== longRecGeneration) return;
    longRecStatus = s;
    applyLongRecStatus(s);
  } finally {
    longRecPollInFlight = false;
  }
}

async function toggleLongRec(): Promise<void> {
  if (longRecBusy) return;
  longRecBusy = true;
  longRecGeneration += 1;
  const wasActive = longRecStatus?.active === true;
  // 先把按钮置灰，避免用户连点两次 start（网关会 409，但这里的请求在途状态更直观）
  applyLongRecStatus(longRecStatus);
  try {
    const result = wasActive ? await stopRec() : await startRec();
    if (result.ok && result.status !== undefined) {
      longRecStatus = result.status;
      applyLongRecStatus(result.status);
      notify(wasActive ? "长录已停止：网关正在封口 chunk（mp4 + CSV 落盘）" : "长录已开始：网关把完整帧写 mp4，事件/帧表写 CSV", "ok");
    } else {
      longRecStatus = null;
      applyLongRecStatus(null);
      notify("长录接口不可用：" + (result.error ?? "未知错误"), "warn");
    }
  } finally {
    longRecBusy = false;
    applyLongRecStatus(longRecStatus);
    longRecGeneration += 1;
    void refreshLongRecStatus();
  }
}

/** 启动长录轮询（页面启动时调一次；重复调用幂等） */
function startLongRecPolling(): void {
  if (longRecPollTimer !== null) return;
  longRecPollTimer = window.setInterval(() => {
    void refreshLongRecStatus();
  }, REC_STATUS_POLL_MS);
  void refreshLongRecStatus();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    // 恢复可见：立即对一次网关，别等下一个 1 s tick
    longRecGeneration += 1;
    void refreshLongRecStatus();
  });
}

/** 「导出当前帧（PNG）」：导出**当前这一帧**，目标画面由下拉框选 */
function exportCurrentFrame(): void {
  const frame = currentAsRecorded();
  if (frame === null) {
    notify("还没有收到任何帧，无法导出", "warn");
    return;
  }
  const target = exportTarget;
  // 当前帧不在录制缓冲里，用**界面上那份实时位图**（含当前余晖）而不是回放出来的
  const canvas = renderRecordedFrame({
    target, frame, events: bitmap, profile: activeProfile, stats, hudText: hudEventInfo.text,
  });
  const size = nativeSize(target, frame, bitmap);
  void canvasToPngBytes(canvas)
    .then((png) => {
      const name = timestampedName("retina-frame-" + target, "png");
      saveBytes(png, name, "image/png");
      notify("已导出当前帧（" + targetLabel(target) + " · " + size.w + "×" + size.h + "）：" + name, "ok");
    })
    .catch((err: unknown) => {
      notify("导出当前帧失败：" + (err instanceof Error ? err.message : String(err)), "error");
    });
}

function targetLabel(t: ExportTarget): string {
  return EXPORT_TARGETS.find((x) => x.id === t)?.label ?? t;
}

/** 「导出选中片段」：把时间轴上选中的区间导成 MP4 片段（片段 = 视频，这才对得上这个名字） */
function exportClip(): void {
  if (exporting) {
    notify("上一次导出还没结束（可以点「取消导出」）", "warn");
    return;
  }
  const all = recorder.frames;
  const sel = timeline.selection();
  if (sel === null || all.length === 0) {
    notify("先在时间轴上拖出要导出的片段（底栏左侧那条轨道），再点这里", "warn");
    return;
  }
  void runExport("mp4", all.slice(sel.from, sel.to + 1), { from: sel.from, to: sel.to });
}

/** 按钮的可用状态：缓冲区空 / 没有视频编码器时**必须置灰并说明原因**，而不是让人点了才失败 */
function refreshExportButtons(): void {
  const frames = recorder.frames;
  const sel = timeline.selection();
  // 选区感知（BLOCK-REC-1）：有选区只按选区帧判定，无选区保留整段 every 的保守行为。
  // 空/越界选区得到 0 帧，exporterAvailability 先报"缓冲是空的"，不会被放宽成"有帧可用"。
  const scope = exportAvailabilityForSelection(frames, sel);
  for (const a of scope.availability) {
    const btn = document.getElementById("exp-" + a.spec.id);
    if (!(btn instanceof HTMLButtonElement)) continue;
    btn.disabled = exporting || !a.enabled;
    btn.title = a.enabled
      ? a.spec.blurb + "\n" + (scope.hasSelection
        ? "只导出时间轴选区（" + scope.frames.length + " 帧）"
        : "没有选区，导出整个缓冲")
      : a.reason + "\n" + a.spec.blurb;
  }
  btnExportFrame.disabled = exporting || current === null;
  // clip MP4 与顶部按钮共用同一个选区帧集合与 allFramesHaveRaw 判据，避免两套口径漂移。
  const clip = clipExportState(frames, sel);
  btnExportClip.disabled = exporting || !clip.enabled;
  btnExportClip.title = clip.enabled && sel !== null
    ? "把选中的帧 " + sel.from + "~" + sel.to + "（" + clip.frames.length + " 帧）导成 MP4 片段"
    : clip.reason;
}


window.addEventListener("keydown", (ev) => {
  if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
  switch (ev.key) {
    case " ":
      ev.preventDefault();
      setFrozen(!frozen);
      break;
    case "1": case "2": case "3": case "4": {
      const id = Number(ev.key);
      const already = panes.find((p) => p.spec.id === id)?.el.classList.contains("focus") === true;
      focusPane(already ? null : id);
      break;
    }
    case "l": case "L":
      presetIdx = (presetIdx + 1) % LAYER_PRESETS.length;
      applyPreset(presetIdx);
      break;
    case "r": case "R":
      setRecording(!recording);
      break;
    case "e": case "E":
      exportCurrentFrame();
      break;
    case "Escape":
      focusPane(null);
      break;
    default:
      break;
  }
});

stageEl.addEventListener("pointermove", (ev) => {
  pointer = { x: ev.clientX, y: ev.clientY, down: ev.buttons !== 0 };
});
stageEl.addEventListener("pointerleave", () => {
  pointer = null;
});
stageEl.addEventListener("pointerdown", (ev) => {
  pointer = { x: ev.clientX, y: ev.clientY, down: true };
  const target = (ev.target as HTMLElement).closest(".pane");
  if (target instanceof HTMLElement) {
    const id = Number(target.dataset["pane"]);
    const focused = target.classList.contains("focus");
    focusPane(focused ? null : id);
  }
});

for (const seg of segMode.children) {
  seg.addEventListener("click", () => {
    const mode = (seg as HTMLElement).dataset["mode"];
    if (mode !== "board" && mode !== "host" && mode !== "synth") return;
    if (mode === "host" && (evOnlyView.active || evOnlyAutoSource || (v3Status !== null && v3Status.mode === 2))) {
      notify("板端只回传事件（EV_ONLY）：没有原始帧，上位机模拟无法计算，已保持板端事件源", "warn");
      return;
    }
    // 用户在 EV_ONLY 期间手动选板端/合成源 = 明确覆盖自动恢复，别在 RAW_EV 回来后把他拽回 host
    if (evOnlyAutoSource && mode !== "host") {
      evOnlyAutoSource = false;
      evOnlySavedSource = null;
    }
    applyUiMode(mode);
  });
}
btnPause.addEventListener("click", () => setFrozen(!frozen));
btnSide.addEventListener("click", () => side.classList.toggle("open"));
btnExportFrame.addEventListener("click", exportCurrentFrame);
btnExportClip.addEventListener("click", exportClip);
btnRec.addEventListener("click", () => setRecording(!recording));
btnLongRec.addEventListener("click", () => { void toggleLongRec(); });
btnExpCancel.addEventListener("click", () => {
  exportCancelled = true;
  notify("已请求取消导出（正在收尾当前这一帧）", "warn");
});

// 5 个导出按钮：以前它们是装饰 span，没有任何处理函数 —— 这正是"点了没反应"的原因。
// 现在逐个按 data-export 接上。用 querySelectorAll 而不是写 5 遍，避免以后加格式漏接线。
for (const el2 of document.querySelectorAll<HTMLButtonElement>("button.chip[data-export]")) {
  const id = el2.dataset["export"];
  if (id === undefined) continue;
  el2.addEventListener("click", () => {
    if (!EXPORTERS.some((e) => e.id === id)) {
      notify("未登记的导出格式：" + id, "error");
      return;
    }
    exportNow(id as ExporterId);
  });
}

// 导出目标下拉框：「导出当前帧」与视频导出都按它选画面（用户 2026-10-06 的建议）
for (const t of EXPORT_TARGETS) {
  const o = document.createElement("option");
  o.value = t.id;
  o.textContent = t.label;
  o.title = t.note;
  selFrameTarget.append(o);
}
selFrameTarget.value = exportTarget;
selFrameTarget.addEventListener("change", () => {
  const v = selFrameTarget.value;
  const found = EXPORT_TARGETS.find((t) => t.id === v);
  if (found === undefined) return;
  exportTarget = found.id;
  notify("导出画面已切到「" + found.label + "」", "info");
});

// 选区变化 ⇒ 片段按钮的可用状态与提示必须跟着变（否则又是"看着能点其实不能"）
timeline.onSelectionChange(() => refreshExportButtons());

// ---------- 启动 ----------
const wantSynth = qs.get("mode") === "synth";
if (wantSynth) client.setMode("synth");
client.start();
// 动作回传轮询（契约 §5.6）：快照 500 ms + 事件长轮询；首次只对齐游标，不执行历史
startActionPolling();
// 长录状态：1 s 轮询 /rec/status；刷新页面后由网关恢复 active，不存前端本地状态
startLongRecPolling();
requestAnimationFrame(render);
window.setInterval(refreshUi, 200);
window.setInterval(() => {
  if (recording) recElapsedMs = Date.now() - recStartedAtMs;
  timeline.update({
    recording,
    elapsedMs: recElapsedMs,
    bufferBytes: recorder.bytes,
    frames: recorder.frames.length,
    capacityBytes: recorder.capacityBytes,
    evicted: recorder.evictionCount,
  });
}, 500);
// 首帧来到之前也先渲染一次，保证"页面一打开就有骨架和四窗格背景"
refreshUi();
refreshExportButtons();

/**
 * 自检钩子（给自动化验证用，不参与界面逻辑）。
 *
 * 为什么要它：导出这条链路里最贵的一段（离屏渲染 + PNG 编码 + zip 打包 + 视频编码）
 * **在 Node 里跑不起来**（要 DOM/Canvas/MediaRecorder），而"点一下按钮看有没有文件下来"
 * 又没法在无头浏览器里断言。所以留一个能在页面里被 evaluate 的入口，把每一步的
 * 真实产出（字节数、PNG 签名、zip 条目数、视频可解码性）报出来。
 */
interface SelftestReport {
  readonly ok: boolean;
  readonly frames: number;
  readonly recording: boolean;
  readonly exportTarget: ExportTarget;
  readonly video: { ok: boolean; mime: string | null; detail: string };
  readonly steps: { step: string; ok: boolean; detail: string }[];
}
(globalThis as unknown as { __retinaSelftest?: (opts?: { encodeVideo?: boolean; videoFrames?: number }) => Promise<SelftestReport> }).__retinaSelftest =
  async (opts) => {
    const steps: { step: string; ok: boolean; detail: string }[] = [];
    const frames = recorder.frames;
    const add = (step: string, ok: boolean, detail: string): void => {
      steps.push({ step, ok, detail });
    };
    add("录制缓冲", frames.length > 0, frames.length + " 帧 / " + humanBytes(recorder.bytes));

    // ① 离屏渲染：尺寸必须是原生分辨率（与窗口无关）
    let canvas: HTMLCanvasElement | null = null;
    try {
      canvas = renderAt(exportTarget, frames, frames.length - 1);
      const size = nativeSize(exportTarget, frames[frames.length - 1] as RecordedFrame, bitmap);
      add(
        "离屏渲染",
        canvas.width === size.w && canvas.height === size.h,
        canvas.width + "×" + canvas.height + "（期望 " + size.w + "×" + size.h + "）",
      );
    } catch (e) {
      add("离屏渲染", false, e instanceof Error ? e.message : String(e));
    }

    // ② PNG 编码：必须真的是 PNG（签名 89 50 4E 47）
    if (canvas !== null) {
      try {
        const png = await canvasToPngBytes(canvas);
        const sig = png.length > 4 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
        add("PNG 编码", sig && png.length > 1000, png.length + " B，签名" + (sig ? "正确" : "错误"));
      } catch (e) {
        add("PNG 编码", false, e instanceof Error ? e.message : String(e));
      }
    }

    // ③ 纯导出：bin / csv / json（这几条在 Node 单测里也测过，这里是端到端再确认一次）
    try {
      const bin = buildRawBin(frames, manifestBase({ from: 0, to: frames.length - 1 }, frames));
      add("原始帧 .bin", bin.length > frames.length * 100, bin.length + " B（" + frames.length + " 帧）");
    } catch (e) {
      add("原始帧 .bin", false, e instanceof Error ? e.message : String(e));
    }
    try {
      const csv = buildEventsCsv(frames);
      add("事件流 .csv", csv.includes("frame_idx") && csv.includes("\r\n"), csv.length + " 字符");
    } catch (e) {
      add("事件流 .csv", false, e instanceof Error ? e.message : String(e));
    }
    try {
      const js = buildDetectionsJson(frames);
      const parsed = JSON.parse(js) as { frames?: unknown[] };
      add("检测结果 .json", Array.isArray(parsed.frames), (parsed.frames?.length ?? 0) + " 帧");
    } catch (e) {
      add("检测结果 .json", false, e instanceof Error ? e.message : String(e));
    }

    // ④ zip：用浏览器自己的 DecompressionStream 解不开 zip，所以只查结构与条目数；
    //    真正的解压验收在 Node 侧单测里用独立解析器做（见 web/test/zip.test.ts）。
    try {
      const res = await buildPngSequenceZip({
        frames: frames.slice(0, Math.min(4, frames.length)),
        renderOne: (i) => renderAt(exportTarget, frames, i),
        manifest: manifestBase({ from: 0, to: 3 }, frames),
      });
      const eocd = res.zip.length > 22 && res.zip[res.zip.length - 22] === 0x50;
      add("PNG 序列 .zip", res.entries >= 3 && eocd, res.entries + " 条目 / " + res.zip.length + " B");
    } catch (e) {
      add("PNG 序列 .zip", false, e instanceof Error ? e.message : String(e));
    }

    // ⑤ 视频：编一小段，然后用 <video> **真的解码一遍**再读 duration/尺寸 ——
    //    "文件生成成功"不等于"能播"，必须让浏览器自己解一次才算证据。
    const cap = probeVideoEncoding();
    if (opts?.encodeVideo === true && cap.ok && cap.mime !== null) {
      try {
        // 帧数可调（videoFrames）：编码器对"极短片段"有暖机窗口，判定阈值要用真实数据定，
        // 不能靠猜 —— 见 export/mp4.ts 里的注释与 test/ui_export_e2e.mjs 的探测。
        const n = Math.min(Math.max(1, opts.videoFrames ?? 12), frames.length);
        const size = nativeSize(exportTarget, frames[0] as RecordedFrame, bitmap);
        const res = await encodeVideo(n, {
          fps: EXPORT_FPS, width: size.w, height: size.h, mime: cap.mime,
          timesMs: frames.slice(0, n).map((f) => f.tMs),
          draw: (i, ctx) => ctx.drawImage(renderAt(exportTarget, frames, i), 0, 0),
        });
        const v = document.createElement("video");
        v.muted = true;
        v.src = URL.createObjectURL(res.blob);
        const meta = await new Promise<{ d: number; w: number; h: number } | null>((resolve) => {
          const t = window.setTimeout(() => resolve(null), 8000);
          v.addEventListener("loadedmetadata", () => {
            window.clearTimeout(t);
            resolve({ d: v.duration, w: v.videoWidth, h: v.videoHeight });
          });
          v.addEventListener("error", () => {
            window.clearTimeout(t);
            resolve(null);
          });
        });
        URL.revokeObjectURL(v.src);
        add(
          "视频编码 + 解码回读",
          meta !== null && meta.w === size.w && meta.h === size.h && Number.isFinite(meta.d),
          meta === null
            ? "生成 " + res.blob.size + " B 但浏览器解不开"
            : res.blob.size + " B / " + meta.w + "×" + meta.h + " / " + meta.d.toFixed(2) + " s / " + res.mime,
        );
        // 负向契约：片段太短时必须**报错说清怎么办**，而不是给一个 0 字节文件。
        // 这条门槛是量出来的（见 export/mp4.ts 的实测表），所以要钉住它不会被悄悄改掉。
        try {
          await encodeVideo(3, {
            fps: EXPORT_FPS, width: size.w, height: size.h, mime: cap.mime,
            draw: (i, ctx) => ctx.drawImage(renderAt(exportTarget, frames, i), 0, 0),
          });
          add("短片段必须报错而不是给空文件", false, "3 帧的导出居然成功了（门槛被改坏了？）");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          add("短片段必须报错而不是给空文件", msg.includes("片段太短"), msg);
        }
      } catch (e) {
        add("视频编码 + 解码回读", false, e instanceof Error ? e.message : String(e));
      }
    } else {
      add("视频编码 + 解码回读", !cap.ok, cap.ok ? "已跳过（传 {encodeVideo:true} 才跑）" : cap.detail);
    }

    return {
      ok: steps.every((s) => s.ok),
      frames: frames.length,
      recording,
      exportTarget,
      video: { ok: cap.ok, mime: cap.mime, detail: cap.detail },
      steps,
    };
  };

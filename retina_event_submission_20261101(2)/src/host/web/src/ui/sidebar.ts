// 侧栏六张卡：连接与指标 / 传输方式 / 事件流 / 参数控制 / 运动预测 / 渲染图层栈。
// 每张卡片上的数字都在 title 里写明公式（03 文档 §0 硬原则：每个数字可追溯到代码或文档）。
// 参数卡片一律标"只读"：v1 上位机没有写参数通路（02 §6），画一个能点但没反应的按钮等于骗人。
import { ACT_CLASS_NAMES, type Profile, type UartTelemFrame, type V3StatusView } from "@retina/protocol";
import { HOST_SIM_DEFAULT_MINDL, HOST_SIM_DEFAULT_THETA } from "@retina/retina";
import {
  ACTION_OPS,
  ACTION_TARGETS,
  defaultActionMapConfig,
  type ActionMapConfig,
  type ActionTarget,
  type ActionView,
} from "../actionmap.ts";
import { evResText, expCapText, netStateText, serStateText } from "../v3labels.ts";
import {
  BAUD_CHOICES,
  TRANSPORT_MODES,
  initialBaudChoice,
  pinBaudChoice,
  transportChipSelected,
  updateBaudChoice,
  transportClickForce,
  baudStateText,
  capabilityText,
  decisionText,
  linkHealthText,
  deframerText,
  handshakeText,
  healthText,
  modeDisabledReason,
  rawRecoverText,
  telemetryText,
  uartRxText,
  uartStatusText,
} from "../transport_labels.ts";
import type { TransportKind, TransportMode, TransportView } from "../transport_labels.ts";
import {
  BOARD_EXP_CAP_MAX,
  BOARD_EXP_CAP_MIN,
  BOARD_MINDL_MAX,
  BOARD_MINDL_MIN,
  BOARD_THETA_MAX,
  BOARD_THETA_MIN,
  HOST_PRESETS,
  MINDL_MAX,
  MINDL_MIN,
  THETA_MAX,
  THETA_MIN,
  clampBoardExpCapInput,
  clampBoardMinDlInput,
  clampInt,
  matchPreset,
} from "../hostparams.ts";
import { fmtBytes, fmtFixed, fmtInt, fmtScale } from "../format.ts";
import { LAYER_META, type LayerMeta } from "../layers/stack.ts";
import type { LayerKey } from "../layers/types.ts";
import { evOnlyLegend, type EvOnlyView } from "../pipeline/evonly.ts";
import type { SourceStatus, ViewStats } from "../types.ts";
import { el, kvRow, statBox, type StatBox } from "./dom.ts";
import {
  BoardParamThrottle,
  boardParamAckText,
  clampThetaSlider,
  shouldSyncSlider,
  sliderBadgeText,
  sliderModeOf,
  type BoardParamAckView,
} from "./sliderlink.ts";
import { Sparkline } from "./sparkline.ts";

export interface SidebarInput {
  readonly stats: ViewStats;
  readonly profile: Profile;
  readonly source: SourceStatus;
  /** 近 4 s 的 250 ms 分桶事件率（ev/s，旧→新），与卡片"近 4 s"同一窗口 */
  readonly history: readonly number[];
  /** 曲线版本号：只有它变了才重画折线（否则每 200 ms 白重画一次） */
  readonly historyRev: number;
  readonly layerOn: Readonly<Record<LayerKey, boolean>>;
  /** 网关可用时才允许下发控制（否则按钮必须灰掉，而不是假装可点） */
  readonly canRpc: boolean;
  /** 当前是否「上位机模拟处理」档位：只有这一档 θ / 守卫可调 */
  readonly hostMode: boolean;
  /** 上位机算法当前的 θ */
  readonly hostTheta: number;
  /** 上位机算法当前的守卫（最小 |ΔL|） */
  readonly hostMinDl: number;
  /** v3 板端状态（STATS 每 1 Hz 推送；网关未启用 v3 时 null） */
  readonly v3: V3StatusView | null;
  /** v3 状态版本号：值变了才回写输入框（避免 1 Hz 刷新把正在输入的数字拽回去） */
  readonly v3Rev: number;
  /**
   * 传输方式视图（UART 路线：网关 LiveTransportManager.statusView()，随 STATS 1 Hz 推来）。
   * null = 非实时源（回放/合成）或字段缺失 —— 卡片按"不可用"渲染并说明。
   */
  readonly transport: TransportView | null;
  /** 传输状态版本号（值变了才回写控件，避免打字被打断） */
  readonly transportRev: number;
  /** 串口遥测帧（帧型 A 直读：ev/act/cr；由 TYPE_CTRL 的 uartTelemetry 事件带来） */
  readonly uartTelem: UartTelemFrame | null;
  /**
   * 传输切换进行中（B1）：档位 chip 置灰、徽章显示"切换中…"。
   * 切换要 2 s（开 COM6 + 3 次握手），不禁用的话现场会连点三四次，网关侧排队重建通道。
   */
  readonly transportBusy: boolean;
  /**
   * EV_ONLY（板端 KEY3 第三档，mode=2）批次状态。
   * 这一档板端**不发原始帧**，所以卡②里"每帧 X / 96 000"永远是 0 ⇒ 必须换成"每批 X 点"口径。
   */
  readonly evOnly: EvOnlyView;
  /**
   * 最近一次 board.setParam 的 ACK 结果（C：在参数卡里**就地**回显，
   * 不只弹 toast —— 板端 BAD_VALUE 的错误码只有就地显示才能跟文档对上）。
   */
  readonly boardParamAck: BoardParamAckView | null;
  /** ACK 结果版本号（变了才重写文本，避免 5 Hz 刷新重复写 DOM） */
  readonly boardParamAckRev: number;
  /** 事件级运动预测状态（可选：回放/旧调用方没有这一项时卡片按默认值渲染） */
  readonly motion?: MotionUiView;
  /** 动作识别视图（M4：byte23 快照 + 本地映射 + 事件序号；缺省 = 卡片按默认值渲染） */
  readonly action?: ActionView;
}

/** v3 板端下发回调（main.ts → board.* RPC）；不提供 = 界面按"不可用"渲染并说明原因 */
export interface BoardActions {
  /** SET_PARAM：θ / MIN_DL 下发（§6.3.1 tag 0x01/0x02） */
  onBoardParam: (patch: { theta?: number; minDl?: number }) => void;
  /** SET_MODE：0=RAW+EV / 1=RAW / 2=EV（§6.3.2；KEY3 物理键只在 0↔2 两态切换，MODE1 仅命令可下） */
  onBoardMode: (mode: 0 | 1 | 2) => void;
  /** PC 主动校准一次（TIME_SYNC，§6.3.3；F2：手动优先于 10 min 自动节流，只挡 2 s 内连点） */
  onBoardCalibrate: () => void;
  /** FRAME_DECIM 下发（§6.3.1 tag 0x03） */
  onBoardDecim: (v: number) => void;
  /** 事件支路开关（v3.1 增补 EV_EN=0x05）：true=使能 / false=禁用 */
  onBoardEvEn: (enabled: boolean) => void;
  /**
   * 曝光上限下发（**sccb 集成 tag 0x0B EXP_CAP**，sccb 集成报告 §9.1；单位 = 行，4..5904）。
   * E0~E6 实测时用户会频繁切这个值（同一把位流内纯命令切换）。
   */
  onBoardExpCap: (v: number) => void;
}

export interface SidebarHandle {
  readonly el: HTMLElement;
  update(input: SidebarInput): void;
}

/** 运动预测的界面视图（main.ts 每 200 ms 推一次；可选 = 旧调用方不受影响） */
export interface MotionUiView {
  readonly enabled: boolean;
  readonly horizonS: number;
  /** 已确认轨迹数（hits ≥ 2） */
  readonly trackCount: number;
  /** 当前事件滑动窗口内的事件数 */
  readonly eventCount: number;
  readonly updatedAtMs: number;
}

/**
 * 传输方式选择回调（UART 路线 §8.2 H7）。
 * 为什么独立于 BoardActions：它管的是**数据从哪来**（UDP/UART/自动），不是板端命令；
 * 且它的失败路径是"COM6 打开失败 ⇒ 保持当前通道 + 明确报错"，与 board.* 的语义不同。
 */
export interface TransportActions {
  /** 选传输方式：udp / uart / auto（网关先建后拆，失败会带原因回 toast） */
  onSelect(mode: TransportMode, force?: boolean): void;
  /** 改串口号并应用（如 COM6 → COM7；对 udp 档只是记下备用） */
  onApplyPort(path: string): void;
  /**
   * B：切换串口波特率（115200/230400/460800/921600）。
   * 串口主通道 = 完整的"板端 ACK → 关旧口 → 新档重开 → GET_STATUS 验证"舞蹈；
   * 网口主通道 = 只发 0x0C 让板端切档。失败由网关带回明确原因。
   */
  onSetBaud(baud: number): void;
}

/**
 * 动作识别卡片的回调（M4）。为什么映射的持久化与网关同步不放在卡片里：
 *   卡片只表达"用户想怎么映射"；localStorage 写入与 WS config.set 是页面级副作用，
 *   必须走 main.ts 的单一出口（否则多份 localStorage 键名/网关键名迟早漂移）。
 */
export interface ActionUiActions {
  /** 下拉/输入变化：main 负责写 localStorage + WS config.set {actionMap} */
  onConfig(config: ActionMapConfig): void;
  /** "API 文档"按钮：纯前端模态，不发任何请求（契约 §5.7） */
  onOpenApiDoc(): void;
}

/** 图层 key → 界面上的 L 编号（L0..L5，与 03 文档 §3 的表一致） */
const LAYER_NO: Record<LayerKey, string> = {
  BACKGROUND: "L0", RAW: "L1", EVENTS: "L2", HUD: "L3", POSTPROC: "L4", INTERACT: "L5",
};

/** 从未收到过 VALID=1 时的提示：当前位流可能根本没开动作回传，不能误报成"无动作"。 */
export const ACTION_PENDING_TEXT = "等待板卡动作引擎 · 当前位流未启用动作回传";

export type ActionResultTone = "warn" | "ok" | "";

export interface ActionResultState {
  /** 单调标志：一旦为 true，本次页面会话内不再回到等待态（只放内存，不写 localStorage）。 */
  readonly sawValid: boolean;
  readonly text: string;
  readonly tone: ActionResultTone;
}

/**
 * 动作卡片"当前结果"的纯状态机。
 *
 * 为什么不能只看当前帧：当前位流未启用动作回传时 byte23 恒 0（VALID=0），
 * 只看当前帧会把"引擎没开"误显示成"当前无动作"，演示时看起来像识别失败。
 * 因此用 sawValid 记住本页是否见过 VALID=1；见过之后即使回到 VALID=0 也只显示"无动作"。
 */
export function actionResultState(prevSawValid: boolean, av: ActionView): ActionResultState {
  const sawValid = prevSawValid || av.valid;
  if (!sawValid) return { sawValid, text: ACTION_PENDING_TEXT, tone: "warn" };
  if (!av.available) return { sawValid, text: "无数据（等待 v3 帧）", tone: "warn" };
  if (!av.valid) return { sawValid, text: "无动作", tone: "" };
  if (av.class === 3) return { sawValid, text: "保留类（不执行映射）", tone: "warn" };
  if (av.class === 0) return { sawValid, text: "无动作", tone: "" };
  return {
    sawValid,
    text: av.className + " · 置信度 " + (av.conf ?? 0) + "/31",
    tone: "ok",
  };
}

function cardHead(title: string, right: string): { card: HTMLElement; right: HTMLElement } {
  const card = el("div", "card");
  const h = el("h4", "", title);
  const r = el("span", "r", right);
  h.append(r);
  card.append(h);
  return { card, right: r };
}

export function mountSidebar(
  root: HTMLElement,
  onToggleLayer: (key: LayerKey) => void,
  onRpc: (method: string) => void,
  /**
   * 给用户一句话的出口（toast）。
   * 为什么参数卡非要它不可：这张卡上有一批**刻意只读**的控件，
   * 没有它就只能"点了没反应"，而用户无法区分"设计如此"和"按钮坏了"。
   */
  notify: (message: string, tone?: "info" | "ok" | "warn" | "error") => void,
  /** 只有在「上位机模拟处理」档位下才有意义：改上位机算法的参数（θ / 守卫） */
  onHostParam: (patch: { theta?: number; minDl?: number }) => void,
  /** v3 板端下发（缺省 = 网关不支持，控件按"不可用+原因"渲染） */
  onBoard?: BoardActions,
  /** 传输方式选择（缺省 = 非实时源：卡片按只读渲染并说明原因） */
  onTransport?: TransportActions,
  /** 运动预测开关/时域变化（缺省 = 卡片仍可点，但不回调；main.ts 必须传） */
  onMotion?: (cfg: { enabled?: boolean; horizonS?: number }) => void,
  /** 动作识别映射/API 文档（缺省 = 卡片只读渲染，改动会提示"未接线"） */
  onAction?: ActionUiActions,
): SidebarHandle {
  /** 当前是否处于「上位机模拟处理」档位（θ 可调）；由 update() 每 200 ms 刷新 */
  let hostModeNow = false;
  /** v3 下行是否可用（onBoard 存在且网关报 downlinkAvailable）；板端面板的点击开关 */
  let boardDownlinkNow = false;
  /** 上次回写板端参数框时的 v3 状态版本（值变了才回写，别打扰正在输入的人） */
  let boardParamRev = -1;
  /** 曝光上限输入框的 v3Rev 节流（与 boardParamRev 同一口径，独立计数避免互相顶掉） */
  let expCapRev = -1;
  /** θ/δL **滑条**的读回版本（分开计数：拖 θ 时不能把 δL 的回写也一起吞掉） */
  let thetaSliderRev = -1;
  let guardSliderRev = -1;
  /** SET_PARAM ACK 结果版本（变了才重写就地回显行） */
  let boardAckRevNow = -1;
  /** 传输卡片：上次回写的版本（串口号输入框只在"传输状态变了"时回写，别抢正在输入的光标） */
  let transportRevNow = -1;
  /**
   * A1：当前**实际主通道**（udp/uart），来自网关 statusView.active / decision.active ——
   * 不是 decision.mode（那只是启动参数，运行期切到串口后仍可能是 "udp"）。
   */
  let transportActiveNow: TransportKind | null = null;
  let transportBusyNow = false;
  let transportBusyNowPrev = false;
  /** MODE1 被禁用时的理由（仅串口档；由传输状态刷新，板端模式 chip 点击时读它） */
  let mode1Blocked: string | null = null;
  // ---- ① 连接与指标 ----
  const c1 = cardHead("连接与指标", "近 4 s");
  const kv = el("dl", "kv");
  const rowBoard = kvRow("板卡 ← 本机");
  const rowWire = kvRow("协议 / profile");
  const rowDown = kvRow("控制下行");
  const rowLast = kvRow("最后收包");
  kv.append(rowBoard.dt, rowBoard.dd, rowWire.dt, rowWire.dd, rowDown.dt, rowDown.dd, rowLast.dt, rowLast.dd);
  const sFps = statBox("回传帧率", "fps");
  const sCam = statBox("相机帧率（反推）", "fps");
  const sBw = statBox("带宽", "MB/s");
  const sPps = statBox("包率", "pkt/s");
  sFps.box.title = "窗口内 FRAME_RAW 条数 ÷ 窗口秒数（4 s 窗口）";
  sCam.box.title = "回传帧率 × profile.frameDecim（02 文档 §2.7 H31 的反推口径）";
  sBw.box.title = "原始字节 ÷ 窗口秒数";
  sPps.box.title = "段数 ÷ 窗口秒数（v2 每帧 750 段，见 02 §2.3）";
  const stats1 = el("div", "stats");
  stats1.style.marginTop = "7px";
  stats1.append(sFps.box, sCam.box, sBw.box, sPps.box);
  c1.card.append(kv, stats1);

  // ---- ①b 传输方式（UART 路线 §8.2 H7：UDP / UART / 自动 + 串口状态 + 遥测直读）----
  // 为什么单独一张卡：它决定"数据从哪条物理通道来"，与板端参数/事件流是两件事；
  // 降级（仅事件回传）必须一眼可见 —— 否则用户会以为"网口还在工作"。
  const cT = cardHead("传输方式", "UART 路线");
  const tModeBox = el("div", "ctlbox");
  const tModeChips = new Map<TransportMode, HTMLElement>();
  for (const m of TRANSPORT_MODES) {
    const chip = el("span", "", m.label);
    chip.title = m.note;
    chip.addEventListener("click", () => {
      if (onTransport === undefined) {
        notify("传输方式不可切换：当前不是实时源（回放/合成），或网关未启用传输路由", "warn");
        return;
      }
      if (transportBusyNow) {
        notify("传输方式正在切换中（最长 20 s，串口要开 COM + 3 次握手），本次点击已忽略", "info");
        return;
      }
      // A2：点当前 active 档 = 强制重连（不是"已经是该档"的空操作）。
      // 现场症状正是：网关 active=uart，chip 却按启动模式 udp 高亮，点"网口"被这里拦掉。
      if (transportClickForce(m.v, transportActiveNow)) {
        notify("正在重新连接「" + m.label + "」…", "info");
        onTransport.onSelect(m.v, true);
        return;
      }
      onTransport.onSelect(m.v);
    });
    tModeChips.set(m.v, chip);
    tModeBox.append(chip);
  }
  const tPort = el("input", "valnum");
  tPort.type = "text";
  tPort.value = "COM6";
  tPort.style.width = "76px";
  tPort.title = "串口号（CH340 枚举，设备管理器可见）。115200 8N1 无流控 —— WIRE-U1 §2.1 硬约束";
  const tApply = el("button", "btn", "应用");
  tApply.style.padding = "1px 7px";
  tApply.style.fontSize = "10.5px";
  tApply.addEventListener("click", () => {
    if (onTransport === undefined) {
      notify("串口号不可改：当前不是实时源（回放/合成）", "warn");
      return;
    }
    const p = tPort.value.trim();
    if (p === "") {
      notify("串口号不能为空（如 COM6）", "warn");
      return;
    }
    onTransport.onApplyPort(p);
  });
  const tPortBox = el("div", "ctlbox");
  tPortBox.append(tPort, tApply);
  const tBadge = el("span", "readonly", "—");
  // B：波特率 4 档（契约 §1.1）。形态与传输档一致用 chip；选中只是"待应用"，点「应用」才真的切
  // （切档是 20 s 级的异步舞蹈，绝不能点一下 chip 就发命令）。
  const BAUD_OPTIONS: readonly number[] = BAUD_CHOICES;
  let baudChoiceState = initialBaudChoice();
  const tBaudChips = new Map<number, HTMLElement>();
  const tBaudBox = el("div", "ctlbox");
  tBaudBox.title = "串口波特率档位（契约 §1.1：115200/230400/460800/921600）。400000 不在支持列表";
  const paintBaudChips = (): void => {
    for (const [b, chip] of tBaudChips) chip.className = b === baudChoiceState.choice ? "sel" : "";
  };
  for (const b of BAUD_OPTIONS) {
    const chip = el("span", "", String(b));
    chip.title = "选择 " + b + " baud（还要点「应用」才切换）";
    chip.addEventListener("click", () => {
      if (onTransport === undefined) {
        notify("波特率不可切换：当前不是实时源（回放/合成），或网关未启用传输路由", "warn");
        return;
      }
      if (transportBusyNow) {
        notify("传输/切档正在进行中，本次点击已忽略", "info");
        return;
      }
      baudChoiceState = pinBaudChoice(baudChoiceState, b);
      paintBaudChips();
      notify("已选择 " + b + " baud；点「应用」开始切换（板端确认 + 主机重开串口）", "info");
    });
    tBaudChips.set(b, chip);
    tBaudBox.append(chip);
  }
  paintBaudChips();
  const tBaudApply = el("button", "btn", "应用");
  tBaudApply.style.padding = "1px 7px";
  tBaudApply.style.fontSize = "10.5px";
  tBaudApply.title = "切到选中的波特率档（串口：板端 ACK → 关旧口 → 新档重开 → GET_STATUS 验证；网口：只发板端命令）";
  tBaudApply.addEventListener("click", () => {
    if (onTransport === undefined) {
      notify("波特率不可切换：当前不是实时源（回放/合成），或网关未启用传输路由", "warn");
      return;
    }
    if (transportBusyNow) {
      notify("传输/切档正在进行中，本次点击已忽略", "info");
      return;
    }
    if (!BAUD_OPTIONS.includes(baudChoiceState.choice)) {
      notify("波特率只能是 " + BAUD_OPTIONS.join(" / ") + "，收到 " + String(baudChoiceState.choice), "warn");
      return;
    }
    onTransport.onSetBaud(baudChoiceState.choice);
  });
  const tBaudWrap = el("div");
  tBaudWrap.style.display = "flex";
  tBaudWrap.style.alignItems = "center";
  tBaudWrap.style.gap = "5px";
  tBaudWrap.append(tBaudBox, tBaudApply);
  const tBaudBadge = el("span", "readonly", "—");

  const tDecision = el("div", "legend");
  const tCapability = el("div", "legend");
  const tUartLine = el("div", "legend");
  const tRxLine = el("div", "legend");
  const tHealth = el("div", "legend");
  const tHandshake = el("div", "legend");
  const tDeframer = el("div", "legend");
  const tCrcLine = el("div", "legend");
  const tBaudLine = el("div", "legend");
  // A4：切到网口 3 s 仍无 FRAME_RAW 的醒目提示 + 「重试」（再 force 一次网口）
  const tRawWarn = el("div", "legend");
  const tRawWarnText = el("span", "");
  const tRawRetry = el("button", "btn", "重试");
  tRawRetry.style.padding = "1px 7px";
  tRawRetry.style.fontSize = "10.5px";
  tRawRetry.title = "强制重建网口通道（A2 force）；若板端仍在串口档，请先在板端/命令切回网口发流";
  tRawRetry.addEventListener("click", () => {
    if (onTransport === undefined) {
      notify("网口重试不可用：当前不是实时源", "warn");
      return;
    }
    if (transportBusyNow) {
      notify("传输方式正在切换中，本次重试已忽略", "info");
      return;
    }
    notify("正在重新连接「网口」…", "info");
    onTransport.onSelect("udp", true);
  });
  tRawWarn.append(tRawWarnText, tRawRetry);
  tRawWarn.style.marginTop = "3px";
  tRawWarn.style.whiteSpace = "normal";
  tRawWarn.style.color = "var(--warn)";
  tRawWarn.style.alignItems = "center";
  tRawWarn.style.display = "none";
  const tTelem = el("div", "legend");
  for (const line of [tDecision, tCapability, tUartLine, tRxLine, tHealth, tHandshake, tDeframer, tCrcLine, tBaudLine, tRawWarn, tTelem]) {
    line.style.marginTop = "3px";
    line.style.whiteSpace = "normal";
  }
  tDecision.style.fontWeight = "600";
  const tBody = el("div");
  tBody.style.marginTop = "5px";
  tBody.append(tDecision, tCapability, tUartLine, tRxLine, tHealth, tHandshake, tDeframer, tCrcLine, tBaudLine, tRawWarn, tTelem);
  const tTitle = (why: string): void => {
    tDecision.title = why;
    tUartLine.title = why;
  };
  tTitle("传输方式由网关的传输选择状态机决定（WIRE-U1 §5.3）：网口在=三模式全可选；仅串口=只事件回传（MODE1 不可用）");
  tRxLine.title = "串口实测收字节速率（网关 deframer 入口的滑动窗口，1 s）：0 B/s = 物理通道没有数据（不一定是打开失败）";
  tHealth.title = "通道健康看门狗：当前通道 ≥3 s 没有新字节/包 ⇒ 降级并写明原因（网线/串口/板端发送都可能是源头）";
  tCrcLine.title = "串口链路有效性（S7）与心跳（十修）：有效 v3 帧数、CRC 失败总数/最近 10 s 失败率、最后成功帧年龄；心跳 RTT、最近成功心跳年龄、已发/ACK 计数。CRC 持续失败 + rxBps>0 但 5 s 无有效帧时，网关会自动切回网口";
  /** 本卡片自己的行构造器（ctlRow 在参数卡那一节才定义，这里不能提前引用） */
  const tRow = (name: string, mid: HTMLElement, tail: HTMLElement): HTMLElement => {
    const row = el("div", "ctl");
    row.append(el("span", "nm", name), mid, tail);
    return row;
  };
  const tSpeed = el("span", "readonly", "115200 8N1");
  tSpeed.title = "主机串口实际打开的档位（8N1 无流控）。档位切换由板端 0x0C/0x91 确认；旧位流会明确提示不支持";
  tBaudLine.title = "B：实际档位 / 板端 0x91 读回 / 偏好档位 / open 扫描轨迹 / 上次切档结果。串口切档失败会回退旧档；网口主通道只切板端，不重开主机串口";
  cT.card.append(
    tRow("数据通道", tModeBox, tBadge),
    tRow("串口 / 端口", tPortBox, tSpeed),
    tRow("波特率", tBaudWrap, tBaudBadge),
    tBody,
  );

  // ---- ② 事件流 ----
  const c2 = cardHead("事件流", "θ = —");
  const sEv = statBox("事件率", "k/s");
  const sRed = statBox("数据量降低", "×");
  sEv.box.title = "窗口内事件条数 ÷ 窗口秒数（4 s 窗口）";
  sRed.box.title = "原始字节 ÷ 事件字节（同一窗口，按字节算，不按条数）";
  const stats2 = el("div", "stats");
  stats2.append(sEv.box, sRed.box);
  const bar = el("div", "bar");
  const barOn = el("i", "on");
  const barOff = el("i", "off");
  bar.append(barOn, barOff);
  const barWrap = el("div");
  barWrap.style.marginTop = "6px";
  barWrap.append(bar);
  const legend = el("div", "legend");
  const legOn = el("span");
  const bOn = el("b", "", "—");
  legOn.append("ON 变亮 ", bOn);
  const legMid = el("span", "", "—");
  const bOffLbl = el("b", "b", "—");
  const legOff = el("span");
  legOff.append("OFF 变暗 ", bOffLbl);
  legend.append(legOn, legMid, legOff);
  barWrap.append(legend);
  const sparkWrap = el("div", "opt");
  sparkWrap.style.marginTop = "5px";
  sparkWrap.style.borderTop = "1px solid var(--line)";
  sparkWrap.style.paddingTop = "5px";
  const sparkCanvas = el("canvas");
  const spark = new Sparkline(sparkCanvas);
  const sparkLegend = el("div", "legend");
  const spL = el("span", "", "事件率近 4 s（250 ms 格，k ev/s）");
  const spPeak = el("span", "", "峰值 —");
  const spMean = el("span", "", "均值 —");
  sparkLegend.append(spL, spPeak, spMean);
  sparkWrap.append(sparkCanvas, sparkLegend);
  c2.card.append(stats2, barWrap, sparkWrap);

  // ---- ③ 参数控制 ----
  // ⚠️ 这一整卡在 v1 是**只读**的：板端参数来自板上 4 个按键，eth_udp 不做接收解析，
  //    上位机没有任何写参数的入口（02 文档 §6）。所以这里的每一个控件都必须"点了有解释"，
  //    而不是长得像按钮却毫无反应（2026-10-06 用户反馈"很多按钮点了没反应"）。
  const c3 = cardHead("参数控制", "板端在 clk_cam 域");
  const RO = {
    theta: "只读：阈值档位由板上 KEY1 切换（sys_ctrl）。v1 没有写参数通路（02 文档 §6.2）",
    decim: "只读：v2 板端的抽帧比是 RTL 参数 FRAME_DECIM（改它要重编比特流）；换 v3 固件后可经 SET_PARAM 下发（WIRE-V3 §6.3.1 tag 0x03）",
    key0: "只读：显示源由板上 KEY0 切换（sys_ctrl），上位机读不到板端状态",
    hud: "只读：HUD 图层由板上 KEY2 轮换预设，属板端状态",
    req: "「请求切换」不可用：v1 无写参数通路（02 文档 §6.2）；需板端先实现 UART 按键注入",
  } as const;

  /** 只读的分段控件：**可以点**，点了会说明为什么改不了（比 disabled 更好：用户能看到原因） */
  const roCtlbox = (labels: readonly string[], sel: readonly string[], why: string): HTMLElement => {
    const box = el("div", "ctlbox ro");
    box.title = why;
    for (const s of labels) {
      const chip = el("span", sel.includes(s) ? "sel" : "", s);
      chip.addEventListener("click", () => notify(why, "warn"));
      box.append(chip);
    }
    return box;
  };
  const roBadge = (why: string): HTMLElement => {
    const b = el("span", "readonly", "只读");
    b.title = why;
    return b;
  };
  const ctlRow = (name: string, mid: HTMLElement, tail: HTMLElement): HTMLElement => {
    const row = el("div", "ctl");
    row.append(el("span", "nm", name), mid, tail);
    return row;
  };
  const requestBtn = el("button", "btn ghost", "请求切换");
  requestBtn.title = RO.req;
  requestBtn.style.padding = "1px 7px";
  requestBtn.style.fontSize = "10.5px";
  requestBtn.addEventListener("click", () => notify(RO.req, "warn"));
  const startBtn = el("button", "btn", "启动回传");
  const stopBtn = el("button", "btn", "停止回传");
  const grabBtn = el("button", "btn", "抓一帧");
  startBtn.title = "向板卡发单字节 '1'，开始 UDP 回传（等价旧脚本行为）";
  stopBtn.title = "向板卡发单字节 '0'，停止 UDP 回传（画面不受影响）";
  grabBtn.title = "UART 通路发 'F' 抓一帧 —— 该通路 M2 未接，点了会告知失败原因";
  const btnRow = el("div", "ctl");
  btnRow.append(el("span", "nm", "回传控制"), startBtn, stopBtn, grabBtn);

  // θ 与守卫是**唯一**在上位机模拟档位下可调的参数：
  // 板端改它们要重编比特流+重烧，上位机改只是改一个数 —— 这正是"标准对照"要的用法
  // （先在上位机扫出合适的值，再把那个值写进 RTL/sys_ctrl）。
  //
  // 为什么是**滑动条**而不是三档按钮（2026-10-06 用户要求）：板端只有 44/74/130 三档，
  // 但"哪个值才对"恰恰是要靠上位机现场找的 —— 三档按钮走不到中间那些值，
  // 而且调一次要能立刻看见效果，滑动条才做得到。
  // 刻度：只标**板端真实存在的档位**，标签就是那个数字本身。
  // ⚠️ 曾经的 bug：这里写的是 "0.12 / 0.20 / 0.35"（把 44/74/130 按 44 归一化后的比例），
  // 而滑动条的值域是原始 LSB —— 于是用户看到"值 60"配着刻度"0.20"，完全对不上，
  // 更糟的是它会让人以为 60 是个"中间值"，其实 60 已经远在可用区间之上。
  // 教训：**刻度标签必须和滑动条的值域是同一个量纲。**
  const THETA_GEARS = [
    { v: HOST_SIM_DEFAULT_THETA, label: HOST_SIM_DEFAULT_THETA + "★" },
    { v: 16, label: "16" },
    { v: 44, label: "44板端" },
    { v: 74, label: "74板端" },
    { v: 130, label: "130板端" },
  ] as const;
  /** 守卫刻度：★ 是现场调出来的工作点，18 原来看不到（最大值只有 20，滑块贴着上限） */
  const GUARD_GEARS = [
    { v: HOST_SIM_DEFAULT_MINDL, label: HOST_SIM_DEFAULT_MINDL + "★" },
    { v: 32, label: "32" },
    { v: 48, label: "48" },
  ] as const;

  /**
   * 一行滑动条：标题 + **可直接输入的数字框** + 刻度。
   *
   * 数字框为什么必须存在（2026-10-06）：θ 的值域 1~130、守卫 1~64，而滑块只有约 200 px 宽，
   * 一像素差一两个单位 —— "精确到 3"和"精确到 18"靠拖是很折腾的，而这两个数恰恰是要
   * 现场反复对出来、还要写进 RTL 的**数字**。拖出来看着对、抄下来抄错一位，那种事故不值得冒。
   */
  function sliderRow(
    name: string,
    min: number,
    max: number,
    gears: readonly { v: number; label: string }[],
    title: string,
    /**
     * commit=true 来自数字框提交/刻度点击（= 用户已经定下一个值）；
     * commit=false 是拖动过程中的连续采样（本地显示已跟手，下发要节流）。
     */
    onPick: (v: number, commit: boolean) => void,
  ): { root: HTMLElement; input: HTMLInputElement; value: HTMLInputElement; badge: HTMLElement } {
    const head = el("div", "ctl");
    const value = el("input", "valnum");
    value.type = "number";
    value.min = String(min);
    value.max = String(max);
    value.step = "1";
    value.value = String(min);
    value.title = "可以直接输入精确值（范围 " + min + "~" + max + "）";
    const badge = el("span", "readonly", "只读");
    head.append(el("span", "nm", name), value, badge);

    const input = el("input", "slider");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = "1";
    input.value = String(min);
    input.title = title;
    input.addEventListener("input", () => {
      value.value = input.value;
      onPick(Number(input.value), false);
    });

    // 数字框：提交时（回车/失焦）夹到值域并同步滑块。用 change 而不是 input ——
    // 边打字边下发的话，输 "18" 会先下发 "1"，每敲一个键就重建一次引擎。
    const commitNumber = () => {
      const n = Number(value.value);
      const clamped = Math.max(min, Math.min(max, Number.isFinite(n) ? Math.round(n) : min));
      value.value = String(clamped);
      input.value = String(clamped);
      onPick(clamped, true);
    };
    value.addEventListener("change", commitNumber);
    value.addEventListener("blur", commitNumber);

    const wrap = el("div", "sliderwrap");
    wrap.append(input);
    const ticks = el("div", "ticks");
    for (const g of gears) {
      const t = el("span", "tick", g.label);
      t.style.left = ((g.v - min) / (max - min)) * 100 + "%";
      t.title = "θ=" + g.v + "（点一下跳过去）；标「板端」的是板上 sys_ctrl 真实存在的档位";
      t.addEventListener("click", () => {
        input.value = String(g.v);
        value.value = String(g.v);
        onPick(g.v, true);
      });
      ticks.append(t);
    }
    wrap.append(ticks);

    const root = el("div", "sliderrow");
    root.append(head, wrap);
    return { root, input, value, badge };
  }

  // —— C：板端模式（非上位机模拟档）下 θ/δL 也可调，走 SET_PARAM ——
  // 拖动中节流（≤5 次/s），松手/数字框提交 150 ms 内必发最终值；本地显示由 DOM 自己跟手。
  // 1 Hz GET_STATUS 读回在拖动/输入中不回写（否则会把滑条从用户手里拽走）。
  let thetaDragging = false;
  let guardDragging = false;
  /** 最近一次用户动滑条/提交的时刻：SET_PARAM ACK 回来前（~1.2 s）不许用旧读回覆盖 */
  let thetaTouchedAt = 0;
  let guardTouchedAt = 0;
  const sendBoardParam = (key: "theta" | "minDl", v: number): void => {
    if (onBoard === undefined || !boardDownlinkNow) return;
    onBoard.onBoardParam(key === "theta" ? { theta: v } : { minDl: v });
  };
  const thetaSend = new BoardParamThrottle(sendBoardParam);
  const guardSend = new BoardParamThrottle(sendBoardParam);

  const thetaSlider = sliderRow(
    "阈值 θ",
    THETA_MIN,
    THETA_MAX,
    THETA_GEARS,
    "事件阈值 θ（空间对比门限）：判决是 (4c−(u+d+l+r))>>2 ≥ θ。" +
      "**θ 越小空间算子越接近旁路**：θ=1 时只要求 lap ≥ 4，输出退化成连通的运动区域；" +
      "θ 一抬高就只剩拉普拉斯峰 ⇒ 变成碎片化的边缘。现场实测：θ=1 孤立率 2.8%、最大连通块 38%；" +
      "θ=3 是 14.2% / 8.9%。θ=44（旧板端）在本场景等于全黑。" +
      "板端四档 = (1,20) / (1,32) / (3,18) / (44,1)，与下面四个预设一一对应。板端模式下拖动 = SET_PARAM tag 0x01",
    (v, commit) => {
      if (hostModeNow) {
        onHostParam({ theta: v });
        return;
      }
      if (onBoard === undefined || !boardDownlinkNow) {
        notify(RO.theta, "warn");
        return;
      }
      // θ 值域钳位 ≥1：0 在板端是"关掉判决"的歧义值，滑条/下发都不许出现
      const t = clampThetaSlider(v, THETA_MAX);
      thetaTouchedAt = Date.now();
      if (commit) thetaSend.commit("theta", t);
      else thetaSend.drag("theta", t);
    },
  );

  const guardSlider = sliderRow(
    "最小 |ΔL|",
    MINDL_MIN,
    MINDL_MAX,
    GUARD_GEARS,
    "事件守卫（时域变化下限）：中心像素的 |ΔL| 小于它就不算事件。" +
      "**这才是照度漂移的过滤器** —— 相机自动曝光的漂移整幅同步发生" +
      "（ΔL ≈ f(L)，实测 75%~99% 的方差只由 L 决定），幅度只有 3~8 LSB；" +
      "运动物体边缘能到 200。区域形态下守卫 20→32 可以再省 26% 事件而连通性不变。板端模式下提交 = SET_PARAM tag 0x02",
    (v, commit) => {
      if (hostModeNow) {
        onHostParam({ minDl: v });
        return;
      }
      if (onBoard === undefined || !boardDownlinkNow) {
        notify(RO.theta, "warn");
        return;
      }
      const d = clampInt(v, MINDL_MIN, MINDL_MAX);
      guardTouchedAt = Date.now();
      if (commit) guardSend.commit("minDl", d);
      else guardSend.drag("minDl", d);
    },
  );

  /** 拖动/编辑状态：指针按下到松手（或 change/blur）之间，1 Hz 读回不许动滑条 */
  // R2：松手必须立刻结算最终值（cancel 挂起的节流定时器）；keyup 覆盖键盘拖动，blur/change 覆盖触摸与数字框。
  const bindDragState = (
    s: { input: HTMLInputElement },
    set: (dragging: boolean) => void,
    release: () => void,
  ): void => {
    s.input.addEventListener("pointerdown", () => set(true));
    const end = (): void => {
      set(false);
      release();
    };
    s.input.addEventListener("pointerup", end);
    s.input.addEventListener("mouseup", end);
    s.input.addEventListener("touchend", end);
    s.input.addEventListener("pointercancel", end);
    s.input.addEventListener("keyup", end);
    s.input.addEventListener("change", end);
    s.input.addEventListener("blur", end);
  };
  const thetaRelease = (): void => {
    if (hostModeNow || onBoard === undefined || !boardDownlinkNow) return;
    thetaTouchedAt = Date.now();
    thetaSend.release("theta", clampThetaSlider(Number(thetaSlider.input.value), THETA_MAX));
  };
  const guardRelease = (): void => {
    if (hostModeNow || onBoard === undefined || !boardDownlinkNow) return;
    guardTouchedAt = Date.now();
    guardSend.release("minDl", clampInt(Number(guardSlider.input.value), MINDL_MIN, MINDL_MAX));
  };
  bindDragState(thetaSlider, (v) => (thetaDragging = v), thetaRelease);
  bindDragState(guardSlider, (v) => (guardDragging = v), guardRelease);

  // ---- 实测工作点预设 ----
  // 为什么要有它：θ 与守卫的组合决定的是**输出形态**（连通区域 vs 碎片边缘），
  // 不是"两个各自独立调到最优的旋钮"。靠拖两个滑块反复逼近某组值很费事，
  // 而这些点都已经现场扫过、有孤立率/最大连通块/数据量降低三个数字支撑。
  const presetWrap = el("div", "presets");
  const presetBtns = new Map<string, HTMLButtonElement>();
  for (const p of HOST_PRESETS) {
    const b = el("button", "", p.label);
    b.title = p.note;
    b.addEventListener("click", () => {
      if (!hostModeNow) {
        notify(RO.theta, "warn");
        return;
      }
      const t = clampInt(p.theta, THETA_MIN, THETA_MAX);
      const m = clampInt(p.minDl, MINDL_MIN, MINDL_MAX);
      thetaSlider.input.value = String(t);
      thetaSlider.value.value = String(t);
      guardSlider.input.value = String(m);
      guardSlider.value.value = String(m);
      notify("已切到「" + p.label + "」：θ=" + t + "、守卫=" + m, "ok");
      // 一次补丁同时带两个键 ⇒ 一次 RPC 就切完，不会出现"θ 换了但守卫还没换"的中间态
      onHostParam({ theta: t, minDl: m });
    });
    presetBtns.set(p.id, b);
    presetWrap.append(b);
  }

  // ---- v3 板端下行面板（WIRE-V3 设计 §6 / §7.2 前端行）----
  // 与上面的"上位机算法参数"完全独立：θ/δL 这里下发的是**板端寄存器**（SET_PARAM tag 0x01/0x02），
  // 走 UDP 1235 + ACK 读回；网关未启用 v3 下行（非 --udp 数据源）时按"不可用+原因"渲染。
  const NO_V3 = "不可用：需要 --udp 数据源 + v3 固件（下行命令走 UDP 1235，WIRE-V3 §6）";
  const ctlRow3 = (name: string, mid: HTMLElement, tail: HTMLElement): HTMLElement => {
    const row = el("div", "ctl");
    row.append(el("span", "nm", name), mid, tail);
    return row;
  };
  const boardModeBox = el("div", "ctlbox ro");
  const boardModeChips = new Map<number, HTMLElement>();
  for (const m of [
    // KEY3 物理键只在 RAW_EV ↔ EV_ONLY 两态循环（2026-10-11 语义修订）；MODE1（RAW_ONLY）
    // 保留在协议命令集中、仅上位机可下发，不绑物理键。
    { v: 0, label: "R+E", note: "原始+事件（默认；KEY3 两态之一）" },
    { v: 1, label: "R", note: "仅原始（仅上位机命令可下发，KEY3 不切到它）" },
    { v: 2, label: "E", note: "仅事件（KEY3 两态之一）" },
  ]) {
    const chip = el("span", "", m.label);
    chip.title = "SET_MODE " + m.v + "（" + m.note + "；帧边界生效，last-writer-wins，§3.2/§6.3.2）";
    chip.addEventListener("click", () => {
      if (onBoard === undefined || !boardDownlinkNow) {
        notify(NO_V3, "warn");
        return;
      }
      if (m.v === 1 && mode1Blocked !== null) {
        notify(mode1Blocked, "warn");
        return;
      }
      onBoard.onBoardMode(m.v as 0 | 1 | 2);
    });
    boardModeChips.set(m.v, chip);
    boardModeBox.append(chip);
  }
  const boardModeBadge = roBadge(NO_V3);
  boardModeBox.title = NO_V3;

  // —— 事件支路开关（v3.1 增补 EV_EN 命令 0x05）：1=使能 / 0=禁用 ——
  // 禁用时事件数据停止上行、原画回传不受影响（与 KEY3 的"切模式"不同：MODE 不变，只关事件流）。
  // 状态以**板端读回**为准（2026-10-11 对齐：EV_EN 的 ACK 与 GET_STATUS 尾部都带 TLV 0x8C）。
  const evEnBox = el("div", "ctlbox ro");
  const evEnState = el("span", "", "—");
  const evEnChips = new Map<string, HTMLElement>();
  for (const e of [
    { v: true, label: "开" },
    { v: false, label: "关" },
  ]) {
    const chip = el("span", "", e.label);
    chip.title = "EV_EN 命令（0x05，v3.1 增补）：" + (e.v ? "事件支路使能（默认）" : "事件支路禁用（事件停止上行，原画不受影响）");
    chip.addEventListener("click", () => {
      if (onBoard === undefined || !boardDownlinkNow) {
        notify(NO_V3, "warn");
        return;
      }
      onBoard.onBoardEvEn(e.v);
    });
    evEnChips.set(e.v ? "1" : "0", chip);
    evEnBox.append(chip);
  }
  evEnState.title = "事件支路当前状态 = 板端读回值（TLV 0x8C，随 EV_EN ACK 与 GET_STATUS 刷新）";
  evEnBox.append(evEnState);
  const evEnBadge = roBadge(NO_V3);
  evEnBox.title = NO_V3;

  // —— UART 板端扩展状态（板端实现报告 §3.3；2026-10-12 契约）——
  // 只读显示板端读回：TLV 0x8D EV_RES_STATE（分辨率档）、0x8E SER_STATE（抽点/聚合/串口丢计数）、
  // 0x8F NET_STATE（网口可用性，0=DOWN/1=UP/2=UNKNOWN）。
  // 这三个量由板端 uart_ev_tap / link_detect 产生，上位机不下发；下行 tag 0x07..0x0A 的编码能力
  // 已在协议层备好（buildSetParamPayload / board.setParam），UI 暂不暴露控件（避免"点了看不出效果"）。
  const uartBox = el("div", "ctlbox ro");
  const evResChip = el("span", "", "EV_RES —");
  const serChip = el("span", "", "SER —");
  const netChip = el("span", "", "NET —");
  // 曝光上限板端读回（**sccb 集成 TLV 0x90**，sccb 集成报告 §9.2，2026-10-13）：
  // 与上面三个同一条"以板端读回为准、未上报显示 —"口径；E0~E6 实测时这里是"芯片内到底写没写进去"的唯一观测点。
  const expCapChip = el("span", "", "EXP_CAP —");
  uartBox.append(evResChip, serChip, netChip, expCapChip);
  const uartBadge = roBadge(NO_V3);
  uartBox.title = NO_V3;

  const boardTheta = el("input", "valnum");
  boardTheta.type = "number";
  boardTheta.min = "0";
  boardTheta.max = "4095";
  boardTheta.step = "1";
  boardTheta.title = "板端事件阈值 θ（SET_PARAM tag 0x01，u16 BE，0..4095；ACK 带写后读回值）";
  const boardMinDl = el("input", "valnum");
  boardMinDl.type = "number";
  boardMinDl.min = String(BOARD_MINDL_MIN);
  boardMinDl.max = String(BOARD_MINDL_MAX);
  boardMinDl.step = "1";
  boardMinDl.title =
    "板端最小下采样 MIN_DL（SET_PARAM tag 0x02，u16 BE，值域 " + BOARD_MINDL_MIN + ".." + BOARD_MINDL_MAX +
    "：板端 9 bit 寄存器上限 511，>511 → BAD_VALUE 且整条命令不写；单位待算法组 U7 定案）";
  const sendParamBtn = el("button", "btn", "下发");
  sendParamBtn.style.padding = "1px 7px";
  sendParamBtn.style.fontSize = "10.5px";
  const sendParam = (): void => {
    if (onBoard === undefined || !boardDownlinkNow) {
      notify(NO_V3, "warn");
      return;
    }
    const t = boardTheta.value === "" ? undefined : Math.round(Number(boardTheta.value));
    if (t !== undefined && (!Number.isFinite(t) || t < BOARD_THETA_MIN || t > BOARD_THETA_MAX)) {
      notify("板端参数越界：θ " + BOARD_THETA_MIN + ".." + BOARD_THETA_MAX + "（设计 §6.3.1）", "warn");
      return;
    }
    // MIN_DL 钳位 0..511（统一把关报告 Q-7 / P-5）：板端 >511 ⇒ BAD_VALUE 且 SET_PARAM 原子性
    // 会让同包其它合法参数一并被拦 —— 所以这里钳位而不是原样发出；钳位必须提示（不静默改用户输入）
    let d = boardMinDl.value === "" ? undefined : Math.round(Number(boardMinDl.value));
    if (d !== undefined) {
      const c = clampBoardMinDlInput(d);
      if (c.clamped) {
        notify(
          "MIN_DL 输入 " + boardMinDl.value + " → " + c.value +
            "（板端 9 bit 寄存器上限 " + BOARD_MINDL_MAX + "，Q-7/P-5 钳位；单位待 U7 定案）",
          "warn",
        );
        boardMinDl.value = String(c.value);
      }
      d = c.value;
    }
    if (t === undefined && d === undefined) {
      notify("先填 θ 或 MIN_DL 再下发（留空 = 不改）", "info");
      return;
    }
    onBoard.onBoardParam({ ...(t === undefined ? {} : { theta: t }), ...(d === undefined ? {} : { minDl: d }) });
  };
  sendParamBtn.addEventListener("click", sendParam);
  const paramBadge = roBadge(NO_V3);
  const paramRow = ctlRow3("板端 θ/δL", (() => {
    const box = el("div", "ctl");
    box.append(boardTheta, boardMinDl, sendParamBtn);
    return box;
  })(), paramBadge);
  // C：SET_PARAM 的 ACK 结果**就地**回显（lead 要求：板端错误码不要只藏在 toast 里）。
  // 成功显示板端写后读回值；失败显示 status 错误码 + detail（BAD_VALUE 等）。
  const paramAckLine = el("div", "legend", boardParamAckText(null));
  paramAckLine.style.marginTop = "2px";
  paramAckLine.style.whiteSpace = "normal";
  paramAckLine.style.fontWeight = "600";
  paramAckLine.title = "board.setParam 的 ACK：ok / 板端 status 错误码 / 写后读回值（TLV 0x81/0x82）";

  // —— 曝光上限 EXP_CAP（**sccb 集成 tag 0x0B**，sccb 集成报告 §9.1，2026-10-13）——
  // 单位 = 行，值域 4..5904（上界 = 厂家基线原上限 0x1710，不放宽）；越界板端回 BAD_VALUE 且整条不写，
  // 故 UI 先钳位后下发（同 MIN_DL 的 Q-7/P-5 先例：钳位必须提示，不静默改用户输入）。
  // 写后约 1 ms 板端重跑整条 SCCB 曝光寄存器写序列（0x3a02/03/0x3a14/15）；等值写入零副作用。
  // E0~E6 实测时用户会频繁切这个值 ⇒ 交互 = 数字输入 + 下发（与 θ/δL 同一模式），状态显示在"串口/网口"区。
  const boardExpCap = el("input", "valnum");
  boardExpCap.type = "number";
  boardExpCap.min = String(BOARD_EXP_CAP_MIN);
  boardExpCap.max = String(BOARD_EXP_CAP_MAX);
  boardExpCap.step = "1";
  boardExpCap.title =
    "板端曝光上限 EXP_CAP（SET_PARAM tag 0x0B，u16 BE，值域 " + BOARD_EXP_CAP_MIN + ".." + BOARD_EXP_CAP_MAX +
    " 行；越界 → BAD_VALUE 且整条命令不写；ACK 带写后读回 TLV 0x90）。" +
    "E0~E6 档位：cap = VTS−4（900→896=0x0380 / 750→746=0x02EA / 600→596=0x0254 / 520→516=0x0204；基线 1000→5904=0x1710）";
  const sendExpCapBtn = el("button", "btn", "下发");
  sendExpCapBtn.style.padding = "1px 7px";
  sendExpCapBtn.style.fontSize = "10.5px";
  const sendExpCap = (): void => {
    if (onBoard === undefined || !boardDownlinkNow) {
      notify(NO_V3, "warn");
      return;
    }
    if (boardExpCap.value === "") {
      notify("先填曝光上限（" + BOARD_EXP_CAP_MIN + ".." + BOARD_EXP_CAP_MAX + " 行）再下发", "info");
      return;
    }
    const raw = Math.round(Number(boardExpCap.value));
    const c = clampBoardExpCapInput(raw);
    if (c.clamped) {
      notify(
        "曝光上限输入 " + boardExpCap.value + " → " + c.value +
          "（板端值域 " + BOARD_EXP_CAP_MIN + ".." + BOARD_EXP_CAP_MAX + " 行；越界会被 BAD_VALUE 整条拦下）",
        "warn",
      );
      boardExpCap.value = String(c.value);
    }
    onBoard.onBoardExpCap(c.value);
  };
  sendExpCapBtn.addEventListener("click", sendExpCap);
  const expCapBadge = roBadge(NO_V3);
  const expCapRow = ctlRow3("曝光上限", (() => {
    const box = el("div", "ctl");
    box.append(boardExpCap, sendExpCapBtn);
    return box;
  })(), expCapBadge);

  const calState = el("span", "", "未校准（板端时基）");  calState.title = "来自 v3 STATUS：TS_FLAGS bit0 calibrated / bit1 stale；对齐误差 = ((t4'−t1) − RTT)/2（§5.1 第 5 步）";
  const calBtn = el("button", "btn ghost", "立即校准");
  calBtn.style.padding = "1px 7px";
  calBtn.style.fontSize = "10.5px";
  calBtn.addEventListener("click", () => {
    if (onBoard === undefined || !boardDownlinkNow) {
      notify(NO_V3, "warn");
      return;
    }
    onBoard.onBoardCalibrate();
  });
  const calRow = ctlRow3("时间校准", calState, calBtn);
  const calBadge = roBadge(NO_V3);

  // 抽帧比：从写死 [1,2,4,8] 选 8 改为反映 profile.frameDecim 的真实值；
  // v3 下它还是 SET_PARAM tag 0x03 的可写参数（1..255），所以点某个值 = 下发该值
  const decimBox = el("div", "ctlbox ro");
  const decimChips = new Map<number, HTMLElement>();
  for (const v of [1, 2, 4, 8]) {
    const chip = el("span", "", String(v));
    chip.title = "FRAME_DECIM=" + v + "（SET_PARAM tag 0x03，u16 BE，1..255；v2 板端只读，v3 可写）";
    chip.addEventListener("click", () => {
      if (onBoard === undefined || !boardDownlinkNow) {
        notify(RO.decim, "warn");
        return;
      }
      onBoard.onBoardDecim(v);
    });
    decimChips.set(v, chip);
    decimBox.append(chip);
  }
  const decimBadge = roBadge(RO.decim);

  c3.card.append(
    presetWrap,
    thetaSlider.root,
    guardSlider.root,
    paramRow,
    paramAckLine,
    expCapRow,
    ctlRow("板端模式", boardModeBox, boardModeBadge),
    ctlRow("事件支路", evEnBox, evEnBadge),
    ctlRow3("串口/网口", uartBox, uartBadge),
    calRow,
    ctlRow("原始帧抽帧比", decimBox, decimBadge),
    ctlRow("显示源 KEY0", roCtlbox(["原始", "事件"], ["原始"], RO.key0), requestBtn),
    ctlRow("HUD 图层", roCtlbox(["panel", "grid", "text", "sprite"], ["panel", "grid"], RO.hud), roBadge(RO.hud)),
    btnRow,
  );

  // ---- ③.5 运动预测（事件级，只画在 L3 HUD 上） ----
  // 为什么单独一张卡：它既不是"数据源"也不是"板端参数"，而是上位机对事件流做的**演示算法**。
  // 默认开、默认 1.0 s；开关/滑条都即时生效，不设"应用"按钮（现场演示不能停下来点确认）。
  let motionEnabledNow = true;
  let motionHorizonNow = 1;
  /** 刚点/拖过：600 ms 内不拿 200 ms 前的 STATS 快照回写控件（否则开关会"弹回去"） */
  let motionTouchedAt = 0;
  const cM = cardHead("运动预测", "L3 HUD");
  const mRow = el("div", "layer");
  const mSw = el("span", "sw on");
  mSw.title = "点击开关事件级运动预测叠加（只影响 L3 HUD，不改数据/协议）";
  const mName = el("span", "n");
  mName.append("叠加显示（HUD） ");
  mName.append(el("em", "", "卡尔曼 CV · 仅事件"));
  mRow.append(mSw, mName, el("span", "b", "L3"));
  mSw.addEventListener("click", () => {
    motionEnabledNow = !motionEnabledNow;
    motionTouchedAt = Date.now();
    mSw.classList.toggle("on", motionEnabledNow);
    onMotion?.({ enabled: motionEnabledNow });
  });

  const mSliderRow = el("div", "sliderrow");
  const mHead = el("div", "ctl");
  const mValue = el("input", "valnum");
  mValue.type = "number";
  mValue.min = "0.2";
  mValue.max = "1.5";
  mValue.step = "0.1";
  mValue.value = "1.0";
  mValue.title = "预测时域（秒）：外推多远；拖动/输入即时生效（0.2~1.5，步长 0.1）";
  mHead.append(el("span", "nm", "预测时域"), mValue, el("span", "val", "s"));
  const mRange = el("input", "slider");
  mRange.type = "range";
  mRange.min = "0.2";
  mRange.max = "1.5";
  mRange.step = "0.1";
  mRange.value = "1.0";
  mRange.title = "预测时域 0.2–1.5 s（默认 1.0 s）；只改外推长度，不清空轨迹";
  const mWrap = el("div", "sliderwrap");
  mWrap.append(mRange);
  const setMotionHorizon = (raw: number): void => {
    const v = Math.max(0.2, Math.min(1.5, Number.isFinite(raw) ? raw : motionHorizonNow));
    const h = Math.round(v * 10) / 10;
    motionHorizonNow = h;
    motionTouchedAt = Date.now();
    mRange.value = String(h);
    mValue.value = h.toFixed(1);
    onMotion?.({ horizonS: h });
  };
  const mTicks = el("div", "ticks");
  for (const v of [0.2, 1.0, 1.5]) {
    const tick = el("span", "tick", v.toFixed(1));
    tick.style.left = ((v - 0.2) / 1.3) * 100 + "%";
    tick.addEventListener("click", () => setMotionHorizon(v));
    mTicks.append(tick);
  }
  mWrap.append(mTicks);
  mSliderRow.append(mHead, mWrap);

  mRange.addEventListener("input", () => setMotionHorizon(Number(mRange.value)));
  mValue.addEventListener("change", () => setMotionHorizon(Number(mValue.value)));
  mValue.addEventListener("blur", () => setMotionHorizon(Number(mValue.value)));

  const mNote = el("div", "motionnote", "卡尔曼 CV · 仅事件 · 外推");
  const mStatus = el("div", "motionstat", "等待运动事件…");
  const mFoot = el("div", "ctl");
  mFoot.append(el("span", "nm", ""), el("span", "readonly", "上位机 · 事件"));
  cM.card.append(mRow, mSliderRow, mNote, mStatus, mFoot);

  // ---- ③.6 动作识别（M4：byte23 → 类别/置信度 + 三行映射 + API 文档入口） ----
  // 位置是契约 §5.1 钉死的：运动预测之后、渲染图层栈之前。
  // 卡片本身不发任何写请求：映射改动只回调 main.ts（localStorage + WS config.set 的唯一出口）。
  let actionCfgNow: ActionMapConfig = defaultActionMapConfig(0);
  /** 本页是否见过 VALID=1（只驻内存：刷新页面 = 新会话，重新等待板卡动作引擎） */
  let actionSawValid = false;
  /** 刚动过下拉/输入：600 ms 内不拿轮询到的旧快照回写控件（否则连续改两行会被打回） */
  let actionTouchedAt = 0;
  const cA = cardHead("动作识别", "byte23 —");
  const aHeadRow = el("div", "ctl");
  const aResult = el("span", "actresult", "无数据（等待 v3 帧）");
  const aCount = el("span", "readonly", "检测次数 0");
  aCount.title = "网关累计检测次数：byte23 的 VALID 由 0 变 1（上升沿）或类别变化各记一次；置信度变化不算（task-24）";
  aHeadRow.append(el("span", "nm", "当前结果"), aResult, aCount);

  type ActionRowUi = {
    readonly cls: 0 | 1 | 2;
    readonly label: HTMLElement;
    readonly selAction: HTMLSelectElement;
    readonly selTarget: HTMLSelectElement;
  };
  const makeActionRow = (cls: 0 | 1 | 2): ActionRowUi => {
    const label = el("span", "cls", ACT_CLASS_NAMES[cls]);
    const selAction = el("select", "sel");
    for (const op of ACTION_OPS) {
      const opt = el("option", "", op);
      opt.value = op;
      selAction.append(opt);
    }
    const selTarget = el("select", "sel");
    for (const t of ACTION_TARGETS) {
      const opt = el("option", "", t);
      opt.value = t;
      selTarget.append(opt);
    }
    selAction.title = "类别 " + cls + "（" + ACT_CLASS_NAMES[cls] + "）触发的操作";
    selTarget.title = "startAndAutoExport 停止后自动导出的目标格式";
    if (cls === 0) {
      // class0=无动作：给它配任何执行动作都等于"静止画面也在录"，契约 §5.4 直接禁止
      selAction.value = "none";
      selAction.disabled = true;
      selAction.title = "class0（无动作）固定为 none，不可执行";
      selTarget.value = "statsOnly";
    } else if (cls === 1) {
      selAction.value = "startRecord";
      selTarget.value = "raw";
    } else {
      selAction.value = "stopRecord";
      selTarget.value = "raw";
    }
    return { cls, label, selAction, selTarget };
  };
  const r0 = makeActionRow(0);
  const r1 = makeActionRow(1);
  const r2 = makeActionRow(2);
  const aMapBox = el("div", "actmap");
  aMapBox.append(r0.label, r0.selAction, r0.selTarget, r1.label, r1.selAction, r1.selTarget, r2.label, r2.selAction, r2.selTarget);

  const aMinRow = el("div", "ctl");
  aMinRow.append(el("span", "nm", "触发置信度 ≥"));
  const aMinConf = el("input", "valnum");
  aMinConf.type = "number";
  aMinConf.min = "0";
  aMinConf.max = "31";
  aMinConf.step = "1";
  aMinConf.value = "8";
  aMinConf.title = "byte23 的 CONF 字段（0..31）；低于此值的事件不触发映射（契约 §5.2）";
  aMinRow.append(aMinConf, el("span", "val", "/31"));

  const applyActionControls = (): void => {
    const minConf = clampInt(Number(aMinConf.value), 0, 31);
    aMinConf.value = String(minConf);
    const cfg: ActionMapConfig = {
      v: 1,
      updatedAtMs: actionCfgNow.updatedAtMs,
      minConf,
      map: {
        "0": { action: "none", target: r0.selTarget.value as ActionTarget },
        "1": {
          action: r1.selAction.value as ActionMapConfig["map"]["1"]["action"],
          target: r1.selTarget.value as ActionTarget,
        },
        "2": {
          action: r2.selAction.value as ActionMapConfig["map"]["2"]["action"],
          target: r2.selTarget.value as ActionTarget,
        },
      },
    };
    actionCfgNow = cfg;
    actionTouchedAt = Date.now();
    if (onAction === undefined) {
      notify("动作映射未接线：本页没有 localStorage/WS 持久化通路", "warn");
      return;
    }
    onAction.onConfig(cfg);
  };
  for (const row of [r0, r1, r2]) {
    row.selAction.addEventListener("change", applyActionControls);
    row.selTarget.addEventListener("change", applyActionControls);
  }
  aMinConf.addEventListener("change", applyActionControls);
  aMinConf.addEventListener("blur", applyActionControls);

  const aNote = el("div", "motionnote", "门槛：VALID=1 · 置信度达标 · class1/2 边沿 · 间隔 ≥1 s；class0/3 永不执行");
  const aStatus = el("div", "motionnote", "映射来源 — · —");
  const aFoot = el("div", "actfoot");
  const aDocBtn = el("button", "btn", "API 文档");
  aDocBtn.title = "契约 §4 的三个只读接口说明（纯前端模态，不发请求）";
  aDocBtn.addEventListener("click", () => {
    if (onAction === undefined) {
      notify("API 文档未接线（旧调用方）", "warn");
      return;
    }
    onAction.onOpenApiDoc();
  });
  aFoot.append(el("span", "readonly", "localStorage actionMap"), aDocBtn);
  cA.card.append(aHeadRow, aMapBox, aMinRow, aNote, aStatus, aFoot);

  // ---- ④ 渲染图层栈 ----
  const c4 = cardHead("渲染图层栈", "自上而下 · 03 文档 §3");
  const layers = el("div", "layers");
  const rows = new Map<LayerKey, { row: HTMLElement; sw: HTMLElement }>();
  for (const m of LAYER_META as readonly LayerMeta[]) {
    const row = el("div", "layer");
    row.dataset["key"] = m.key;
    const z = el("span", "z", LAYER_NO[m.key]);
    const sw = el("span", "sw");
    sw.title = "点击开关该图层（立即生效）";
    const n = el("span", "n");
    n.append(m.label + " ");
    n.append(el("em", "", m.note));
    const b = el("span", "b", m.blend);
    row.append(z, sw, n, b);
    sw.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onToggleLayer(m.key);
    });
    row.addEventListener("click", () => {
      for (const other of rows.values()) other.row.classList.remove("sel");
      row.classList.add("sel");
    });
    rows.set(m.key, { row, sw });
    layers.append(row);
  }
  c4.card.append(layers);

  root.append(c1.card, cT.card, c2.card, c3.card, cM.card, c4.card);
  // 动作识别插在运动预测之后、渲染图层栈之前（契约 §5.1 钉死的位置）；
  // 用 insertBefore 而不是重排 append：既保住既有结构断言的原文，也让 cA 的归属一眼可见。
  root.insertBefore(cA.card, c4.card);

  startBtn.addEventListener("click", () => onRpc("transport.start"));
  stopBtn.addEventListener("click", () => onRpc("transport.stop"));
  grabBtn.addEventListener("click", () => onRpc("transport.uartGrab"));

  let histRev = -1;
  return {
    el: root,
    update(input: SidebarInput): void {
      const { stats, profile, source } = input;
      const synthSrc = source.kind === "synth";
      rowBoard.dd.textContent = synthSrc
        ? "页内合成源（无板卡）"
        : profile.udp.board + ":" + profile.udp.port + " ← " + profile.udp.bind;
      rowWire.dd.textContent = profile.wire + " · " + profile.name;
      rowDown.dd.textContent = "仅 '1' / '0'";
      rowDown.dd.style.color = "var(--warn)";
      rowLast.dd.textContent = (stats.latencyMs / 1000).toFixed(2) + " s 前";
      sFps.set(fmtFixed(stats.fps, 2), "fps", stats.fps > 0.5 ? "ok" : "warn");
      sCam.set(fmtFixed(stats.camFps, 1), "fps");
      sBw.set(fmtFixed(stats.bps / 1024 / 1024, 2), "MB/s");
      sPps.set(fmtInt(stats.pps), "pkt/s");
      const ev = fmtScale(stats.eventRate, 1);
      sEv.set(ev.v, ev.u + "ev/s", "on");
      sRed.set(fmtFixed(stats.reduction, 0), "×", stats.reduction > 30 ? "ok" : "");
      const onPct = Math.round(stats.onShare * 100);
      barOn.style.width = onPct + "%";
      barOff.style.width = 100 - onPct + "%";
      bOn.textContent = onPct + "%";
      bOffLbl.textContent = (100 - onPct) + "%";
      // EV_ONLY 下"每帧"不存在（没有 FRAME_RAW）：显示批次口径，绝不能让用户看到恒为 0 的每帧点数
      if (input.evOnly.active) {
        legMid.textContent = evOnlyLegend(stats.eventsPerBatch, input.evOnly.batches);
      } else {
        const perFrame = stats.eventsPerFrame;
        legMid.textContent = "每帧 " + fmtInt(perFrame) + " / 96 000（" + fmtFixed((perFrame / 96000) * 100, 1) + "%）";
      }
      // —— 传输方式卡片（UART 路线）——
      // 只在"传输状态版本变了"时回写（1 Hz STATS 不该反复动输入框/光标）
      const t = input.transport;
      mode1Blocked = modeDisabledReason(t, 1);
      transportBusyNow = input.transportBusy;
      if (input.transportRev !== transportRevNow || input.transportBusy !== transportBusyNowPrev) {
        transportBusyNowPrev = input.transportBusy;
        transportRevNow = input.transportRev;
        // A1：chip 只认实际主通道；"自动"不是通道，仅在无主通道且启动模式=auto 时保持高亮
        transportActiveNow = t?.active ?? t?.decision?.active ?? null;
        for (const [mode, chip] of tModeChips) {
          const sel = transportChipSelected(mode, transportActiveNow, t?.decision?.mode);
          chip.className = t === null ? "" : (sel ? "sel" : "");
          // 切换中把 chip 置灰（不是 disabled 属性：span 没有 disabled，视觉+点击守卫才可靠）
          chip.style.opacity = input.transportBusy ? "0.45" : "";
          chip.style.pointerEvents = input.transportBusy ? "none" : "";
        }
        tApply.disabled = input.transportBusy;
        if (t === null) {
          tBadge.textContent = "不可用";
          tBadge.className = "readonly";
          tDecision.textContent = "传输方式 —（当前不是实时源：回放/合成源没有物理通道）";
          tCapability.textContent = "—";
          tUartLine.textContent = "串口 —";
          tRxLine.textContent = "串口收发 —";
          tHealth.textContent = "通道健康 —";
          tHandshake.textContent = "—";
          tDeframer.textContent = "—";
          tCrcLine.textContent = "链路：—";
          tBaudApply.disabled = true;
          tBaudBox.className = "ctlbox ro";
          for (const chip of tBaudChips.values()) chip.className = "";
          tBaudBadge.textContent = "—";
          tBaudBadge.className = "readonly";
          tSpeed.textContent = "串口未启用";
          tBaudLine.textContent = "波特率：—（当前不是实时源）";
          tBaudLine.style.color = "";
          tRawWarn.style.display = "none";
        } else {
          const degraded = t.decision?.degraded === true;
          const failed = t.decision?.state === "failed";
          const unhealthy = t.health?.state === "degraded";
          if (input.transportBusy) {
            tBadge.textContent = "切换中…";
            tBadge.className = "readonly";
            tBadge.title = "正在重建通道（串口要开 COM + 3 次握手，最长 20 s）";
          } else {
            tBadge.textContent = failed ? "无通道" : degraded || unhealthy ? "降级" : "正常";
            tBadge.className = failed || degraded || unhealthy ? "readonly" : "readonly live";
            tBadge.title = t.decision?.reason ?? "";
          }
          tDecision.textContent = "当前：" + decisionText(t);
          tCapability.textContent = capabilityText(t);
          tUartLine.textContent = "串口：" + uartStatusText(t);
          tRxLine.textContent = uartRxText(t);
          tHealth.textContent = healthText(t);
          tHandshake.textContent = t.uart === null ? "v3 握手：—（无串口通道）" : "v3 握手：" + handshakeText(t);
          tDeframer.textContent = "定帧：" + deframerText(t);
          tCrcLine.textContent = linkHealthText(t);
          // B：4 档 chip + 应用；实际档位 / 板端 0x91 读回 / 偏好 / 扫描轨迹 / 上次切档结果。
          // 网口主通道下 baudRate 显式为 null（板端仍可能知道 0x91），所以不能拿 uart.baudRate 冒充实际档。
          const actualBaud = t.baudRate !== undefined ? t.baudRate : (t.uart?.baudRate ?? null);
          const prefBaud = t.preferredBaud ?? actualBaud ?? 115200;
          // B4：用户点完 chip 后不能被下一帧 STATS 拽回实际档（1 Hz 刷新会覆盖选择）；
          // 只有实际档变化或网口下首选档变化才跟随，busy 期间完全冻结。
          baudChoiceState = updateBaudChoice(baudChoiceState, actualBaud, prefBaud, input.transportBusy);
          paintBaudChips();
          tBaudApply.disabled = input.transportBusy;
          tBaudBox.className = input.transportBusy ? "ctlbox ro" : "ctlbox";
          for (const chip of tBaudChips.values()) {
            chip.style.pointerEvents = input.transportBusy ? "none" : "";
          }
          tBaudBadge.textContent = input.transportBusy
            ? "正在切换波特率…"
            : (actualBaud === null ? "未打开" : actualBaud + " baud");
          tBaudBadge.className = actualBaud === null && !input.transportBusy ? "readonly" : "readonly live";
          tBaudBadge.title = "主机串口实际打开 " + (actualBaud === null ? "未打开（网口主通道或串口关闭）" : actualBaud + " baud") +
            "；板端 0x91 读回 " + (t.boardBaud === null ? "未上报（旧位流）" : t.boardBaud + " baud") +
            "；首选档 " + prefBaud + " baud";
          tSpeed.textContent = actualBaud === null ? (t.uart === null ? "串口未启用" : "串口未打开") : actualBaud + " 8N1";
          if (input.transportBusy) {
            tBaudLine.textContent = "正在切换波特率…（板端确认 + 主机重开串口，最长 20 s）";
          } else if (t.baudScan?.running === true) {
            tBaudLine.textContent = "正在扫描波特率…（已试 " + String(t.baudScan.tried.length) + "/5）";
          } else {
            tBaudLine.textContent = baudStateText(t);
          }
          const boardBaud = t.boardBaud ?? null;
          const baudMismatch = actualBaud !== null &&
            ((boardBaud !== null && boardBaud !== actualBaud) || (t.preferredBaud !== undefined && t.preferredBaud !== actualBaud));
          tBaudLine.style.color = baudMismatch ? "var(--warn)" : "";
          if (baudMismatch) {
            tBaudLine.title = "⚠ 三者不一致：主机串口实际 " + actualBaud + " baud · 板端读回 " +
              (boardBaud === null ? "未上报" : boardBaud + " baud") + " · 首选档 " + prefBaud + " baud（契约 §1.1）";
          } else {
            tBaudLine.title = "B：实际档位 / 板端 0x91 读回 / 偏好档位 / open 扫描轨迹 / 上次切档结果。串口切档失败会回退旧档；网口主通道只切板端，不重开主机串口";
          }
          // A4：UDP 已切过去但 3 s 内没有 FRAME_RAW ⇒ 醒目提示 + 重试（不能只留黑屏）
          const rawWarn = rawRecoverText(t);
          if (rawWarn === null) {
            // P1-1：EV_ONLY/串口事件链路本来没有 RAW，rawRecoverText 已返回 null；重试也一并禁用，
            // 否则隐藏的按钮仍留着 tab 焦点/可点状态。
            tRawWarn.style.display = "none";
            tRawRetry.disabled = true;
          } else {
            tRawWarnText.textContent = "⚠ " + rawWarn;
            tRawWarnText.title = rawWarn + "（已收到原始帧 " + String(t.rawFrames ?? 0) + "）";
            tRawRetry.disabled = input.transportBusy;
            tRawWarn.style.display = input.transportBusy ? "none" : "flex";
          }
          // 串口遥测帧（帧型 A）优先用实时 CTRL 事件里的那一份；缺失时退化到状态视图里的快照
          const telem = input.uartTelem ?? t.uart?.telemetry ?? null;
          tTelem.textContent = "遥测直读：" + telemetryText(telem);
          tTelem.title = "串口遥测帧 AA 55 54 4D（16 B 大端载荷 + CRC8，250 ms 周期）：fr=帧计数 ev=每帧事件数 act=活跃度 cr=降低倍数 mode/key/en=板端状态";
          const port = t.uart?.path;
          if (typeof port === "string" && port !== "" && tPort.value !== port && document.activeElement !== tPort) {
            tPort.value = port;
          }
        }
      }
      if (input.historyRev !== histRev) {
        histRev = input.historyRev;
        const hist = input.history;
        spark.draw(hist);
        let peak = 0;
        let sum = 0;
        for (const v of hist) {
          if (v > peak) peak = v;
          sum += v;
        }
        const mean = hist.length > 0 ? sum / hist.length : 0;
        spPeak.textContent = "峰值 " + fmtFixed(peak / 1000, 1) + " k";
        spMean.textContent = "均值 " + fmtFixed(mean / 1000, 1) + " k";
      }
      for (const m of LAYER_META) {
        const r = rows.get(m.key);
        if (!r) continue;
        const on = input.layerOn[m.key] === true;
        r.sw.className = on ? "sw on" : "sw";
        r.row.className = on ? "layer" : "layer dim";
      }
      const rpc = input.canRpc;
      for (const b of [startBtn, stopBtn, grabBtn]) {
        b.disabled = !rpc;
        if (!rpc) b.title = "需要网关连接（当前为页内合成源）";
      }
      // —— v3 板端下行面板（WIRE-V3 §7.2 前端行）——
      const v3 = input.v3;
      boardDownlinkNow = onBoard !== undefined && v3 !== null && v3.downlinkAvailable;
      const boardOn = boardDownlinkNow;
      rowDown.dd.textContent = boardOn ? "v3 命令 → 1235 + '1'/'0'" : "仅 '1' / '0'";
      rowDown.dd.style.color = boardOn ? "var(--ok)" : "var(--warn)";
      // 模式徽标：R+E / R / E（0/1/2），当前值来自数据包 MODE 与 STATUS 双源
      for (const [v, chip] of boardModeChips) {
        const sel = v3 !== null && v3.mode === v;
        chip.className = sel ? "sel" : "";
      }
      boardModeBox.className = boardOn ? "ctlbox" : "ctlbox ro";
      boardModeBox.title = boardOn ? "点击下发 SET_MODE（帧边界生效；KEY3 物理键在 R+E ↔ E 两态循环，R 仅命令可下）" : NO_V3;
      boardModeBadge.textContent = boardOn ? "下行可用" : "不可用";
      boardModeBadge.className = boardOn ? "readonly live" : "readonly";
      boardModeBadge.title = boardOn ? "SET_MODE m：板端写 mode_reg，ACK 带 MODE 读回值（§6.3.2）" : NO_V3;
      // 事件支路开关（v3.1 EV_EN=0x05）：当前状态 = 最近一次 ACK OK 的下发值
      for (const [k, chip] of evEnChips) {
        chip.className = v3 !== null && v3.evEn !== null && (v3.evEn ? "1" : "0") === k ? "sel" : "";
      }
      evEnState.textContent = v3 === null || v3.evEn === null ? "—" : v3.evEn ? "使能中" : "已禁用";
      evEnBox.className = boardOn ? "ctlbox" : "ctlbox ro";
      evEnBox.title = boardOn ? "EV_EN（0x05）：开=事件支路使能（默认）/ 关=事件停止上行、原画不受影响" : NO_V3;
      evEnBadge.textContent = boardOn ? "下行可用" : "不可用";
      evEnBadge.className = boardOn ? "readonly live" : "readonly";
      evEnBadge.title = boardOn
        ? "状态以板端读回为准（TLV 0x8C，随 EV_EN ACK 与 GET_STATUS 刷新；v3.1 对齐）"
        : NO_V3;
      // —— UART 板端扩展状态（板端实现报告 §3.3；同 0x8C 口径：以板端读回为准，缺失显示"—"）——
      const evResNow = v3 === null ? null : v3.evRes;
      evResChip.textContent = "EV_RES " + evResText(evResNow);
      evResChip.title =
        "TLV 0x8D EV_RES_STATE（len1）：串口事件分辨率档 —— 0=全分辨率 / 1=÷2 / 2=÷4；" +
        "与 SER_AGG≠0 互斥（板端 BAD_VALUE 整条不写）";
      const serNow = v3 === null ? null : v3.serState;
      serChip.textContent = "SER " + serStateText(serNow);
      serChip.title =
        "TLV 0x8E SER_STATE（len3）：SER_DECIM 均匀抽点比（1..255）/ SER_AGG 聚合档 / " +
        "uartEvDrop 串口丢事件计数（8 bit，快变时单次读回可能瞬时不一致）";
      const netNow = v3 === null ? null : v3.netState;
      netChip.textContent = "NET " + netStateText(netNow);
      netChip.title =
        "TLV 0x8F NET_STATE（len1）：0=DOWN（网口不可用）/ 1=UP / 2=UNKNOWN（尚未首判）；" +
        "由板端 link_detect 产生，状态变化时会立即插发一条心跳形态 CTRL（不必等 1 Hz）";
      // 曝光上限读回（TLV 0x90，sccb 集成报告 §9.2）：行数 + hex（与 SCCB 寄存器口径对照，E0~E6 档位表同款写法）
      const expCapNow = v3 === null ? null : v3.expCap;
      expCapChip.textContent = "EXP_CAP " + expCapText(expCapNow);
      expCapChip.title =
        "TLV 0x90 EXP_CAP_STATE（len2 BE，单位=行）：板端读回真值（芯片内曝光上限），" +
        "随 SET_PARAM ACK（写后读回）与 GET_STATUS 刷新；心跳不含本 TLV ⇒ 旧固件/未上报显示 —。" +
        "值域 4..5904（" + BOARD_EXP_CAP_MIN + ".." + BOARD_EXP_CAP_MAX + "）；写入后约 1 ms 板端重跑整条 SCCB 曝光寄存器写序列（0x3a02/03/0x3a14/15）";
      uartBox.title = v3 === null
        ? NO_V3
        : "板端读回状态（旧固件/未上报显示 —）：EV_RES=TLV 0x8D，SER=TLV 0x8E，NET=TLV 0x8F，EXP_CAP=TLV 0x90";
      uartBadge.textContent = v3 === null ? "不可用" : "板端读回";
      uartBadge.className = v3 === null ? "readonly" : "readonly live";
      uartBadge.title = uartBox.title;
      // 板端 θ/δL：回显 ACK 读回值；正在编辑时不动
      if (boardParamRev !== input.v3Rev && document.activeElement !== boardTheta && document.activeElement !== boardMinDl) {
        boardParamRev = input.v3Rev;
        if (v3 !== null && v3.theta !== null) boardTheta.value = String(v3.theta);
        if (v3 !== null && v3.minDl !== null) boardMinDl.value = String(v3.minDl);
      }
      boardTheta.disabled = !boardOn;
      boardMinDl.disabled = !boardOn;
      sendParamBtn.disabled = !boardOn;
      // 曝光上限（sccb 集成 tag 0x0B）：与 θ/δL 同一"板端读回值回写输入框、正在输入不动"口径
      boardExpCap.disabled = !boardOn;
      sendExpCapBtn.disabled = !boardOn;
      if (expCapRev !== input.v3Rev && v3 !== null && v3.expCap !== null && document.activeElement !== boardExpCap) {
        // v3Rev 节流：值没变就不动输入框（避免 1 Hz STATS 打扰正在准备输入的人）
        expCapRev = input.v3Rev;
        boardExpCap.value = String(v3.expCap);
      }
      expCapBadge.textContent = boardOn ? "下行可用" : "不可用";
      expCapBadge.className = boardOn ? "readonly live" : "readonly";
      expCapBadge.title = boardOn
        ? "SET_PARAM tag 0x0B（u16 BE，4..5904 行）：写后约 1 ms 重跑整条曝光寄存器写序列；ACK 带 TLV 0x90 读回（sccb 集成报告 §9.1/§9.4）"
        : NO_V3;
      paramBadge.textContent = boardOn ? "下行可用" : "不可用";
      paramBadge.className = boardOn ? "readonly live" : "readonly";
      paramBadge.title = boardOn
        ? "SET_PARAM（原子写入，ACK 带写后读回值；§6.3.1）"
        : NO_V3;
      // 校准状态行：calibrated/stale + 对齐误差 + 距上次校准
      if (v3 === null) {
        calState.textContent = "—（需 v3）";
      } else if (v3.tsCalibrated === true) {
        const age = v3.calAgeMs === null ? "" : " · 距今 " + fmtFixed(v3.calAgeMs / 1000, 0) + " s";
        const err = v3.tsAlignErrMs === null ? "" : " · 误差 " + fmtFixed(v3.tsAlignErrMs, 2) + " ms";
        calState.textContent = (v3.tsStale ? "已校准（stale，保留旧 offset）" : "已校准") + age + err;
      } else {
        calState.textContent = "未校准（板端时基）" + (v3.calFailures > 0 ? " · 失败 " + v3.calFailures + " 次" : "");
      }
      calBtn.disabled = !boardOn;
      calBadge.textContent = boardOn ? "下行可用" : "不可用";
      calBadge.className = boardOn ? "readonly live" : "readonly";
      calBadge.title = boardOn
        ? "TIME_SYNC（F2：手动校准优先于 10 min 自动节流——点一次就发一帧，只挡 2 s 内连点；板端 REQ 由网关自动应答，§5.1/§5.2）"
        : NO_V3;
      // 抽帧比：显示 profile 的真实值；v3 可点 = 下发 FRAME_DECIM
      const decimNow = input.profile.frameDecim;
      for (const [v, chip] of decimChips) {
        chip.className = v === decimNow ? "sel" : "";
      }
      decimBox.className = boardOn ? "ctlbox" : "ctlbox ro";
      decimBox.title = boardOn
        ? "点击 = SET_PARAM FRAME_DECIM（1..255）"
        : RO.decim;
      decimBadge.textContent = boardOn ? "可下发" : "只读";
      decimBadge.className = boardOn ? "readonly live" : "readonly";
      decimBadge.title = decimBox.title;
      // θ / 守卫滑动条三态：上位机模拟档 = 改上位机算法；板端档且 v3 下行可用 = SET_PARAM 可调；
      // 都没有（回放/合成/无 v3 固件）= 只读。板端可调时拖动/提交都走 board.setParam（节流见 sliderlink.ts）。
      hostModeNow = input.hostMode;
      const sliderMode = sliderModeOf(input.hostMode, boardOn);
      const sliderInteractive = sliderMode !== "readonly";
      for (const s of [thetaSlider, guardSlider]) {
        s.root.className = sliderInteractive ? "sliderrow" : "sliderrow ro";
        s.input.disabled = !sliderInteractive;
        s.value.disabled = !sliderInteractive;
        s.badge.textContent = sliderBadgeText(sliderMode);
        s.badge.className = sliderInteractive ? "readonly live" : "readonly";
      }
      thetaSlider.badge.title =
        sliderMode === "host"
          ? "这是**上位机算法**的 θ（板端要同步需重编比特流）。先用它扫出合适的值，再写进 RTL/sys_ctrl"
          : sliderMode === "board"
            ? "板端可调(SET_PARAM tag 0x01)：拖动中节流 ≤5 次/s，松手 150 ms 内必发最终值；1 Hz GET_STATUS 读回会同步这里（拖动/输入中不回写）"
            : RO.theta;
      guardSlider.badge.title =
        sliderMode === "host"
          ? "这是**上位机算法**的守卫值（板端对应的端口是 sys_ctrl 的守卫档位）"
          : sliderMode === "board"
            ? "板端可调(SET_PARAM tag 0x02)：拖动中节流 ≤5 次/s，松手 150 ms 内必发最终值；读回值同步这里（拖动/输入中不回写）"
            : "只读：守卫值来自板端 sys_ctrl 的档位";
      // 「事件流」卡的右上角必须说清**这些事件是谁算的**：这张卡的每个数字都从事件流来，
      // 来源不同（板端/上位机/页内合成）时 θ 的含义完全不同，写死一个数就是误导。
      if (input.evOnly.active) {
        c2.right.textContent = "EV_ONLY 批次 " + fmtInt(input.evOnly.batches) + " · 板端只回传事件";
      } else if (input.hostMode) {
        c2.right.textContent = "上位机 θ = " + input.hostTheta;
      } else if (input.source.kind === "synth") {
        c2.right.textContent = "页内合成事件";
      } else if (input.profile.wire === "LEGACY") {
        c2.right.textContent = "legacy/v1 板端不发事件";
      } else {
        c2.right.textContent = "板端事件（θ 由板上 KEY1 决定）";
      }
      // SET_PARAM ACK 就地回显（成功=板端读回值；失败=status 错误码 + detail）
      if (input.boardParamAckRev !== boardAckRevNow) {
        boardAckRevNow = input.boardParamAckRev;
        const ack = input.boardParamAck;
        paramAckLine.textContent = boardParamAckText(ack);
        paramAckLine.style.color = ack === null ? "" : ack.ok ? "var(--ok)" : "var(--on)";
      }
      // 预设高亮：当前参数正好落在某个实测工作点上时把那个按钮标出来
      // （不标的话用户看不出"我现在这个值是谁调出来的、还有哪些现成的点"）
      const activePreset = matchPreset(input.hostTheta, input.hostMinDl);
      for (const [id, b] of presetBtns) {
        b.className = id === activePreset ? "sel" : "";
        b.disabled = !input.hostMode;
      }
      // 同步数值：**正在拖 / 正在输入 / 刚提交还没等到 ACK 的那一条不要回写**
      // （否则拖到一半、或 SET_PARAM 还在飞的时候，会被 1 Hz 读回拽回旧值）
      if (input.hostMode) {
        // 上位机档：数值来源就是 input.hostTheta / hostMinDl（滑块/数字框自己改的），保持旧行为
        if (document.activeElement !== thetaSlider.input && document.activeElement !== thetaSlider.value) {
          thetaSlider.input.value = String(input.hostTheta);
          thetaSlider.value.value = String(input.hostTheta);
        }
        if (document.activeElement !== guardSlider.input && document.activeElement !== guardSlider.value) {
          guardSlider.input.value = String(input.hostMinDl);
          guardSlider.value.value = String(input.hostMinDl);
        }
      } else if (boardOn && v3 !== null) {
        // 板端档：以 v3 GET_STATUS（1 Hz）读回为准；在本条滑条上拖动/编辑/刚提交时都不回写
        const thetaBusy = thetaDragging || Date.now() - thetaTouchedAt < 1500;
        if (
          v3.theta !== null &&
          shouldSyncSlider({
            revChanged: thetaSliderRev !== input.v3Rev,
            dragging: thetaBusy,
            editing: document.activeElement === thetaSlider.value,
          })
        ) {
          thetaSliderRev = input.v3Rev;
          const t = clampThetaSlider(v3.theta, THETA_MAX);
          thetaSlider.input.value = String(t);
          thetaSlider.value.value = String(t);
        }
        const guardBusy = guardDragging || Date.now() - guardTouchedAt < 1500;
        if (
          v3.minDl !== null &&
          shouldSyncSlider({
            revChanged: guardSliderRev !== input.v3Rev,
            dragging: guardBusy,
            editing: document.activeElement === guardSlider.value,
          })
        ) {
          guardSliderRev = input.v3Rev;
          const d = clampInt(v3.minDl, MINDL_MIN, MINDL_MAX);
          guardSlider.input.value = String(d);
          guardSlider.value.value = String(d);
        }
      }
      // ---- 运动预测卡片：只改文本/控件值，绝不重建 DOM（滑块拖动中重建会掉焦点） ----
      if (input.motion !== undefined) {
        const mv = input.motion;
        const touched = Date.now() - motionTouchedAt < 600;
        if (!touched) {
          motionEnabledNow = mv.enabled;
          mSw.classList.toggle("on", mv.enabled);
          const h = Math.round(Math.max(0.2, Math.min(1.5, mv.horizonS)) * 10) / 10;
          motionHorizonNow = h;
          if (document.activeElement !== mRange && document.activeElement !== mValue) {
            if (mRange.value !== String(h)) mRange.value = String(h);
            if (mValue.value !== h.toFixed(1)) mValue.value = h.toFixed(1);
          }
        }
        if (!mv.enabled) {
          // 关闭时不要把"上次的 TRACK 数"留在卡上：那会让人以为叠加还在跑
          mStatus.textContent = "已关闭 · 事件窗口 " + fmtInt(mv.eventCount);
          mStatus.classList.remove("warn");
        } else if (mv.trackCount > 0) {
          mStatus.textContent = "TRACK " + mv.trackCount + " · 事件窗口 " + fmtInt(mv.eventCount);
          mStatus.classList.remove("warn");
        } else {
          mStatus.textContent = "等待运动事件…";
          mStatus.classList.add("warn");
        }
      }
      // ---- 动作识别卡片：只改文本/控件值，不重建 DOM ----
      if (input.action !== undefined) {
        const av = input.action;
        const touched = Date.now() - actionTouchedAt < 600;
        if (!touched) {
          actionCfgNow = av.config;
          const entries = av.config.map;
          // 正在操作的那个控件不回写（与运动预测卡片同一口径：不许把用户的手拽回来）
          if (document.activeElement !== r0.selTarget) r0.selTarget.value = entries["0"].target;
          if (document.activeElement !== r1.selAction) r1.selAction.value = entries["1"].action;
          if (document.activeElement !== r1.selTarget) r1.selTarget.value = entries["1"].target;
          if (document.activeElement !== r2.selAction) r2.selAction.value = entries["2"].action;
          if (document.activeElement !== r2.selTarget) r2.selTarget.value = entries["2"].target;
          if (document.activeElement !== aMinConf) aMinConf.value = String(av.config.minConf);
        }
        const hex = av.byte23 === null ? "—" : "0x" + av.byte23.toString(16).padStart(2, "0").toUpperCase();
        cA.right.textContent = "byte23 " + hex;
        aResult.title = av.available ? "" : (av.reason ?? "");
        const display = actionResultState(actionSawValid, av);
        actionSawValid = display.sawValid;
        aResult.textContent = display.text;
        aResult.style.color =
          display.tone === "warn" ? "var(--warn)" : display.tone === "ok" ? "var(--ok)" : "";
        aCount.textContent = "检测次数 " + String(av.recognizedCount);
        const le = av.lastEvent;
        const when = le === null
          ? "最近事件 —"
          : "最近事件 #" + le.seq + " · " + le.className + " · " +
            new Date(le.tMs).toLocaleTimeString("zh-CN", { hour12: false });
        aStatus.textContent =
          "映射来源 " + av.source + " · " +
          (av.saved ? "已保存到浏览器" : "尚未保存（改动即写入）") + " · " + when;
        aStatus.classList.toggle("warn", av.source === "default");
      }
      void fmtBytes;
    },
  };
}

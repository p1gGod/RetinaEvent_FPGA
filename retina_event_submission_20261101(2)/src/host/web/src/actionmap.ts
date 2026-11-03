// 动作映射（M4 上位机动作回传）：浏览器端唯一事实来源 + 触发门槛。
//
// 为什么映射表放在浏览器、不放在网关：
//   1) 契约 §5.4 规定 localStorage 键 "actionMap" 存的是**用户意图**，刷新/重开页面必须还在；
//   2) 契约 §5.6 规定触发与动作只在页面内执行（多标签各自执行），网关只保存只读镜像（§4.3）；
//   3) 网关不落盘 —— 页面关掉后就不该再有任何东西替用户"按映射表动作"。
//
// 本模块刻意不碰全局 DOM/localStorage：storage 由调用方注入。
// 这样 node:test 能直接把 schema 校验、损坏回落、触发门槛这些
// "改一个字符就可能在现场误触发录制"的细节钉死。
import { ACT_CLASS_NAMES } from "@retina/protocol";
import type { ExporterId } from "./export/registry.ts";

/** 触发器可执行的操作（契约 §5.4）。 */
export type ActionOp = "none" | "startRecord" | "stopRecord" | "startAndAutoExport";

/** 操作的目标（仅 startAndAutoExport 实际使用；契约 §5.3）。 */
export type ActionTarget = "raw" | "events" | "overlay" | "statsOnly";

export interface ActionMapEntry {
  readonly action: ActionOp;
  readonly target: ActionTarget;
}

/** localStorage 键 "actionMap" 的 JSON 结构（契约 §5.4，版本 1）。 */
export interface ActionMapConfig {
  readonly v: 1;
  readonly updatedAtMs: number;
  readonly minConf: number;
  readonly map: Readonly<Record<"0" | "1" | "2", ActionMapEntry>>;
}

export type ActionClass = 0 | 1 | 2 | 3;

/**
 * 契约 §5.4 钉死的键名 —— **单点**。
 * 与网关 ipc/ws.ts 的 config.set 白名单、/api/action/config 的镜像必须是同一个字符串。
 * （hostparams.ts 的教训：界面键名与网关键名漂移一次，现场表现就是"参数永远没下发"。）
 */
export const ACTION_MAP_STORAGE_KEY = "actionMap";

export const ACTION_OPS: readonly ActionOp[] = ["none", "startRecord", "stopRecord", "startAndAutoExport"];
export const ACTION_TARGETS: readonly ActionTarget[] = ["raw", "events", "overlay", "statsOnly"];

/**
 * 类别名与固件/RTL 保持同一口径（当前权威语义）：
 * 0=无动作/静止；1=手部开合（任一方向合并）；2=横向挥手；3=保留（当无动作、不得执行映射）。
 * 直接复用协议包的 ACT_CLASS_NAMES，避免前端另写一份文案后与文档不一致。
 */
export function actionClassName(cls: number | null): string {
  if (cls === null || !Number.isInteger(cls) || cls < 0 || cls > 3) return "无数据";
  return ACT_CLASS_NAMES[cls as ActionClass] ?? "无数据";
}

/** 默认映射（与网关 DEFAULT_ACTION_CONFIG 逐字段一致；契约 §5.4）。 */
export function defaultActionMapConfig(nowMs = 0): ActionMapConfig {
  return {
    v: 1,
    updatedAtMs: nowMs,
    minConf: 8,
    map: {
      "0": { action: "none", target: "statsOnly" },
      "1": { action: "startRecord", target: "raw" },
      "2": { action: "stopRecord", target: "raw" },
    },
  };
}

/** localStorage 的最小抽象：node:test 里注入假实现，浏览器里传 window.localStorage。 */
export interface ActionMapStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ActionMapLoadResult {
  readonly config: ActionMapConfig;
  /** 非 null 时调用方必须给用户一句 toast（契约 §5.4：损坏/版本不符不许静默改数据）。 */
  readonly warning: string | null;
}

export const ACTION_MAP_CORRUPT_WARNING = "动作映射配置损坏，已恢复默认";

export function actionMapVersionWarning(v: unknown): string {
  // String(null) 会变成 "null"，恰好能说清"字段没了"和"字段是别的版本"两种情况
  return "动作映射版本不匹配（v=" + String(v) + "），已恢复默认";
}

function fail(message: string): never {
  throw new Error(message);
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** 严格校验（任何不合法都抛错，由 load 统一回落默认；不在这里"帮忙修正"）。 */
export function parseActionMapConfig(raw: unknown, nowMs = 0): ActionMapConfig {
  if (!isPlainObject(raw)) fail("actionMap 必须是对象");
  if (raw["v"] !== 1) fail(actionMapVersionWarning(raw["v"]));
  const minConf = raw["minConf"];
  if (typeof minConf !== "number" || !Number.isInteger(minConf) || minConf < 0 || minConf > 31) {
    fail("actionMap.minConf 必须是 0..31 的整数（收到 " + String(minConf) + "）");
  }
  const updatedAtMs = raw["updatedAtMs"];
  if (typeof updatedAtMs !== "number" || !Number.isFinite(updatedAtMs)) {
    fail("actionMap.updatedAtMs 必须是有限数字（收到 " + String(updatedAtMs) + "）");
  }
  const rawMap = raw["map"];
  if (!isPlainObject(rawMap)) fail("actionMap.map 必须是对象");

  const defaults = defaultActionMapConfig(nowMs);
  const entries: Record<string, ActionMapEntry> = {};
  for (const key of Object.keys(rawMap)) {
    if (key !== "0" && key !== "1" && key !== "2") {
      // class3 是保留类：契约明确"不接受 3"，宁可整体回落，也不留一条永远不会被执行的映射
      fail("actionMap.map 含不允许的类别键: " + key + "（只接受 0/1/2）");
    }
    const entry = rawMap[key];
    if (!isPlainObject(entry)) fail("actionMap.map." + key + " 必须是 {action,target}");
    const action = entry["action"];
    const target = entry["target"];
    if (typeof action !== "string" || !(ACTION_OPS as readonly string[]).includes(action)) {
      fail("actionMap.map." + key + ".action 非法: " + String(action) + "（允许 " + ACTION_OPS.join("/") + "）");
    }
    if (typeof target !== "string" || !(ACTION_TARGETS as readonly string[]).includes(target)) {
      fail("actionMap.map." + key + ".target 非法: " + String(target) + "（允许 " + ACTION_TARGETS.join("/") + "）");
    }
    if (key === "0" && action !== "none") {
      // class0 是"无动作"：给它配 startRecord 等于静止画面也在录制，现场没人能解释
      fail("actionMap.map.0.action 必须是 none（无动作类不允许执行操作）");
    }
    entries[key] = { action: action as ActionOp, target: target as ActionTarget };
  }

  // 缺键补默认（契约 §5.4）；显式给出了 0/1/2 的以用户值为准
  const map = {
    "0": entries["0"] ?? defaults.map["0"],
    "1": entries["1"] ?? defaults.map["1"],
    "2": entries["2"] ?? defaults.map["2"],
  } as const;
  return { v: 1, updatedAtMs, minConf, map };
}

/**
 * 从 localStorage 读取映射。
 *
 * 读取失败一律"整体回落默认 + 一句 warning"，绝不部分采用：
 * 半套配置（比如 minConf 用了用户的、map 用了默认）触发出来的动作，
 * 事后没人能复现用户当时到底配了什么。
 */
export function loadActionMap(storage: ActionMapStorage, nowMs = Date.now()): ActionMapLoadResult {
  let text: string | null;
  try {
    text = storage.getItem(ACTION_MAP_STORAGE_KEY);
  } catch {
    // 隐私模式/禁用存储：用默认值让页面继续可用，并告诉用户"这次改动不会保存"
    return { config: defaultActionMapConfig(nowMs), warning: "浏览器存储不可用，动作映射使用默认值（本次修改不会保存）" };
  }
  if (text === null) return { config: defaultActionMapConfig(nowMs), warning: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { config: defaultActionMapConfig(nowMs), warning: ACTION_MAP_CORRUPT_WARNING };
  }
  try {
    return { config: parseActionMapConfig(parsed, nowMs), warning: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 版本不符单独给一句更准确的提示（契约 §5.4 要求"重置默认并提示"）
    if (isPlainObject(parsed) && "v" in parsed && parsed["v"] !== 1) {
      return { config: defaultActionMapConfig(nowMs), warning: actionMapVersionWarning(parsed["v"]) };
    }
    return { config: defaultActionMapConfig(nowMs), warning: ACTION_MAP_CORRUPT_WARNING + "（" + msg + "）" };
  }
}

/** 保存：updatedAtMs 每次刷新为"这次保存的时刻"，其余字段原样（先校验再写）。 */
export function saveActionMap(storage: ActionMapStorage, config: ActionMapConfig, nowMs = Date.now()): ActionMapConfig {
  const next = parseActionMapConfig({ ...config, updatedAtMs: nowMs }, nowMs);
  storage.setItem(ACTION_MAP_STORAGE_KEY, JSON.stringify(next));
  return next;
}

/**
 * WS config.set 的参数：**只有 actionMap 一个键**。
 * 网关在 ipc/ws.ts 层消化它（存只读镜像），不进 control.setConfig。
 */
export function actionMapRpcParams(config: ActionMapConfig): { actionMap: ActionMapConfig } {
  return { actionMap: config };
}

export const ACTION_MIN_INTERVAL_MS = 1000;
/** 契约 §5.2 的"同 class 持续 10 s 只执行一次"：边沿判定天然满足，此常量只用于文案/测试说明。 */
export const ACTION_SAME_CLASS_HOLD_MS = 10000;

/** 触发器记住的"上一条已执行结果"（只由执行侧更新，观察侧不要碰）。 */
export interface ActionTriggerMemory {
  lastClass: ActionClass | null;
  lastExecAtMs: number;
}

export interface ActionEventLike {
  readonly valid: boolean;
  readonly conf: number;
  readonly class: number;
  readonly tMs?: number;
}

/**
 * 契约 §5.2 的触发门槛，三条必须同时满足：
 *   1) valid=1（byte23 bit7）；
 *   2) conf >= minConf；
 *   3) class ∈ {1,2} 且与**上一条已执行**的 class 不同（边沿）。
 * 另外两次执行至少间隔 ACTION_MIN_INTERVAL_MS，防止板端抖动导致连发。
 *
 * class0（无动作）与 class3（保留）永远不触发 —— 契约 §2.1 明确 class3 不得执行任何映射。
 */
export function shouldTrigger(
  event: ActionEventLike,
  config: ActionMapConfig,
  memory: ActionTriggerMemory,
  nowMs = Date.now(),
): boolean {
  if (!event.valid) return false;
  if (event.class !== 1 && event.class !== 2) return false;
  if (!(event.conf >= config.minConf)) return false;
  if (memory.lastClass === event.class) return false;
  if (memory.lastExecAtMs !== 0 && nowMs - memory.lastExecAtMs < ACTION_MIN_INTERVAL_MS) return false;
  return true;
}

/** 执行成功后调用：把"上一条已执行结果"推进到本次事件。 */
export function noteTriggered(memory: ActionTriggerMemory, event: ActionEventLike, nowMs = Date.now()): void {
  // 无效事件/不可执行类别（0、3）不得覆盖"上一条已执行结果"，否则边沿判定会被无效帧冲掉
  if (!event.valid) return;
  if (event.class !== 1 && event.class !== 2) return;
  memory.lastClass = event.class;
  memory.lastExecAtMs = nowMs;
}

/** target → 既有导出器；statsOnly 没有对应导出器（走独立的轻量统计导出）。 */
export const ACTION_TARGET_EXPORTER: Readonly<Record<ActionTarget, ExporterId | null>> = {
  raw: "rawbin",
  events: "csv",
  overlay: "pngzip",
  statsOnly: null,
};

/** 侧栏动作卡片需要的只读视图（main.ts 每次刷新填充）。 */
export interface ActionLastEventView {
  readonly seq: number;
  readonly className: string;
  readonly tMs: number;
}

export interface ActionMappedView {
  readonly action: ActionOp;
  readonly target: ActionTarget;
}

export interface ActionView {
  /** 当前数据源是否带动作字节（v3 实时帧才有） */
  readonly available: boolean;
  /** available=false 时给用户的原因（契约 §4.1） */
  readonly reason: string | null;
  /** /api/action 的原始 byte23；没数据时 null */
  readonly byte23: number | null;
  readonly className: string;
  readonly class: ActionClass | null;
  readonly conf: number | null;
  readonly valid: boolean;
  readonly mapped: ActionMappedView | null;
  /** 最近事件序号（事件环里最新一条）；没有事件时 0 */
  readonly lastSeq: number;
  readonly lastEvent: ActionLastEventView | null;
  /** 本页打开以来收到且 VALID=1 的 class1/2 事件条数（本地累计，不经网关，不受触发门槛影响） */
  readonly recognizedCount: number;
  /** 映射镜像来源：ui=网关收到过浏览器的 config.set；default=浏览器还没推过 */
  readonly source: "ui" | "default";
  /** 本地是否真的写进过 localStorage（首次打开、从没改过时为 false） */
  readonly saved: boolean;
  readonly config: ActionMapConfig;
}

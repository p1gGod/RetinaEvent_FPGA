// 网关的 HTTP 数据接口（/api/*）—— 给"别的进程/agent 来拉画面与统计"用。
//
// 为什么必须有它（2026-10-06 用户提出）：上位机要**长时间挂着**当监控面板，
// 那它就不能为了给别人看一眼画面而让出 UDP 1234（那是唯一的板子数据入口，
// 一让出就得重烧/重连）。所以画面必须以"被拉取"的方式暴露出去，而不是让每个消费者都去抢那个 socket。
//
// 设计约束：
//   · 只读。没有 POST，没有写操作 —— 谁都不能通过这个接口改变采集状态（避免"另一个 agent 把采集弄停了"）。
//   · 零依赖。PNG 自己编码（见 util/png.ts），不引原生模块（SEA 单 exe 纪律）。
//   · 单槽语义。拿到的永远是"最新一帧"，不是队列里的旧帧；要"等新帧"就用长轮询 /api/frames/next。
import type { IncomingMessage, ServerResponse } from "node:http";
import { decodeRgb565 } from "@retina/protocol";
import type { Counters, Profile, SourceStats } from "@retina/protocol";
import type { LatestStore } from "../pipeline/latest.ts";
// actionStore 是模块级单例：processor 解析到 byte23 后写它，三个 /api/action* 读它。
// 真实网关不经过 ApiContext 注入（main.ts 不在本轮白名单），显式 fallback 保证"同一份状态"；
// ApiContext.action 仍保留，供单测用独立 ActionStore 隔离全局单例。
import { actionStore, type ActionStore } from "../action.ts";
import { downscaleRgba, encodePngRgba } from "../util/png.ts";

export interface ApiContext {
  readonly store: LatestStore;
  readonly profile: Profile;
  readonly getStats: () => SourceStats;
  readonly getCounters: () => Counters;
  readonly getConfig: () => Record<string, unknown>;
  readonly startedAtMs: number;
  readonly sourceInfo: unknown;
  readonly uiUrl: string | null;
  /**
   * 动作识别快照/事件环（契约 05 §4）。
   * 可选：老测试只构造画面相关 ctx，不该因为新增接口就必须补字段；
   * 缺省时 /api/action* 按"从未收到 v3 帧"处理（503 / default 配置）。
   */
  readonly action?: ActionStore | undefined;
}

/** 接口清单：别的 agent 直接 GET /api 就能知道有什么可拉（比读文档快） */
export const ENDPOINTS = {
  "/api": "本清单",
  "/api/health": "存活 + 采集状态 + profile（{ok, uptimeMs, ...}）",
  "/api/stats": "统计与计数器（{profile, source, stats, counters, config}）",
  "/api/frame.json": "最新一帧的元数据（不含像素）",
  "/api/frame.raw": "最新一帧的原始字节（RGB565，800*480*2 = 768000 B）",
  "/api/frame.png?w=400": "最新一帧渲染成 PNG（w 可选，盒式降采样；默认全分辨率）",
  "/api/events.json": "最新事件位图的元数据（不含像素）",
  "/api/events.png?w=200": "最新事件位图渲染成 PNG（ON 红 / OFF 蓝）",
  "/api/frames/next?after=<seq>&timeoutMs=5000": "长轮询：等 seq 更新的一帧，返回其 PNG",
  // 动作回传（契约 05 §4）：三个只读接口，语义与错误码以契约为准
  "/api/action": "最近一次动作识别结果（byte23 解码；available=false 表示当前源没有动作字节）",
  "/api/action/events?after=<seq>&timeoutMs=5000": "长轮询：等 seq 更新的动作事件（类别变化才记一条，环 64）",
  "/api/action/config": "动作→操作映射（浏览器 localStorage 键 actionMap 的只读镜像）",
} as const;

function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj, null, 1), "utf8");
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function sendPng(res: ServerResponse, png: Buffer): void {
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": String(png.length),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(png);
}

function sendText(res: ServerResponse, code: number, text: string): void {
  const body = Buffer.from(text, "utf8");
  res.writeHead(code, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** RGB565 原始帧 → RGBA（复用协议包里的唯一一份解码实现，避免两套像素约定） */
function frameToRgba(raw: Uint8Array, w: number, h: number, pixel: "RGB565_BE" | "RGB565_LE"): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  decodeRgb565(raw, rgba, pixel === "RGB565_LE" ? "LE" : "BE");
  return rgba;
}

/**
 * 处理 /api/*。返回 true 表示已处理（http.ts 据此决定是否继续走静态文件逻辑）。
 * 非 /api 开头的路径一律返回 false，本函数不碰它们。
 */
export function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ApiContext): boolean {
  const p = url.pathname;
  if (p !== "/api" && !p.startsWith("/api/")) return false;

  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    sendText(res, 405, "本接口只读：仅支持 GET/HEAD");
    return true;
  }

  const nowMs = Date.now();
  const base = {
    ok: true,
    uptimeMs: nowMs - ctx.startedAtMs,
    uiUrl: ctx.uiUrl,
  };

  if (p === "/api" || p === "/api/") {
    sendJson(res, 200, { ...base, endpoints: ENDPOINTS });
    return true;
  }

  if (p === "/api/health") {
    const f = ctx.store.getFrame();
    const e = ctx.store.getEvents();
    sendJson(res, 200, {
      ...base,
      profile: ctx.profile.name,
      wire: ctx.profile.wire,
      geometry: { w: ctx.profile.frame.w, h: ctx.profile.frame.h },
      source: ctx.sourceInfo,
      framesSeen: ctx.store.totalFrames,
      latestFrame: f === null ? null : { seq: f.seq, frameIdx: f.frameIdx, ageMs: nowMs - f.arrivedAtMs, synthetic: f.synthetic },
      latestEvents: e === null ? null : { frameIdx: e.frameIdx, count: e.count, origin: e.origin, ageMs: nowMs - e.arrivedAtMs },
    });
    return true;
  }

  if (p === "/api/stats") {
    sendJson(res, 200, {
      ...base,
      profile: { name: ctx.profile.name, wire: ctx.profile.wire, rawChunk: ctx.profile.rawChunk, chunksPerFrame: ctx.profile.chunksPerFrame, evRecBytes: ctx.profile.evRecBytes, frameDecim: ctx.profile.frameDecim },
      source: ctx.sourceInfo,
      stats: ctx.getStats(),
      counters: ctx.getCounters(),
      config: ctx.getConfig(),
    });
    return true;
  }

  if (p === "/api/frame.json") {
    const f = ctx.store.getFrame();
    if (f === null) {
      sendJson(res, 503, { ...base, ok: false, error: "还没有收到任何完整帧（检查板子/网口/UDP 端口）" });
      return true;
    }
    sendJson(res, 200, {
      ...base,
      seq: f.seq,
      frameIdx: f.frameIdx,
      w: f.w,
      h: f.h,
      pixel: f.pixel,
      bytes: f.raw.length,
      tArriveMs: f.tArriveMs,
      // F4（2026-10-13）：板端时间轴（WIRE-V3 §4.3）。缺省 = 本帧无可信板端时间，
      // 消费者按"整体回退到达时刻"处理（web/src/export/times.ts 同一条规则）。
      ...(f.tBoardMs === undefined ? {} : { tBoardMs: f.tBoardMs }),
      synthetic: f.synthetic,
      ageMs: nowMs - f.arrivedAtMs,
      arrivedAtMs: f.arrivedAtMs,
    });
    return true;
  }

  if (p === "/api/frame.raw") {
    const f = ctx.store.getFrame();
    if (f === null) {
      sendText(res, 503, "还没有收到任何完整帧");
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(f.raw.length),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "X-Frame-Seq": String(f.seq),
      "X-Frame-Idx": String(f.frameIdx),
      "X-Frame-W": String(f.w),
      "X-Frame-H": String(f.h),
      "X-Frame-Pixel": f.pixel,
    });
    res.end(Buffer.from(f.raw));
    return true;
  }

  if (p === "/api/frame.png") {
    const f = ctx.store.getFrame();
    if (f === null) {
      sendText(res, 503, "还没有收到任何完整帧");
      return true;
    }
    const rgba = frameToRgba(f.raw, f.w, f.h, f.pixel);
    const wantW = intParam(url, "w", f.w, 16, 4096);
    const scaled = downscaleRgba(rgba, f.w, f.h, wantW);
    res.setHeader("X-Frame-Seq", String(f.seq));
    sendPng(res, encodePngRgba(scaled.rgba, scaled.w, scaled.h));
    return true;
  }

  if (p === "/api/events.json") {
    const e = ctx.store.getEvents();
    if (e === null) {
      sendJson(res, 503, { ...base, ok: false, error: "还没有事件图（板端未发事件，或上位机算法未开启）" });
      return true;
    }
    sendJson(res, 200, { ...base, frameIdx: e.frameIdx, w: e.w, h: e.h, count: e.count, origin: e.origin, ageMs: nowMs - e.arrivedAtMs });
    return true;
  }

  if (p === "/api/events.png") {
    const e = ctx.store.getEvents();
    if (e === null) {
      sendText(res, 503, "还没有事件图");
      return true;
    }
    const wantW = intParam(url, "w", e.w, 16, 4096);
    const scaled = downscaleRgba(e.rgba, e.w, e.h, wantW);
    res.setHeader("X-Events-Origin", e.origin);
    sendPng(res, encodePngRgba(scaled.rgba, scaled.w, scaled.h));
    return true;
  }

  if (p === "/api/frames/next") {
    const after = intParam(url, "after", -1, -2147483648, 2147483647);
    const timeoutMs = intParam(url, "timeoutMs", 5000, 0, 60000);
    const wantW = intParam(url, "w", 0, 0, 4096);
    void ctx.store
      .waitFrame(after, timeoutMs)
      .then((f) => {
        if (f === null) {
          sendJson(res, 200, { ...base, ok: false, timeout: true, error: "在 " + timeoutMs + " ms 内没有新帧" });
          return;
        }
        if (url.searchParams.get("format") === "json") {
          sendJson(res, 200, {
            ...base, seq: f.seq, frameIdx: f.frameIdx, w: f.w, h: f.h, pixel: f.pixel,
            bytes: f.raw.length, tArriveMs: f.tArriveMs,
            // F4：长轮询 JSON 与 /api/frame.json 同口径（同一 store 快照，禁止两套字段）
            ...(f.tBoardMs === undefined ? {} : { tBoardMs: f.tBoardMs }),
            synthetic: f.synthetic,
          });
          return;
        }
        const rgba = frameToRgba(f.raw, f.w, f.h, f.pixel);
        const scaled = downscaleRgba(rgba, f.w, f.h, wantW > 0 ? wantW : f.w);
        res.setHeader("X-Frame-Seq", String(f.seq));
        sendPng(res, encodePngRgba(scaled.rgba, scaled.w, scaled.h));
      })
      .catch((err: unknown) => {
        sendText(res, 500, "等待帧失败: " + (err instanceof Error ? err.message : String(err)));
      });
    return true;
  }

  // ————————————————————————— 动作回传（契约 05_动作回传与上位机契约 §4） —————————————————————————
  // 三个接口都只读；语义/错误码逐条来自契约 §4.1~§4.3，实现里不另造字段口径。
  // 状态来源：真实网关走模块级单例（processor 写、API 读）；测试可注入 ctx.action 隔离。
  const action = ctx.action ?? actionStore;
  if (p === "/api/action") {
    const f = ctx.store.getFrame();
    if (f === null) {
      // 2026-10-31（task-6）：串口 EV_ONLY 链路（act8_uart 位流）只有事件帧与 CTRL ACK、永远没有
      // "完整帧"，而动作快照来自 GET_STATUS ACK 尾部的权威 TLV 0x92 —— 有快照就必须给 200，
      // 否则纯串口模式下面板永远拿不到手势结果。只有"既无帧又无快照"才走下面的 503。
      const snapNoFrame = action.getSnapshot();
      if (snapNoFrame !== null) {
        sendJson(res, 200, {
          ...base,
          available: true,
          frameIdx: snapNoFrame.frameIdx,
          tArriveMs: snapNoFrame.tArriveMs,
          ageMs: nowMs - snapNoFrame.tArriveMs,
          raw: snapNoFrame.raw,
          valid: snapNoFrame.valid,
          class: snapNoFrame.class,
          className: snapNoFrame.className,
          conf: snapNoFrame.conf,
          mapped: snapNoFrame.mapped,
          // 与"有帧"链路同一套兼容镜像字段口径（契约消费者忽略即可）：
          seq: action.getLastEventSeq(),
          tMs: snapNoFrame.tArriveMs,
          source: action.getConfigView().source,
          count: action.getCount(),
          // 本分支特有：说清"无完整帧、快照来自串口 TLV 0x92"（有帧链路不带该字段，保持契约原样）
          reason: "串口事件-only 链路：无完整帧，动作快照来自 GET_STATUS TLV 0x92",
        });
        return true;
      }
      // 与 /api/frame.json 同一文案：消费者只需要一个"没有帧"的信号（契约 §4.1 尾段）
      sendJson(res, 503, { ...base, ok: false, available: false, error: "还没有收到任何完整帧（检查板子/网口/UDP 端口）" });
      return true;
    }
    const snap = action.getSnapshot();
    if (snap === null) {
      // 有帧但不是 v3（v2/合成/回放没有动作字节）：200 + available:false + reason（契约 §4.1）
      sendJson(res, 200, {
        ...base,
        available: false,
        reason: "当前数据源不是 v3 实时帧（v2/回放/合成），没有动作字节",
        frameIdx: f.frameIdx,
        tArriveMs: f.tArriveMs,
        ageMs: nowMs - f.arrivedAtMs,
        raw: null,
        valid: false,
        class: null,
        className: "无数据",
        conf: null,
        mapped: null,
        // 任务书 API_OK 列出的兼容镜像字段（契约 §4.1 未列；多给不改变语义）：
        // seq=最近事件序号（0=还没有事件）、tMs=动作快照时间（不可判定时 null）、source=映射来源。
        seq: 0,
        tMs: null,
        source: action.getConfigView().source,
        // task-24：检测次数只增不改；还没有任何 v3 动作字节时可判定的检测数就是 0。
        count: 0,
      });
      return true;
    }
    sendJson(res, 200, {
      ...base,
      available: true,
      frameIdx: snap.frameIdx,
      tArriveMs: snap.tArriveMs,
      ageMs: nowMs - snap.tArriveMs,
      raw: snap.raw,
      valid: snap.valid,
      class: snap.class,
      className: snap.className,
      conf: snap.conf,
      mapped: snap.mapped,
      // 任务书 API_OK 的兼容镜像字段：契约消费者忽略即可，字段值都有明确定义（见上）。
      seq: action.getLastEventSeq(),
      tMs: snap.tArriveMs,
      source: action.getConfigView().source,
      // task-24：累计检测次数（VALID 0->1 或类别变化），与事件 seq 解耦、跨长轮询游标不丢。
      count: action.getCount(),
    });
    return true;
  }

  if (p === "/api/action/events") {
    const after = intParam(url, "after", -1, -2147483648, 2147483647);
    const timeoutMs = intParam(url, "timeoutMs", 5000, 0, 60000);
    const act = action;
    // "从未收到 v3 实时帧" ⇒ 503（与 /api/action 同文案）；等不到事件一律 200 + timeout:true
    if (!act.hasSnapshot) {
      sendJson(res, 503, { ...base, ok: false, available: false, error: "还没有收到任何完整帧（检查板子/网口/UDP 端口）" });
      return true;
    }
    void act
      .waitEvents(after, timeoutMs)
      .then((page) => {
        if (page.timedOut) {
          sendJson(res, 200, {
            ...base,
            ok: false,
            timeout: true,
            lastSeq: page.lastSeq,
            events: [],
            dropped: 0,
            error: "在 " + timeoutMs + " ms 内没有新的动作事件",
          });
          return;
        }
        sendJson(res, 200, { ...base, lastSeq: page.lastSeq, events: page.events, dropped: page.dropped });
      })
      .catch((err: unknown) => {
        // 内部异常 500 纯文本（契约 §4.4 错误码表）
        sendText(res, 500, "等待动作事件失败: " + (err instanceof Error ? err.message : String(err)));
      });
    return true;
  }

  if (p === "/api/action/config") {
    const view = action.getConfigView();
    sendJson(res, 200, {
      ...base,
      source: view.source,
      updatedAtMs: view.updatedAtMs,
      // 字段并集：契约 §4.3 的嵌套 config（v/minConf/map）与任务书的扁平 map/minConf 同时满足，
      // 多给字段不改变语义；消费者按契约嵌套读，联动机器按扁平读都行。
      minConf: view.config.minConf,
      map: view.config.map,
      config: view.config,
    });
    return true;
  }

  sendJson(res, 404, { ...base, ok: false, error: "未知接口: " + p, endpoints: ENDPOINTS });
  return true;
}

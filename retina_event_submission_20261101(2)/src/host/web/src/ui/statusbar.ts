// 状态栏：profile / bind / 收包 / 包率 ‖ 全部计数器 ‖ 资源 ‖ 版本。
// 为什么全部计数器都要常驻（原则 P6"不静默"）：任何一个丢弃计数非 0 都必须能被一眼看到，
// 但长名字挤不下 —— 所以用固定缩写 + title 给全名，并且在紧凑档把最冷门的几个标 .opt。
import { COUNTER_KEYS } from "@retina/protocol";
import type { Counters, Profile } from "@retina/protocol";
import { fmtBytes, fmtFixed, fmtInt } from "../format.ts";
import { el } from "./dom.ts";

export interface StatusInput {
  readonly stats: import("../types.ts").ViewStats;
  readonly profile: Profile;
  readonly source: import("../types.ts").SourceStatus;
  readonly renderMs: number;
  /** F2：网关在线客户端数（含旧标签页残留） */
  readonly clients?: number;
  /** F2：其中“慢连接”（bufferedAmount 超阈值，只丢它自己的 FRAME_RAW）数 */
  readonly slowClients?: number;
  /** S7：链路降级原因（传输健康 / S8 自动回退结果）；null = 无异常 */
  readonly link?: { readonly state: "active" | "degraded"; readonly reason: string } | null;
}

/** 计数器缩写：只求"能对上号"，全名放 title（hover 可见），避免状态栏被挤出视口 */
const SHORT: Record<string, string> = {
  badMagic: "badMagic", badLength: "badLength", oversize: "ovsz", truncated: "trunc",
  crcFail: "crc", idxGap: "gap", aborted: "abrt", dupChunk: "dup", evPartial: "evPart",
  evDrop: "evDrop", evOrphan: "evOrph", uiDrop: "uiDrop", segInconsistent: "segInc", segNotice: "segNtc",
  pluginTimeout: "plugT", pluginError: "plugE",
  // WIRE-V3 §7.2 增补的 10 个：解析/装配/校准/下行四组
  badVersion: "ver", badHdrLen: "hdr", modeNotice: "modeN", tsEpochReset: "tsEp",
  tsCalFail: "calF", idxWrap: "wrap", dlCrcFail: "dlCrc", dlBadOpcode: "dlOp",
  dlReject: "dlRej", modeConflict: "modeCf",
};
/** 紧凑档隐藏的冷门计数器（值是 0 时无信息量；非 0 时会通过 title 汇总暴露） */
const OPT_KEYS = new Set(["pluginTimeout", "pluginError", "segNotice", "segInconsistent", "crcFail",
  // v3 的下行/校准计数平时全 0（板端没坏就不会有人盯它），非 0 时经 g3.title 汇总暴露
  "badVersion", "badHdrLen", "modeNotice", "tsCalFail", "idxWrap", "dlCrcFail", "dlBadOpcode", "dlReject", "modeConflict"]);

function memOf(): string {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m ? fmtBytes(m.usedJSHeapSize) : "—";
}

export function mountStatusBar(root: HTMLElement, version: string): { update(v: StatusInput): void } {
  const g1 = el("span", "grp");
  const bProfile = el("b", "", "profile");
  const vProfile = el("span", "", "-");
  const bBind = el("b", "", "bind");
  const vBind = el("span", "", "-");
  g1.append(bProfile, vProfile, bBind, vBind);

  const g2 = el("span", "grp");
  const bPk = el("b", "", "收包");
  const vPk = el("span", "", "0");
  const bPps = el("b", "", "包率");
  const vPps = el("span", "", "0 pkt/s");
  g2.append(bPk, vPk, bPps, vPps);

  // S7/S8：链路降级原因必须常驻可见（不能只让用户看黑屏或控制台）
  const gLink = el("span", "grp");
  const bLink = el("b", "", "链路");
  const vLink = el("span", "", "—");
  gLink.append(bLink, vLink);
  gLink.title = "串口链路有效性 / 自动回退状态；降级时原样显示网关给出的原因";

  const g3 = el("span", "grp counters");
  const counterEls = new Map<string, HTMLElement>();
  for (const k of COUNTER_KEYS) {
    const s = el("span", "", SHORT[k] + " 0");
    s.title = k + "（计数器；非 0 即为异常或丢弃，见 02 文档计数器表）";
    if (OPT_KEYS.has(k)) s.classList.add("opt");
    counterEls.set(k, s);
    g3.append(s);
  }

  // F2：多客户端时把“有几个连接 / 几个在拖后腿”摆在状态栏，别再让旧标签页悄悄拖死整条链路
  const gConn = el("span", "grp opt");
  const bConn = el("b", "", "连接");
  const vConn = el("span", "", "—");
  gConn.append(bConn, vConn);
  gConn.title = "网关在线 WebSocket 客户端数 / 其中慢连接数；慢连接只丢它自己的 FRAME_RAW，不影响其他页面";

  const g4 = el("span", "grp opt");
  const bMem = el("b", "", "内存");
  const vMem = el("span", "", "—");
  const bRen = el("b", "", "渲染");
  const vRen = el("span", "", "—");
  g4.append(bMem, vMem, bRen, vRen);

  root.append(g1, g2, gLink, gConn, g3, el("div", "spacer"), g4);
  // 版本号不占状态栏横向空间（计数器要常驻），改为 hover 可见 + 顶栏品牌区显示
  root.title = version + " · 计数器口径见 02 文档计数器表 + WIRE-V3 §7.2；录制与 5 种导出（PNG 序列 / MP4 / 原始帧 / 事件流 / 检测结果）已实现，见底栏";

  return {
    update(input: StatusInput): void {
      const { stats, profile, source } = input;
      vProfile.textContent = profile.name;
      vBind.textContent = source.kind === "synth" ? "页内合成源" : profile.udp.bind + ":" + profile.udp.port;
      vPk.textContent = fmtInt(stats.packets);
      vPps.textContent = fmtInt(stats.pps) + " pkt/s";
      const c = stats.counters as Counters;
      const lines: string[] = [];
      for (const k of COUNTER_KEYS) {
        const n = c[k] ?? 0;
        const e = counterEls.get(k);
        if (e) {
          e.textContent = (SHORT[k] ?? k) + " " + fmtInt(n);
          e.className = n === 0 ? "ok" : k === "uiDrop" || k === "idxGap" ? "warn" : "bad";
          if (OPT_KEYS.has(k)) e.classList.add("opt");
        }
        lines.push(k + "=" + n);
      }
      g3.title = "全部计数器：" + lines.join(" ");
      const clients = input.clients;
      if (clients === undefined || clients <= 0) {
        vConn.textContent = "—";
        vConn.className = "";
      } else {
        const slow = input.slowClients ?? 0;
        vConn.textContent = slow > 0 ? clients + " · 慢 " + slow + "（已单独降帧）" : String(clients);
        vConn.className = slow > 0 ? "warn" : "ok";
        if (slow > 0) {
          vConn.title = "检测到 " + slow + " 个旧连接/慢连接，已单独降帧：它们只丢自己的 FRAME_RAW，其他页面不受影响";
        }
      }
      const link = input.link ?? null;
      if (link === null || link.state !== "degraded") {
        vLink.textContent = link === null ? "正常" : "链路正常";
        vLink.className = link === null ? "" : "ok";
        vLink.title = "当前通道健康";
      } else {
        vLink.textContent = "⚠ " + link.reason;
        vLink.className = "bad";
        vLink.title = link.reason;
      }
      vMem.textContent = memOf();
      vRen.textContent = fmtFixed(input.renderMs, 1) + " ms";
    },
  };
}

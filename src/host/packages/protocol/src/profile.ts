// profile：加载 + 校验（02 文档 §9）。校验失败必须拒绝启动并打印原因。
import type { Profile } from "./types.ts";

export interface ProfileCheck {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/** 校验规则（每条都对应一次真实踩坑或协议缺口） */
export function validateProfile(p: Profile): ProfileCheck {
  const e: string[] = [];
  if (p.wire !== "STREAM" && p.wire !== "LEGACY" && p.wire !== "TELEM") e.push("wire 取值非法: " + String(p.wire));
  if (!/^[0-9a-fA-F]{2,16}$/.test(p.magic)) e.push("magic 必须是偶数长度十六进制串");
  if (p.frame.w <= 0 || p.frame.h <= 0) e.push("frame.w/h 必须为正");
  const expectBytes = p.frame.w * p.frame.h * 2;
  if (p.wire !== "TELEM" && p.frame.bytes !== expectBytes) {
    e.push("frame.bytes=" + p.frame.bytes + " 与 w*h*2=" + expectBytes + " 不一致");
  }
  // 分片参数只对 UDP 通路有意义（UART 是字节流，没有"每包多少字节"的概念）
  if (p.wire !== "TELEM") {
    if (p.rawChunk <= 0) e.push("rawChunk 必须为正");
    else if (p.frame.bytes % p.rawChunk !== 0) {
      // 事实：RAW_CHUNK 必须整除整帧字节数，否则末包零头会让整帧错位（02 文档 §2.3）
      e.push("rawChunk=" + p.rawChunk + " 不能整除 frame.bytes=" + p.frame.bytes);
    } else if (p.chunksPerFrame !== p.frame.bytes / p.rawChunk) {
      e.push("chunksPerFrame=" + p.chunksPerFrame + " 应为 " + p.frame.bytes / p.rawChunk);
    }
  }
  if (p.evRecBytes < 3 || p.evRecBytes > 8) e.push("evRecBytes 应在 3~8（当前 " + p.evRecBytes + "）");
  if (p.crc16 !== "none" && p.crc16 !== "present" && p.crc16 !== "auto") e.push("crc16 取值非法");
  if (p.frameDecim < 1) e.push("frameDecim 必须 >= 1");
  if (!/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(p.udp.bind)) e.push("udp.bind 不是点分十进制地址（板侧 PC_IP 写死，必须匹配）");
  return { ok: e.length === 0, errors: e };
}

/** 启动失败时的提示：必须一眼看出"改哪个参数" */
export function formatProfileError(p: Profile, check: ProfileCheck): string {
  const lines: string[] = [];
  lines.push("[FATAL] profile " + p.name + " 校验失败：");
  for (const s of check.errors) lines.push("        - " + s);
  lines.push("        请核对 udp_merge / 例程 60 的实际参数，或改用其它 profile");
  return lines.join(String.fromCharCode(10));
}

const base = {
  magic: "F05AA50F",
  crc16: "auto",
  udp: { bind: "192.168.1.102", port: 1234, board: "192.168.1.10", boardPort: 1234 },
} as const;

/** 内置 profile（02 文档 §9 的表）。v2 的变体对应缺口 G2 的两种取值 */
export const BUILTIN_PROFILES: Readonly<Record<string, Profile>> = {
  "legacy-800x480-1280": {
    ...base, name: "legacy-800x480-1280", wire: "LEGACY",
    frame: { w: 800, h: 480, bytes: 768000, pixel: "RGB565_BE" },
    rawChunk: 1280, chunksPerFrame: 600, evRecBytes: 5,
    evGrid: { w: 400, h: 240 }, frameDecim: 8,
  },
  // ★ RTL 实际参数（`retina_event/src/hdl/comms/udp_merge.v` 的默认值）：
  //   RAW_CHUNK=1280、CHUNKS_PER_FRAME=600、EV_REC_BYTES=5、CRC_EN=1（尾部必带 CRC16）。
  //   2026-10-06 用 `tb_udp_merge` dump 出的 605 个真实包逐包核对后定稿：
  //   包长 25/1295/1325/1330/1350（最大 1350 ≤ 1472），CRC 605/605 = CCITT-FALSE。
  //   ⚠️ 与下面 e5/e3 的 1024/750 不同：**接真板子必须用本 profile**，否则
  //     帧永远凑不齐（等 750 块只来 600 块）且按 1024 步长拼 1280 字节负载会整帧错位。
  "retina-v2-800x480-1280": {
    ...base, name: "retina-v2-800x480-1280", wire: "STREAM", crc16: "present",
    frame: { w: 800, h: 480, bytes: 768000, pixel: "RGB565_BE" },
    rawChunk: 1280, chunksPerFrame: 600, evRecBytes: 5,
    evGrid: { w: 400, h: 240 },
    // ★ 2026-10-07（H62 选项 (a)）：板端 `event_sink.FRAME_DECIM` 已由 8 改为 **1**
    //   —— 为了让"上位机模拟处理"与板端引擎**同一时间基**（否则同一组 (θ,守卫) 在两边
    //   不是同一件事）。实测回传帧率 **26.58 fps**（= 相机帧率）、16 001 pps / 20.66 MB/s。
    //   ⚠️ 这个字段不是纯装饰：`web/src/main.ts` 用 `相机帧率 = 回传帧率 × frameDecim`
    //   反推（H31），填 8 会让界面显示 **26.4×8 = 211 fps**。改板端 FRAME_DECIM 时必须同改这里。
    frameDecim: 1,
  },
  "retina-v2-800x480-e5": {
    ...base, name: "retina-v2-800x480-e5", wire: "STREAM",
    frame: { w: 800, h: 480, bytes: 768000, pixel: "RGB565_BE" },
    rawChunk: 1024, chunksPerFrame: 750, evRecBytes: 5,
    evGrid: { w: 400, h: 240 }, frameDecim: 8,
  },
  "retina-v2-800x480-e3": {
    ...base, name: "retina-v2-800x480-e3", wire: "STREAM",
    frame: { w: 800, h: 480, bytes: 768000, pixel: "RGB565_BE" },
    rawChunk: 1024, chunksPerFrame: 750, evRecBytes: 3,
    evGrid: { w: 400, h: 240 }, frameDecim: 8,
  },
  "telem-400x240": {
    ...base, name: "telem-400x240", wire: "TELEM",
    frame: { w: 400, h: 240, bytes: 96000, pixel: "RGB565_BE" },
    rawChunk: 0, chunksPerFrame: 0, evRecBytes: 5,
    evGrid: { w: 400, h: 240 }, frameDecim: 1,
  },
};

export function getProfile(name: string): Profile | null {
  const p = BUILTIN_PROFILES[name];
  return p === undefined ? null : p;
}

// 串口（UART 路线）**流式定帧**：把连续字节流切成 ①遥测帧 ②v3 帧 ③下行回显。
//
// 依据 WIRE-U1（UART回传协议设计）§3.1 的分派规则，两侧同一条规则：
//   首 2 字节 AA 55        → 遥测帧（固定 21 B = 4 魔数 + 16 载荷 + CRC8）
//   首 4 字节 F0 5A A5 30  → v3 帧（24 B 包头自描述长度：HDR_LEN + RAW_LEN + EV_LEN / CTRL_LEN）
//   首 4 字节 F0 5A A5 31  → 本机下行帧（板端回显/环路），按下行长度规则跳过
//   其余字节               → 零散字节（含 'B' 与遥测 ASCII 行），按字节丢弃并计数
//
// 为什么必须单独一层：UDP 有数据报边界，串口是**连续字节流** —— 这是设计 §7.2 D1 点名的
// "唯一不可避免的协议面改动，且只加在定界，不动帧内容"。定帧错一个字节，后面全是垃圾；
// 所以这里把三条硬规则 + CRC 校验 + 重同步全部落在一处，并有独立单测（含逐字节滴灌）。
import {
  CTRL,
  DOWNLINK,
  FLAGS3,
  LIMITS3,
  MAGIC_V3,
  MAGIC_V3_DOWN,
  OFF3,
  TELEM,
  WIRE_V3,
  crc16,
  parseUartTelemFrame,
} from "@retina/protocol";
import type { UartTelemFrame } from "@retina/protocol";

export interface SerialDeframerStats {
  /** 收到的总字节数 */
  bytes: number;
  /** 完整通过校验的 v3 帧数（含 CTRL） */
  v3Frames: number;
  /** 完整通过校验的遥测帧数 */
  telemFrames: number;
  /** 遥测帧 CRC8 失败次数（失败即按字节重同步） */
  telemCrcFail: number;
  /** v3 帧 CRC16 失败次数 */
  v3CrcFail: number;
  /** 长度不自洽 / 超上限（按字节重同步） */
  badLen: number;
  /** 重同步次数（= 定帧候选被证伪的次数，CRC 或长度） */
  resyncs: number;
  /** 被丢弃的零散字节数（ASCII 行、'B'、噪声都算） */
  bytesDropped: number;
  /** 流里出现的本机下行帧（F0 5A A5 31）个数 */
  downlinkEcho: number;
  /** 成功解析出的人读 ASCII 行（`T fr=…`）条数 */
  textLines: number;
}

export interface SerialDeframerHooks {
  /** 一个完整的 v3 帧（含 CRC，已切片拷贝，调用方可长期持有） */
  readonly onV3Frame?: ((frame: Uint8Array, tArriveMs: number) => void) | undefined;
  /** 一个完整的串口遥测帧（帧型 A：人读统计通道） */
  readonly onTelem?: ((telem: UartTelemFrame, raw: Uint8Array, tArriveMs: number) => void) | undefined;
  /** 人读 ASCII 行（RTL 的 `T fr=…` 行；只放行该格式，避免把噪声当文本上屏） */
  readonly onText?: ((line: string) => void) | undefined;
  /** 定帧异常（调用方据此 bump 计数器：crcFail / badLength —— 原则 P6 不静默） */
  readonly onBadFrame?: ((reason: "crcFail" | "badLength", detail: string) => void) | undefined;
}

/** ASCII 行只认板端格式（uart_link.v：`T fr=` 开头，`\r\n` 结尾），上限防噪声撑爆 */
const TEXT_PREFIX = "T fr=";
const TEXT_MAX = 160;

export class SerialDeframer {
  readonly stats: SerialDeframerStats = {
    bytes: 0,
    v3Frames: 0,
    telemFrames: 0,
    telemCrcFail: 0,
    v3CrcFail: 0,
    badLen: 0,
    resyncs: 0,
    bytesDropped: 0,
    downlinkEcho: 0,
    textLines: 0,
  };

  private buf: Uint8Array;
  private start = 0;
  private end = 0;
  private readonly text: number[] = [];
  private readonly hooks: SerialDeframerHooks;

  constructor(hooks: SerialDeframerHooks = {}, capacity = 4096) {
    this.hooks = hooks;
    this.buf = new Uint8Array(Math.max(64, capacity));
  }

  /** 缓冲区里尚未定界的字节数（联调用：长期不归零说明帧头对不上/波特率错了） */
  get pending(): number {
    return this.end - this.start;
  }

  /** 喂一段字节（串口 data 事件的原始分片；分片边界与帧边界无关，逐字节滴灌也必须正确） */
  push(chunk: Uint8Array, tArriveMs = Date.now()): void {
    if (chunk.length === 0) return;
    this.append(chunk);
    this.scan(tArriveMs);
    // 全部消费掉就复位游标，避免缓冲区无限前移
    if (this.start === this.end) this.start = this.end = 0;
  }

  /** 流结束：剩余字节按噪声结算（调用方在 stop() 里调一次） */
  flush(): void {
    const leftover = this.end - this.start;
    if (leftover > 0) {
      this.stats.bytesDropped += leftover;
      this.start = this.end = 0;
    }
    this.text.length = 0;
  }

  // ————————————————————————— 内部 —————————————————————————

  private append(chunk: Uint8Array): void {
    if (this.buf.length - this.end < chunk.length) {
      // 先压缩（把未消费的头部字节挪到 0），再按需扩容
      if (this.start > 0) {
        this.buf.copyWithin(0, this.start, this.end);
        this.end -= this.start;
        this.start = 0;
      }
      if (this.buf.length - this.end < chunk.length) {
        let cap = this.buf.length * 2;
        while (cap < this.end + chunk.length) cap *= 2;
        const next = new Uint8Array(cap);
        next.set(this.buf.subarray(0, this.end), 0);
        this.buf = next;
      }
    }
    this.buf.set(chunk, this.end);
    this.end += chunk.length;
    this.stats.bytes += chunk.length;
  }

  private scan(tArriveMs: number): void {
    while (this.start < this.end) {
      const b0 = this.buf[this.start] as number;
      if (b0 === (MAGIC_V3[0] as number)) {
        // v3 族（上行 0x30 / 下行回显 0x31）。F0 是唯一需要看第 4 字节的族。
        if (!this.scanV3(tArriveMs)) return; // 需要更多字节：等下一次 push
        continue;
      }
      if (b0 === (TELEM.MAGIC[0] as number)) {
        if (!this.scanTelem(tArriveMs)) return;
        continue;
      }
      this.skipGarbage(1);
    }
  }

  /** @returns false = 字节不够（保持游标，等后续 push）；true = 已推进游标 */
  private scanV3(tArriveMs: number): boolean {
    const avail = this.end - this.start;
    if (avail < 4) return false; // 至少要能看到第 4 字节
    const p = this.buf;
    if ((p[this.start + 1] as number) !== (MAGIC_V3[1] as number) || (p[this.start + 2] as number) !== (MAGIC_V3[2] as number)) {
      this.skipGarbage(1);
      return true;
    }
    const b3 = p[this.start + 3] as number;
    if (b3 === (MAGIC_V3_DOWN[3] as number)) {
      if (!this.skipDownlinkEcho()) return false;
      return true;
    }
    if (b3 !== (MAGIC_V3[3] as number)) {
      this.skipGarbage(3); // F0 5A A5 已排除，不可能再有帧头从这里开始
      return true;
    }
    // 到这里确定是 v3 上行魔数：需要 24 B 才能读自描述长度
    if (avail < OFF3.HEADER) return false;
    const ver = p[this.start + OFF3.VER] as number;
    if (ver !== WIRE_V3) {
      this.resync("v3", "badLength", "VER=0x" + ver.toString(16) + " ≠ 0x03");
      return true;
    }
    const hdrLen = p[this.start + OFF3.HDR_LEN] as number;
    if (hdrLen < OFF3.HEADER) {
      this.resync("v3", "badLength", "HDR_LEN=" + hdrLen + " < 24");
      return true;
    }
    if (hdrLen > LIMITS3.MAX_PAYLOAD) {
      // 噪声带上来的荒谬头长：立刻判坏重同步，不为了"等够字节"把重同步拖到几百字节之后
      this.resync("v3", "badLength", "HDR_LEN=" + hdrLen + " > " + LIMITS3.MAX_PAYLOAD);
      return true;
    }
    const dv = new DataView(p.buffer, p.byteOffset + this.start, avail);
    const flags = dv.getUint8(OFF3.FLAGS);
    const isCtrl = (flags & FLAGS3.CTRL) !== 0;
    const crcPresent = (flags & FLAGS3.CRC_PRESENT) !== 0;
    const rawLen = dv.getUint16(OFF3.RAW_LEN);
    const evLen = dv.getUint16(OFF3.EV_LEN);
    let total: number;
    if (isCtrl) {
      if (avail < hdrLen + CTRL.HEADER) return false; // 控制头才带 CTRL_LEN
      total = hdrLen + CTRL.HEADER + dv.getUint16(hdrLen + 4) + (crcPresent ? 2 : 0);
    } else {
      if (rawLen > LIMITS3.RAW_LEN || evLen > LIMITS3.EV_LEN) {
        this.resync("v3", "badLength", "RAW_LEN=" + rawLen + " / EV_LEN=" + evLen + " 超上限");
        return true;
      }
      total = hdrLen + rawLen + evLen + (crcPresent ? 2 : 0);
    }
    // 串口侧一帧不可能超过 UDP 的 MTU 上限（设计 §3.5：满包 1471 B）；超了就是长度字段被噪声带跑
    if (total > LIMITS3.MAX_PAYLOAD) {
      this.resync("v3", "badLength", "帧长 " + total + " > " + LIMITS3.MAX_PAYLOAD);
      return true;
    }
    if (avail < total) return false; // 等整帧到齐
    const frame = p.subarray(this.start, this.start + total);
    if (crcPresent) {
      const want = ((frame[total - 2] as number) << 8) | (frame[total - 1] as number);
      const got = crc16(frame.subarray(0, total - 2));
      if (want !== got) {
        this.resync("v3", "crcFail", "CRC16 期望 0x" + want.toString(16) + " 实得 0x" + got.toString(16));
        return true;
      }
    }
    this.stats.v3Frames++;
    // 必须拷贝：解析层/装配器会持有负载视图，而本缓冲区会被后续 push 复用
    this.hooks.onV3Frame?.(frame.slice(), tArriveMs);
    this.start += total;
    return true;
  }

  /** @returns false = 字节不够；true = 已推进（跳过或消费） */
  private scanTelem(tArriveMs: number): boolean {
    const avail = this.end - this.start;
    if (avail < 2) return false;
    const p = this.buf;
    if ((p[this.start + 1] as number) !== (TELEM.MAGIC[1] as number)) {
      this.skipGarbage(1);
      return true;
    }
    if (avail < 4) return false;
    if ((p[this.start + 2] as number) !== (TELEM.MAGIC[2] as number) || (p[this.start + 3] as number) !== (TELEM.MAGIC[3] as number)) {
      this.skipGarbage(2); // AA 55 已排除；从第 3 字节起不可能再有 AA
      return true;
    }
    if (avail < TELEM.TOTAL) return false;
    const raw = p.subarray(this.start, this.start + TELEM.TOTAL);
    const r = parseUartTelemFrame(raw);
    if (r.ok) {
      this.stats.telemFrames++;
      this.hooks.onTelem?.(r.value, raw.slice(), tArriveMs);
      this.start += TELEM.TOTAL;
      return true;
    }
    this.resync("telem", "crcFail", "遥测 " + r.detail);
    return true;
  }

  /** 下行帧回显（F0 5A A5 31 + LEN@8）——板端环路时会出现；按行长度规则整帧跳过 */
  private skipDownlinkEcho(): boolean {
    const avail = this.end - this.start;
    if (avail < DOWNLINK.HEADER) return false;
    const p = this.buf;
    const dv = new DataView(p.buffer, p.byteOffset + this.start, avail);
    const len = dv.getUint16(8);
    if (len > LIMITS3.MAX_PAYLOAD) {
      this.resync("v3", "badLength", "下行回显长度 " + len + " 超上限");
      return true;
    }
    const total = DOWNLINK.HEADER + len + 2;
    if (avail < total) return false;
    this.stats.downlinkEcho++;
    this.start += total;
    return true;
  }

  private resync(family: "v3" | "telem", reason: "crcFail" | "badLength", detail: string): void {
    this.stats.resyncs++;
    if (reason === "crcFail") {
      if (family === "telem") this.stats.telemCrcFail++;
      else this.stats.v3CrcFail++;
    } else {
      this.stats.badLen++;
    }
    this.hooks.onBadFrame?.(reason, detail);
    // 按字节重同步：丢掉当前字节，下一个字节重新判帧头（设计 §8.2 H2）
    this.skipGarbage(1);
  }

  private skipGarbage(n: number): void {
    for (let k = 0; k < n && this.start < this.end; k++) {
      const b = this.buf[this.start] as number;
      this.start++;
      this.stats.bytesDropped++;
      if (b === 0x0a) this.emitText();
      else if (b === 0x0d) { /* CR：行内忽略 */ }
      else if (b >= 0x20 && b < 0x7f) {
        if (this.text.length < TEXT_MAX) this.text.push(b);
      } else this.text.length = 0; // 不可打印字节打断当前行
    }
  }

  private emitText(): void {
    if (this.text.length > 0) {
      const line = String.fromCharCode(...this.text);
      if (line.startsWith(TEXT_PREFIX)) {
        this.stats.textLines++;
        this.hooks.onText?.(line);
      }
    }
    this.text.length = 0;
  }
}

// 串口测试用的假件（不叫 *.test.ts，不会被 `npm test` 直接收集为用例）。
//
// 为什么要有假口而不是拿真 COM6 跑：① CI/无板机器上没有口；② 要能构造"打开失败""握手 3 次全超时"
// "板端回 ACK""板端发 TIME_SYNC_REQ""USB 被拔"这些分支 —— 真口只能等现场。
// 判据：假口只实现 serialport 的结构契约（SerialPortLike），协议字节仍走真实现。
import { CTRL, DOWNLINK, crc16 } from "@retina/protocol";
import type { Profile } from "@retina/protocol";
import type { SerialPortLike, SerialOpenOptions, SerialPortFactory } from "../src/transport/serial.ts";
import { SerialOpenError } from "../src/transport/serial.ts";
import { v3Tlv, concatU8, buildV3 } from "../../packages/protocol/test/helpers.ts";

export class FakeSerialPort implements SerialPortLike {
  isOpen = true;
  /** 收到的下行帧（含 GET_STATUS / SET_PARAM / TIME_SYNC / 单字节 B 命令） */
  readonly written: Uint8Array[] = [];
  /** 板端模拟：收到下行帧时回调（测试用它回 ACK / 发 TIME_SYNC_REQ） */
  responder: ((frame: Uint8Array) => void) | null = null;
  /** 写回调错误注入（测"写入失败"分支） */
  writeError: Error | null = null;
  closed = false;

  private readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();

  on(event: string, cb: (...args: unknown[]) => void): unknown {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }

  write(data: Uint8Array, cb: (err: Error | null) => void): unknown {
    const copy = data.slice();
    this.written.push(copy);
    cb(this.writeError);
    if (this.writeError === null) this.responder?.(copy);
    return true;
  }

  close(cb?: (err: Error | null) => void): unknown {
    this.isOpen = false;
    this.closed = true;
    cb?.(null);
    return undefined;
  }

  // —— 测试助手 ——
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }

  /** 板端发字节（串口 → PC） */
  feed(bytes: Uint8Array): void {
    this.emit("data", Buffer.from(bytes));
  }

  /** 模拟 USB 拔出 */
  unplug(): void {
    this.isOpen = false;
    this.emit("close", new Error("port closed"));
  }

  get downlinks(): Uint8Array[] {
    return this.written.filter((f) => f[3] === 0x31);
  }

  /** 独立解一条下行帧（不复用被测编码器的读侧）：magic/ver/opcode/seq/len/crc 全查一遍 */
  static parseDownlink(frame: Uint8Array): { opcode: number; seq: number; payload: Uint8Array; crcOk: boolean } | null {
    if (frame.length < 12 || frame[0] !== 0xf0 || frame[1] !== 0x5a || frame[2] !== 0xa5 || frame[3] !== 0x31) return null;
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const opcode = frame[5] as number;
    const seq = dv.getUint16(6);
    const len = dv.getUint16(8);
    const payload = frame.subarray(10, 10 + len);
    const want = dv.getUint16(10 + len);
    const crcOk = crc16(frame.subarray(0, 10 + len)) === want;
    return { opcode, seq, payload, crcOk };
  }
}

/** 打开必失败的工厂（等价真机上"COM6 不存在/被占用"） */
export function failingFactory(pathHint = "COM6", available: readonly string[] = ["COM1", "COM4"]): SerialPortFactory {
  return {
    async open(opts: SerialOpenOptions): Promise<SerialPortLike> {
      throw new SerialOpenError(opts.path === "" ? pathHint : opts.path, "File not found (系统找不到指定的文件。)", available);
    },
    async list() {
      return available;
    },
  };
}

/** 打开必成功的工厂（返回同一只假口） */
export function portFactory(port: FakeSerialPort): SerialPortFactory {
  return {
    async open(): Promise<SerialPortLike> {
      return port;
    },
    async list() {
      return ["COM6"];
    },
  };
}

/**
 * 板端 v3 CTRL 应答（板端实现报告 §3.3 的字节布局）：
 * GET_STATUS ACK = OPCODE 0x04 / STATUS 0 / CTRL_LEN 61（TLV 区尾部含 0x8D/0x8E/0x8F）。
 */
export function ctrlAck(profile: Profile, opcode: number, seq: number, ctrlLen?: number): Uint8Array {
  const tlvs = concatU8(
    v3Tlv(CTRL.TLV.MODE, Uint8Array.of(0)),
    v3Tlv(CTRL.TLV.EV_RES_STATE, Uint8Array.of(0)),
    v3Tlv(CTRL.TLV.SER_STATE, Uint8Array.of(32, 0, 0)),
    v3Tlv(CTRL.TLV.NET_STATE, Uint8Array.of(2)),
  );
  return buildV3({
    ctrl: true,
    ctrlOpcode: opcode,
    ctrlStatus: DOWNLINK.STATUS.OK,
    ctrlSeq: seq,
    ctrlPayload: tlvs,
    ...(ctrlLen === undefined ? {} : { ctrlLen }),
  });
}

/** 板端主动发起的校准请求（0x83 REQ：裸 6 B BOARD_TS_US 载荷） */
export function timeSyncReq(seq: number, boardTsUs: number): Uint8Array {
  const payload = new Uint8Array(6);
  payload[0] = Math.floor(boardTsUs / 2 ** 40) & 0xff;
  payload[1] = Math.floor(boardTsUs / 2 ** 32) & 0xff;
  new DataView(payload.buffer).setUint32(2, boardTsUs % 2 ** 32);
  return buildV3({ ctrl: true, ctrlOpcode: CTRL.OPCODE.TIME_SYNC_REQ, ctrlStatus: 0, ctrlSeq: seq, ctrlPayload: payload, ctrlLen: 6 });
}

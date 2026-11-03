// CLI 参数测试（UART 路线新增开关）：--serial / --transport / --recv-buf / --udp-probe。
// 为什么单列一条：这些开关决定"用哪条通道"，解析错一个值就是"连不上板子还看不出来"。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/main.ts";
import type { CliOptions } from "../src/main.ts";
import { DEFAULT_SERIAL_PATH, SerialOpenError } from "../src/transport/serial.ts";
import { UdpTransport } from "../src/transport/udp.ts";

function ok(argv: string[]): CliOptions {
  const r = parseArgs(argv);
  assert.equal(r.ok, true, "参数应解析成功: " + argv.join(" ") + " ⇒ " + JSON.stringify(r));
  return (r as { ok: true; options: CliOptions }).options;
}

test("--serial：裸用 = 串口源 + 缺省 COM6；带值则用给定串口号", () => {
  const bare = ok(["--serial"]);
  assert.equal(bare.kind, "uart");
  assert.equal(bare.serialPath, undefined, "解析层不硬编码串口号（运行时用 DEFAULT_SERIAL_PATH）");
  assert.equal(DEFAULT_SERIAL_PATH, "COM6", "缺省串口号 = 用户现场口径 COM6");
  const withPath = ok(["--serial", "COM12"]);
  assert.equal(withPath.kind, "uart");
  assert.equal(withPath.serialPath, "COM12");
});

test("--transport：udp / uart / auto 三值；非法值必须明确报错", () => {
  assert.equal(ok(["--transport", "udp"]).transport, "udp");
  assert.equal(ok(["--transport", "auto"]).transport, "auto");
  const u = ok(["--transport", "uart"]);
  assert.equal(u.transport, "uart");
  assert.equal(u.kind, "uart", "uart 模式同时钉住初始候选源");
  const bad = parseArgs(["--transport", "serial"]);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /只能是 udp \/ uart \/ auto/);
  const missing = parseArgs(["--transport"]);
  assert.equal(missing.ok, false);
});

test("--recv-buf / --udp-probe：数值校验；缺省时字段为 undefined（用实现内默认值）", () => {
  const o = ok(["--udp", "--recv-buf", "16", "--udp-probe", "1200"]);
  assert.equal(o.recvBufMb, 16);
  assert.equal(o.udpProbeMs, 1200);
  const def = ok(["--udp"]);
  assert.equal(def.recvBufMb, undefined);
  assert.equal(def.udpProbeMs, undefined);
  assert.equal(parseArgs(["--recv-buf", "0"]).ok, false);
  assert.equal(parseArgs(["--recv-buf", "abc"]).ok, false);
  assert.equal(parseArgs(["--udp-probe", "-5"]).ok, false);
});

test("--serial-baud：115200 缺省不动，460800/921600 可达（设计 §3.6 阶段④），越界必须报错", () => {
  assert.equal(ok(["--serial"]).serialBaud, undefined, "缺省用实现内的 115200");
  assert.equal(ok(["--serial", "COM6", "--serial-baud", "921600"]).serialBaud, 921600);
  assert.equal(ok(["--serial-baud", "460800"]).serialBaud, 460800);
  assert.equal(parseArgs(["--serial-baud", "0"]).ok, false);
  assert.equal(parseArgs(["--serial-baud", "3000000"]).ok, false, "超过 CH340 手册上限 2 Mbps 必须拦下");
});

test("缺省接收缓冲已提到 16 MB（P0 报告 §5.4 的装配掉帧复盘），且可显式调回", () => {
  assert.equal(UdpTransport.DEFAULT_RECV_BUFFER, 16 * 1024 * 1024);
});

test("SerialOpenError：消息必须带齐四项可执行信息（口 / 原因 / 可用口 / 排查指引）", () => {
  const e = new SerialOpenError("COM6", "File not found", ["COM1", "COM7"]);
  assert.match(e.message, /串口 COM6 打开失败：File not found/);
  assert.match(e.message, /当前可用串口：COM1, COM7/);
  assert.match(e.message, /CH341SER/);
  assert.match(e.message, /串口助手/);
  assert.equal(e.path, "COM6");
  assert.equal(e.cause, "File not found");
  assert.deepEqual(e.available, ["COM1", "COM7"]);
});

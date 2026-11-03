// 传输方式选择状态机测试（UART 路线 WIRE-U1 §1.3 / §5.3）。
//
// 判据：三种模式（UDP / UART / auto）下的全部组合都有确定结论，且
//   ① 显式选择的失败必须**明确报错**（绝不偷偷换通道）；
//   ② auto 的降级必须**如实说明能力少了什么**（仅串口 ⇒ MODE1 只原画不可用）；
//   ③ auto 里"网口在 + 串口也在"是**两个通道**（主 + 第二观察），不是失败；
//   ④ 运行期降级只在 auto 且备选已探过可用时发生。
import { test } from "node:test";
import assert from "node:assert/strict";
import { TransportSelector, UART_ONLY_NOTE } from "../src/transport/select.ts";

test("显式 UDP：探测通过 ⇒ active=udp（三模式全可选，无降级）", () => {
  const s = new TransportSelector("udp");
  assert.equal(s.next(), "udp");
  assert.equal(s.next(), null, "显式模式只探一条通道");
  const d = s.record("udp", { ok: true, detail: "绑定 192.168.1.102:1234，1 ms 内收到 1 包" });
  assert.equal(d.state, "active");
  assert.equal(d.active, "udp");
  assert.equal(d.degraded, false);
  assert.equal(d.secondary, null);
  assert.match(d.reason, /MODE0\/MODE1\/MODE2/);
  assert.equal(s.settled, true);
});

test("显式 UDP 失败：结论 failed 且原因就是探针给的（不虚构）", () => {
  const s = new TransportSelector("udp");
  s.next();
  const d = s.record("udp", { ok: false, detail: "绑定成功但 1500 ms 内未收到任何包（端口被旧进程独占）" });
  assert.equal(d.state, "failed");
  assert.equal(d.active, null);
  assert.match(d.reason, /没有可用数据通道/);
  assert.match(d.reason, /端口被旧进程独占/);
  assert.equal(d.failures.udp, "绑定成功但 1500 ms 内未收到任何包（端口被旧进程独占）");
});

test("显式 UART：打开成功 ⇒ active=uart 且 degraded（仅事件回传，MODE1 不可用）", () => {
  const s = new TransportSelector("uart");
  assert.equal(s.next(), "uart");
  const d = s.record("uart", { ok: true, detail: "串口 COM6 @115200 8N1 已打开；固件在线" });
  assert.equal(d.active, "uart");
  assert.equal(d.degraded, true, "串口档必须显式标注能力缺失");
  assert.equal(d.reason, "网口不可用 → " + UART_ONLY_NOTE);
  assert.match(d.reason, /MODE1 只原画禁用/);
});

test("显式 UART 打开失败（COM6 打不开）：明确报错，不偷偷回退到网口", () => {
  const s = new TransportSelector("uart");
  s.next();
  const d = s.record("uart", { ok: false, detail: "串口 COM6 打开失败：File not found（当前可用串口：COM1）" });
  assert.equal(d.state, "failed");
  assert.equal(d.active, null, "绝不静默回退到另一条通道");
  assert.match(d.reason, /串口 COM6 打开失败/);
  assert.match(d.reason, /没有可用数据通道/);
  assert.deepEqual(d.trail, ["uart FAIL：串口 COM6 打开失败：File not found（当前可用串口：COM1）"]);
});

test("auto：网口在 ⇒ 主 UDP；串口也在 ⇒ 第二观察通道（不是失败、不降级）", () => {
  const s = new TransportSelector("auto");
  assert.equal(s.next(), "udp");
  s.record("udp", { ok: true, detail: "绑定后 2 ms 内收到 1 包" });
  assert.equal(s.next(), "uart", "auto 必须继续探串口（第二观察通道）");
  const d = s.record("uart", { ok: true, detail: "串口 COM6 已打开；固件在线" });
  assert.equal(d.state, "active");
  assert.equal(d.active, "udp");
  assert.equal(d.secondary, "uart");
  assert.equal(d.degraded, false);
  assert.match(d.reason, /第二观察通道/);
});

test("auto：网口在但串口打不开 ⇒ 仍是 active（只是少一条观察通道，原因写清楚）", () => {
  const s = new TransportSelector("auto");
  s.next();
  s.record("udp", { ok: true, detail: "绑定后 2 ms 内收到 1 包" });
  s.next();
  const d = s.record("uart", { ok: false, detail: "串口 COM6 打开失败：Access denied（当前可用串口：COM6）" });
  assert.equal(d.state, "active");
  assert.equal(d.active, "udp");
  assert.equal(d.secondary, null);
  assert.match(d.reason, /串口不可用/);
  assert.match(d.reason, /Access denied/);
});

test("auto：网口不在 + 串口可用 ⇒ 降级为串口档（仅事件回传）", () => {
  const s = new TransportSelector("auto");
  s.next();
  const mid = s.record("udp", { ok: false, detail: "1500 ms 内未收到任何包" });
  assert.equal(mid.state, "idle", "还有串口没探：此时不能下结论");
  assert.match(mid.reason, /尝试串口/);
  s.next();
  const d = s.record("uart", { ok: true, detail: "串口 COM6 已打开；固件在线" });
  assert.equal(d.state, "degraded");
  assert.equal(d.active, "uart");
  assert.equal(d.degraded, true);
  assert.match(d.reason, /仅事件回传/);
});

test("auto：两侧都不可用 ⇒ failed，两条原因都在（用户能分别排查）", () => {
  const s = new TransportSelector("auto");
  s.next();
  s.record("udp", { ok: false, detail: "1500 ms 内未收到任何包" });
  s.next();
  const d = s.record("uart", { ok: false, detail: "串口 COM6 打开失败：File not found" });
  assert.equal(d.state, "failed");
  assert.match(d.reason, /UDP：1500 ms 内未收到任何包/);
  assert.match(d.reason, /串口：串口 COM6 打开失败/);
  assert.equal(Object.keys(d.failures).length, 2);
});

test("探测顺序错乱必须抛错（不允许静默走错分支）", () => {
  const s = new TransportSelector("auto");
  assert.throws(() => s.record("uart", { ok: true, detail: "x" }), /探测顺序错乱/);
});

test("运行期降级：auto 且备选可用才换；显式模式或备选不可用一律返回 null", () => {
  const auto = new TransportSelector("auto");
  auto.next();
  auto.record("udp", { ok: true, detail: "收到包" });
  auto.next();
  auto.record("uart", { ok: true, detail: "串口可用" });
  const d = auto.fallback("UDP 已绑定但 5000 ms 内未收到任何包");
  assert.equal(d?.active, "uart", "auto 才能降级");
  assert.equal(d?.degraded, true);
  assert.match(d?.trail.join("\n") ?? "", /降级 udp → uart/);

  const explicit = new TransportSelector("udp");
  explicit.next();
  explicit.record("udp", { ok: true, detail: "收到包" });
  assert.equal(explicit.fallback("停滞"), null, "显式选择不自动换通道（要用户拍板）");

  const noAlt = new TransportSelector("auto");
  noAlt.next();
  noAlt.record("udp", { ok: true, detail: "收到包" });
  noAlt.next();
  noAlt.record("uart", { ok: false, detail: "串口打不开" });
  assert.equal(noAlt.fallback("停滞"), null, "备选没探通过就不能降级（避免降级到黑洞）");
});

test("force：用户显式选择后状态与能力文案同步更新", () => {
  const s = new TransportSelector("auto");
  s.next();
  s.record("udp", { ok: true, detail: "收到包" });
  s.next();
  s.record("uart", { ok: true, detail: "串口可用" });
  const d = s.force("uart", "显式切换到串口（仅事件回传）");
  assert.equal(d.active, "uart");
  assert.equal(d.degraded, true);
  assert.equal(d.state, "degraded");
  assert.match(d.trail.join("\n"), /显式切换到 uart/);
});

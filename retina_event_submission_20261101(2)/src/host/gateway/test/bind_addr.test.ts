// task-1 判据 A 的网关侧单测：UDP bind 地址不属于本机（EADDRNOTAVAIL / NOTLOCAL）时，
// 网关必须在 8 s 内打印含 BIND_ADDR_NOT_LOCAL 的明确错误、并以非 0 退出码结束 —— 而不是"零输出 exit 0"。
// 大部分用例是纯函数（注入假网卡，不依赖真机）；末尾用真 socket 跑一次 main() 覆盖"文案 + 退出码"整条链路，
// 端口取 124xx，避开开发板上游的 1234 与 Lead 诊断用的 8787/8801。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BIND_ADDR_NOT_LOCAL,
  formatBindAddrNotLocal,
  isCgnatIpv4,
  isIpv4Literal,
  isLocalBindAddress,
  isLoopbackAddr,
  isNotLocalBindFailure,
  isPrivateIpv4,
  localIpv4Addresses,
  preferredBindAddress,
  socketErrorCodeOf,
} from "../src/transport/live.ts";
import type { NetworkInterfacesLike } from "../src/transport/live.ts";
import { UdpTransport } from "../src/transport/udp.ts";
import { STARTUP_GUARD_MS, installFatalHandlers, main, startupGuardMs, withStartupGuard } from "../src/main.ts";
import { getProfile } from "@retina/protocol";
import type { Profile } from "@retina/protocol";

const profile: Profile = getProfile("retina-v2-800x480-1280") as Profile;

/** 假网卡：一块物理网卡 192.168.10.1 + 回环 127.0.0.1（不碰真机网卡，换机器跑也稳定） */
const FAKE_IFACES: NetworkInterfacesLike = {
  "以太网": [{ address: "192.168.10.1", family: "IPv4", internal: false }],
  "Loopback Pseudo-Interface 1": [{ address: "127.0.0.1", family: "IPv4", internal: true }],
};

test("isIpv4Literal：点分四段且在 0-255 内才算 IPv4 字面量", () => {
  assert.equal(isIpv4Literal("203.0.113.9"), true);
  assert.equal(isIpv4Literal(" 192.168.10.1 "), true);
  assert.equal(isIpv4Literal("999.1.1.1"), false);
  assert.equal(isIpv4Literal("192.168.1"), false);
  assert.equal(isIpv4Literal("localhost"), false);
});

test("isLoopbackAddr：127.0.0.0/8 / localhost / ::1 属于本机，物理网卡地址不属于", () => {
  assert.equal(isLoopbackAddr("127.0.0.1"), true);
  assert.equal(isLoopbackAddr("127.255.255.254"), true);
  assert.equal(isLoopbackAddr("localhost"), true);
  assert.equal(isLoopbackAddr("::1"), true);
  assert.equal(isLoopbackAddr("192.168.10.1"), false);
});

test("isLocalBindAddress：本机网卡/回环/通配通过，非本机地址（NOTLOCAL）拒绝", () => {
  assert.equal(isLocalBindAddress("192.168.10.1", FAKE_IFACES), true);
  assert.equal(isLocalBindAddress("127.0.0.1", FAKE_IFACES), true);
  assert.equal(isLocalBindAddress("127.0.0.2", FAKE_IFACES), true);
  assert.equal(isLocalBindAddress("0.0.0.0", FAKE_IFACES), true);
  assert.equal(isLocalBindAddress("", FAKE_IFACES), true);
  assert.equal(isLocalBindAddress("localhost", FAKE_IFACES), true);
  // 假网卡清单里没有的地址 ⇒ 一定不属于本机（判据 A 的输入）
  assert.equal(isLocalBindAddress("203.0.113.9", FAKE_IFACES), false);
  assert.equal(localIpv4Addresses(FAKE_IFACES).join(","), "192.168.10.1,127.0.0.1");
});

test("socketErrorCodeOf：把真实 socket 错误码从文本里取出来", () => {
  assert.equal(socketErrorCodeOf("bind EADDRNOTAVAIL 203.0.113.9:12401"), "EADDRNOTAVAIL");
  assert.equal(socketErrorCodeOf("bind EACCES 192.168.1.102:1236"), "EACCES");
  assert.equal(socketErrorCodeOf("bind EADDRINUSE 0.0.0.0:1234"), "EADDRINUSE");
  assert.equal(socketErrorCodeOf("some libuv failure errno -4091"), "errno -4091");
  assert.equal(socketErrorCodeOf("boom"), null);
});

test("isNotLocalBindFailure：只认 NOTLOCAL 类错误，别把端口占用/权限问题误判", () => {
  assert.equal(isNotLocalBindFailure("bind EADDRNOTAVAIL 203.0.113.9:12401"), true);
  assert.equal(isNotLocalBindFailure("bind WSAEADDRNOTAVAIL 203.0.113.9:12401"), true);
  assert.equal(isNotLocalBindFailure("bind: Cannot assign requested address"), true);
  assert.equal(isNotLocalBindFailure("bind EADDRINUSE 0.0.0.0:1234"), false);
  assert.equal(isNotLocalBindFailure("bind EACCES 192.168.1.102:1236"), false);
});

test("formatBindAddrNotLocal：单行、含 BIND_ADDR_NOT_LOCAL / socket_code / 本机清单 / 修复命令", () => {
  const msg = formatBindAddrNotLocal(
    "203.0.113.9", 1234, "EADDRNOTAVAIL", "bind EADDRNOTAVAIL 203.0.113.9:1234", FAKE_IFACES,
  );
  assert.match(msg, new RegExp(BIND_ADDR_NOT_LOCAL));
  assert.match(msg, /socket_code=EADDRNOTAVAIL/);
  assert.match(msg, /203\.0\.113\.9:1234/);
  assert.match(msg, /本机 IPv4：192\.168\.10\.1、127\.0\.0\.1/);
  assert.match(msg, /--bind 192\.168\.10\.1/);
  assert.match(msg, /netsh interface ipv4 set address name="以太网" static 203\.0\.113\.9 255\.255\.255\.0/);
  assert.equal(msg.includes("\n"), false, "必须是单行：日志/终端一行就能看完");
});

test("withStartupGuard：快速完成不改变结果，卡住时按时超时（不静默 exit 0）", async () => {
  assert.equal(await withStartupGuard("测试", 1000, Promise.resolve(7)), 7);
  await assert.rejects(
    () => withStartupGuard("网关启动", 30, new Promise<never>(() => { /* 永不 settle */ })),
    /启动超时：网关启动.*30 ms/,
  );
  assert.ok(STARTUP_GUARD_MS > 0 && STARTUP_GUARD_MS <= 8000, "启动守卫必须 ≤ 8 s（判据 A）");
});

test("installFatalHandlers：幂等（重复安装不会重复挂进程监听）", () => {
  const beforeRej = process.listenerCount("unhandledRejection");
  const beforeExc = process.listenerCount("uncaughtException");
  installFatalHandlers();
  installFatalHandlers();
  assert.equal(process.listenerCount("unhandledRejection"), beforeRej + 1);
  assert.equal(process.listenerCount("uncaughtException"), beforeExc + 1);
});

test("UdpTransport：绑定失败后不再回调 onBound（不能出现假\"已绑定\"）", async () => {
  const bound: string[] = [];
  const errors: string[] = [];
  const t = new UdpTransport({
    profile,
    bind: "203.0.113.9",
    port: 12464,
    onBound: (ip, p) => bound.push(ip + ":" + p),
  });
  t.on("error", (e) => errors.push(e.message));
  t.start();
  await new Promise((r) => setTimeout(r, 150));   // 真 socket：EADDRNOTAVAIL 是异步错误
  t.stop();                                        // 收尾曾在这里 send() 隐式绑定 ⇒ 触发 listening
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(errors.some((m) => /EADDRNOTAVAIL/.test(m)), "必须上报真实绑定错误");
  assert.deepEqual(bound, [], "绑定失败后绝不能再报\"已绑定\"");
});

test("main：--udp --bind 非本机地址 ⇒ 打印 BIND_ADDR_NOT_LOCAL + EADDRNOTAVAIL，exitCode=2", async () => {
  const prevExit = process.exitCode;
  const prevErr = console.error;
  const prevLog = console.log;
  const lines: string[] = [];
  const out: string[] = [];
  console.error = (...args: unknown[]): void => { lines.push(args.map((a) => String(a)).join(" ")); };
  console.log = (...args: unknown[]): void => { out.push(args.map((a) => String(a)).join(" ")); };
  try {
    await main(["--udp", "--bind", "203.0.113.9", "--port", "12459", "--ws-port", "12458", "--serve"]);
    assert.equal(process.exitCode, 2, "绑定失败必须以非 0 退出码结束（判据 A）");
    const text = lines.join("\n");
    assert.match(text, /\[FATAL\]/);
    assert.match(text, new RegExp(BIND_ADDR_NOT_LOCAL));
    assert.match(text, /EADDRNOTAVAIL/);
    assert.doesNotMatch(out.join("\n"), /UDP 已绑定/, "失败路径不能再打印\"UDP 已绑定\"（假成功）");
  } finally {
    console.error = prevErr;
    console.log = prevLog;
    process.exitCode = prevExit;
  }
});

test("startupGuardMs：默认 7 s；auto 的 --udp-probe 会放宽阈值（避免误杀合法慢启动）", () => {
  assert.equal(startupGuardMs({}), 7000);
  assert.equal(startupGuardMs({ udpProbeMs: 0 }), 7000);
  assert.equal(startupGuardMs({ udpProbeMs: 1500 }), 7000);
  // 探针 10 s + 3 s 余量 ⇒ 阈值 13 s（判据：--udp-probe 10000 不得被 7 s 守卫误杀）
  assert.equal(startupGuardMs({ udpProbeMs: 10000 }), 13000);
  assert.equal(startupGuardMs({ udpProbeMs: 25000 }), 28000);
});

test("preferredBindAddress：优先有线私有网段，排除 Tailscale/VMnet/VLAN/链路本地/回环", () => {
  assert.equal(isPrivateIpv4("192.168.1.102"), true);
  assert.equal(isPrivateIpv4("10.27.235.85"), true);
  assert.equal(isPrivateIpv4("172.16.0.1"), true);
  assert.equal(isPrivateIpv4("172.31.255.254"), true);
  assert.equal(isPrivateIpv4("172.32.0.1"), false, "172.16-31/12 之外不是私有地址");
  assert.equal(isPrivateIpv4("100.97.43.68"), false, "CGNAT 不是 RFC1918");
  assert.equal(isCgnatIpv4("100.97.43.68"), true);
  assert.equal(isCgnatIpv4("100.128.0.1"), false);

  const MIXED: NetworkInterfacesLike = {
    // 真机枚举顺序里虚拟网卡常排在前面：打分不能受顺序影响
    "Tailscale": [{ address: "100.97.43.68", family: "IPv4", internal: false }],
    "VMware Network Adapter VMnet8": [{ address: "192.168.17.1", family: "IPv4", internal: false }],
    "vEthernet (Default Switch)": [{ address: "172.27.48.1", family: "IPv4", internal: false }],
    "WLAN": [{ address: "10.27.235.85", family: "IPv4", internal: false }],
    "以太网": [{ address: "192.168.1.102", family: "IPv4", internal: false }],
    "Loopback Pseudo-Interface 1": [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  };
  assert.equal(preferredBindAddress(MIXED)?.address, "192.168.1.102");
  assert.equal(preferredBindAddress(MIXED)?.name, "以太网");

  // 只有回环 + CGNAT 时不得把 Tailscale 当首选（宁可不建议，也不误导用户改板端）
  const ONLY_CGNAT: NetworkInterfacesLike = {
    "Tailscale": [{ address: "100.97.43.68", family: "IPv4", internal: false }],
    "Loopback": [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  };
  assert.equal(preferredBindAddress(ONLY_CGNAT), null);
  // 只有虚拟网卡/链路本地时同上
  assert.equal(preferredBindAddress({
    "以太网 3": [{ address: "169.254.10.20", family: "IPv4", internal: false }],
  }), null);
});

test("formatBindAddrNotLocal：修复① 的建议地址跟着网卡打分走（不推荐 Tailscale）", () => {
  const MIXED: NetworkInterfacesLike = {
    "Tailscale": [{ address: "100.97.43.68", family: "IPv4", internal: false }],
    "VMware Network Adapter VMnet1": [{ address: "192.168.78.1", family: "IPv4", internal: false }],
    "以太网": [{ address: "192.168.1.102", family: "IPv4", internal: false }],
    "Loopback Pseudo-Interface 1": [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  };
  const msg = formatBindAddrNotLocal("203.0.113.9", 1234, "EADDRNOTAVAIL", "bind EADDRNOTAVAIL 203.0.113.9:1234", MIXED);
  assert.match(msg, /--bind 192\.168\.1\.102/);
  assert.doesNotMatch(msg, /--bind 100\.97\.43\.68/, "不得建议 Tailscale 地址（板端接不到）");
  assert.doesNotMatch(msg, /--bind 192\.168\.78\.1/, "VMnet 虚拟网卡不该被推荐");
  // 建议地址必须是本机清单里的真地址（换机器时靠清单推，不是写死）
  const suggested = /--bind (\d+\.\d+\.\d+\.\d+)/.exec(msg)?.[1];
  assert.ok(suggested !== undefined && localIpv4Addresses(MIXED).includes(suggested));
});


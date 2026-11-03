// task-1 判据 B 的启动器侧单测：launch.mjs 在 spawn 网关之前用 os.networkInterfaces() 预检 --bind，
// 地址不属于本机时立刻 die（含 BIND_ADDR_NOT_LOCAL + 本机 IPv4 清单 + 可执行的 netsh 修复命令），
// 而不是把 EADDRNOTAVAIL 当 warning 继续、然后干等 25 s 报"服务没有就绪"。
// 这里只测纯函数（不装依赖、不构建、不起网关），真实 CLI 行为由 evidence.log 的命令级判据覆盖。
import { test } from "node:test";
import assert from "node:assert/strict";

interface Iface { readonly name: string; readonly address: string; readonly internal: boolean }
interface LaunchMod {
  readonly listLocalIpv4: () => Iface[];
  readonly isIpv4Literal: (addr: string) => boolean;
  readonly isLoopbackAddr: (addr: string) => boolean;
  readonly isLocalBindAddress: (addr: string, ifaces?: readonly Iface[]) => boolean;
  readonly bindNotLocalMessage: (addr: string, port: number, ifaces?: readonly Iface[]) => string;
  readonly pickPreferredIface: (ifaces?: readonly Iface[]) => Iface | null;
}

// launch.mjs 是纯 ESM .js，tsconfig 未开 allowJs：静态 import 会报 TS7016（找不到声明）。
// 用非字面量动态 import 让 TS 不做模块解析 —— 运行时仍加载真实文件，不复制一份实现来测。
const mod = (await import(new URL("../launch.mjs", import.meta.url).href)) as unknown as LaunchMod;

/** 假网卡：物理网卡 192.168.1.102（板卡 PC_IP）+ 回环 */
const FAKE: Iface[] = [
  { name: "以太网", address: "192.168.1.102", internal: false },
  { name: "Loopback Pseudo-Interface 1", address: "127.0.0.1", internal: true },
];

test("预检：本机地址通过（192.168.1.102 在网卡清单里）", () => {
  assert.equal(mod.isLocalBindAddress("192.168.1.102", FAKE), true);
});

test("预检：非本机地址拒绝（203.0.113.9 不在清单里）", () => {
  assert.equal(mod.isLocalBindAddress("203.0.113.9", FAKE), false);
  // 清单里只有回环时，任何物理地址都必须被拒（换机器也不会误放行）
  assert.equal(mod.isLocalBindAddress("192.168.1.102", [{ name: "lo", address: "127.0.0.1", internal: true }]), false);
});

test("预检：127.0.0.1 / localhost / 0.0.0.0 永远通过（不需要网卡配置）", () => {
  assert.equal(mod.isLocalBindAddress("127.0.0.1", FAKE), true);
  assert.equal(mod.isLocalBindAddress("127.0.0.1", []), true);
  assert.equal(mod.isLocalBindAddress("localhost", []), true);
  assert.equal(mod.isLocalBindAddress("0.0.0.0", []), true);
  assert.equal(mod.isLocalBindAddress("", []), true);
});

test("listLocalIpv4：能列出真机网卡（至少含回环 127.0.0.1）", () => {
  const ifaces = mod.listLocalIpv4();
  assert.ok(ifaces.length >= 1);
  assert.ok(ifaces.some((x) => x.address === "127.0.0.1"));
  for (const x of ifaces) {
    assert.equal(typeof x.name, "string");
    assert.equal(mod.isIpv4Literal(x.address), true, "清单里必须全是 IPv4 字面量");
  }
});

test("bindNotLocalMessage：单行，含 BIND_ADDR_NOT_LOCAL / 本机 IPv4 清单 / netsh 修复命令", () => {
  const msg = mod.bindNotLocalMessage("203.0.113.9", 1234, FAKE);
  assert.match(msg, /BIND_ADDR_NOT_LOCAL/);
  assert.match(msg, /203\.0\.113\.9/);
  assert.match(msg, /本机 IPv4：192\.168\.1\.102@以太网/);
  assert.match(msg, /--bind 192\.168\.1\.102/);
  // 必须给出可直接粘贴执行的命令（判据 B 的字面量要求）
  assert.match(msg, /netsh interface ipv4 set address name="以太网" static 192\.168\.1\.102 255\.255\.255\.0/);
  assert.equal(msg.includes("\n"), false, "启动器输出必须是一行（die 会额外换行排版）");
});

test("bindNotLocalMessage：虚拟网卡/VPN 排在前面时，修复建议仍指向有线网卡", () => {
  // 真机常见顺序：Tailscale / vEthernet / WLAN 排在以太网前面；建议若落到它们身上就是误导
  const real: Iface[] = [
    { name: "Tailscale", address: "100.97.43.68", internal: false },
    { name: "VMware Network Adapter VMnet1", address: "192.168.78.1", internal: false },
    { name: "vEthernet (Default Switch)", address: "172.27.48.1", internal: false },
    { name: "WLAN", address: "10.27.235.85", internal: false },
    { name: "以太网", address: "192.168.1.102", internal: false },
    { name: "Loopback Pseudo-Interface 1", address: "127.0.0.1", internal: true },
  ];
  const picked = mod.pickPreferredIface(real);
  assert.equal(picked?.name, "以太网");
  const msg = mod.bindNotLocalMessage("203.0.113.9", 1234, real);
  assert.match(msg, /--bind 192\.168\.1\.102/);
  assert.match(msg, /netsh interface ipv4 set address name="以太网"/);
  assert.doesNotMatch(msg, /name="Tailscale"/);
});

// 口径一致性：网关 [FATAL] BIND_ADDR_NOT_LOCAL 的"修复①"与启动器预检的"修复①"必须给同一个地址，
// 否则用户按其中一个改完，另一个还在提示别的网卡（Lead 明确要求：同一份清单 ⇒ 同一首选地址）。
interface LiveMod {
  readonly preferredBindAddress: (
    ifaces?: Record<string, readonly { readonly address: string; readonly family: string | number; readonly internal: boolean }[]>,
  ) => { readonly address: string; readonly name: string } | null;
}

function asOsIfaces(list: readonly Iface[]): Record<string, readonly { address: string; family: string; internal: boolean }[]> {
  const out: Record<string, { address: string; family: string; internal: boolean }[]> = {};
  for (const x of list) out[x.name] = [{ address: x.address, family: "IPv4", internal: x.internal }];
  return out;
}

test("口径一致：同一份网卡清单，启动器与网关给同一个首选地址", async () => {
  // 非字面量路径动态 import：与 launch.mjs 一样绕过 TS 的 .ts 模块解析限制
  const live = (await import(new URL("../../gateway/src/transport/live.ts", import.meta.url).href)) as unknown as LiveMod;
  const REAL: Iface[] = [
    { name: "Tailscale", address: "100.97.43.68", internal: false },
    { name: "VMware Network Adapter VMnet1", address: "192.168.78.1", internal: false },
    { name: "vEthernet (Default Switch)", address: "172.27.48.1", internal: false },
    { name: "WLAN", address: "10.27.235.85", internal: false },
    { name: "以太网", address: "192.168.1.102", internal: false },
    { name: "Loopback Pseudo-Interface 1", address: "127.0.0.1", internal: true },
  ];
  const launcher = mod.pickPreferredIface(REAL);
  const gateway = live.preferredBindAddress(asOsIfaces(REAL));
  assert.equal(launcher?.address, "192.168.1.102");
  assert.equal(gateway?.address, launcher?.address, "启动器与网关的首选地址必须一致");
  assert.equal(gateway?.name, launcher?.name, "首选网卡名也必须一致（netsh 要按名字改）");

  // 真机清单同样必须一致（结果不写死：只要求两边相等，换机器也成立）
  const realLauncher = mod.pickPreferredIface();
  const realGateway = live.preferredBindAddress();
  assert.equal(realGateway?.address, realLauncher?.address, "真机上网关与启动器的首选地址也必须一致");
});

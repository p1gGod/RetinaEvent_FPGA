#!/usr/bin/env node
// launch.mjs —— 「一键启动」的实际实现（面向不会命令行的使用者）
// 四件事：① 检查 Node ② 缺依赖就装 ③ 缺界面就构建 ④ 起网关（自带界面）并打开浏览器
// 为什么用 Node 而不是 .bat 里写逻辑：Node 的输出是 UTF-8，中文提示在任何 Windows 上都不会乱码；
// .bat 只负责"找到 node 并转交"，保持极简。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import dgram from "node:dgram";
import os from "node:os";
import { fileURLToPath } from "node:url";

const APP = path.resolve(import.meta.dirname, "..");          // host/app
const WEB = path.join(APP, "web");
const DIST = path.join(WEB, "dist");

// npm 的可执行入口。
// 坑（2026-10-09 实测）：Windows 上命令名 "npm" 实际指向批处理 npm.cmd。Node ≥18.20.2 / ≥20.12.2
// 为修 CVE-2024-27980 做了加固：shell:false 时 spawn/spawnSync 一个 .cmd/.bat 会直接抛
// "spawnSync npm.cmd EINVAL"，命令根本没被执行（见 docs/05_experiments/上位机启动_20261009/
// gateway_launch_stderr.log）。因此这里优先直接调用 npm 自己的 JS 入口
// （node <node安装目录>/node_modules/npm/bin/npm-cli.js），它由 node 直接执行、任何平台都不需要 shell；
// 只有该入口不存在时才退回 npm.cmd + shell:true。两种模式对全部 CLI（--udp/--replay/--demo/--dev）一致生效。
function resolveNpm() {
  const candidates = [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const cli of candidates) {
    try { if (fs.existsSync(cli)) return { cmd: process.execPath, args: [cli], shell: false, via: cli }; } catch { /* 忽略 */ }
  }
  if (process.platform === "win32") return { cmd: "npm.cmd", args: [], shell: true, via: "npm.cmd (shell:true)" };
  return { cmd: "npm", args: [], shell: false, via: "npm" };
}
const NPM = resolveNpm();

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

// --uart / --serial：UART 路线（WIRE-U1）：串口数据源（缺省 COM6，115200 8N1）
// --auto：传输方式自动（先网口后串口；网口不在则降级为"仅事件回传"）
const UART_MODE = has("--uart") || has("--serial") || has("--auto");
const MODE = UART_MODE ? "uart" : has("--udp") ? "udp" : has("--replay") ? "replay" : has("--dev") ? "dev" : "demo";
const SERIAL_PORT = valOf("--serial-port") ?? valOf("--serial") ?? "COM6";
const UART_AUTO = has("--auto");
const NO_OPEN = has("--no-open");
const SELFTEST = has("--selftest");
const PORT_FROM = Number(valOf("--port") ?? 8787);
// --udp 模式收流地址：默认值必须与 packages/protocol/src/profile.ts 的 retina-v2-800x480-1280
// （udp.bind / udp.port）一致；板侧 PC_IP 是写死的，改这里等于改 line 格式，两边必须同时改。
const UDP_BIND = valOf("--bind") ?? "192.168.1.102";
const UDP_PORT = Number(valOf("--udp-port") ?? 1234);
// 长录参数透传（task-30）：launch.mjs 自己不解释这些值，只原样交给网关；
// 不带任何 --record* 时 RECORD_ARGS 为空，启动行为与以前完全一致。
const RECORD_ARGS = [];
for (const f of ["--record", "--record-raw"]) if (has(f)) RECORD_ARGS.push(f);
for (const f of ["--record-root", "--record-chunk-min", "--record-crf", "--record-encoder", "--ffmpeg"]) {
  if (!has(f)) continue;
  const v = valOf(f);
  if (v !== undefined) RECORD_ARGS.push(f, v);
}

const line = "============================================================";
const say = (m) => console.log(m);

function die(msg, hint) {
  console.error("");
  console.error("  [启动失败] " + msg);
  if (hint) console.error("  " + hint);
  console.error("");
  process.exit(1);
}

function run(cmd, args, cwd, shell) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: shell ?? false });
  if (r.error) die("无法执行 " + cmd + "：" + r.error.message);
  if (r.status !== 0) die(cmd + " " + args.join(" ") + " 退出码 " + r.status);
}

/** 用 npm 入口执行 npm 子命令（自动带上 npm-cli.js 前缀与正确的 shell 设置） */
function runNpm(args, cwd) {
  run(NPM.cmd, [...NPM.args, ...args], cwd, NPM.shell);
}

/** 递归取最大修改时间（判断界面是否需要重新构建） */
function newestMtime(dir, exts) {
  let newest = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") newest = Math.max(newest, newestMtime(p, exts)); continue; }
    if (exts.some((x) => e.name.endsWith(x))) newest = Math.max(newest, fs.statSync(p).mtimeMs);
  }
  return newest;
}

function freePort(from, tries) {
  return new Promise((resolve) => {
    let port = from;
    let left = tries;
    const probe = () => {
      const s = net.createServer();
      s.once("error", () => { s.close(); port++; if (--left <= 0) resolve(0); else probe(); });
      s.listen(port, "127.0.0.1", () => s.close(() => resolve(port)));
    };
    probe();
  });
}

/**
 * UDP 收流端口预检（只对 --udp 模式）。
 *
 * 为什么必须做：Windows 上两个进程用 SO_REUSEADDR 绑同一 UDP 端口时，**先绑定者独占收包**。
 * 上一次没关掉的网关窗口会让新网关"绑定成功却永远收 0 包" ⇒ 界面全黑、日志还写着"UDP 已绑定"，
 * 用户看不到任何错误（2026-10-12 联板排障实测：旧进程占着 1234 时，网卡收 23.7 MB/s，新监听者收 0 包）。
 * 判据：用**独占绑定**（不设 SO_REUSEADDR）探测 —— 被占用时内核明确报 EADDRINUSE（同机实测），
 * 所以这个检查是可靠的，不是启发式。
 * @returns {"free"|"inuse"|"probe-failed:<code>"}
 */
function probeUdpPort(bind, port) {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");           // 故意不设 reuseAddr：占用时会明确失败
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { s.close(); } catch { /* 还没绑上/已关 */ }
      resolve(v);
    };
    s.once("error", (e) => done(e.code === "EADDRINUSE" ? "inuse" : "probe-failed:" + e.code));
    s.bind(port, bind, () => done("free"));
  });
}

/**
 * 本机 IPv4 地址清单（含回环），[{name, address, internal}]。
 * 预检不靠"试着 bind 一下"：绑定探测只能说明"绑不上"，而用户需要的是
 * "这个地址不属于本机、本机到底有哪些地址、我该敲哪条命令"。
 */
export function listLocalIpv4() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === "IPv4" || info.family === 4) out.push({ name, address: info.address, internal: info.internal });
    }
  }
  return out;
}

/** IPv4 字面量判定（"192.168.1.102" 是；"localhost"/"192.168.1" 不是） */
export function isIpv4Literal(addr) {
  const parts = String(addr).trim().split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** 回环地址（127.0.0.0/8、localhost、::1）：绑它永远不需要网卡配置 */
export function isLoopbackAddr(addr) {
  const a = String(addr).trim().toLowerCase();
  return a === "localhost" || a === "::1" || a.startsWith("127.");
}

/**
 * --bind 的地址属于本机吗？
 * 通配地址（空 / 0.0.0.0 / ::）与回环永远算本机；其余必须是 os.networkInterfaces() 里的某个 IPv4。
 * 判错的代价不对称：把本机地址判成"不是本机"⇒ 拒绝正常启动；把非本机判成本机 ⇒ 用户回到
 * "干等 25 秒"的老毛病。所以清单匹配用精确相等，不做网段/前缀猜测。
 */
export function isLocalBindAddress(addr, ifaces = listLocalIpv4()) {
  const a = String(addr).trim();
  if (a === "" || a === "0.0.0.0" || a === "::") return true;
  if (isLoopbackAddr(a)) return true;
  return ifaces.some((x) => x.address === a);
}

/** RFC1918 私有地址（192.168/16、10/8、172.16-31/12）：板卡链路一定是私有网段 */
export function isPrivateIpv4(addr) {
  const p = String(addr).trim().split(".");
  if (p.length !== 4) return false;
  const a = Number(p[0]);
  const b = Number(p[1]);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  if (a === 192 && b === 168) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/** CGNAT 100.64.0.0/10（Tailscale 等虚拟组网）：不是"接板卡"的地址 */
export function isCgnatIpv4(addr) {
  const p = String(addr).trim().split(".");
  if (p.length !== 4) return false;
  const a = Number(p[0]);
  const b = Number(p[1]);
  return a === 100 && b >= 64 && b <= 127;
}

/** 虚拟/隧道/无线网卡的名字特征：修网卡 IP 的提示绝不能落到它们身上 */
const VIRTUAL_NIC_RE = /tailscale|vethernet|vmware|hyper-v|virtualbox|loopback|bluetooth|wsl|docker|无线|wi-?fi|wlan/i;
/** 有线以太网卡的名字特征（板卡走网线，优先建议它） */
const WIRED_NIC_RE = /以太网|ethernet|本地连接|lan/i;

/**
 * 从本机 IPv4 里挑一张"该拿去接板卡"的网卡（与网关 gateway/src/transport/live.ts 的
 * preferredBindAddress 同一打分口径 —— 同一份清单两处必须给出同一个首选地址）：
 *   +8 RFC1918 私有网段；+4 有线网卡（板卡走网线）；
 *   排除 回环/internal/169.254 链路本地/100.64-127 CGNAT(Tailscale)/名字像虚拟·隧道·无线
 *   （vEthernet、VMnet、WLAN、Docker、WSL…）；
 *   排序 score 降序 → 地址字符串升序，与网卡枚举顺序无关；不硬编码任何具体 IP。
 * 全被过滤掉时退化为"第一个非 internal 地址"，再退到清单首项。
 */
export function pickPreferredIface(ifaces = listLocalIpv4()) {
  const cands = [];
  for (const x of ifaces) {
    const a = String(x.address).trim();
    if (x.internal || isLoopbackAddr(a)) continue;
    if (VIRTUAL_NIC_RE.test(x.name)) continue;
    if (!isIpv4Literal(a)) continue;
    if (a.startsWith("169.254.") || isCgnatIpv4(a)) continue;
    let score = 0;
    if (isPrivateIpv4(a)) score += 8;
    if (WIRED_NIC_RE.test(x.name)) score += 4;
    cands.push({ name: x.name, address: a, internal: x.internal, score });
  }
  cands.sort((p, q) => q.score - p.score || p.address.localeCompare(q.address) || p.name.localeCompare(q.name));
  if (cands.length > 0) return cands[0];
  const external = ifaces.filter((x) => !x.internal);
  return external[0] ?? ifaces[0] ?? null;
}

/**
 * 「bind 地址不是本机」的单行可执行文案：机读标记 BIND_ADDR_NOT_LOCAL + 本机 IPv4 清单 + 修复命令。
 * netsh 里写死 192.168.1.102，是因为板端 PC_IP 就写死发往这个地址（packages/protocol 的 profile 默认值）；
 * 想用别的地址就按清单换掉命令里的 IP，或改用 --bind。
 */
export function bindNotLocalMessage(addr, port, ifaces = listLocalIpv4()) {
  const list = ifaces.map((x) => x.address + "@" + x.name).join("、") || "（未探测到）";
  const nic = pickPreferredIface(ifaces);
  const suggestion = nic ? nic.address : "127.0.0.1";
  return "BIND_ADDR_NOT_LOCAL：--bind " + addr + "（端口 " + port + "）不是本机 IPv4 地址；本机 IPv4：" + list +
    "；修复① 换成本机地址启动：--bind " + suggestion + "（同时把板端 PC_IP 改成 " + suggestion + "）；" +
    "修复② 或把网卡改成板卡要发的地址（管理员 PowerShell）：" +
    'netsh interface ipv4 set address name="' + (nic ? nic.name : "以太网") + '" static 192.168.1.102 255.255.255.0' +
    "；修复③ 或检查网线是否插在已配置该地址的网卡上。";
}

async function waitHttp(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    else if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch { /* 打不开浏览器不致命：地址已经打印出来了 */ }
}

export async function main() {
  // ---------- ① 环境检查 ----------
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 18)) {
    die("Node.js 版本太低（当前 v" + process.versions.node + "）",
        "本程序需要 Node.js 22.18 或更高。请到 https://nodejs.org/ 下载 LTS 版并双击安装，然后重新运行。");
  }

  // ---------- ①.5 bind 归属预检（--udp）----------
  // 为什么放在装依赖/构建之前：bind 地址不属于本机时网关必然绑不上，先花 20 ms 判掉，
  // 用户立刻看到 BIND_ADDR_NOT_LOCAL 与修复命令，而不是等满 25 秒"服务在 25 秒内没有就绪"。
  if (MODE === "udp" && !isLocalBindAddress(UDP_BIND)) {
    die(bindNotLocalMessage(UDP_BIND, UDP_PORT),
        "（预检发生在启动网关之前，网关没有启动；按上面的命令改好地址后重新双击即可）");
  }
  if (MODE === "uart" && UART_AUTO && !isLocalBindAddress(UDP_BIND)) {
    say("       [提示] " + UDP_BIND + " 不是本机地址；自动模式会跳过网口、直接用串口 " + SERIAL_PORT + "。");
  }

  // ---------- ② 依赖 ----------
  if (!fs.existsSync(path.join(APP, "node_modules", "ws"))) {
    say("[1/4] 首次运行：正在安装依赖（大约 10 秒，只需一次）…");
    runNpm(["install", "--no-audit", "--no-fund"], APP);
  } else {
    say("[1/4] 依赖已就绪");
  }

  // ---------- ③ 界面构建（开发模式交给 vite，不需要 dist） ----------
  if (MODE !== "dev") {
    const distIndex = path.join(DIST, "index.html");
    const srcTime = Math.max(
      newestMtime(path.join(WEB, "src"), [".ts", ".css"]),
      fs.existsSync(path.join(WEB, "index.html")) ? fs.statSync(path.join(WEB, "index.html")).mtimeMs : 0,
      fs.existsSync(path.join(WEB, "vite.config.ts")) ? fs.statSync(path.join(WEB, "vite.config.ts")).mtimeMs : 0,
    );
    const distTime = fs.existsSync(distIndex) ? fs.statSync(distIndex).mtimeMs : 0;
    if (distTime === 0 || srcTime > distTime) {
      say("[2/4] 正在构建界面（大约 1 秒）…");
      runNpm(["run", "build", "--workspace", "web"], APP);
    } else {
      say("[2/4] 界面已是最新（源码没改过，跳过构建）");
    }
  } else {
    say("[2/4] 开发模式：界面由 vite 实时编译，跳过构建");
  }

  // ---------- ④ 起服务 ----------
  const port = await freePort(PORT_FROM, 12);
  if (port === 0) die("端口 " + PORT_FROM + " 起连续 12 个都被占用了", "请关掉占用端口的程序，或用 --port 9000 指定别的端口。");

  const children = [];
  let killed = false;
  const killAll = () => {
    if (killed) return;                 // 幂等：重复 kill 在 Windows 上会让 libuv 抛断言
    killed = true;
    for (const c of children) { try { c.kill(); } catch { /* 已退出 */ } }
  };
  process.on("SIGINT", () => { killAll(); process.exitCode = 0; });
  process.on("SIGTERM", () => { killAll(); process.exitCode = 0; });

  const srcArgs = ["--experimental-strip-types", path.join("gateway", "src", "main.ts")];
  let url;
  const modeText = {
    demo: "演示模式（合成数据，不需要开发板）",
    udp: "实时模式（接收开发板 UDP 数据）",
    uart: UART_AUTO
      ? "串口模式（传输方式=自动：先网口后串口，端口 " + SERIAL_PORT + "）"
      : "串口模式（UART 路线：事件回传 + 命令/校准，端口 " + SERIAL_PORT + "，115200 8N1）",
    replay: "回放模式（播放录制好的示例数据）",
    dev: "开发模式（改代码自动热更新）",
  }[MODE];

  if (MODE === "dev") {
    say("[3/4] 正在启动网关与开发服务器…");
    const vitePort = await freePort(5173, 12);
    const gw = spawn(process.execPath, [...srcArgs, ...RECORD_ARGS, "--synth", "--no-serve", "--ws-port", String(port)], { cwd: APP, stdio: "inherit" });
    children.push(gw);
    const vite = spawn(NPM.cmd, [...NPM.args, "run", "dev", "--workspace", "web", "--", "--port", String(vitePort), "--strictPort"], { cwd: APP, stdio: "inherit", shell: NPM.shell });
    children.push(vite);
    url = "http://127.0.0.1:" + vitePort + "/?ws=ws://127.0.0.1:" + port;
  } else {
    // ---------- 端口预检（只对 --udp 模式）：把"静默收 0 包的黑屏"变成明确报错 ----------
    if (MODE === "udp") {
      if (!Number.isInteger(UDP_PORT) || UDP_PORT <= 0 || UDP_PORT > 65535) {
        die("--udp-port 非法：" + String(UDP_PORT), "用法：--udp-port 1234 --bind 192.168.1.102");
      }
      const probe = await probeUdpPort(UDP_BIND, UDP_PORT);
      if (probe === "inuse") {
        die("UDP 收流端口 " + UDP_BIND + ":" + UDP_PORT + " 已被另一个进程占用",
            "极可能是上次没关掉的 RetinaEvent 窗口（或残留的 node.exe）：Windows 上先绑定者独占收包，" +
            "新网关会「绑定成功却收不到任何包」→ 界面全黑且没有报错。请先关掉其它 RetinaEvent 窗口" +
            "（或任务管理器结束 node.exe），再重新双击本文件。");
      }
      if (probe === "free") {
        say("       UDP 收流端口预检通过：" + UDP_BIND + ":" + UDP_PORT + " 空闲");
      } else {
        say("       [提示] UDP 端口预检未能完成（" + probe + "），继续启动；绑定结果以网关日志为准。");
      }
    }
    say("[3/4] 正在启动服务…");
    const modeArgs = MODE === "udp"
      ? ["--udp", "--bind", UDP_BIND, "--port", String(UDP_PORT)]
      : MODE === "uart"
        ? (UART_AUTO
            ? ["--transport", "auto", "--serial", SERIAL_PORT]
            : ["--serial", SERIAL_PORT])
        : MODE === "replay" ? ["--replay"] : ["--synth"];
    const gw = spawn(process.execPath, [...srcArgs, ...modeArgs, ...RECORD_ARGS, "--ws-port", String(port), "--serve"], { cwd: APP, stdio: "inherit" });
    children.push(gw);
    url = "http://127.0.0.1:" + port + "/";
  }

  const uiUrl = url.split("?")[0];
  const ready = await waitHttp(uiUrl + "healthz", 25000);
  if (!ready) {
    killAll();
    die("服务在 25 秒内没有就绪", "请把上面网关打印的最后几行错误发给我；常见原因是端口被占用或防火墙拦截。");
  }

  if (SELFTEST) {
    const res = await fetch(uiUrl);
    const body = await res.text();
    say("[4/4] 自检: HTTP " + res.status + "，" + body.length + " B，含界面标题=" + body.includes("RetinaEvent"));
    killAll();
    process.exitCode = res.ok && body.includes("RetinaEvent") ? 0 : 1;
    await new Promise((r) => setTimeout(r, 400));   // 留一点时间让子进程收尾，避免退出噪音
  }

  if (!SELFTEST) {                       // 自检模式到此为止（ESM 顶层不能用 return）
    for (const c of children) {
      c.on("exit", (code) => {
        if (killed || SELFTEST) return;
        say("");
        say(line);
        say("  服务意外退出了（退出码 " + code + "）");
        say("  请把上面最后几行错误信息截图发给开发者。常见原因：");
        say("   · 端口被其它程序占用（换个端口：双击时加参数 --port 9000）");
        say("   · 防火墙/杀毒软件拦截了本机的网络监听");
        say(line);
      });
    }
    if (!NO_OPEN) openBrowser(url);

    say("");
    say(line);
    say("   RetinaEvent 上位机已启动");
    say(line);
    say("   界面地址 : " + url);
    if (port !== PORT_FROM) {
      say("   注意     : 端口 " + PORT_FROM + " 已被别的程序占用，本次改用 " + port +
          "。浏览器里若开着指向 " + PORT_FROM + " 的旧标签页，那是另一个服务，请用上面的新地址。");
    }
    say("   当前模式 : " + modeText);
    if (MODE === "demo") {
      say("");
      say("   ※ 现在看到的是【演示数据】：由程序合成，用来先看效果。");
      say("     要接真实开发板，请改双击「启动-接开发板.bat」。");
    }
    if (MODE === "uart") {
      say("");
      say("   ※ 串口模式需要板上位流为 UART_LINK_EN=1（当前合体位流是 UART_LINK_EN=0，串口不发数据）。");
      say("     界面「传输方式」卡片会显示握手结果：失败时会明确写「未检测到 UART v3 固件」，遥测照常显示。");
      say("     串口档只回事件（原画 768000 B/帧在 115200 下需 66.7 s/帧，物理不可达）。");
    }
    say(line);
    say("   · 浏览器如果没自动打开，请手动复制上面的地址到浏览器。");
    say("   · 关闭这个窗口，服务就停止了。");
    say(line);
    say("");
    say("（下面是服务日志，正常运行时会滚动刷新统计，可以不管它）");
    say("");

  }
}

// 只有「直接运行本文件」时才执行主流程；被 import 时只暴露上面的辅助函数，
// 便于用隔离脚本单独验证 npm 的 spawn 逻辑（不触发构建、不起网关）。
export { NPM, resolveNpm, runNpm, run, APP, MODE, PORT_FROM };

const isEntry = (() => {
  if (!process.argv[1]) return false;
  try {
    const self = fileURLToPath(import.meta.url);
    const arg = path.resolve(process.argv[1]);
    return process.platform === "win32" ? arg.toLowerCase() === self.toLowerCase() : arg === self;
  } catch { return true; }
})();
if (isEntry) await main();

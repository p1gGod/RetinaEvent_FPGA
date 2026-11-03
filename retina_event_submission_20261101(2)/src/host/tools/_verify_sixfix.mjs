#!/usr/bin/env node
// 六修（DIRECTOR REVIEW_BLOCK=2）机读判据：A1-A7。
// 每一项都由 host/app 下的单测真实断言，本脚本只负责逐项聚焦执行 + 收集 ✔ 证据；
// 任何一项缺失/失败 ⇒ 打印 FAIL 并以非 0 退出，绝不无条件打印 SIXFIX_OK=1。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CASES = [
  { id: "A1", file: "gateway/test/sixfix-assembler.test.ts", match: /✔ A1 /,
    why: "RAW_EV 低帧率（≤200ms/帧）/尾包晚到：纯事件批不得标 EV_ONLY，必须仍进 evQueue+录制（BLOCK-1）" },
  { id: "A2", file: "gateway/test/sixfix-assembler.test.ts", match: /✔ A2 /,
    why: "EV_ONLY 下 40ms 时间窗照常兜底：批数足够、evDrop=0、2000 条守恒（不因门控而退化）" },
  { id: "A3", file: "gateway/test/sixfix-assembler.test.ts", match: /✔ A3 /,
    why: "EV_ONLY→RAW_EV 回切：<40ms 残留批以 EV_ONLY 出口结算，不悬空、不进 evQueue、不重复（BLOCK-2）" },
  { id: "A4", file: "gateway/test/transport_health.test.ts", match: /✔ A4 EACCES/,
    why: "Windows 端口占用实际是 EACCES：与 EADDRINUSE 同样自动重试一次且只一次（R1）" },
  { id: "A5", file: "web/test/sliderlink.test.ts", match: /✔ A5 松手 release/,
    why: "滑条松手 ≤150ms 内恰好一次最终值，取消挂起节流 timer（R2）" },
  { id: "A6", file: "web/test/sixfix-f1.test.ts", match: /✔ A6-1 /,
    why: "host+EV_ONLY 自动切板端事件源，有人话日志，RAW_EV 后恢复用户原选择（F1）" },
  { id: "A7", file: "gateway/test/evonly-ws.test.ts", match: /✔ A7 /,
    why: "双客户端：一个慢只丢自己的 FRAME_RAW，另一个照收，uiDrop 不涨（F2）" },
];

let bad = 0;
for (const c of CASES) {
  const r = spawnSync(process.execPath, ["--test", "--experimental-strip-types", c.file], {
    cwd: app, encoding: "utf8", timeout: 120_000,
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const ok = r.status === 0 && c.match.test(out);
  console.log((ok ? "PASS " : "FAIL ") + c.id + "  " + c.why);
  if (!ok) {
    bad++;
    console.log(out.split("\n").filter((l) => /✖|not ok|Error|等待超时/.test(l)).slice(0, 8).join("\n") || "(无输出)");
  }
}
console.log("");
if (bad === 0) {
  console.log("判据：A1..A7 全部由单测断言通过（证据行见上，逐条 ✔）");
  console.log("SIXFIX_OK=1");
} else {
  console.log("SIXFIX_OK=0  失败项：" + bad);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * _verify_slider.mjs — C 线机读判据（θ / 最小|ΔL| 滑条板端联动）
 *
 * 两部分：
 *  1) **纯逻辑**（不碰网络、不碰 DOM）：用假时钟直接验收 web/src/ui/sliderlink.ts 的四条规则——
 *     拖动 1 s 内下发 ≤5 次、只发最新值、松手 150 ms 内必发最终值、θ 钳位 ≥1、
 *     1 Hz 读回不覆盖拖动/编辑中的值、三态 badge 文案、SET_PARAM ACK 回显带错误码。
 *  2) **真实板端 ACK**：连当前正在运行的网关（默认 ws://127.0.0.1:8787），
 *     先 session.snapshot 读板端 θ，再用 board.setParam **写同一个值**（幂等，不改现场状态），
 *     验收 RPC 返回 ok===true 且 tlvs.theta 为数字（= 板端 ACK 通路真的通）。
 *     注意：板端 UDP 遥测目的端口被厂家 udp_tx.v 写死为 1234，因此"独立网关 1236"收不到 ACK；
 *     真实 ACK 只能走已绑定 1234 的那个网关（脚本只连 WS，不 bind、不杀进程）。
 *     可用 --ws 覆盖（例如 --ws ws://127.0.0.1:8789 会在独立网关上预期超时，用于对照）。
 *
 * 全部通过时最后一行打印 SLIDER_OK=1；任何一条失败打印 FAIL 明细并以 1 退出。
 */
const WS_URL = (() => {
  const i = process.argv.indexOf("--ws");
  return i >= 0 ? process.argv[i + 1] : "ws://127.0.0.1:8787";
})();
const RPC_TIMEOUT_MS = 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
function check(name, ok, detail) {
  console.log((ok ? "PASS  " : "FAIL  ") + name + " ⇒ " + detail);
  if (!ok) fails.push(name);
}

// ---------------- 1) 纯逻辑验收（假时钟） ----------------
const M = await import("../web/src/ui/sliderlink.ts");

function fakeClock(start = 10000) {
  let nowMs = start;
  let seq = 0;
  const tasks = [];
  const timers = {
    now: () => nowMs,
    setTimeout(fn, ms) {
      const id = ++seq;
      tasks.push({ at: nowMs + ms, id, fn, cancelled: false });
      return id;
    },
    clearTimeout(id) {
      const t = tasks.find((x) => x.id === id);
      if (t !== undefined) t.cancelled = true;
    },
  };
  return {
    timers,
    advance(ms) {
      const end = nowMs + ms;
      for (;;) {
        const due = tasks
          .filter((t) => !t.cancelled && t.at <= end)
          .sort((a, b) => a.at - b.at || a.id - b.id);
        const t = due[0];
        if (t === undefined) break;
        nowMs = t.at;
        t.cancelled = true;
        t.fn();
      }
      nowMs = end;
    },
  };
}

function newThrottle() {
  const clock = fakeClock();
  const sent = [];
  const throttle = new M.BoardParamThrottle((key, value) => sent.push({ key, value, at: clock.timers.now() }), {
    timers: clock.timers,
  });
  return { clock, sent, throttle };
}

{
  const { clock, sent, throttle } = newThrottle();
  for (let i = 0; i <= 19; i++) {
    throttle.drag("theta", i + 1);
    clock.advance(50);
  }
  const first = sent[0];
  const inSecond = sent.filter((s) => s.at - first.at < 1000);
  check("拖动 1 s 内下发 ≤5 次（节流口径）", inSecond.length <= 5 && inSecond.length >= 4, inSecond.length + " 次：" + sent.map((s) => s.value).join(","));
  check("只发窗口内最新采样值（不发中间值）", sent.map((s) => s.value).join(",") === "1,5,10,15,20", sent.map((s) => s.value).join(","));
}
{
  const { clock, sent, throttle } = newThrottle();
  throttle.drag("theta", 44);
  clock.advance(100);
  const commitAt = clock.timers.now();
  throttle.commit("theta", 74);
  clock.advance(M.RELEASE_MAX_DELAY_MS);
  const last = sent[sent.length - 1];
  check(
    "松手/提交后 150 ms 内必发最终值",
    sent.length === 2 && last.value === 74 && last.at - commitAt === M.RELEASE_MAX_DELAY_MS,
    "提交后 " + (last.at - commitAt) + " ms 发出 θ=" + last.value,
  );
}
{
  check("θ 钳位 ≥1", [0, -5, Number.NaN].every((v) => M.clampThetaSlider(v, 130) === 1) && M.clampThetaSlider(999, 130) === 130, "0→1, -5→1, NaN→1, 999→130");
  check(
    "1 Hz 读回不覆盖拖动中/编辑中的值",
    M.shouldSyncSlider({ revChanged: true, dragging: false, editing: false }) === true &&
      M.shouldSyncSlider({ revChanged: true, dragging: true, editing: false }) === false &&
      M.shouldSyncSlider({ revChanged: true, dragging: false, editing: true }) === false,
    "rev+idle→写; 拖动中→不写; 编辑中→不写",
  );
  check(
    "滑条三态文案",
    M.sliderModeOf(false, true) === "board" &&
      M.sliderBadgeText("board") === "板端可调(SET_PARAM)" &&
      M.sliderBadgeText("host") === "上位机可调" &&
      M.sliderBadgeText("readonly") === "只读",
    "board→板端可调(SET_PARAM)",
  );
  const bad = M.boardParamAckText({ ok: false, status: 2, detail: "BAD_VALUE", theta: null, minDl: null, atMs: 1 });
  check("SET_PARAM 错误码就地回显（带 status）", bad.includes("status=2") && bad.includes("BAD_VALUE"), bad);
}

// ---------------- 2) 真实板端 ACK（幂等写回当前 θ） ----------------
function rpc(method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => finish({ timeout: true, error: "RPC 超时 " + timeoutMs + " ms" }), timeoutMs);
    function finish(v) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(v);
    }
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onerror = () => finish({ timeout: false, error: "WS 连接失败：" + WS_URL });
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let obj;
      try {
        obj = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (obj === null || typeof obj !== "object" || obj.id !== 1) return;
      finish(obj);
    };
  });
}

try {
  const snap = await rpc("session.snapshot", {});
  const v3 = snap?.result?.v3 ?? null;
  const theta = typeof v3?.theta === "number" ? v3.theta : null;
  const minDl = typeof v3?.minDl === "number" ? v3.minDl : null;
  check("能读到板端当前 θ（网关在线、v3 已同步）", theta !== null, JSON.stringify({ ws: WS_URL, theta, minDl }));
  if (theta === null) throw new Error("读不到板端 θ，无法做幂等 ACK 验收");

  const t0 = Date.now();
  const res = await rpc("board.setParam", { theta }, RPC_TIMEOUT_MS);
  const dt = Date.now() - t0;
  const r = res?.result;
  const ok = r?.ok === true && typeof r?.tlvs?.theta === "number" && r.tlvs.theta === theta;
  check(
    "board.setParam 写回同值后板端 ACK ok=true 且 tlvs.theta=" + theta,
    ok,
    JSON.stringify({ ok: r?.ok, status: r?.status, tlvs: r?.tlvs, detail: r?.detail ?? res?.error ?? null, dtMs: dt }),
  );
  check("SET_PARAM RPC 往返 < 8000 ms", dt < RPC_TIMEOUT_MS, dt + " ms");
} catch (e) {
  check("真实板端 ACK 验收", false, String(e && e.message ? e.message : e));
}

if (fails.length === 0) {
  console.log("SLIDER_OK=1");
  process.exit(0);
}
console.log("SLIDER_OK=0");
process.exit(1);

// task-6（2026-10-31）串口 EV_ONLY 模式 /api/action 的三态回归：
//   ① 无完整帧 + 有动作快照 ⇒ 200 available:true（串口 GET_STATUS ACK 的 TLV 0x92 已经写了快照，
//      不能因为"永远没有完整帧"就一律 503 —— 这是纯串口模式下动作面板看不到结果的真正原因）
//   ② 无完整帧 + 无快照 ⇒ 仍是 503，文案逐字不变（契约 §4.1 尾段）
//   ③ 有帧 + 有快照 ⇒ 与改动前逐字段一致（回归，且不得凭空多出 reason 字段）
//   ④（附加）有帧 + 无快照 ⇒ 200 available:false + 原 reason 不变（回归）
//
// 为什么用假 res + handleApi：API 层是纯函数，钉死状态码/字段不需要起真 socket；
// 真实 HTTP 端到端证据见报告 §C 的 curl 输出。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createCounters, decodeActionState, getProfile } from "@retina/protocol";
import type { Profile } from "@retina/protocol";
import { ActionStore } from "../src/action.ts";
import { handleApi, type ApiContext } from "../src/ipc/api.ts";
import { LatestStore } from "../src/pipeline/latest.ts";

const profile = getProfile("retina-v2-800x480-e5") as Profile;
const RAW = new Uint8Array(profile.frame.bytes);

/** 与生产装配同形的 ApiContext；store 由用例决定要不要塞帧 */
function makeCtx(action: ActionStore): { ctx: ApiContext; store: LatestStore } {
  const store = new LatestStore();
  const ctx: ApiContext = {
    store,
    profile,
    getStats: () => ({ packets: 0, bytes: 0, bytesRaw: 0, bytesEvents: 0, pps: 0, bps: 0, lastFrameIdx: 0, wraps: 0, tNowMs: 0 }),
    getCounters: createCounters,
    getConfig: () => ({}),
    startedAtMs: 1_000_000,
    sourceInfo: { wire: profile.wire, profile: profile.name },
    uiUrl: null,
    action,
  };
  return { ctx, store };
}

/** 串口 EV_ONLY 通道：只有事件帧与 CTRL ACK，LatestStore 永远是空的 */
function putFrame(store: LatestStore, frameIdx = 1): void {
  store.setFrame(
    {
      frameIdx,
      seq: frameIdx,
      w: profile.frame.w,
      h: profile.frame.h,
      raw: RAW,
      pixel: "RGB565_BE",
      events: { records: [], dropped: 0, thinned: false },
      tArriveMs: 1500,
      synthetic: false,
    },
    1500,
  );
}

interface ApiReply {
  readonly code: number;
  readonly body: string;
  readonly type: string;
}

function callApi(ctx: ApiContext, path: string): Promise<ApiReply> {
  return new Promise<ApiReply>((resolve) => {
    let code = 0;
    const headers: Record<string, string> = {};
    const res = {
      writeHead: (c: number, h?: Record<string, string | number>) => {
        code = c;
        if (h !== undefined) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
        return res;
      },
      setHeader: (k: string, v: unknown) => {
        headers[k.toLowerCase()] = String(v);
      },
      end: (b?: unknown) => {
        resolve({
          code,
          body: typeof b === "string" ? b : b instanceof Uint8Array ? Buffer.from(b).toString("utf8") : String(b ?? ""),
          type: headers["content-type"] ?? "",
        });
      },
    } as unknown as ServerResponse;
    const req = { method: "GET" } as IncomingMessage;
    const handled = handleApi(req, res, new URL("http://127.0.0.1" + path), ctx);
    assert.equal(handled, true, "已注册的 /api 路径必须被 handleApi 接住: " + path);
  });
}

async function getJson(ctx: ApiContext, path: string): Promise<{ code: number; j: Record<string, unknown> }> {
  const r = await callApi(ctx, path);
  assert.match(r.type, /application\/json; charset=utf-8/, "JSON 接口的 Content-Type 口径（契约 §4.0）: " + path);
  return { code: r.code, j: JSON.parse(r.body) as Record<string, unknown> };
}

test("C1 串口无完整帧 + 有快照 ⇒ 200 available:true（task-6 的核心修复）", async () => {
  const action = new ActionStore();
  const { ctx } = makeCtx(action);          // 注意：不 putFrame —— 串口 EV_ONLY 永远没有完整帧
  action.observe(0xa2, 777, 3000);          // 等价于 GET_STATUS ACK 里 TLV 0x92 = 0xa2 被 observe
  const st = decodeActionState(0xa2);

  const { code, j } = await getJson(ctx, "/api/action");
  assert.equal(code, 200, "有快照就不能再 503：串口面板要能看到动作");
  assert.equal(j["ok"], true);
  assert.equal(j["available"], true);
  assert.equal(j["frameIdx"], 777);
  assert.equal(j["tArriveMs"], 3000);
  assert.equal(j["raw"], 0xa2);
  assert.equal(j["valid"], st.valid);
  assert.equal(j["class"], st.cls);
  assert.equal(j["className"], "横向挥手");
  assert.equal(j["conf"], st.conf);
  assert.deepEqual(j["mapped"], { action: "stopRecord", target: "raw" });
  assert.equal(typeof j["ageMs"], "number");
  assert.ok((j["ageMs"] as number) >= 0);
  // 兼容镜像字段沿用现取值，语义不变
  assert.equal(j["seq"], 1);
  assert.equal(j["tMs"], 3000);
  assert.equal(j["source"], "default");
  assert.equal(j["count"], 1);
  // 无帧链路要说明数据来源（多给字段不改变契约语义）
  assert.equal(j["reason"], "串口事件-only 链路：无完整帧，动作快照来自 GET_STATUS TLV 0x92");
  assert.equal(typeof j["uptimeMs"], "number");
});

test("C2 串口无完整帧 + 无快照 ⇒ 仍是 503，文案逐字不变（不得把错误码改宽）", async () => {
  const action = new ActionStore();
  const { ctx } = makeCtx(action);
  const r = await callApi(ctx, "/api/action");
  assert.equal(r.code, 503);
  assert.match(r.body, /还没有收到任何完整帧（检查板子\/网口\/UDP 端口）/);
  const j = JSON.parse(r.body) as Record<string, unknown>;
  assert.equal(j["ok"], false);
  assert.equal(j["available"], false);
  assert.equal(j["reason"], undefined, "503 分支不该出现 reason（契约只要求 error）");
});

test("C3 有帧 + 有快照 ⇒ 与改动前逐字段一致，且不得多出 reason（回归）", async () => {
  const action = new ActionStore();
  const { ctx, store } = makeCtx(action);
  putFrame(store, 30);
  action.observe(0xa2, 30, 1500);
  const st = decodeActionState(0xa2);

  const { code, j } = await getJson(ctx, "/api/action");
  assert.equal(code, 200);
  assert.deepEqual(Object.keys(j).sort(), [
    "ageMs", "available", "class", "className", "conf", "count", "frameIdx",
    "mapped", "ok", "raw", "seq", "source", "tArriveMs", "tMs", "uiUrl", "uptimeMs", "valid",
  ], "字段集合必须与改动前完全一致（reason 只属于无帧链路）");
  assert.equal(j["available"], true);
  assert.equal(j["frameIdx"], 30);
  assert.equal(j["tArriveMs"], 1500);
  assert.equal(j["raw"], 0xa2);
  assert.equal(j["valid"], st.valid);
  assert.equal(j["class"], st.cls);
  assert.equal(j["conf"], st.conf);
  assert.equal(j["seq"], 1);
  assert.equal(j["tMs"], 1500);
  assert.equal(j["source"], "default");
  assert.equal(j["count"], 1);
  assert.equal(j["reason"], undefined);
});

test("C4 有帧 + 无快照 ⇒ 仍是 200 available:false + 原 reason（回归）", async () => {
  const action = new ActionStore();
  const { ctx, store } = makeCtx(action);
  putFrame(store, 12);
  const { code, j } = await getJson(ctx, "/api/action");
  assert.equal(code, 200);
  assert.equal(j["available"], false);
  assert.equal(j["reason"], "当前数据源不是 v3 实时帧（v2/回放/合成），没有动作字节");
  assert.equal(j["frameIdx"], 12);
  assert.equal(j["raw"], null);
  assert.equal(j["tMs"], null);
  assert.equal(j["seq"], 0);
  assert.equal(j["count"], 0);
});

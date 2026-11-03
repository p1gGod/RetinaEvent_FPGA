// 长录 HTTP 接口（task-30 / REC_API_OK）：只有 POST /rec/start、POST /rec/stop、GET /rec/status。
// 写在 ipc 的 405 闸门之前（http.ts 负责分派），所以 POST 不会被静态层的"只支持 GET/HEAD"挡掉。
import type http from "node:http";
import { RecorderBusyError, type Recorder, type RecorderStatus } from "./recorder.ts";

const MAX_BODY = 64 * 1024;

type BodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: number; readonly error: string };

function sendJson(res: http.ServerResponse, code: number, body: unknown, extra?: Record<string, string>): void {
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(buf.length),
    "Cache-Control": "no-store",
    ...(extra ?? {}),
  });
  res.end(buf);
}

function fail(res: http.ServerResponse, code: number, error: string, extra?: Record<string, string>): void {
  sendJson(res, code, { ok: false, error }, extra);
}

function readBody(req: http.IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (r: BodyResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        finish({ ok: false, status: 413, error: "请求体过大（上限 64 KB）" });
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") {
        finish({ ok: true, value: {} });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(text) as unknown });
      } catch (err) {
        finish({ ok: false, status: 400, error: "请求体不是合法 JSON: " + (err instanceof Error ? err.message : String(err)) });
      }
    });
    req.on("error", (err: Error) => {
      finish({ ok: false, status: 400, error: "读取请求体失败: " + err.message });
    });
  });
}

interface StartBody {
  readonly label?: string;
}

function parseStartBody(value: unknown): { readonly ok: true; readonly body: StartBody } | { readonly ok: false; readonly error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "请求体必须是 JSON 对象（可省略，或 {\"label\":\"rec\"}）" };
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "label") return { ok: false, error: "未知字段: " + key };
  }
  if (obj["label"] !== undefined) {
    const label = obj["label"];
    if (typeof label !== "string") return { ok: false, error: "label 必须是字符串" };
    const trimmed = label.trim();
    if (trimmed.length === 0 || trimmed.length > 64) return { ok: false, error: "label 长度必须在 1..64" };
    if (/[\\/:*?"<>|\u0000-\u001f]/.test(trimmed)) return { ok: false, error: "label 不能包含路径/文件名非法字符" };
    return { ok: true, body: { label: trimmed } };
  }
  return { ok: true, body: {} };
}

function allow(res: http.ServerResponse, methods: readonly string[]): void {
  fail(res, 405, "不支持的请求方法，仅支持 " + methods.join(" / "), { Allow: methods.join(", ") });
}

/**
 * /rec* 分派。返回 true 表示已处理（http.ts 据此不再落到静态文件）。
 * 注意：这里**不**新增写接口之外的任何能力，status 也只读。
 */
export function handleRec(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  recorder: Recorder,
): boolean {
  const pathname = url.pathname;
  if (pathname !== "/rec" && !pathname.startsWith("/rec/")) return false;
  const method = (req.method ?? "GET").toUpperCase();

  if (pathname === "/rec/status") {
    if (method !== "GET" && method !== "HEAD") {
      allow(res, ["GET", "HEAD"]);
      return true;
    }
    const status: RecorderStatus = recorder.status();
    sendJson(res, 200, { ok: true, ...status });
    return true;
  }
  if (pathname === "/rec/start") {
    if (method !== "POST") {
      allow(res, ["POST"]);
      return true;
    }
    void (async () => {
      const body = await readBody(req);
      if (!body.ok) {
        fail(res, body.status, body.error);
        return;
      }
      const parsed = parseStartBody(body.value);
      if (!parsed.ok) {
        fail(res, 400, parsed.error);
        return;
      }
      try {
        const status = await recorder.start(parsed.body.label);
        sendJson(res, 200, { ok: true, ...status });
      } catch (err) {
        if (err instanceof RecorderBusyError) {
          fail(res, 409, err.message);
          return;
        }
        fail(res, 500, "开始录制失败: " + (err instanceof Error ? err.message : String(err)));
      }
    })();
    return true;
  }
  if (pathname === "/rec/stop") {
    if (method !== "POST") {
      allow(res, ["POST"]);
      return true;
    }
    void (async () => {
      try {
        const status = await recorder.stop("api");
        sendJson(res, 200, { ok: true, ...status });
      } catch (err) {
        fail(res, 500, "停止录制失败: " + (err instanceof Error ? err.message : String(err)));
      }
    })();
    return true;
  }
  fail(res, 404, "未知的 /rec 接口: " + pathname);
  return true;
}

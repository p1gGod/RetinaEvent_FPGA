// 静态界面服务（网关兼任）：让用户"双击一个文件、打开一个网址"就能用。
// 为什么放在网关而不是另起 vite：① 一个进程 = 一个网址 = 一个要关的窗口（面向非开发者）
// ② 浏览器与 WS 同源，不用配 CORS/代理 ③ 将来打包成单 exe 时，exe 本身就是"后端 + 界面"（见 host/docs/04 §11）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export interface WebServerOptions {
  /** 界面根目录（web/dist） */
  readonly root: string;
  /**
   * /api/* 的处理器（见 ipc/api.ts）。返回 true 表示已处理。
   * 单独抽出来是因为它服务的是"别的进程来拉数据"，与"给浏览器送界面"是两类消费者：
   * 前者要的是机器可读的图与数（且必须只读），后者要的是静态文件。
   */
  readonly api?: ((req: http.IncomingMessage, res: http.ServerResponse, url: URL) => boolean) | undefined;
  /**
   * /rec* 长录接口（只读写接口之外的启动/停止/状态；task-30）。
   * 放在 method 检查之前：POST /rec/start 不能被静态层的 405 挡掉。
   */
  readonly rec?: ((req: http.IncomingMessage, res: http.ServerResponse, url: URL) => boolean) | undefined;
  readonly log?: (msg: string) => void;
}

/** 未构建界面时的提示页：不要只给 404，要让用户知道"下一步做什么" */
function hintPage(root: string): string {
  return [
    "<!doctype html><html lang=zh-CN><meta charset=utf-8>",
    "<title>界面还没构建</title>",
    "<body style='font-family:Microsoft YaHei,sans-serif;background:#0d1220;color:#e7eefa;padding:40px;line-height:1.8'>",
    "<h1>界面还没构建</h1>",
    "<p>后端已经在跑，但没找到构建好的前端目录：</p>",
    "<pre style='background:#111827;padding:12px;border-radius:8px'>" + root + "</pre>",
    "<p>请回到 <b>host/app</b> 目录执行：</p>",
    "<pre style='background:#111827;padding:12px;border-radius:8px'>npm run build --workspace web</pre>",
    "<p>或者直接双击 <b>一键启动.bat</b>（它会自动构建）。</p>",
    "<p>协议接口仍然可用：<code>ws://" + "127.0.0.1" + "/</code>（WebSocket）与 <code>/healthz</code>（健康检查）。</p>",
    "</body></html>",
  ].join("");
}

function send(res: http.ServerResponse, code: number, type: string, body: Buffer | string): void {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  res.writeHead(code, { "Content-Type": type, "Content-Length": String(buf.length), "Cache-Control": "no-store" });
  res.end(buf);
}

export function createWebServer(opts: WebServerOptions): http.Server {
  const root = path.resolve(opts.root);
  const log = opts.log ?? (() => {});
  const exists = fs.existsSync(path.join(root, "index.html"));
  if (!exists) log("界面目录里没有 index.html：" + root + "（浏览器会看到构建提示页）");

  return http.createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    const pathname = decodeURIComponent(url.split("?")[0] ?? "/");
    // /api/* 优先交给数据接口（只读、机器可读）。它处理不了才落到静态文件。
    // 为什么放在 method 检查之前：非 GET/HEAD 的 /api 请求要由 api.ts 回契约 §4.0 的
    // "本接口只读：仅支持 GET/HEAD"，而不是静态层的通用 "只支持 GET/HEAD"（两者都是 405）。
    if (opts.api !== undefined && (pathname === "/api" || pathname.startsWith("/api/"))) {
      try {
        if (opts.api(req, res, new URL(url, "http://localhost"))) return;
      } catch (err) {
        send(res, 500, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        return;
      }
    }
    // 长录接口同样先于通用 method 检查：POST /rec/start 是合法的写操作，
    // 不能落到静态层的 "只支持 GET/HEAD"。rec 自己负责 404/405/400。
    if (opts.rec !== undefined && (pathname === "/rec" || pathname.startsWith("/rec/"))) {
      try {
        if (opts.rec(req, res, new URL(url, "http://localhost"))) return;
      } catch (err) {
        send(res, 500, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        return;
      }
    }
    if (method !== "GET" && method !== "HEAD") {
      send(res, 405, "text/plain; charset=utf-8", "只支持 GET/HEAD");
      return;
    }
    if (pathname === "/healthz") {
      send(res, 200, MIME[".json"] as string, JSON.stringify({ ok: true, service: "retina-host-gateway", root }));
      return;
    }
    // 路径穿越防护：解析后必须仍在 root 之内
    const target = path.resolve(root, "." + pathname);
    if (target !== root && !target.startsWith(root + path.sep)) {
      send(res, 403, "text/plain; charset=utf-8", "非法路径");
      return;
    }
    let file = target;
    try {
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
      if (!fs.existsSync(file) && pathname !== "/" && !path.extname(pathname)) file = path.join(root, "index.html"); // SPA 兜底
      if (!fs.existsSync(file)) {
        if (!exists) { send(res, 200, MIME[".html"] as string, hintPage(root)); return; }
        send(res, 404, "text/plain; charset=utf-8", "找不到: " + pathname);
        return;
      }
      const body = fs.readFileSync(file);
      send(res, 200, MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", body);
    } catch (err) {
      send(res, 500, "text/plain; charset=utf-8", "读文件失败: " + (err instanceof Error ? err.message : String(err)));
    }
  });
}

/** 监听并返回真实端口（port=0 时由系统分配） */
export function listenWebServer(server: http.Server, host: string, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", (err) => reject(err));
    server.listen(port, host, () => {
      const addr = server.address();
      resolve(addr !== null && typeof addr === "object" ? addr.port : port);
    });
  });
}

/** 端口是否空闲（启动器用它挑一个可用端口） */
export function portFree(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const s = http.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

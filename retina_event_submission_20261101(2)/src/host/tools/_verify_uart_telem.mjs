// T2 真实串口遥测验收（task-5）：
//   直接打开 COM6 @115200 8N1 读 3000 ms（**读完必须 close**），把原始字节喂给修好后的 SerialDeframer，
//   打印 TELEM_VERIFY 统计。判据：telemFrames>=8 且 telemCrcFail=0 且 v3Frames>=2。
// 打开失败（用户串口面板占用 COM6）时每 2 s 重试，最多 3 次；仍失败则打印 PORT_BUSY 原样原因并以 3 退出
// —— 这是端口占用，不是 CRC 判据失败。
//
// 用法：cd host/app && node --experimental-strip-types tools/_verify_uart_telem.mjs [COM6] [ms]
import { SerialPort } from "serialport";
import { SerialDeframer } from "../gateway/src/pipeline/serial_deframer.ts";

const PATH = process.argv[2] || "COM6";
const DURATION = Number(process.argv[3] || 3000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const openOnce = () => new Promise((resolve, reject) => {
  const p = new SerialPort({ path: PATH, baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", autoOpen: false });
  const t = setTimeout(() => { try { p.destroy(); } catch {} reject(new Error("open timeout 4000 ms")); }, 4000);
  p.open((e) => { clearTimeout(t); if (e) { try { p.destroy(); } catch {} reject(e); } else resolve(p); });
});

let port = null;
let lastErr = null;
for (let i = 0; i < 3 && !port; i++) {
  try { port = await openOnce(); }
  catch (e) { lastErr = e; console.log("PORT_BUSY attempt=" + (i + 1) + " path=" + PATH + " err=" + (e && e.message ? e.message : String(e))); if (i < 2) await sleep(2000); }
}
if (!port) {
  console.log("TELEM_VERIFY_PORT_FAIL=1 path=" + PATH + " cause=" + (lastErr && lastErr.message ? lastErr.message : String(lastErr)));
  process.exit(3);
}

let telemCount = 0;
const telemFirst = [];
let v3Count = 0;
let lastTelem = null;
const lines = [];
const d = new SerialDeframer({
  onTelem: (t) => { telemCount++; lastTelem = t; if (telemFirst.length < 3) telemFirst.push({ frameCnt: t.frameCnt, evPerFrame: t.evPerFrame, mode: t.mode, cr: t.cr, protoVer: t.protoVer }); },
  onV3Frame: () => { v3Count++; },
  onText: (s) => { if (lines.length < 3) lines.push(s); },
});

const t0 = Date.now();
port.on("data", (b) => d.push(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), Date.now()));
await new Promise((resolve) => setTimeout(resolve, DURATION));
port.removeAllListeners("data");
const ms = Date.now() - t0;
await new Promise((resolve) => port.close(() => resolve()));
d.flush();
const s = d.stats;
console.log("TELEM_VERIFY telemFrames=" + s.telemFrames + " telemCrcFail=" + s.telemCrcFail + " v3Frames=" + s.v3Frames + " v3CrcFail=" + s.v3CrcFail + " textLines=" + s.textLines + " bytes=" + s.bytes);
console.log("TELEM_VERIFY_MORE resyncs=" + s.resyncs + " bytesDropped=" + s.bytesDropped + " badLen=" + s.badLen + " downlinkEcho=" + s.downlinkEcho + " ms=" + ms + " first3=" + JSON.stringify(telemFirst) + " asciiFirst=" + JSON.stringify(lines));
const ok = s.telemFrames >= 8 && s.telemCrcFail === 0 && s.v3Frames >= 2;
console.log("UART_TELEM_LIVE_OK=" + (ok ? 1 : 0));
process.exit(ok ? 0 : 1);

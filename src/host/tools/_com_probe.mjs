import { SerialPort } from "serialport";
const path = process.argv[2] || "COM6";
const ports = await SerialPort.list();
console.log("[list]", JSON.stringify(ports.map(p => ({path:p.path, mfr:p.manufacturer, vid:p.vendorId, pid:p.productId, sn:p.serialNumber}))));
const p = new SerialPort({ path, baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none" }, (e) => { if (e) { console.log("[open-err]", e.message); process.exit(3); } });
console.log("[open] ok " + path);
let n = 0; const bufs = [];
let firstAt = 0;
p.on("data", (b) => { if (n === 0) firstAt = Date.now(); n += b.length; if (bufs.length < 40) bufs.push(Buffer.from(b)); });
const t0 = Date.now();
setTimeout(() => {
  const buf = Buffer.concat(bufs);
  console.log("[rx] bytes=" + n + " in " + (Date.now() - t0) + " ms, chunks=" + bufs.length + ", firstAt=" + (firstAt ? firstAt - t0 : -1) + " ms");
  console.log("[hex]", buf.subarray(0, 200).toString("hex").replace(/(..)/g, "$1 "));
  // 找 AA 55 54 4D（遥测帧）与 F0 5A A5（v3 上行）
  const all = Buffer.concat(bufs);
  const tele = []; const v3 = [];
  for (let i = 0; i + 4 <= all.length; i++) {
    if (all[i] === 0xAA && all[i+1] === 0x55 && all[i+2] === 0x54 && all[i+3] === 0x4D) tele.push(i);
    if (all[i] === 0xF0 && all[i+1] === 0x5A && all[i+2] === 0xA5) v3.push(i);
  }
  console.log("[marks] TELEM(AA554D)=" + tele.length + " V3(F05AA5)=" + v3.length + " offsets=" + JSON.stringify(tele.slice(0,5)) + JSON.stringify(v3.slice(0,5)));
  console.log("[ascii]", all.subarray(0, 400).toString("latin1").replace(/[^\x20-\x7e]/g, "."));
  p.close(() => process.exit(0));
}, 3500);

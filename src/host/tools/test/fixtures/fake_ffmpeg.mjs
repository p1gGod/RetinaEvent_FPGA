#!/usr/bin/env node
// 假 ffmpeg（task-30 单测用）：不依赖系统 ffmpeg，只验证"喂进来的字节数/帧数"和命令形态。
//
// 编码模式（含 -f rawvideo）：读 stdin 累计字节，结束时写一个非空占位 MP4 与 sidecar JSON；
// 转封装模式（seal，含 -i）：把输入文件复制到输出文件（模拟 -c copy），成功退出 0。
//
// 环境变量：
//   FAKE_FFMPEG_FAIL_ALWAYS=1   每次启动都 exit 2（测"二次失败停录"）
//   FAKE_FFMPEG_FAIL_ONCE=<file> 若该文件存在则删除它并 exit 2（测"异常后重开一次"）
import fs from "node:fs";

const args = process.argv.slice(2);
const isEncode = args.includes("-f") && args.includes("rawvideo");
const out = args[args.length - 1];
if (typeof out !== "string" || out.length === 0) {
  console.error("fake_ffmpeg: 缺少输出路径");
  process.exit(64);
}

const failAlways = process.env.FAKE_FFMPEG_FAIL_ALWAYS === "1";
const failOnce = process.env.FAKE_FFMPEG_FAIL_ONCE;
if (failAlways || (failOnce !== undefined && failOnce !== "" && fs.existsSync(failOnce))) {
  if (failOnce !== undefined && failOnce !== "") {
    try { fs.rmSync(failOnce, { force: true }); } catch { /* 忽略 */ }
  }
  console.error("fake_ffmpeg: 注入的异常退出");
  process.exit(2);
}

if (!isEncode) {
  // seal：-i <frag> ... <video>；复制而不是真转封装
  const i = args.indexOf("-i");
  const src = i >= 0 ? args[i + 1] : undefined;
  if (typeof src !== "string") {
    console.error("fake_ffmpeg: seal 缺少 -i 输入");
    process.exit(65);
  }
  fs.copyFileSync(src, out);
  process.exit(0);
}

let bytes = 0;
process.stdin.on("data", (c) => { bytes += c.length; });
process.stdin.on("end", () => {
  // 非空占位：让 seal 有东西可复制；真 ffmpeg 集成测试走 record_integration。
  fs.writeFileSync(out, Buffer.alloc(32, 0x55));
  fs.writeFileSync(out + ".fake.json", JSON.stringify({ bytes, frames: bytes / 768000 }) + "\n");
  process.exit(0);
});

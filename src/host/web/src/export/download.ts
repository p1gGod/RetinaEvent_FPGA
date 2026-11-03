// 浏览器下载助手：把内存里的字节变成用户真能拿到的文件。
//
// 为什么要有这一层：在浏览器里"导出"只有一个合法出口 —— 造一个 <a download> 点它。
// 这个动作有 4 个容易忘的细节，散在各处写就会漏：
//   ① objectURL 必须 revoke（不 revoke，导 200 帧的 zip 会一直占着内存，页面越用越沉）
//   ② revoke 不能紧接着 click（Safari/Chrome 有异步读取窗口，立刻 revoke 会下出 0 字节文件）
//   ③ 文件名要带时间戳（同名文件浏览器会自己加 (1)(2)，用户分不清哪份是哪次录的）
//   ④ 空白字符/冒号不能进文件名（Windows 直接拒绝，且失败是静默的）
// 所以统一从这里走。

/** 文件名里不能出现的字符（Windows 最严格，冒号/斜杠/管道全禁） */
const BAD_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 生成 `前缀-20261006-214533.扩展名`（本地时间，秒级足够区分两次导出） */
export function timestampedName(prefix: string, ext: string, at: Date = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  const stamp =
    String(at.getFullYear()) + p(at.getMonth() + 1) + p(at.getDate()) + "-" +
    p(at.getHours()) + p(at.getMinutes()) + p(at.getSeconds());
  const safePrefix = prefix.replace(BAD_NAME_CHARS, "_");
  const safeExt = ext.replace(/^\./, "").replace(BAD_NAME_CHARS, "_");
  return safePrefix + "-" + stamp + (safeExt === "" ? "" : "." + safeExt);
}

/** 触发一次下载。blob 的所有权交给本函数（会负责 revoke） */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  // 延迟 revoke：立刻 revoke 会让下载拿到 0 字节（尤其是几十 MB 的 zip）
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * 保存字节。
 *
 * ⚠️ 必须 `new Blob([bytes])` 时给一份**新的视图**：`bytes` 若是一个大 ArrayBuffer 的
 * subarray，Blob 会按视图长度取（这是对的），但若上游之后复用了那块 buffer，文件内容会变。
 * 这里的调用方都是就地生成的一次性字节，所以直接包；有复用场景请自己先 slice。
 */
export function saveBytes(bytes: Uint8Array, filename: string, mime: string): void {
  saveBlob(new Blob([bytes as unknown as BlobPart], { type: mime }), filename);
}

export function saveText(text: string, filename: string, mime = "text/plain;charset=utf-8"): void {
  saveBlob(new Blob([text], { type: mime }), filename);
}

/** 人看的字节数（导出结果提示里要用，别显示 12345678 B） */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

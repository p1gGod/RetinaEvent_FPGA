// ZIP 打包（STORE，不压缩）：把一批文件装进"用户双击就能打开"的单个文件。
//
// 为什么 method 恒为 0（STORE）：
//   进这个容器的数据是 PNG/JPEG（本身已经是 deflate 过的）和 .bin 原始像素。
//   对已压缩数据再跑一遍 deflate，CPU 白花，省下的通常只有几十字节，
//   而导出跑在浏览器唯一的渲染主线程上，压缩时间直接等于"页面卡住多久"。
//   所以这里只做搬运，不做压缩。
//
// 为什么要自己写而不是 `zip -r`：导出必须发生在浏览器里（数据从没离开过页面），
//   而 ZIP 的结构简单到足以在几百行内写对：LFH* + CD + EOCD，字段全小端。
//
// 两个容易踩的坑（都在下面固化了）：
//   ① 中文文件名必须置 general purpose bit flag 的 bit 11（0x0800，UTF-8 名字），
//      否则 Windows 资源管理器/Expand-Archive 按 CP437 解释，名字变乱码甚至报错；
//   ② 中央目录里的 relative offset 指的是**LFH 起始（含签名）**的绝对偏移，
//      不是数据起点 —— 写成数据起点的话 7-Zip/Python zipfile 都还能忍，
//      但 Windows 自带解压会报"压缩文件损坏"。

/** ZIP 单条目：名字（可含中文）+ 原始字节（STORE，逐字节写入） */
export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

const LFH_SIG = 0x04034b50;
const CDH_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/** 2.0：STORE + 我们写出的目录结构所需的最低解压版本 */
const VERSION_NEEDED = 20;
/** version made by：高字节 0 = MS-DOS/FAT，低字节 20（Windows 资源管理器对这两个字段最宽容） */
const VERSION_MADE_BY = (0 << 8) | VERSION_NEEDED;
/** bit 11：文件名按 UTF-8 编码 */
const FLAG_UTF8 = 0x0800;
/** STORE */
const METHOD_STORE = 0;

// DOS 时间戳固定成 1980-01-01 00:00（DOS 时间的最小合法值）：
// 同样的输入永远产出同样的字节，便于"同一批帧导出的 zip 应当一致"这类对拍，
// 也避免测试因为跨秒运行而抖动。时间信息在导出文件名里（见 download.ts）。
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;

const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

/** CRC-32 查表（多项式 0xEDB88320，即反射后的 0x04C11DB7）。首次调用时建表并缓存 */
let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable !== null) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

/**
 * 标准 ZIP CRC-32：初值/终值都取反，返回**无符号** 32 位。
 *
 * 无符号这一点是必须的：`^` 在 JS 里产出有符号 32 位，负数写进
 * `setUint32` 虽然也能落成正确字节，但调用方拿去做比较就会莫名其妙地不相等。
 * 标准校验值：crc32("123456789") === 0xCBF43926（见单测）。
 */
export function crc32(bytes: Uint8Array): number {
  const t = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    const idx = (c ^ b) & 0xff;
    c = ((t[idx] ?? 0) ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 取数组元素；`noUncheckedIndexedAccess` 下下标越界是 undefined，这里当成内部错误炸掉 */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error("内部错误：ZIP 组装时下标越界（这不是用户输入能触发的路径）");
  return v;
}

/**
 * 组装一个 STORE 模式的 ZIP。
 *
 * 布局：`LFH(30+名) + 数据` × N → `CDH(46+名)` × N → `EOCD(22)`。
 * 先算总长、一次分配、顺序写：ZIP 里的偏移全是自描述的，
 * 分块拼装（先写数据再回头填偏移）是这类代码最经典的 off-by-N 来源。
 */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > MAX_U16) {
    throw new Error(`ZIP 条目过多（${entries.length} > ${MAX_U16}）：需要 ZIP64，本容器不支持`);
  }
  const enc = new TextEncoder();
  const names: Uint8Array[] = [];
  const datas: Uint8Array[] = [];
  const crcs: number[] = [];
  for (const e of entries) {
    const name = enc.encode(e.name);
    if (name.length > MAX_U16) {
      throw new Error(`ZIP 条目名过长（UTF-8 ${name.length} 字节 > ${MAX_U16}）：${e.name}`);
    }
    if (e.data.length > MAX_U32) {
      throw new Error(`ZIP 条目过大（${e.data.length} 字节 > ${MAX_U32}）：${e.name}`);
    }
    names.push(name);
    datas.push(e.data);
    crcs.push(crc32(e.data));
  }

  let localSize = 0;
  let centralSize = 0;
  for (let i = 0; i < datas.length; i++) {
    const nameLen = at(names, i).length;
    localSize += 30 + nameLen + at(datas, i).length;
    centralSize += 46 + nameLen;
  }
  const total = localSize + centralSize + 22; // 22 = EOCD 固定长度
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let p = 0;

  // —— Local File Header + 数据 ——
  const localOffsets: number[] = [];
  for (let i = 0; i < datas.length; i++) {
    const name = at(names, i);
    const data = at(datas, i);
    const crc = at(crcs, i);
    localOffsets.push(p); // 中央目录里的偏移 = LFH 起始（含签名），必须在写之前记
    view.setUint32(p, LFH_SIG, true);
    p += 4;
    view.setUint16(p, VERSION_NEEDED, true);
    p += 2;
    view.setUint16(p, FLAG_UTF8, true);
    p += 2;
    view.setUint16(p, METHOD_STORE, true);
    p += 2;
    view.setUint16(p, DOS_TIME, true);
    p += 2;
    view.setUint16(p, DOS_DATE, true);
    p += 2;
    view.setUint32(p, crc, true);
    p += 4;
    view.setUint32(p, data.length, true); // STORE：压缩后 == 压缩前
    p += 4;
    view.setUint32(p, data.length, true);
    p += 4;
    view.setUint16(p, name.length, true);
    p += 2;
    view.setUint16(p, 0, true); // extra field 长度：留 0，扩展字段只会让老解压器困惑
    p += 2;
    out.set(name, p);
    p += name.length;
    out.set(data, p);
    p += data.length;
  }

  // —— Central Directory ——
  const cdStart = p;
  for (let i = 0; i < datas.length; i++) {
    const name = at(names, i);
    const data = at(datas, i);
    view.setUint32(p, CDH_SIG, true);
    p += 4;
    view.setUint16(p, VERSION_MADE_BY, true);
    p += 2;
    view.setUint16(p, VERSION_NEEDED, true);
    p += 2;
    view.setUint16(p, FLAG_UTF8, true);
    p += 2;
    view.setUint16(p, METHOD_STORE, true);
    p += 2;
    view.setUint16(p, DOS_TIME, true);
    p += 2;
    view.setUint16(p, DOS_DATE, true);
    p += 2;
    view.setUint32(p, at(crcs, i), true);
    p += 4;
    view.setUint32(p, data.length, true);
    p += 4;
    view.setUint32(p, data.length, true);
    p += 4;
    view.setUint16(p, name.length, true);
    p += 2;
    view.setUint16(p, 0, true); // extra
    p += 2;
    view.setUint16(p, 0, true); // comment
    p += 2;
    view.setUint16(p, 0, true); // 起始磁盘号（单卷恒 0）
    p += 2;
    view.setUint16(p, 0, true); // internal attrs
    p += 2;
    view.setUint32(p, 0, true); // external attrs：0 = 交给解压端按默认权限处理
    p += 4;
    view.setUint32(p, at(localOffsets, i), true);
    p += 4;
    out.set(name, p);
    p += name.length;
  }
  const cdSize = p - cdStart;

  // —— End Of Central Directory ——
  view.setUint32(p, EOCD_SIG, true);
  p += 4;
  view.setUint16(p, 0, true); // 本磁盘号
  p += 2;
  view.setUint16(p, 0, true); // 中央目录所在磁盘号（单卷 = 0）
  p += 2;
  view.setUint16(p, datas.length, true); // 本磁盘条目数
  p += 2;
  view.setUint16(p, datas.length, true); // 总条目数
  p += 2;
  view.setUint32(p, cdSize, true);
  p += 4;
  view.setUint32(p, cdStart, true);
  p += 4;
  view.setUint16(p, 0, true); // 注释长度 0（有注释的话 EOCD 签名就不在末尾了，倒查逻辑会退化）
  p += 2;

  if (p !== total) throw new Error(`内部错误：ZIP 长度预算 ${total} ≠ 实际写入 ${p}`);
  return out;
}

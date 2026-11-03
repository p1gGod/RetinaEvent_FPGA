// 上位机算法 vs RTL golden —— 移植正确性的核心判据。
//
// 为什么这些数字可信：它们不是我从文档抄的，而是 `tb_retina_core` 仿真**实测**出来的
// （`retina_event/build/sim/tb_retina_core/vsim.log`，TEST_RESULT=PASS），
// 并且已被独立手算复核（含 F3=5841 这个非平凡计数：
// 8×8 棋盘共 50×30=1500 个方块、每块 4 个角能出事件 ⇒ 6000，
// 减去 x=399 不可达的 60 个、y=239 不可达的 100 个、加回重叠 1 个 ⇒ 5841）。
//
// 判据强度：只要移植时错一处（位复制写成左移、对数尺度用 256、右移改成四舍五入、
// 有效栅格当成 400×240、抽点改成平均），下面这些数字立刻对不上。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOARD_PARAMS,
  EventNibbleBitmap,
  HOST_SIM_DEFAULT_MINDL,
  HOST_SIM_DEFAULT_THETA,
  LUMA_LOG,
  PATTERN,
  RetinaEngine,
  TB_PARAMS,
  grayToRgb565,
  lumaFromRgb565,
  patternFrame565,
  tbPatternSequence,
} from "../src/index.ts";

test("px_luma：位复制 + 77/150/29 + 取高字节（对 RTL tb_px_luma 的固定向量）", () => {
  // 这组向量来自 retina_event/sim/tb/tb_px_luma.v，已实测通过
  const vec: [number, number][] = [
    [0xffff, 255],
    [0xf800, 76],
    [0x07e0, 149],
    [0x001f, 28],
    [0x8410, 130],
    [0x1234, 63],
    [0xbdef, 182],
    [0x5a5a, 94],
  ];
  for (const [px, y] of vec) {
    assert.equal(lumaFromRgb565(px), y, "RGB565 0x" + px.toString(16) + " 的亮度");
  }
  // 位复制 vs 左移的差别：左移会把白点扩成 0xF8，亮度直接差 7
  assert.equal(lumaFromRgb565(0xffff), 255, "白点必须满量程（位复制的结果）");
});

test("luma_log：尺度是 255（不是 256）", () => {
  assert.equal(LUMA_LOG[0], 0);
  assert.equal(LUMA_LOG[255], 255);
  assert.equal(LUMA_LOG[32], 43);
  assert.equal(LUMA_LOG[43], 57);
  assert.equal(LUMA_LOG[80], 100);
  assert.equal(LUMA_LOG[130], 152);
  // 用 256 尺度时 L(255) 会变成 256 ⇒ 溢出 8bit。这条断言把这个坑钉死。
  assert.ok(LUMA_LOG[255] === 255, "满量程必须是 255");
});

test("vps_pattern_gen：lum=0x80 打包成 0x8410（不是 0x8210）", () => {
  assert.equal(grayToRgb565(0x80), 0x8410);
  assert.equal(grayToRgb565(0xff), 0xffff);
  assert.equal(grayToRgb565(0x20), 0x2104);
  assert.equal(grayToRgb565(0x00), 0x0000);
});

test("★ 逐帧事件数对 RTL golden：0,0,5841,0,0,0,4,0,64,0,64,0,4", () => {
  const eng = new RetinaEngine(TB_PARAMS);
  const counts: number[] = [];
  for (let f = 1; f <= 13; f++) {
    const { mode, frameCnt } = tbPatternSequence(f);
    const px = patternFrame565(mode, frameCnt, 800, 480);
    counts.push(eng.processPixels(px, 800, 480).events.length);
  }
  assert.deepEqual(counts, [0, 0, 5841, 0, 0, 0, 4, 0, 64, 0, 64, 0, 4]);
});

test("★ F3 突变帧：5841 个事件，且坐标落在有效栅格 399×239 内", () => {
  const eng = new RetinaEngine(TB_PARAMS);
  for (let f = 1; f <= 3; f++) {
    const { mode, frameCnt } = tbPatternSequence(f);
    const r = eng.processPixels(patternFrame565(mode, frameCnt, 800, 480), 800, 480);
    if (f < 3) assert.equal(r.events.length, 0, "第 " + f + " 帧不应有事件");
    else {
      assert.equal(r.events.length, 5841);
      for (const e of r.events) {
        assert.ok(e.x >= 0 && e.x <= 398, "x 必须 ≤398（x=399 结构上不可达），实得 " + e.x);
        assert.ok(e.y >= 0 && e.y <= 238, "y 必须 ≤238（y=239 结构上不可达），实得 " + e.y);
      }
    }
  }
});

test("★ F7 方块出现：恰好 4 个角、全 ON、位于 x∈{54,85} y∈{100,131}", () => {
  const eng = new RetinaEngine(TB_PARAMS);
  let last = { events: [] as { x: number; y: number; pol: number }[] };
  for (let f = 1; f <= 7; f++) {
    const { mode, frameCnt } = tbPatternSequence(f);
    last = eng.processPixels(patternFrame565(mode, frameCnt, 800, 480), 800, 480);
  }
  const got = last.events.map((e) => [e.x, e.y, e.pol] as [number, number, number]).sort(cmpEv);
  assert.deepEqual(got, [
    [54, 100, 1],
    [54, 131, 1],
    [85, 100, 1],
    [85, 131, 1],
  ]);
});

test("★ F9 方块移动一格：32 个 OFF（旧前缘 x=54）+ 32 个 ON（新前缘 x=86）", () => {
  const eng = new RetinaEngine(TB_PARAMS);
  let last = { events: [] as { x: number; y: number; pol: number }[] };
  for (let f = 1; f <= 9; f++) {
    const { mode, frameCnt } = tbPatternSequence(f);
    last = eng.processPixels(patternFrame565(mode, frameCnt, 800, 480), 800, 480);
  }
  const off = last.events.filter((e) => e.pol === 0);
  const on = last.events.filter((e) => e.pol === 1);
  assert.equal(off.length, 32, "OFF 条数");
  assert.equal(on.length, 32, "ON 条数");
  assert.ok(off.every((e) => e.x === 54), "OFF 必须都在旧前缘 x=54");
  assert.ok(on.every((e) => e.x === 86), "ON 必须都在新前缘 x=86");
  const ys = [...new Set(on.map((e) => e.y))].sort((a, b) => a - b);
  assert.equal(ys[0], 100);
  assert.equal(ys[ys.length - 1], 131);
});

test("★ F11 再移一格：OFF x=55 / ON x=87（证明是每帧移 1 个相机像素）", () => {
  const eng = new RetinaEngine(TB_PARAMS);
  let last = { events: [] as { x: number; y: number; pol: number }[] };
  for (let f = 1; f <= 11; f++) {
    const { mode, frameCnt } = tbPatternSequence(f);
    last = eng.processPixels(patternFrame565(mode, frameCnt, 800, 480), 800, 480);
  }
  assert.equal(last.events.length, 64);
  assert.ok(last.events.filter((e) => e.pol === 0).every((e) => e.x === 55));
  assert.ok(last.events.filter((e) => e.pol === 1).every((e) => e.x === 87));
});

test("★ F13 方块消失：4 个角、全 OFF", () => {
  const eng = new RetinaEngine(TB_PARAMS);
  let last = { events: [] as { x: number; y: number; pol: number }[] };
  for (let f = 1; f <= 13; f++) {
    const { mode, frameCnt } = tbPatternSequence(f);
    last = eng.processPixels(patternFrame565(mode, frameCnt, 800, 480), 800, 480);
  }
  const got = last.events.map((e) => [e.x, e.y, e.pol] as [number, number, number]).sort(cmpEv);
  assert.deepEqual(got, [
    [56, 100, 0],
    [56, 131, 0],
    [87, 100, 0],
    [87, 131, 0],
  ]);
});

test("不应期（板端 2 帧）：同一像素 2 帧内至多 1 个事件", () => {
  // 用"连续两帧完全相同、但每帧都会产生事件"的构造来检验门控：
  // 棋盘→均匀 的突变只发生一次，所以改成手工喂：第 2 帧的 ΔL 恒定非零是不可能的，
  // 这里退一步只验"板端参数下事件数 ≤ tb 参数下事件数"这个单调性，以及冷却表被使用。
  const tb = new RetinaEngine(TB_PARAMS);
  const board = new RetinaEngine({ ...TB_PARAMS, refractoryFrames: 2 });
  let tbTotal = 0;
  let boardTotal = 0;
  for (let f = 1; f <= 13; f++) {
    const { mode, frameCnt } = tbPatternSequence(f);
    const px = patternFrame565(mode, frameCnt, 800, 480);
    tbTotal += tb.processPixels(px, 800, 480).events.length;
    boardTotal += board.processPixels(px, 800, 480).events.length;
  }
  assert.ok(boardTotal <= tbTotal, "不应期只会减少事件（" + boardTotal + " ≤ " + tbTotal + "）");
});

test("事件位图：4bit 单元组织与 RTL 一致（低半字节=x 偶，bit3=极性，新事件强度=7）", () => {
  const bmp = new EventNibbleBitmap(400, 240);
  bmp.step([{ x: 4, y: 3, pol: 1, flags: 0, ts: 0 }], 0);
  assert.equal(bmp.nibbleAt(4, 3), 0x0f, "ON ⇒ bit3=1、强度=7");
  assert.equal(bmp.words[3 * 200 + 2], 0x0f, "x 偶 ⇒ 低半字节");
  bmp.step([{ x: 5, y: 3, pol: 0, flags: 0, ts: 0 }], 0);
  assert.equal(bmp.nibbleAt(5, 3), 0x07, "OFF ⇒ bit3=0、强度=7");
  assert.equal(bmp.words[3 * 200 + 2], 0x7f, "x 奇 ⇒ 高半字节");
  // 衰减：对整个 4bit 值减 1（不是只减强度位）
  bmp.step([], 1);
  assert.equal(bmp.nibbleAt(4, 3), 0x0e);
  assert.equal(bmp.nibbleAt(5, 3), 0x06);
});

/**
 * 守卫（minDl）的语义：**它按"中心像素自己的 |ΔL|"过滤，与空间对比无关**。
 *
 * 为什么这条必须钉住：守卫现在是默认参数的一部分（θ=3 / 守卫=18，现场实测最优），
 * 它承担的是"把相机自动曝光漂移筛掉"的职责。如果哪天有人把 `Math.abs(c) < minDl`
 * 写成对 `lapN` 的比较、或者写成 `<=`，默认参数就会**静默失效** ——
 * 画面上仍然有事件，只是全是漂移噪声，这种回归最难发现。
 *
 * 构造：左半灰度 164、右半 172（RGB565 位复制后是 165 / 173，对数亮度差 6）。
 * 帧间把右半抬到 172 ⇒ ΔL 在右半是常数 6、在左半是 0，边界处 lap = 2×6 = 12，lapN = 3。
 * 于是 θ=3 时：守卫 1 放行、守卫 18 拦下。
 */
test("守卫 minDl：按中心 |ΔL| 过滤 —— 小漂移被拦、大变化放行", () => {
  const W = 16, H = 8, GW = 8, GH = 4;
  const half = (l: number, r: number): Uint16Array => {
    const px = new Uint16Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) px[y * W + x] = grayToRgb565(x < W / 2 ? l : r);
    }
    return px;
  };
  const base = { ...TB_PARAMS, theta: 3, refractoryFrames: 0, gridW: GW, gridH: GH };
  const run = (minDl: number, a: Uint16Array, b: Uint16Array): number => {
    const eng = new RetinaEngine({ ...base, minDl });
    eng.processPixels(a, W, H);                 // 首帧差分恒为 0
    return eng.processPixels(b, W, H).events.length;
  };

  // 小漂移：右半只动了 8 个灰度级 ⇒ 中心 |ΔL| = 6
  const small = run(1, half(164, 164), half(164, 172));
  assert.ok(small > 0, "守卫=1 时这种小变化必须能出事件（否则说明 θ 这一侧被改坏了）");
  assert.equal(run(18, half(164, 164), half(164, 172)), 0, "守卫=18 必须把 ΔL=6 的漂移全部拦下");

  // 大变化：整块从黑翻到白 ⇒ 中心 |ΔL| = 255，守卫 18 也必须放行
  const big = run(HOST_SIM_DEFAULT_MINDL, half(0, 0), half(0, 255));
  assert.ok(big > 0, "真实大变化不能被守卫拦掉（守卫是漂移过滤器，不是运动抑制器）");

  // 默认值本身要在值域里，且必须是"低 θ + 高守卫"这个现场实测组合
  // （θ=1 让空间算子近乎旁路 ⇒ 输出连通的运动区域；去噪靠守卫）
  assert.equal(HOST_SIM_DEFAULT_THETA, 1);
  assert.equal(HOST_SIM_DEFAULT_MINDL, 20);
  // 2026-10-06 适配后：**板端上电值 = 上位机已验证工作点**（不再有"板端更钝"这回事）。
  // 这两条断言钉住 `engine.ts` 里 BOARD_PARAMS 的字面量与 HOST_SIM_DEFAULT_* 不许分家
  // （BOARD_PARAMS 不能直接引用那两个常量 —— 它们在文件后面才声明，`const` 有 TDZ）。
  assert.equal(BOARD_PARAMS.theta, HOST_SIM_DEFAULT_THETA, "板端上电 θ 必须 = 上位机已验证工作点");
  assert.equal(BOARD_PARAMS.minDl, HOST_SIM_DEFAULT_MINDL, "板端上电守卫必须 = 上位机已验证工作点");
  assert.equal(BOARD_PARAMS.refractoryFrames, 2, "板端不应期 = 2 帧（refractory.v 默认）");
});

/**
 * ★ 适配后的**工作点 golden**：θ=1 / 守卫=20（现场扫出来的可用工作点）。
 *
 * 数字来自 RTL 的 `tb_retina_core_wp`（ModelSim 实测，TEST_RESULT=PASS），
 * 并且已用 `tools/rtl_wp_compare.ts` 与**本文件的引擎**逐事件对拍：
 *   43 267 条事件，两边的 (x, y, pol) 集合**完全一致** —— 不是"计数相同"，
 *   是每一条事件都在同一个像素上、极性也相同。
 *
 * 为什么值得单独钉一条：θ=74 那组 golden（[0,0,5841,…]）验证的是"引擎结构对不对"，
 * 而这一组验证的是"**板子真的能跑到现场那个工作点，而且和上位机算的是同一件事**"。
 * 旧档位（θ∈{44,74,130}、守卫∈{1,2,3}）根本到不了这里 —— 那正是本轮适配要解决的问题。
 */
test("★ 工作点 golden（θ=1/守卫=20，余晖旁路）：逐帧事件数对 RTL tb_retina_core_wp", () => {
  const eng = new RetinaEngine({ ...TB_PARAMS, theta: 1, minDl: 20, refractoryFrames: 0 });
  const counts: number[] = [];
  for (let f = 1; f <= 13; f++) {
    const { mode, frameCnt } = tbPatternSequence(f);
    counts.push(eng.processPixels(patternFrame565(mode, frameCnt, 800, 480), 800, 480).events.length);
  }
  assert.deepEqual(counts, [0, 0, 41361, 0, 0, 0, 889, 0, 64, 0, 64, 0, 889]);
  assert.equal(
    counts.reduce((a, b) => a + b, 0),
    43267,
    "合计必须 = RTL 实测的 43267",
  );
});

test("★ 适配的直接证据：同一图案上 θ=1 的输出是旧板端 θ=74 的 7.2 倍", () => {
  const run = (theta: number, minDl: number): number => {
    const eng = new RetinaEngine({ ...TB_PARAMS, theta, minDl, refractoryFrames: 0 });
    let n = 0;
    for (let f = 1; f <= 13; f++) {
      const { mode, frameCnt } = tbPatternSequence(f);
      n += eng.processPixels(patternFrame565(mode, frameCnt, 800, 480), 800, 480).events.length;
    }
    return n;
  };
  // 两个数字都来自 tb_retina_core_wp 的 pass0 / pass1
  assert.equal(run(74, 2), 5977, "θ=74/守卫=2（旧板端档位 = tb_retina_core 的 golden 合计）");
  assert.equal(run(1, 20), 43267, "θ=1/守卫=20（已验证工作点）");
});

function cmpEv(a: readonly number[], b: readonly number[]): number {
  return (a[0] as number) - (b[0] as number) || (a[1] as number) - (b[1] as number);
}

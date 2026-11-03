// 录制侧的事件配对账本（2026-10-13：录制/CSV 的事件配对对齐 A5 口径）。
//
// 为什么需要它：协议把 FRAME_RAW 与 EVENTS 分成两条 IPC 消息发，而录制**必须在 FRAME_RAW
// 到达时就存下像素**（否则丢帧），所以事件只能"后补"进那一帧的录制记录。补法取决于到达序，
// 而 A5（2026-10-09 KEY3 撕裂修复）之后网关（板源/回放/网关合成源，`gateway/src/ipc/ws.ts`
// `encodeFrame()`）与页内合成源（`web/src/synth.ts` `oneTick()`）都保证：
//
//     EVENTS(N)  先到（属于第 N 帧的事件，可能一批或多批）
//     FRAME_RAW(N) 后到（同一帧号）
//
// 修前的旧口径是 `pendingEventsFor === m.frameIdx`（"事件必须晚于同帧 FRAME_RAW 到达"），
// 在 A5 序下**一条都配不上**：事件到达时占位帧号还是 N-1，等帧 N 到时占位数组早已空了。
// 后果是两条源（板源/回放 与 页内合成源）的录制帧 `events` 全空 —— CSV 只剩表头、
// 事件轴/PNG 序列/视频里的事件层全空。取证见
// `docs/05_实验与实测/录制配对修复_20261013/录制配对修复报告.md` §3/§5。
//
// 反过来，板端"解耦事件包"通路（`gateway/src/ipc/ws.ts`
// `pushEvents()`，事件包与帧包各自到达）仍可能让事件**晚于**帧到达 ⇒ 两种顺序都要支持。
// 于是本模块只做两件事，且**只按 frameIdx 配对**：
//   · attach(N)：帧 N 到达 → 交出该帧的事件账本（**数组引用**交给录制记录；Recorder.push 是浅拷贝，
//     保留了数组身份 —— 这是 recorder.ts 写明的契约，晚到的事件才能补进同一个数组）；
//   · add(N, recs)：事件到达 → 帧已录就补进**那一帧**的数组（不管它是第几新的帧）；帧还没到就按帧号攒着等 attach。
//
// 三条不许含糊的规则（都是"宁可丢、不许错"）：
//   1. **不跨帧**：帧 N 的账本只给帧 N；比"已经录过的最新帧号"更旧的事件直接计成 orphan
//      （那几帧已被网关按背压丢掉或本段没录到，再补就说不清属于哪一段）；
//   2. **有上限**：未配对的键与已配对的账本各最多 `MAX_KEYS` 个（与渲染侧 evQueue 同口径：
//      ≈ 8 帧 @3.25 fps ≈ 2.5 s），满了淘汰最旧的键；
//   3. **可清点**：配进录制帧的条数（pairedRecords）与被清掉的条数（orphanRecords）都计数 ——
//      静默丢事件会让"这段全录上了"变成一句没法核对的话（原则 P6）。
//
// 为什么单独一个文件：`main.ts` 是 DOM 入口（node:test 起不来），抽成纯数据模块才能把
// 配对语义钉成机器判据（与 frameTimeline.ts / export/times.ts 同一条理由）。
import type { EventRecord } from "@retina/protocol";

/** 配对账目（UI/取证用它说清"多少条配对上了、多少条错过"） */
export interface RecPairStats {
  /** 交出过账本的帧数（= 录制帧数，含本帧零事件的情况） */
  readonly attachedFrames: number;
  /** 最终落在录制帧里的条数（导出 CSV 的数据行数应当等于它） */
  readonly pairedRecords: number;
  /** 等不到自己的帧 / 属于更旧帧而被清掉的条数 */
  readonly orphanRecords: number;
  /** 仍攒着、还没等到帧的键数与条数 */
  readonly pendingKeys: number;
  readonly pendingRecords: number;
}

export class RecordEventPairing {
  /**
   * 未配对键的存活上限（≈ 8 帧 @3.25 fps ≈ 2.5 s），与渲染侧 `evQueue` 的
   * `EV_QUEUE_MAX_KEYS` 同口径：慢客户端/背压时网关丢 FRAME_RAW 但事件照推，
   * 那些事件永远等不到自己的帧，不能让它们无限占着内存。
   */
  static readonly MAX_KEYS = 8;

  /** 键 = frameIdx（插入序 = 事件到达序，淘汰队头即淘汰最旧的键） */
  private readonly pending = new Map<number, EventRecord[]>();
  /**
   * 已经交给录制帧的账本：键 = frameIdx，值 = 那个数组对象。
   *
   * 为什么要留着（而不是只记"最近一次"）：板端解耦事件包（`pushEvents()`）与帧包各自到达，
   * 事件可能晚到几帧 —— 晚到的事件必须补进**它自己那一帧**的数组，不能看"谁最近"就塞给谁。
   * 同样按 MAX_KEYS 淘汰最旧的键：被淘汰之后再来属于它的晚到事件就只剩 orphan 一条路
   * （那几帧早就录完/导出了，再补也进不去）。
   */
  private readonly attached = new Map<number, EventRecord[]>();
  /** 已经录过的最新帧号：比它还旧的事件键永远等不到 attach，直接计 orphan */
  private newestAttached: number | null = null;

  private attachedCount = 0;
  private paired = 0;
  private orphan = 0;

  /**
   * FRAME_RAW(frameIdx) 到达：返回该帧的事件账本，交给录制记录持有。
   *
   * 事件先到（A5 序）时账本里已经有那几批事件；事件晚到时返回空账本，等 `add()` 补进来。
   * 同一个 frameIdx 被二次 attach（网关断线补发最近一帧）会拿到一个**新的空账本**：
   * 同一批事件不会被重复计入 CSV。
   */
  attach(frameIdx: number): EventRecord[] {
    const pre = this.pending.get(frameIdx);
    if (pre !== undefined) {
      this.pending.delete(frameIdx);
      this.paired += pre.length;
    }
    // 比本帧更旧的键等不到自己的帧了（与渲染侧 handleFrame 的同名清理同口径）
    for (const k of [...this.pending.keys()]) {
      if (k < frameIdx) this.evictPending(k);
    }
    const arr = pre ?? [];
    if (this.newestAttached === null || frameIdx > this.newestAttached) this.newestAttached = frameIdx;
    this.attached.set(frameIdx, arr);
    while (this.attached.size > RecordEventPairing.MAX_KEYS) {
      const oldest = this.attached.keys().next();
      if (oldest.done === true) break;
      this.attached.delete(oldest.value);
    }
    this.attachedCount++;
    return arr;
  }

  /** EVENTS(frameIdx) 到达：帧已录下就补进**那一帧**的数组，否则按帧号攒着等帧 */
  add(frameIdx: number, records: readonly EventRecord[]): void {
    if (records.length === 0) return;
    const out = this.attached.get(frameIdx);
    if (out !== undefined) {
      for (const r of records) out.push(r);
      this.paired += records.length;
      return;
    }
    if (this.newestAttached !== null && frameIdx < this.newestAttached) {
      // 已经录过的更旧帧：这时候再补就晚了（宁可计成错过，也不写进别的帧）
      this.orphan += records.length;
      return;
    }
    const hit = this.pending.get(frameIdx);
    if (hit === undefined) this.pending.set(frameIdx, records.slice());
    else for (const r of records) hit.push(r);
    while (this.pending.size > RecordEventPairing.MAX_KEYS) {
      const oldest = this.pending.keys().next();
      if (oldest.done === true) break;
      this.evictPending(oldest.value);
    }
  }

  get stats(): RecPairStats {
    let pendingRecords = 0;
    for (const a of this.pending.values()) pendingRecords += a.length;
    return {
      attachedFrames: this.attachedCount,
      pairedRecords: this.paired,
      orphanRecords: this.orphan,
      pendingKeys: this.pending.size,
      pendingRecords,
    };
  }

  /**
   * 清空（换数据源 / 开始新一次录制）。
   *
   * **不清会怎样**（与 resetView 的既有理由同源）：上一段来源的事件留着，
   * 新一段第一帧同号时会配到一起，导出的事件就跨了两段来源 —— 事后没人能说清。
   */
  clear(): void {
    this.pending.clear();
    this.attached.clear();
    this.newestAttached = null;
    this.attachedCount = 0;
    this.paired = 0;
    this.orphan = 0;
  }

  private evictPending(key: number): void {
    const dropped = this.pending.get(key);
    this.pending.delete(key);
    this.orphan += dropped === undefined ? 0 : dropped.length;
  }
}

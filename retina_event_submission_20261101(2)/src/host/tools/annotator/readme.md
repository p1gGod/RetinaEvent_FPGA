# annotator —— M7c 轻量动作标注工具

给 FPGA 长录（`records/<session>/chunk-00N.*`）打动作片段标签的本地小工具。**零 npm 依赖**（只用 Node 内置模块 + 原生 JS/canvas/video），**不进 npm workspace 构建**，不改 `package.json`，不装任何东西。

- 左栏：视频画面
- 中栏：时间轴（100ms 事件密度柱 + 片段轨道，可缩放/平移/框选）
- 右栏：动作类型（可改名/改色/增删）+ 片段列表

标注写回 `chunk-00N.labels.json`（与录制工具同一份契约），可导出 `chunk-00N.segments.csv`。

## 启动

```bash
# 最省事：双击 打开标注.bat（Windows）
# 等价于在 host/app/tools/annotator/ 下运行：
node server.mjs
# 浏览器地址 http://127.0.0.1:8790
```

参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--root <dir>` | `E:\workspace\FPGA_Comp\records` | 会话根目录（下面一层是 `<session>/`） |
| `--port <n>` | `8790` | 监听端口；**只绑 127.0.0.1**；禁用 1234/8787（用户面板占用） |
| `--no-open` | 自动开浏览器 | 不自动打开浏览器 |
| `--help` | — | 用法 |

没有数据时不会白屏：页面显示空状态卡片，写明 `--root` 用法和期望的目录结构。

## 数据契约（与录制端一致，勿改字段）

```
<root>/<session>/
  meta.json
  chunk-000.video.mp4        # seal 之后才有；录制中是 chunk-000.recording.mp4
  chunk-000.events.csv
  chunk-000.frames.csv
  chunk-000.labels.json      # 本工具写
```

- `meta.json`：`{version,session,startedAt,endedAt,profile,fpsNominal,chunks:[{index,video,events,frames}],counters:{frames,events,droppedFrames,droppedEvents,bytes}}`（缺字段容忍）
- `events.csv`：`frame_idx,frame_t_ms,x,y,pol,pol_name,flags,ts`（CRLF，8 列；缺文件按空处理）
- `frames.csv`：`frame_idx,t_board_ms,t_arrive_ms`（CRLF；frame_idx 严格递增；时间轴以 `t_board_ms` 为准）
- `labels.json`（本工具产物）：

  | 字段 | 含义 |
  | --- | --- |
  | `version` | 固定 1 |
  | `session` / `chunk` / `fpsNominal` | 归属与标称帧率 |
  | `types[]` | `{id,name,color}`；`id=0` 固定「无动作」，不可删 |
  | `segments[]` | `{id,startMs,endMs,startFrame,endFrame,typeId,note}` |
  | `updatedAt` | ISO 时间 |

**坐标系**：`labels.json` 的 `startMs/endMs` 是**绝对板卡毫秒**（等于 `frames.csv` 的 `t_board_ms` 刻度，首帧通常不是 0），下游可以直接与 `events.csv` 的 `frame_t_ms` 比区间；页面内部用「相对首帧的偏移毫秒」画图，读写时由 `core.js` 的 `relToAbs/absToRel` 换算。无 `frames.csv` 时退化为按 `fpsNominal` 推算的视频时间轴（页面标警告，frame 号是近似值）。

## 快捷键

输入框里打字时所有快捷键失效。

| 键 | 作用 |
| --- | --- |
| `Space` | 播放 / 暂停 |
| `←` / `→` | 逐帧后退 / 前进 |
| `Shift+←` / `Shift+→` | 10 帧后退 / 前进 |
| `S` | 在播放头处切分片段（两侧各至少 40ms） |
| `Delete` / `Backspace` | 删除选中片段 |
| `Esc` | 取消拖拽 / 取消选中 |
| `Ctrl+S` | 立即保存 |
| `Alt+1` … `Alt+9` | 给选中片段赋类型；**没有选中但有拖拽选区时，先建段再赋类型** |
| `1` … `9` | 备用：与 Alt+N 等价；右栏开关可关掉，右下角实时显示当前生效方式 |

鼠标：滚轮缩放（以指针为中心）；上排标尺/密度区拖动平移；轨道空白左右拖动建段；拖片段两端改边界；拖中间移动；点片段选中并 seek 到起点。改动 800ms 防抖自动保存；保存失败顶部出现红条和「重试保存」，不会静默丢。

## 类型管理

右栏可以给类型改名、改颜色、增删（上限 10 个，含「无动作」）；删除类型时用它的片段回到「无动作」。`Alt+N` 的 N 是类型按 id 排序后的槽位。

## 测试

```bash
cd host/app/tools/annotator
node --test test/core.test.mjs        # 纯函数单测（30 个 test：px↔ms、钳制、桶聚合、Range/206、路径穿越、labels 迁移…）
node test/http_selfcheck.mjs          # 真起服务跑 HTTP 自检（10 项），末尾打印 ANNO_HTTP_OK=1
node test/realdata_check.mjs          # 真实长录验证（8 项），校验 frames.csv 时间轴与 Range，末尾打印 REALDATA_OK=1
node test/browser_smoke.mjs           # headless Chrome/Edge + CDP 真跑页面（拖动/建段/打标/保存/导出），末尾打印 BROWSER_OK=1
```

自检默认用 `temp_test/anno_fixture/records` 这套假会话（`node temp_test/anno_fixture/make_fixture.mjs` 可重建）：含正常分段、只有 `.recording.mp4` 的未完成分段、无 `events.csv` 的分段、无 `meta.json` 的会话。也可以 `node test/http_selfcheck.mjs --root <你的 records>` 指向真数据。

## 已知限制

- 事件超过 60000 条时服务端只回 100ms 分桶（`counts`），不把逐条事件塞给浏览器；密度图不受影响。
- 视频解码依赖浏览器内置解码器（H.264/MP4 一般没问题）；只有 `.recording.mp4`（未 seal）的分段可以标，但拖动可能卡顿。
- **mp4 时间轴是压缩的**：容器按 `fpsNominal=30` 声明，真实板卡约 26.7 fps ⇒ 容器时长比墙钟短约 11%。标注工具按 `frames.csv` 的 `frame_idx/t_board_ms` 对齐，不受影响；但用外部 `ffmpeg -ss` 抠图时，目标秒数要乘 `0.889`（板卡秒 → 容器秒）。
- 导出的是片段级 CSV（`id,startMs,endMs,startFrame,endFrame,typeId,typeName,note`，UTF-8 无 BOM、CRLF），不带逐事件数据。
- `labels.json` 损坏或字段非法时自动重建默认值（尽量保留能解析的片段），页面顶部给黄条提示；文件不存在（全新会话）不算损坏，状态栏显示「暂无标注」。
- 保存 labels 用 tmp+rename；Windows 上 rename 遇到目标文件被占用（EPERM/EBUSY）会自动重试，仍失败则退化为直接覆盖写，不丢标注。
- 页面由 `GET /` 返回，静态资源固定在 `/ui/*`：改 HTML 里的资源路径时要写成 `./ui/app.js` 这类绝对到站点的路径。

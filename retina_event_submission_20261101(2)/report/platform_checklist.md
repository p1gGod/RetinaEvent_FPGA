# 平台上传材料清单

> 用途：按平台必填项逐项准备，避免最后一天才发现缺件。
> 状态标记：✅ 已备好；🔶 有草稿待定稿/待拍；⬜ 未开始。

## 1. 必填项清单

| # | 平台必填项 | 本仓库文件 / 动作 | 规格 | 当前状态 |
|---|---|---|---|---|
| 1 | 演示视频 | report/demo_video_script.md 按分镜拍摄 | 1920×1080，H.264，30 fps，≤180 s，≤300 MB | 🔶 分镜已定稿，待拍摄 |
| 2 | 作品概览图 | report/figures/f1_system_arch.svg，导出 PNG 上传 | 长边 ≥1920 px，白底，文字可读 | 🔶 源图已备，待导出 |
| 3 | 开发板实物照 | 板卡 + 摄像头 + 网线 + 屏幕同框 | 3 张，JPG/PNG，单张 ≤10 MB | ⬜ 待拍 |
| 4 | 承诺与授权书 | 平台模板；用户手写/签名 | 平台指定 PDF/扫描件 | ⬜ 待用户签 |
| 5 | 3 个创新关键词 | 见 §2 | 英文小写，单词或连字符短语 | ✅ 已定稿 |
| 6 | 作品简介（中英文） | 见 §3 | 中文 ≤200 字；英文 ≤120 词 | ✅ 已定稿 |

## 2. 3 个创新关键词

| 关键词 | 入选理由 |
|---|---|
| event-driven | 只上报亮度变化；静态场景几乎不产生数据，链路与存储压力随场景稀疏度下降。 |
| on-chip-inference | 动作判别在 FPGA 内完成，不把原始视频送到云端；100 ms 窗内给出结果。 |
| reproducible | RTL、时序、资源、上位机与采集脚本同仓库；评审可按 README 与报告复跑。 |

## 3. 作品简介

### 3.1 中文（≤200 字）

RetinaEvent 是一套面向低功耗视觉的仿视网膜事件相机前端。它在 FPGA 内把 800×480 画面转成 400×240 稀疏事件，静态场景几乎不输出；手部开合在片上以 100 ms 窗完成判别，结果通过千兆网送到浏览器面板。工程开放 RTL、时序与资源报告，并附可复跑脚本。

### 3.2 English（≤120 words）

RetinaEvent is an event-driven vision front-end on a low-cost AMD Artix-7 FPGA. It converts an 800×480 camera stream into a 400×240 sparse event stream inside the device, so static scenes produce almost no data. A compact int8 network classifies hand opening and closing in 100 ms windows on the same die, and a gigabit link carries events and decisions to a browser-based host. The package includes RTL, timing and resource reports, and scripts for reproduction.

## 4. 概览图导出

首选源图：report/figures/f1_system_arch.svg。该图是系统框图，评审在缩略图尺寸也能看懂采集、事件、显示、回传、推理五段关系。

首选命令（需要 rsvg-convert）：

    rsvg-convert -w 1920 -h 1080 --keep-aspect-ratio report/figures/f1_system_arch.svg -o report/figures/f1_overview_1920.png

备选命令（需要 ImageMagick）：

    magick -background white -density 200 report/figures/f1_system_arch.svg -resize 1920x1080 -gravity center -extent 1920x1080 report/figures/f1_overview_1920.png

若平台限制文件大小在 2 MB 以内，先降到长边 1600 px；若限制 1 MB，降到 1280 px。不要只截屏幕上的一部分，保留完整框图与标题。

## 5. 实物照拍摄要求

拍三张，全部横构图，板卡、摄像头、网线、屏幕同框，能看清板卡丝印与接口。

1. 全景：板卡平放，摄像头朝上，网线接 GE1，屏幕在后方显示实时画面；光线均匀，不反光。
2. 细节：镜头靠近板卡型号丝印与摄像头排线，保留网线水晶头，证明是真实接线。
3. 工作场景：屏幕显示上位机面板与事件率曲线，板卡与屏幕同时入镜，画面里不出现队伍信息。

构图要求：板卡占画面三分之一以上；镜头与板卡成 30–60 度，避免正面反光；背景干净，不出现学校标识、姓名牌、联系方式。

## 6. 承诺与授权书

平台模板下载后，由用户本人填写并手写签名。需要确认的字段：

- 作品名称：RetinaEvent
- 参赛赛道：FPGA 创新设计赛道
- 参赛队伍/成员信息：按平台要求填写，不写进海报与视频
- 作品原创性与第三方代码许可说明：自研 RTL 与厂家驱动分层，厂家驱动放 ref_original/ 并保留版权声明
- 承诺人签名与日期：用户手写，不代签
- 身份证件/学生证信息：按平台要求上传，不放进公开仓库

## 7. 提交前检查

- 视频总时长 ≤180 s，文件 ≤300 MB，封面帧不是纯标题。
- 概览图长边 ≥1920 px，文字不糊；平台压缩后仍能读清五段框图。
- 实物照三张，板卡型号丝印可读，无队伍信息。
- 授权书已手写签名，扫描件清晰。
- 三个关键词全部英文小写，与海报、视频字幕一致。
- 中文简介 ≤200 字，英文简介 ≤120 词；与 D8 登记册数字不冲突。

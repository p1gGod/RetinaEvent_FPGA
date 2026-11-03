# event_vision_bringup

一句话：把事件视觉系统从「能上电」推到「可验收」，用逐级计数器和离线检查定位丢事件、坏包与时序问题。

## 适用范围

- 事件相机、动态视觉传感器、或任何产生异步事件流并打包上传的 FPGA 系统。
- 上板 bringup、链路联调、长期稳定性测试前的自检。
- 没有示波器、只有控制通道可读计数器的现场。
- 不覆盖：传感器寄存器配置细节、光学对焦、上位机算法效果；本包只检查数据通路的完整性与可观测性。

## 使用方法

1) 上板前按 bringup_checklist.md 的阶段 0 做静态检查，阶段 1 到 5 逐级推进；每阶段留一行证据。

2) 需要确认线协议时，按 packet_format.md 的清单核对字段、字节序与 CRC 覆盖范围。

3) 把采集结果导出为 CSV/JSON，运行离线检查：

```bash
python check_stream.py report \
  --events examples/events_clean.csv \
  --packets examples/packets_clean.csv \
  --stats examples/stats_clean.json
```

输出每类异常的计数与第一个异常值，末行 STREAM_RESULT=PASS|FAIL，退出码 0 通过、1 有异常。

4) 计算或核对 CRC：

```bash
python check_stream.py crc --hex 313233343536373839
```

输出 CRC16=0x29B1（CRC16-CCITT-FALSE 标准测试向量）。

5) 自检（不依赖任何外部文件）：

```bash
python check_stream.py --selftest
```

输入列约定：

- 事件 CSV：ts_us,x,y,pol。
- 包 CSV：seq,crc_ok,len,ts_us。
- 计数器 JSON：对象或嵌套对象，键名含 drop/lost/err/fail/bad/overflow/corrupt/missing/timeout 且值非零时会报警；可用 --allow-key 放行已知的非零计数器。

## 已验证效果

本包自检（2026-10-30，Python 3 标准库）：

```text
$ python check_stream.py --selftest
SELFTEST_CASE=events_clean status=PASS
SELFTEST_CASE=events_bad_detected status=PASS bad_time=1 oob=1 bad_pol=1
SELFTEST_CASE=packets_clean status=PASS
SELFTEST_CASE=packets_bad_detected status=PASS gaps=1 crc=1 oversize=1
SELFTEST_CASE=stats_clean status=PASS
SELFTEST_CASE=stats_bad_detected status=PASS nonzero=2
SELFTEST_CASE=crc_vector status=PASS crc=0x29B1 want=0x29B1
SELFTEST_CASE=crc_hex_parse status=PASS
SELFTEST_RESULT=PASS
```

退出码 0。示例文件的实测输出：

```text
$ python check_stream.py report --events examples/events_bad.csv \
    --packets examples/packets_bad.csv --stats examples/stats_bad.json
EVENTS_BAD_TIME=1 first_bad_ts=900
EVENTS_OUT_OF_RANGE=1 first_bad_coord=500,20
EVENTS_BAD_POL=1
EVENTS_MAX_GAP_US=898700 first_gap_ts=900000
PACKETS_SEQ_GAPS=1 first_bad_seq=4
PACKETS_CRC_FAIL=1 first_crc_fail_seq=4
PACKETS_OVERSIZE=1 first_oversize_seq=4
STATS_NONZERO=2
STATS_NONZERO_LIST=rx.drop=3,crc_fail=2
STREAM_RESULT=FAIL
```

退出码 1，四条异常各自给出首个位置，符合二分定位的预期。

来源工程历史实测（非本包自检）：build/udp_frame_check.py 用同一 CRC16-CCITT-FALSE 参数解析 v3 上行包；docs/05_experiments/FPGA工作点适配_20261007/README.md 记录坏 magic、CRC 失败、序号缺口三个计数器在长时间采集后为 0（同表 aborted=3，表示另有失败场景）；docs/05_experiments/协议v3设计_20261009/v3线协议设计.md 记录 24 B 头与 1472 B MTU。

## 失效条件

- 事件 CSV 的列名不是 ts_us/x/y/pol，或包 CSV 缺 seq/crc_ok/len；需要先改导出脚本。
- 时间戳单位不是微秒：--max-gap-us 与速率判断会失真。
- 坐标上限不是 400x240：用 --width、--height 指定，否则越界误报或漏报。
- 序号不是 1 递增（例如每帧从 0 重新编号）：用 --seq-mod 或先按帧拆分文件。
- 计数器 JSON 的键名不含检查表中的关键词：不会报警，需要加 --allow-key 的反向白名单或改键名。
- CRC 实现与对端不一致（poly、init、xorout、覆盖范围任一不同）：全部包报 crc_ok=0。
- 本包不读取实时流量，只检查导出文件；在线抓包需要额外的采集脚本。

## 来源

- 逐级计数器与窗沿事件标记：docs/03_tech/06_rtl_design_and_pitfalls.md 坑 5、6、7。
- 包解析与 CRC 实现：build/udp_frame_check.py。
- v3 线协议字段与 MTU：docs/05_experiments/协议v3设计_20261009/v3线协议设计.md、docs/03_tech/05_action_uplink_contract.md。
- 长时间采集计数器结果：docs/05_experiments/FPGA工作点适配_20261007/README.md。
- 验收与证据写法：sim/nn/EVIDENCE_M3.md、docs/04_contest/05_report_outline_and_style.md。

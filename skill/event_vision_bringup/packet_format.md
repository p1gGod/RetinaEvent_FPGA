# 事件流包格式：最小清单与 CRC 校验

结论先行：自定义线协议只需要固定字段、明确字节序、明确校验覆盖范围，并用同一组测试向量在 FPGA 与上位机两侧自测；其余字段按项目需要增删。

## 1 包格式清单

写进项目文档的字段，缺一项就会在上板阶段返工。

| 字段 | 建议宽度 | 要求 |
| --- | --- | --- |
| magic | 4 B | 固定值，接收端用于重同步；坏 magic 计数必须可见 |
| version | 1 B | 布局变化时递增 |
| header_len | 1 B | 头部字节数，允许扩展字段 |
| flags | 1 B | 逐位定义：raw、event、first、last、ts_valid、crc_valid |
| mode | 1 B | 数据、控制、心跳等模式 |
| sequence | 2 B 或 4 B | 逐包递增，写清回绕规则 |
| timestamp | 4 B 或 6 B | 单位与位宽固定，例如 48 bit 微秒 |
| payload_len | 2 B | 单包载荷字节数，不得超过 MTU |
| payload | 0..1440 B | 事件记录或原始数据 |
| crc16 | 2 B | 覆盖范围写清；通常覆盖头部与载荷 |

约束：

- 字节序写清（little-endian 或 big-endian），跨语言解析时最容易出错。
- MTU 1472 B 是常见上限（1500 B 以太网帧减去 20 B IP 与 8 B UDP 头）。
- 保留字段在计算 CRC 前清零，避免同一包两次计算结果不同。
- CRC 覆盖头部时，必须先把所有字段写好，再计算，再写回包尾。
- 版本号与布局一起改；只换 ROM/固件不换版本号，会让上位机误解析。

## 2 CRC16-CCITT-FALSE

参数：poly=0x1021、init=0xFFFF、refin=false、refout=false、xorout=0x0000。

测试向量：ASCII 字符串 123456789 的 CRC 为 0x29B1。

```bash
python check_stream.py crc --hex 313233343536373839
# CRC16=0x29B1
# CRC_BYTES=9
```

注意：CRC-16/XMODEM 使用同样的 poly 与 init，但 xorout 不同；两者结果会差 0xFFFF 相关常量，文档里写清是哪一种。

FPGA 侧建议用逐位 LFSR 实现（每字节 8 轮），与软件逐位实现逐字节对拍；先用手算 3 字节向量，再跑随机向量 1 万组。

## 3 导出数据与离线检查

把上板采集的数据导出成 CSV，列名固定，便于 check_stream.py 直接读取：

- 事件：ts_us,x,y,pol
- 包：seq,crc_ok,len,ts_us
- 计数器：JSON 对象，允许嵌套

```bash
python check_stream.py report --events events.csv --packets packets.csv --stats stats.json
```

输出包含每类异常的数量与第一个异常值（first_bad_ts、first_bad_seq、first_crc_fail_seq），用于二分定位。末行 STREAM_RESULT=PASS|FAIL；退出码 0 通过，1 有异常。

## 4 来源工程示例（附录）

以下是来源工程 v3 上行协议的字段级事实，仅作示例；本包不绑定该布局。

- 头部 24 B；MAGIC=F0 5A A5 30；VER=0x03；HDR_LEN=0x18。
- FLAGS 逐位：bit0 RAW、bit1 EV、bit2 CRC、bit3 TS_VALID、bit4 TS_CALIBRATED、bit5 FIRST、bit6 LAST、bit7 CTRL。
- MODE 取值 0/1/2；CHUNK_IDX 2 B；TS 48 bit 微秒；CRC16 覆盖整包；MTU 1472。
- 事件记录 5 B：X 低 8 位、X 第 9 位、Y、POL、FLAGS。
- 文档路径：docs/05_experiments/协议v3设计_20261009/v3线协议设计.md；上位机约定：docs/03_tech/05_action_uplink_contract.md。
- 对应解析脚本：build/udp_frame_check.py（标准库实现，含 CRC16 查表版本）。

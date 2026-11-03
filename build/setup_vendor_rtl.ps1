# ==============================================================================
# setup_vendor_rtl.ps1 -- 把厂家 RTL 从已归档的实验工程拷进 ref_original/
#
# 为什么要用脚本，而不是直接把厂家 RTL 提交进仓库：
#
#   1. ref_original/ 下的厂家 RTL 版权归正点原子（文件头写"版权所有，盗版必究"），
#      .gitignore 已把它排除在版本控制之外。
#   2. 团队私有仓库里也不需要重复存一份 —— doc/FPGA_board/ 下已经有完全相同的
#      厂家资料了，再存一遍纯粹是浪费。
#   3. 将来建公开仓库时，ref_original/ 天然就是空的，不用再做清理。
#
#   所以：仓库里 ref_original/ 只提交 README.md，队友跑一次本脚本即可补齐源码。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tool\setup_vendor_rtl.ps1
#
#   加 -Check 只检查不拷贝。
# ==============================================================================

param(
    [switch]$Check
)

$ErrorActionPreference = 'Stop'

$here     = Split-Path -Parent $PSScriptRoot              # retina_event\
$repoRoot = Split-Path -Parent $here                      # FPGA_Comp\
$src      = Join-Path $repoRoot 'exp_ov5640_lcd_eth\prj_src\rtl'
$dst      = Join-Path $here 'ref_original'

# ------------------------------------------------------------------------------
# 厂家 RTL 清单（路径相对于 $src）
#
# ⚠️ 注意：$src 目录里**同时混有我们自研的文件**——
#      img_data_pkt_udp.v / lcd_overlay_axes.v / lcd_rgb_top_ovl.v /
#      key_toggle.v / font8x16_rom.v / ovl_text_rom.v / ov5640_lcd_udp.v
#    那些是自研代码，不属于厂家，**故意不在下面这张表里**。
# ------------------------------------------------------------------------------
$vendorFiles = @(
    # --- 例程 37：摄像头 → DDR3 → LCD 显示通路（本工程的显示底座）---
    'ov5640_lcd.v'
    'picture_size.v'
    'ov5640_dri.v'
    'i2c_ov5640_rgb565_cfg.v'
    'i2c_dri.v'
    'cmos_capture_data.v'
    'ddr3_top.v'
    'ddr3_rw.v'
    'ddr3_fifo_ctrl.v'
    'lcd_rgb_top.v'
    'lcd_driver.v'
    'rd_id.v'
    'clk_div.v'
    # --- 例程 60：以太网协议栈（回传通路）---
    'eth_top.v'
    'eth_ctrl.v'
    'start_transfer_ctrl.v'
    'eth\gmii_to_rgmii\gmii_to_rgmii.v'
    'eth\gmii_to_rgmii\rgmii_rx.v'
    'eth\gmii_to_rgmii\rgmii_tx.v'
    'eth\arp\arp.v'
    'eth\arp\arp_rx.v'
    'eth\arp\arp_tx.v'
    'eth\arp\crc32_d8.v'
    'eth\udp\udp.v'
    'eth\udp\udp_rx.v'
    'eth\udp\udp_tx.v'
)

Write-Host ''
Write-Host '=== retin_event :: 补齐厂家 RTL ===' -ForegroundColor Cyan
Write-Host "  源: $src"
Write-Host "  目标: $dst"

if (-not (Test-Path $src)) {
    Write-Host ''
    Write-Host "[FAIL] 源目录不存在: $src" -ForegroundColor Red
    Write-Host '       请确认已克隆完整仓库（exp_ov5640_lcd_eth 是已归档的上板实验工程）。'
    exit 1
}

if (-not (Test-Path $dst)) {
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
}

$copied  = 0
$skipped = 0
$missing = @()

foreach ($rel in $vendorFiles) {
    $s = Join-Path $src $rel
    $d = Join-Path $dst $rel
    if (-not (Test-Path $s)) {
        $missing += $rel
        continue
    }
    if ($Check) {
        Write-Host ("  [ok]      {0}" -f $rel) -ForegroundColor DarkGray
        $copied++
        continue
    }
    $dd = Split-Path -Parent $d
    if (-not (Test-Path $dd)) {
        New-Item -ItemType Directory -Force -Path $dd | Out-Null
    }
    if ((Test-Path $d) -and ((Get-FileHash $s).Hash -eq (Get-FileHash $d).Hash)) {
        $skipped++
        continue
    }
    Copy-Item -Path $s -Destination $d -Force
    Write-Host ("  [copied]  {0}" -f $rel) -ForegroundColor Green
    $copied++
}

Write-Host ''
if ($missing.Count -gt 0) {
    Write-Host ("[WARN] {0} 个文件在源目录里找不到:" -f $missing.Count) -ForegroundColor Yellow
    foreach ($m in $missing) { Write-Host ("         {0}" -f $m) -ForegroundColor Yellow }
}

if ($Check) {
    Write-Host ("[CHECK] 应有 {0} 个厂家 RTL，源目录里找到 {1} 个" -f $vendorFiles.Count, $copied)
} else {
    Write-Host ("[OK] 拷贝 {0} 个，跳过（内容相同）{1} 个，缺失 {2} 个" -f $copied, $skipped, $missing.Count) -ForegroundColor Green
}

# ------------------------------------------------------------------------------
# 提醒：IP 不在这里，要另外处理
# ------------------------------------------------------------------------------
Write-Host ''
Write-Host '--- 还需要手工处理的 IP ---' -ForegroundColor Cyan
Write-Host '  含 MIG 的工程不能只拿 .xci，缺 mig_a.prj 会报 [IP_Flow 19-3460]。'
Write-Host '  完整的 IP 目录在这些位置（原样拷贝，**不要**用 Vivado 2023.2 打开）：'
Write-Host '    显示通路 IP: exp_ov5640_lcd37\prj_src37\prj\ov5640_lcd.srcs\sources_1\ip\'
Write-Host '    以太网 IP  : exp_ov5640_lcd_eth\prj_src\prj\ov5640_lcd.srcs\sources_1\ip\'
Write-Host '  重建配方见: exp_ov5640_lcd37\tool\rebuild37.ps1（Vivado 2020.2，约 7.5 min）'
Write-Host ''
Write-Host '  完整说明见 NOTICE 与 ref_original\README.md'
Write-Host ''

# ==============================================================================
# run_sim.ps1 -- retina_event 统一 ModelSim 仿真运行器
#
# 为什么要有它：全工程 40+ 个 testbench 需要**同一套**编译/运行/判定约定，
# 否则每个 agent 各写一套 vsim 命令，结果无法汇总、失败无法复用。
#
# 约定（testbench 必须遵守）：
#   1. TB 文件放在 sim/tb/tb_<模块名>.v，文件名 = 顶层 module 名。
#   2. TB 在结束时打印 **恰好一行**：`TEST_RESULT=PASS` 或 `TEST_RESULT=FAIL`
#      （用 $display("TEST_RESULT=PASS"); 建议用局部 task 统一收口）
#   3. 每条判据单独打印：`CHECK=<名称> <PASS|FAIL>`，便于失败时定位。
#   4. TB 依赖的 RTL 文件列在同名 .f 文件里（sim/tb/tb_xxx.f），一行一个路径，
#      路径相对 **工程根 retina_event/**。没有 .f 时回退到"编译 src/hdl 全树"。
#   5. TB 必须自己产生时钟、自己 $finish/超时保护，**不许无限跑**。
#
# 用法：
#   pwsh -File tool\run_sim.ps1 -Tb tb_sync_ff
#   pwsh -File tool\run_sim.ps1 -Tb tb_retina_core -Vcd
#   pwsh -File tool\run_sim.ps1 -Tb tb_px_luma -Deps src\hdl\engine\px_luma.v
#   pwsh -File tool\run_sim.ps1 -Tb tb_foo -Runtime "run 1ms"
#
# 退出码：0 = TEST_RESULT=PASS；1 = FAIL 或编译/仿真报错；2 = 用法错误
# ==============================================================================

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Tb,
    [string[]]$Deps,
    [string]$Runtime = 'run -all',
    [switch]$Vcd,
    [switch]$Gui,
    [switch]$KeepLog,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$root      = Split-Path -Parent $PSScriptRoot          # retina_event\
$modelsim  = 'E:\Programs\modeltech64_2020.4\win64'
$vlog      = Join-Path $modelsim 'vlog.exe'
$vsim      = Join-Path $modelsim 'vsim.exe'
$vlib      = Join-Path $modelsim 'vlib.exe'

foreach ($exe in @($vlog, $vsim, $vlib)) {
    if (-not (Test-Path $exe)) { Write-Host "[FAIL] 找不到 ModelSim 可执行文件: $exe" -ForegroundColor Red; exit 2 }
}

# ---- 定位 TB 文件 -------------------------------------------------------------
$tbName = $Tb
if ($tbName -like '*.v') { $tbName = [IO.Path]::GetFileNameWithoutExtension($tbName) }
$tbFile = Join-Path $root "sim\tb\$tbName.v"
if (-not (Test-Path $tbFile)) {
    # 允许直接给路径
    if (Test-Path $Tb) { $tbFile = (Resolve-Path $Tb).Path; $tbName = [IO.Path]::GetFileNameWithoutExtension($tbFile) }
    else { Write-Host "[FAIL] 找不到 testbench: $tbFile" -ForegroundColor Red; exit 2 }
}

# ---- 工作目录 ---------------------------------------------------------------
$work = Join-Path $root "build\sim\$tbName"
if (Test-Path $work) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $work | Out-Null

# ---- 决定要编译的文件列表 -----------------------------------------------------
$fileList = @()
if ($Deps -and $Deps.Count -gt 0) {
    $fileList = $Deps
} else {
    $fFile = [IO.Path]::ChangeExtension($tbFile, '.f')
    if (Test-Path $fFile) {
        $fileList = Get-Content -Encoding UTF8 $fFile | Where-Object { $_ -and $_.Trim() -ne '' -and -not $_.Trim().StartsWith('#') }
    } else {
        # 回退：编译 src/hdl 全树（会把他人的编译错误一起带进来，仅作兜底）
        $fileList = Get-ChildItem (Join-Path $root 'src\hdl') -Recurse -Filter *.v | ForEach-Object { $_.FullName }
        if (-not $Quiet) { Write-Host "[warn] 未找到 .f 文件，回退为编译 src/hdl 全树" -ForegroundColor Yellow }
    }
}

$resolved = @()
foreach ($f in $fileList) {
    $p = if ([IO.Path]::IsPathRooted($f)) { $f } else { Join-Path $root $f }
    if (-not (Test-Path $p)) { Write-Host "[FAIL] 依赖文件不存在: $f" -ForegroundColor Red; exit 2 }
    $resolved += (Resolve-Path $p).Path
}

# ---- 编译 ------------------------------------------------------------------
$vlogArgs = @('-quiet') + $resolved + @($tbFile)
$vlogLog  = Join-Path $work 'vlog.log'
Push-Location $work
try {
    & $vlog @vlogArgs > $vlogLog 2>&1
    $vlogRc = $LASTEXITCODE
} finally { Pop-Location }

if ($vlogRc -ne 0) {
    Write-Host "[FAIL] vlog 编译失败 (rc=$vlogRc)" -ForegroundColor Red
    Get-Content $vlogLog -Encoding UTF8 | Select-String -Pattern '\*\* (Error|Warning)' -Context 0,3 | Select-Object -First 25 | ForEach-Object { Write-Host $_ }
    exit 1
}

# ---- 仿真 ------------------------------------------------------------------
$vcdArgs = if ($Vcd) { 'vcd file wave.vcd; vcd add -r /*;' } else { '' }
$doScript = "${vcdArgs} ${Runtime}; quit -f"
$vsimLog = Join-Path $work 'vsim.log'

$vsimArgs = @('-c', '-voptargs=+acc', '-do', $doScript, "work.$tbName")
# ModelSim 用 MODELSIM 环境变量定位 modelsim.ini（-modelsimini 在本机被 Tcl 花括号包成 {..}，
# 实测报 `Failed to open -modelsimini file "{C:\...}"`，故改用环境变量）
$env:MODELSIM = Join-Path (Split-Path -Parent $modelsim) 'modelsim.ini'
Push-Location $work
try {
    & $vsim @vsimArgs > $vsimLog 2>&1
    $vsimRc = $LASTEXITCODE
} finally { Pop-Location }

# ---- 判定 ------------------------------------------------------------------
$content = Get-Content -Raw -Encoding UTF8 $vsimLog -ErrorAction SilentlyContinue
$hasPass = $content -match 'TEST_RESULT=PASS'
$hasFail = $content -match 'TEST_RESULT=FAIL'

if (-not $Quiet) {
    # 逐条判据
    Get-Content $vsimLog -Encoding UTF8 | Select-String -Pattern 'CHECK=' | ForEach-Object { Write-Host $_.Line }
    Get-Content $vsimLog -Encoding UTF8 | Select-String -Pattern 'TEST_RESULT=' | ForEach-Object { Write-Host $_.Line }
}

if ($hasPass -and -not $hasFail) {
    if (-not $Quiet) { Write-Host "[PASS] $tbName" -ForegroundColor Green }
    if (-not $KeepLog) { }
    exit 0
}

Write-Host "[FAIL] $tbName (vsim rc=$vsimRc, PASS=$hasPass FAIL=$hasFail)" -ForegroundColor Red
if ($content -match '\*\* Error') {
    Get-Content $vsimLog -Encoding UTF8 | Select-String -Pattern '\*\* Error' -Context 0,4 | Select-Object -First 20 | ForEach-Object { Write-Host $_ }
}
Write-Host "  日志: $vsimLog"
exit 1

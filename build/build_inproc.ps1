# =============================================================================
# build_inproc.ps1 -- 进程内构建包装（绕开挂死的 run server）
#
# 用法（CWD = retina_event\）：
#   pwsh -NoProfile -File tool\build_inproc.ps1                 # 全量
#   pwsh -NoProfile -File tool\build_inproc.ps1 -Mode --synthonly
#   pwsh -NoProfile -File tool\build_inproc.ps1 -Mode --resume
#
# 退出码：0 = 成功（且日志里 INPROC_RESULT=OK）；1 = 失败
# ⚠️ 不要把输出管到 Select-Object -First（会把 $LASTEXITCODE 变成 -1）
# =============================================================================
param(
    [ValidateSet('--full', '--synthonly', '--resume')][string]$Mode = '--full'
)

$ErrorActionPreference = 'Continue'
$root    = Split-Path -Parent $PSScriptRoot
$vivado  = 'E:\Programs\Xilinx\Vivado\2020.2\bin\vivado.bat'
$tcl     = Join-Path $root 'tool\build_inproc.tcl'
$log     = Join-Path $root 'tool\build_inproc.log'
$jou     = Join-Path $root 'tool\build_inproc.jou'
$console = Join-Path $root 'tool\build_inproc.console.log'
$bit     = Join-Path $root 'build\retina_event.bit'

foreach ($p in @($vivado, $tcl)) { if (-not (Test-Path $p)) { Write-Host "[FAIL] 缺文件: $p" -ForegroundColor Red; exit 1 } }
New-Item -ItemType Directory -Force -Path (Join-Path $root 'build') | Out-Null

Write-Host "== 进程内构建 retina_event（Vivado 2020.2, mode=$Mode）=="
$sw = [Diagnostics.Stopwatch]::StartNew()

# ⚠️ -tclargs 必须是整条命令行的最后一个参数（否则 -log/-journal 会被脚本吞掉）
$cmdLine = '"{0}" -mode batch -source "{1}" -log "{2}" -journal "{3}" -tclargs {4}' -f $vivado, $tcl, $log, $jou, $Mode
& cmd /c $cmdLine > $console 2>&1
$code = $LASTEXITCODE
$sw.Stop()

$txt    = Get-Content $console -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
$result = [regex]::Match($txt, '(?m)^INPROC_RESULT=(\S+)').Groups[1].Value

Write-Host ("退出码={0}  耗时={1:n1} 分钟  INPROC_RESULT={2}" -f $code, $sw.Elapsed.TotalMinutes, $result)
foreach ($k in 'INPROC_ACTUAL_TOP', 'INPROC_ACTUAL_PART', 'INPROC_GEN_TARGET_OK', 'INPROC_WNS', 'INPROC_TNS',
               'INPROC_WHS', 'INPROC_THS', 'INPROC_LUT', 'INPROC_FF', 'INPROC_BRAM', 'INPROC_DSP',
               'INPROC_DRC_ERRORS', 'INPROC_DRC_CRIT', 'INPROC_BIT_BYTES') {
    $m = [regex]::Match($txt, "(?m)^$k=(.*)$")
    if ($m.Success) { Write-Host ("   {0,-24} = {1}" -f $k, $m.Groups[1].Value.Trim()) }
}

if ($code -ne 0 -or $result -ne 'OK') {
    Write-Host '--- 最后 30 行控制台 ---' -ForegroundColor Yellow
    Get-Content $console -Encoding UTF8 | Select-Object -Last 30 | ForEach-Object { Write-Host $_ }
    Write-Host "失败：完整日志见 $console 与 $log" -ForegroundColor Red
    exit 1
}

if (Test-Path $bit) {
    $h = (Get-FileHash $bit -Algorithm MD5).Hash
    Write-Host ("比特流: {0}" -f $bit) -ForegroundColor Green
    Write-Host ("        {0} bytes  md5={1}" -f (Get-Item $bit).Length, $h) -ForegroundColor Green
} else {
    Write-Host "[FAIL] 构建报 OK 但未见比特流" -ForegroundColor Red
    exit 1
}
exit 0

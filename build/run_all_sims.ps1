# ==============================================================================
# run_all_sims.ps1 -- 一键跑全部单模块 testbench，汇总成表
#
# 用法（CWD 必须是工程根 retina_event\）：
#   pwsh -NoProfile -File tool\run_all_sims.ps1
#   pwsh -NoProfile -File tool\run_all_sims.ps1 -Out build\sim_summary.txt -Json
#
# 退出码：0 = 全部 PASS；1 = 有 FAIL（或跳过）
#
# ⚠️ 不要用 `| Select-Object -First N` 截断原生命令输出（会把 $LASTEXITCODE 变成 -1）；
#    本脚本把每个 TB 的输出落盘后再解析。
# ==============================================================================
[CmdletBinding()]
param(
    [string]$Out = '',
    [switch]$Json,
    # ⚠️ 用**逗号分隔的单个字符串**而不是 [string[]]：
    #    `pwsh -File script.ps1 -Only a,b,c` 下 -File 的参数解析不支持数组，
    #    会把第二个元素当成位置参数报 "A positional parameter cannot be found"（实测踩过）
    [string]$Only = ''
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$tbs = Get-ChildItem 'sim\tb' -Filter 'tb_*.v' | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($_.Name) } | Sort-Object
if ($Only -ne '') {
    $keep = $Only -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
    $tbs = $tbs | Where-Object { $keep -contains $_ }
}

$rows = @()
foreach ($tb in $tbs) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $log = Join-Path $root "build\sim\$tb\vsim.log"
    & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'run_sim.ps1') -Tb $tb -Quiet > $null 2>&1
    $rc = $LASTEXITCODE
    $sw.Stop()

    $checks = 0; $fails = 0
    if (Test-Path $log) {
        $lines = Get-Content $log -Encoding UTF8
        $checks = ($lines | Select-String -Pattern 'CHECK=' -SimpleMatch).Count
        $fails  = ($lines | Select-String -Pattern 'FAIL'     -SimpleMatch | Select-String -Pattern 'CHECK=' -SimpleMatch).Count
    }
    $rows += [pscustomobject]@{
        TB      = $tb
        Result  = if ($rc -eq 0) { 'PASS' } else { 'FAIL' }
        Checks  = $checks
        Failed  = $fails
        Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    }
    Write-Host ("{0,-28} {1,-5} checks={2,-4} failed={3,-3} {4,7:n1}s" -f $tb, $rows[-1].Result, $checks, $fails, $rows[-1].Seconds)
}

Write-Host ''
$pass = ($rows | Where-Object { $_.Result -eq 'PASS' }).Count
$fail = ($rows | Where-Object { $_.Result -eq 'FAIL' }).Count
$tc   = ($rows | Measure-Object -Property Checks -Sum).Sum
Write-Host ("==== 合计: {0} 个 TB / PASS {1} / FAIL {2} / 判据总数 {3} ====" -f $rows.Count, $pass, $fail, $tc)

if ($Out) {
    $rows | Format-Table -AutoSize | Out-String | Set-Content -Path $Out -Encoding UTF8
    Add-Content -Path $Out -Value ("合计: {0} 个 TB / PASS {1} / FAIL {2} / 判据总数 {3}" -f $rows.Count, $pass, $fail, $tc)
}
if ($Json) { $rows | ConvertTo-Json -Depth 3 | Set-Content -Path 'build\sim_summary.json' -Encoding UTF8 }

if ($fail -gt 0) { exit 1 } else { exit 0 }

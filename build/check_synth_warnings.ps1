#==============================================================================
# check_synth_warnings.ps1 —— 交付闸门：逐模块 OOC 综合，抓"仿真验不出来"的综合期致命告警
#
# 为什么需要它（真实教训）：
#   `udp_merge.v` 曾有两个 always 块驱动同一个 reg（其一只在复位分支写 0），
#   Vivado 报 [Synth 8-6859] multi-driven net（另一驱动被当成常量 GND）。
#   **ModelSim 不报错、TB 14/14 全绿**，只有综合才暴露 ⇒ 必须有这道闸门。
#
# 判 FAIL 的判据（按 lead 冻结规格）：
#   · 任何 `ERROR:`（"缺 IP/黑盒导致 elaborate 失败"除外 —— 那种算 SKIP，见下）
#   · [Synth 8-6859] multi-driven net
#   · [Synth 8-6858] multi-driven net ... constant driver
#   · [Synth 8-295]  found timing loop
#
# 做法（两阶段，兼顾"快"和"兜得住"）：
#   阶段 1：**单模块 out-of-context 综合**（`synth_design -top <mod> -mode out_of_context`），
#           依赖文件一次性全给（工程内 62 个 .v 无重名，已实测），可并行。
#   阶段 2：阶段 1 里因"缺 IP/黑盒"失败的模块（如 clk_rst_gen 缺 clk_wiz_0、
#           display_path 缺 mig_7series_0），**带上工程 IP（.xci）复跑一次**。
#           ⚠️ 这一步必须做：顶层那条 [Synth 8-295] timing loop 只有在
#           `top_retina_event` 能真正 elaborate（即 clk_wiz_0/MIG 在位）时才会暴露，
#           不带 IP 的 OOC 综合会"失败得干干净净"，闸门形同虚设。
#
# 用法：
#   pwsh -NoProfile -File tool\check_synth_warnings.ps1                     # 全部 src/hdl 模块
#   pwsh -NoProfile -File tool\check_synth_warnings.ps1 -Top udp_merge      # 只查一个
#   pwsh -NoProfile -File tool\check_synth_warnings.ps1 -Files 'src/hdl/comms/*.v'
#   pwsh -NoProfile -File tool\check_synth_warnings.ps1 -Report build\synth_chk.txt -Jobs 4
#   pwsh -NoProfile -File tool\check_synth_warnings.ps1 -NoIpRetry          # 只跑阶段 1（快）
#
# 输出（行首锚定，便于 grep）：
#   CHK_MODULES=<n>  CHK_ERRORS=<n>  CHK_CRIT=<n>
#   CHK_BAD=<MODULE>:<ERROR_CODE>      ← 每个"模块+错误码"一行；没有就不打印
#   CHK_SKIP=<MODULE>:<REASON>         ← 依赖 IP/黑盒缺失（且未复跑成功），未判定
#   CHK_RESULT=OK|FAIL
#
# 退出码：0 = 干净；1 = 有 FAIL 判据；2 = 用法/环境错误
#==============================================================================
[CmdletBinding()]
param(
    [string[]]$Files,                       # 要检查的 RTL（默认 src/hdl/**/*.v）
    [string[]]$Deps,                        # 额外依赖文件（默认 ref_original/**/*.v）
    [string]$Top,                           # 只检查指定模块
    [string]$Report,                        # 报告输出路径（同时打印到控制台）
    [int]$Jobs = 3,                         # 并行 Vivado 进程数
    [int]$TimeoutSec = 900,                 # 单模块综合超时
    [string[]]$Ip,                          # IP .xci（默认自动发现 prj/.../ip/*/*.xci）
    [switch]$NoIpRetry,                     # 跳过阶段 2（缺 IP 的模块直接记 SKIP）
    [switch]$KeepLog                        # 保留每个模块的完整日志（默认就在 build\synth_chk\）
)

$ErrorActionPreference = 'Stop'

$root   = Split-Path -Parent $PSScriptRoot            # retina_event\
$vivado = 'E:\Programs\Xilinx\Vivado\2020.2\bin\vivado.bat'
$part   = 'xc7a100tfgg484-2'
$work   = Join-Path $root 'build\synth_chk'

# 判 FAIL 的告警码（lead 冻结）
$failCodes = @('Synth 8-6859', 'Synth 8-6858', 'Synth 8-295')

if (-not (Test-Path $vivado)) {
    Write-Host "[FAIL] 找不到 Vivado: $vivado" -ForegroundColor Red
    exit 2
}

# ---------------------------------------------------------------------------
# 1. 解析文件集
# ---------------------------------------------------------------------------
function Resolve-Globs([string[]]$patterns) {
    $out = @()
    # ⚠️ `pwsh -File script.ps1 -Files a,b` 里逗号**不会**被拆成数组（-File 模式全是字符串），
    #    所以这里自己按逗号再拆一次，两种调用方式都能用。
    $flat = @()
    foreach ($p0 in $patterns) { $flat += ($p0 -split ',') }
    foreach ($p in ($flat | Where-Object { $_ -and $_.Trim() -ne '' })) {
        $p = $p.Trim()
        $full = if ([IO.Path]::IsPathRooted($p)) { $p } else { Join-Path $root $p }
        if (Test-Path $full -PathType Leaf) {
            $out += @(Resolve-Path $full | ForEach-Object { $_.Path })
            continue
        }
        $dir = Split-Path -Parent $full
        $pat = Split-Path -Leaf $full
        if (-not (Test-Path $dir)) { continue }
        $out += @(Get-ChildItem -Path $dir -Filter $pat -File -ErrorAction SilentlyContinue |
                  ForEach-Object { $_.FullName })
    }
    return @($out | Select-Object -Unique)
}

if ($Files) { $checkFiles = Resolve-Globs $Files }
else        { $checkFiles = @(Get-ChildItem (Join-Path $root 'src\hdl') -Recurse -Filter *.v -File |
                              ForEach-Object { $_.FullName }) }
if ($Deps) { $depExtra = Resolve-Globs $Deps }
else       { $depExtra = @(Get-ChildItem (Join-Path $root 'ref_original') -Recurse -Filter *.v -File -ErrorAction SilentlyContinue |
                           ForEach-Object { $_.FullName }) }

# 依赖集 = 待检文件 + src/hdl 全树 + ref_original（工程内 62 个 .v 无重名，已实测）
$srcAll   = @(Get-ChildItem (Join-Path $root 'src\hdl') -Recurse -Filter *.v -File -ErrorAction SilentlyContinue |
              ForEach-Object { $_.FullName })
$allFiles = @(@($checkFiles) + $srcAll + $depExtra | Select-Object -Unique)

if ($checkFiles.Count -eq 0) { Write-Host '[FAIL] 没有匹配到任何 RTL 文件' -ForegroundColor Red; exit 2 }

# ---------------------------------------------------------------------------
# 2. 模块名（一个文件一个模块；同名去重并告警）
# ---------------------------------------------------------------------------
$mods = @()
$seen = @{}
foreach ($f in $checkFiles) {
    $txt = Get-Content -Raw -Encoding UTF8 $f
    $m = [regex]::Match($txt, '(?m)^\s*module\s+([A-Za-z_]\w*)')
    if (-not $m.Success) { Write-Host "[warn] 未找到 module 声明: $f" -ForegroundColor Yellow; continue }
    $name = $m.Groups[1].Value
    if ($seen.ContainsKey($name)) { Write-Host "[warn] 模块名重复: $name" -ForegroundColor Yellow; continue }
    $seen[$name] = $f
    $mods += [pscustomobject]@{ Name = $name; File = $f; Tcl = ''; Log = '' }   # Tcl/Log 占位：PSCustomObject 不能事后加属性
}
if ($Top) { $mods = @($mods | Where-Object { $_.Name -eq $Top }) }
if ($mods.Count -eq 0) { Write-Host "[FAIL] 没有可检查的模块（-Top $Top 没匹配上？）" -ForegroundColor Red; exit 2 }

# ---------------------------------------------------------------------------
# 3. IP 列表（阶段 2 用；按 IP 名去重，避免 4 份 MIG 副本都读）
# ---------------------------------------------------------------------------
if ($Ip) { $ipFiles = Resolve-Globs $Ip }
else {
    # ⚠️ 默认**排除 mig_7series_0**：在"非工程流 + read_ip"下 MIG 起不来
    #    （[Mig7series 79-134] Error in opening fpga xml file .../fpga_parts.xml），
    #    而且它会污染整个 Vivado 会话、把只需要 clk_wiz_0 的模块也一起带失败。
    #    MIG 依赖的模块（display_path / top_retina_event）本闸门只能记 SKIP —— 见文件头说明。
    $ipFiles = @(Get-ChildItem (Join-Path $root 'prj') -Recurse -Filter *.xci -File -ErrorAction SilentlyContinue |
                 Where-Object { $_.FullName -match '\\ip\\' -and $_.Name -notmatch '^mig_7series_0' } |
                 ForEach-Object { $_.FullName })
}
$ipKeep = @{}
$ipList = @()
foreach ($x in ($ipFiles | Sort-Object)) {
    $n = [IO.Path]::GetFileNameWithoutExtension($x)
    if (-not $ipKeep.ContainsKey($n)) { $ipKeep[$n] = $true; $ipList += $x }
}

# ---------------------------------------------------------------------------
# 4. 跑一批模块
# ---------------------------------------------------------------------------
if (Test-Path $work) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $work | Out-Null
$env:Path = (Split-Path -Parent $vivado) + ';' + $env:Path

function Run-Batch([object[]]$moduleList, [string[]]$ipForRun, [string]$tag) {
    if ($moduleList.Count -eq 0) { return @() }

    $readLines = ($allFiles | ForEach-Object { "read_verilog {$($_)}" }) -join "`n"
    $ipLines   = ($ipForRun | ForEach-Object { "read_ip {$($_)}" }) -join "`n"
    foreach ($m in $moduleList) {
        $tcl = @"
$ipLines
$readLines
puts "@@@SYNTH_BEGIN $($m.Name)"
synth_design -top $($m.Name) -part $part -mode out_of_context
puts "@@@SYNTH_DONE $($m.Name)"
"@
        $m.Tcl = Join-Path $work "$($m.Name)$tag.tcl"
        $m.Log = Join-Path $work "$($m.Name)$tag.log"
        Set-Content -Path $m.Tcl -Value $tcl -Encoding ASCII
    }

    $queue   = [System.Collections.Queue]::new()
    $moduleList | ForEach-Object { $queue.Enqueue($_) }
    $running = @()
    $results = @()

    while ($queue.Count -gt 0 -or $running.Count -gt 0) {
        while ($running.Count -lt $Jobs -and $queue.Count -gt 0) {
            $m = $queue.Dequeue()
            $proc = Start-Process -FilePath $vivado `
                -ArgumentList @('-mode', 'batch', '-nojournal', '-nolog', '-source', $m.Tcl) `
                -RedirectStandardOutput $m.Log -RedirectStandardError "$($m.Log).err" `
                -NoNewWindow -PassThru
            $running += [pscustomobject]@{ Mod = $m; Proc = $proc; Sw = [Diagnostics.Stopwatch]::StartNew() }
            if ($queue.Count -gt 0) { Start-Sleep -Seconds 3 }   # 错开启动：并行时 Vivado 会抢 unimacro*.tcl
        }
        Start-Sleep -Milliseconds 400
        $keep = @()
        foreach ($job in $running) {
            $r = Collect-Job $job
            if ($null -eq $r) { $keep += $job } else { $results += $r }
        }
        $running = $keep
    }
    return $results
}

function Collect-Job($job) {
    $p = $job.Proc
    $timedOut = $false
    if (-not $p.HasExited) {
        if ($job.Sw.Elapsed.TotalSeconds -gt $TimeoutSec) {
            try { $p.Kill() } catch { }
            $timedOut = $true
        } else {
            return $null                       # 还在跑
        }
    }
    if (-not $p.HasExited) { try { $p.WaitForExit(5000) | Out-Null } catch { } }

    $log = $job.Mod.Log
    # ⚠️ Vivado 把 `ERROR:` 写 **stderr**、把 summary/CRITICAL WARNING 写 stdout：
    #    只解析 stdout 会漏掉全部错误（曾实测：顶层 elaborate 失败却报 OK ⇒ 闸门形同虚设）。
    #    两个流都读，并按行去重避免同一行被计两次。
    $txt = ''
    if (Test-Path $log)          { $txt += (Get-Content -Raw $log) }
    if (Test-Path "$log.err")    { $txt += "`n" + (Get-Content -Raw "$log.err") }
    $lines = @($txt -split "`r?`n" | ForEach-Object { $_.Trim() } |
               Where-Object { $_ -ne '' } | Select-Object -Unique)

    $counts = @{}
    foreach ($code in $failCodes) {
        # 用 .Contains()：`-like "*[Synth 8-6859]*"` 里的 `[` 会被当成通配符类而报错
        $needle = "[$code]"
        $counts[$code] = (@($lines | Where-Object { $_.Contains($needle) })).Count
    }
    $errLines = @($lines | Where-Object { $_ -match '^ERROR:' })
    $errN     = $errLines.Count
    # 依赖缺失（IP/黑盒）→ SKIP：这类 ERROR 不是代码缺陷，而是"没有 IP 无法 elaborate"
    $depPat   = 'not found|not defined|is undefined|black box|unresolved|8-439|8-2543|8-3491|IP_Flow'
    $cascPat  = 'failed synthesizing module|Command failed:|8-6156'
    $depN     = (@($errLines | Where-Object { $_ -match $depPat })).Count
    $cascN    = (@($errLines | Where-Object { $_ -match $cascPat })).Count
    $isDep    = ($errN -gt 0) -and ($depN -ge 1) -and (($depN + $cascN) -eq $errN)
    $failN    = 0
    foreach ($code in $failCodes) { $failN += $counts[$code] }

    $missMods = @($errLines | ForEach-Object {
        $mm = [regex]::Match($_, "module '([^']+)' not found")
        if ($mm.Success) { $mm.Groups[1].Value }
    } | Select-Object -Unique)

    $status = if ($timedOut) { 'TIMEOUT' }
              elseif ($isDep) { 'SKIP' }
              elseif (($failN -gt 0) -or ($errN -gt 0)) { 'BAD' }
              else { 'OK' }

    # 基础设施抖动（并行跑 Vivado 时抢 `unimacro_*.tcl`，报 "couldn't read file ...: No error"
    # 后 synth_design failed，但**没有任何 Synth 代码错误**）⇒ 可重跑，不能当代码缺陷。
    $infra = ($status -eq 'BAD') -and ($failN -eq 0) -and
             ($txt -match "unimacro|couldn't read file")
    if ($infra) { $status = 'INFRA' }

    $reason = if ($timedOut) { 'timeout' }
              elseif ($isDep) { 'missing-ip:' + ($missMods -join '+') }
              elseif ($infra) { 'infra-flaky' }
              else { '' }

    return [pscustomobject]@{
        Name = $job.Mod.Name; Status = $status; Err = $errN
        C6859 = $counts['Synth 8-6859']; C6858 = $counts['Synth 8-6858']; C295 = $counts['Synth 8-295']
        Reason = $reason; Log = $log; Sec = [math]::Round($job.Sw.Elapsed.TotalSeconds, 1)
        WithIp = $false
    }
}

# ---------------------------------------------------------------------------
# 5. 阶段 1（不带 IP）→ 阶段 2（对缺 IP 的模块带 IP 复跑）
# ---------------------------------------------------------------------------
Write-Host ("[chk] 阶段1：待检模块 {0} 个，依赖文件 {1} 个，并行 {2}" -f $mods.Count, $allFiles.Count, $Jobs) -ForegroundColor Cyan
$results = @(Run-Batch $mods @() '')

if (-not $NoIpRetry) {
    $skipMods = @($mods | Where-Object { $n = $_.Name; ($results | Where-Object { $_.Name -eq $n -and $_.Status -eq 'SKIP' }).Count -gt 0 })
    if ($skipMods.Count -gt 0 -and $ipList.Count -gt 0) {
        Write-Host ("[chk] 阶段2：{0} 个模块缺 IP，带 {1} 个 .xci 复跑" -f $skipMods.Count, $ipList.Count) -ForegroundColor Cyan
        $r2 = @(Run-Batch $skipMods $ipList 'ip')
        foreach ($r in $r2) {
            $r.WithIp = $true
            $results = @($results | Where-Object { $_.Name -ne $r.Name }) + $r
        }
    }
}

# ---------------------------------------------------------------------------
# 5b. 阶段 3：基础设施抖动的模块 → 串行重跑一次（并行抢 unimacro 的假失败）
# ---------------------------------------------------------------------------
$infraMods = @($mods | Where-Object {
    $n = $_.Name
    @($results | Where-Object { $_.Name -eq $n -and $_.Status -eq 'INFRA' }).Count -gt 0
})
if ($infraMods.Count -gt 0) {
    Write-Host ("[chk] 阶段3：{0} 个模块疑似基础设施抖动，串行重跑" -f $infraMods.Count) -ForegroundColor Yellow
    $savedJobs = $Jobs
    $Jobs = 1
    # ⚠️ 重跑必须**带上 IP 列表**：阶段 2 的模块本来就缺 IP，
    #    不带 IP 重跑只会再报一次"模块未定义"，把它的结论从 OK 打成 SKIP（实测踩过）。
    $r3 = @(Run-Batch $infraMods $ipList 'retry')
    $Jobs = $savedJobs
    foreach ($r in $r3) {
        if ($r.Status -eq 'INFRA') {           # 重跑仍失败 ⇒ 不能再当抖动，报出来
            $r.Status = 'BAD'
            $r.Reason = 'infra-flaky-after-retry'
        }
        $results = @($results | Where-Object { $_.Name -ne $r.Name }) + $r
    }
}

# ---------------------------------------------------------------------------
# 6. 汇总 + 输出
# ---------------------------------------------------------------------------
# CHK_ERRORS 只统计**已判定**模块（OK/BAD）的错误；SKIP（缺 IP，没判定）的不计入，
# 否则"CHK_RESULT=OK"旁边挂着一个非零 CHK_ERRORS，读起来自相矛盾。
$nErr  = ($results | Where-Object { $_.Status -ne 'SKIP' } | Measure-Object -Property Err -Sum).Sum
$nCrit = ($results | Measure-Object -Property C6859 -Sum).Sum +
         ($results | Measure-Object -Property C6858 -Sum).Sum +
         ($results | Measure-Object -Property C295  -Sum).Sum
$nErr  = if ($null -eq $nErr)  { 0 } else { [int]$nErr }
$nCrit = if ($null -eq $nCrit) { 0 } else { [int]$nCrit }

$badLines  = @()
$skipLines = @()
foreach ($r in ($results | Sort-Object Name)) {
    if ($r.Status -eq 'BAD' -or $r.Status -eq 'TIMEOUT') {
        if ($r.Err -gt 0)   { $badLines += "CHK_BAD=$($r.Name):ERROR" }
        if ($r.C6859 -gt 0) { $badLines += "CHK_BAD=$($r.Name):Synth 8-6859" }
        if ($r.C6858 -gt 0) { $badLines += "CHK_BAD=$($r.Name):Synth 8-6858" }
        if ($r.C295  -gt 0) { $badLines += "CHK_BAD=$($r.Name):Synth 8-295" }
        if ($r.Status -eq 'TIMEOUT') { $badLines += "CHK_BAD=$($r.Name):TIMEOUT" }
    }
    elseif ($r.Status -eq 'SKIP') { $skipLines += "CHK_SKIP=$($r.Name):$($r.Reason)" }
}

$out = @()
$out += "CHK_MODULES=$($results.Count)  CHK_ERRORS=$nErr  CHK_CRIT=$nCrit"
$out += $badLines
$out += $skipLines
$out += "CHK_RESULT=" + $(if ($badLines.Count -eq 0) { 'OK' } else { 'FAIL' })

Write-Host ''
Write-Host '--- 逐模块明细（OK/SKIP/BAD，秒数，IP=带工程 IP 复跑）---' -ForegroundColor Cyan
foreach ($r in ($results | Sort-Object Name)) {
    $color = switch ($r.Status) { 'OK' { 'Green' } 'SKIP' { 'DarkGray' } default { 'Red' } }
    $ipMark = if ($r.WithIp) { 'IP' } else { '  ' }
    Write-Host ("  {0,-18} {1,-8} {2} err={3} 6859={4} 6858={5} 295={6} {7}s  {8}" -f `
        $r.Name, $r.Status, $ipMark, $r.Err, $r.C6859, $r.C6858, $r.C295, $r.Sec, $r.Reason) -ForegroundColor $color
}
Write-Host ''
$out | ForEach-Object { Write-Host $_ }

if ($Report) {
    $rp = if ([IO.Path]::IsPathRooted($Report)) { $Report } else { Join-Path $root $Report }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $rp) | Out-Null
    $detail = $results | Sort-Object Name | ForEach-Object {
        "  {0,-18} {1,-8} {2} err={3} 6859={4} 6858={5} 295={6} {7}s  {8}  {9}" -f `
            $_.Name, $_.Status, $(if ($_.WithIp) { 'IP' } else { '  ' }), $_.Err, $_.C6859, $_.C6858, $_.C295, $_.Sec, $_.Reason, $_.Log
    }
    Set-Content -Path $rp -Value (@("check_synth_warnings.ps1 报告 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
                                    "Vivado: $vivado  part: $part  jobs: $Jobs  ip: $($ipList.Count)",
                                    "判 FAIL: 任何 ERROR / Synth 8-6859 / 8-6858 / 8-295") + $out + '' + $detail) -Encoding UTF8
    Write-Host "[chk] 报告: $rp" -ForegroundColor Cyan
}

if ($badLines.Count -eq 0) { exit 0 } else { exit 1 }

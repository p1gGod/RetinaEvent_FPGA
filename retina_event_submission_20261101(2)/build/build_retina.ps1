# =============================================================================
# build_retina.ps1 —— retina_event 一键重建的 PowerShell 外壳（Vivado 2020.2）
#
# 用法（工程根 = retina_event\，或任意目录）：
#   pwsh -NoProfile -File tool\build_retina.ps1                 # 全量重建（进程内 综合→实现→比特流）
#   pwsh -NoProfile -File tool\build_retina.ps1 -DryRun         # 只做 RTL 语法/elaborate 检查
#   pwsh -NoProfile -File tool\build_retina.ps1 -Mode --runs    # 改用 launch_runs 流程（仅限不受限会话）
#   pwsh -NoProfile -File tool\build_retina.ps1 -Mode --resume  # 沿用综合产物，只重跑实现
#   pwsh -NoProfile -File tool\build_retina.ps1 -Jobs 8 -Program
#
# ★ 为什么默认"进程内"而不是 launch_runs：
#   本机沙箱拦住了 Vivado 的 run server（`rundef.js ... JavaScript runtime error: Access denied`），
#   `launch_runs` 流程在这里必然失败（实测：runme.log 只写一行就死）。进程内流程
#   （synth_design→opt_design→place_design→route_design→write_bitstream）不需要 run server，实测可用。
#   ⚠️ 也装不了"先试 launch_runs、失败自动回退"——run server 被拦时 `wait_on_run` **不返回**，
#      整个 vivado 进程直接退出，脚本没有机会执行回退分支。所以默认就是进程内。
#
# 判定：退出码 + 行首锚定的 ASCII 标记 BUILD_RESULT=OK。**不要** grep 中文日志。
#
# ⚠️ 两个本机踩过的坑（已固化）：
#   1. `-tclargs` 必须是整条命令行**最后一个**参数 —— 它后面的 token 会被脚本 argv 吞掉，
#      把 -log/-journal 写在它后面，日志就会跑到 CWD\vivado.log（实测踩过）。
#   2. 抽标记的正则必须行首锚定 `(?m)^` —— Vivado 会把执行过的 TCL 源码回显进日志，
#      不锚定就会命中注释里的 `BUILD_RESULT=SYNTH_FAILED`（实测踩过）。
#
# ⚠️ 本文件含中文 ⇒ 必须存成 **UTF-8 with BOM**（PowerShell 5.1 用 -File 跑无 BOM 的
#    UTF-8 会按 GBK 解码，中文吃掉收尾引号，报 "The string is missing the terminator"）。
#    而 build_retina.tcl / retina_event.xdc 必须**无 BOM**（XDC/TCL 带 BOM 会报
#    `invalid command name "\xEF\xBB\xBF"`）。两者要求相反，别搞错。
# =============================================================================
param(
    [ValidateSet('--full', '--inproc', '--runs', '--resume', '--dryrun')][string]$Mode = '--full',
    [int]$Jobs = 12,
    [switch]$DryRun,
    [switch]$Program
)

$ErrorActionPreference = 'Stop'
if ($DryRun) { $Mode = '--dryrun' }

$vivado = 'E:\Programs\Xilinx\Vivado\2020.2\bin\vivado.bat'
$here   = Split-Path -Parent $PSScriptRoot                  # retina_event\
$tcl    = Join-Path $here 'tool\build_retina.tcl'
$log    = Join-Path $here 'tool\build_retina.log'
$jou    = Join-Path $here 'tool\build_retina.jou'
$con    = Join-Path $here 'tool\build_retina.console.log'
$bit    = Join-Path $here 'build\retina_event.bit'
$top    = 'top_retina_event'

foreach ($p in @($vivado, $tcl)) {
    if (-not (Test-Path $p)) { Write-Host "[FATAL] 缺少必需文件: $p" -ForegroundColor Red; exit 1 }
}
if (-not (Test-Path (Join-Path $here 'build'))) { New-Item -ItemType Directory -Force -Path (Join-Path $here 'build') | Out-Null }

function Read-Txt([string]$f) {
    # 用 Latin-1 读：厂家 RTL 是 GBK，自研是 UTF-8；Latin-1 逐字节映射不会解码失败，
    # 而我们要匹配的 module/端口名全是 ASCII，不受影响。
    $bytes = [System.IO.File]::ReadAllBytes($f)
    return ([System.Text.Encoding]::GetEncoding(28591)).GetString($bytes)
}

# =============================================================================
# 阶段 0：不依赖 Vivado 的静态体检（秒级）—— 缺文件 / 重复模块 / 缺模块 / 端口
# =============================================================================
Write-Host ''
Write-Host '=== [0/3] RTL 静态体检（不启动 Vivado）===' -ForegroundColor Cyan

$refDir = Join-Path $here 'ref_original'
$hdlDir = Join-Path $here 'src\hdl'
$xdc    = Join-Path $here 'src\constraints\retina_event.xdc'

$refFiles = @(Get-ChildItem $refDir -Recurse -File -Include *.v,*.sv -EA SilentlyContinue)
$hdlFiles = @()
if (Test-Path $hdlDir) { $hdlFiles = @(Get-ChildItem $hdlDir -Recurse -File -Include *.v,*.sv,*.svh -EA SilentlyContinue) }

Write-Host ("  ref_original 厂家 RTL : {0} 个 .v" -f $refFiles.Count)
Write-Host ("  src/hdl      自研 RTL : {0} 个 .v" -f $hdlFiles.Count)

$allFiles = @($refFiles) + @($hdlFiles)
$declared = @{}          # module name -> file
$dups     = New-Object System.Collections.ArrayList
$insts    = @{}          # instantiated module -> first file that instantiates it

# Verilog 保留字（避免把 always/assign/... 误判成模块例化）
$kw = @('module','endmodule','always','always_ff','always_comb','initial','assign','wire','reg',
        'input','output','inout','parameter','localparam','generate','endgenerate','genvar','if',
        'else','case','endcase','begin','end','for','while','function','endfunction','task','endtask',
        'defparam','integer','real','time','signed','unsigned','default','posedge','negedge','or','and',
        'not','xor','nand','nor','xnor','buf','bufif0','bufif1','notif0','notif1','specify','endspecify',
        'primitive','endprimitive','table','endtable','typedef','logic','bit','byte','shortint','int',
        'longint','string','struct','union','enum','package','endpackage','import','export','return',
        'automatic','static','const','var','void','break','continue','do','foreach','repeat','forever',
        'wait','disable','fork','join','joint_any','join_none','force','release','deassign','assert',
        'assume','cover','property','endproperty','sequence','endsequence','modport','interface','endinterface',
        'class','endclass','extends','virtual','pure','extern','new','this','super','null','local','protected')

foreach ($f in $allFiles) {
    $txt = Read-Txt $f.FullName
    # ⚠️ 必须先剥注释：厂家 RTL 里有大量"注释掉的老例化"，不剥会报出
    #    cas / i / fo / u_arp_r 之类一堆假缺模块（实测踩过，20 条里 14 条是假的）。
    $txt = [regex]::Replace($txt, '(?s)/\*.*?\*/', ' ')
    $txt = [regex]::Replace($txt, '(?m)//.*$', ' ')

    foreach ($m in [regex]::Matches($txt, '(?m)^[ \t]*module[ \t]+([A-Za-z_][A-Za-z0-9_]*)')) {
        $name = $m.Groups[1].Value
        if ($declared.ContainsKey($name)) {
            [void]$dups.Add(("{0}  a={1}  b={2}" -f $name, $declared[$name], $f.FullName))
        } else { $declared[$name] = $f.FullName }
    }

    # 例化的三种写法（覆盖厂家 RTL 与可读风格；比"行首 类型 实例名 ("单条正则准得多：
    # 后者在参数表跨行时会退化成把**实例名截断一个字符**当成模块名，
    # 实测报出 u_i2c_dr / u_arp_r / u_gmii_to_rgmi 等 11 个假缺模块）
    #   A) 类型单独占一行：   mig_7series_0
    #   B) 类型 + 参数表：    rgmii_rx #(
    #   C) 单行 类型 实例名(  ddr3_rw u_ddr3_rw(
    $pats = @(
        '(?m)^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*$',
        '(?m)^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*#[ \t]*\(',
        '(?m)^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]*\([ \t]*$'
    )
    foreach ($p in $pats) {
        foreach ($m in [regex]::Matches($txt, $p)) {
            $t = $m.Groups[1].Value
            if ($kw -contains $t) { continue }
            if (-not $insts.ContainsKey($t)) { $insts[$t] = $f.FullName }
        }
    }
}

# Xilinx 原语 / 仿真原语不算缺模块
$prims = @('IBUF','OBUF','IOBUF','BUFG','BUFH','BUFIO','BUFR','IBUFDS','OBUFDS','IOBUFDS','IBUFG',
           'IBUFGDS','OBUFT','IBUFT','ODDR','IDDR','OSERDESE2','ISERDESE2','IDELAYE2','ODELAYE2',
           'IDELAYCTRL','MMCME2_ADV','MMCME2_BASE','PLLE2_ADV','PLLE2_BASE','BUFGMUX','BUFGCTRL',
           'BUFGCE','STARTUPE2','DNA_PORT','USR_ACCESSE2','XADC','IN_FIFO','OUT_FIFO','PHASER_IN_PHY',
           'PHASER_OUT_PHY','PHASER_REF','PHY_CONTROL','OSERDESE2_ADV','GTPE2_CHANNEL','GTPE2_COMMON',
           'IBUFDS_GTE2','PCIE_2_1','DSP48E1','RAMB36E1','RAMB18E1','SRL16E','SRLC32E','FDRE','FDCE',
           'LUT1','LUT2','LUT3','LUT4','LUT5','LUT6','MUXF7','MUXF8','CARRY4','GND','VCC','OBUFDS_GTE2',
           'IODELAYE1','OSERDESE1','ISERDESE1','BSCANE2','EFUSE_USR','SYSMON','MMCME2','PLLE2')

$missing = @()
foreach ($k in ($insts.Keys | Sort-Object)) {
    if ($declared.ContainsKey($k)) { continue }
    if ($prims -contains $k) { continue }
    # 全大写的标识符多半是 Xilinx 原语 / 宏，不当缺模块报（降噪）
    if ($k -cmatch '^[A-Z][A-Z0-9_]*$') { continue }
    $missing += ("{0}   (首次出现于 {1})" -f $k, $insts[$k])
}

Write-Host ("  声明模块 : {0} 个" -f $declared.Count)
if ($dups.Count -gt 0) {
    Write-Host ("  [!!] 重复模块名 {0} 个（一个工程只能有一份，否则 module already defined）:" -f $dups.Count) -ForegroundColor Yellow
    foreach ($d in $dups) { Write-Host ("       {0}" -f $d) -ForegroundColor Yellow }
} else { Write-Host '  重复模块名 : 0（OK）' }

if ($missing.Count -gt 0) {
    Write-Host ("  [!!] 未解析的模块例化 {0} 个（自研 RTL 还没写完时属于预期；含 IP 与 XPM 宏）:" -f $missing.Count) -ForegroundColor Yellow
    foreach ($m in $missing) { Write-Host ("       {0}" -f $m) -ForegroundColor Yellow }
} else { Write-Host '  未解析例化 : 0（全部模块都能找到）' }

# 按设计文档的 36 模块清单核对"还差哪些没写"
#   来源：retina_event\docs\01_模块划分与总体框图.md §2（L0~L4 共 36 个模块）
$inv = @('clk_rst_gen','sys_ctrl',
         'sync_ff','delay_pipe','line_buffer','axis_fifo','edge_detect',
         'cam_tap','vps_resample','vps_pattern_gen','vps_mux',
         'px_luma','luma_log','temporal_diff','spatial_lap','event_gen','refractory','stats_counter',
         'hud_stack','hud_grid','hud_event_layer','hud_panel','hud_text','hud_sprite','font_rom',
         'lcd_scanout','disp_mux','event_render','hud_inject',
         'udp_merge','eth_udp','uart_telemetry',
         'display_path','retina_core','event_sink','top_retina_event')
$invMissing = @($inv | Where-Object { -not $declared.ContainsKey($_) } | Sort-Object)
Write-Host ("  设计文档 36 模块清单 : 已声明 {0}/36，仍缺 {1} 个" -f ($inv.Count - $invMissing.Count), $invMissing.Count)
if ($invMissing.Count -gt 0) { Write-Host ("       {0}" -f ($invMissing -join ' ')) -ForegroundColor Yellow }
$invExtra = @($declared.Keys | Where-Object { $_ -notin $inv } | Sort-Object)
if ($invExtra.Count -gt 0) {
    Write-Host ("  清单外已声明模块 {0} 个（自研新增/IP 封装，不算错）：{1}" -f $invExtra.Count, ($invExtra -join ' ')) -ForegroundColor DarkGray
}

# 顶层存在性 + 端口表交叉核对
$topFile = Join-Path $hdlDir "top\$top.v"
if (-not (Test-Path $topFile)) {
    # 兜底：全树搜索声明该模块的文件
    foreach ($f in $hdlFiles) {
        if ((Read-Txt $f.FullName) -match ("(?m)^[ \t]*module[ \t]+$top\b")) { $topFile = $f.FullName; break }
    }
}
if (Test-Path $topFile) {
    Write-Host ("  顶层文件 : {0}" -f $topFile)
    $ttxt = Read-Txt $topFile
    # ⚠️ 必须先剥注释再解析端口：厂家/自研顶层端口声明后常跟 `// R4 50MHz` 这类注释，
    #    不剥会把注释里的引脚号(W7/V7/N20…)当成端口名，实测报出 39 个假端口。
    $ttxt = [regex]::Replace($ttxt, '(?s)/\*.*?\*/', ' ')
    $ttxt = [regex]::Replace($ttxt, '(?m)//.*$', ' ')
    $idx = $ttxt.IndexOf("module $top")
    $ports = @()
    if ($idx -ge 0) {
        $sub = $ttxt.Substring($idx)
        $end = $sub.IndexOf(');')
        if ($end -lt 0) { $end = [Math]::Min(4000, $sub.Length - 1) }
        $hdr = $sub.Substring(0, $end)
        # ANSI 风格：input/output/inout [wire|reg] [宽度] <name>
        $ports = @([regex]::Matches($hdr, '\b(?:input|output|inout)\b[^,;()]*?\b([A-Za-z_][A-Za-z0-9_]*)\s*(?=,|$|\))') |
                   ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
        if ($ports.Count -eq 0) {
            # 非 ANSI 风格（只有端口名列表）的兜底
            $ports = @([regex]::Matches($hdr, '(?m)(?:^|[,\(\s])([A-Za-z_][A-Za-z0-9_]*)\s*(?:,|$|\))') |
                       ForEach-Object { $_.Groups[1].Value } |
                       Where-Object { $_ -and ($_.ToLower() -notin 'module','input','output','inout','wire','reg','logic','signed','unsigned','parameter','localparam', $top.ToLower()) } |
                       Select-Object -Unique)
        }
    }
    Write-Host ("  顶层端口 : {0} 个（ANSI 声明提取）" -f $ports.Count)
    Write-Host ("       {0}" -f ($ports -join ' '))

    if (Test-Path $xdc) {
        $xtxt = Read-Txt $xdc
        $xports = @([regex]::Matches($xtxt, '(?m)^#\s*RETE_PORT\|([^|]+)\|') | ForEach-Object { $_.Groups[1].Value })
        $base = { param($p) ($p -replace '\[\d+\]$','') }
        $xs = @($xports | ForEach-Object { & $base $_ } | Select-Object -Unique)
        $ts = @($ports   | ForEach-Object { & $base $_ } | Select-Object -Unique)
        $xOnly = @($xs | Where-Object { $_ -notin $ts })
        $tOnly = @($ts | Where-Object { $_ -notin $xs })
        Write-Host ("  XDC 端口契约 : {0} 条 / {1} 个不同基名" -f $xports.Count, $xs.Count)
        if ($xOnly.Count -gt 0) {
            Write-Host ("  [!!] XDC 有约束、顶层疑似没有的端口 {0} 个：" -f $xOnly.Count) -ForegroundColor Yellow
            Write-Host ("       {0}" -f ($xOnly -join ' ')) -ForegroundColor Yellow
        } else { Write-Host '  XDC->顶层 : 全部对得上（OK）' }
        if ($tOnly.Count -gt 0) {
            Write-Host ("  [!!] 顶层有、XDC 没约束的端口 {0} 个（会变成未约束 I/O ⇒ DRC UCIO-1）：" -f $tOnly.Count) -ForegroundColor Yellow
            Write-Host ("       {0}" -f ($tOnly -join ' ')) -ForegroundColor Yellow
        } else { Write-Host '  顶层->XDC : 全部有约束（OK）' }
    }
} else {
    Write-Host ("  [!!] 顶层文件不存在: src\hdl\top\$top.v —— elaborate 一定会失败（自研 RTL 还没交付时属预期）") -ForegroundColor Yellow
}

# =============================================================================
# 阶段 1：调用 Vivado
# =============================================================================
Write-Host ''
Write-Host ("=== [1/3] Vivado 2020.2 ({0}, jobs={1}) ===" -f $Mode, $Jobs) -ForegroundColor Cyan

# ⚠️ -tclargs 必须放最后
$cmdLine = '"{0}" -mode batch -source "{1}" -log "{2}" -journal "{3}" -tclargs {4} {5}' `
           -f $vivado, $tcl, $log, $jou, $Mode, $Jobs
Write-Host "  命令: $cmdLine"

$sw = [Diagnostics.Stopwatch]::StartNew()
& cmd /c $cmdLine > $con 2>&1
$code = $LASTEXITCODE
$sw.Stop()

# =============================================================================
# 阶段 2：解析 ASCII 标记（行首锚定）
# =============================================================================
Write-Host ''
$txt = Get-Content $con -Raw -Encoding UTF8

function Get-Mark([string]$key) {
    $m = [regex]::Match($txt, ("(?m)^{0}=(\S+)" -f [regex]::Escape($key)))
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}
function Get-AllMarks([string]$key) {
    return [regex]::Matches($txt, ("(?m)^{0}=(.*)$" -f [regex]::Escape($key))) | ForEach-Object { $_.Groups[1].Value }
}

$result = Get-Mark 'BUILD_RESULT'

Write-Host ("=== [2/3] 结果: 退出码={0}  耗时={1:n1} 分钟  BUILD_RESULT={2} ===" -f $code, $sw.Elapsed.TotalMinutes, $result) -ForegroundColor Cyan

foreach ($k in 'BUILD_VIVADO', 'BUILD_PART', 'BUILD_PART_USED', 'BUILD_MODE', 'BUILD_TOP', 'BUILD_FLOW',
               'BUILD_NREF', 'BUILD_NHDL', 'BUILD_NMODULES', 'BUILD_TOP_FILE_EXISTS', 'BUILD_NIPS',
               'BUILD_GEN_TARGET_OK', 'BUILD_GEN_TARGET_FAIL',
               'BUILD_SRC_MGMT_MODE', 'BUILD_SRCSET_AFTER_REMOVE', 'BUILD_SRCSET_AFTER_ADD',
               'BUILD_SYNTH_OK', 'BUILD_SYNTH_CELLS', 'BUILD_SYNTH_PIN_APPLY_FAILS', 'BUILD_IMPL',
               'BUILD_SYNTH_STATUS', 'BUILD_SYNTH_REUSED',
               'BUILD_IMPL_STATUS',
               'BUILD_WNS', 'BUILD_WHS', 'BUILD_TNS', 'BUILD_THS',
               'BUILD_LUT', 'BUILD_FF', 'BUILD_BRAM', 'BUILD_DSP',
               'BUILD_DRC_ERRORS', 'BUILD_DRC_CRITICAL_WARNINGS', 'BUILD_DRC_WARNINGS', 'BUILD_DRC_VIOLATIONS_TOTAL',
               'BUILD_SYNTH_DCP',
               'BUILD_CLOCKS', 'BUILD_NCLOCKS',
               'BUILD_CLK_LCD_PRESENT', 'BUILD_CLK_LCD_PERIOD', 'BUILD_CLK_LCD_SOURCE',
               'BUILD_CLK_out1_clk_wiz_0', 'BUILD_CLK_out2_clk_wiz_0',
               'BUILD_CDC_CAM_TO_SYS_PATHS', 'BUILD_CDC_SYS_TO_CAM_PATHS', 'BUILD_CDC_WARNING', 'BUILD_CDC_PATH_QUERY_SKIPPED',
               'BUILD_NPORTS', 'BUILD_XDC_CONTRACT', 'BUILD_XDC_CONTRACT_MATCHED', 'BUILD_XDC_CONTRACT_MISSING', 'BUILD_PORT_EXTRA_COUNT',
               'BUILD_PIN_CHECKED', 'BUILD_PIN_CHECK_FAILS', 'BUILD_PORT_MISSING_COUNT', 'BUILD_PORT_UNCONSTRAINED_COUNT',
               'BUILD_BITSTREAM_FILE',
               'BUILD_BIT_SRC', 'BUILD_BIT_DST', 'BUILD_BIT_BYTES', 'BUILD_BIT_MD5') {
    $v = Get-Mark $k
    if ($v -ne '') { Write-Host ("   {0,-34} = {1}" -f $k, $v) }
}

foreach ($k in 'BUILD_PORT_MISSING', 'BUILD_PORT_EXTRA', 'BUILD_PORT_UNCONSTRAINED',
               'BUILD_PIN_CHECK_FAIL', 'BUILD_IOSTD_CHECK_FAIL', 'BUILD_DUP_MODULE',
               'BUILD_REMOVE_CONSTR', 'BUILD_ELAB_ERROR', 'BUILD_SET_TOP_FAIL',
               'BUILD_SYNTH_ERROR', 'BUILD_OPT_ERROR', 'BUILD_PLACE_ERROR', 'BUILD_ROUTE_ERROR',
               'BUILD_BITSTREAM_ERROR', 'BUILD_SYNTH_PIN_NOT_APPLIED', 'BUILD_TIMING_SUMMARY_FAIL') {
    $vs = @(Get-AllMarks $k)
    if ($vs.Count -gt 0) {
        $color = if ($k -in 'BUILD_REMOVE_CONSTR') { 'DarkGray' } else { 'Yellow' }
        Write-Host ("   --- {0} ({1}) ---" -f $k, $vs.Count) -ForegroundColor $color
        foreach ($v in ($vs | Select-Object -First 60)) { Write-Host ("       {0}" -f $v) -ForegroundColor $color }
    }
}

Write-Host ''
Write-Host '=== [3/3] Vivado 日志里的 ERROR / CRITICAL WARNING ==='
$errs = @([regex]::Matches($txt, '(?m)^ERROR:.*$') | ForEach-Object { $_.Value } | Select-Object -Unique)
$cws  = @([regex]::Matches($txt, '(?m)^CRITICAL WARNING:.*$') | ForEach-Object { $_.Value } |
          Where-Object { $_ -notmatch '17-741' } | Select-Object -Unique)
Write-Host ("  ERROR            : {0} 条" -f $errs.Count)
foreach ($e in ($errs | Select-Object -First 30)) { Write-Host ("     {0}" -f $e) -ForegroundColor Red }
Write-Host ("  CRITICAL WARNING : {0} 条（去重；端口/时钟对不上时会出现在这里）" -f $cws.Count)
foreach ($w in ($cws | Select-Object -First 30)) { Write-Host ("     {0}" -f $w) -ForegroundColor Yellow }

# ---- 已知可接受项（Lead 已裁定：不改 RTL，但要写进交付记录）----------------
$known = @(
    @{ pat = '8-6896'; note = 'temporal_diff 帧存 initial 块超 loop limit 被忽略（已知偏差：BRAM 未初始化=0，且 i_first_frame 本就抑制首帧）' },
    @{ pat = 'TFMPC';  note = 'u_event_sink 的 o_ev_dbg_x/y/valid 故意悬空（留给 ILA），预期行为' }
)
foreach ($kn in $known) {
    $hits = @([regex]::Matches($txt, ("(?m)^.*{0}.*$" -f [regex]::Escape($kn.pat))) |
              ForEach-Object { $_.Value.Trim() } | Select-Object -Unique)
    if ($hits.Count -gt 0) {
        Write-Host ("  [已知可接受] {0}（命中 {1} 条）" -f $kn.note, $hits.Count) -ForegroundColor DarkGray
        foreach ($h in ($hits | Select-Object -First 3)) { Write-Host ("       {0}" -f $h) -ForegroundColor DarkGray }
    }
}

Write-Host ("  完整日志: {0}" -f $log)
Write-Host ("  控制台日志: {0}" -f $con)

# =============================================================================
# 判定
# =============================================================================
if ($Mode -eq '--dryrun') {
    if ($code -ne 0 -or $result -ne 'OK') {
        Write-Host ''
        Write-Host ("DryRun 失败：BUILD_RESULT={0}（脚本**没有**修改任何 RTL，请看上面 ERROR 与缺模块清单）" -f $result) -ForegroundColor Red
        exit 2
    }
    Write-Host ''
    Write-Host 'DryRun 通过：RTL 语法/elaborate 检查 OK。' -ForegroundColor Green
    if ($Program) { Write-Host '  （-DryRun 与 -Program 同时给出，忽略 -Program）' -ForegroundColor DarkGray }
    exit 0
}

if ($code -ne 0 -or $result -ne 'OK') {
    Write-Host ''
    Write-Host ("构建失败 (exit={0}, BUILD_RESULT={1})。看 {2}" -f $code, $result, $log) -ForegroundColor Red
    exit 2
}
if (-not (Test-Path $bit)) { Write-Host "构建报成功但未见比特流: $bit" -ForegroundColor Red; exit 3 }

$h = (Get-FileHash $bit -Algorithm MD5).Hash
Write-Host ''
Write-Host ("比特流: {0}" -f $bit) -ForegroundColor Green
Write-Host ("        {0} bytes   md5={1}" -f (Get-Item $bit).Length, $h) -ForegroundColor Green

if ($Program) {
    $ptcl = Join-Path $here 'tool\program_retina.tcl'
    if (-not (Test-Path $ptcl)) { Write-Host "缺少 $ptcl" -ForegroundColor Red; exit 4 }
    Write-Host ''
    Write-Host '=== JTAG 烧录（6 MHz）===' -ForegroundColor Cyan
    $pcmd = '"{0}" -mode batch -source "{1}" -log "{2}" -journal "{3}" -tclargs "{4}"' `
            -f $vivado, $ptcl, (Join-Path $here 'tool\program_retina.log'), (Join-Path $here 'tool\program_retina.jou'), $bit
    & cmd /c $pcmd
    if ($LASTEXITCODE -ne 0) { Write-Host "烧录失败 exit=$LASTEXITCODE" -ForegroundColor Red; exit 5 }
    Write-Host '已烧录到板卡' -ForegroundColor Green
}
exit 0

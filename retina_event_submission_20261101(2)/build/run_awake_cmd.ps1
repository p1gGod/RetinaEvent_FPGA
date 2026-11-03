# =============================================================================
# run_awake_cmd.ps1 -- run ANY command line with system sleep blocked.
#
# WHY: on this host the AC standby timeout is 30 minutes (powercfg shows
#   STANDBYIDLE AC = 0x708 = 1800 s). A frozen-then-timed-out build is very easy
#   to misread as an RTL failure (see fpga-builder-amd skill, iron rule 3).
#   E:\Tools\FPGABuilder_AMD\scripts\run_awake.ps1 only wraps `fpgab.bat`;
#   this wrapper takes a raw command line so direct `vivado.bat -mode batch`
#   invocations get the same protection.
#
# USAGE (CWD is inherited by the child, so pass -workdir when you need one):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tool\run_awake_cmd.ps1 ^
#       -CommandLine '"E:\Programs\Xilinx\Vivado\2020.2\bin\vivado.bat" -mode batch ...'
#
# The command line is handed to `cmd /c` verbatim, so quotes/args pass through
# unchanged (no PowerShell parameter binding on the child's own switches).
#
# KEEP THIS FILE PURE ASCII: a UTF-8-without-BOM .ps1 containing Chinese is
# decoded as GBK by PowerShell 5.1 -File and can fail with
# "The string is missing the terminator".
# =============================================================================
param(
    [Parameter(Mandatory = $true)]
    [string] $CommandLine
)

$ErrorActionPreference = 'Continue'

Add-Type -Namespace AwakeCmd -Name Power -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@

# 0x80000000 | 0x00000001 ; as unsigned literals (PowerShell would otherwise
# fold them into a negative Int32 and the P/Invoke binding would reject it).
[uint32] $FLAGS_ON  = 2147483649
[uint32] $FLAGS_OFF = 2147483648

Write-Host "[awake] sleep blocked; cwd=$((Get-Location).Path)"
Write-Host "[awake] cmd: $CommandLine"
$prev = [AwakeCmd.Power]::SetThreadExecutionState($FLAGS_ON)
if ($prev -eq 0) { Write-Host '[awake] WARN: SetThreadExecutionState failed (host may still sleep)' }

$rc = 1
try {
    & cmd /c $CommandLine
    $rc = $LASTEXITCODE
    if ($null -eq $rc) { $rc = 0 }
} finally {
    [void][AwakeCmd.Power]::SetThreadExecutionState($FLAGS_OFF)
    Write-Host "[awake] released; exit code = $rc"
}
exit $rc

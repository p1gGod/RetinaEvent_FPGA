# =============================================================================
# build_ila_variant.ps1 -- build the ILA debug variant with system sleep blocked.
#
# WHY: the AC standby timeout on this host is 30 minutes; a frozen-then-timed-out
#   build is very easy to misread as an RTL failure (fpga-builder-amd skill, rule 3).
#   tool\run_awake_cmd.ps1 exists but the nested quoting needed to also set the
#   RETE_* environment variables gets unreadable -- this script sets them directly.
#
# Product goes to build\variant_ila\ (RETE_TAG=ila) and does NOT overwrite the
# delivery bitstream build\retina_event.bit.
#
# KEEP THIS FILE PURE ASCII (a UTF-8-without-BOM .ps1 containing Chinese is decoded
# as GBK by PowerShell 5.1 -File and can fail with "missing the terminator").
# =============================================================================
$ErrorActionPreference = 'Continue'

Add-Type -Namespace AwakeIla -Name Power -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
[uint32] $FLAGS_ON  = 2147483649
[uint32] $FLAGS_OFF = 2147483648

$root = Split-Path -Parent $PSScriptRoot          # retina_event\
Set-Location $root

$env:RETE_GENERICS = 'ILA_EN=1'
$env:RETE_TAG      = 'ila'
Write-Host "[ila] RETE_GENERICS=$env:RETE_GENERICS  RETE_TAG=$env:RETE_TAG  cwd=$root"

$vivado = 'E:\Programs\Xilinx\Vivado\2020.2\bin\vivado.bat'
if (-not (Test-Path $vivado)) { Write-Host "[ila] FAIL: vivado not found: $vivado"; exit 2 }

[void][AwakeIla.Power]::SetThreadExecutionState($FLAGS_ON)
$rc = 1
try {
    & $vivado -mode batch -source tool\build_inproc.tcl -log tool\build_ila.log -tclargs --full
    $rc = $LASTEXITCODE
    if ($null -eq $rc) { $rc = 0 }
} finally {
    [void][AwakeIla.Power]::SetThreadExecutionState($FLAGS_OFF)
}
Write-Host "ILA_BUILD_EXIT=$rc"
exit $rc

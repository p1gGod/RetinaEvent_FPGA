# =============================================================================
# check_eth_onboard.ps1 -- on-board ethernet bring-up check for retina_event.
#
# WHAT IT PROVES (each step is independently falsifiable):
#   1. ARP     -- the board answers ARP for its own IP => RGMII RX/TX + PHY are alive
#   2. ICMP    -- ping round-trips => the vendor UDP/ARP stack in eth_udp.v runs
#   3. UDP     -- retina_event's merged stream (MAGIC F0 5A A5 0F, port 1234) arrives
#                 and reassembles into whole 768000-byte frames with valid CRC16
#
# WHY adapter counters are also read: the Windows firewall may silently drop
#   inbound UDP, in which case a socket listener sees nothing even though the
#   packets did arrive. ReceivedUnicastPackets still moves in that case, so the
#   counter delta separates "board sent nothing" from "host dropped it".
#
# USAGE (run from anywhere; the project root is derived from this file's path):
#   pwsh -NoProfile -File tool\check_eth_onboard.ps1
#   pwsh -NoProfile -File tool\check_eth_onboard.ps1 -UdpSeconds 12 -SkipUdp
#
# Markers are line-anchored ASCII (see fpga-builder-amd skill trap 13).
# KEEP THIS FILE PURE ASCII: a UTF-8-without-BOM .ps1 with Chinese is decoded as
#   GBK by PowerShell 5.1 -File and can fail with a missing-terminator error.
# =============================================================================
param(
    [string] $BoardIp    = '192.168.1.10',
    [string] $PcIp       = '192.168.1.102',
    [int]    $UdpSeconds = 8,
    [int]    $PingCount  = 4,
    [switch] $SkipUdp,
    [string] $Python     = ''
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
$rcv  = Join-Path $root 'tool\receive_udp.py'

function Line([string]$k, $v) { Write-Host ("{0}={1}" -f $k, $v) }

Write-Host "=== retina_event on-board ethernet check ==="
Line 'VERIFY_BOARD_IP' $BoardIp
Line 'VERIFY_PC_IP'    $PcIp

# ---- 0. which local NIC owns the PC IP? (avoids matching a localized name) ----
$ifIdx = $null
try {
    $ifIdx = (Get-NetIPAddress -AddressFamily IPv4 -IPAddress $PcIp -ErrorAction Stop |
              Select-Object -First 1).InterfaceIndex
} catch { }
Line 'VERIFY_IFINDEX' $(if ($ifIdx) { $ifIdx } else { 'NONE' })
if (-not $ifIdx) { Line 'VERIFY_RESULT' 'NO_PC_NIC'; exit 2 }

$adapter = Get-NetAdapter -InterfaceIndex $ifIdx -ErrorAction SilentlyContinue
$adapterName = if ($adapter) { $adapter.Name } else { '' }
Line 'VERIFY_ADAPTER' $(if ($adapter) { $adapter.Name } else { 'UNKNOWN' })
Line 'VERIFY_LINK'    $(if ($adapter) { $adapter.Status } else { 'UNKNOWN' })

# ---- 0b. proxy/VPN TUN guard ----------------------------------------------
# MEASURED TRAP (2026-10-06): this host runs a Clash-style proxy with a TUN
# adapter ("Meta", 198.18.0.1/30) whose default route has metric 0. It wins over
# the LAN route for 192.168.1.0/24, so a plain `ping 192.168.1.10` is answered
# by the local proxy (TTL=64, <1ms, no ARP entry) and looks like a healthy board
# while the board is actually silent. Every network probe below is therefore
# source-bound to $PcIp so it egresses the real NIC.
$egress = $null
try {
    $egress = (Find-NetRoute -RemoteIPAddress $BoardIp -ErrorAction Stop |
               Select-Object -First 1).InterfaceAlias
} catch { }
Line 'VERIFY_EGRESS_IF' $(if ($egress) { $egress } else { 'UNKNOWN' })
if ($egress -and $adapterName -and $egress -ne $adapterName) {
    Line 'VERIFY_WARN' "unbound traffic to $BoardIp egresses '$egress', not '$adapterName' (proxy/VPN TUN) -> probes are source-bound to $PcIp"
}

function Get-RxUnicast {
    if (-not $adapterName) { return -1 }
    $s = Get-NetAdapterStatistics -Name $adapterName -ErrorAction SilentlyContinue
    if ($s) { return [int64]$s.ReceivedUnicastPackets }
    return -1
}

# ---- 1. ARP ---------------------------------------------------------------
# Get-NetNeighbor (not `arp -a`): it reports the MAC *and* the state, so a stale
# or proxy-generated entry cannot be mistaken for a real ARP reply.
function Get-Neighbor([string]$ip) {
    return Get-NetNeighbor -AddressFamily IPv4 -IPAddress $ip -ErrorAction SilentlyContinue |
           Where-Object { $_.InterfaceIndex -eq $ifIdx } | Select-Object -First 1
}
function NeighborLine($n) {
    if (-not $n) { return 'ABSENT' }
    return ("{0} state={1}" -f $n.LinkLayerAddress, $n.State)
}

Line 'VERIFY_ARP_BEFORE' (NeighborLine (Get-Neighbor $BoardIp))

$rxBefore = Get-RxUnicast
Line 'VERIFY_RX_UNICAST_BEFORE' $rxBefore

# ---- 2. ICMP --------------------------------------------------------------
# -S $PcIp forces the probe out of the real LAN NIC (see the TUN guard above).
Write-Host "--- ping -S $PcIp $BoardIp ---"
$pingOut = & ping -S $PcIp -n $PingCount -w 1000 $BoardIp 2>&1
$pingTxt = ($pingOut | Out-String)
$pingExit = $LASTEXITCODE
$replies  = ([regex]::Matches($pingTxt, 'TTL=')).Count
$replyFrom = ([regex]::Matches($pingTxt, 'Reply from')).Count
$lost     = 0
if ($pingTxt -match '\((\d+)% loss\)') { $lost = [int]$Matches[1] }
Line 'VERIFY_PING_EXIT'  $pingExit
Line 'VERIFY_PING_REPLIES' $replies
Line 'VERIFY_PING_REPLY_FROM' $replyFrom
Line 'VERIFY_PING_LOSS_PCT' $lost

$rxAfterPing = Get-RxUnicast
Line 'VERIFY_RX_UNICAST_AFTER_PING' $rxAfterPing

# PRIMARY gate = the real NIC's neighbor entry for the board MAC.
# A proxy/VPN TUN can fake an ICMP reply (measured: TTL=64, <1ms, exit 0) but it
# has no L2 presence on the LAN NIC, so it cannot create this neighbor entry.
$nb = Get-Neighbor $BoardIp
Line 'VERIFY_ARP_AFTER' (NeighborLine $nb)
$macOk = ($nb -and $nb.LinkLayerAddress -eq '00-11-22-33-44-55')
Line 'VERIFY_MAC_MATCH' $(if ($macOk) { 'YES' } else { 'NO (' + (NeighborLine $nb) + ')' })

if (-not $macOk) {
    Line 'VERIFY_RESULT' "NO_BOARD_ARP (neighbor=$((NeighborLine $nb)); icmp replies=$replies may be a proxy TUN; check ETH_EN=1 build is loaded, cable on GE1, PHY reset)"
    exit 3
}

# ---- 3. UDP ---------------------------------------------------------------
# Decision is made with tool\udp_frame_check.py: stdlib-only, so it can run under
# an interpreter the Windows firewall allows, and it validates the wire format
# (MAGIC / lengths / CRC16) and reassembles whole 768000-byte frames.
#
# ⚠️ MEASURED TRAP (2026-10-06): this host has inbound *Block* rules for
#   C:\Users\Admin\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe
#   (the DSH-bundled interpreter, the only one with a working numpy), while the
#   allowed ones are the system Python 3.14 and node.exe. Using the bundled
#   interpreter makes the socket silently receive nothing while the NIC counter
#   still climbs. Hence the candidate order below, and the explicit warning.
if ($SkipUdp) {
    Line 'VERIFY_UDP' 'SKIPPED'
    Line 'VERIFY_RESULT' 'ARP_ICMP_OK'
    exit 0
}

$sniff = Join-Path $root 'tool\udp_frame_check.py'
$blocked = 'C:\Users\Admin\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
if (-not $Python) {
    $cand = @(
        'C:\Users\Admin\AppData\Local\Programs\Python\Python314\python.exe',
        'python'
    )
    foreach ($c in $cand) {
        if ($c -eq 'python') {
            $cmd = Get-Command python -ErrorAction SilentlyContinue
            if ($cmd) { $Python = $cmd.Source; break }
        } elseif (Test-Path $c) { $Python = $c; break }
    }
}
Line 'VERIFY_PYTHON' $(if ($Python) { $Python } else { 'NONE' })
if ($Python -and ($Python -eq $blocked)) {
    Line 'VERIFY_WARN_FIREWALL' 'this interpreter has inbound Block rules -> the socket will receive nothing; use the system Python 3.14'
}

if (-not $Python -or -not (Test-Path $sniff)) {
    Line 'VERIFY_UDP' 'SKIPPED_NO_PYTHON_OR_CHECKER'
    Line 'VERIFY_RESULT' 'ARP_ICMP_OK'
    exit 0
}

Write-Host "--- live UDP frame check for $UdpSeconds s ---"
$sniffOut = & $Python $sniff --seconds $UdpSeconds --out capture\udp 2>&1
$sniffExit = $LASTEXITCODE
$sniffOut | ForEach-Object { Write-Host "  [udpchk] $_" }
Line 'VERIFY_UDP_EXIT' $sniffExit

$rxAfterUdp = Get-RxUnicast
Line 'VERIFY_RX_UNICAST_AFTER_UDP' $rxAfterUdp
Line 'VERIFY_RX_UNICAST_DELTA' ($rxAfterUdp - $rxBefore)

$sniffTxt = ($sniffOut | Out-String)
$nPkt = 0; $nBad = 0; $nFrm = 0
if ($sniffTxt -match 'UDPCHK_DATAGRAMS=(\d+)') { $nPkt = [int]$Matches[1] }
if ($sniffTxt -match 'UDPCHK_BAD=(\d+)')       { $nBad = [int]$Matches[1] }
if ($sniffTxt -match 'UDPCHK_FRAMES_OK=(\d+)') { $nFrm = [int]$Matches[1] }
Line 'VERIFY_UDP_DATAGRAMS' $nPkt
Line 'VERIFY_UDP_BAD_CRC_OR_MALFORMED' $nBad
Line 'VERIFY_UDP_FRAMES_OK' $nFrm

# ⚠️ MEASURED TRAP (2026-10-06): if the PC ground station (host/app) is already
#   running, it binds the SPECIFIC address 192.168.1.102:1234, which wins over this
#   script's 0.0.0.0:1234 bind (SO_REUSEADDR lets both bind). The socket then sees
#   0 datagrams while the NIC counter climbs at the full ~1970 pkt/s, which looks
#   exactly like "the board stopped streaming". Report the real owner instead.
if ($nPkt -eq 0 -and ($rxAfterUdp - $rxBefore) -gt 100) {
    $owner = $null
    $nl = netstat -ano -p UDP | Select-String ":1234\s"
    if ($nl) {
        $cols = ($nl[0].Line -split '\s+') | Where-Object { $_ -ne '' }
        $ownerPid = $cols[-1]
        $pname = '-'
        try { $pname = (Get-Process -Id ([int]$ownerPid) -ErrorAction Stop).ProcessName } catch { }
        $owner = "$ownerPid ($pname)"
    }
    Line 'VERIFY_UDP_PORT1234_OWNER' $(if ($owner) { $owner } else { 'none' })
    Line 'VERIFY_HINT' 'another process owns 192.168.1.102:1234 (likely host/app ground station); it consumes the stream, so a 0-datagram result here is NOT a board fault -- check the NIC rate instead'
}

if ($nFrm -gt 0) {
    Line 'VERIFY_RESULT' 'FULL_OK (ARP + UDP stream + whole 768000-byte frames with valid CRC16)'
    exit 0
}
if (($rxAfterUdp - $rxBefore) -gt 100 -or $nPkt -gt 0) {
    Line 'VERIFY_RESULT' 'ARP_OK_UDP_PARTIAL (packets arrived but no complete frame; check port owner / rcvbuf / firewall / camera)'
    exit 4
}
Line 'VERIFY_RESULT' 'ARP_OK_NO_UDP (board answered but sent no stream: camera not producing frames? try USE_DDR3=0 + CFG_SRC=1; check GE1 vs GE0 port)'
exit 5

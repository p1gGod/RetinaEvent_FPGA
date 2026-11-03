# ==============================================================================
# check_vendor_manifest.ps1 -- verify vendor_manifest.json
#
# The file list and count are read from setup_vendor_rtl.ps1 ($vendorFiles).
# Every sha256 is recomputed from the real bytes under
# exp_ov5640_lcd_eth/prj_src/rtl.  If that source tree is absent, ref_original/
# is used as the hash source instead (HASH_SOURCE prints which one).  When both
# exist, the local copy must match the source byte-for-byte.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File build/check_vendor_manifest.ps1
# ==============================================================================

$ErrorActionPreference = 'Stop'

$here     = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $here
$setup    = Join-Path $PSScriptRoot 'setup_vendor_rtl.ps1'
$manifestPath = Join-Path $here 'vendor_manifest.json'
$srcDir   = Join-Path $repoRoot 'exp_ov5640_lcd_eth\prj_src\rtl'
$refDir   = Join-Path $here 'ref_original'

$fail = 0

function Fail([string]$msg) {
    Write-Host "FAIL $msg"
    $script:fail++
}

function Get-VendorListFromSetup([string]$path) {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw "setup_vendor_rtl.ps1 parse errors: $($errors[0].Message)" }
    $assign = $ast.FindAll({
        param($n)
        $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and
        $n.Left.Extent.Text -eq '$vendorFiles'
    }, $true) | Select-Object -First 1
    if (-not $assign) { throw 'vendorFiles assignment not found' }
    $values = New-Object System.Collections.Generic.List[string]
    function Add-Value($node) {
        if ($node -is [System.Management.Automation.Language.ArrayLiteralAst]) {
            foreach ($e in $node.Elements) { Add-Value $e }
        } elseif ($node -is [System.Management.Automation.Language.ArrayExpressionAst]) {
            Add-Value $node.SubExpression
        } elseif ($node -is [System.Management.Automation.Language.StatementBlockAst]) {
            foreach ($s in $node.Statements) { Add-Value $s }
        } elseif ($node -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
            $values.Add($node.Value)
        } elseif ($node -is [System.Management.Automation.Language.PipelineAst]) {
            foreach ($e in $node.PipelineElements) { Add-Value $e }
        } elseif ($node -is [System.Management.Automation.Language.CommandExpressionAst]) {
            Add-Value $node.Expression
        } else {
            throw "unsupported vendorFiles element: $($node.GetType().Name)"
        }
    }
    Add-Value $assign.Right
    return @($values)
}

if (-not (Test-Path -LiteralPath $manifestPath)) {
    Write-Host "MANIFEST_MISSING=$manifestPath"
    Write-Host 'VENDOR_MANIFEST_OK=0'
    exit 1
}
$srcAvailable = Test-Path -LiteralPath $srcDir
$refAvailable = Test-Path -LiteralPath $refDir
if (-not $srcAvailable -and -not $refAvailable) {
    Write-Host "VENDOR_SOURCE_MISSING=$srcDir and $refDir"
    Write-Host 'VENDOR_MANIFEST_OK=0'
    exit 1
}
$hashRoot = if ($srcAvailable) { $srcDir } else { $refDir }
Write-Host "HASH_SOURCE=$hashRoot"

try {
    $vendorFiles = @(Get-VendorListFromSetup $setup)
} catch {
    Fail "cannot read vendorFiles: $($_.Exception.Message)"
    $vendorFiles = @()
}
Write-Host "VENDORFILES_COUNT=$($vendorFiles.Count)"

try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Fail "cannot parse vendor_manifest.json: $($_.Exception.Message)"
    Write-Host 'VENDOR_MANIFEST_OK=0'
    exit 1
}

if ($manifest.schema -ne 1) { Fail "schema must be 1, got $($manifest.schema)" }
if (-not $manifest.source -or $manifest.source.source_dir -notmatch 'exp_ov5640_lcd_eth/prj_src/rtl') {
    Fail 'source.source_dir must point to exp_ov5640_lcd_eth/prj_src/rtl'
}
if (-not $manifest.source -or $manifest.source.target_dir -notmatch 'retina_event/ref_original') {
    Fail 'source.target_dir must point to retina_event/ref_original'
}

$files = @($manifest.files)
if ($files.Count -ne $vendorFiles.Count) {
    Fail "entry count $($files.Count) != vendorFiles count $($vendorFiles.Count)"
}
if ($manifest.total.files -ne $files.Count) {
    Fail "total.files $($manifest.total.files) != entry count $($files.Count)"
}

$expected = @{}
foreach ($rel in $vendorFiles) { $expected[($rel -replace '\\','/')] = $true }
$seen = @{}
$sumBytes = [int64]0
$checked = 0

foreach ($item in $files) {
    $rel = [string]$item.path
    if (-not $rel) { Fail 'entry with empty path'; continue }
    if ($rel -match '\\') { Fail "path must use forward slashes: $rel" }
    if ($rel -match '(^|/)\.\.(/|$)' -or [System.IO.Path]::IsPathRooted($rel)) {
        Fail "path escapes target dir: $rel"; continue
    }
    if (-not $expected.ContainsKey($rel)) { Fail "unexpected path: $rel"; continue }
    if ($seen.ContainsKey($rel)) { Fail "duplicate path: $rel"; continue }
    $seen[$rel] = $true

    $src = Join-Path $hashRoot ($rel -replace '/','\')
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { Fail "missing vendor file: $rel"; continue }
    $len = (Get-Item -LiteralPath $src).Length
    if ([int64]$item.bytes -ne [int64]$len) {
        Fail "bytes mismatch: $rel manifest=$($item.bytes) actual=$len"
    }
    $hash = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]$item.sha256 -notmatch '^[0-9a-f]{64}$') {
        Fail "sha256 is not 64 lowercase hex: $rel"
    } elseif ([string]$item.sha256 -ne $hash) {
        Fail "sha256 mismatch: $rel manifest=$($item.sha256) actual=$hash"
    }
    if ($item.routine -ne '37' -and $item.routine -ne '60') {
        Fail "routine must be 37 or 60: $rel"
    }
    if (-not $item.used_by) { Fail "used_by is empty: $rel" }
    if (-not ([string]$item.used_by).StartsWith('N/A')) {
        $m = [regex]::Match([string]$item.used_by, '^([A-Za-z0-9_]+\.v)')
        if (-not $m.Success) {
            Fail "used_by must start with a .v file or N/A: $rel"
        } else {
            $selfDev = @(Get-ChildItem -LiteralPath (Join-Path $here 'src\hdl') -Recurse -Filter $m.Groups[1].Value -File)
            if ($selfDev.Count -eq 0) { Fail "used_by target not found in src/hdl: $($m.Groups[1].Value)" }
        }
    }

    if ($srcAvailable -and $refAvailable) {
        $dst = Join-Path $refDir ($rel -replace '/','\')
        if (Test-Path -LiteralPath $dst -PathType Leaf) {
            $dstHash = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($dstHash -ne $hash) { Fail "ref_original copy differs: $rel" }
        } else {
            Write-Host "REF_ORIGINAL_MISSING $rel"
        }
    }

    $sumBytes += [int64]$len
    $checked++
    Write-Host ("CHECK {0} bytes={1} sha256={2}" -f $rel, $len, $hash)
}

foreach ($rel in $expected.Keys) {
    if (-not $seen.ContainsKey($rel)) { Fail "missing entry: $rel" }
}
if ([int64]$manifest.total.bytes -ne $sumBytes) {
    Fail "total.bytes $($manifest.total.bytes) != computed $sumBytes"
}

$manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "MANIFEST_FILES=$($files.Count)"
Write-Host "MANIFEST_BYTES=$sumBytes"
Write-Host "MANIFEST_SHA256=$manifestHash"
Write-Host "CHECKED_ENTRIES=$checked"
if ($fail -eq 0 -and $checked -eq $vendorFiles.Count) {
    Write-Host 'VENDOR_MANIFEST_OK=1'
    exit 0
}
Write-Host "VENDOR_MANIFEST_OK=0 FAILS=$fail"
exit 1

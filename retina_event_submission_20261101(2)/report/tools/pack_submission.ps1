#requires -Version 5.1
<#
.SYNOPSIS
  从 FPGA_Comp 仓库生成比赛提交工程包（官方目录结构）并做命名/体积/幂等检查。

.DESCRIPTION
  读取 report/tools/pack_map.json，把三条线（RTL / 上位机 / NN）与仿真、构建脚本、
  板卡约束、数据说明复制到 temp_test/pack。输出目录强制位于 temp_test 下，
  不会写入仓库根 submission/，也不会修改任何被映射的源文件。

  流程：清理输出 -> 逐条映射复制 -> 写入 generated_files -> 检查 required ->
  调用 check_names.py 检查命名/体积并生成 manifest -> 打印 TREE_HASH 与
  PACK_SUMMARY。任一步失败退出非 0，且不会打印 PACK_SUMMARY。

.PARAMETER Out
  输出目录，默认 temp_test/pack；必须位于仓库 temp_test/ 之下且不能是 temp_test 根。

.PARAMETER Map
  映射表 JSON，默认 report/tools/pack_map.json。
#>
[CmdletBinding()]
param(
    [string]$Out = 'temp_test/pack',
    [string]$Map = 'report/tools/pack_map.json',
    [switch]$Snapshot,
    [string]$SnapshotDir = ''
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'

$script:RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$script:OriginalRepoRoot = $script:RepoRoot
$MapFull = if ([IO.Path]::IsPathRooted($Map)) { [IO.Path]::GetFullPath($Map) } else { [IO.Path]::GetFullPath((Join-Path $script:RepoRoot $Map)) }
$OutFull = if ([IO.Path]::IsPathRooted($Out)) { [IO.Path]::GetFullPath($Out) } else { [IO.Path]::GetFullPath((Join-Path $script:RepoRoot $Out)) }
$OutFull = $OutFull.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$TempRoot = [IO.Path]::GetFullPath((Join-Path $script:RepoRoot 'temp_test')).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$TempPrefix = $TempRoot + [IO.Path]::DirectorySeparatorChar
if (-not $OutFull.StartsWith($TempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "ERROR 输出目录必须在 $TempRoot 之下：$OutFull"
    exit 2
}
if ($OutFull.Equals($TempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "ERROR 输出目录不能是 temp_test 根：$OutFull"
    exit 2
}
if (-not (Test-Path -LiteralPath $MapFull -PathType Leaf)) {
    Write-Host "ERROR 映射表不存在：$MapFull"
    exit 2
}

$MapObj = Get-Content -LiteralPath $MapFull -Raw -Encoding UTF8 | ConvertFrom-Json
$script:MaxBytes = [int64]$MapObj.max_file_bytes
$script:NameExceptions = @($MapObj.name_exceptions | Where-Object { $_ })
$script:NameRegex = New-Object System.Text.RegularExpressions.Regex([string]$MapObj.name_regex, [System.Text.RegularExpressions.RegexOptions]::None)
$script:OutFull = $OutFull
$script:Errors = 0
$script:Stats = @{ Files = 0; Bytes = 0; Skipped = 0 }
$script:Seen = @{}
$script:NoAsciiSkipped = New-Object System.Collections.Generic.List[string]
$script:Renames = 0
$script:AsciiAliases = @{}
if ($MapObj.ascii_aliases) {
    foreach ($p in $MapObj.ascii_aliases.PSObject.Properties) {
        $script:AsciiAliases[[string]$p.Name] = [string]$p.Value
    }
}

function Get-RelPath([string]$Root, [string]$Path) {
    $rootNorm = $Root.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    if ($Path.StartsWith($rootNorm + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        return $Path.Substring($rootNorm.Length + 1).Replace([IO.Path]::DirectorySeparatorChar, '/')
    }
    return $Path.Replace([IO.Path]::DirectorySeparatorChar, '/')
}

function ConvertTo-GlobRegex([string]$Glob) {
    $g = $Glob.Replace('\', '/')
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('^')
    $i = 0
    while ($i -lt $g.Length) {
        $c = $g[$i]
        if ($c -eq '*') {
            if (($i + 1) -lt $g.Length -and $g[$i + 1] -eq '*') {
                $i++
                if (($i + 1) -lt $g.Length -and $g[$i + 1] -eq '/') {
                    $i++
                    [void]$sb.Append('(?:.*/)?')
                } else {
                    [void]$sb.Append('.*')
                }
            } else {
                [void]$sb.Append('[^/]*')
            }
        } elseif ($c -eq '?') {
            [void]$sb.Append('[^/]')
        } else {
            [void]$sb.Append([regex]::Escape([string]$c))
        }
        $i++
    }
    [void]$sb.Append('$')
    return New-Object System.Text.RegularExpressions.Regex($sb.ToString(), [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

$script:ExcludeRegexes = @()
foreach ($g in @($MapObj.exclude_globs | Where-Object { $_ })) {
    $script:ExcludeRegexes += (ConvertTo-GlobRegex $g)
}
$script:DenyRegexes = @()
foreach ($g in @($MapObj.deny_globs | Where-Object { $_ })) {
    $script:DenyRegexes += (ConvertTo-GlobRegex $g)
}
$script:LogExceptionRegexes = @()
foreach ($g in @($MapObj.log_exceptions | Where-Object { $_ })) {
    $script:LogExceptionRegexes += (ConvertTo-GlobRegex $g)
}

function Test-LogException([string]$Rel) {
    foreach ($rx in $script:LogExceptionRegexes) {
        if ($rx.IsMatch($Rel)) { return $true }
    }
    return $false
}

function Test-Excluded([string]$Rel) {
    foreach ($rx in $script:DenyRegexes) {
        if ($rx.IsMatch($Rel)) { return $true }
    }
    $matched = $false
    foreach ($rx in $script:ExcludeRegexes) {
        if ($rx.IsMatch($Rel)) { $matched = $true; break }
    }
    if ($matched -and $Rel -match '(?i)\.log$') {
        if (Test-LogException $Rel) { return $false }
        # report 引用的 docs/*.log 是证据材料，按引用进包，不受全局 *.log 排除。
        if ($script:DocsRefFiles.ContainsKey($Rel)) { return $false }
    }
    return $matched
}

function Test-MappingExclude([string]$Rel, $Regexes) {
    foreach ($rx in $Regexes) {
        if ($rx.IsMatch($Rel)) { return $true }
    }
    return $false
}

function Test-Include([string]$Rel, $Regexes) {
    foreach ($rx in $Regexes) {
        if ($rx.IsMatch($Rel)) { return $true }
    }
    return $false
}

function Get-SafeTarget([string]$TargetRel, [string]$SourceRel) {
    $isException = $script:NameExceptions -contains $TargetRel
    $safeParts = New-Object System.Collections.Generic.List[string]
    foreach ($part in ($TargetRel -split '/')) {
        if ([string]::IsNullOrEmpty($part)) { continue }
        if ($isException) {
            # 例外名按目标原样保留：README.md / LICENSE / skill/README.md /
            # board/evidence_board_doc.log（板卡 README 用大写链接引用该日志，
            # 全小写会在 Linux 大小写敏感文件系统上断链）；被引用 docs 路径同样
            # 原样保留中文目录与大小写，按 lead 裁决不改成 ASCII。
            $safeParts.Add($part)
            continue
        }
        foreach ($ch in $part.ToCharArray()) {
            if ([int]$ch -gt 127) {
                Write-Host "NOASCII_SKIP $SourceRel"
                $script:NoAsciiSkipped.Add("$SourceRel|non-ascii-component")
                return $null
            }
        }
        $lower = $part.ToLowerInvariant()
        if (-not $script:NameRegex.IsMatch($lower)) {
            Write-Host "SKIPNAME $SourceRel bad-component=$part"
            return $null
        }
        $safeParts.Add($lower)
    }
    return ($safeParts -join '/')
}

function Copy-OneFile([string]$SourceFull, [string]$SourceRel, [string]$TargetRel) {
    $repoRel = Get-RelPath $script:RepoRoot $SourceFull
    if (Test-Excluded $repoRel) { return }
    $alias = $null
    if ($script:AsciiAliases.ContainsKey($repoRel)) {
        $alias = $script:AsciiAliases[$repoRel]
    } elseif ($script:AsciiAliases.ContainsKey($SourceRel)) {
        $alias = $script:AsciiAliases[$SourceRel]
    }
    if ($alias) {
        Write-Host "RENAME $repoRel -> $alias"
        $script:Renames++
        $TargetRel = $alias
    }
    $safe = Get-SafeTarget $TargetRel $repoRel
    if (-not $safe) {
        $script:Stats.Skipped++
        return
    }
    if ($script:Seen.ContainsKey($safe)) {
        Write-Host "DUPLICATE $safe <- $SourceRel"
        $script:Errors++
        return
    }
    $len = (Get-Item -LiteralPath $SourceFull -ErrorAction Stop).Length
    if ($script:MaxBytes -gt 0 -and $len -gt $script:MaxBytes) {
        Write-Host "SKIP $safe $len"
        $script:Stats.Skipped++
        return
    }
    $dest = Join-Path $script:OutFull $safe
    $parent = Split-Path -Parent $dest
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Copy-Item -LiteralPath $SourceFull -Destination $dest -Force
    $script:Seen[$safe] = $SourceFull
    $script:Stats.Files++
    $script:Stats.Bytes += $len
}

function Add-RecursiveMapping([string]$Dir, [string]$SourceRoot, [string]$TargetRoot, $IncludeRegexes, $ExcludeRegexes) {
    $children = Get-ChildItem -LiteralPath $Dir -Force
    foreach ($child in $children) {
        $rel = Get-RelPath $SourceRoot $child.FullName
        $repoRel = Get-RelPath $script:RepoRoot $child.FullName
        if ($child.PSIsContainer) {
            if (Test-Excluded ($repoRel + '/')) { continue }
            if (Test-MappingExclude ($rel + '/') $ExcludeRegexes) { continue }
            Add-RecursiveMapping $child.FullName $SourceRoot $TargetRoot $IncludeRegexes $ExcludeRegexes
        } else {
            if (Test-Excluded $repoRel) { continue }
            if (Test-MappingExclude $rel $ExcludeRegexes) { continue }
            if (Test-Include $rel $IncludeRegexes) {
                Copy-OneFile $child.FullName $rel ($TargetRoot + '/' + $rel)
            }
        }
    }
}

function Test-MappingOptional($Mapping) {
    if ($Mapping.optional) { return $true }
    if (@($Mapping.PSObject.Properties.Name) -contains 'required') {
        return (-not [bool]$Mapping.required)
    }
    return $false
}

function Add-FileMapping($Mapping) {
    $src = Join-Path $script:RepoRoot ([string]$Mapping.source)
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) {
        if (Test-MappingOptional $Mapping) {
            Write-Host "WARN optional-missing $($Mapping.source)"
        } else {
            Write-Host "MISSING_SOURCE $($Mapping.source)"
            $script:Errors++
        }
        return
    }
    Copy-OneFile $src ([string]$Mapping.source) ([string]$Mapping.target)
}

function Add-DirectoryMapping($Mapping) {
    $src = Join-Path $script:RepoRoot ([string]$Mapping.source)
    if (-not (Test-Path -LiteralPath $src -PathType Container)) {
        if (Test-MappingOptional $Mapping) {
            Write-Host "WARN optional-missing $($Mapping.source)"
        } else {
            Write-Host "MISSING_SOURCE $($Mapping.source)"
            $script:Errors++
        }
        return
    }
    $patterns = @($Mapping.include | Where-Object { $_ })
    $includeRegexes = @()
    foreach ($p in $patterns) { $includeRegexes += (ConvertTo-GlobRegex ([string]$p)) }
    $excludeRegexes = @()
    foreach ($p in @($Mapping.exclude | Where-Object { $_ })) {
        $excludeRegexes += (ConvertTo-GlobRegex ([string]$p))
    }
    $recursive = $false
    foreach ($p in $patterns) {
        if (([string]$p) -match '[/\\]' -or ([string]$p) -match '\*\*') { $recursive = $true; break }
    }
    $targetRoot = ([string]$Mapping.target).TrimEnd('/')
    if (-not $recursive) {
        foreach ($file in @(Get-ChildItem -LiteralPath $src -File -Force)) {
            $rel = $file.Name
            $repoRel = Get-RelPath $script:RepoRoot $file.FullName
            if (Test-Excluded $repoRel) { continue }
            if (Test-MappingExclude $rel $excludeRegexes) { continue }
            if (Test-Include $rel $includeRegexes) {
                Copy-OneFile $file.FullName $rel ($targetRoot + '/' + $rel)
            }
        }
        return
    }
    Add-RecursiveMapping $src $src $targetRoot $includeRegexes $excludeRegexes
}


# ---- snapshot mode -------------------------------------------------------
# Copy the mapped sources once into temp_test/pack_snapshot/<stamp>/, then
# pack from that frozen copy. Reuse with -SnapshotDir for repeat runs.
$script:SnapshotFiles = 0
$script:SnapshotBytes = [int64]0
$script:SnapshotErrors = 0
$script:SnapshotSeen = @{}

function Copy-SnapshotFile([string]$SourceFull, [string]$SourceRel) {
    if ($script:SnapshotSeen.ContainsKey($SourceRel)) { return }
    $repoRel = Get-RelPath $script:OriginalRepoRoot $SourceFull
    if (Test-Excluded $repoRel) { return }
    $dest = Join-Path $script:SnapshotRoot $SourceRel
    $parent = Split-Path -Parent $dest
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Copy-Item -LiteralPath $SourceFull -Destination $dest -Force
    $script:SnapshotSeen[$SourceRel] = $true
    $script:SnapshotFiles++
    $script:SnapshotBytes += (Get-Item -LiteralPath $SourceFull).Length
}

function Add-SnapshotRecursive([string]$Dir, [string]$SourceBase, [string]$SourcePrefix, $IncludeRegexes, $ExcludeRegexes) {
    foreach ($child in @(Get-ChildItem -LiteralPath $Dir -Force)) {
        $rel = Get-RelPath $SourceBase $child.FullName
        $repoRel = Get-RelPath $script:OriginalRepoRoot $child.FullName
        if ($child.PSIsContainer) {
            if (Test-Excluded ($repoRel + '/')) { continue }
            if (Test-MappingExclude ($rel + '/') $ExcludeRegexes) { continue }
            Add-SnapshotRecursive $child.FullName $SourceBase $SourcePrefix $IncludeRegexes $ExcludeRegexes
        } else {
            if (Test-Excluded $repoRel) { continue }
            if (Test-MappingExclude $rel $ExcludeRegexes) { continue }
            if (Test-Include $rel $IncludeRegexes) {
                $sourceRel = if ($SourcePrefix) { $SourcePrefix + '/' + $rel } else { $rel }
                Copy-SnapshotFile $child.FullName $sourceRel
            }
        }
    }
}

function Add-SnapshotFileMapping($Mapping) {
    $src = Join-Path $script:OriginalRepoRoot ([string]$Mapping.source)
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) {
        if (Test-MappingOptional $Mapping) {
            Write-Host "WARN optional-missing $($Mapping.source)"
        } else {
            Write-Host "MISSING_SOURCE $($Mapping.source)"
            $script:SnapshotErrors++
        }
        return
    }
    Copy-SnapshotFile $src ([string]$Mapping.source)
}

function Add-SnapshotDirectoryMapping($Mapping) {
    $src = Join-Path $script:OriginalRepoRoot ([string]$Mapping.source)
    if (-not (Test-Path -LiteralPath $src -PathType Container)) {
        if (Test-MappingOptional $Mapping) {
            Write-Host "WARN optional-missing $($Mapping.source)"
        } else {
            Write-Host "MISSING_SOURCE $($Mapping.source)"
            $script:SnapshotErrors++
        }
        return
    }
    $patterns = @($Mapping.include | Where-Object { $_ })
    $includeRegexes = @()
    foreach ($p in $patterns) { $includeRegexes += (ConvertTo-GlobRegex ([string]$p)) }
    $excludeRegexes = @()
    foreach ($p in @($Mapping.exclude | Where-Object { $_ })) {
        $excludeRegexes += (ConvertTo-GlobRegex ([string]$p))
    }
    $recursive = $false
    foreach ($p in $patterns) {
        if (([string]$p).Contains('/') -or ([string]$p).Contains('\') -or ([string]$p).Contains('**')) { $recursive = $true; break }
    }
    $sourcePrefix = ([string]$Mapping.source).TrimEnd('/')
    if (-not $recursive) {
        foreach ($file in @(Get-ChildItem -LiteralPath $src -File -Force)) {
            $rel = $file.Name
            $repoRel = Get-RelPath $script:OriginalRepoRoot $file.FullName
            if (Test-Excluded $repoRel) { continue }
            if (Test-MappingExclude $rel $excludeRegexes) { continue }
            if (Test-Include $rel $includeRegexes) {
                Copy-SnapshotFile $file.FullName ($sourcePrefix + '/' + $rel)
            }
        }
        return
    }
    Add-SnapshotRecursive $src $src $sourcePrefix $includeRegexes $excludeRegexes
}

# ---- dynamic docs references ---------------------------------------------
# report/**/*.md 与根 README.md 里引用到的 docs/ 文件按“引用”进包，避免手写
# 清单漂移；目录引用（如 docs/06_facts）展开为该目录下全部 .md。
# docs/ 全树含 raw bin 等大文件，不能整体映射，只收被引用的文本与少量资源。
$script:ExtraMappings = @()
$script:DocsRefFiles = @{}

function Get-DocsReferenceFiles([string]$Root) {
    $mdFiles = New-Object System.Collections.Generic.List[object]
    $rootReadme = Join-Path $Root 'README.md'
    if (Test-Path -LiteralPath $rootReadme -PathType Leaf) {
        $mdFiles.Add((Get-Item -LiteralPath $rootReadme))
    }
    $reportDir = Join-Path $Root 'report'
    if (Test-Path -LiteralPath $reportDir -PathType Container) {
        foreach ($f in @(Get-ChildItem -LiteralPath $reportDir -Recurse -File -Filter '*.md' -Force)) {
            $mdFiles.Add($f)
        }
    }
    # 正文里常见 ../docs/... 与 “docs/a.svg、docs/b.md” 连写；负向前瞻排除
    # 路径中间的子串，可选 ../ 只吞前缀不进入捕获组，中文标点/星号作为边界。
    $refRegex = [regex]'(?<![A-Za-z0-9_./-])(?:\.\./)?(docs/[^ \t\r\n"''<>、。，；：*]+)'
    $candidates = @{}
    foreach ($f in $mdFiles) {
        $text = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8)
        foreach ($m in $refRegex.Matches($text)) {
            $raw = $m.Groups[1].Value
            $raw = $raw.TrimEnd([char[]]@('.', ',', ';', ':', '!', '?', ')', ']', '}', '。', '，', '；', '：', '、'))
            $raw = $raw.TrimEnd('/')
            if (-not $raw -or $raw -eq 'docs') { continue }
            if ($raw -match '[*?{}<>]') { continue }
            $candidates[$raw] = $true
        }
    }
    $files = New-Object System.Collections.Generic.List[string]
    $seenFiles = @{}
    $unresolved = 0
    foreach ($raw in @($candidates.Keys | Sort-Object)) {
        # 正文里 docs/ 后常直接跟中文说明、右括号或句号；取“能真实存在”的最长前缀。
        $candidate = $raw
        $chosen = ''
        while ($candidate.Length -gt 4) {
            $candidate = $candidate.TrimEnd([char[]]@('.', ',', ';', ':', '!', '?', ')', ']', '}', '）', '】', '》', '」', '』', '。', '，', '；', '：', '、', '"'))
            if ($candidate -eq 'docs' -or $candidate -eq 'docs/') { break }
            $fullCand = Join-Path $Root $candidate
            if (Test-Path -LiteralPath $fullCand) { $chosen = $candidate; break }
            $candidate = $candidate.Substring(0, $candidate.Length - 1)
        }
        if (-not $chosen) {
            # 正文里的裸 docs/ 或 docs/反引号是目录统称，不是可打包路径；
            # 不把它算作 unresolved，避免证据出现无意义的红字。
            if ($raw -match '^docs/?[`*]*$') { continue }
            Write-Host "DOCS_REF_UNRESOLVED_RAW $raw"
            $unresolved++
            continue
        }
        $full = Join-Path $Root $chosen
        if (Test-Path -LiteralPath $full -PathType Leaf) {
            if (-not $seenFiles.ContainsKey($chosen)) { $files.Add($chosen); $seenFiles[$chosen] = $true }
        } elseif (Test-Path -LiteralPath $full -PathType Container) {
            $under = @(Get-ChildItem -LiteralPath $full -Recurse -File -Filter '*.md' -Force)
            if ($under.Count -eq 0) {
                Write-Host "DOCS_REF_EMPTY_DIR $chosen"
                $script:Errors++
            }
            foreach ($mf in $under) {
                $mrel = Get-RelPath $Root $mf.FullName
                if (-not $seenFiles.ContainsKey($mrel)) { $files.Add($mrel); $seenFiles[$mrel] = $true }
            }
        }
    }
    Write-Host "DOCS_REF_UNRESOLVED=$unresolved"
    return @($files)
}

function Set-DocsReferenceMappings([string]$Root) {
    $script:ExtraMappings = @()
    $script:DocsRefFiles = @{}
    $script:DocsRefDirs = 0
    $refs = @(Get-DocsReferenceFiles $Root)
    foreach ($rel in $refs) {
        $script:DocsRefFiles[$rel] = $true
        if (-not ($script:NameExceptions -contains $rel)) {
            # 被引用 docs 路径含中文目录；先按原样收集，打包后由 normalize_pack.mjs
            # 统一改成 ASCII 小写，命名检查以改名后的包内路径为准。
            $script:NameExceptions += $rel
        }
        $parts = @($rel -split '/')
        for ($i = 1; $i -lt $parts.Count; $i++) {
            $dir = (($parts[0..($i - 1)]) -join '/')
            if ($dir -match '[^\x00-\x7F]' -and -not ($script:NameExceptions -contains $dir)) {
                $script:NameExceptions += $dir
                $script:DocsRefDirs++
            }
        }
        $script:ExtraMappings += [pscustomobject]@{
            source = $rel
            target = $rel
            type = 'file'
            required = $true
        }
    }
    Write-Host "DOCS_REFS_FILES=$($refs.Count)"
}

function New-PackSnapshot {
    $base = Join-Path $script:OriginalRepoRoot 'temp_test/pack_snapshot'
    if (-not (Test-Path -LiteralPath $base -PathType Container)) {
        New-Item -ItemType Directory -Path $base -Force | Out-Null
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dir = Join-Path $base $stamp
    $suffix = 1
    while (Test-Path -LiteralPath $dir) {
        $dir = Join-Path $base ($stamp + '-' + $suffix)
        $suffix++
    }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $script:SnapshotRoot = $dir
    $script:SnapshotFiles = 0
    $script:SnapshotBytes = [int64]0
    $script:SnapshotErrors = 0
    $script:SnapshotSeen = @{}
    $snapshotMappings = @($MapObj.mappings) + @($script:ExtraMappings)
    foreach ($m in $snapshotMappings) {
        $type = [string]$m.type
        if ($type -eq 'file') {
            Add-SnapshotFileMapping $m
        } elseif ($type -eq 'dir') {
            Add-SnapshotDirectoryMapping $m
        } else {
            Write-Host "MISSING_TYPE $($m.source)"
            $script:SnapshotErrors++
        }
    }
    if ($script:SnapshotErrors -gt 0) {
        Write-Host "SNAPSHOT_FAIL errors=$($script:SnapshotErrors)"
        exit 1
    }
    Write-Host "SNAPSHOT_DIR=$dir"
    Write-Host "SNAPSHOT_FILES=$($script:SnapshotFiles)"
    Write-Host "SNAPSHOT_BYTES=$($script:SnapshotBytes)"
}

if ($Snapshot -and $SnapshotDir) {
    Write-Host "ERROR -Snapshot 与 -SnapshotDir 不能同时使用"
    exit 2
}
if ($Snapshot) {
    Set-DocsReferenceMappings $script:OriginalRepoRoot
    if ($script:Errors -gt 0) {
        Write-Host "DOCS_REF_FAIL errors=$($script:Errors)"
        exit 1
    }
    New-PackSnapshot
    $script:RepoRoot = $script:SnapshotRoot
} elseif ($SnapshotDir) {
    $candidate = if ([IO.Path]::IsPathRooted($SnapshotDir)) { [IO.Path]::GetFullPath($SnapshotDir) } else { [IO.Path]::GetFullPath((Join-Path $script:OriginalRepoRoot $SnapshotDir)) }
    $candidate = $candidate.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $snapshotBase = [IO.Path]::GetFullPath((Join-Path $script:OriginalRepoRoot 'temp_test/pack_snapshot')).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    if (-not $candidate.StartsWith($snapshotBase + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        Write-Host "ERROR -SnapshotDir 必须在 $snapshotBase 之下：$candidate"
        exit 2
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
        Write-Host "ERROR -SnapshotDir 不存在：$candidate"
        exit 2
    }
    $script:SnapshotRoot = $candidate
    $script:RepoRoot = $candidate
    Set-DocsReferenceMappings $script:RepoRoot
    if ($script:Errors -gt 0) {
        Write-Host "DOCS_REF_FAIL errors=$($script:Errors)"
        exit 1
    }
    $snapFiles = @(Get-ChildItem -LiteralPath $candidate -Recurse -File -Force)
    $snapBytes = [int64]0
    foreach ($f in $snapFiles) { $snapBytes += $f.Length }
    Write-Host "SNAPSHOT_DIR=$candidate"
    Write-Host "SNAPSHOT_FILES=$($snapFiles.Count)"
    Write-Host "SNAPSHOT_BYTES=$snapBytes"
    Write-Host "SNAPSHOT_REUSED=1"
}

if (-not $Snapshot -and -not $SnapshotDir) {
    Set-DocsReferenceMappings $script:RepoRoot
    if ($script:Errors -gt 0) {
        Write-Host "DOCS_REF_FAIL errors=$($script:Errors)"
        exit 1
    }
}

# 评审报告与图表是 report/ 的硬前置：缺报告时不要生成一个看似完整的包。
# 该检查放在 snapshot 切换之后，保证检查对象就是本次打包根。
$EvalReportPath = Join-Path $script:RepoRoot 'report/evaluation_report.md'
if (-not (Test-Path -LiteralPath $EvalReportPath -PathType Leaf)) {
    Write-Host "ERROR report/evaluation_report.md 不存在：等 task-45 交付后再打包"
    exit 4
}
$FiguresDir = Join-Path $script:RepoRoot 'report/figures'
$SvgCount = 0
if (Test-Path -LiteralPath $FiguresDir -PathType Container) {
    $SvgCount = @(Get-ChildItem -LiteralPath $FiguresDir -Filter '*.svg' -File -ErrorAction SilentlyContinue).Count
}
if ($SvgCount -lt 8) {
    Write-Host "ERROR report/figures SVG 数量=$SvgCount（要求 >=8）：等 task-45 图表交付后再打包"
    exit 4
}

Write-Host "PACK_MAP $MapFull"
Write-Host "PACK_OUT $OutFull"
if (Test-Path -LiteralPath $OutFull) {
    Remove-Item -LiteralPath $OutFull -Recurse -Force
}
New-Item -ItemType Directory -Path $OutFull -Force | Out-Null

$packMappings = @($MapObj.mappings) + @($script:ExtraMappings)
foreach ($m in $packMappings) {
    $type = [string]$m.type
    if ($type -eq 'file') {
        Add-FileMapping $m
    } elseif ($type -eq 'dir') {
        Add-DirectoryMapping $m
    } else {
        Write-Host "MISSING_TYPE $($m.source)"
        $script:Errors++
    }
}

foreach ($g in @($MapObj.generated_files | Where-Object { $_ })) {
    $targetRel = [string]$g.target
    $safe = Get-SafeTarget $targetRel $targetRel
    if (-not $safe) {
        $script:Stats.Skipped++
        continue
    }
    if ($script:Seen.ContainsKey($safe)) {
        Write-Host "KEEP $safe (source)"
        continue
    }
    $dest = Join-Path $script:OutFull $safe
    $parent = Split-Path -Parent $dest
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    [IO.File]::WriteAllText($dest, [string]$g.content, (New-Object System.Text.UTF8Encoding($false)))
    $script:Seen[$safe] = 'generated'
    $script:Stats.Files++
    $script:Stats.Bytes += ([IO.FileInfo]::new($dest)).Length
}

$script:NoAsciiCount = $script:NoAsciiSkipped.Count
if ($script:NoAsciiCount -gt 0) {
    # 只有确实发生跳过时才产出审计文件，避免包里出现零内容的占位文件。
    $noAsciiLines = New-Object System.Collections.Generic.List[string]
    $noAsciiLines.Add('# NOASCII_SKIPPED')
    $noAsciiLines.Add('')
    $noAsciiLines.Add("NOASCII_SKIPPED=$($script:NoAsciiCount)")
    $noAsciiLines.Add('')
    foreach ($entry in $script:NoAsciiSkipped) {
        $parts = $entry -split '\|', 2
        $why = if ($parts.Count -gt 1) { $parts[1] } else { 'non-ascii-component' }
        $noAsciiLines.Add("- $($parts[0]) - $why")
    }
    $noAsciiDir = Join-Path $script:OutFull 'report/evidence'
    if (-not (Test-Path -LiteralPath $noAsciiDir)) { New-Item -ItemType Directory -Path $noAsciiDir -Force | Out-Null }
    $noAsciiPath = Join-Path $noAsciiDir 'pack_namecheck.txt'
    [IO.File]::WriteAllText($noAsciiPath, (($noAsciiLines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    $script:Seen['report/evidence/pack_namecheck.txt'] = 'generated'
    $script:Stats.Files++
    $script:Stats.Bytes += ([IO.FileInfo]::new($noAsciiPath)).Length
}

foreach ($r in @($MapObj.required)) {
    $rel = ([string]$r.path).TrimEnd('/')
    $full = Join-Path $script:OutFull $rel
    if (-not (Test-Path -LiteralPath $full)) {
        Write-Host "MISSING_REQUIRED $rel"
        $script:Errors++
    }
}

if ($script:Errors -gt 0) {
    Write-Host "PACK_FAIL errors=$($script:Errors)"
    exit 1
}

# ---- 路径归一化：官方要求包内目录名与文件名纯英文小写 -----------------------
# 复制阶段保留源路径（便于人眼核对），在命名检查与清单生成之前统一改名并重写
# 包内文本引用；映射表在 report/tools/name_map.json，未覆盖的非 ASCII 路径会失败。
$NodeExe = $null
try { $NodeExe = (Get-Command node.exe -ErrorAction Stop).Source } catch {
    try { $NodeExe = (Get-Command node -ErrorAction Stop).Source } catch { }
}
if (-not $NodeExe) {
    Write-Host "ERROR node not found (needed by normalize_pack.mjs)"
    exit 4
}
$NormScript = Join-Path $PSScriptRoot 'normalize_pack.mjs'
$NormMap = Join-Path $PSScriptRoot 'name_map.json'
if (-not (Test-Path -LiteralPath $NormScript) -or -not (Test-Path -LiteralPath $NormMap)) {
    Write-Host "ERROR normalize_pack.mjs or name_map.json missing"
    exit 4
}
$normLines = & $NodeExe $NormScript --root $OutFull --map $NormMap 2>&1
$normExit = $LASTEXITCODE
foreach ($line in @($normLines)) { Write-Host $line }
if ($normExit -ne 0) {
    Write-Host "NORMALIZE_FAIL exit=$normExit"
    exit 1
}
$LinkFix = Join-Path $PSScriptRoot 'fix_pack_links.mjs'
if (-not (Test-Path -LiteralPath $LinkFix)) {
    Write-Host "ERROR fix_pack_links.mjs not found"
    exit 4
}
$linkLines = & $NodeExe $LinkFix --pack $OutFull 2>&1
$linkExit = $LASTEXITCODE
foreach ($line in @($linkLines)) { Write-Host $line }
if ($linkExit -ne 0) {
    Write-Host "LINK_FIX_FAIL exit=$linkExit"
    exit 1
}

$PythonExe = $null
try {
    $PythonExe = (Get-Command python.exe -ErrorAction Stop).Source
} catch {
    try { $PythonExe = (Get-Command python -ErrorAction Stop).Source } catch { }
}
if (-not $PythonExe) {
    Write-Host "ERROR python not found"
    exit 3
}
$Checker = Join-Path $PSScriptRoot 'check_names.py'
if (-not (Test-Path -LiteralPath $Checker -PathType Leaf)) {
    Write-Host "ERROR check_names.py not found: $Checker"
    exit 3
}
$Manifest = $OutFull + '.manifest.txt'
$ExceptionArg = ($script:NameExceptions -join ',')
$checkArgs = @(
    $Checker,
    '--root', $OutFull,
    '--name-regex', [string]$MapObj.name_regex,
    '--max-bytes', [string]$script:MaxBytes,
    '--manifest', $Manifest
)
if ($ExceptionArg) {
    $checkArgs += @('--exceptions', $ExceptionArg)
}
$checkLines = & $PythonExe @checkArgs 2>&1
$checkExit = $LASTEXITCODE
$treeHash = ''
foreach ($line in @($checkLines)) {
    Write-Host $line
    if (([string]$line) -match '^TREE_HASH=([0-9a-f]+)$') { $treeHash = $Matches[1] }
}
if ($checkExit -ne 0) {
    Write-Host "NAMECHECK_FAIL exit=$checkExit"
    exit 1
}
if (-not $treeHash) {
    Write-Host "NAMECHECK_FAIL missing-tree-hash"
    exit 1
}

$outFiles = @(Get-ChildItem -LiteralPath $OutFull -Recurse -File -Force)
$forbidden = @($outFiles | Where-Object { $_.FullName.Replace('\', '/') -match '/(ref_original|exp_ov5640_lcd_eth)/' })
if ($forbidden.Count -gt 0) {
    Write-Host "FORBIDDEN_PATHS=$($forbidden.Count)"
    foreach ($f in $forbidden) { Write-Host "FORBIDDEN $($f.FullName)" }
    exit 5
}
$outBytes = [int64]0
foreach ($f in $outFiles) { $outBytes += $f.Length }
Write-Host "FORBIDDEN_PATHS=0"
Write-Host "FIGURE_SVGS=$SvgCount"
Write-Host "RENAMES=$($script:Renames)"
Write-Host "NOASCII_SKIPPED=$($script:NoAsciiCount)"
Write-Host "TREE_HASH=$treeHash"
Write-Host "PACK_SUMMARY files=$($outFiles.Count) bytes=$outBytes skipped=$($script:Stats.Skipped)"
exit 0

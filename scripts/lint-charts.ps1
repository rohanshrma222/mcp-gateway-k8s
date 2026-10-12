<#
.SYNOPSIS
    Lints and renders every chart in charts/ against both value overlays.

.DESCRIPTION
    Three things, for each of store, platform and upstreams:

      1. `helm dependency build` resolves the charts/common library from Chart.lock.
         Build, not update: the lock file is committed, so a reviewer gets the same
         resolution rather than whatever is newest.
      2. `helm lint` and `helm template` against values-local.yaml and values-prod.yaml.
         Linting only the defaults would miss a key that exists in one overlay and not
         the other, which is exactly the mistake the overlays invite.
      3. A structural comparison of the local and prod renders.

    Step 3 is the one worth explaining. The brief asks for the same charts to deploy to a
    k3s VPS with config changes only, and the way to show that is not a promise - it is a
    diff. This compares the set of (kind, name) pairs produced by each overlay: if prod
    renders an object local does not, or vice versa, the difference is structural and the
    claim is false. Values inside those objects are expected to differ; that is the point
    of an overlay.

    The comparison is deliberately shallow - it reads kind and metadata.name out of the
    rendered YAML rather than parsing it properly. It is a tripwire, not a schema
    validator, and stage 9 replaces it with a full rendered diff.

.EXAMPLE
    .\scripts\lint-charts.ps1
.EXAMPLE
    .\scripts\lint-charts.ps1 -Chart store
#>
[CmdletBinding()]
param(
    [string[]]$Chart = @('store', 'platform', 'upstreams'),
    [switch]$SkipDeps
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Overlays = @('values-local.yaml', 'values-prod.yaml')

function Write-Head ([string]$m) { Write-Host ''; Write-Host $m -ForegroundColor Cyan }
function Write-Ok   ([string]$m) { Write-Host "    ok   $m" -ForegroundColor Green }
function Write-Fail ([string]$m) { Write-Host "    FAIL $m" -ForegroundColor Red }
function Write-Info ([string]$m) { Write-Host "    ..   $m" -ForegroundColor DarkGray }

$helm = (Get-Command helm -ErrorAction SilentlyContinue)
if (-not $helm) { throw "helm not found on PATH." }
$helm = $helm.Source

# Native tools write progress to stderr, and PS 5.1 turns a redirected native stderr into
# a terminating ErrorRecord under $ErrorActionPreference = 'Stop'. Same wrapper shape as
# bootstrap.ps1: demote stderr, trust the exit code.
function Invoke-Helm {
    param([Parameter(Mandatory)][string[]]$Arguments, [switch]$Capture)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($Capture) { $out = & $helm @Arguments 2>&1 } else { $out = & $helm @Arguments 2>&1 }
    }
    finally { $ErrorActionPreference = $previous }
    return [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output   = (($out | Out-String))
    }
}

# Shallow read of (kind, name) pairs out of rendered YAML. See the note in the synopsis:
# this is a tripwire for structural drift between overlays, not a YAML parser.
function Get-RenderedObjects {
    param([Parameter(Mandatory)][string]$Yaml)
    $objects = @()
    foreach ($doc in ($Yaml -split "(?m)^---\s*$")) {
        if ([string]::IsNullOrWhiteSpace($doc)) { continue }
        $kindMatch = [regex]::Match($doc, '(?m)^kind:\s*(\S+)')
        $nameMatch = [regex]::Match($doc, '(?m)^\s{2}name:\s*(\S+)')
        if ($kindMatch.Success -and $nameMatch.Success) {
            $objects += ('{0}/{1}' -f $kindMatch.Groups[1].Value, $nameMatch.Groups[1].Value)
        }
    }
    return ($objects | Sort-Object -Unique)
}

$failures = 0

foreach ($name in $Chart) {
    $dir = Join-Path $RepoRoot "charts\$name"
    Write-Head "chart: $name"

    if (-not (Test-Path (Join-Path $dir 'Chart.yaml'))) {
        Write-Fail "no Chart.yaml in $dir"
        $failures++
        continue
    }

    if (-not $SkipDeps) {
        $lock = Join-Path $dir 'Chart.lock'
        # build honours the committed lock; update would re-resolve and rewrite it.
        $depArgs = if (Test-Path $lock) { @('dependency', 'build', $dir) } else { @('dependency', 'update', $dir) }
        Write-Info "helm $($depArgs[0..1] -join ' ')"
        $r = Invoke-Helm -Arguments $depArgs
        if ($r.ExitCode -ne 0) {
            Write-Fail "dependency resolution failed:`n$($r.Output)"
            $failures++
            continue
        }
        Write-Ok 'dependencies resolved'
    }

    $renders = @{}
    foreach ($overlay in $Overlays) {
        $valuesPath = Join-Path $dir $overlay
        if (-not (Test-Path $valuesPath)) {
            Write-Fail "missing $overlay"
            $failures++
            continue
        }

        $r = Invoke-Helm -Arguments @('lint', $dir, '--values', $valuesPath)
        if ($r.ExitCode -ne 0) {
            Write-Fail "lint failed with ${overlay}:`n$($r.Output)"
            $failures++
        } else {
            Write-Ok "lint clean with $overlay"
        }

        # lint renders the chart, but template is what surfaces the output we care about
        # and makes a render failure legible rather than summarised.
        $r = Invoke-Helm -Arguments @('template', $name, $dir, '--values', $valuesPath)
        if ($r.ExitCode -ne 0) {
            Write-Fail "template failed with ${overlay}:`n$($r.Output)"
            $failures++
        } else {
            $renders[$overlay] = $r.Output
            $objects = @(Get-RenderedObjects -Yaml $r.Output)
            Write-Ok "template renders $($objects.Count) object(s) with $overlay"
        }
    }

    if ($renders.Count -eq 2) {
        $localObjects = @(Get-RenderedObjects -Yaml $renders['values-local.yaml'])
        $prodObjects = @(Get-RenderedObjects -Yaml $renders['values-prod.yaml'])
        $onlyLocal = @($localObjects | Where-Object { $prodObjects -notcontains $_ })
        $onlyProd = @($prodObjects | Where-Object { $localObjects -notcontains $_ })

        if ($onlyLocal.Count -eq 0 -and $onlyProd.Count -eq 0) {
            Write-Ok 'local and prod render the same object set (config-only difference)'
        } else {
            # Not automatically a failure: upstreams/values-prod.yaml disables
            # everything-mcp on purpose, and a deliberate, documented difference is
            # different from an accidental one. Reported for inspection either way.
            Write-Info 'local and prod differ structurally - confirm each is deliberate:'
            foreach ($o in $onlyLocal) { Write-Info "  local only: $o" }
            foreach ($o in $onlyProd) { Write-Info "  prod only:  $o" }
        }
    }
}

Write-Head 'Result'
if ($failures -eq 0) {
    Write-Host "all charts lint and render cleanly against both overlays" -ForegroundColor Green
    exit 0
}
Write-Host "$failures check(s) failed" -ForegroundColor Red
exit 1

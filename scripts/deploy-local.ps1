<#
.SYNOPSIS
    Deploys all three charts to the local kind cluster, in the order they depend on.

.DESCRIPTION
    This exists because of a gap found while finishing stage 6: the `mcp-upstreams`
    namespace existed only because it had been created by hand. Every chart was correct and
    a fresh clone still could not deploy, because nothing in the repository created that
    namespace. The README's deploy section, meanwhile, still showed only the store chart
    with a "planned" marker, two stages after the other two charts started working.

    Both are the same failure: the deploy path was never itself the thing being run. Every
    deploy in this project was a hand-typed `helm upgrade` for whichever chart had just
    changed, so the end-to-end path - clean cluster to working system - was never exercised
    and quietly rotted.

    So this is the deploy path, and it is the one the README tells people to use. It is
    idempotent (`upgrade --install`) and safe to re-run.

    Order matters and is not alphabetical:

      1. store       WordPress, MariaDB and woo-mcp. First because the platform's seed Job
                     registers woo-mcp as an upstream, and while registration does not
                     require the store to be running - deliberately, see
                     `seedUpstreams` in services/gateway/src/seed.ts - having it up means
                     the gateway's first health probe finds it connected rather than
                     reporting an outage that is really just a deploy ordering artefact.
      2. upstreams   notes-mcp and everything-mcp, for the same reason.
      3. platform    Postgres, the gateway and the dashboard. Last, because its seed Job
                     pre-registers every upstream above.

    `--create-namespace` on each, which is what closes the original gap. The NetworkPolicies
    select namespaces by `kubernetes.io/metadata.name`, a label the API server applies to
    every namespace automatically, so a namespace created this way is selectable without
    any extra labelling step - verified rather than assumed.

.PARAMETER SkipImages
    Do not build or load container images. Use when only chart values changed.

.PARAMETER Context
    kubectl context to deploy into. Defaults to kind-urumi.

.EXAMPLE
    .\scripts\deploy-local.ps1
.EXAMPLE
    .\scripts\deploy-local.ps1 -SkipImages
#>
[CmdletBinding()]
param(
    [switch]$SkipImages,
    [string]$Context = 'kind-urumi',
    [string]$ClusterName = 'urumi'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

$script:step = 0
function Write-Step([string]$m) { $script:step++; Write-Host ''; Write-Host ("[{0}] {1}" -f $script:step, $m) -ForegroundColor Cyan }
function Write-Ok  ([string]$m) { Write-Host "    ok   $m" -ForegroundColor Green }
function Write-Info([string]$m) { Write-Host "    ..   $m" -ForegroundColor DarkGray }

function Invoke-Native {
    param([Parameter(Mandatory)][string]$Exe, [Parameter(Mandatory)][string[]]$Arguments, [switch]$Quiet)
    # stderr to $null, not 2>&1: in Windows PowerShell 5.1 redirecting a native command's
    # stderr wraps each line in an ErrorRecord and sets $? to false even on success, which
    # with ErrorActionPreference = Stop turns ordinary progress output into a fatal error.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($Quiet) { & $Exe @Arguments 2>$null | Out-Null } else { & $Exe @Arguments 2>$null }
        if ($LASTEXITCODE -ne 0) { throw "$(Split-Path -Leaf $Exe) $($Arguments -join ' ') exited with $LASTEXITCODE" }
    }
    finally { $ErrorActionPreference = $previous }
}

$kubectl = (Get-Command kubectl -ErrorAction Stop).Source
$helm    = (Get-Command helm -ErrorAction Stop).Source

Write-Step "Targeting context $Context"
Invoke-Native -Exe $kubectl -Arguments @('config', 'use-context', $Context) -Quiet
Write-Ok "context set (Docker Desktop resets this to docker-desktop on restart, which is why it is explicit here)"

# ------------------------------------------------------------------------------ images

if (-not $SkipImages) {
    # Each service, with the Dockerfile path and the image tag the charts expect. Built from
    # the repository root because these are npm workspaces and the root lockfile is the only
    # file that pins the dependency tree.
    $images = @(
        @{ Name = 'urumi/woo-mcp:dev';        File = 'services/woo-mcp/Dockerfile' }
        @{ Name = 'urumi/notes-mcp:dev';      File = 'services/notes-mcp/Dockerfile' }
        @{ Name = 'urumi/everything-mcp:dev'; File = 'services/everything-mcp/Dockerfile' }
        @{ Name = 'urumi/gateway:dev';        File = 'services/gateway/Dockerfile' }
        @{ Name = 'urumi/dashboard:dev';      File = 'services/dashboard/Dockerfile' }
    )
    $docker = (Get-Command docker -ErrorAction Stop).Source
    $kind   = (Get-Command kind -ErrorAction Stop).Source

    foreach ($image in $images) {
        Write-Step "Building $($image.Name)"
        Invoke-Native -Exe $docker -Arguments @('build', '-q', '-f', $image.File, '-t', $image.Name, $repoRoot)
        # kind nodes have their own image store; a locally built image is invisible to them
        # until loaded. Forgetting this presents as ImagePullBackOff on an image that
        # `docker images` clearly shows, which is a confusing five minutes.
        Invoke-Native -Exe $kind -Arguments @('load', 'docker-image', $image.Name, '--name', $ClusterName) -Quiet
        Write-Ok "$($image.Name) built and loaded into the $ClusterName cluster"
    }
}
else { Write-Step 'Skipping image build (-SkipImages)'; Write-Info 'charts will use whatever is already loaded' }

# ------------------------------------------------------------------------------ charts

$releases = @(
    @{ Release = 'store-default'; Chart = 'charts/store';     Namespace = 'store-default'  }
    @{ Release = 'upstreams';     Chart = 'charts/upstreams'; Namespace = 'mcp-upstreams'  }
    @{ Release = 'platform';      Chart = 'charts/platform';  Namespace = 'urumi-platform' }
)

foreach ($r in $releases) {
    Write-Step "Deploying $($r.Release) to $($r.Namespace)"
    Invoke-Native -Exe $helm -Arguments @('dependency', 'build', (Join-Path $repoRoot $r.Chart)) -Quiet
    Invoke-Native -Exe $helm -Arguments @(
        'upgrade', '--install', $r.Release, (Join-Path $repoRoot $r.Chart),
        '--namespace', $r.Namespace,
        # The line that closes the gap this script was written for.
        '--create-namespace',
        '--values', (Join-Path $repoRoot "$($r.Chart)/values-local.yaml"),
        '--wait', '--timeout', '10m'
    )
    Write-Ok "$($r.Release) deployed"

    # ---------------------------------------------------------------------------------
    # Force the new images to actually run.
    #
    # This script built and loaded images a few steps above, all tagged `:dev`. A mutable
    # tag means a code-only change produces an IDENTICAL pod spec, so `helm upgrade`
    # reports "Upgrade complete", changes nothing, and the old pods keep serving the old
    # code. Only a values or template change happens to trigger a rollout, which is why
    # this went unnoticed for several steps - most deploys here changed something in the
    # chart as well.
    #
    # It cost two false test results in step 8.2: a prompt-injection defence was tested
    # twice against a gateway that was not running it, and the passes were credited to code
    # that was not deployed. The failure mode is the dangerous kind, because the deploy
    # reports success and the only symptom is behaviour that does not match the source.
    #
    # `rollout restart` sets a template annotation, which changes the pod spec, which is
    # what makes the rollout happen. The real fix is content-addressed tags - building
    # `urumi/gateway:<git-sha>` so the spec changes whenever the code does - and that is
    # what values-prod.yaml already points at for GHCR. For a local loop against a mutable
    # tag this is the honest workaround, and doing it unconditionally is right: a restart
    # with no new image costs a few seconds, while skipping one costs a wrong conclusion.
    #
    # StatefulSets are included; databases roll one pod at a time and keep their PVCs.
    $workloads = & $kubectl get deployment,statefulset -n $r.Namespace -o name 2>$null
    foreach ($w in $workloads) {
        if ([string]::IsNullOrWhiteSpace($w)) { continue }
        Invoke-Native -Exe $kubectl -Arguments @('rollout', 'restart', $w, '-n', $r.Namespace) -Quiet
    }
    foreach ($w in $workloads) {
        if ([string]::IsNullOrWhiteSpace($w)) { continue }
        Invoke-Native -Exe $kubectl -Arguments @('rollout', 'status', $w, '-n', $r.Namespace, '--timeout', '10m') -Quiet
    }
    Write-Ok "$($r.Release) workloads restarted onto the newly loaded images"
}

# ------------------------------------------------------------------------------ summary

Write-Step 'Cluster state'
foreach ($ns in @('store-default', 'mcp-upstreams', 'urumi-platform')) {
    Write-Info "namespace $ns"
    & $kubectl get pods -n $ns --no-headers 2>$null | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
}

Write-Host ''
Write-Host 'Next' -ForegroundColor Cyan
Write-Host '    .\scripts\verify-upstream-isolation.ps1   prove every upstream is gateway-only' -ForegroundColor DarkGray
Write-Host '    hosts file needs store.urumi.local and app.urumi.local -> 127.0.0.1' -ForegroundColor DarkGray
Write-Host '    see README "Connect an external MCP client" for issuing an API key' -ForegroundColor DarkGray

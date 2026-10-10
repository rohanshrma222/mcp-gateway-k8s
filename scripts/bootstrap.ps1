<#
.SYNOPSIS
    Creates the local Kubernetes cluster for the Urumi MCP gateway platform.

.DESCRIPTION
    Idempotent. Running it twice is safe: an existing cluster is reused, and both Helm
    releases are installed with `upgrade --install`.

    Order matters and is not arbitrary:

      1. kind creates the cluster with no CNI, so every node reports NotReady. That is
         expected - nothing can schedule until a CNI owns the dataplane.
      2. The control-plane node is labelled ingress-ready=true. kind maps host
         127.0.0.1:80/443 to that node, so the ingress controller must land there.
      3. Calico is installed and becomes the CNI. Only now do nodes go Ready.
      4. Traefik is installed and binds node :80/:443 through a hostPort.
      5. A smoke test proves the whole path host -> node -> ingress pod actually works,
         rather than assuming it from "pods are Running".

    Everything after this script is Helm charts from charts/.

.PARAMETER Recreate
    Delete an existing cluster of the same name first. Destroys all cluster state,
    including PersistentVolume data.

.PARAMETER WriteHosts
    Append the required hostnames to the Windows hosts file. Needs an elevated shell.
    Without it, the script prints the lines for you to add yourself.

.EXAMPLE
    .\scripts\bootstrap.ps1
.EXAMPLE
    .\scripts\bootstrap.ps1 -Recreate
#>
[CmdletBinding()]
param(
    [string]$ClusterName = 'urumi',
    [switch]$Recreate,
    [switch]$SkipIngress,
    [switch]$WriteHosts
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Pinned so a reviewer gets the same control plane as the author. Bump deliberately.
$CalicoChartVersion  = 'v3.33.0'
$TraefikChartVersion = '41.7.1'
$CalicoRepo          = 'https://docs.tigera.io/calico/charts'
$TraefikRepo         = 'https://traefik.github.io/charts'

# The tigera-operator chart has no crds/ directory: recent Calico releases ship the
# operator CRDs as a separate manifest, while the chart's templates create Installation,
# APIServer, Goldmane and Whisker custom resources. Install the chart without the CRDs
# and Helm fails with "no matches for kind Installation". Pinned to the same tag as the
# chart so the CRDs and the operator cannot drift apart.
$CalicoCrdsUrl = "https://raw.githubusercontent.com/projectcalico/calico/$CalicoChartVersion/manifests/operator-crds.yaml"

$RepoRoot      = Split-Path -Parent $PSScriptRoot
$ClusterConfig = Join-Path $RepoRoot 'kind\cluster.yaml'
$CalicoValues  = Join-Path $RepoRoot 'kind\calico-values.yaml'
$TraefikValues = Join-Path $RepoRoot 'kind\traefik-values.yaml'
$KubeContext   = "kind-$ClusterName"
$Hostnames     = @('store.urumi.local', 'app.urumi.local')

# --------------------------------------------------------------------------- output

$script:step = 0
function Write-Step([string]$Message) {
    $script:step++
    Write-Host ''
    Write-Host ("[{0}] {1}" -f $script:step, $Message) -ForegroundColor Cyan
}
function Write-Ok   ([string]$m) { Write-Host "    ok   $m" -ForegroundColor Green }
function Write-Info ([string]$m) { Write-Host "    ..   $m" -ForegroundColor DarkGray }
function Write-Warn2([string]$m) { Write-Host "    warn $m" -ForegroundColor Yellow }

# --------------------------------------------------------------------------- helpers

# winget installs kind without refreshing PATH in already-running shells, so resolve
# the binary rather than trusting PATH.
function Resolve-Tool {
    param([Parameter(Mandatory)][string]$Name, [string[]]$Fallbacks = @())

    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    foreach ($pattern in $Fallbacks) {
        $hit = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue |
               Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    throw "Required tool '$Name' not found. See README.md for prerequisites."
}

function Invoke-Tool {
    param(
        [Parameter(Mandatory)][string]$Exe,
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$AllowFailure
    )
    Write-Info "$(Split-Path -Leaf $Exe) $($Arguments -join ' ')"

    # kind, kubectl and helm all write progress to stderr. Under Windows PowerShell 5.1
    # those lines become ErrorRecords whenever the caller redirects the stream - piping
    # this script to Out-String or running it in CI is enough - and with
    # $ErrorActionPreference = 'Stop' that aborts the run on a perfectly healthy
    # command. Exit code is the only honest success signal for a native tool, so
    # stderr is demoted to output here and the exit code is checked explicitly.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Exe @Arguments }
    finally { $ErrorActionPreference = $previous }

    if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) {
        throw "$(Split-Path -Leaf $Exe) exited with code $LASTEXITCODE"
    }
    return $LASTEXITCODE
}

# Capture a tool's stdout without letting its stderr kill the script.
#
# Windows PowerShell 5.1 turns a native command's stderr into an ErrorRecord whenever
# that stderr is redirected, and with $ErrorActionPreference = 'Stop' that becomes a
# terminating error. `kind get clusters` writes "No kind clusters found." to stderr on a
# clean machine, and several kubectl reads below are expected to fail while resources are
# still being created, so those reads go through here instead of being inlined.
function Get-ToolOutput {
    param(
        [Parameter(Mandatory)][string]$Exe,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $Exe @Arguments 2>$null
        if ($null -eq $output) { return '' }
        return (($output | Out-String).Trim())
    }
    finally { $ErrorActionPreference = $previous }
}

# Register a chart repository and refresh only that one.
#
# `helm install --repo <url>` would avoid needing this, but that path makes Helm read the
# cache of every repository already configured on the machine. One unrelated repo with a
# missing index file (a stale Bitnami entry is the common case) is then enough to fail an
# install that has nothing to do with it. A targeted `helm repo update <name>` also avoids
# refreshing - and failing on - repos this project does not use.
# kind publishes host 80/443 when it creates the cluster, so a conflict has to be caught
# before `kind create`, and only then: on a re-run the listener on those ports is Docker
# publishing them for the cluster that already exists, which is success, not a conflict.
function Assert-HostPortsFree {
    param([int[]]$Ports = @(80, 443))

    foreach ($port in $Ports) {
        $inUse = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
        if ($inUse) {
            $owners = ($inUse | ForEach-Object {
                (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName
            } | Sort-Object -Unique) -join ', '
            throw ("Host port $port is already in use by: $owners. " +
                   'Free it, or change extraPortMappings in kind/cluster.yaml.')
        }
    }
    Write-Ok "host ports $($Ports -join ' and ') are free"
}

function Add-HelmRepo {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Url
    )
    Invoke-Tool -Exe $helm -Arguments @('repo', 'add', $Name, $Url, '--force-update') | Out-Null
    Invoke-Tool -Exe $helm -Arguments @('repo', 'update', $Name) | Out-Null
}

# Poll a condition instead of sleeping a guessed duration.
function Wait-Until {
    param(
        [Parameter(Mandatory)][string]$Description,
        [Parameter(Mandatory)][scriptblock]$Condition,
        [int]$TimeoutSeconds = 300,
        [int]$IntervalSeconds = 5
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try { if (& $Condition) { Write-Ok $Description; return } } catch { }
        Start-Sleep -Seconds $IntervalSeconds
        Write-Host '.' -NoNewline -ForegroundColor DarkGray
    }
    Write-Host ''
    throw "Timed out after ${TimeoutSeconds}s waiting for: $Description"
}

# --------------------------------------------------------------- 0. preflight checks

Write-Step 'Preflight'

$kind    = Resolve-Tool -Name 'kind' -Fallbacks @(
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links\kind.exe",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Kubernetes.kind*\kind.exe"
)
$kubectl = Resolve-Tool -Name 'kubectl'
$helm    = Resolve-Tool -Name 'helm'
$docker  = Resolve-Tool -Name 'docker'
Write-Ok "kind    $kind"
Write-Ok "kubectl $kubectl"
Write-Ok "helm    $helm"

foreach ($f in @($ClusterConfig, $CalicoValues, $TraefikValues)) {
    if (-not (Test-Path $f)) { throw "Missing required file: $f" }
}
Write-Ok 'cluster config and values files present'

& $docker info --format '{{.ServerVersion}}' > $null 2>&1
if ($LASTEXITCODE -ne 0) {
    throw 'Docker engine is not reachable. Start Docker Desktop and wait for it to report Running.'
}
Write-Ok 'docker engine reachable'

# Host ports are only checked on the create path - see Assert-HostPortsFree below.
# Once the cluster exists, Docker itself is the listener on 80/443 (that is the
# extraPortMapping working as intended), so checking here would fail every re-run.

# ------------------------------------------------------------------- 1. the cluster

Write-Step "Cluster '$ClusterName'"

$existing = @(
    (Get-ToolOutput -Exe $kind -Arguments @('get', 'clusters')) -split "`r?`n" |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -and $_ -notmatch '^No kind clusters' }
)

if ($existing -contains $ClusterName) {
    if ($Recreate) {
        Write-Warn2 "deleting existing cluster '$ClusterName' (all cluster data is lost)"
        Invoke-Tool -Exe $kind -Arguments @('delete', 'cluster', '--name', $ClusterName)
        $existing = @()
    }
    else {
        Write-Ok "cluster '$ClusterName' already exists, reusing it (pass -Recreate to rebuild)"
    }
}

if ($existing -notcontains $ClusterName) {
    Assert-HostPortsFree

    # Nodes come up NotReady: there is no CNI yet. Calico fixes that in step 3.
    Invoke-Tool -Exe $kind -Arguments @(
        'create', 'cluster',
        '--name', $ClusterName,
        '--config', $ClusterConfig,
        '--wait', '0s'
    )
    Write-Ok "cluster created (nodes will stay NotReady until the CNI is installed)"
}

Invoke-Tool -Exe $kubectl -Arguments @('config', 'use-context', $KubeContext) | Out-Null

# --------------------------------------------------------------- 2. ingress-ready node

Write-Step 'Label the ingress node'

# Applied here rather than through a kubeadmConfigPatch in cluster.yaml: kubeadm changed
# kubeletExtraArgs from a map (v1beta3) to a name/value list (v1beta4) in k8s 1.31, so
# the patch form in kind's own docs is version-dependent. A label is not.
$controlPlane = Get-ToolOutput -Exe $kubectl -Arguments @(
    'get', 'nodes',
    '-l', 'node-role.kubernetes.io/control-plane',
    '-o', 'jsonpath={.items[0].metadata.name}'
)
if (-not $controlPlane) { throw 'Could not find the control-plane node.' }

Invoke-Tool -Exe $kubectl -Arguments @(
    'label', 'node', $controlPlane, 'ingress-ready=true', '--overwrite'
) | Out-Null
Write-Ok "$controlPlane labelled ingress-ready=true (host :80/:443 map to this node)"

# ------------------------------------------------------------------------ 3. Calico

Write-Step "Calico CNI ($CalicoChartVersion)"

# Calico is install-once infrastructure, not something to reconcile on every run.
#
# Once the operator reconciles, it becomes the server-side-apply field owner of
# .spec.calicoNetwork.ipPools on the Installation resource, because it writes defaults
# into that field. A second `helm upgrade` then fails with a field-manager conflict
# against manager "operator". Helm could be told --force-conflicts, but that means
# seizing ownership back from the controller whose job it is to own that field, on every
# single run, for no benefit: a Calico IP pool is immutable once created, so the pod CIDR
# cannot be changed on a live cluster regardless.
#
# So: install if absent, otherwise leave it alone and just verify health below. Changing
# CNI settings is a cluster rebuild - re-run with -Recreate.
$calicoInstalled = @(
    (Get-ToolOutput -Exe $helm -Arguments @(
        'list', '-n', 'tigera-operator', '-q', '--kube-context', $KubeContext
    )) -split "`r?`n" | ForEach-Object { $_.Trim() }
) -contains 'calico'

if ($calicoInstalled) {
    Write-Ok 'Calico already installed, leaving it untouched (use -Recreate to change CNI config)'
}
else {
    # Server-side apply, not plain apply: these 32 CRDs total ~3.4 MB, and client-side
    # apply stores the whole object in a last-applied-configuration annotation, which
    # blows past the 256 KiB annotation limit.
    Write-Info 'applying Calico operator CRDs (shipped separately from the chart)'
    Invoke-Tool -Exe $kubectl -Arguments @(
        'apply', '--server-side', '--force-conflicts',
        '-f', $CalicoCrdsUrl,
        '--context', $KubeContext
    ) | Out-Null
    Write-Ok '32 operator CRDs established'

    Add-HelmRepo -Name 'projectcalico' -Url $CalicoRepo

    Invoke-Tool -Exe $helm -Arguments @(
        'install', 'calico', 'projectcalico/tigera-operator',
        '--version', $CalicoChartVersion,
        '--namespace', 'tigera-operator', '--create-namespace',
        '--values', $CalicoValues,
        '--kube-context', $KubeContext
    )
}

# tigerastatus is the operator's own readiness report: more honest than counting pods,
# because it only goes Available once the dataplane is actually programmed.
#
# Readiness is checked with `kubectl wait`, not a jsonpath filter. Windows PowerShell
# strips the inner double quotes when passing an argument like
# {.status.conditions[?(@.type=="Available")].status} to a native executable, so the
# filter arrives malformed, matches nothing, and the script waits forever on a cluster
# that is already healthy. `kubectl wait --for=condition=` needs no quoting at all.
Write-Info 'waiting for the operator to create its status resource'
Wait-Until -Description 'tigerastatus/calico exists' -TimeoutSeconds 180 -Condition {
    $name = Get-ToolOutput -Exe $kubectl -Arguments @(
        'get', 'tigerastatus', 'calico', '--ignore-not-found', '-o', 'name'
    )
    return ($name -match 'tigerastatus')
}

Write-Info 'waiting for the operator to report the dataplane Available'
Invoke-Tool -Exe $kubectl -Arguments @(
    'wait', '--for=condition=Available', 'tigerastatus/calico', '--timeout=420s'
) | Out-Null
Write-Ok 'Calico reports Available'

Write-Info 'waiting for nodes to go Ready now that a CNI owns the dataplane'
Invoke-Tool -Exe $kubectl -Arguments @(
    'wait', '--for=condition=Ready', 'nodes', '--all', '--timeout=300s'
) | Out-Null
Write-Ok 'all nodes Ready'

# ----------------------------------------------------------------------- 4. Traefik

if ($SkipIngress) {
    Write-Step 'Ingress controller skipped (-SkipIngress)'
}
else {
    Write-Step "Traefik ingress controller ($TraefikChartVersion)"

    Add-HelmRepo -Name 'traefik' -Url $TraefikRepo

    Invoke-Tool -Exe $helm -Arguments @(
        'upgrade', '--install', 'traefik', 'traefik/traefik',
        '--version', $TraefikChartVersion,
        '--namespace', 'traefik', '--create-namespace',
        '--values', $TraefikValues,
        '--kube-context', $KubeContext,
        '--wait', '--timeout', '5m'
    )

    Invoke-Tool -Exe $kubectl -Arguments @(
        'wait', '--for=condition=Ready', 'pod',
        '-l', 'app.kubernetes.io/name=traefik',
        '-n', 'traefik', '--timeout=240s'
    ) | Out-Null
    Write-Ok 'Traefik pod Ready'

    # The real check. Pods Running proves nothing about whether traffic from the host
    # reaches them: that depends on the kind port mapping, the ingress-ready label, the
    # hostPort binding and Calico programming hostPort rules. A 404 from Traefik means
    # every one of those links works - we reached the router, it just has no route yet.
    Write-Step 'Smoke test: host -> node -> ingress pod'
    Wait-Until -Description 'http://127.0.0.1/ answered by Traefik (404 expected, no routes yet)' `
        -TimeoutSeconds 120 -Condition {
        $code = Get-ToolOutput -Exe 'curl.exe' -Arguments @(
            '-s', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '5', 'http://127.0.0.1/'
        )
        return ($code -eq '404')
    }
}

# -------------------------------------------------------------------- 5. local DNS

Write-Step 'Local hostnames'

$hostsPath  = "$env:SystemRoot\System32\drivers\etc\hosts"
$hostsText  = if (Test-Path $hostsPath) { Get-Content $hostsPath -Raw } else { '' }
$missing    = $Hostnames | Where-Object { $hostsText -notmatch [regex]::Escape($_) }

if (-not $missing) {
    Write-Ok 'all hostnames already present in the hosts file'
}
elseif ($WriteHosts) {
    $isAdmin = ([Security.Principal.WindowsPrincipal] `
        [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    if (-not $isAdmin) {
        Write-Warn2 '-WriteHosts needs an elevated shell; printing the lines instead'
        $missing | ForEach-Object { Write-Host "    127.0.0.1 $_" -ForegroundColor White }
    }
    else {
        $block = ($missing | ForEach-Object { "127.0.0.1 $_" }) -join "`r`n"
        Add-Content -Path $hostsPath -Value "`r`n# urumi mcp gateway (local kind cluster)`r`n$block"
        Write-Ok "added to ${hostsPath}: $($missing -join ', ')"
    }
}
else {
    Write-Warn2 'these hostnames are missing from your hosts file'
    Write-Host ''
    Write-Host "    Add to ${hostsPath} (needs Administrator):" -ForegroundColor White
    $missing | ForEach-Object { Write-Host "    127.0.0.1 $_" -ForegroundColor White }
    Write-Host ''
    Write-Host '    Or re-run this script in an elevated shell with -WriteHosts.' -ForegroundColor DarkGray
    Write-Host '    Alternative with no hosts-file edit: use nip.io names such as' -ForegroundColor DarkGray
    Write-Host '    app.127.0.0.1.nip.io, set via the ingress hosts in charts values.' -ForegroundColor DarkGray
}

# ----------------------------------------------------------------------- 6. summary

Write-Step 'Cluster ready'
& $kubectl get nodes -o wide
Write-Host ''
$notRunning = Get-ToolOutput -Exe $kubectl -Arguments @(
    'get', 'pods', '-A', '--field-selector', 'status.phase!=Running'
)
if ($notRunning) {
    Write-Warn2 'pods not in Running phase:'
    Write-Host $notRunning
}
else {
    Write-Ok 'every pod in the cluster is Running'
}
Write-Host ''
Write-Host "  context : $KubeContext" -ForegroundColor White
Write-Host "  next    : .\scripts\verify-netpol.ps1   (proves NetworkPolicy is enforced)" -ForegroundColor White
Write-Host ''

<#
.SYNOPSIS
    Proves that NetworkPolicy is actually enforced by this cluster's CNI.

.DESCRIPTION
    This is a gate, not a convenience script. Every network-isolation requirement in the
    brief - "the WooCommerce MCP server must not be reachable from outside the cluster",
    "upstreams are reachable only from the gateway" - rests on NetworkPolicy being
    enforced. Kubernetes does not enforce it. The API server validates and stores a
    NetworkPolicy object on any cluster, and delegates enforcement entirely to the CNI.
    kind's default CNI, kindnet, does not implement enforcement, so on a default kind
    cluster every policy in this repo would be accepted, listed by kubectl, and ignored.

    So the claim has to be tested, and tested in a way that cannot pass by accident.
    Four phases, in this order:

      1. BASELINE   no policy          client -> server  MUST SUCCEED
                    Proves the probe itself works. Without this, phase 2 passing could
                    just mean the pods were never able to reach each other anyway.

      2. DENY       default-deny       client -> server  MUST FAIL
                    Proves enforcement exists.

      3. ALLOW      selector policy    client -> server  MUST SUCCEED
                    Proves a policy can re-open a specific path, so phase 2 was the
                    policy and not a broken pod.

      4. SELECTIVE  same policy        stranger -> server MUST FAIL
                    Proves the policy *selects*. Phases 2 and 3 alone are also consistent
                    with a CNI that toggles all traffic on and off. This phase is the one
                    that matches the real requirement: not "traffic is restricted" but
                    "only the gateway gets through".

    Exit code is 0 only if all four phases pass, so this is usable as a CI gate.

    If this script fails, no application code should be written against the current
    cluster. The documented fallback is k3d: k3s enforces NetworkPolicy natively through
    kube-router and is also the production VPS target, so bootstrap.ps1 switches and
    nothing else in the repo changes.

.PARAMETER KeepNamespace
    Leave the probe namespace in place for manual inspection. By default it is deleted
    even when a phase fails.

.EXAMPLE
    .\scripts\verify-netpol.ps1
.EXAMPLE
    .\scripts\verify-netpol.ps1 -KeepNamespace
#>
[CmdletBinding()]
param(
    [string]$ClusterName = 'urumi',
    [string]$Namespace = 'netpol-probe',
    [switch]$KeepNamespace
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$KubeContext = "kind-$ClusterName"

# Throwaway probe pods, but still pinned: an unpinned tag here could change the listening
# port or the user the image runs as, and the failure would look like a policy failure.
$ServerImage = 'nginxinc/nginx-unprivileged:1.29-alpine'
$ClientImage = 'curlimages/curl:8.18.0'
$ServerPort = 8080

# A denied packet is dropped, not rejected, so curl waits. Keep the probe timeout short
# and poll instead - see Wait-ForReachState.
$ProbeTimeoutSeconds = 4
$PolicySettleSeconds = 45

# --------------------------------------------------------------------------- output

$script:step = 0
function Write-Step([string]$Message) {
    $script:step++
    Write-Host ''
    Write-Host ("[{0}] {1}" -f $script:step, $Message) -ForegroundColor Cyan
}
function Write-Ok   ([string]$m) { Write-Host "    ok   $m" -ForegroundColor Green }
function Write-Fail ([string]$m) { Write-Host "    FAIL $m" -ForegroundColor Red }
function Write-Info ([string]$m) { Write-Host "    ..   $m" -ForegroundColor DarkGray }

# --------------------------------------------------------------------------- helpers

function Resolve-Tool {
    param([Parameter(Mandatory)][string]$Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw "Required tool '$Name' not found. See README.md for prerequisites."
}

# Native tools write progress to stderr, and Windows PowerShell 5.1 turns a redirected
# native stderr into an ErrorRecord - terminating under $ErrorActionPreference = 'Stop'.
# Exit code is the only honest success signal, so both wrappers demote stderr and branch
# on $LASTEXITCODE. Same reasoning as bootstrap.ps1.
function Invoke-Tool {
    param(
        [Parameter(Mandatory)][string]$Exe,
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$AllowFailure,
        [switch]$Quiet
    )
    if (-not $Quiet) { Write-Info "$(Split-Path -Leaf $Exe) $($Arguments -join ' ')" }

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Exe @Arguments | Out-Null }
    finally { $ErrorActionPreference = $previous }

    if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) {
        throw "$(Split-Path -Leaf $Exe) exited with code $LASTEXITCODE"
    }
    return $LASTEXITCODE
}

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

function New-TempManifest {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Content)
    $path = Join-Path ([System.IO.Path]::GetTempPath()) "urumi-netpol-$Name.yaml"
    # UTF8 without BOM: kubectl rejects a leading BOM in a YAML document.
    [System.IO.File]::WriteAllText($path, $Content, (New-Object System.Text.UTF8Encoding $false))
    return $path
}

function Invoke-Manifest {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Content)
    $path = New-TempManifest -Name $Name -Content $Content
    try {
        Invoke-Tool -Exe $kubectl -Arguments @('apply', '-f', $path, '--context', $KubeContext) | Out-Null
    }
    finally { Remove-Item $path -ErrorAction SilentlyContinue }
}

# --------------------------------------------------------------------- the probe

# Hit the target's pod IP, not its Service name.
#
# NetworkPolicy is evaluated against the pod IP after any Service DNAT, so the pod IP is
# the honest subject of the test. Going through a Service name would add CoreDNS and
# kube-proxy to the path, and a DNS hiccup would then present as successful policy
# enforcement - a false pass on the one test that must not produce one.
function Test-HttpReach {
    param(
        [Parameter(Mandatory)][string]$FromPod,
        [Parameter(Mandatory)][string]$ToIp
    )
    $execArgs = @(
        'exec', '-n', $Namespace, $FromPod, '--context', $KubeContext, '--',
        'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
        '--max-time', "$ProbeTimeoutSeconds", "http://${ToIp}:$ServerPort/"
    )
    $body = Get-ToolOutput -Exe $kubectl -Arguments $execArgs
    $exit = $LASTEXITCODE
    return [pscustomobject]@{
        Reached  = ($exit -eq 0 -and $body -eq '200')
        HttpCode = $body
        ExitCode = $exit
    }
}

# Poll until the expected state is observed.
#
# Applying a NetworkPolicy is not instantaneous: the API server accepts it, Calico's
# controller observes it, and only then is the dataplane on the relevant node programmed.
# A single probe fired immediately after `kubectl apply` can legitimately still see the
# old behaviour, which would make this gate flaky in exactly the direction that matters -
# a phase-2 pass before enforcement is programmed would be a false negative on isolation.
# Polling to a deadline keeps the assertion strict while tolerating propagation.
function Wait-ForReachState {
    param(
        [Parameter(Mandatory)][string]$FromPod,
        [Parameter(Mandatory)][string]$ToIp,
        [Parameter(Mandatory)][bool]$Expected,
        [int]$TimeoutSeconds = $PolicySettleSeconds
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $last = $null
    do {
        $last = Test-HttpReach -FromPod $FromPod -ToIp $ToIp
        if ($last.Reached -eq $Expected) { return $last }
        Write-Host '.' -NoNewline -ForegroundColor DarkGray
    } while ((Get-Date) -lt $deadline)
    Write-Host ''
    return $last
}

$script:results = @()
function Assert-Reach {
    param(
        [Parameter(Mandatory)][string]$Phase,
        [Parameter(Mandatory)][string]$FromPod,
        [Parameter(Mandatory)][string]$ToIp,
        [Parameter(Mandatory)][bool]$Expected
    )
    $want = if ($Expected) { 'reachable' } else { 'blocked' }
    Write-Info "probing $FromPod -> server, expecting $want"

    $r = Wait-ForReachState -FromPod $FromPod -ToIp $ToIp -Expected $Expected
    $pass = ($r.Reached -eq $Expected)
    $got = if ($r.Reached) { "reachable (HTTP $($r.HttpCode))" } else { "blocked (curl exit $($r.ExitCode))" }

    if ($pass) { Write-Ok "$Phase - $got" } else { Write-Fail "$Phase - expected $want, got $got" }

    $script:results += [pscustomobject]@{
        Phase = $Phase; Expected = $want; Actual = $got; Pass = $pass
    }
    return $pass
}

# ------------------------------------------------------------------ 0. preflight

Write-Step 'Preflight'

$kubectl = Resolve-Tool -Name 'kubectl'
Write-Ok "kubectl $kubectl"

$ctx = Get-ToolOutput -Exe $kubectl -Arguments @('config', 'get-contexts', $KubeContext, '-o', 'name')
if ($ctx -notmatch [regex]::Escape($KubeContext)) {
    throw "Kube context '$KubeContext' not found. Run scripts\bootstrap.ps1 first."
}
Write-Ok "context $KubeContext"

# Check the API server answers before interpreting anything it returns.
#
# This exists because of a real misdiagnosis: with the cluster stopped, the CNI check
# below returned an empty pod list and the script reported "probably running kindnet".
# Wrong, and wrong in the worst direction for a security gate - it blamed the component
# under test for an unrelated outage. An empty result is only evidence when the thing
# being queried is actually up.
$readyz = Get-ToolOutput -Exe $kubectl -Arguments @('get', '--raw=/readyz', '--context', $KubeContext)
if ($readyz -ne 'ok') {
    throw ("Cluster '$ClusterName' is not reachable (/readyz returned '$readyz'). " +
           'Start Docker Desktop and wait for it to report Running. The kind containers ' +
           'do not always come back by themselves after the engine restarts - check with ' +
           "'docker ps -a' and start them, or re-run scripts\bootstrap.ps1.")
}
Write-Ok 'api server /readyz ok'

# Report the CNI up front, because it is the component actually under test. A cluster
# running kindnet will fail phase 2, and the reason should be obvious from the log rather
# than inferred from the failure.
$cniPods = Get-ToolOutput -Exe $kubectl -Arguments @(
    'get', 'pods', '-n', 'calico-system', '-l', 'k8s-app=calico-node',
    '--no-headers', '--context', $KubeContext
)
if ([string]::IsNullOrWhiteSpace($cniPods)) {
    Write-Fail 'no calico-node pods found - this cluster is probably running kindnet, which does not enforce NetworkPolicy'
} else {
    $cniCount = @($cniPods -split "`r?`n").Count
    Write-Ok "calico-node present on $cniCount node(s)"
}

# --------------------------------------------------------- 1. namespace and pods

Write-Step "Probe namespace '$Namespace'"

# Deleted and recreated rather than reused: a leftover policy from an aborted run would
# silently invalidate the baseline phase.
Invoke-Tool -Exe $kubectl -Arguments @(
    'delete', 'namespace', $Namespace, '--ignore-not-found', '--wait',
    '--context', $KubeContext
) | Out-Null

$podsManifest = @"
apiVersion: v1
kind: Namespace
metadata:
  name: $Namespace
  labels:
    purpose: netpol-verification
---
apiVersion: v1
kind: Pod
metadata:
  name: server
  namespace: $Namespace
  labels:
    app: server
spec:
  containers:
    - name: server
      image: $ServerImage
      ports:
        - containerPort: $ServerPort
      readinessProbe:
        httpGet: { path: /, port: $ServerPort }
        periodSeconds: 2
      resources:
        requests: { cpu: 10m, memory: 32Mi }
        limits:   { cpu: 100m, memory: 64Mi }
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: { drop: ['ALL'] }
---
apiVersion: v1
kind: Pod
metadata:
  name: client
  namespace: $Namespace
  labels:
    app: client
    # The label the allow policy selects on. This mirrors how the real charts work:
    # woo-mcp will accept ingress from pods carrying the gateway's labels, not from an
    # IP range, so identity is the selector and rescheduling cannot break it.
    netpol-probe/role: allowed
spec:
  containers:
    - name: curl
      image: $ClientImage
      command: ['sleep', 'infinity']
      resources:
        requests: { cpu: 10m, memory: 16Mi }
        limits:   { cpu: 100m, memory: 32Mi }
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: { drop: ['ALL'] }
---
apiVersion: v1
kind: Pod
metadata:
  name: stranger
  namespace: $Namespace
  labels:
    app: stranger
spec:
  containers:
    - name: curl
      image: $ClientImage
      command: ['sleep', 'infinity']
      resources:
        requests: { cpu: 10m, memory: 16Mi }
        limits:   { cpu: 100m, memory: 32Mi }
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: { drop: ['ALL'] }
"@

Invoke-Manifest -Name 'pods' -Content $podsManifest

foreach ($pod in @('server', 'client', 'stranger')) {
    Invoke-Tool -Exe $kubectl -Arguments @(
        'wait', '--for=condition=Ready', "pod/$pod", '-n', $Namespace,
        '--timeout=180s', '--context', $KubeContext
    ) | Out-Null
}
Write-Ok 'server, client and stranger are Ready'

# A bare jsonpath like this is safe. The expression that PowerShell mangles is a filter
# containing inner double quotes - [?(@.type=="Available")] loses them when passed to a
# native executable, which is why bootstrap.ps1 uses `kubectl wait` for conditions. There
# are no quotes to strip here.
$serverIp = Get-ToolOutput -Exe $kubectl -Arguments @(
    'get', 'pod', 'server', '-n', $Namespace, '-o', 'jsonpath={.status.podIP}',
    '--context', $KubeContext
)
if ([string]::IsNullOrWhiteSpace($serverIp)) { throw 'Could not read the server pod IP.' }
Write-Ok "server pod IP $serverIp"

# ---------------------------------------------------------------- the four phases

$allPassed = $true
try {
    Write-Step 'Phase 1 - BASELINE: no policy, traffic must flow'
    $allPassed = (Assert-Reach -Phase 'baseline' -FromPod 'client' -ToIp $serverIp -Expected $true) -and $allPassed

    Write-Step 'Phase 2 - DENY: default-deny ingress, traffic must stop'

    # Ingress only, deliberately.
    #
    # Adding Egress to policyTypes here would also block the client's DNS lookups, and a
    # DNS failure is indistinguishable from a blocked connection at the curl exit code.
    # The test would still pass, but it would no longer be testing what it claims to.
    # The real charts do deny egress - and therefore carry an explicit allow for
    # kube-dns, which is the rule people forget.
    $denyManifest = @"
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: $Namespace
spec:
  podSelector: {}
  policyTypes: [Ingress]
"@
    Invoke-Manifest -Name 'deny' -Content $denyManifest
    $allPassed = (Assert-Reach -Phase 'default-deny' -FromPod 'client' -ToIp $serverIp -Expected $false) -and $allPassed

    Write-Step 'Phase 3 - ALLOW: selector policy re-opens the path for client'

    # Note there is no `delete` of the deny policy. Policies are additive: a pod selected
    # by any policy is isolated, and traffic is permitted only if some policy allows it.
    # Demonstrating that an allow rule lands on top of a standing default-deny is the
    # shape every chart in this repo uses.
    $allowManifest = @"
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-client-to-server
  namespace: $Namespace
spec:
  podSelector:
    matchLabels:
      app: server
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              netpol-probe/role: allowed
      ports:
        - protocol: TCP
          port: $ServerPort
"@
    Invoke-Manifest -Name 'allow' -Content $allowManifest
    $allPassed = (Assert-Reach -Phase 'allow-client' -FromPod 'client' -ToIp $serverIp -Expected $true) -and $allPassed

    Write-Step 'Phase 4 - SELECTIVE: the unlabelled stranger must still be blocked'
    $allPassed = (Assert-Reach -Phase 'deny-stranger' -FromPod 'stranger' -ToIp $serverIp -Expected $false) -and $allPassed
}
finally {
    if ($KeepNamespace) {
        Write-Step 'Cleanup skipped'
        Write-Info "namespace '$Namespace' left in place; delete it with:"
        Write-Info "  kubectl delete namespace $Namespace --context $KubeContext"
    } else {
        Write-Step 'Cleanup'
        Invoke-Tool -Exe $kubectl -Arguments @(
            'delete', 'namespace', $Namespace, '--ignore-not-found', '--wait=false',
            '--context', $KubeContext
        ) -AllowFailure | Out-Null
        Write-Ok "namespace '$Namespace' deleted"
    }
}

# ---------------------------------------------------------------------- verdict

Write-Step 'Result'
$script:results | Format-Table -AutoSize @(
    @{ Label = 'Phase';    Expression = { $_.Phase } }
    @{ Label = 'Expected'; Expression = { $_.Expected } }
    @{ Label = 'Actual';   Expression = { $_.Actual } }
    @{ Label = 'Pass';     Expression = { if ($_.Pass) { 'yes' } else { 'NO' } } }
) | Out-Host

if ($allPassed -and $script:results.Count -eq 4) {
    Write-Host ''
    Write-Host 'PASS - NetworkPolicy is enforced, and enforcement is selective.' -ForegroundColor Green
    Write-Host 'The isolation requirements in the brief can be built on this cluster.' -ForegroundColor Green
    exit 0
}

Write-Host ''
Write-Host 'FAIL - NetworkPolicy is not enforced as required.' -ForegroundColor Red
Write-Host 'Do not build application isolation on this cluster. Options:' -ForegroundColor Red
Write-Host '  1. Check the CNI:  kubectl get tigerastatus' -ForegroundColor Yellow
Write-Host '  2. Re-run bootstrap with a clean cluster:  .\scripts\bootstrap.ps1 -Recreate' -ForegroundColor Yellow
Write-Host '  3. Switch to k3d, which enforces NetworkPolicy natively (see docs/meaning.md 2.2)' -ForegroundColor Yellow
exit 1

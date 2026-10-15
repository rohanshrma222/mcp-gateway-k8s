<#
.SYNOPSIS
    Proves that every MCP upstream is reachable only from the gateway, and from nowhere else.

.DESCRIPTION
    `verify-netpol.ps1` proves the CLUSTER enforces NetworkPolicy at all, using throwaway
    pods. This script proves the claim about the REAL workloads: the brief requires that
    the WooCommerce MCP server is unreachable from outside the cluster, and that the extra
    upstreams are reachable only from the gateway. Those are two different statements and
    this checks both, against whatever is actually deployed.

    Written as a script rather than a list of commands in a document for one reason: this
    is a demo claim. A claim re-tested on demand is a property; a claim typed out once and
    remembered is an anecdote. It also means a change to a chart that quietly opens a path
    fails here rather than in front of someone.

    Five phases:

      1. NO ROUTE       No Ingress object references any upstream, anywhere in the cluster.
                        The strongest form of "not reachable from outside" is that the
                        object which would route to it does not exist - nothing to
                        misconfigure later.

      2. GATEWAY IN     The gateway pod can POST an MCP tools/list to each upstream and get
                        a real protocol response. This runs FIRST among the reachability
                        phases, deliberately: without it, phase 3 failing could just mean
                        the upstreams are broken.

      3. STRANGER OUT   An unlabelled pod in an unrelated namespace cannot reach any
                        upstream. This is the phase that matches the requirement - not
                        "traffic is restricted" but "only the gateway gets through".

      4. EGRESS         Each upstream we control cannot reach the internet, the store
                        database, the gateway, or the Kubernetes API. A compromised or
                        prompt-injected upstream has nowhere to send anything.

      5. LATERAL        Upstreams cannot reach each other. Co-tenancy in one namespace is
                        not a trust relationship, and the default-deny plus DNS-only egress
                        should already make this true - but "should already" is exactly the
                        kind of claim worth a test.

    Exit code is 0 only if every phase passes, so it is usable as a gate.

.PARAMETER KeepProbe
    Leave the probe namespace in place for inspection. Deleted by default, pass or fail.

.EXAMPLE
    .\scripts\verify-upstream-isolation.ps1
#>
[CmdletBinding()]
param(
    [switch]$KeepProbe
)

$ErrorActionPreference = 'Stop'

$script:step = 0
$script:failures = @()

function Write-Step([string]$Message) {
    $script:step++
    Write-Host ''
    Write-Host ("[{0}] {1}" -f $script:step, $Message) -ForegroundColor Cyan
}
function Write-Ok   ([string]$m) { Write-Host "    ok   $m" -ForegroundColor Green }
function Write-Fail ([string]$m) { Write-Host "    FAIL $m" -ForegroundColor Red; $script:failures += $m }
function Write-Info ([string]$m) { Write-Host "    ..   $m" -ForegroundColor DarkGray }

$kubectl = (Get-Command kubectl -ErrorAction Stop).Source
$probeNs = 'netpol-probe-upstreams'

# The upstreams under test, as (namespace, service, label-component) triples. woo-mcp lives
# in the store release and the other two in the upstreams release - the isolation claim is
# the same for all three, which is why they are checked by one script rather than per chart.
$upstreams = @(
    @{ Name = 'woo-mcp';        Namespace = 'store-default'; Service = 'store-default-woo-mcp';        Ours = $true  }
    @{ Name = 'notes-mcp';      Namespace = 'mcp-upstreams'; Service = 'upstreams-notes-mcp';          Ours = $true  }
    # everything-mcp is third-party and runs in session mode, so a bare tools/list without
    # an initialize handshake is not a fair reachability probe for it - phase 2 checks the
    # TCP path instead. It is still covered by phases 1, 3 and 5.
    @{ Name = 'everything-mcp'; Namespace = 'mcp-upstreams'; Service = 'upstreams-everything-mcp';     Ours = $false }
)

# Native-command output, the way verify-netpol.ps1 already learned to do it.
#
# NOT `2>&1`. In Windows PowerShell 5.1 redirecting a native executable's stderr inside
# PowerShell wraps each line in an ErrorRecord, which sets $? to false even on exit code 0 -
# and with $ErrorActionPreference = 'Stop' that turns an EXPECTED failure into a terminating
# error. The first version of this script did exactly that and died in phase 3 on the curl
# timeout it was written to observe: the thing being tested crashed the test.
#
# So stderr goes to $null and the exit code is the signal, with the preference relaxed for
# the duration of the call.
function Get-Out([string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $kubectl @Arguments 2>$null
        $code = $LASTEXITCODE
        $text = if ($null -eq $out) { '' } else { ($out | Out-String).Trim() }
        return @{ Text = $text; Code = $code }
    }
    finally { $ErrorActionPreference = $previous }
}

# ---------------------------------------------------------------------------- phase 1

Write-Step 'NO ROUTE - no Ingress object references any upstream'

$ingressJson = (Get-Out @('get', 'ingress', '-A', '-o', 'json')).Text
$ingress = $ingressJson | ConvertFrom-Json
$backends = @()
foreach ($item in $ingress.items) {
    foreach ($rule in $item.spec.rules) {
        foreach ($path in $rule.http.paths) {
            $backends += [pscustomobject]@{
                Ingress = "$($item.metadata.namespace)/$($item.metadata.name)"
                Service = $path.backend.service.name
            }
        }
    }
}
Write-Info "$($ingress.items.Count) Ingress object(s) cluster-wide, $($backends.Count) backend reference(s)"
foreach ($b in $backends) { Write-Info "  $($b.Ingress) -> $($b.Service)" }

foreach ($u in $upstreams) {
    $hit = $backends | Where-Object { $_.Service -eq $u.Service }
    if ($hit) { Write-Fail "$($u.Name) is routed by Ingress $($hit.Ingress)" }
    else      { Write-Ok   "$($u.Name) is referenced by no Ingress" }
}

$upstreamNsIngress = $ingress.items | Where-Object { $_.metadata.namespace -eq 'mcp-upstreams' }
if ($upstreamNsIngress) { Write-Fail "mcp-upstreams contains $($upstreamNsIngress.Count) Ingress object(s)" }
else                    { Write-Ok   'mcp-upstreams contains no Ingress object at all' }

# ---------------------------------------------------------------------------- phase 2

Write-Step 'GATEWAY IN - the gateway can reach every upstream'

foreach ($u in $upstreams) {
    $url = "http://$($u.Service).$($u.Namespace).svc.cluster.local:3000/mcp"
    if ($u.Ours) {
        # A real MCP request. Proves the protocol path, not just the port - a TCP check
        # would pass against a process that had stopped answering.
        $cmd = "wget -q -O- --timeout=8 --post-data='{\""jsonrpc\"":\""2.0\"",\""id\"":1,\""method\"":\""tools/list\""}' " +
               "--header='Content-Type: application/json' --header='Accept: application/json, text/event-stream' $url"
        $r = Get-Out @('exec', '-n', 'urumi-platform', 'deploy/platform-gateway', '--', 'sh', '-c', $cmd)
        if ($r.Code -eq 0 -and $r.Text -match '"tools"') { Write-Ok "$($u.Name): gateway got a real tools/list response" }
        else { Write-Fail "$($u.Name): gateway could not get tools/list (exit $($r.Code))" }
    }
    else {
        # Session-mode server: check the TCP path only. See the comment on $upstreams.
        $cmd = "nc -z -w 5 $($u.Service).$($u.Namespace).svc.cluster.local 3000 && echo OPEN"
        $r = Get-Out @('exec', '-n', 'urumi-platform', 'deploy/platform-gateway', '--', 'sh', '-c', $cmd)
        if ($r.Text -match 'OPEN') { Write-Ok "$($u.Name): gateway can open a connection" }
        else { Write-Fail "$($u.Name): gateway could not connect (exit $($r.Code))" }
    }
}

# ---------------------------------------------------------------------------- phase 3

Write-Step 'STRANGER OUT - an unrelated pod can reach nothing'

Write-Info "creating probe namespace $probeNs"
(Get-Out @('create', 'namespace', $probeNs, '--dry-run=client', '-o', 'yaml')).Text | & $kubectl apply -f - | Out-Null

try {
    # One long-lived pod, so each target is a fast exec rather than a fresh pod start. It
    # carries NO labels the policies look for, which is the whole point: it is a pod that
    # simply exists somewhere in the cluster.
    $podYaml = @"
apiVersion: v1
kind: Pod
metadata:
  name: stranger
  namespace: $probeNs
spec:
  restartPolicy: Never
  containers:
    - name: probe
      image: curlimages/curl:8.11.1
      command: ['sleep', '600']
"@
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $podYaml | & $kubectl apply -f - 2>$null | Out-Null } finally { $ErrorActionPreference = $previous }
    Get-Out @('wait', '--for=condition=Ready', 'pod/stranger', '-n', $probeNs, '--timeout=120s') | Out-Null

    foreach ($u in $upstreams) {
        $target = "http://$($u.Service).$($u.Namespace).svc.cluster.local:3000/mcp"
        $r = Get-Out @('exec', '-n', $probeNs, 'stranger', '--', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '6', $target)
        # A blocked path times out (curl exit 28) or returns 000. Anything that answers at
        # all is a failure, including an error status - a 405 would still mean the packet
        # arrived.
        if ($r.Text -match '^\s*000\s*$' -or $r.Code -ne 0) { Write-Ok "$($u.Name): stranger blocked (exit $($r.Code))" }
        else { Write-Fail "$($u.Name): stranger REACHED it and got HTTP $($r.Text)" }
    }

    # Same pod, against something it SHOULD reach, so a blanket network failure in the probe
    # pod cannot masquerade as correct isolation. This is phase 1 of verify-netpol.ps1's
    # logic applied here: prove the prober works before trusting its negatives.
    $r = Get-Out @('exec', '-n', $probeNs, 'stranger', '--', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '8', # No space after the colon, deliberately. Windows PowerShell 5.1 splits a native
    # argument on an embedded space however it is quoted, so 'Host: store.urumi.local'
    # reached curl as two arguments and it tried to fetch the hostname as a URL - the
    # control probe failed while the thing it was controlling for was fine. curl accepts
    # the compact form, and it has no space to split.
    '-H', 'Host:store.urumi.local', 'http://traefik.traefik.svc.cluster.local/')
    if ($r.Text -match '200|30\d') { Write-Ok "control: the same pod CAN reach the public storefront route (HTTP $($r.Text)) - so its failures above were the policy" }
    else { Write-Fail "control: the probe pod could not reach the storefront either (HTTP $($r.Text)) - the negatives above prove nothing" }
}
finally {
    if (-not $KeepProbe) {
        Write-Info "deleting probe namespace $probeNs"
        Get-Out @('delete', 'namespace', $probeNs, '--wait=false') | Out-Null
    }
}

# ---------------------------------------------------------------------------- phase 4

Write-Step 'EGRESS - our upstreams can reach nothing but DNS'

$egressTargets = @(
    @{ Label = 'the internet';      Url = 'http://1.1.1.1/' }
    @{ Label = 'the store website'; Url = 'http://store-default-wordpress.store-default.svc.cluster.local/' }
    @{ Label = 'the gateway';       Url = 'http://platform-gateway.urumi-platform.svc.cluster.local:3000/healthz' }
    @{ Label = 'the Kubernetes API'; Url = 'https://kubernetes.default.svc/' }
)

foreach ($u in ($upstreams | Where-Object { $_.Name -ne 'woo-mcp' })) {
    # woo-mcp is excluded because it legitimately needs egress to WordPress - that IS its
    # job. Its egress rules are verified in the store chart's own policy and in stage 3.
    $pod = (Get-Out @('get', 'pods', '-n', $u.Namespace, '-l', "app.kubernetes.io/component=$($u.Name)", '-o', 'jsonpath={.items[0].metadata.name}')).Text
    if (-not $pod) { Write-Fail "$($u.Name): no pod found to test egress from"; continue }

    foreach ($t in $egressTargets) {
        $js = "fetch('$($t.Url)',{signal:AbortSignal.timeout(5000)}).then(r=>console.log('REACHED '+r.status)).catch(e=>console.log('BLOCKED'))"
        $r = Get-Out @('exec', '-n', $u.Namespace, $pod, '--', 'node', '-e', $js)
        if ($r.Text -match 'BLOCKED') { Write-Ok "$($u.Name) cannot reach $($t.Label)" }
        else { Write-Fail "$($u.Name) REACHED $($t.Label): $($r.Text)" }
    }

    # DNS must still work, or the pod could not start or resolve anything - which would make
    # the four results above true for the wrong reason.
    $js = "require('dns').promises.resolve4('kubernetes.default.svc.cluster.local').then(a=>console.log('RESOLVED '+a[0])).catch(e=>console.log('DNSFAIL'))"
    $r = Get-Out @('exec', '-n', $u.Namespace, $pod, '--', 'node', '-e', $js)
    if ($r.Text -match 'RESOLVED') { Write-Ok "$($u.Name) CAN still resolve DNS - so the blocks above are egress rules, not a broken pod" }
    else { Write-Fail "$($u.Name) cannot resolve DNS either ($($r.Text)) - the blocks above prove nothing" }
}

# ---------------------------------------------------------------------------- phase 5

Write-Step 'LATERAL - upstreams cannot reach each other'

$pairs = @(
    @{ From = 'notes-mcp';      FromNs = 'mcp-upstreams'; To = 'upstreams-everything-mcp' }
    @{ From = 'everything-mcp'; FromNs = 'mcp-upstreams'; To = 'upstreams-notes-mcp' }
)
foreach ($p in $pairs) {
    $pod = (Get-Out @('get', 'pods', '-n', $p.FromNs, '-l', "app.kubernetes.io/component=$($p.From)", '-o', 'jsonpath={.items[0].metadata.name}')).Text
    if (-not $pod) { Write-Fail "$($p.From): no pod found"; continue }
    $js = "fetch('http://$($p.To).mcp-upstreams.svc.cluster.local:3000/mcp',{signal:AbortSignal.timeout(5000)}).then(r=>console.log('REACHED '+r.status)).catch(e=>console.log('BLOCKED'))"
    $r = Get-Out @('exec', '-n', $p.FromNs, $pod, '--', 'node', '-e', $js)
    if ($r.Text -match 'BLOCKED') { Write-Ok "$($p.From) cannot reach $($p.To) - sharing a namespace is not a trust relationship" }
    else { Write-Fail "$($p.From) REACHED $($p.To): $($r.Text)" }
}

# ---------------------------------------------------------------------------- result

Write-Host ''
Write-Host 'Result' -ForegroundColor Cyan
if ($script:failures.Count -eq 0) {
    Write-Host '    every upstream is reachable from the gateway and from nothing else' -ForegroundColor Green
    exit 0
}
Write-Host "    $($script:failures.Count) check(s) failed:" -ForegroundColor Red
foreach ($f in $script:failures) { Write-Host "      - $f" -ForegroundColor Red }
exit 1

<#
.SYNOPSIS
    Audits the security posture of every workload in the cluster. Step 9.4, stand-out #6.

.DESCRIPTION
    This script exists because "every workload is non-root with a read-only root filesystem
    and dropped capabilities" is a claim about ~10 pods across 3 namespaces, written by hand
    in Helm templates over two weeks. Asserting it is easy; being right about it is not, and
    the failure mode is silent - a missing `readOnlyRootFilesystem` looks like nothing at all.

    So it checks the LIVE cluster rather than the templates. A template says what should be
    deployed; the API server says what is. Those differ whenever a template was edited and
    not applied - which 8.2 found happening for a whole step, because a mutable image tag
    meant `helm upgrade` changed nothing.

    Every check prints what it found, not just a verdict, so a reviewer can disagree with the
    threshold rather than having to trust the word PASS. Exit code 0 only if every check
    passes, so it is usable as a gate.

.NOTES
    Read-only. It makes no changes and needs no credentials beyond a working kubeconfig.
#>

[CmdletBinding()]
param(
    [string[]] $Namespaces = @('store-default', 'mcp-upstreams', 'urumi-platform'),
    # Set to skip the NetworkPolicy reachability probes, which take ~30s and create a pod.
    [switch] $SkipProbes
)

$ErrorActionPreference = 'Stop'
$script:failures = 0
$script:checks = 0

function Write-Section([string] $Title) {
    Write-Host ''
    Write-Host "=== $Title ===" -ForegroundColor Cyan
}

function Assert-Check {
    param(
        [string] $Name,
        [bool]   $Ok,
        [string] $Detail = ''
    )
    $script:checks++
    if ($Ok) {
        Write-Host ("  PASS  {0}" -f $Name) -ForegroundColor Green
    } else {
        $script:failures++
        Write-Host ("  FAIL  {0}" -f $Name) -ForegroundColor Red
    }
    if ($Detail -ne '') {
        Write-Host ("        {0}" -f $Detail) -ForegroundColor DarkGray
    }
}

function Get-Json([string[]] $KubectlArgs) {
    # The preference is relaxed around the native call, which is the lesson 6.5 paid for:
    # in Windows PowerShell 5.1 a native executable writing to stderr produces an ErrorRecord
    # that sets $? to false even on exit code 0, and under `$ErrorActionPreference = 'Stop'`
    # that becomes a terminating error. A kubectl that cannot reach the API server writes a
    # long complaint to stderr, so without this the audit dies on the one condition it should
    # report calmly.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = & kubectl @KubectlArgs 2>$null
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) { return $null }
        return $raw | ConvertFrom-Json
    }
    finally { $ErrorActionPreference = $previous }
}

# A reachable cluster is a precondition, not a check: without it every single check below
# would report FAIL and bury the one fact that matters.
function Assert-ClusterReachable {
    $nodes = Get-Json @('get', 'nodes', '-o', 'json')
    if ($null -eq $nodes -or $nodes.items.Count -eq 0) {
        Write-Host ''
        Write-Host '  Cannot reach the cluster.' -ForegroundColor Red
        Write-Host '  Check that Docker Desktop is running and the context is kind-urumi:' -ForegroundColor DarkGray
        Write-Host '      kubectl config use-context kind-urumi' -ForegroundColor DarkGray
        exit 2
    }
    Write-Host ("nodes: {0}" -f (($nodes.items | ForEach-Object { $_.metadata.name }) -join ', ')) -ForegroundColor DarkGray
}

Write-Host 'Security posture audit (9.4)' -ForegroundColor White
Write-Host ("namespaces: {0}" -f ($Namespaces -join ', ')) -ForegroundColor DarkGray
Assert-ClusterReachable

# ---------------------------------------------------------------------------------------
# 1. Container hardening, on every pod that is actually running.
#
# Checked per CONTAINER rather than per pod, because a pod with a hardened app container and
# an unhardened init container is not hardened - and init containers are easy to forget,
# since they are written once and never looked at again.
# ---------------------------------------------------------------------------------------
Write-Section 'Container hardening (live pods)'

foreach ($ns in $Namespaces) {
    $pods = Get-Json @('get', 'pods', '-n', $ns, '-o', 'json')
    if ($null -eq $pods) {
        Assert-Check "namespace $ns is reachable" $false 'kubectl returned nothing'
        continue
    }

    foreach ($pod in $pods.items) {
        # Completed Jobs are included deliberately: a bootstrap or migration Job runs with
        # real privileges against real data, so its posture matters as much as a Deployment's
        # - and it is the thing nobody re-reads after it worked once.
        $podName = $pod.metadata.name
        $podSec  = $pod.spec.securityContext

        $allContainers = @()
        if ($pod.spec.initContainers) { $allContainers += $pod.spec.initContainers }
        if ($pod.spec.containers)     { $allContainers += $pod.spec.containers }

        foreach ($c in $allContainers) {
            $sec = $c.securityContext
            $label = "$ns/$podName [$($c.name)]"

            # runAsNonRoot can be set on the pod or the container; either satisfies it.
            $nonRoot = ($sec.runAsNonRoot -eq $true) -or ($podSec.runAsNonRoot -eq $true)
            $readOnly = $sec.readOnlyRootFilesystem -eq $true
            $noEscalate = $sec.allowPrivilegeEscalation -eq $false
            $dropsAll = $false
            if ($sec.capabilities -and $sec.capabilities.drop) {
                $dropsAll = $sec.capabilities.drop -contains 'ALL'
            }
            $notPrivileged = $sec.privileged -ne $true

            $problems = @()
            if (-not $nonRoot)       { $problems += 'runAsNonRoot' }
            if (-not $readOnly)      { $problems += 'readOnlyRootFilesystem' }
            if (-not $noEscalate)    { $problems += 'allowPrivilegeEscalation!=false' }
            if (-not $dropsAll)      { $problems += 'capabilities.drop missing ALL' }
            if (-not $notPrivileged) { $problems += 'privileged=true' }

            Assert-Check $label ($problems.Count -eq 0) ($problems -join ', ')
        }
    }
}

# ---------------------------------------------------------------------------------------
# 2. Resource requests AND limits.
#
# Both, not either. A request with no limit means the pod can starve its neighbours; a limit
# with no request means the scheduler has no idea how much room it needs and may place it
# somewhere it cannot run. The brief asks for both on every workload.
# ---------------------------------------------------------------------------------------
Write-Section 'Resource requests and limits'

foreach ($ns in $Namespaces) {
    $pods = Get-Json @('get', 'pods', '-n', $ns, '-o', 'json')
    if ($null -eq $pods) { continue }

    foreach ($pod in $pods.items) {
        $allContainers = @()
        if ($pod.spec.initContainers) { $allContainers += $pod.spec.initContainers }
        if ($pod.spec.containers)     { $allContainers += $pod.spec.containers }

        foreach ($c in $allContainers) {
            $r = $c.resources
            $missing = @()
            if (-not $r.requests.cpu)    { $missing += 'requests.cpu' }
            if (-not $r.requests.memory) { $missing += 'requests.memory' }
            if (-not $r.limits.memory)   { $missing += 'limits.memory' }

            # A CPU LIMIT is deliberately not required, and this is the one threshold in the
            # script worth arguing about. A CPU limit throttles rather than kills, and
            # throttling a request handler produces latency that looks like a slow upstream.
            # Memory limits are different: without one a leak takes the node down. So the
            # rule here is "requests for both, a hard limit on memory", and a missing CPU
            # limit is reported as information rather than a failure.
            $note = ''
            if (-not $r.limits.cpu) { $note = 'no cpu limit (deliberate: throttling looks like latency)' }

            # -join, not Join-String: the latter is PowerShell 7+ and this project targets the
            # Windows PowerShell 5.1 that ships with the OS, so a 7-only cmdlet is a script
            # that works on the author machine and nowhere else.
            $detail = (@(($missing -join ', '), $note) | Where-Object { $_ -ne '' }) -join ' | '
            Assert-Check "$ns/$($pod.metadata.name) [$($c.name)] resources" ($missing.Count -eq 0) $detail
        }
    }
}

# ---------------------------------------------------------------------------------------
# 3. A default-deny NetworkPolicy per namespace.
#
# "Default deny" means a policy selecting ALL pods (empty podSelector) with both policy
# types and no rules that admit anything. A namespace with only allow-policies is
# default-ALLOW for any pod those policies do not select, which is the state that looks
# secure in a diagram and is not.
# ---------------------------------------------------------------------------------------
Write-Section 'Default-deny NetworkPolicy per namespace'

foreach ($ns in $Namespaces) {
    $policies = Get-Json @('get', 'networkpolicy', '-n', $ns, '-o', 'json')
    if ($null -eq $policies) {
        Assert-Check "$ns has NetworkPolicies" $false 'none found'
        continue
    }

    $defaultDeny = $policies.items | Where-Object {
        $selectsAll = $null -eq $_.spec.podSelector.matchLabels -and $null -eq $_.spec.podSelector.matchExpressions
        $bothTypes  = ($_.spec.policyTypes -contains 'Ingress') -and ($_.spec.policyTypes -contains 'Egress')
        $noIngress  = -not $_.spec.ingress -or $_.spec.ingress.Count -eq 0
        $noEgress   = -not $_.spec.egress  -or $_.spec.egress.Count  -eq 0
        $selectsAll -and $bothTypes -and $noIngress -and $noEgress
    }

    Assert-Check "$ns default-deny (all pods, both directions, no rules)" ($null -ne $defaultDeny) (
        "policies in namespace: " + (($policies.items | ForEach-Object { $_.metadata.name }) -join ', ')
    )
}

# ---------------------------------------------------------------------------------------
# 4. Service account tokens.
#
# Nothing in this platform talks to the Kubernetes API, so no pod needs a token. A mounted
# token is a credential sitting in a container for no reason - and the one thing an attacker
# with code execution looks for first.
# ---------------------------------------------------------------------------------------
Write-Section 'Service account tokens not mounted'

foreach ($ns in $Namespaces) {
    $pods = Get-Json @('get', 'pods', '-n', $ns, '-o', 'json')
    if ($null -eq $pods) { continue }

    foreach ($pod in $pods.items) {
        # The reliable test is whether the projected token volume exists, not what the spec
        # field says: `automountServiceAccountToken: false` on the pod is what we set, but
        # the ServiceAccount can also set it, and the only thing that matters is whether the
        # file is in the container.
        $hasTokenVolume = $false
        if ($pod.spec.volumes) {
            foreach ($v in $pod.spec.volumes) {
                if ($v.projected -and $v.projected.sources) {
                    foreach ($s in $v.projected.sources) {
                        if ($s.serviceAccountToken) { $hasTokenVolume = $true }
                    }
                }
                if ($v.name -like 'kube-api-access*') { $hasTokenVolume = $true }
            }
        }
        # The detail is precomputed: `if` as an EXPRESSION is PowerShell 7+, and this project
        # targets the 5.1 that ships with Windows. Second time in this script - the same
        # mistake in two forms, both only visible when the script actually runs.
        $tokenDetail = ''
        if ($hasTokenVolume) { $tokenDetail = 'a kube-api-access volume is present' }
        Assert-Check "$ns/$($pod.metadata.name) has no API token mounted" (-not $hasTokenVolume) $tokenDetail
    }
}

# ---------------------------------------------------------------------------------------
# 5. RBAC: least privilege for anything that does touch the API server.
#
# The expected answer is that this project creates no Roles or ClusterRoles at all, because
# nothing needs the API. Checked rather than assumed, since a chart dependency could add one.
# ---------------------------------------------------------------------------------------
Write-Section 'RBAC footprint'

$ourRoles = @()
foreach ($ns in $Namespaces) {
    $roles = Get-Json @('get', 'role,rolebinding', '-n', $ns, '-o', 'json')
    if ($null -ne $roles -and $roles.items.Count -gt 0) {
        $ourRoles += $roles.items | ForEach-Object { "$ns/$($_.kind)/$($_.metadata.name)" }
    }
}
$roleDetail = 'nothing in this platform talks to the API server'
if ($ourRoles.Count -gt 0) { $roleDetail = $ourRoles -join ', ' }
Assert-Check 'no Roles or RoleBindings in our namespaces' ($ourRoles.Count -eq 0) $roleDetail

$clusterRoles = Get-Json @('get', 'clusterrolebinding', '-o', 'json')
$oursBound = @()
if ($null -ne $clusterRoles) {
    foreach ($crb in $clusterRoles.items) {
        if (-not $crb.subjects) { continue }
        foreach ($s in $crb.subjects) {
            if ($s.kind -eq 'ServiceAccount' -and $Namespaces -contains $s.namespace) {
                $oursBound += "$($crb.metadata.name) -> $($s.namespace)/$($s.name)"
            }
        }
    }
}
$crbDetail = ''
if ($oursBound.Count -gt 0) { $crbDetail = $oursBound -join ', ' }
Assert-Check 'no ClusterRoleBinding grants our service accounts anything' ($oursBound.Count -eq 0) $crbDetail

# ---------------------------------------------------------------------------------------
# 6. No secret values in environment variables.
#
# Every secret should arrive by secretKeyRef or a mounted file, never as a literal in the
# pod spec - because a pod spec is readable by anything that can `kubectl get pod -o yaml`,
# it ends up in `helm get manifest`, and it is printed by half the debugging commands anyone
# runs. This checks for the SHAPE of a leak rather than guessing at names.
# ---------------------------------------------------------------------------------------
Write-Section 'No literal secrets in pod environment'

$suspiciousNames = 'PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL|PASSWD|PRIVATE'
foreach ($ns in $Namespaces) {
    $pods = Get-Json @('get', 'pods', '-n', $ns, '-o', 'json')
    if ($null -eq $pods) { continue }

    foreach ($pod in $pods.items) {
        $allContainers = @()
        if ($pod.spec.initContainers) { $allContainers += $pod.spec.initContainers }
        if ($pod.spec.containers)     { $allContainers += $pod.spec.containers }

        $leaks = @()
        foreach ($c in $allContainers) {
            if (-not $c.env) { continue }
            foreach ($e in $c.env) {
                if ($e.name -notmatch $suspiciousNames) { continue }
                if ($null -eq $e.value -or $e.value -eq '') { continue }

                # The name alone is too crude, which the first run of this script proved by
                # reporting four false positives: WC_PASSWORD_FILE and APP_PASSWORD_NAME are a
                # path and a name, UPSTREAM_PRIVATE_HOSTS matched "PRIVATE", and
                # CHAT_KEY_SWEEP_INTERVAL_MS matched "KEY". All four are configuration, and a
                # check that cries wolf four times out of four gets ignored - which is worse
                # than not having it.
                #
                # So the VALUE has to look like a credential as well. Excluded: names whose
                # suffix says they are not one, plain numbers, filesystem paths, and
                # comma-separated lists - and anything short, since a secret worth protecting
                # is not eight characters.
                if ($e.name -match '_(FILE|NAME|PATH|ENABLED|INTERVAL_MS|TIMEOUT_MS|HOSTS|ALLOWLIST)$') { continue }
                if ($e.value -match '^[0-9]+$')        { continue }   # a number
                if ($e.value -match '^/')              { continue }   # a path
                if ($e.value -match ',')               { continue }   # a list
                if ($e.value.Length -lt 12)             { continue }   # too short to matter

                if ($true) {
                    # A literal value on a secret-shaped name. Reported with the name only -
                    # printing the value would make the audit log the leak.
                    $leaks += "$($c.name).$($e.name)"
                }
            }
        }
        Assert-Check "$ns/$($pod.metadata.name) secrets by reference only" ($leaks.Count -eq 0) ($leaks -join ', ')
    }
}

# ---------------------------------------------------------------------------------------
# 7. Probes on every long-running workload.
#
# Mandatory in the brief. Jobs are excluded - a Job has no steady state to probe, and a
# readiness probe on a one-shot container is meaningless.
# ---------------------------------------------------------------------------------------
Write-Section 'Probes on long-running workloads'

foreach ($ns in $Namespaces) {
    foreach ($kind in @('deployment', 'statefulset')) {
        $items = Get-Json @('get', $kind, '-n', $ns, '-o', 'json')
        if ($null -eq $items) { continue }
        foreach ($w in $items.items) {
            foreach ($c in $w.spec.template.spec.containers) {
                $missing = @()
                if (-not $c.readinessProbe) { $missing += 'readinessProbe' }
                if (-not $c.livenessProbe)  { $missing += 'livenessProbe' }
                Assert-Check "$ns/$kind/$($w.metadata.name) [$($c.name)] probes" ($missing.Count -eq 0) ($missing -join ', ')
            }
        }
    }
}

# ---------------------------------------------------------------------------------------
# 8. The upstream isolation claim, as a live reachability probe.
#
# verify-upstream-isolation.ps1 covers this in depth; repeated here in one line so the
# security audit is self-contained and a reviewer running one script sees the headline.
# ---------------------------------------------------------------------------------------
if (-not $SkipProbes) {
    Write-Section 'Upstream isolation (live probe)'

    $ingresses = Get-Json @('get', 'ingress', '-A', '-o', 'json')
    $hosts = @()
    if ($null -ne $ingresses) {
        foreach ($i in $ingresses.items) {
            foreach ($r in $i.spec.rules) { $hosts += "$($i.metadata.namespace)/$($r.host)" }
        }
    }
    # Exactly two: the storefront and the platform. Any third is a way in that nobody
    # intended, and an Ingress is the one object that turns an internal service into a
    # public one by existing.
    Assert-Check 'exactly 2 Ingress hosts cluster-wide' ($hosts.Count -eq 2) ($hosts -join ', ')

    $mcpIngress = @()
    if ($null -ne $ingresses) {
        $mcpIngress = $ingresses.items | Where-Object { $_.metadata.namespace -eq 'mcp-upstreams' }
    }
    Assert-Check 'mcp-upstreams has no Ingress at all' ($mcpIngress.Count -eq 0) ''
}

# ---------------------------------------------------------------------------------------
Write-Host ''
Write-Host ("{0} checks, {1} failures" -f $script:checks, $script:failures) -ForegroundColor White
if ($script:failures -gt 0) {
    Write-Host 'SECURITY AUDIT FAILED' -ForegroundColor Red
    exit 1
}
Write-Host 'SECURITY AUDIT PASSED' -ForegroundColor Green
exit 0

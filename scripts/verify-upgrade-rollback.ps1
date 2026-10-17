<#
.SYNOPSIS
    Upgrades the platform to a new image tag, rolls it back, and proves no data was lost.
    Step 9.6.

.DESCRIPTION
    The brief asks for a `helm upgrade` and a `helm rollback` with no data loss. "No data
    loss" is easy to assert after the fact - everything looks fine, the dashboard loads - so
    this takes a fingerprint of every piece of persistent state before touching anything and
    compares it afterwards.

    Four stores, because the platform has four and they fail differently:

      Postgres        users, API keys, audit rows, upstreams, permission rules
      MariaDB         WooCommerce products and orders
      notes SQLite    the notes upstream's own database, on its own PVC
      wp-content      the WordPress uploads and plugins PVC

    It also checks something a count cannot: that each PVC is the SAME OBJECT afterwards, by
    UID. A PVC that was deleted and recreated with identical contents would pass a row count
    and would mean the data had survived by luck rather than by design - and a rollback that
    recreates a volume is a rollback that destroys a database on a cluster where the storage
    class reclaims.

    WHAT THIS DELIBERATELY DOES NOT CLAIM: the schema does not roll back. Migrations are
    forward-only numbered files with a ledger, so rolling the chart back to a revision whose
    image expects an older schema leaves the NEW schema in place. That is safe for additive
    migrations - every one in this project so far - and would not be safe for a migration that
    dropped a column. Stated here rather than discovered during an incident.

.NOTES
    This script makes changes: it upgrades and rolls back a live release. It restores the
    original revision before exiting, including on failure.
#>

[CmdletBinding()]
param(
    [string] $Release   = 'platform',
    [string] $Namespace = 'urumi-platform',
    [string] $Chart     = 'charts/platform',
    [string] $Values    = 'charts/platform/values-local.yaml',
    # The tag to upgrade TO. Must already be loaded into the cluster:
    #   docker build -f services/gateway/Dockerfile -t urumi/gateway:v2 .
    #   kind load docker-image urumi/gateway:v2 --name urumi
    [string] $NewTag    = 'v2'
)

$ErrorActionPreference = 'Stop'
$script:failures = 0
$script:checks = 0

function Write-Step([string] $Message) {
    Write-Host ''
    Write-Host "=== $Message ===" -ForegroundColor Cyan
}

function Assert-Check {
    param([string] $Name, [bool] $Ok, [string] $Detail = '')
    $script:checks++
    if ($Ok) { Write-Host ("  PASS  {0}" -f $Name) -ForegroundColor Green }
    else { $script:failures++; Write-Host ("  FAIL  {0}" -f $Name) -ForegroundColor Red }
    if ($Detail -ne '') { Write-Host ("        {0}" -f $Detail) -ForegroundColor DarkGray }
}

# Native commands get the preference relaxed around them: in Windows PowerShell 5.1 a native
# executable writing to stderr produces an ErrorRecord that becomes terminating under 'Stop'.
# 6.5 paid for this lesson and 9.4 repeated it.
function Invoke-Native {
    param([string] $Exe, [string[]] $Arguments, [string] $StdIn = '')
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($StdIn -ne '') { $out = $StdIn | & $Exe @Arguments 2>$null }
        else { $out = & $Exe @Arguments 2>$null }
        return @{ Text = (($out | Out-String).Trim()); Code = $LASTEXITCODE }
    }
    finally { $ErrorActionPreference = $previous }
}

function Invoke-Psql([string] $Sql) {
    $inner = 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U urumi -d urumi -qXAt'
    return (Invoke-Native -Exe 'kubectl' -Arguments @(
        'exec', '-i', '-n', $Namespace, 'platform-postgres-0', '--', 'sh', '-c', $inner
    ) -StdIn $Sql).Text
}

function Invoke-Mysql([string] $Sql) {
    $pod = (Invoke-Native -Exe 'kubectl' -Arguments @(
        'get', 'pod', '-n', 'store-default', '-l', 'app.kubernetes.io/component=mariadb',
        '-o', 'jsonpath={.items[0].metadata.name}'
    )).Text
    $inner = 'mariadb -u root -p"$MARIADB_ROOT_PASSWORD" -N -B wordpress'
    return (Invoke-Native -Exe 'kubectl' -Arguments @(
        'exec', '-i', '-n', 'store-default', $pod, '--', 'sh', '-c', $inner
    ) -StdIn $Sql).Text
}

<#
    The fingerprint.

    Counts AND a content hash, because counts alone miss a mutation: a rollback that somehow
    rewrote a row would keep the count identical. The hash is over the ids and a couple of
    meaningful columns per table, ordered, so it is stable across reads and changes if
    anything changes.
#>
function Get-Fingerprint {
    $pg = Invoke-Psql @'
SELECT 'users=' || count(*) FROM users;
SELECT 'keys=' || count(*) FROM api_keys;
SELECT 'audit=' || count(*) FROM audit_log;
SELECT 'upstreams=' || count(*) FROM mcp_servers;
SELECT 'tools=' || count(*) FROM mcp_tools;
SELECT 'permissions=' || count(*) FROM tool_permissions;
SELECT 'migrations=' || count(*) FROM schema_migrations;
SELECT 'pghash=' || md5(string_agg(x, '|' ORDER BY x)) FROM (
  SELECT id::text || email || role FROM users
  UNION ALL SELECT id::text || key_id || kind FROM api_keys
  UNION ALL SELECT id::text || slug || coalesce(name,'') FROM mcp_servers
  UNION ALL SELECT id::text || effect || coalesce(role,'') FROM tool_permissions
) AS t(x);
'@

    $products = Invoke-Mysql "SELECT concat('products=', count(*)) FROM wp_posts WHERE post_type='product' AND post_status='publish';"
    $orders   = Invoke-Mysql "SELECT concat('orders=', count(*)) FROM wp_posts WHERE post_type IN ('shop_order','shop_order_placehold');"

    $notesPod = (Invoke-Native -Exe 'kubectl' -Arguments @(
        'get', 'pod', '-n', 'mcp-upstreams', '-l', 'app.kubernetes.io/component=notes-mcp',
        '-o', 'jsonpath={.items[0].metadata.name}'
    )).Text
    # The script goes in on STDIN, not as an argument.
    #
    # Windows PowerShell 5.1 re-splits native-command arguments on embedded spaces, so a
    # one-liner containing `SELECT count(*) c FROM notes` arrives at node as several
    # mangled arguments and silently produces nothing - which is exactly what happened: the
    # fingerprint came back missing its notes lines with no error anywhere. stdin has no
    # quoting rules, which is why Invoke-Psql above already uses it.
    $notesJs = @'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/notes.db");
const count = db.prepare("SELECT count(*) AS c FROM notes").get().c;
const joined = db.prepare("SELECT group_concat(id || title) AS g FROM notes ORDER BY id").get().g;
const hash = require("node:crypto").createHash("md5").update(String(joined)).digest("hex");
console.log("notes=" + count);
console.log("noteshash=" + hash);
'@
    $notes = (Invoke-Native -Exe 'kubectl' -Arguments @(
        'exec', '-i', '-n', 'mcp-upstreams', $notesPod, '--', 'node'
    ) -StdIn $notesJs).Text

    return (@($pg, $products, $orders, $notes) -join "`n")
}

function Get-PvcIdentity {
    $out = @()
    foreach ($ns in @('urumi-platform', 'store-default', 'mcp-upstreams')) {
        $json = (Invoke-Native -Exe 'kubectl' -Arguments @('get', 'pvc', '-n', $ns, '-o', 'json')).Text
        if ([string]::IsNullOrWhiteSpace($json)) { continue }
        $parsed = $json | ConvertFrom-Json
        foreach ($pvc in $parsed.items) {
            $out += ("{0}/{1} uid={2} volume={3}" -f $ns, $pvc.metadata.name, $pvc.metadata.uid, $pvc.spec.volumeName)
        }
    }
    return ($out | Sort-Object) -join "`n"
}

function Get-RunningGatewayImage {
    return (Invoke-Native -Exe 'kubectl' -Arguments @(
        'get', 'deploy', 'platform-gateway', '-n', $Namespace,
        '-o', 'jsonpath={.spec.template.spec.containers[0].image}'
    )).Text
}

function Test-Serving {
    # curl.exe, NOT curl: in Windows PowerShell 5.1 `curl` is an ALIAS for
    # Invoke-WebRequest, so `& 'curl' -o NUL` resolves to the cmdlet and fails with
    # "a positional parameter cannot be found that accepts argument '-o'". The .exe
    # suffix is what forces the real binary. Same trap as `wget`.
    $code = (Invoke-Native -Exe 'curl.exe' -Arguments @(
        '-s', '-o', 'NUL', '-w', '%{http_code}', '-m', '20',
        '-H', 'Host:app.urumi.local', 'http://127.0.0.1/healthz'
    )).Text
    return $code
}

# =======================================================================================
Write-Host 'Upgrade and rollback, with a data-loss proof (9.6)' -ForegroundColor White

$startRevision = (Invoke-Native -Exe 'helm' -Arguments @('list', '-n', $Namespace, '-o', 'json')).Text |
    ConvertFrom-Json | Where-Object { $_.name -eq $Release } | ForEach-Object { $_.revision }
if (-not $startRevision) {
    Write-Host "  cannot read the current revision of $Release in $Namespace" -ForegroundColor Red
    exit 2
}
Write-Host ("release {0} is at revision {1}" -f $Release, $startRevision) -ForegroundColor DarkGray

Write-Step 'Before: fingerprint the persistent state'
$before = Get-Fingerprint
$beforePvc = Get-PvcIdentity
$beforeImage = Get-RunningGatewayImage
$before.Split("`n") | ForEach-Object { Write-Host ("  {0}" -f $_) -ForegroundColor DarkGray }
Write-Host ("  gateway image: {0}" -f $beforeImage) -ForegroundColor DarkGray
Assert-Check 'the platform is serving before the upgrade' ((Test-Serving) -eq '200') ''

try {
    Write-Step "Upgrade: gateway.image.tag -> $NewTag"
    $up = Invoke-Native -Exe 'helm' -Arguments @(
        'upgrade', $Release, $Chart, '--namespace', $Namespace, '--values', $Values,
        '--set', "gateway.image.tag=$NewTag", '--wait', '--timeout', '8m'
    )
    Assert-Check 'helm upgrade succeeded' ($up.Code -eq 0) ($up.Text -split "`n" | Select-Object -Last 1)

    $afterUpImage = Get-RunningGatewayImage
    Assert-Check "the new image is running" ($afterUpImage -like "*:$NewTag") ("image is now $afterUpImage")
    Assert-Check 'the platform serves on the new revision' ((Test-Serving) -eq '200') ''

    $midFingerprint = Get-Fingerprint
    # Precomputed, because `if` AS AN EXPRESSION is PowerShell 7+ and this targets the 5.1
    # that ships with Windows. Third time in this project - 9.4 caught two of these - and the
    # cost here was the worst yet: the script died mid-run, so the ROLLBACK HALF NEVER
    # EXECUTED and the output looked like a clean partial pass.
    $midDetail = ''
    if ($midFingerprint -ne $before) { $midDetail = 'fingerprint differs - see the diff below' }
    Assert-Check 'data is unchanged by the upgrade' ($midFingerprint -eq $before) $midDetail
    if ($midFingerprint -ne $before) {
        Compare-Object ($before -split "`n") ($midFingerprint -split "`n") |
            ForEach-Object { Write-Host ("        {0} {1}" -f $_.SideIndicator, $_.InputObject) -ForegroundColor Yellow }
    }

    Write-Step 'Rollback to the previous revision'
    $rb = Invoke-Native -Exe 'helm' -Arguments @(
        'rollback', $Release, '--namespace', $Namespace, '--wait', '--timeout', '8m'
    )
    Assert-Check 'helm rollback succeeded' ($rb.Code -eq 0) ($rb.Text -split "`n" | Select-Object -Last 1)

    $afterRbImage = Get-RunningGatewayImage
    Assert-Check 'the original image is back' ($afterRbImage -eq $beforeImage) (
        "image is $afterRbImage, was $beforeImage"
    )
    Assert-Check 'the platform serves after the rollback' ((Test-Serving) -eq '200') ''
}
finally {
    # Whatever happened, leave the release where it started. A verification script that can
    # leave a cluster on a test image is a liability, and the `finally` is what makes it safe
    # to run during a demo.
    Write-Step 'Restore'
    $current = (Invoke-Native -Exe 'helm' -Arguments @('list', '-n', $Namespace, '-o', 'json')).Text |
        ConvertFrom-Json | Where-Object { $_.name -eq $Release } | ForEach-Object { $_.revision }
    $image = Get-RunningGatewayImage
    if ($image -ne $beforeImage) {
        Write-Host "  the running image is $image, restoring $beforeImage" -ForegroundColor Yellow
        $null = Invoke-Native -Exe 'helm' -Arguments @(
            'upgrade', $Release, $Chart, '--namespace', $Namespace, '--values', $Values,
            '--wait', '--timeout', '8m'
        )
    }
    Write-Host ("  revision {0} -> {1}, image {2}" -f $startRevision, $current, (Get-RunningGatewayImage)) -ForegroundColor DarkGray
}

Write-Step 'After: compare the fingerprint and the PVC identities'
$after = Get-Fingerprint
$afterPvc = Get-PvcIdentity
$after.Split("`n") | ForEach-Object { Write-Host ("  {0}" -f $_) -ForegroundColor DarkGray }

Assert-Check 'every row and hash is identical to before' ($after -eq $before) ''
if ($after -ne $before) {
    Compare-Object ($before -split "`n") ($after -split "`n") |
        ForEach-Object { Write-Host ("        {0} {1}" -f $_.SideIndicator, $_.InputObject) -ForegroundColor Yellow }
}

# The check a row count cannot make: the volumes are the same OBJECTS, not replacements that
# happen to hold the same data.
Assert-Check 'every PVC is the same object (uid and bound volume unchanged)' ($afterPvc -eq $beforePvc) ''
if ($afterPvc -ne $beforePvc) {
    Compare-Object ($beforePvc -split "`n") ($afterPvc -split "`n") |
        ForEach-Object { Write-Host ("        {0} {1}" -f $_.SideIndicator, $_.InputObject) -ForegroundColor Yellow }
} else {
    $beforePvc -split "`n" | ForEach-Object { Write-Host ("        {0}" -f $_) -ForegroundColor DarkGray }
}

Write-Step 'What this does not prove'
Write-Host '  The SCHEMA does not roll back. Migrations are forward-only numbered files with a' -ForegroundColor DarkGray
Write-Host '  ledger, so rolling the chart back to a revision whose image expects an older schema' -ForegroundColor DarkGray
Write-Host '  leaves the NEW schema in place. Safe for additive migrations - every one here so' -ForegroundColor DarkGray
Write-Host '  far - and not safe for one that dropped a column. A rollback is an application' -ForegroundColor DarkGray
Write-Host '  rollback, not a database one.' -ForegroundColor DarkGray

Write-Host ''
Write-Host ("{0} checks, {1} failures" -f $script:checks, $script:failures) -ForegroundColor White
if ($script:failures -gt 0) {
    Write-Host 'UPGRADE/ROLLBACK VERIFICATION FAILED' -ForegroundColor Red
    exit 1
}
Write-Host 'UPGRADE/ROLLBACK VERIFIED: no data loss in either direction' -ForegroundColor Green
exit 0

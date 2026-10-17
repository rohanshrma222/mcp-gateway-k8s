#!/usr/bin/env node
/**
 * Proves that `values-prod.yaml` changes configuration and not structure. Step 9.5.
 *
 * The brief's requirement is that the same Helm charts deploy to a k3s VPS with config
 * changes only. That is easy to assert and `lint-charts.ps1` has carried a deliberately
 * shallow version of the check since stage 1 - it compares the set of (kind, name) pairs and
 * says in its own docstring that "stage 9 replaces it with a full rendered diff". This is
 * that replacement.
 *
 * ## What "only config changed" actually means
 *
 * Not "the renders are identical" - they must differ, that is the point of an overlay. The
 * precise claim is that **no object has a different shape**: the same objects exist, each with
 * the same containers, volumes, mounts, probes, ports and keys. What differs is the values at
 * the leaves - an image registry, a hostname, a replica count, a memory limit.
 *
 * So the comparison is over **key paths**, not values. For every object present in both
 * renders, the set of paths through its JSON must be identical. A path present in one and
 * absent in the other means a field appeared or vanished, which is a structural change and
 * makes the claim false.
 *
 * Array indices are normalised to `[]`, because `containers[0]` and `containers[1]` differing
 * in count IS structural and is caught by comparing the counts separately - while a differing
 * number of, say, `except` CIDRs in a NetworkPolicy would otherwise produce dozens of path
 * differences that all say one thing.
 *
 * ## Parsing
 *
 * Via `kubectl create --dry-run=client -o json`, so the authoritative Kubernetes parser reads
 * the YAML rather than something written here. kubectl emits concatenated JSON objects rather
 * than an array, which the splitter below handles.
 *
 * ## Known structural differences
 *
 * Some differences in the OBJECT SET are themselves the configuration decision, and those are
 * declared below with a reason rather than silenced. An undeclared one fails the run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

const CHARTS = [
  { name: 'store-default', dir: 'charts/store', namespace: 'store-default' },
  { name: 'upstreams', dir: 'charts/upstreams', namespace: 'mcp-upstreams' },
  { name: 'platform', dir: 'charts/platform', namespace: 'urumi-platform' },
];

/**
 * Object-set differences that are expected, each with the reason it exists.
 *
 * Declared rather than suppressed: a reviewer should be able to read why prod renders fewer
 * objects and judge whether each reason is acceptable. Anything not on this list is a failure,
 * which is what makes the check a gate rather than a report.
 */
const EXPECTED_ONLY_IN_LOCAL = [
  {
    match: /^Secret\//,
    reason:
      'prod names externally managed Secrets (secrets.*ExistingSecret), so the chart stops rendering its own. That is the external-secret strategy, and it is a values decision - the templates are unchanged and simply skip a block.',
  },
  {
    match: /^(Deployment|Service|NetworkPolicy)\/upstreams-everything-mcp/,
    reason:
      'everythingMcp.enabled is false in prod. It is a third-party reference server kept for demonstrating a non-ours upstream and a timeout; a production deployment has no reason to run it.',
  },
];

const EXPECTED_ONLY_IN_PROD = [];

/**
 * FIELD-level differences that are expected, as opposed to whole objects.
 *
 * Needed because the interesting config-only changes are blocks a template emits
 * conditionally. Enabling TLS does not alter a template - it satisfies an `{{- if }}` - but it
 * does make fields appear, so a check comparing field sets would otherwise report the single
 * most obviously-config change in the whole chart as structural drift.
 *
 * Each entry names where the field may differ and why. The two halves matter equally: a
 * pattern loose enough to cover anything would quietly re-admit the drift the check exists to
 * find, so these are scoped to an object kind and a path prefix.
 */
const EXPECTED_FIELD_DIFFERENCES = [
  {
    kind: /^Ingress\//,
    path: /^spec.tls/,
    side: "prod",
    reason:
      "TLS is off locally (plain HTTP on a hosts-file domain, no certificate authority can issue for .local) and on in prod via ingress.tls.enabled. The template is unchanged; the block is conditional.",
  },
  {
    kind: /^Ingress\//,
    path: /^metadata\.annotations\.cert-manager\.io/,
    side: "prod",
    reason:
      "cert-manager issues the certificate in prod and is not installed locally, so the annotation that asks it to is a prod-only value in ingress.annotations.",
  },
  {
    kind: /^Ingress\//,
    path: /^metadata\.annotations\.traefik\.ingress\.kubernetes\.io/,
    side: "prod",
    reason:
      "the HTTPS redirect middleware only makes sense once TLS exists; it is an entry in ingress.annotations rather than anything in a template.",
  },
];

function fieldAllowed(objectKey, path, side) {
  return EXPECTED_FIELD_DIFFERENCES.some(
    (entry) => entry.kind.test(objectKey) && entry.path.test(path) && entry.side === side,
  );
}

let failures = 0;
let checks = 0;

function fail(message, detail) {
  failures += 1;
  console.log(`  FAIL  ${message}`);
  if (detail) console.log(`        ${detail}`);
}

function pass(message, detail) {
  checks += 1;
  console.log(`  PASS  ${message}`);
  if (detail) console.log(`        ${detail}`);
}

/** Renders a chart with one overlay and returns the objects, parsed by kubectl. */
function render(chart, overlay) {
  const valuesPath = `${chart.dir}/${overlay}`;
  if (!existsSync(valuesPath)) throw new Error(`missing ${valuesPath}`);

  const yaml = execFileSync(
    'helm',
    ['template', chart.name, chart.dir, '--namespace', chart.namespace, '--values', valuesPath],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const json = execFileSync('kubectl', ['create', '--dry-run=client', '-o', 'json', '-f', '-'], {
    input: yaml,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return splitConcatenatedJson(json);
}

/**
 * kubectl prints one JSON object per input document, concatenated. Split on a closing brace
 * at column 0 followed by an opening one - which is exactly how it formats them, and is
 * cheaper and clearer than a streaming parser for this input.
 */
function splitConcatenatedJson(text) {
  const parts = text.replace(/^﻿/, '').split(/\}\s*\n\{/);
  return parts.map((part, index) => {
    let body = part;
    if (index > 0) body = `{${body}`;
    if (index < parts.length - 1) body = `${body}}`;
    return JSON.parse(body);
  });
}

/** `kind/name`, which is what identifies an object within one release. */
function key(object) {
  return `${object.kind}/${object.metadata?.name ?? '(unnamed)'}`;
}

/**
 * Every path through an object, with array indices collapsed.
 *
 * `metadata.managedFields` and `status` are dropped: the first is server-side bookkeeping that
 * kubectl may add, and the second is never present in a render but would be meaningless if it
 * were.
 */
function paths(value, prefix = '', out = new Set()) {
  if (value === null || typeof value !== 'object') {
    out.add(prefix);
    return out;
  }
  if (Array.isArray(value)) {
    // The LENGTH is compared separately; here every element contributes to the same `[]` path
    // so that a list of different length does not produce one difference per element.
    for (const item of value) paths(item, `${prefix}[]`, out);
    if (value.length === 0) out.add(`${prefix}[]`);
    return out;
  }
  for (const [field, child] of Object.entries(value)) {
    if (prefix === 'metadata' && field === 'managedFields') continue;
    if (prefix === '' && field === 'status') continue;
    paths(child, prefix === '' ? field : `${prefix}.${field}`, out);
  }
  return out;
}

/** Counts of every array in the object, by path - so a changed container count is caught. */
function arrayLengths(value, prefix = '', out = new Map()) {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    out.set(prefix, value.length);
    for (const item of value) arrayLengths(item, `${prefix}[]`, out);
    return out;
  }
  for (const [field, child] of Object.entries(value)) {
    if (prefix === 'metadata' && field === 'managedFields') continue;
    arrayLengths(child, prefix === '' ? field : `${prefix}.${field}`, out);
  }
  return out;
}

function explain(name, list) {
  for (const entry of list) {
    if (entry.match.test(name)) return entry.reason;
  }
  return undefined;
}

// ----------------------------------------------------------------------------------------
console.log('Production parity: does values-prod.yaml change config only? (9.5)\n');

for (const chart of CHARTS) {
  console.log(`=== ${chart.dir} ===`);

  let local;
  let prod;
  try {
    local = render(chart, 'values-local.yaml');
    prod = render(chart, 'values-prod.yaml');
  } catch (error) {
    fail(`${chart.dir} could not be rendered`, String(error.message).slice(0, 300));
    continue;
  }

  const localByKey = new Map(local.map((o) => [key(o), o]));
  const prodByKey = new Map(prod.map((o) => [key(o), o]));

  console.log(`  local renders ${local.length} objects, prod renders ${prod.length}`);

  // ---- objects present in only one overlay -------------------------------------------
  for (const name of localByKey.keys()) {
    if (prodByKey.has(name)) continue;
    const reason = explain(name, EXPECTED_ONLY_IN_LOCAL);
    if (reason === undefined) {
      fail(`${name} exists only in local, and is not a declared difference`);
    } else {
      pass(`${name} is local-only, by design`, reason.slice(0, 160));
    }
  }
  for (const name of prodByKey.keys()) {
    if (localByKey.has(name)) continue;
    const reason = explain(name, EXPECTED_ONLY_IN_PROD);
    if (reason === undefined) {
      fail(`${name} exists only in prod, and is not a declared difference`);
    } else {
      pass(`${name} is prod-only, by design`, reason.slice(0, 160));
    }
  }

  // ---- shape of the objects present in both -------------------------------------------
  let shapeDiffs = 0;
  let compared = 0;

  for (const [name, localObject] of localByKey) {
    const prodObject = prodByKey.get(name);
    if (prodObject === undefined) continue;
    compared += 1;

    const localPaths = paths(localObject);
    const prodPaths = paths(prodObject);

    const onlyLocal = [...localPaths].filter((p) => !prodPaths.has(p));
    const onlyProd = [...prodPaths].filter((p) => !localPaths.has(p));

    // Declared field differences are removed before judging, and reported so they are
    // visible rather than silently tolerated.
    const allowedLocal = onlyLocal.filter((p) => fieldAllowed(name, p, "local"));
    const allowedProd = onlyProd.filter((p) => fieldAllowed(name, p, "prod"));
    const unexplainedLocal = onlyLocal.filter((p) => !fieldAllowed(name, p, "local"));
    const unexplainedProd = onlyProd.filter((p) => !fieldAllowed(name, p, "prod"));

    if (allowedLocal.length > 0 || allowedProd.length > 0) {
      pass(
        `${name} has ${allowedLocal.length + allowedProd.length} declared field difference(s)`,
        [...allowedLocal, ...allowedProd].slice(0, 4).join(", "),
      );
    }

    if (unexplainedLocal.length > 0 || unexplainedProd.length > 0) {
      shapeDiffs += 1;
      fail(
        `${name} differs in SHAPE, not just values`,
        [
          onlyLocal.length > 0 ? `local-only fields: ${onlyLocal.slice(0, 6).join(', ')}` : '',
          onlyProd.length > 0 ? `prod-only fields: ${onlyProd.slice(0, 6).join(', ')}` : '',
        ]
          .filter(Boolean)
          .join(' | '),
      );
      continue;
    }

    // Same paths, so compare how many items each list holds. A different container count
    // would otherwise slip through, since every container contributes the same `[]` path.
    const localLengths = arrayLengths(localObject);
    const prodLengths = arrayLengths(prodObject);
    const lengthDiffs = [];
    for (const [path, n] of localLengths) {
      const other = prodLengths.get(path);
      if (other !== n) lengthDiffs.push(`${path}: ${n} vs ${other}`);
    }

    /**
     * A differing list length is reported but not always a failure, and the distinction
     * matters: a different number of CONTAINERS or VOLUMES is structural, while a different
     * number of env vars or CIDRs is a value decision expressed as a list.
     */
    const structural = lengthDiffs.filter((d) =>
      /\.(containers|initContainers|volumes|volumeMounts|ports|rules|paths)\b/.test(d),
    );
    if (structural.length > 0) {
      shapeDiffs += 1;
      fail(`${name} has a different number of structural items`, structural.slice(0, 4).join(' | '));
    }
  }

  if (shapeDiffs === 0) {
    pass(
      `all ${compared} shared objects have identical shape`,
      'same fields, same containers, same volumes and mounts - only leaf values differ',
    );
  }
  console.log('');
}

console.log(`${checks} checks, ${failures} failures`);
if (failures > 0) {
  console.log('PROD PARITY FAILED: a structural difference is not config-only');
  process.exit(1);
}
console.log('PROD PARITY PASSED: values-prod.yaml changes configuration only');

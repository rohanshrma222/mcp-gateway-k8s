/**
 * Prometheus metrics. Stand-out area #8.
 *
 * Three series, chosen because each answers a question the dashboard cannot:
 *
 *   mcp_tool_calls_total{server,tool,outcome}   what is being used, and what is failing
 *   mcp_tool_call_duration_seconds{server,tool} which upstream is slow, and how slow
 *   mcp_upstream_up{server}                     which upstreams are reachable right now
 *   mcp_audit_write_failures_total               tool calls that happened and were not recorded
 *   mcp_upstream_tools{server}                   how many tools each upstream advertises
 *   mcp_probe_cycle_completed_timestamp_seconds  when the health prober last finished a pass
 *
 * The tool-call series are registered here but only written from 5.4, when there is a
 * call path to instrument. They are declared now so the registry has one owner and the
 * label sets are decided once rather than invented at three call sites.
 *
 * Label discipline, because this is where metrics go wrong: every label here is
 * low-cardinality by construction. `server` and `tool` come from the registry, so they
 * are bounded by what an admin has configured. Note what is deliberately NOT a label -
 * user id, API key id, request id. Each of those is unbounded, and one unbounded label
 * turns a time series into a time series per user and exhausts Prometheus. Per-user
 * attribution belongs in the audit log, which is built for exactly that and is queried
 * rather than scraped.
 */
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type Metric,
} from 'prom-client';

export interface Metrics {
  registry: Registry;
  toolCalls: Counter<'server' | 'tool' | 'outcome'>;
  toolCallDuration: Histogram<'server' | 'tool'>;
  upstreamUp: Gauge<'server'>;
  auditWriteFailures: Counter<string>;
  upstreamTools: Gauge<'server'>;
  probeCycleCompleted: Gauge<string>;
  chatKeysSwept: Counter<string>;
}

export function createMetrics(enabled: boolean): Metrics {
  // A private registry rather than prom-client's global default.
  //
  // The global registry is process-wide shared state: two modules registering the same
  // metric name throw, and a test importing this file twice throws. An explicit registry
  // makes ownership obvious and the whole thing constructible more than once.
  const registry = new Registry();

  if (enabled) {
    // Event-loop lag, heap, GC, file descriptors, process CPU. Worth having because the
    // first question about a slow gateway is whether it is slow or the upstream is, and
    // event-loop lag separates those two immediately.
    collectDefaultMetrics({ register: registry });
  }

  const toolCalls = new Counter({
    name: 'mcp_tool_calls_total',
    help: 'Tool calls routed through the gateway, by upstream server, tool and outcome',
    // outcome mirrors audit_log.outcome exactly: ok | error | denied | timeout. The same
    // vocabulary in the metric and in the database means a spike on a graph and a filter
    // in the dashboard are describing the same thing, rather than two taxonomies someone
    // has to mentally translate between.
    labelNames: ['server', 'tool', 'outcome'] as const,
    registers: [registry],
  });

  const toolCallDuration = new Histogram({
    name: 'mcp_tool_call_duration_seconds',
    help: 'Wall-clock duration of tool calls routed through the gateway',
    labelNames: ['server', 'tool'] as const,
    // Buckets chosen for this system rather than left at the library default, which is
    // tuned for sub-second web requests and would put every MCP call in the top bucket.
    // A WooCommerce round trip is tens to hundreds of milliseconds; the per-server
    // timeout is 20s. The top bucket sits just under that so a call that timed out is
    // visibly distinct from one that was merely slow.
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20],
    registers: [registry],
  });

  const upstreamUp = new Gauge({
    name: 'mcp_upstream_up',
    help: '1 if the last health probe of this upstream succeeded, 0 otherwise',
    labelNames: ['server'] as const,
    registers: [registry],
  });

  /**
   * Tool calls that happened and could not be written to the audit log.
   *
   * Exists because the audit write is allowed to fail without failing the call - see
   * `recordCalls` for why that is the right choice once an upstream side effect has
   * already landed. The whole justification for that leniency is that the gap is loud, and
   * a log line alone is not loud: nobody alerts on log prose. This counter is what makes
   * "the audit log is complete" a statement with evidence rather than a hope.
   *
   * Unlabelled on purpose. There is nothing to break down by - any non-zero value is the
   * same incident class and wants the same response - and a label here would be one more
   * place for caller-controlled text to reach the metric namespace.
   */
  /**
   * Ephemeral chat keys the sweeper had to revoke because their request never did (8.4).
   *
   * **A counter that should stay at zero**, and that is what makes it worth having. The
   * normal path revokes a chat key in a `finally` within about a second - measured median
   * 0.83s - so a key reaching the sweeper means its request died first: a pod killed by a
   * rollout, an OOM, a node eviction. This is therefore not a throughput metric but an
   * incident signal, and a steadily climbing value says chat requests are being
   * interrupted rather than that the sweeper is busy.
   *
   * No label. A key id would be high-cardinality text from close to the caller living in
   * the metric namespace, which is the same objection as
   * `mcp_audit_write_failures_total`. The sweeper logs the ids at warn level, which is
   * where to look once this moves.
   */
  const chatKeysSwept = new Counter({
    name: 'mcp_chat_keys_swept_total',
    help: 'Expired ephemeral chat keys revoked by the sweeper because their request did not clean up',
    registers: [registry],
  });

  const auditWriteFailures = new Counter({
    name: 'mcp_audit_write_failures_total',
    help: 'Tool calls that completed but could not be written to the audit log',
    registers: [registry],
  });

  /**
   * How many tools each upstream currently advertises.
   *
   * Answers a question neither of the other gauges can: an upstream that is up and
   * reachable can still have silently stopped advertising half its tools - a bad deploy,
   * a feature flag, a colliding prefixed name that 5.3's unique constraint rejected. From
   * `mcp_upstream_up` alone that upstream looks perfectly healthy.
   *
   * Labelled by slug only. The alternative - a series per tool - would be a label whose
   * values are supplied by an upstream, which is the cardinality trap described above.
   */
  const upstreamTools = new Gauge({
    name: 'mcp_upstream_tools',
    help: 'Number of tools currently cached for this upstream',
    labelNames: ['server'] as const,
    registers: [registry],
  });

  /**
   * Unix seconds at which the health prober last completed a pass.
   *
   * This exists because of a property of `mcp_upstream_up` that is easy to miss: it is a
   * gauge written by the prober, so if the prober stops, the gauge keeps its last value
   * forever. Three upstreams reading 1 looks like a healthy system whether the prober ran
   * a second ago or died an hour ago. **A metric that can go stale without saying so is
   * worse than no metric**, because it is trusted.
   *
   * A timestamp rather than a counter of cycles, because the useful alert is
   * `time() - mcp_probe_cycle_completed_timestamp_seconds > 60` - absolute, needs no rate
   * window, and works from a single scrape. A counter would require two scrapes and a
   * `rate()` to say the same thing.
   *
   * Set at the END of a cycle rather than the start, so a cycle that wedges mid-pass does
   * not refresh it. Unlabelled: there is one prober per process.
   */
  const probeCycleCompleted = new Gauge({
    name: 'mcp_probe_cycle_completed_timestamp_seconds',
    help: 'Unix timestamp of the last completed upstream health probe cycle',
    registers: [registry],
  });

  return {
    registry,
    toolCalls,
    toolCallDuration,
    upstreamUp,
    auditWriteFailures,
    upstreamTools,
    chatKeysSwept,
    probeCycleCompleted,
  };
}

/**
 * Removes every series carrying this server label.
 *
 * Needed when an upstream is deleted from the registry: without it, `mcp_upstream_up`
 * keeps reporting a stale value for a server that no longer exists, and a dashboard
 * built on it shows a permanent phantom failure that nothing can clear.
 */
export function forgetUpstream(metrics: Metrics, server: string): void {
  const remove = (metric: Metric<string>): void => {
    // prom-client types `remove` as variadic strings in label-declaration order; both
    // metrics here take `server` first.
    (metric as unknown as { remove: (...labels: string[]) => void }).remove(server);
  };
  remove(metrics.upstreamUp);
  // The same removal for the tool count. Omitting it would recreate 5.2's bug in a new
  // place: a deleted upstream still reporting, this time a tool count rather than a health
  // of 1. Any per-slug series added anywhere needs a line here, which is the argument for
  // there being exactly one place that forgets an upstream.
  remove(metrics.upstreamTools);
}

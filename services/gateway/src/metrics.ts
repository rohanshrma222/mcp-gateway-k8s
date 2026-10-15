/**
 * Prometheus metrics. Stand-out area #8.
 *
 * Three series, chosen because each answers a question the dashboard cannot:
 *
 *   mcp_tool_calls_total{server,tool,outcome}   what is being used, and what is failing
 *   mcp_tool_call_duration_seconds{server,tool} which upstream is slow, and how slow
 *   mcp_upstream_up{server}                     which upstreams are reachable right now
 *   mcp_audit_write_failures_total               tool calls that happened and were not recorded
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
  const auditWriteFailures = new Counter({
    name: 'mcp_audit_write_failures_total',
    help: 'Tool calls that completed but could not be written to the audit log',
    registers: [registry],
  });

  return { registry, toolCalls, toolCallDuration, upstreamUp, auditWriteFailures };
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
}

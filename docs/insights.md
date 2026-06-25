# Insights — `[preview]`

Insights run failure-pattern analysis across your agent's sessions. The insights service inspects historical traces,
clusters bad outcomes into failure categories, and surfaces root causes with recommendations you can act on. Run it
on-demand with `run insights`, or attach a continuous config with `add online-insights`.

> **Preview:** the insights feature is in preview. Commands and output may change.

## Quick Start

```bash
# On-demand failure analysis over the last 7 days of sessions
agentcore run insights \
  -r MyAgent \
  --insights Builtin.Insight.FailureAnalysis

# Block until the job finishes
agentcore run insights -r MyAgent --insights Builtin.Insight.FailureAnalysis --wait
```

If you omit `--insights`, the CLI defaults to `Builtin.Insight.FailureAnalysis`.

## On-Demand Insights

`run insights` starts a job that analyzes the sessions it finds for your runtime in CloudWatch.

### Choosing the session window

By default, insights looks back 7 days. Narrow or widen the window with `--lookback-days`, or pin an explicit range
with `--start-time` / `--end-time`:

```bash
# Custom lookback window (1–90 days)
agentcore run insights -r MyAgent --insights Builtin.Insight.FailureAnalysis --lookback-days 14

# Explicit time range (ISO-8601)
agentcore run insights \
  -r MyAgent \
  --insights Builtin.Insight.FailureAnalysis \
  --start-time 2026-06-01T00:00:00Z \
  --end-time 2026-06-15T00:00:00Z
```

### Limiting to specific sessions

```bash
agentcore run insights -r MyAgent --session-ids <id-1> <id-2>
```

### Using an existing online eval config as the source

```bash
agentcore run insights --online-eval-config-arn <arn>
```

### Chaining into recommendations

Pass evaluators with `-e` so the resulting batch evaluation can later feed `run recommendation --from-insights`:

```bash
agentcore run insights -r MyAgent -e Builtin.Correctness
agentcore run recommendation -r MyAgent -e Builtin.Correctness --type system-prompt --from-insights <insights-id>
```

## Options Reference

| Option                       | Description                                                            |
| ---------------------------- | ---------------------------------------------------------------------- |
| `-r, --runtime <name>`       | Runtime name from project config.                                      |
| `--insights <ids...>`        | Insight type(s). Defaults to `Builtin.Insight.FailureAnalysis`.        |
| `-e, --evaluator <ids...>`   | Evaluator(s) to include (needed for chaining into recommendations).    |
| `--online-eval-config-arn`   | Use an existing OnlineEvaluationConfig as the session source.          |
| `-d, --lookback-days <days>` | Lookback window in days, 1–90 (default: 7).                            |
| `--start-time <iso8601>`     | Session filter start time.                                             |
| `--end-time <iso8601>`       | Session filter end time.                                               |
| `-s, --session-ids <ids...>` | Limit analysis to specific session IDs.                                |
| `-n, --name <name>`          | Job name (auto-generated if omitted).                                  |
| `--endpoint <name>`          | Runtime endpoint name (e.g. `PROMPT_V1`).                              |
| `--wait`                     | Block until the job reaches a terminal state.                          |
| `--region <region>`          | AWS region (auto-detected if omitted).                                 |
| `--json`                     | Output as JSON.                                                        |

## Output

Insights jobs are fire-and-forget: `run insights` returns the job `id` and an initial `status`
(`PENDING`/`IN_PROGRESS`) — the failure analysis is **not** available immediately. Pass `--wait` to block until the job
finishes, or check later with `agentcore view insights <id>`.

```bash
agentcore run insights -r MyAgent --insights Builtin.Insight.FailureAnalysis --json
```

A completed job record includes:

| Field                   | Description                                                                  |
| ----------------------- | ---------------------------------------------------------------------------- |
| `id`                    | Insights job ID.                                                             |
| `name`                  | Job name.                                                                    |
| `status`                | Job status (`PENDING`, `IN_PROGRESS`, `COMPLETED`, `FAILED`).                |
| `insights`              | Insight type(s) requested.                                                   |
| `evaluators`            | Evaluators included (when chaining into recommendations).                    |
| `failureAnalysisResult` | Structured failure categories, each with root causes and recommendations.    |
| `evaluationResults`     | Per-evaluator score summaries (when evaluators were included).               |

Each failure category carries a name, description, optional group, and one or more root causes. A root cause includes a
category, description, a recommendation, and the related session IDs.

## Viewing History

List past insights jobs or view one in detail:

```bash
# List all insights jobs (or open the TUI when run without --json)
agentcore view insights --json

# Detail for a single job
agentcore view insights <id> --json
```

You can also browse jobs interactively via the TUI:

```bash
agentcore
# Navigate to: View → Insights
```

## Continuous Insights

Attach a config that runs insights continuously alongside your online evals:

```bash
agentcore add online-insights        # add a continuous insights config bound to a runtime
agentcore pause online-insights <name>
agentcore resume online-insights <name>
```

Use `--arn <arn>` with `pause`/`resume` to target configs outside the current project.

## Archiving

Delete an insights job on the service and clear local history:

```bash
agentcore archive insights -i <insights-id>
agentcore archive insights -i <insights-id> --region us-west-2 --json
```

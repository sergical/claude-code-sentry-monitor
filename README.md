# claude-code-sentry-monitor

Sentry AI Agent Monitoring plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Traces sessions and tool calls as OpenTelemetry spans in [Sentry](https://sentry.io).

Each Claude Code session becomes a root `invoke_agent` span, each prompt becomes a child `chat` span with its token usage, and every tool call becomes an `execute_tool` span. All spans share the session id as `gen_ai.conversation.id`, so sessions show up in **Sentry AI Agents** and the **Conversations** view.

Requires Node.js 18 or newer on the machine that runs Claude Code.

## Installation

**Quick start** (load for one session):
```bash
claude --plugin-dir /path/to/claude-code-sentry-monitor
```

**Permanent install** (inside Claude Code):
```
/plugin marketplace add sergical/claude-code-sentry-monitor
/plugin install claude-code-sentry-monitor
```

Dependencies auto-install on first hook invocation.

## Setup

Inside Claude Code, run the setup wizard skill:

> "Set up Sentry monitoring"

Or create the config manually:

```bash
mkdir -p ~/.config/claude-code
cat > ~/.config/claude-code/sentry-monitor.json << 'EOF'
{
  "dsn": "https://your-dsn@o123.ingest.sentry.io/456",
  "tags": {
    "developer": "your-name"
  }
}
EOF
```

## Configuration

This is a developer-level tool — config is global (per-machine), not per-project.

Config is loaded from the first file found (in order):

1. `CLAUDE_SENTRY_CONFIG` env var (explicit path)
2. `~/.config/claude-code/sentry-monitor.json` (main config)
3. `~/.config/sentry-claude/config` (legacy KEY=VALUE format, for migration)

### Options

| Field | Default | Description |
|-------|---------|-------------|
| `dsn` | *required* | Sentry DSN from Project Settings → Client Keys |
| `tracesSampleRate` | `1` | Fraction of sessions to trace (0-1) |
| `recordInputs` | `true` | Record tool inputs as span attributes |
| `recordOutputs` | `true` | Record tool outputs as span attributes |
| `maxAttributeLength` | `12000` | Max characters per span attribute |
| `enableMetrics` | `false` | Emit Sentry metrics for token usage |
| `environment` | — | Environment tag on spans |
| `tags` | `{}` | Custom key-value tags on every span |
| `mode` | `batch` | `batch` (process at session end) or `realtime` (local HTTP server) |

### Environment variable overrides

Each setting can be overridden via env var:

| Env var | Overrides |
|---------|-----------|
| `CLAUDE_SENTRY_DSN` / `SENTRY_DSN` | `dsn` |
| `CLAUDE_SENTRY_TRACES_SAMPLE_RATE` | `tracesSampleRate` |
| `CLAUDE_SENTRY_RECORD_INPUTS` | `recordInputs` |
| `CLAUDE_SENTRY_RECORD_OUTPUTS` | `recordOutputs` |
| `CLAUDE_SENTRY_MAX_ATTRIBUTE_LENGTH` | `maxAttributeLength` |
| `CLAUDE_SENTRY_ENABLE_METRICS` | `enableMetrics` |
| `CLAUDE_SENTRY_TAGS` | `tags` (format: `key1:val1,key2:val2`) |
| `CLAUDE_SENTRY_MODE` | `mode` |
| `SENTRY_ENVIRONMENT` | `environment` |
| `SENTRY_RELEASE` | `release` |

## How it works

The plugin registers five hooks:

- **SessionStart** — begins the root `invoke_agent` span
- **UserPromptSubmit** — starts a `chat` span for the turn, with the prompt as `gen_ai.input.messages`
- **PreToolUse** — starts a child `execute_tool` span
- **PostToolUse** — ends the tool span, records output
- **SessionEnd** — ends the root span, flushes to Sentry

Token usage, the response model, and the final assistant text for each turn come from the session transcript. Usage is counted once per API response and is set only on `chat` spans, so per-trace totals in Sentry never double count.

In **batch mode** (default), events are written to a JSONL file in the system temp directory and processed at session end. In **realtime mode**, events are POSTed to a local HTTP collector server.

### Recovering abandoned sessions

A session that crashes, is killed, or ends when the machine sleeps never runs its `SessionEnd` hook, so in batch mode its event log is never flushed and its trace is lost. On every `SessionStart` the plugin sweeps the temp directory in a detached background process and flushes any log older than an hour that belongs to another session, then deletes it. Logs that cannot be parsed are removed after 7 days. The sweep is capped at 20 logs per run and never touches the current session, so it adds no latency to the session that triggers it.

### Tags

Every trace is tagged with `claude_code.repo`, the name of the git repository the session ran in (detected by walking up from the session's working directory), so sessions from different projects can be told apart in Sentry.

### Security

- Sensitive keys (`api_key`, `token`, `secret`, `password`, `authorization`, `cookie`, `session`, `bearer`) are automatically redacted from tool inputs/outputs
- Credentials are also redacted by **value**, not just by key name, so a secret embedded in a shell command, a file read, or an HTTP response is caught too. Covers PEM private key blocks, JWTs, `sk-ant-*`/`sk-*`/`sk_live_*` API keys, GitHub (`ghp_*`, `github_pat_*`) and npm tokens, AWS access key ids, Google API keys, Slack tokens, credentials embedded in URLs (including Sentry DSNs), `KEY=value` assignments whose key looks sensitive, `--password`/`--token` CLI flags, and bearer tokens. The surrounding text is preserved so the command remains readable
- Attributes are truncated to `maxAttributeLength` (default 12000 chars)
- Set `recordInputs: false` and `recordOutputs: false` to suppress all tool data
- No data is sent if no DSN is configured

## Development

```bash
# Install dev dependencies
npm install

# Type-check
npm run typecheck

# Build (compiles src/ → scripts/)
npm run build
```

## License

MIT

# claude-code-sentry-monitor

Sentry AI Agent Monitoring plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Traces sessions and tool calls as OpenTelemetry spans in [Sentry](https://sentry.io).

Each Claude Code session becomes a root `invoke_agent` span with child `execute_tool` spans for every tool call. See your sessions in the **Sentry AI Agents** dashboard.

## Installation

```bash
# Clone the repo
git clone https://github.com/sergical/claude-code-sentry-monitor.git

# Install runtime dependencies
cd claude-code-sentry-monitor/scripts && npm install && cd ..

# Install as a Claude Code plugin
# (run this inside Claude Code)
/install-plugin file:///path/to/claude-code-sentry-monitor
```

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

For project-specific config, create `.claude-code/sentry-monitor.json` in your project root.

## Configuration

Config is loaded from the first file found (in order):

1. `CLAUDE_SENTRY_CONFIG` env var (explicit path)
2. `.claude-code/sentry-monitor.json` (project-local)
3. `~/.config/claude-code/sentry-monitor.json` (user-global)
4. `~/.config/sentry-claude/config` (legacy KEY=VALUE format)

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

The plugin registers four hooks:

- **SessionStart** — begins the root `invoke_agent` span
- **PreToolUse** — starts a child `execute_tool` span
- **PostToolUse** — ends the tool span, records output
- **SessionEnd** — ends the root span, flushes to Sentry

In **batch mode** (default), events are written to a JSONL file and processed at session end. In **realtime mode**, events are POSTed to a local HTTP collector server.

### Security

- Sensitive keys (`api_key`, `token`, `secret`, `password`, `authorization`, `cookie`, `session`, `bearer`) are automatically redacted from tool inputs/outputs
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

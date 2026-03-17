---
name: claude-code-sentry-monitor
description: Set up Sentry observability for Claude Code sessions. Use when someone says "set up Sentry monitoring", "add observability to Claude Code", "configure claude-code-sentry-monitor", "trace Claude Code sessions", "monitor Claude Code with Sentry", or "instrument Claude Code". Interactively collects DSN and preferences, then writes the config file.
---

# claude-code-sentry-monitor Setup Wizard

You are setting up the `claude-code-sentry-monitor` plugin, which instruments Claude Code sessions as distributed traces in Sentry.

## What you will do

1. Verify the plugin is installed
2. Check for an existing config file — offer to update it if found
3. Auto-detect project name and developer identity
4. Ask the user a small set of questions
5. Write the config file
6. Confirm and offer to verify

---

## Step 1 — Verify plugin installation

Check if the plugin hooks are registered by looking for the plugin in the user's Claude Code config:

```bash
grep -r "claude-code-sentry-monitor" ~/.claude/ 2>/dev/null || echo "NOT_FOUND"
```

If not found, tell the user to install it:
```
/install-plugin file:///path/to/claude-code-sentry-monitor
```

---

## Step 2 — Check for existing config

Look for an existing config in these locations (in order):
1. `CLAUDE_SENTRY_CONFIG` env var (if set)
2. `.claude-code/sentry-monitor.json` (project-local)
3. `~/.config/claude-code/sentry-monitor.json` (user-global)
4. `~/.config/sentry-claude/config` (legacy format)

Use the `read` tool to check each. If one exists, show the current config and ask: **"A config already exists — do you want to update it or leave it as-is?"**

---

## Step 3 — Auto-detect context

Before asking questions, silently gather:

**Project name:**
```bash
basename "$PWD"
```

**Developer identity** — try each in order, use the first that returns a value:
```bash
gh api user --jq .login 2>/dev/null        # GitHub username
git config user.email 2>/dev/null           # fallback: git email
git config user.name 2>/dev/null            # fallback: git name
whoami                                      # last resort
```

Hold onto both — you'll use them to pre-fill answers and write the config.

---

## Step 4 — Ask questions

Ask these questions, showing auto-detected values as defaults:

1. **Sentry DSN** *(required)* — "Paste your DSN from Sentry → Project Settings → Client Keys. Looks like: `https://abc123@o456.ingest.sentry.io/789`"

2. **Config scope** — "Should this be project-local (`.claude-code/sentry-monitor.json`) or global (`~/.config/claude-code/sentry-monitor.json`)? Project-local applies only here; global applies to all Claude Code sessions on this machine."

3. **Developer tag** — "We detected your identity as `<detected-identity>`. Want to tag your traces with this? It lets you filter Sentry data by developer. (yes/no, default: yes)"

4. **Environment** *(optional)* — "What environment name should appear on traces? e.g. `development`, `production`. Leave blank to omit."

5. **Record tool inputs/outputs** — "Record tool inputs and outputs as span attributes? Useful for debugging but can be verbose. (yes/no, default: yes)"

6. **Traces sample rate** *(optional)* — "What fraction of sessions to trace? `1` = 100%, `0.5` = 50%. Leave blank for the default (1)."

---

## Step 5 — Write the config file

Build the config from the answers. Only include fields that differ from defaults or were explicitly set. Defaults are: `tracesSampleRate: 1`, `recordInputs: true`, `recordOutputs: true`.

If the user confirmed the developer tag, add it under `tags`:
```json
{
  "tags": {
    "developer": "<detected-identity>"
  }
}
```

Example minimal config:
```json
{
  "dsn": "https://abc123@o456.ingest.sentry.io/789",
  "tags": {
    "developer": "sergical"
  }
}
```

Example fuller config:
```json
{
  "dsn": "https://abc123@o456.ingest.sentry.io/789",
  "environment": "development",
  "recordOutputs": false,
  "tracesSampleRate": 0.5,
  "tags": {
    "developer": "sergical"
  }
}
```

Write the file using the `write` tool to the path the user chose. If writing to a project-local path, create the `.claude-code/` directory if it doesn't exist. If writing to the global path, create `~/.config/claude-code/` if needed.

---

## Step 6 — Confirm and verify

Show the user the config that was written and where it was saved.

Then tell them:
> "The plugin will activate automatically on your next Claude Code session. Tool calls will appear as spans in your Sentry AI Agents dashboard."

---

## Config reference

| Field | Default | Description |
|-------|---------|-------------|
| `dsn` | required | Sentry DSN |
| `environment` | — | Environment tag |
| `recordInputs` | `true` | Capture tool input args as span attributes |
| `recordOutputs` | `true` | Capture tool output as span attributes |
| `tracesSampleRate` | `1` | Fraction of sessions to trace (0–1) |
| `maxAttributeLength` | `12000` | Max chars per span attribute |
| `enableMetrics` | `false` | Emit Sentry token usage metrics |
| `tags` | `{}` | Custom tags on every span — great for `developer`, `team` |
| `mode` | `batch` | `batch` (default) or `realtime` |

## Troubleshooting

**No traces appearing** — Check the DSN, ensure `tracesSampleRate` is `1`, verify the plugin is installed with `/plugins`. Traces flush at session end in batch mode.

**Plugin not loading** — Run `/install-plugin file:///path/to/claude-code-sentry-monitor` again. Check `~/.claude/plugins/` for the registration.

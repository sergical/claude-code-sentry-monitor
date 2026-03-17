import * as Sentry from "@sentry/node";
import { readFileSync, unlinkSync, existsSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { loadPluginConfig } from "./config.js";
import { serializeAttribute } from "./serialize.js";
// ── Helpers ──────────────────────────────────────────────────
function safeJsonParse(str) {
    try {
        return JSON.parse(str);
    }
    catch {
        return null;
    }
}
function addTimestamp(event) {
    return { ...event, _ts: Date.now() / 1000 };
}
function extractTokensFromTranscript(transcriptPath) {
    if (!existsSync(transcriptPath))
        return null;
    let inputTokens = 0;
    let outputTokens = 0;
    let model = null;
    let prompt = null;
    let lastResponse = null;
    const content = readFileSync(transcriptPath, "utf-8");
    for (const line of content.split("\n")) {
        if (!line)
            continue;
        const obj = safeJsonParse(line);
        if (!obj)
            continue;
        // Capture first user message as prompt
        if (obj.type === "user" && !prompt) {
            const msg = obj.message?.content ?? obj.message;
            prompt = typeof msg === "string" ? msg : JSON.stringify(msg);
        }
        // Capture last assistant text as response
        if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
            const texts = obj.message.content
                .filter((c) => c.type === "text" && c.text)
                .map((c) => c.text);
            if (texts.length)
                lastResponse = texts.join("\n");
        }
        if (obj.type !== "assistant" || !obj.message?.usage)
            continue;
        const usage = obj.message.usage;
        inputTokens +=
            (usage.input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0) +
                (usage.cache_read_input_tokens || 0);
        outputTokens += usage.output_tokens || 0;
        if (obj.message.model) {
            model = obj.message.model;
        }
    }
    return { inputTokens, outputTokens, model, prompt, lastResponse };
}
function pairToolEvents(events) {
    const preByUseId = new Map();
    const preByToolName = new Map();
    const completed = [];
    for (const event of events) {
        if (event.hook_event_name === "PreToolUse") {
            if (event.tool_use_id) {
                preByUseId.set(event.tool_use_id, event);
            }
            else {
                const stack = preByToolName.get(event.tool_name) || [];
                stack.push(event);
                preByToolName.set(event.tool_name, stack);
            }
        }
        else if (event.hook_event_name === "PostToolUse") {
            let pre;
            if (event.tool_use_id) {
                pre = preByUseId.get(event.tool_use_id);
                if (pre)
                    preByUseId.delete(event.tool_use_id);
            }
            else {
                const stack = preByToolName.get(event.tool_name);
                if (stack?.length)
                    pre = stack.pop();
            }
            const startTime = pre ? pre._ts : event._ts - 1;
            completed.push({
                tool_name: event.tool_name,
                startTime,
                endTime: event._ts,
                input: pre?.tool_input ?? event.tool_input,
                output: event.tool_response,
                tool_error: event.tool_error === true,
            });
        }
    }
    return completed;
}
// ── Batch mode ───────────────────────────────────────────────
async function processBatch(filePath, config) {
    if (!existsSync(filePath)) {
        return;
    }
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    const events = lines.map((line) => safeJsonParse(line)).filter(Boolean);
    if (events.length === 0) {
        try {
            unlinkSync(filePath);
        }
        catch { }
        return;
    }
    const sessionStart = events.find((e) => e.hook_event_name === "SessionStart");
    const model = sessionStart?.model || events[0]?.model || "claude";
    const transcriptPath = sessionStart?.transcript_path || events[0]?.transcript_path;
    const tokenData = transcriptPath ? extractTokensFromTranscript(transcriptPath) : null;
    const toolCalls = pairToolEvents(events);
    const firstTs = events[0]._ts || Date.now() / 1000;
    const lastTs = events[events.length - 1]._ts || Date.now() / 1000;
    const rootAttrs = {
        "gen_ai.agent.name": "claude-code",
        "gen_ai.request.model": model,
        "gen_ai.system": "anthropic",
    };
    // Add custom tags
    for (const [key, value] of Object.entries(config.tags)) {
        rootAttrs[key] = value;
    }
    const rootSpan = Sentry.startInactiveSpan({
        name: "invoke_agent claude-code",
        op: "gen_ai.invoke_agent",
        forceTransaction: true,
        startTime: firstTs,
        attributes: rootAttrs,
    });
    // Set token data from session transcript
    if (tokenData) {
        if (tokenData.inputTokens) {
            rootSpan.setAttribute("gen_ai.usage.input_tokens", tokenData.inputTokens);
        }
        if (tokenData.outputTokens) {
            rootSpan.setAttribute("gen_ai.usage.output_tokens", tokenData.outputTokens);
        }
        if (tokenData.model) {
            rootSpan.setAttribute("gen_ai.response.model", tokenData.model);
        }
        if (config.recordInputs && tokenData.prompt) {
            rootSpan.setAttribute("gen_ai.request.messages", serializeAttribute(tokenData.prompt, config.maxAttributeLength));
        }
        if (config.recordOutputs && tokenData.lastResponse) {
            rootSpan.setAttribute("gen_ai.response.text", serializeAttribute(tokenData.lastResponse, config.maxAttributeLength));
        }
    }
    Sentry.withActiveSpan(rootSpan, () => {
        for (const tool of toolCalls) {
            const attrs = {
                "gen_ai.tool.name": tool.tool_name,
            };
            if (config.recordInputs && tool.input) {
                attrs["gen_ai.tool.input"] = serializeAttribute(tool.input, config.maxAttributeLength);
            }
            if (config.recordOutputs && tool.output) {
                attrs["gen_ai.tool.output"] = serializeAttribute(tool.output, config.maxAttributeLength);
            }
            if (tool.tool_error) {
                attrs["gen_ai.tool.error"] = true;
            }
            const childSpan = Sentry.startInactiveSpan({
                name: `execute_tool ${tool.tool_name}`,
                op: "gen_ai.execute_tool",
                startTime: tool.startTime,
                attributes: attrs,
            });
            if (tool.tool_error) {
                childSpan.setStatus({ code: 2, message: "tool_error" });
            }
            childSpan.end(tool.endTime);
        }
    });
    rootSpan.setAttribute("gen_ai.tool.call_count", toolCalls.length);
    rootSpan.end(lastTs);
    await Sentry.flush(10_000);
    try {
        unlinkSync(filePath);
    }
    catch { }
}
// ── Real-time server mode ────────────────────────────────────
function startServer(config) {
    const PORT = parseInt(process.env.SENTRY_COLLECTOR_PORT || "9876", 10);
    const sessions = new Map();
    function handleEvent(event) {
        const { session_id, hook_event_name, tool_name } = event;
        switch (hook_event_name) {
            case "SessionStart": {
                const rootAttrs = {
                    "gen_ai.agent.name": "claude-code",
                    "gen_ai.request.model": event.model || "claude",
                    "gen_ai.system": "anthropic",
                };
                for (const [key, value] of Object.entries(config.tags)) {
                    rootAttrs[key] = value;
                }
                const rootSpan = Sentry.startInactiveSpan({
                    name: "invoke_agent claude-code",
                    op: "gen_ai.invoke_agent",
                    forceTransaction: true,
                    attributes: rootAttrs,
                });
                sessions.set(session_id, {
                    rootSpan,
                    pendingTools: new Map(),
                    toolCount: 0,
                });
                break;
            }
            case "PreToolUse": {
                const session = sessions.get(session_id);
                if (!session)
                    break;
                const attrs = {
                    "gen_ai.tool.name": tool_name ?? "unknown",
                };
                if (config.recordInputs && event.tool_input) {
                    attrs["gen_ai.tool.input"] = serializeAttribute(event.tool_input, config.maxAttributeLength);
                }
                const toolSpan = Sentry.withActiveSpan(session.rootSpan, () => Sentry.startInactiveSpan({
                    name: `execute_tool ${tool_name}`,
                    op: "gen_ai.execute_tool",
                    attributes: attrs,
                }));
                if (event.tool_use_id) {
                    session.pendingTools.set(event.tool_use_id, toolSpan);
                }
                session.toolCount++;
                break;
            }
            case "PostToolUse": {
                const session = sessions.get(session_id);
                if (!session)
                    break;
                const toolSpan = event.tool_use_id
                    ? session.pendingTools.get(event.tool_use_id)
                    : undefined;
                if (toolSpan) {
                    if (config.recordOutputs && event.tool_response) {
                        toolSpan.setAttribute("gen_ai.tool.output", serializeAttribute(event.tool_response, config.maxAttributeLength));
                    }
                    if (event.tool_error === true) {
                        toolSpan.setAttribute("gen_ai.tool.error", true);
                        toolSpan.setStatus({ code: 2, message: "tool_error" });
                    }
                    toolSpan.end();
                    session.pendingTools.delete(event.tool_use_id);
                }
                break;
            }
            case "SessionEnd": {
                const session = sessions.get(session_id);
                if (!session)
                    break;
                for (const span of session.pendingTools.values()) {
                    span.end();
                }
                session.rootSpan.setAttribute("gen_ai.tool.call_count", session.toolCount);
                session.rootSpan.end();
                sessions.delete(session_id);
                Sentry.flush(5_000);
                break;
            }
        }
    }
    const server = createServer((req, res) => {
        if (req.url === "/health") {
            res.writeHead(200);
            res.end("ok");
            return;
        }
        if (req.url !== "/hook" || req.method !== "POST") {
            res.writeHead(404);
            res.end("not found");
            return;
        }
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            try {
                handleEvent(JSON.parse(body));
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end("{}");
            }
            catch (err) {
                res.writeHead(400);
                res.end(err.message);
            }
        });
    });
    server.listen(PORT, "127.0.0.1", () => {
        // silent
    });
    process.on("SIGTERM", async () => {
        server.close();
        for (const [, session] of sessions) {
            session.rootSpan.end();
        }
        await Sentry.flush(5_000);
        process.exit(0);
    });
}
// ── Main entry point (reads stdin) ───────────────────────────
async function main() {
    // Read hook event from stdin
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    const inputStr = Buffer.concat(chunks).toString("utf-8").trim();
    if (!inputStr) {
        process.exit(0);
    }
    const event = safeJsonParse(inputStr);
    if (!event) {
        process.exit(0);
    }
    // Load config
    const cwd = event.cwd || process.cwd();
    const loaded = await loadPluginConfig(cwd);
    if (!loaded) {
        // No DSN configured, exit silently
        process.exit(0);
    }
    const { config } = loaded;
    // Initialize Sentry
    Sentry.init({
        dsn: config.dsn,
        tracesSampleRate: config.tracesSampleRate,
        environment: config.environment,
        release: config.release,
        debug: config.debug,
    });
    const timestamped = addTimestamp(event);
    const hookEvent = event.hook_event_name;
    const sessionId = event.session_id;
    if (!sessionId) {
        process.exit(0);
    }
    if (config.mode === "realtime") {
        // In realtime mode, forward to collector server
        const PORT = parseInt(process.env.SENTRY_COLLECTOR_PORT || "9876", 10);
        const BASE = `http://127.0.0.1:${PORT}`;
        if (hookEvent === "SessionStart") {
            // Ensure collector server is running
            try {
                const healthRes = await fetch(`${BASE}/health`);
                if (!healthRes.ok)
                    throw new Error("not ok");
            }
            catch {
                // Start server in background
                const { spawn } = await import("node:child_process");
                const child = spawn(process.execPath, [import.meta.filename, "--serve", JSON.stringify(config)], {
                    detached: true,
                    stdio: "ignore",
                });
                child.unref();
                // Wait for server to be ready
                for (let i = 0; i < 6; i++) {
                    await new Promise((r) => setTimeout(r, 500));
                    try {
                        const res = await fetch(`${BASE}/health`);
                        if (res.ok)
                            break;
                    }
                    catch { }
                }
            }
        }
        // POST event to collector
        try {
            await fetch(`${BASE}/hook`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(timestamped),
            });
        }
        catch { }
    }
    else {
        // Batch mode: append to session-specific JSONL file
        const logfile = `/tmp/claude-sentry-${sessionId}.jsonl`;
        appendFileSync(logfile, JSON.stringify(timestamped) + "\n");
        // On SessionEnd, process the collected events
        if (hookEvent === "SessionEnd") {
            await processBatch(logfile, config);
        }
    }
}
// Handle --serve flag (spawned by realtime mode)
const [, , command, configArg] = process.argv;
if (command === "--serve" && configArg) {
    const config = JSON.parse(configArg);
    Sentry.init({
        dsn: config.dsn,
        tracesSampleRate: config.tracesSampleRate,
        environment: config.environment,
        release: config.release,
        debug: config.debug,
    });
    startServer(config);
}
else {
    main().catch(() => process.exit(0));
}

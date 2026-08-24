import * as Sentry from "@sentry/node";
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPluginConfig, type ResolvedPluginConfig } from "./config.js";
import { serializeAttribute } from "./serialize.js";

const AGENT_NAME = "claude-code";
const PROVIDER_NAME = "anthropic";
const DEFAULT_MODEL = "claude";

type Attributes = Record<string, string | number | boolean>;
type Span = ReturnType<typeof Sentry.startInactiveSpan>;

// ── Helpers ──────────────────────────────────────────────────

function safeJsonParse(str: string): Record<string, unknown> | null {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function addTimestamp(event: Record<string, unknown>): Record<string, unknown> {
  return { ...event, _ts: Date.now() };
}

// Claude Code sends "sessionEnd" (camelCase) but other events are PascalCase.
function normalizeHookEventName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function batchLogPath(sessionId: string): string {
  return join(tmpdir(), `claude-sentry-${sessionId}.jsonl`);
}

function initSentry(config: ResolvedPluginConfig): void {
  Sentry.init({
    dsn: config.dsn,
    tracesSampleRate: config.tracesSampleRate,
    environment: config.environment,
    release: config.release,
    debug: config.debug,
    // The collector's own HTTP traffic (realtime server, transport) must not
    // show up as transactions next to the agent traces.
    integrations: (defaults) => defaults.filter((i) => !["Http", "NodeFetch"].includes(i.name)),
  });
}

// ── Token usage ──────────────────────────────────────────────

interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  reasoning: number;
  llmCalls: number;
}

const EMPTY_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  reasoning: 0,
  llmCalls: 0,
};

function usageFromMessage(usage: any): TokenUsage {
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  return {
    // Sentry expects input_tokens to include cached tokens; the API reports them separately.
    input: (usage.input_tokens || 0) + cacheRead + cacheCreation,
    output: usage.output_tokens || 0,
    cacheRead,
    cacheCreation,
    reasoning: usage.output_tokens_details?.thinking_tokens || 0,
    llmCalls: 1,
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    reasoning: a.reasoning + b.reasoning,
    llmCalls: a.llmCalls + b.llmCalls,
  };
}

function usageAttributes(usage: TokenUsage): Attributes {
  if (usage.llmCalls === 0) {
    return {};
  }
  const attrs: Attributes = {
    "gen_ai.usage.input_tokens": usage.input,
    "gen_ai.usage.output_tokens": usage.output,
    "gen_ai.usage.total_tokens": usage.input + usage.output,
  };
  if (usage.cacheRead) attrs["gen_ai.usage.cache_read.input_tokens"] = usage.cacheRead;
  if (usage.cacheCreation) attrs["gen_ai.usage.cache_creation.input_tokens"] = usage.cacheCreation;
  if (usage.reasoning) attrs["gen_ai.usage.reasoning.output_tokens"] = usage.reasoning;
  return attrs;
}

// ── Messages (Sentry gen_ai.input/output.messages format) ────

function textMessage(role: "user" | "assistant", content: string) {
  return { role, parts: [{ type: "text", content }] };
}

function messageAttributes(
  config: ResolvedPluginConfig,
  prompt: string | null,
  response: string | null,
): Attributes {
  const attrs: Attributes = {};
  if (config.recordInputs && prompt) {
    attrs["gen_ai.input.messages"] = serializeAttribute(
      [textMessage("user", prompt)],
      config.maxAttributeLength,
    );
  }
  if (config.recordOutputs && response) {
    attrs["gen_ai.output.messages"] = serializeAttribute(
      [textMessage("assistant", response)],
      config.maxAttributeLength,
    );
  }
  return attrs;
}

// ── Transcript parsing ───────────────────────────────────────

interface TranscriptTurn {
  response: string | null;
  usage: TokenUsage;
  model: string | null;
}

interface TranscriptData {
  model: string | null;
  prompt: string | null;
  turns: TranscriptTurn[];
}

function newTurn(): TranscriptTurn {
  return { response: null, usage: EMPTY_USAGE, model: null };
}

// A user line is a real prompt only when it is not a tool_result echo.
function isUserPrompt(obj: Record<string, unknown>): boolean {
  if (obj.type !== "user") return false;
  if (obj.toolUseResult !== undefined) return false;
  const content = (obj as any).message?.content;
  if (Array.isArray(content)) {
    return !content.some((c: any) => c?.type === "tool_result");
  }
  return true;
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter((c: any) => c?.type === "text" && c.text).map((c: any) => c.text);
  return texts.length ? texts.join("\n") : null;
}

function readTranscript(transcriptPath: string): TranscriptData | null {
  if (!existsSync(transcriptPath)) return null;

  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;
  let model: string | null = null;
  let prompt: string | null = null;
  // Claude Code writes one transcript line per content block of an assistant
  // message, each repeating the same usage, so usage is counted once per message id.
  const countedMessageIds = new Set<string>();

  for (const line of readFileSync(transcriptPath, "utf-8").split("\n")) {
    if (!line) continue;
    const obj = safeJsonParse(line);
    if (!obj || obj.isSidechain === true) continue;

    if (isUserPrompt(obj)) {
      if (current) turns.push(current);
      current = newTurn();
      if (!prompt) prompt = textOf((obj as any).message?.content);
      continue;
    }

    if (obj.type !== "assistant") continue;
    const message = (obj as any).message;
    if (!message) continue;
    if (!current) current = newTurn();

    const text = textOf(message.content);
    if (text) current.response = text;

    if (message.model) {
      model = message.model;
      current.model = message.model;
    }

    if (!message.usage) continue;
    const messageId = message.id as string | undefined;
    if (messageId) {
      if (countedMessageIds.has(messageId)) continue;
      countedMessageIds.add(messageId);
    }
    current.usage = addUsage(current.usage, usageFromMessage(message.usage));
  }
  if (current) turns.push(current);

  return { model, prompt, turns };
}

function countTranscriptTurns(transcriptPath: string | undefined): number {
  if (!transcriptPath) return 0;
  return readTranscript(transcriptPath)?.turns.length ?? 0;
}

// A resumed session's transcript starts with turns from earlier sessions.
// `offset` is the transcript turn count at SessionStart; it is unknown for
// older batch logs, so fall back to aligning on the trailing turns.
function sessionTurns(
  transcript: TranscriptData | null,
  offset: number | undefined,
  turnCount: number,
): (TranscriptTurn | null)[] {
  const turns = transcript?.turns ?? [];
  const start = offset ?? Math.max(0, turns.length - turnCount);
  return Array.from({ length: turnCount }, (_, t) => turns[start + t] ?? null);
}

function sumUsage(turns: TranscriptTurn[]): TokenUsage {
  return turns.reduce((acc, turn) => addUsage(acc, turn.usage), EMPTY_USAGE);
}

// ── Span builders ────────────────────────────────────────────

function startAgentSpan(config: ResolvedPluginConfig, requestModel: string, startTime?: number): Span {
  return Sentry.startInactiveSpan({
    name: `invoke_agent ${AGENT_NAME}`,
    op: "gen_ai.invoke_agent",
    forceTransaction: true,
    startTime,
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": AGENT_NAME,
      "gen_ai.provider.name": PROVIDER_NAME,
      "gen_ai.request.model": requestModel,
      ...config.tags,
    },
  });
}

function startChatSpan(
  config: ResolvedPluginConfig,
  requestModel: string,
  prompt: string | null,
  startTime?: number,
): Span {
  return Sentry.startInactiveSpan({
    name: `chat ${requestModel}`,
    op: "gen_ai.chat",
    startTime,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.agent.name": AGENT_NAME,
      "gen_ai.provider.name": PROVIDER_NAME,
      "gen_ai.request.model": requestModel,
      ...messageAttributes(config, prompt, null),
    },
  });
}

// Token usage lives on chat spans only, never on the parent agent span,
// so Sentry's per-trace totals count each LLM call once.
function finishChatSpan(
  span: Span,
  config: ResolvedPluginConfig,
  turn: TranscriptTurn | null,
  endTime?: number,
): void {
  if (turn) {
    // Hook events never carry a model, so the transcript's model is also the
    // requested model once the turn is known.
    if (turn.model) {
      span.updateName(`chat ${turn.model}`);
      span.setAttribute("gen_ai.request.model", turn.model);
      span.setAttribute("gen_ai.response.model", turn.model);
    }
    span.setAttributes(usageAttributes(turn.usage));
    span.setAttributes(messageAttributes(config, null, turn.response));
  }
  span.end(endTime);
}

function startToolSpan(
  config: ResolvedPluginConfig,
  toolName: string,
  input: unknown,
  startTime?: number,
): Span {
  const attrs: Attributes = {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.agent.name": AGENT_NAME,
    "gen_ai.tool.name": toolName,
    "gen_ai.tool.type": "function",
  };
  if (config.recordInputs && input) {
    attrs["gen_ai.tool.call.arguments"] = serializeAttribute(input, config.maxAttributeLength);
  }
  return Sentry.startInactiveSpan({
    name: `execute_tool ${toolName}`,
    op: "gen_ai.execute_tool",
    startTime,
    attributes: attrs,
  });
}

function finishToolSpan(
  span: Span,
  config: ResolvedPluginConfig,
  output: unknown,
  isError: boolean,
  endTime?: number,
): void {
  if (config.recordOutputs && output) {
    span.setAttribute("gen_ai.tool.call.result", serializeAttribute(output, config.maxAttributeLength));
  }
  if (isError) {
    span.setStatus({ code: 2, message: "tool_error" });
  }
  span.end(endTime);
}

// ── Tool event pairing ───────────────────────────────────────

interface PairedToolCall {
  tool_name: string;
  startTime: number;
  endTime: number;
  input: unknown;
  output: unknown;
  tool_error: boolean;
}

function pairToolEvents(events: Record<string, unknown>[]): PairedToolCall[] {
  const preByUseId = new Map<string, Record<string, unknown>>();
  const preByToolName = new Map<string, Record<string, unknown>[]>();
  const completed: PairedToolCall[] = [];

  for (const event of events) {
    if (event.hook_event_name === "PreToolUse") {
      if (event.tool_use_id) {
        preByUseId.set(event.tool_use_id as string, event);
      } else {
        const stack = preByToolName.get(event.tool_name as string) || [];
        stack.push(event);
        preByToolName.set(event.tool_name as string, stack);
      }
    } else if (event.hook_event_name === "PostToolUse") {
      let pre: Record<string, unknown> | undefined;
      if (event.tool_use_id) {
        pre = preByUseId.get(event.tool_use_id as string);
        if (pre) preByUseId.delete(event.tool_use_id as string);
      } else {
        const stack = preByToolName.get(event.tool_name as string);
        if (stack?.length) pre = stack.pop();
      }

      const startTime = pre ? (pre._ts as number) : (event._ts as number) - 1;

      completed.push({
        tool_name: event.tool_name as string,
        startTime,
        endTime: event._ts as number,
        input: pre?.tool_input ?? event.tool_input,
        output: event.tool_response,
        tool_error: (event as any).tool_error === true,
      });
    }
  }

  return completed;
}

function createToolSpan(tool: PairedToolCall, config: ResolvedPluginConfig): void {
  const span = startToolSpan(config, tool.tool_name, tool.input, tool.startTime);
  finishToolSpan(span, config, tool.output, tool.tool_error, tool.endTime);
}

// ── Batch mode ───────────────────────────────────────────────

async function processBatch(filePath: string, config: ResolvedPluginConfig): Promise<void> {
  if (!existsSync(filePath)) {
    return;
  }

  const lines = readFileSync(filePath, "utf-8").trim().split("\n");
  const events = lines.map((line) => safeJsonParse(line)).filter(Boolean) as Record<
    string,
    unknown
  >[];

  if (events.length === 0) {
    try {
      unlinkSync(filePath);
    } catch {}
    return;
  }

  const sessionStart = events.find((e) => e.hook_event_name === "SessionStart");
  const transcriptPath =
    (sessionStart?.transcript_path as string) || (events[0]?.transcript_path as string);
  const transcript = transcriptPath ? readTranscript(transcriptPath) : null;

  const requestModel =
    (sessionStart?.model as string) ||
    (events[0]?.model as string) ||
    transcript?.model ||
    DEFAULT_MODEL;

  const toolCalls = pairToolEvents(events);

  const firstTs = (events[0]._ts as number) || Date.now();
  const lastTs = (events[events.length - 1]._ts as number) || Date.now();

  const userPromptIndices = events
    .map((e, i) => (e.hook_event_name === "UserPromptSubmit" ? i : -1))
    .filter((i) => i >= 0);
  const turns = sessionTurns(
    transcript,
    sessionStart?._transcriptTurns as number | undefined,
    userPromptIndices.length,
  );

  const rootSpan = startAgentSpan(config, requestModel, firstTs);
  if (transcript?.model) {
    rootSpan.setAttribute("gen_ai.response.model", transcript.model);
  }

  if (userPromptIndices.length > 0) {
    Sentry.withActiveSpan(rootSpan, () => {
      for (let t = 0; t < userPromptIndices.length; t++) {
        const startIdx = userPromptIndices[t];
        const endIdx =
          t + 1 < userPromptIndices.length ? userPromptIndices[t + 1] : events.length;
        const promptEvent = events[startIdx];
        const turnEndTs =
          t + 1 < userPromptIndices.length
            ? (events[userPromptIndices[t + 1]]._ts as number)
            : lastTs;
        const turnPrompt =
          (promptEvent.prompt as string) || (promptEvent.message as string) || null;

        const turnSpan = startChatSpan(config, requestModel, turnPrompt, promptEvent._ts as number);
        Sentry.withActiveSpan(turnSpan, () => {
          for (const tool of pairToolEvents(events.slice(startIdx, endIdx))) {
            createToolSpan(tool, config);
          }
        });
        finishChatSpan(turnSpan, config, turns[t], turnEndTs);
      }
    });
  } else {
    // No prompt events (for example a non-interactive session): the agent span
    // is the only LLM span, so usage and messages go there.
    const allTurns = transcript?.turns ?? [];
    rootSpan.setAttributes(usageAttributes(sumUsage(allTurns)));
    rootSpan.setAttributes(
      messageAttributes(config, transcript?.prompt ?? null, allTurns.at(-1)?.response ?? null),
    );
    Sentry.withActiveSpan(rootSpan, () => {
      for (const tool of toolCalls) {
        createToolSpan(tool, config);
      }
    });
  }

  rootSpan.setAttribute("gen_ai.tool.call_count", toolCalls.length);
  rootSpan.end(lastTs);

  await Sentry.flush(10_000);

  try {
    unlinkSync(filePath);
  } catch {}
}

// ── Real-time server mode ────────────────────────────────────

interface LiveSession {
  rootSpan: Span;
  requestModel: string;
  currentTurnSpan: Span | null;
  pendingTools: Map<string, Span>;
  toolCount: number;
  turnIndex: number;
  transcriptPath: string | undefined;
  transcriptTurnOffset: number;
}

function startServer(config: ResolvedPluginConfig): void {
  const PORT = parseInt(process.env.SENTRY_COLLECTOR_PORT || "9876", 10);
  const sessions = new Map<string, LiveSession>();

  function readSessionTranscript(session: LiveSession): TranscriptData | null {
    return session.transcriptPath ? readTranscript(session.transcriptPath) : null;
  }

  function endCurrentTurn(session: LiveSession, transcript: TranscriptData | null): void {
    if (!session.currentTurnSpan) return;
    const turn = transcript?.turns[session.transcriptTurnOffset + session.turnIndex - 1] ?? null;
    finishChatSpan(session.currentTurnSpan, config, turn);
    session.currentTurnSpan = null;
  }

  function handleEvent(event: Record<string, unknown>): void {
    const session_id = event.session_id as string;
    const hook_event_name = normalizeHookEventName(event.hook_event_name as string);
    const tool_name = event.tool_name as string | undefined;

    switch (hook_event_name) {
      case "SessionStart": {
        const transcriptPath = event.transcript_path as string | undefined;
        const requestModel = (event.model as string) || DEFAULT_MODEL;
        sessions.set(session_id, {
          rootSpan: startAgentSpan(config, requestModel),
          requestModel,
          currentTurnSpan: null,
          pendingTools: new Map(),
          toolCount: 0,
          turnIndex: 0,
          transcriptPath,
          transcriptTurnOffset: countTranscriptTurns(transcriptPath),
        });
        break;
      }

      case "UserPromptSubmit": {
        const session = sessions.get(session_id);
        if (!session) break;

        endCurrentTurn(session, readSessionTranscript(session));
        session.turnIndex++;

        const prompt = (event.prompt as string) || (event.message as string) || null;
        session.currentTurnSpan = Sentry.withActiveSpan(session.rootSpan, () =>
          startChatSpan(config, session.requestModel, prompt),
        );
        break;
      }

      case "PreToolUse": {
        const session = sessions.get(session_id);
        if (!session) break;

        const parentSpan = session.currentTurnSpan ?? session.rootSpan;
        const toolSpan = Sentry.withActiveSpan(parentSpan, () =>
          startToolSpan(config, tool_name ?? "unknown", event.tool_input),
        );

        if (event.tool_use_id) {
          session.pendingTools.set(event.tool_use_id as string, toolSpan);
        }
        session.toolCount++;
        break;
      }

      case "PostToolUse": {
        const session = sessions.get(session_id);
        if (!session) break;

        const toolSpan = event.tool_use_id
          ? session.pendingTools.get(event.tool_use_id as string)
          : undefined;

        if (toolSpan) {
          finishToolSpan(toolSpan, config, event.tool_response, (event as any).tool_error === true);
          session.pendingTools.delete(event.tool_use_id as string);
        }
        break;
      }

      case "SessionEnd": {
        const session = sessions.get(session_id);
        if (!session) break;
        for (const span of session.pendingTools.values()) {
          span.end();
        }
        const transcript = readSessionTranscript(session);
        endCurrentTurn(session, transcript);
        const model = transcript?.model;
        if (model) {
          session.rootSpan.setAttribute("gen_ai.response.model", model);
          if (session.requestModel === DEFAULT_MODEL) {
            session.rootSpan.setAttribute("gen_ai.request.model", model);
          }
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
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => {
      try {
        const event = JSON.parse(body) as Record<string, unknown>;
        // The conversation id integration stamps gen_ai spans from the scope
        // at span start, so each event runs in a scope for its own session.
        Sentry.withScope((scope) => {
          scope.setConversationId(event.session_id as string);
          handleEvent(event);
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      } catch (err: any) {
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

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
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

  const loaded = await loadPluginConfig();
  if (!loaded) {
    // No DSN configured, exit silently
    process.exit(0);
  }

  const { config } = loaded;

  const hookEvent = normalizeHookEventName(event.hook_event_name as string);
  const sessionId = event.session_id as string;

  if (!sessionId) {
    process.exit(0);
  }

  const timestamped = addTimestamp(event);
  if (hookEvent === "SessionStart") {
    timestamped._transcriptTurns = countTranscriptTurns(event.transcript_path as string | undefined);
  }

  if (config.mode === "realtime") {
    const PORT = parseInt(process.env.SENTRY_COLLECTOR_PORT || "9876", 10);
    const BASE = `http://127.0.0.1:${PORT}`;

    if (hookEvent === "SessionStart") {
      try {
        const healthRes = await fetch(`${BASE}/health`);
        if (!healthRes.ok) throw new Error("not ok");
      } catch {
        const { spawn } = await import("node:child_process");
        const child = spawn(
          process.execPath,
          [fileURLToPath(import.meta.url), "--serve", JSON.stringify(config)],
          {
            detached: true,
            stdio: "ignore",
          },
        );
        child.unref();

        for (let i = 0; i < 6; i++) {
          await new Promise((r) => setTimeout(r, 500));
          try {
            const res = await fetch(`${BASE}/health`);
            if (res.ok) break;
          } catch {}
        }
      }
    }

    try {
      await fetch(`${BASE}/hook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(timestamped),
      });
    } catch {}
  } else {
    const logfile = batchLogPath(sessionId);
    appendFileSync(logfile, JSON.stringify(timestamped) + "\n");

    // Only the SessionEnd hook talks to Sentry; every other hook just appends a line.
    if (hookEvent === "SessionEnd") {
      initSentry(config);
      Sentry.setConversationId(sessionId);
      await processBatch(logfile, config);
    }
  }
}

const [, , command, configArg] = process.argv;
if (command === "--serve" && configArg) {
  const config = JSON.parse(configArg) as ResolvedPluginConfig;
  initSentry(config);
  startServer(config);
} else {
  main().catch(() => process.exit(0));
}

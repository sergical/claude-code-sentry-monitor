import {
  readFileSync,
  unlinkSync,
  existsSync,
  appendFileSync,
  writeFileSync,
  openSync,
  closeSync,
  readSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginConfig, type ResolvedPluginConfig } from "./config.js";
import { serializeAttribute } from "./serialize.js";

// @sentry/node is loaded lazily: importing it costs well over a second, and the
// vast majority of hook invocations (PreToolUse/PostToolUse/UserPromptSubmit in
// batch mode) only append a line to a JSONL file and never talk to Sentry.
// Only the paths that actually emit spans call initSentry().
let Sentry!: typeof import("@sentry/node");

async function initSentry(config: ResolvedPluginConfig): Promise<void> {
  Sentry = await import("@sentry/node");
  Sentry.init({
    dsn: config.dsn,
    tracesSampleRate: config.tracesSampleRate,
    environment: config.environment,
    release: config.release,
    debug: config.debug,
  });
  if (config.user) {
    Sentry.setUser(config.user);
  }
}

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

/**
 * Per-session batch log path. Uses the OS temp dir so it works on Windows too
 * (the old hardcoded "/tmp" silently dropped everything on Windows).
 */
function batchLogPath(sessionId: string): string {
  return join(tmpdir(), `claude-sentry-${sessionId}.jsonl`);
}

/**
 * Per-session token offsets. Deliberately kept OUTSIDE the batch logfile, which
 * is deleted at SessionEnd: the transcript accumulates across resumes, so a
 * session that is resumed would otherwise re-report its entire token history
 * every time it is reopened.
 */
function offsetPath(sessionId: string): string {
  return join(tmpdir(), `claude-sentry-${sessionId}.offset.json`);
}

/**
 * Where we've read up to in a session's transcript, plus the running token
 * totals accumulated so far. Lets each flush read only the bytes appended since
 * the last one instead of re-parsing the whole file. Sessions left open for
 * weeks grow transcripts of hundreds of MB, and re-reading one on every 20-min
 * flush froze the hook for seconds (measured: 4.2 s on a 238 MB transcript).
 */
interface TranscriptReadState {
  path: string;
  bytesRead: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  model: string | null;
  /** Last message id counted, to skip a response whose lines straddle a read. */
  lastMessageId: string | null;
}

function readStatePath(sessionId: string): string {
  return join(tmpdir(), `claude-sentry-${sessionId}.readstate.json`);
}

function loadReadState(sessionId: string, path: string): TranscriptReadState {
  const fresh: TranscriptReadState = {
    path,
    bytesRead: 0,
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    model: null,
    lastMessageId: null,
  };
  try {
    const parsed = safeJsonParse(readFileSync(readStatePath(sessionId), "utf-8"));
    if (!parsed || typeof parsed !== "object") return fresh;
    const s = parsed as Partial<TranscriptReadState>;
    // A different transcript, or a file that shrank (truncated/rotated), means
    // our saved offset is meaningless — start over from the top.
    if (s.path !== path || typeof s.bytesRead !== "number") return fresh;
    const size = statSync(path).size;
    if (size < s.bytesRead) return fresh;
    return { ...fresh, ...s, path };
  } catch {
    return fresh;
  }
}

function saveReadState(sessionId: string, state: TranscriptReadState): void {
  try {
    writeFileSync(readStatePath(sessionId), JSON.stringify(state));
  } catch {}
}

/**
 * Seed the read state at the current end of the transcript with zero totals, so
 * the plugin reports only tokens spent from now on. Used at SessionStart for a
 * resumed (or pre-existing) session whose transcript already holds history we
 * were never watching. Costs a stat(), not a full read — this is what removes
 * the startup freeze on a large transcript.
 */
function seedReadStateAtEnd(sessionId: string, path: string): void {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {}
  saveReadState(sessionId, {
    path,
    bytesRead: size,
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    model: null,
    lastMessageId: null,
  });
}

// ── Transcript token extraction ──────────────────────────────

interface TokenData {
  /** Fresh prompt tokens: neither read from nor written to the prompt cache. */
  inputTokens: number;
  /** Tokens written to the prompt cache (Anthropic cache_creation_input_tokens). */
  cacheCreationTokens: number;
  /** Tokens served from the prompt cache (Anthropic cache_read_input_tokens). */
  cacheReadTokens: number;
  outputTokens: number;
  model: string | null;
  prompt: string | null;
  lastResponse: string | null;
  turnResponses: string[];
}

/**
 * Incremental token-only read: parse just the bytes appended to the transcript
 * since the last read, add their (message-id-deduped) usage to the running
 * totals in the read state, and return the cumulative totals. This is the fast
 * path used whenever prompt/response content is not being recorded — i.e. the
 * default and the team's privacy setting. It never re-reads the whole file, so
 * a flush on a multi-hundred-MB transcript stays instant.
 */
function extractTokensIncremental(
  transcriptPath: string,
  sessionId: string,
): TokenData | null {
  if (!existsSync(transcriptPath)) return null;

  const state = loadReadState(sessionId, transcriptPath);
  let size = 0;
  try {
    size = statSync(transcriptPath).size;
  } catch {
    return null;
  }

  // Read only [bytesRead, size). Stop at the last newline so a half-written
  // trailing line is left for the next read instead of being parsed truncated.
  if (size > state.bytesRead) {
    let chunk = "";
    try {
      const fd = openSync(transcriptPath, "r");
      try {
        const len = size - state.bytesRead;
        const buf = Buffer.allocUnsafe(len);
        readSync(fd, buf, 0, len, state.bytesRead);
        chunk = buf.toString("utf-8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }

    const lastNl = chunk.lastIndexOf("\n");
    if (lastNl >= 0) {
      const consumed = chunk.slice(0, lastNl);
      for (const line of consumed.split("\n")) {
        if (!line) continue;
        const obj = safeJsonParse(line);
        if (!obj) continue;
        if (obj.type !== "assistant" || !(obj as any).message?.usage) continue;

        const messageId = (obj as any).message?.id;
        // Skip a repeated line of the same response, including one whose lines
        // straddle the boundary between this read and the previous one.
        if (messageId && messageId === state.lastMessageId) continue;
        if (messageId) state.lastMessageId = messageId;

        const usage = (obj as any).message.usage;
        state.input += usage.input_tokens || 0;
        state.cacheWrite += usage.cache_creation_input_tokens || 0;
        state.cacheRead += usage.cache_read_input_tokens || 0;
        state.output += usage.output_tokens || 0;
        if ((obj as any).message.model) state.model = (obj as any).message.model;
      }
      // Advance only past the newline we actually consumed.
      state.bytesRead += Buffer.byteLength(consumed + "\n", "utf-8");
    }
    saveReadState(sessionId, state);
  }

  return {
    inputTokens: state.input,
    cacheCreationTokens: state.cacheWrite,
    cacheReadTokens: state.cacheRead,
    outputTokens: state.output,
    model: state.model,
    prompt: null,
    lastResponse: null,
    turnResponses: [],
  };
}

function extractTokensFromTranscript(transcriptPath: string): TokenData | null {
  if (!existsSync(transcriptPath)) return null;

  let inputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let model: string | null = null;
  let prompt: string | null = null;
  let lastResponse: string | null = null;
  const turnResponses: string[] = [];
  let currentTurnResponse: string | null = null;
  let inTurn = false;
  // A single API response is written to the transcript as one line per content
  // block — thinking, text, tool_use — and every one of those lines repeats the
  // same `usage` object. Summing them all bills one response several times over
  // (measured: 2.3x on output, 1.9x on cache reads). The message id is what
  // identifies the response, so count each id once.
  const countedMessageIds = new Set<string>();

  const content = readFileSync(transcriptPath, "utf-8");
  for (const line of content.split("\n")) {
    if (!line) continue;
    const obj = safeJsonParse(line);
    if (!obj) continue;

    // Capture first user message as prompt; track turn boundaries
    if (obj.type === "user") {
      const msg = (obj as any).message?.content ?? (obj as any).message;
      if (!prompt) {
        prompt = typeof msg === "string" ? msg : JSON.stringify(msg);
      }
      // Close previous turn
      if (inTurn && currentTurnResponse !== null) {
        turnResponses.push(currentTurnResponse);
      }
      currentTurnResponse = null;
      inTurn = true;
    }

    // Capture assistant text responses
    if (obj.type === "assistant" && Array.isArray((obj as any).message?.content)) {
      const texts = (obj as any).message.content
        .filter((c: any) => c.type === "text" && c.text)
        .map((c: any) => c.text);
      if (texts.length) {
        const response = texts.join("\n");
        lastResponse = response;
        if (inTurn) {
          currentTurnResponse = response; // keep updating to get the last one
        }
      }
    }

    if (obj.type !== "assistant" || !(obj as any).message?.usage) continue;

    const messageId = (obj as any).message?.id;
    if (messageId) {
      if (countedMessageIds.has(messageId)) continue;
      countedMessageIds.add(messageId);
    }

    const usage = (obj as any).message.usage;
    // Keep the three input buckets separate: they have very different costs, and
    // in long sessions cache reads dwarf everything else (the same context is
    // re-read every turn). Collapsing them into one number makes Sentry price
    // cached tokens at the full input rate.
    inputTokens += usage.input_tokens || 0;
    cacheCreationTokens += usage.cache_creation_input_tokens || 0;
    cacheReadTokens += usage.cache_read_input_tokens || 0;
    outputTokens += usage.output_tokens || 0;

    if ((obj as any).message.model) {
      model = (obj as any).message.model;
    }
  }

  // Close last turn
  if (inTurn && currentTurnResponse !== null) {
    turnResponses.push(currentTurnResponse);
  }

  return {
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    model,
    prompt,
    lastResponse,
    turnResponses,
  };
}

// ── Tool event pairing ───────────────────────────────────────

interface PairedToolCall {
  tool_name: string;
  startTime: number;
  endTime: number;
  input: unknown;
  output: unknown;
  tool_error?: boolean;
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

// ── Tool span creation helper ────────────────────────────────

function createToolSpan(tool: PairedToolCall, config: ResolvedPluginConfig): void {
  const attrs: Record<string, string | number | boolean> = {
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

// ── Batch mode ───────────────────────────────────────────────

interface TokenTotals {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

interface ChapterCarry {
  chapterIndex: number;
  offset: TokenTotals;
}

const ZERO_CARRY: ChapterCarry = {
  chapterIndex: 0,
  offset: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
};

/** A lock held longer than this is assumed to belong to a process that died. */
const LOCK_STALE_MS = 2 * 60_000;

function lockPath(sessionId: string): string {
  return join(tmpdir(), `claude-sentry-${sessionId}.lock`);
}

/**
 * Take an exclusive, cross-process lock on a session's flush.
 *
 * Claude Code runs tool calls in parallel, so several hook processes fire at the
 * same instant. Flushing reads the batch log, awaits a network round-trip to
 * Sentry, and only then advances the offset — so without a lock every one of
 * those processes sees the same un-advanced offset and emits the same chapter.
 * Observed in production: five identical transactions, same timestamp, same
 * token counts, five distinct trace ids.
 *
 * `wx` fails if the file already exists, and that check-and-create is atomic on
 * both Windows and POSIX, so exactly one process wins. The losers skip this
 * flush; their events stay in the log and land in the next chapter.
 */
function acquireFlushLock(sessionId: string): boolean {
  const path = lockPath(sessionId);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(path, "wx"));
      return true;
    } catch {
      // Held by someone. If that someone died mid-flush the lock would never be
      // released and the session would stop reporting, so drop a stale one and
      // retry exactly once.
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(path);
          continue;
        }
      } catch {}
      return false;
    }
  }
  return false;
}

function releaseFlushLock(sessionId: string): void {
  try {
    unlinkSync(lockPath(sessionId));
  } catch {}
}

/**
 * Read the chapter index and token totals already reported for this session.
 * Survives SessionEnd so that resuming a session reports only new tokens.
 */
function readCarry(sessionId: string): ChapterCarry {
  try {
    const raw = readFileSync(offsetPath(sessionId), "utf-8");
    const parsed = safeJsonParse(raw);
    if (!parsed) return ZERO_CARRY;
    return {
      chapterIndex: (parsed.chapter as number) || 0,
      offset: {
        input: (parsed.input as number) || 0,
        cacheWrite: (parsed.cacheWrite as number) || 0,
        cacheRead: (parsed.cacheRead as number) || 0,
        output: (parsed.output as number) || 0,
      },
    };
  } catch {
    return ZERO_CARRY;
  }
}

function writeCarry(sessionId: string, chapterIndex: number, totals: TokenTotals): void {
  try {
    writeFileSync(
      offsetPath(sessionId),
      JSON.stringify({ chapter: chapterIndex, ...totals }),
    );
  } catch {}
}

/**
 * Build the transaction tree for a set of events and flush it to Sentry.
 * Returns the cumulative transcript token totals observed, so the caller can
 * carry them forward as the next chapter's offset (avoids double-counting
 * tokens, since the transcript accumulates across chapters).
 */
async function emitTransaction(
  events: Record<string, unknown>[],
  config: ResolvedPluginConfig,
  carry: ChapterCarry,
  ongoing: boolean,
): Promise<TokenTotals> {
  const sessionStart = events.find((e) => e.hook_event_name === "SessionStart");
  const model = (sessionStart?.model as string) || (events[0]?.model as string) || "claude";
  const sessionId = (sessionStart?.session_id as string) || (events[0]?.session_id as string);

  const transcriptPath =
    (sessionStart?.transcript_path as string) || (events[0]?.transcript_path as string);
  // Fast incremental path unless we actually need prompt/response text (which
  // requires reading the whole transcript). Recording content is off by default.
  const needContent = config.recordInputs || config.recordOutputs;
  const tokenData = transcriptPath
    ? needContent || !sessionId
      ? extractTokensFromTranscript(transcriptPath)
      : extractTokensIncremental(transcriptPath, sessionId)
    : null;

  const cumulative: TokenTotals = {
    input: tokenData?.inputTokens ?? carry.offset.input,
    cacheWrite: tokenData?.cacheCreationTokens ?? carry.offset.cacheWrite,
    cacheRead: tokenData?.cacheReadTokens ?? carry.offset.cacheRead,
    output: tokenData?.outputTokens ?? carry.offset.output,
  };

  const toolCalls = pairToolEvents(events);

  // A chapter that spent no tokens and ran no tools has nothing to say. It shows
  // up when a flush loses a race — the winner already advanced the offset, so the
  // straggler computes a zero delta — and publishing it just litters the dashboard
  // with empty transactions that look like duplicates of the real one.
  const spent =
    cumulative.input - carry.offset.input +
    (cumulative.cacheWrite - carry.offset.cacheWrite) +
    (cumulative.cacheRead - carry.offset.cacheRead) +
    (cumulative.output - carry.offset.output);
  if (spent <= 0 && toolCalls.length === 0) {
    return cumulative;
  }

  const firstTs = (events[0]._ts as number) || Date.now() / 1000;
  const lastTs = (events[events.length - 1]._ts as number) || Date.now() / 1000;

  // Find UserPromptSubmit event indices for turn-based tracing
  const userPromptIndices = events
    .map((e, i) => (e.hook_event_name === "UserPromptSubmit" ? i : -1))
    .filter((i) => i >= 0);

  const rootAttrs: Record<string, string | number | boolean> = {
    "gen_ai.agent.name": "claude-code",
    "gen_ai.request.model": model,
    "gen_ai.system": "anthropic",
  };

  // Add custom tags
  for (const [key, value] of Object.entries(config.tags)) {
    rootAttrs[key] = value;
  }

  // Chapter metadata (only meaningful when chunking is enabled). session_id lets
  // you group every chapter of one long session in Sentry.
  if (sessionId) {
    rootAttrs["claude.session_id"] = sessionId;
  }
  if (carry.chapterIndex > 0 || ongoing) {
    rootAttrs["claude.session_chapter"] = carry.chapterIndex;
    rootAttrs["claude.session_ongoing"] = ongoing;
  }

  const rootSpan = Sentry.startInactiveSpan({
    name: "invoke_agent claude-code",
    op: "gen_ai.invoke_agent",
    forceTransaction: true,
    startTime: firstTs,
    attributes: rootAttrs,
  });

  // Set token data from session transcript, reported as this chapter's delta.
  if (tokenData) {
    const freshInput = Math.max(0, cumulative.input - carry.offset.input);
    const cacheWrite = Math.max(0, cumulative.cacheWrite - carry.offset.cacheWrite);
    const cacheRead = Math.max(0, cumulative.cacheRead - carry.offset.cacheRead);
    const chapterOutput = Math.max(0, cumulative.output - carry.offset.output);

    // Sentry's cost formula is:
    //   (input_tokens - cached) * input_rate
    //   + cached * cached_rate
    //   + cache_write * cache_write_rate
    // so input_tokens must include cached reads but NOT cache writes, otherwise
    // cache writes get billed twice. (OTel semconv would fold cache_creation in
    // as well; that double-counts under Sentry's formula.)
    const totalInput = freshInput + cacheRead;

    if (totalInput) {
      rootSpan.setAttribute("gen_ai.usage.input_tokens", totalInput);
    }
    if (cacheRead) {
      rootSpan.setAttribute("gen_ai.usage.input_tokens.cached", cacheRead);
    }
    if (cacheWrite) {
      rootSpan.setAttribute("gen_ai.usage.input_tokens.cache_write", cacheWrite);
    }
    if (chapterOutput) {
      rootSpan.setAttribute("gen_ai.usage.output_tokens", chapterOutput);
    }
    if (totalInput || chapterOutput) {
      rootSpan.setAttribute("gen_ai.usage.total_tokens", totalInput + chapterOutput);
    }
    if (tokenData.model) {
      rootSpan.setAttribute("gen_ai.response.model", tokenData.model);
    }
    // Only set flat input/output on root span when there are no per-turn spans
    if (userPromptIndices.length === 0) {
      if (config.recordInputs && tokenData.prompt) {
        rootSpan.setAttribute(
          "gen_ai.request.messages",
          serializeAttribute([{ role: "user", content: tokenData.prompt }], config.maxAttributeLength),
        );
      }
      if (config.recordOutputs && tokenData.lastResponse) {
        rootSpan.setAttribute(
          "gen_ai.response.text",
          serializeAttribute([tokenData.lastResponse], config.maxAttributeLength),
        );
      }
    }
  }

  if (userPromptIndices.length > 0) {
    // Turn-based mode: create gen_ai.chat span per conversation turn
    Sentry.withActiveSpan(rootSpan, () => {
      for (let t = 0; t < userPromptIndices.length; t++) {
        const startIdx = userPromptIndices[t];
        const endIdx =
          t + 1 < userPromptIndices.length ? userPromptIndices[t + 1] : events.length;
        const turnEvents = events.slice(startIdx, endIdx);
        const promptEvent = events[startIdx];
        const turnStartTs = promptEvent._ts as number;
        const turnEndTs =
          t + 1 < userPromptIndices.length
            ? (events[userPromptIndices[t + 1]]._ts as number)
            : lastTs;

        const turnPrompt =
          (promptEvent.prompt as string) || (promptEvent.message as string) || null;
        const turnResponse = tokenData?.turnResponses[t] ?? null;

        const turnAttrs: Record<string, string | number | boolean> = {};
        if (config.recordInputs && turnPrompt) {
          turnAttrs["gen_ai.request.messages"] = serializeAttribute(
            [{ role: "user", content: turnPrompt }],
            config.maxAttributeLength,
          );
        }
        if (config.recordOutputs && turnResponse) {
          turnAttrs["gen_ai.response.text"] = serializeAttribute(
            [turnResponse],
            config.maxAttributeLength,
          );
        }

        const turnSpan = Sentry.startInactiveSpan({
          name: "gen_ai.chat",
          op: "gen_ai.request",
          startTime: turnStartTs,
          attributes: turnAttrs,
        });

        const turnToolCalls = pairToolEvents(turnEvents);
        Sentry.withActiveSpan(turnSpan, () => {
          for (const tool of turnToolCalls) {
            createToolSpan(tool, config);
          }
        });

        turnSpan.end(turnEndTs);
      }
    });
  } else {
    // Fallback: flat tool spans directly under root span
    Sentry.withActiveSpan(rootSpan, () => {
      for (const tool of toolCalls) {
        createToolSpan(tool, config);
      }
    });
  }

  rootSpan.setAttribute("gen_ai.tool.call_count", toolCalls.length);
  rootSpan.end(lastTs);

  await Sentry.flush(10_000);

  return cumulative;
}

/** Read events from a batch logfile, dropping blank/corrupt lines. */
function readBatchEvents(filePath: string): Record<string, unknown>[] {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf-8").trim().split("\n");
  return lines.map((line) => safeJsonParse(line)).filter(Boolean) as Record<
    string,
    unknown
  >[];
}

/**
 * Final flush (SessionEnd): emit remaining events, persist the token totals so a
 * later resume of this session doesn't re-report them, then remove the logfile.
 */
async function processBatch(
  filePath: string,
  config: ResolvedPluginConfig,
  sessionId: string,
): Promise<void> {
  if (readBatchEvents(filePath).length === 0) {
    try {
      unlinkSync(filePath);
    } catch {}
    return;
  }

  if (!acquireFlushLock(sessionId)) return;
  try {
    // Re-read under the lock. Whoever held it before us has already emitted and
    // deleted the log, and emitting the copy we read on the way in would publish
    // that same chapter a second time (as an empty transaction, since the offset
    // it advanced leaves us a zero delta).
    const events = readBatchEvents(filePath);
    if (events.length === 0) return;

    const carry = readCarry(sessionId);
    const cumulative = await emitTransaction(events, config, carry, false);
    writeCarry(sessionId, carry.chapterIndex + 1, cumulative);

    try {
      unlinkSync(filePath);
    } catch {}
  } finally {
    releaseFlushLock(sessionId);
  }
}

/**
 * Time-triggered flush for a still-open session: emit everything so far as a
 * "chapter" transaction, then reset the logfile to a single synthetic
 * SessionStart that carries the model, transcript path and token offset forward
 * so the next chapter is a fresh, correctly-accounted transaction.
 */
async function processChunk(
  filePath: string,
  config: ResolvedPluginConfig,
  sessionId: string,
): Promise<void> {
  // Nothing worth a chapter unless there's real activity beyond the marker.
  if (readBatchEvents(filePath).length <= 1) return;

  if (!acquireFlushLock(sessionId)) return;
  try {
    // Re-read under the lock: parallel hooks may have appended since the check
    // above, and whoever lost the race left their events here for us.
    const events = readBatchEvents(filePath);
    if (events.length <= 1) return;

    const carry = readCarry(sessionId);
    const cumulative = await emitTransaction(events, config, carry, true);
    writeCarry(sessionId, carry.chapterIndex + 1, cumulative);

    const start = events.find((e) => e.hook_event_name === "SessionStart");
    const carried: Record<string, unknown> = {
      hook_event_name: "SessionStart",
      session_id: sessionId,
      model: (start?.model as string) || (events[0]?.model as string),
      transcript_path:
        (start?.transcript_path as string) || (events[0]?.transcript_path as string),
      _ts: Date.now(),
    };

    try {
      writeFileSync(filePath, JSON.stringify(carried) + "\n");
    } catch {}
  } finally {
    releaseFlushLock(sessionId);
  }
}

/** Age in ms of the current chapter (its first/SessionStart event). */
function chapterAgeMs(filePath: string): number {
  const events = readBatchEvents(filePath);
  if (events.length === 0) return 0;
  const firstTs = (events[0]._ts as number) || Date.now();
  return Date.now() - firstTs;
}

// ── Real-time server mode ────────────────────────────────────

function startServer(config: ResolvedPluginConfig): void {
  const PORT = parseInt(process.env.SENTRY_COLLECTOR_PORT || "9876", 10);
  interface SessionState {
    rootSpan: ReturnType<typeof Sentry.startInactiveSpan>;
    currentTurnSpan: ReturnType<typeof Sentry.startInactiveSpan> | null;
    pendingTools: Map<string, ReturnType<typeof Sentry.startInactiveSpan>>;
    toolCount: number;
    model: string;
    chapter: number;
  }
  const sessions = new Map<string, SessionState>();

  function newRootSpan(
    sessionId: string,
    model: string,
    chapter: number,
    ongoing: boolean,
  ): ReturnType<typeof Sentry.startInactiveSpan> {
    const rootAttrs: Record<string, string | number | boolean> = {
      "gen_ai.agent.name": "claude-code",
      "gen_ai.request.model": model,
      "gen_ai.system": "anthropic",
      "claude.session_id": sessionId,
    };
    for (const [key, value] of Object.entries(config.tags)) {
      rootAttrs[key] = value;
    }
    if (chapter > 0 || ongoing) {
      rootAttrs["claude.session_chapter"] = chapter;
      rootAttrs["claude.session_ongoing"] = ongoing;
    }
    return Sentry.startInactiveSpan({
      name: "invoke_agent claude-code",
      op: "gen_ai.invoke_agent",
      forceTransaction: true,
      attributes: rootAttrs,
    });
  }

  /**
   * Close the current chapter of a still-open session and start the next one,
   * so realtime sessions that never end still report every flushInterval.
   */
  function rotateSession(sessionId: string, session: SessionState): void {
    if (session.currentTurnSpan) {
      session.currentTurnSpan.end();
      session.currentTurnSpan = null;
    }
    for (const span of session.pendingTools.values()) {
      span.end();
    }
    session.pendingTools.clear();
    session.rootSpan.setAttribute("gen_ai.tool.call_count", session.toolCount);
    session.rootSpan.setAttribute("claude.session_ongoing", true);
    session.rootSpan.end();
    Sentry.flush(5_000);

    session.chapter += 1;
    session.toolCount = 0;
    session.rootSpan = newRootSpan(sessionId, session.model, session.chapter, true);
  }

  function handleEvent(event: Record<string, unknown>): void {
    const { session_id, hook_event_name: rawEvent, tool_name } = event as {
      session_id: string;
      hook_event_name: string;
      tool_name?: string;
      tool_input?: unknown;
    };
    const hook_event_name = rawEvent.charAt(0).toUpperCase() + rawEvent.slice(1);

    switch (hook_event_name) {
      case "SessionStart": {
        const model = (event.model as string) || "claude";
        sessions.set(session_id, {
          rootSpan: newRootSpan(session_id, model, 0, false),
          currentTurnSpan: null,
          pendingTools: new Map(),
          toolCount: 0,
          model,
          chapter: 0,
        });
        break;
      }

      case "UserPromptSubmit": {
        const session = sessions.get(session_id);
        if (!session) break;

        // End previous turn span if any
        if (session.currentTurnSpan) {
          session.currentTurnSpan.end();
        }

        const turnAttrs: Record<string, string | number | boolean> = {};
        const prompt = (event.prompt as string) || (event.message as string) || null;
        if (config.recordInputs && prompt) {
          turnAttrs["gen_ai.request.messages"] = serializeAttribute(
            [{ role: "user", content: prompt }],
            config.maxAttributeLength,
          );
        }

        session.currentTurnSpan = Sentry.withActiveSpan(session.rootSpan, () =>
          Sentry.startInactiveSpan({
            name: "gen_ai.chat",
            op: "gen_ai.request",
            attributes: turnAttrs,
          }),
        );
        break;
      }

      case "PreToolUse": {
        const session = sessions.get(session_id);
        if (!session) break;

        const attrs: Record<string, string | number | boolean> = {
          "gen_ai.tool.name": tool_name ?? "unknown",
        };

        if (config.recordInputs && event.tool_input) {
          attrs["gen_ai.tool.input"] = serializeAttribute(
            event.tool_input,
            config.maxAttributeLength,
          );
        }

        const parentSpan = session.currentTurnSpan ?? session.rootSpan;
        const toolSpan = Sentry.withActiveSpan(parentSpan, () =>
          Sentry.startInactiveSpan({
            name: `execute_tool ${tool_name}`,
            op: "gen_ai.execute_tool",
            attributes: attrs,
          }),
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
          if (config.recordOutputs && event.tool_response) {
            toolSpan.setAttribute(
              "gen_ai.tool.output",
              serializeAttribute(event.tool_response, config.maxAttributeLength),
            );
          }
          if ((event as any).tool_error === true) {
            toolSpan.setAttribute("gen_ai.tool.error", true);
            toolSpan.setStatus({ code: 2, message: "tool_error" });
          }
          toolSpan.end();
          session.pendingTools.delete(event.tool_use_id as string);
        }
        break;
      }

      case "SessionEnd": {
        const session = sessions.get(session_id);
        if (!session) break;
        if (session.currentTurnSpan) {
          session.currentTurnSpan.end();
        }
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
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => {
      try {
        handleEvent(JSON.parse(body));
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

  // Periodically rotate open sessions so ones that never end still report.
  if (config.flushIntervalMinutes > 0) {
    const timer = setInterval(
      () => {
        for (const [sessionId, session] of sessions) {
          rotateSession(sessionId, session);
        }
      },
      config.flushIntervalMinutes * 60_000,
    );
    timer.unref();
  }

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
  // Read hook event from stdin
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

  // Load config
  const loaded = await loadPluginConfig();
  if (!loaded) {
    // No DSN configured, exit silently
    process.exit(0);
  }

  const { config } = loaded;

  const timestamped = addTimestamp(event);
  // Normalize: Claude Code sends "sessionEnd" (camelCase) but other events are PascalCase
  const rawHookEvent = event.hook_event_name as string;
  const hookEvent = rawHookEvent.charAt(0).toUpperCase() + rawHookEvent.slice(1);
  const sessionId = event.session_id as string;

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
        if (!healthRes.ok) throw new Error("not ok");
      } catch {
        // Start server in background
        const { spawn } = await import("node:child_process");
        const child = spawn(
          process.execPath,
          [import.meta.filename, "--serve", JSON.stringify(config)],
          {
            detached: true,
            stdio: "ignore",
          },
        );
        child.unref();

        // Wait for server to be ready
        for (let i = 0; i < 6; i++) {
          await new Promise((r) => setTimeout(r, 500));
          try {
            const res = await fetch(`${BASE}/health`);
            if (res.ok) break;
          } catch {}
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
    } catch {}
  } else {
    // Batch mode: append to session-specific JSONL file
    const logfile = batchLogPath(sessionId);
    appendFileSync(logfile, JSON.stringify(timestamped) + "\n");

    // First time we ever see this session? Seed its token offset from whatever the
    // transcript already contains, so we never report tokens spent before the plugin
    // was watching. A brand-new session has an (almost) empty transcript, so this
    // seeds ~0 and changes nothing. A session resumed with --resume — or any session
    // that predates the install — already carries its full history, and without this
    // the first flush would report that entire history as if it were new spend.
    if (hookEvent === "SessionStart" && !existsSync(offsetPath(sessionId))) {
      const transcriptPath = event.transcript_path as string | undefined;
      const needContent = config.recordInputs || config.recordOutputs;
      if (transcriptPath && !needContent) {
        // Fast path: mark the read state at end-of-transcript (a stat, not a
        // read) so we count only tokens spent from here on. This is what keeps
        // resuming a huge session from freezing at startup.
        seedReadStateAtEnd(sessionId, transcriptPath);
        writeCarry(sessionId, 0, { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
      } else {
        const priorTokens = transcriptPath ? extractTokensFromTranscript(transcriptPath) : null;
        writeCarry(sessionId, 0, {
          input: priorTokens?.inputTokens ?? 0,
          cacheWrite: priorTokens?.cacheCreationTokens ?? 0,
          cacheRead: priorTokens?.cacheReadTokens ?? 0,
          output: priorTokens?.outputTokens ?? 0,
        });
      }
    }

    if (hookEvent === "SessionEnd") {
      // Final flush of whatever remains in the current chapter.
      await initSentry(config);
      await processBatch(logfile, config, sessionId);
    } else if (
      config.flushIntervalMinutes > 0 &&
      chapterAgeMs(logfile) >= config.flushIntervalMinutes * 60_000
    ) {
      // Long-lived session: flush the current chapter and start a fresh one so
      // sessions that never end still report periodically.
      await initSentry(config);
      await processChunk(logfile, config, sessionId);
    }
    // Otherwise we only appended a line — Sentry was never loaded.
  }
}

// Handle --serve flag (spawned by realtime mode)
const [, , command, configArg] = process.argv;
if (command === "--serve" && configArg) {
  const config = JSON.parse(configArg) as ResolvedPluginConfig;
  initSentry(config)
    .then(() => startServer(config))
    .catch(() => process.exit(0));
} else {
  main().catch(() => process.exit(0));
}

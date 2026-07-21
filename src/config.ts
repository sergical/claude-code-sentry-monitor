import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import stripJsonComments from "strip-json-comments";

const CONFIG_FILE_NAMES = [
  "sentry-monitor.json",
  "sentry-monitor.jsonc",
] as const;

const DEFAULTS = {
  tracesSampleRate: 1,
  recordInputs: true,
  recordOutputs: true,
  maxAttributeLength: 12000,
  enableMetrics: false,
  tags: {} as Record<string, string>,
  flushIntervalMinutes: 0,
} as const;

export interface SentryUser {
  email?: string;
  id?: string;
  username?: string;
}

export interface PluginConfig {
  dsn: string;
  tracesSampleRate?: number;
  environment?: string;
  release?: string;
  debug?: boolean;
  recordInputs?: boolean;
  recordOutputs?: boolean;
  maxAttributeLength?: number;
  enableMetrics?: boolean;
  tags?: Record<string, string>;
  mode?: "batch" | "realtime";
  /**
   * Populates Sentry's user context so traces show up under a user (and can be
   * filtered with `user.email:...`). The plugin otherwise leaves user context
   * empty. Filter by the `developer` tag instead if you don't set this.
   */
  user?: SentryUser;
  /**
   * When > 0, long-lived sessions are flushed to Sentry every N minutes as
   * successive "chapter" transactions instead of only once at SessionEnd.
   * Required for workflows that keep sessions open indefinitely — with the
   * default of 0, a session that never ends never reports anything.
   */
  flushIntervalMinutes?: number;
}

export interface ResolvedPluginConfig {
  dsn: string;
  tracesSampleRate: number;
  environment?: string;
  release?: string;
  debug?: boolean;
  recordInputs: boolean;
  recordOutputs: boolean;
  maxAttributeLength: number;
  enableMetrics: boolean;
  tags: Record<string, string>;
  mode: "batch" | "realtime";
  flushIntervalMinutes: number;
  user?: SentryUser;
}

export interface LoadedPluginConfig {
  source: string;
  config: ResolvedPluginConfig;
}

function asString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`"${fieldName}" must be a non-empty string`);
  }
  return value.trim();
}

function asOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return asString(value, fieldName);
}

function asOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`"${fieldName}" must be a boolean`);
  }
  return value;
}

function asOptionalNumber(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`"${fieldName}" must be a finite number`);
  }
  return value;
}

function asOptionalTags(value: unknown, fieldName: string): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`"${fieldName}" must be an object`);
  }
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") {
      throw new Error(`"${fieldName}.${k}" must be a string`);
    }
  }
  return value as Record<string, string>;
}

function asOptionalUser(value: unknown, fieldName: string): SentryUser | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`"${fieldName}" must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const user: SentryUser = {
    email: asOptionalString(raw.email, `${fieldName}.email`),
    id: asOptionalString(raw.id, `${fieldName}.id`),
    username: asOptionalString(raw.username, `${fieldName}.username`),
  };
  // Drop entirely if no field was provided.
  if (!user.email && !user.id && !user.username) {
    return undefined;
  }
  return user;
}

function parseBooleanEnv(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function parseNumberEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
}

function parseConfigContent(raw: string, source: string): Record<string, unknown> {
  try {
    // Strip a leading UTF-8 BOM — editors/PowerShell on Windows often add one,
    // and neither stripJsonComments nor JSON.parse tolerate it.
    const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = JSON.parse(stripJsonComments(withoutBom));

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Config root must be an object");
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid config in ${source}: ${message}`);
  }
}

function normalizeConfig(raw: Record<string, unknown>): ResolvedPluginConfig {
  const dsn = asString(raw.dsn, "dsn");

  let dsnUrl: URL;
  try {
    dsnUrl = new URL(dsn);
  } catch {
    throw new Error('"dsn" must be a valid URL');
  }

  if (!/^https?:$/.test(dsnUrl.protocol)) {
    throw new Error('"dsn" must use "https" or "http" protocol');
  }

  const tracesSampleRate =
    asOptionalNumber(raw.tracesSampleRate, "tracesSampleRate") ?? DEFAULTS.tracesSampleRate;
  if (tracesSampleRate < 0 || tracesSampleRate > 1) {
    throw new Error('"tracesSampleRate" must be between 0 and 1');
  }

  const maxAttributeLength =
    asOptionalNumber(raw.maxAttributeLength, "maxAttributeLength") ??
    DEFAULTS.maxAttributeLength;
  if (!Number.isInteger(maxAttributeLength) || maxAttributeLength < 128) {
    throw new Error('"maxAttributeLength" must be an integer >= 128');
  }

  const modeRaw = asOptionalString(raw.mode, "mode");
  const mode = modeRaw === "realtime" ? "realtime" : "batch";

  const flushIntervalMinutes =
    asOptionalNumber(raw.flushIntervalMinutes, "flushIntervalMinutes") ??
    DEFAULTS.flushIntervalMinutes;
  if (!Number.isFinite(flushIntervalMinutes) || flushIntervalMinutes < 0) {
    throw new Error('"flushIntervalMinutes" must be a number >= 0');
  }

  return {
    dsn,
    tracesSampleRate,
    environment: asOptionalString(raw.environment, "environment"),
    release: asOptionalString(raw.release, "release"),
    debug: asOptionalBoolean(raw.debug, "debug"),
    recordInputs: asOptionalBoolean(raw.recordInputs, "recordInputs") ?? DEFAULTS.recordInputs,
    recordOutputs:
      asOptionalBoolean(raw.recordOutputs, "recordOutputs") ?? DEFAULTS.recordOutputs,
    maxAttributeLength,
    enableMetrics:
      asOptionalBoolean(raw.enableMetrics, "enableMetrics") ?? DEFAULTS.enableMetrics,
    tags: asOptionalTags(raw.tags, "tags") ?? DEFAULTS.tags,
    mode,
    flushIntervalMinutes,
    user: asOptionalUser(raw.user, "user"),
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function addUnique(list: string[], value: string | undefined): void {
  if (!value) {
    return;
  }
  if (!list.includes(value)) {
    list.push(value);
  }
}

function resolveMaybeRelative(filePath: string, cwd: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

/**
 * Parse legacy KEY=VALUE config format (from ~/.config/sentry-claude/config).
 * Returns a partial config object with dsn and mode if found.
 */
function parseLegacyConfig(content: string): Record<string, unknown> {
  const raw: Record<string, unknown> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    // Strip surrounding quotes
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    switch (key) {
      case "SENTRY_DSN":
        raw.dsn = val;
        break;
      case "SENTRY_CLAUDE_MODE":
        raw.mode = val;
        break;
      case "SENTRY_ENVIRONMENT":
        raw.environment = val;
        break;
      case "SENTRY_RELEASE":
        raw.release = val;
        break;
    }
  }

  return raw;
}

async function getCandidatePaths(): Promise<string[]> {
  const candidates: string[] = [];

  // 1. Explicit path via env var
  const explicitPath = process.env.CLAUDE_SENTRY_CONFIG;
  if (explicitPath) {
    addUnique(candidates, isAbsolute(explicitPath) ? explicitPath : resolve(explicitPath));
  }

  // 2. User-global config (~/.config/claude-code/)
  const home = homedir();
  if (home) {
    for (const fileName of CONFIG_FILE_NAMES) {
      addUnique(candidates, join(home, ".config", "claude-code", fileName));
    }
  }

  return candidates;
}

function addEnvOverrides(raw: Record<string, unknown>): Record<string, unknown> {
  const withEnv = { ...raw };

  const dsn = process.env.CLAUDE_SENTRY_DSN ?? process.env.SENTRY_DSN;
  if (dsn) {
    withEnv.dsn = dsn;
  }

  const tracesSampleRate = parseNumberEnv("CLAUDE_SENTRY_TRACES_SAMPLE_RATE");
  if (tracesSampleRate !== undefined) {
    withEnv.tracesSampleRate = tracesSampleRate;
  }

  const recordInputs = parseBooleanEnv("CLAUDE_SENTRY_RECORD_INPUTS");
  if (recordInputs !== undefined) {
    withEnv.recordInputs = recordInputs;
  }

  const recordOutputs = parseBooleanEnv("CLAUDE_SENTRY_RECORD_OUTPUTS");
  if (recordOutputs !== undefined) {
    withEnv.recordOutputs = recordOutputs;
  }

  const maxAttributeLength = parseNumberEnv("CLAUDE_SENTRY_MAX_ATTRIBUTE_LENGTH");
  if (maxAttributeLength !== undefined) {
    withEnv.maxAttributeLength = maxAttributeLength;
  }

  const enableMetrics = parseBooleanEnv("CLAUDE_SENTRY_ENABLE_METRICS");
  if (enableMetrics !== undefined) {
    withEnv.enableMetrics = enableMetrics;
  }

  const tagsEnv = process.env.CLAUDE_SENTRY_TAGS;
  if (tagsEnv) {
    const envTags: Record<string, string> = {};
    for (const pair of tagsEnv.split(",")) {
      const colonIdx = pair.indexOf(":");
      if (colonIdx > 0) {
        const key = pair.slice(0, colonIdx).trim();
        const val = pair.slice(colonIdx + 1).trim();
        if (key.length > 0 && val.length > 0) {
          envTags[key] = val;
        }
      }
    }
    withEnv.tags = { ...(withEnv.tags as Record<string, string> | undefined), ...envTags };
  }

  const modeEnv = process.env.CLAUDE_SENTRY_MODE;
  if (modeEnv) {
    withEnv.mode = modeEnv;
  }

  const flushIntervalMinutes = parseNumberEnv("CLAUDE_SENTRY_FLUSH_INTERVAL_MINUTES");
  if (flushIntervalMinutes !== undefined) {
    withEnv.flushIntervalMinutes = flushIntervalMinutes;
  }

  const userEmail = process.env.CLAUDE_SENTRY_USER_EMAIL;
  const userId = process.env.CLAUDE_SENTRY_USER_ID;
  const userName = process.env.CLAUDE_SENTRY_USER_NAME;
  if (userEmail || userId || userName) {
    const base = (withEnv.user as Record<string, unknown> | undefined) ?? {};
    withEnv.user = {
      ...base,
      ...(userEmail ? { email: userEmail } : {}),
      ...(userId ? { id: userId } : {}),
      ...(userName ? { username: userName } : {}),
    };
  }

  if (process.env.SENTRY_ENVIRONMENT) {
    withEnv.environment = process.env.SENTRY_ENVIRONMENT;
  }

  if (process.env.SENTRY_RELEASE) {
    withEnv.release = process.env.SENTRY_RELEASE;
  }

  return withEnv;
}

export async function loadPluginConfig(): Promise<LoadedPluginConfig | null> {
  const candidates = await getCandidatePaths();

  let source = "environment";
  let raw: Record<string, unknown> = {};

  // Try JSON config files first
  for (const candidate of candidates) {
    if (!(await fileExists(candidate))) {
      continue;
    }

    const content = await readFile(candidate, "utf-8");
    raw = parseConfigContent(content, candidate);
    source = candidate;
    break;
  }

  // If no JSON config found, try legacy KEY=VALUE format
  if (Object.keys(raw).length === 0) {
    const home = homedir();
    if (home) {
      const legacyPath = join(home, ".config", "sentry-claude", "config");
      if (await fileExists(legacyPath)) {
        const content = await readFile(legacyPath, "utf-8");
        raw = parseLegacyConfig(content);
        source = legacyPath;
      }
    }
  }

  // Apply env var overrides
  raw = addEnvOverrides(raw);

  // If no DSN found anywhere, plugin stays disabled
  if (typeof raw.dsn !== "string" || raw.dsn.trim().length === 0) {
    return null;
  }

  const config = normalizeConfig(raw);
  return { source, config };
}

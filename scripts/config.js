import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import stripJsonComments from "strip-json-comments";
const CONFIG_FILE_NAMES = [
    "sentry-monitor.json",
    "sentry-monitor.jsonc",
];
const DEFAULTS = {
    tracesSampleRate: 1,
    recordInputs: true,
    recordOutputs: true,
    maxAttributeLength: 12000,
    enableMetrics: false,
    tags: {},
};
function asString(value, fieldName) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`"${fieldName}" must be a non-empty string`);
    }
    return value.trim();
}
function asOptionalString(value, fieldName) {
    if (value === undefined) {
        return undefined;
    }
    return asString(value, fieldName);
}
function asOptionalBoolean(value, fieldName) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "boolean") {
        throw new Error(`"${fieldName}" must be a boolean`);
    }
    return value;
}
function asOptionalNumber(value, fieldName) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`"${fieldName}" must be a finite number`);
    }
    return value;
}
function asOptionalTags(value, fieldName) {
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
    return value;
}
function parseBooleanEnv(name) {
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
function parseNumberEnv(name) {
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
function parseConfigContent(raw, source) {
    try {
        const parsed = JSON.parse(stripJsonComments(raw));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Config root must be an object");
        }
        return parsed;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid config in ${source}: ${message}`);
    }
}
function normalizeConfig(raw) {
    const dsn = asString(raw.dsn, "dsn");
    let dsnUrl;
    try {
        dsnUrl = new URL(dsn);
    }
    catch {
        throw new Error('"dsn" must be a valid URL');
    }
    if (!/^https?:$/.test(dsnUrl.protocol)) {
        throw new Error('"dsn" must use "https" or "http" protocol');
    }
    const tracesSampleRate = asOptionalNumber(raw.tracesSampleRate, "tracesSampleRate") ?? DEFAULTS.tracesSampleRate;
    if (tracesSampleRate < 0 || tracesSampleRate > 1) {
        throw new Error('"tracesSampleRate" must be between 0 and 1');
    }
    const maxAttributeLength = asOptionalNumber(raw.maxAttributeLength, "maxAttributeLength") ??
        DEFAULTS.maxAttributeLength;
    if (!Number.isInteger(maxAttributeLength) || maxAttributeLength < 128) {
        throw new Error('"maxAttributeLength" must be an integer >= 128');
    }
    const modeRaw = asOptionalString(raw.mode, "mode");
    const mode = modeRaw === "realtime" ? "realtime" : "batch";
    return {
        dsn,
        tracesSampleRate,
        environment: asOptionalString(raw.environment, "environment"),
        release: asOptionalString(raw.release, "release"),
        debug: asOptionalBoolean(raw.debug, "debug"),
        recordInputs: asOptionalBoolean(raw.recordInputs, "recordInputs") ?? DEFAULTS.recordInputs,
        recordOutputs: asOptionalBoolean(raw.recordOutputs, "recordOutputs") ?? DEFAULTS.recordOutputs,
        maxAttributeLength,
        enableMetrics: asOptionalBoolean(raw.enableMetrics, "enableMetrics") ?? DEFAULTS.enableMetrics,
        tags: asOptionalTags(raw.tags, "tags") ?? DEFAULTS.tags,
        mode,
    };
}
async function fileExists(filePath) {
    try {
        await access(filePath, fsConstants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
function addUnique(list, value) {
    if (!value) {
        return;
    }
    if (!list.includes(value)) {
        list.push(value);
    }
}
function resolveMaybeRelative(filePath, cwd) {
    return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}
/**
 * Parse legacy KEY=VALUE config format (from ~/.config/sentry-claude/config).
 * Returns a partial config object with dsn and mode if found.
 */
function parseLegacyConfig(content) {
    const raw = {};
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx <= 0)
            continue;
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
async function getCandidatePaths() {
    const candidates = [];
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
function addEnvOverrides(raw) {
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
        const envTags = {};
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
        withEnv.tags = { ...withEnv.tags, ...envTags };
    }
    const modeEnv = process.env.CLAUDE_SENTRY_MODE;
    if (modeEnv) {
        withEnv.mode = modeEnv;
    }
    if (process.env.SENTRY_ENVIRONMENT) {
        withEnv.environment = process.env.SENTRY_ENVIRONMENT;
    }
    if (process.env.SENTRY_RELEASE) {
        withEnv.release = process.env.SENTRY_RELEASE;
    }
    return withEnv;
}
export async function loadPluginConfig() {
    const candidates = await getCandidatePaths();
    let source = "environment";
    let raw = {};
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

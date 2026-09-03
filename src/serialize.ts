const SENSITIVE_KEY_PATTERN =
  /(api[-_]?key|token|secret|password|authorization|cookie|session|bearer|x-api-key)/i;

// Key-name matching only protects structured data. Tool inputs and outputs are
// mostly free text — shell commands, file contents, HTTP responses — where a
// credential is just a substring. These patterns redact the credential itself
// while leaving the surrounding text readable.
//
// A pattern may define a named `keep` group for the non-secret prefix (a URL
// scheme, the `KEY=` of an assignment) that should survive redaction. Every
// other group must be non-capturing.
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  // PEM private key blocks (the whole block, not just the header).
  /-----BEGIN(?:[ A-Z]*)PRIVATE KEY-----[\s\S]*?-----END(?:[ A-Z]*)PRIVATE KEY-----/g,
  // JWTs.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Anthropic / OpenAI / Stripe style prefixed keys.
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj)[-_][A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  // GitHub and npm tokens.
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  // AWS access key ids and Google API keys.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  /\bAIza[A-Za-z0-9_-]{35}/g,
  // Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  // Credentials embedded in a URL, including Sentry DSNs.
  /(?<keep>\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+(?::[^\s/@]+)?@/gi,
  // `KEY=value` / `KEY: value` where the key looks sensitive. The value may be
  // quoted and may carry a `Bearer ` prefix, both of which are consumed.
  /(?<keep>\b[A-Za-z0-9_-]*(?:API[-_]?KEY|TOKEN|SECRET|PASSWD|PASSWORD|CREDENTIAL|PRIVATE[-_]?KEY|AUTHORIZATION)[A-Za-z0-9_-]*["']?\s*[=:]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|\S+)/gi,
  // `--password secret`, `--token=secret`.
  /(?<keep>(?:^|\s)--?(?:password|token|secret|api[-_]?key)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi,
  // A bearer token anywhere else.
  /(?<keep>\bBearer\s+)[A-Za-z0-9._~+/-]{8,}=*/g,
];

function redactString(value: string): string {
  let output = value;

  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    output = output.replace(pattern, (...args: unknown[]) => {
      const last = args[args.length - 1];
      const groups =
        typeof last === "object" && last !== null
          ? (last as Record<string, string | undefined>)
          : undefined;
      const keep = groups?.keep;
      return keep ? `${keep}[REDACTED]` : "[REDACTED]";
    });
  }

  return output;
}

function redact(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > 8) {
    return "[DepthLimit]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  if (typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen, depth + 1));
  }

  const output: Record<string, unknown> = {};

  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = "[REDACTED]";
      continue;
    }

    output[key] = redact(nested, seen, depth + 1);
  }

  return output;
}

function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0) {
    return "";
  }

  if (value.length <= maxLength) {
    return value;
  }

  const omitted = value.length - maxLength;
  return `${value.slice(0, maxLength)}...[truncated ${omitted} chars]`;
}

export function serializeAttribute(value: unknown, maxLength: number): string {
  const redacted = redact(value, new WeakSet<object>(), 0);

  if (typeof redacted === "string") {
    return truncate(redacted, maxLength);
  }

  try {
    return truncate(JSON.stringify(redacted), maxLength);
  } catch {
    return "[Unserializable]";
  }
}

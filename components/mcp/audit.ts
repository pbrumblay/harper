/**
 * Per-`tools/call` audit logging. Emits a structured info-level log entry
 * for every tool invocation so operators can replay who-did-what after the
 * fact. The shape mirrors what Harper's existing operations audit captures
 * (operation, user, status, duration) plus MCP-specific identity
 * (session id, profile, tool name).
 *
 * Argument summarization runs through a redaction step that drops anything
 * that looks like a credential (key/secret/password). Operators who need
 * stricter PII handling configure `mcp.audit.argumentRedactor` to a custom
 * function via a future component-author hook (v1.1).
 */
import harperLogger from '../../utility/logging/harper_logger.ts';

export interface AuditEntry {
	timestamp: string;
	profile: 'operations' | 'application';
	sessionId: string;
	tool: string;
	user: string;
	args: object;
	status: 'ok' | 'isError' | 'rate_limited' | 'protocol_error';
	durationMs: number;
	errorMessage?: string;
}

const REDACTION_PATTERN = /(secret|password|token|api[-_]?key|credentials?|auth)/i;
const REDACTION_PLACEHOLDER = '[redacted]';

/**
 * Recursively walk an object and replace values for keys matching the
 * redaction pattern. Bounded depth so a pathological cyclic input doesn't
 * stall the audit emit. Returns a shallow clone — the caller's payload is
 * never mutated.
 */
export function redactArgs(value: unknown, depth = 0): unknown {
	if (depth > 5 || value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) {
		return value.map((v) => redactArgs(v, depth + 1));
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		if (REDACTION_PATTERN.test(k)) {
			out[k] = REDACTION_PLACEHOLDER;
		} else {
			out[k] = redactArgs(v, depth + 1);
		}
	}
	return out;
}

/** Mask a session id for logging — first 8 chars, suffix elided. */
export function maskSessionId(id: string): string {
	if (typeof id !== 'string' || id.length <= 8) return id;
	return `${id.slice(0, 8)}…`;
}

/**
 * Emit a single audit entry. Writes to the structured log channel as INFO
 * so it's captured by Harper's standard log rotation; downstream tooling
 * can filter on `category: 'mcp.audit'`.
 */
export function emitAuditEntry(entry: AuditEntry): void {
	try {
		const masked = { ...entry, sessionId: maskSessionId(entry.sessionId), args: redactArgs(entry.args) };
		harperLogger.info({ category: 'mcp.audit', ...masked });
	} catch (err) {
		// Audit emission must never break a tool call. If logging itself fails
		// (logger disposed, disk full, whatever), trace-log the loss and move on.
		harperLogger.trace(`MCP audit emit failed: ${(err as Error).message}`);
	}
}

/**
 * MCP Streamable HTTP transport core — framework-agnostic.
 *
 * Takes a normalized request (method, headers, body, authenticated user,
 * profile) and returns a normalized response (status, headers, optional
 * JSON body or SSE iterable). The Fastify adapter (operations port) and
 * Harper-HTTP adapter (application port) each translate to/from this shape.
 *
 * All spec MUSTs from MCP §basic/transports (rev 2025-06-18) live here:
 *   - Origin validation
 *   - Mcp-Session-Id lifecycle
 *   - MCP-Protocol-Version enforcement
 *   - HTTP status code mapping (200/202/400/403/404/405)
 *   - JSON-RPC envelope parsing + standard error codes
 */
import * as env from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import {
	ERROR_CODES,
	buildError,
	buildSuccess,
	isClientFireAndForget,
	parseMessage,
	type JsonRpcId,
	type JsonRpcMessage,
} from './jsonrpc.ts';
import {
	handleInitialize,
	handleInitialized,
	PROTOCOL_VERSION_BACKCOMPAT,
	SUPPORTED_PROTOCOL_VERSIONS,
} from './lifecycle.ts';
import { deleteSession, loadSession, touchSession } from './session.ts';

export type McpProfile = 'operations' | 'application';

export interface NormRequest {
	method: string;
	/** Lowercased header name → value. Adapters normalize before calling. */
	headers: Record<string, string | undefined>;
	/**
	 * The request body. May be a raw JSON string (Harper-HTTP adapter, which
	 * reads from a stream) or an already-parsed value (Fastify adapter, which
	 * receives parsed JSON via its preParsing pipeline). `parseMessage` handles
	 * both — no JSON round-trip needed.
	 */
	body: string | unknown;
	/** Authenticated username from upstream auth pipeline. */
	user: string;
	profile: McpProfile;
}

export interface NormResponse {
	status: number;
	headers: Record<string, string>;
	jsonBody?: unknown;
	sseIterable?: AsyncIterable<unknown>;
}

const SESSION_HEADER = 'mcp-session-id';
const PROTOCOL_HEADER = 'mcp-protocol-version';
const ORIGIN_HEADER = 'origin';

/**
 * Main entry. Adapters call this and map the returned shape to their
 * native wire format. Any unhandled error from a downstream call (e.g., a
 * RocksDB I/O failure on the session table) is caught and reported as a
 * spec-conformant JSON-RPC Internal Error so clients see a structured
 * error envelope instead of an opaque framework 500.
 */
export async function handleMcpRequest(request: NormRequest): Promise<NormResponse> {
	try {
		if (!isOriginAllowed(request)) {
			return jsonResponse(403, { error: 'origin_not_allowed' });
		}
		if (request.method === 'POST') return await handlePost(request);
		if (request.method === 'GET') return handleGet();
		if (request.method === 'DELETE') return await handleDelete(request);
		return { status: 405, headers: { Allow: currentlyAllowedMethods() } };
	} catch (err) {
		harperLogger.error(`MCP transport internal error: ${(err as Error).stack ?? (err as Error).message}`);
		return jsonRpcErrorResponse(500, null, ERROR_CODES.INTERNAL_ERROR, 'internal error');
	}
}

/**
 * Per-profile Origin validation. Mirrors Harper's existing auth.ts pattern
 * (security/auth.ts:65) for parity with how the operations + HTTP ports
 * already handle CORS:
 *   - CORS disabled in config ⇒ accept any Origin (don't gate on it at all).
 *   - CORS enabled with empty/unset allow-list ⇒ accept any.
 *   - CORS enabled with allow-list ⇒ match exactly OR honor a `'*'` wildcard.
 *   - Missing Origin header ⇒ accept (curl, server-to-server, no DNS-rebinding
 *     vector exists when the request isn't browser-initiated).
 */
function isOriginAllowed(request: NormRequest): boolean {
	const origin = request.headers[ORIGIN_HEADER];
	if (!origin) return true;
	const corsEnabled =
		request.profile === 'operations'
			? env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORS)
			: env.get(CONFIG_PARAMS.HTTP_CORS);
	if (!corsEnabled) return true;
	const list =
		request.profile === 'operations'
			? env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORSACCESSLIST)
			: env.get(CONFIG_PARAMS.HTTP_CORSACCESSLIST);
	if (!Array.isArray(list) || list.length === 0) return true;
	return list.includes(origin) || list.includes('*');
}

async function handlePost(request: NormRequest): Promise<NormResponse> {
	const parsed = parseMessage(request.body);
	if (parsed.ok !== true) {
		// Explicit cast: tsconfig has `strict: false`, so TS can't narrow
		// discriminated unions from `parsed.ok !== true`. Without the cast it
		// errors TS2339 on `parsed.code` / `parsed.reason`. (Verified during
		// review; the alternative — enabling strict mode — is repo-wide.)
		const fail = parsed as { ok: false; code: number; reason: string };
		return jsonRpcErrorResponse(400, null, fail.code, fail.reason);
	}
	const message = parsed.message;
	const messageId: JsonRpcId = 'id' in message ? message.id : null;
	const method = 'method' in message ? message.method : undefined;

	if (method === 'initialize') return dispatchInitialize(request, message, messageId);

	const sessionId = request.headers[SESSION_HEADER];
	if (!sessionId) {
		return jsonRpcErrorResponse(400, messageId, ERROR_CODES.INVALID_REQUEST, 'missing Mcp-Session-Id header');
	}
	const session = await loadSession(sessionId);
	if (!session) {
		// Terminated, expired, or never existed. Spec mandates 404 so the
		// client knows to drop the id and re-initialize.
		return { status: 404, headers: {} };
	}

	const protocolCheck = validateProtocolHeader(request.headers[PROTOCOL_HEADER], session.protocolVersion);
	if (protocolCheck.ok !== true) {
		const fail = protocolCheck as { ok: false; reason: string };
		return jsonRpcErrorResponse(400, messageId, ERROR_CODES.INVALID_REQUEST, fail.reason);
	}

	if (session.user !== request.user) {
		// Defense-in-depth against session-id leaks: id was created for a
		// different user. Mask the session id in logs — even though it's not
		// a credential in MCP, leaking it to an attacker with log access would
		// enable session-jacking once paired with a valid token.
		harperLogger.warn(
			`MCP session ${maskSessionId(sessionId)} presented by user ${request.user} but bound to ${session.user}`
		);
		return { status: 403, headers: {} };
	}

	// Sliding-window idle reset. Awaited (not fire-and-forget) so a concurrent
	// DELETE that arrives mid-request can't be resurrected by a late put.
	await touchSession(session);

	// Fire-and-forget frames (notifications + client responses) always 202.
	if (isClientFireAndForget(message)) {
		if (method === 'notifications/initialized') {
			await handleInitialized(session);
		}
		return { status: 202, headers: {} };
	}

	// Request (has id + method, not 'initialize') — stub responder for v1.
	// Tools/resources lands in #615/#616/#617/#618; until then, every method
	// other than initialize gets a spec-conformant Method-not-found error.
	return jsonResponse(
		200,
		buildError(messageId, ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method ?? '<missing>'}`)
	);
}

async function dispatchInitialize(
	request: NormRequest,
	message: JsonRpcMessage,
	messageId: JsonRpcId
): Promise<NormResponse> {
	const params = 'params' in message ? (message.params as { protocolVersion?: unknown } | undefined) : undefined;
	const outcome = await handleInitialize(params, request.user);
	if (outcome.ok !== true) {
		const fail = outcome as { ok: false; reason: string; supportedVersions: readonly string[] };
		return jsonRpcErrorResponse(400, messageId, ERROR_CODES.INVALID_PARAMS, fail.reason, {
			supportedVersions: fail.supportedVersions,
		});
	}
	return {
		status: 200,
		headers: { 'Mcp-Session-Id': outcome.session.id },
		jsonBody: buildSuccess(messageId, outcome.result),
	};
}

function handleGet(): NormResponse {
	// v1 does not offer a GET SSE channel. #619 will replace this with a
	// real server-push stream for `listChanged` notifications.
	return { status: 405, headers: { Allow: currentlyAllowedMethods() } };
}

async function handleDelete(request: NormRequest): Promise<NormResponse> {
	const allow = env.get(CONFIG_PARAMS.MCP_SESSION_ALLOWCLIENTDELETE);
	if (allow !== true) {
		return { status: 405, headers: { Allow: currentlyAllowedMethods() } };
	}
	const sessionId = request.headers[SESSION_HEADER];
	if (!sessionId) {
		return { status: 400, headers: {} };
	}
	const session = await loadSession(sessionId);
	if (!session) {
		return { status: 404, headers: {} };
	}
	if (session.user !== request.user) {
		return { status: 403, headers: {} };
	}
	await deleteSession(sessionId);
	return { status: 204, headers: {} };
}

function validateProtocolHeader(
	headerValue: string | undefined,
	sessionVersion: string
): { ok: true } | { ok: false; reason: string } {
	// Per spec compatibility rule: missing header is treated as 2025-03-26.
	const effective = headerValue ?? PROTOCOL_VERSION_BACKCOMPAT;
	if (!SUPPORTED_PROTOCOL_VERSIONS.includes(effective as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number])) {
		return { ok: false, reason: `unsupported MCP-Protocol-Version: ${effective}` };
	}
	if (effective !== sessionVersion) {
		return {
			ok: false,
			reason: `MCP-Protocol-Version mismatch: session negotiated ${sessionVersion}, request sent ${effective}`,
		};
	}
	return { ok: true };
}

function jsonResponse(status: number, body: unknown): NormResponse {
	return {
		status,
		headers: { 'Content-Type': 'application/json' },
		jsonBody: body,
	};
}

function jsonRpcErrorResponse(
	status: number,
	id: JsonRpcId,
	code: number,
	message: string,
	data?: unknown
): NormResponse {
	return {
		status,
		headers: { 'Content-Type': 'application/json' },
		jsonBody: buildError(id, code, message, data),
	};
}

/**
 * Mask an MCP session id for log output. Sessions aren't credentials in the
 * strict sense, but a leaked id paired with a stolen token enables session
 * jacking, so we don't print the full value in routine logs.
 */
function maskSessionId(id: string): string {
	if (id.length <= 8) return '***';
	return `${id.slice(0, 8)}…`;
}

/**
 * Build the `Allow` header value for a 405 response. Per RFC 9110 §9.1 the
 * server MUST list only currently-supported methods. In v1, POST is always
 * supported; GET is never supported (no SSE channel until #619); DELETE is
 * conditional on `mcp.session.allowClientDelete`.
 */
function currentlyAllowedMethods(): string {
	return env.get(CONFIG_PARAMS.MCP_SESSION_ALLOWCLIENTDELETE) === true ? 'POST, DELETE' : 'POST';
}

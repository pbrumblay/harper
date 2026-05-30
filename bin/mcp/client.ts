/**
 * Streamable HTTP MCP client over stdio. Implements the MCP rev 2025-06-18
 * transport from the client side: each line on stdin is a JSON-RPC frame,
 * POSTed to the server's `/mcp` endpoint; the response (JSON or SSE) is
 * parsed and emitted to stdout as line-delimited JSON-RPC. After the
 * `initialize` handshake completes, a long-lived GET request opens the
 * server-push SSE channel and forwards each notification to stdout.
 *
 * Sits between an MCP host (Claude Desktop, Cursor, Zed) and a running
 * Harper instance. The host treats this as a stdio-transport MCP server;
 * Harper sees a Streamable HTTP client. v1 keeps it simple — no
 * `Last-Event-ID` resumability, no multi-process session coordination.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import * as readline from 'node:readline';
import { URL } from 'node:url';
import type { McpCliOptions } from './options.ts';

interface HttpOptions {
	hostname?: string;
	port?: number | string;
	protocol: 'http:' | 'https:';
	socketPath?: string;
	rejectUnauthorized: boolean;
	authHeader?: string;
}

interface PostResult {
	statusCode: number;
	contentType: string;
	headers: http.IncomingHttpHeaders;
	bodyText: string; // for application/json
	sse?: AsyncIterable<SseFrame>;
}

interface SseFrame {
	event?: string;
	data: string;
	id?: string;
}

const SESSION_HEADER = 'mcp-session-id';
const PROTOCOL_HEADER = 'mcp-protocol-version';

export interface BridgeOptions {
	connection: HttpOptions;
	mountPath: string;
	stdin?: NodeJS.ReadableStream;
	stdout?: NodeJS.WritableStream;
	stderr?: NodeJS.WritableStream;
}

/**
 * Run the bridge until stdin closes (host disconnects) or the GET stream
 * errors. Returns a promise that resolves on graceful shutdown.
 */
export async function runBridge(opts: BridgeOptions): Promise<void> {
	const stdin = opts.stdin ?? process.stdin;
	const stdout = opts.stdout ?? process.stdout;
	const stderr = opts.stderr ?? process.stderr;
	const log = (msg: string): void => {
		stderr.write(`harper mcp: ${msg}\n`);
	};

	let sessionId: string | undefined;
	let protocolVersion: string | undefined;
	let getController: AbortController | undefined;

	const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });
	const writeFrame = (frame: object): void => {
		stdout.write(JSON.stringify(frame) + '\n');
	};

	// stdin lines → POST /mcp
	const stdinDone: Promise<void> = (async () => {
		for await (const line of rl) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let message: unknown;
			try {
				message = JSON.parse(trimmed);
			} catch (err) {
				log(`stdin line is not valid JSON, ignoring: ${(err as Error).message}`);
				continue;
			}
			try {
				const result = await postMessage(opts.connection, opts.mountPath, message, sessionId, protocolVersion);
				// Capture session id from initialize response.
				const newSid = headerString(result.headers, SESSION_HEADER);
				if (newSid && !sessionId) {
					sessionId = newSid;
					// If this is an initialize response, capture the protocol version
					// the server picked, then open the GET stream.
					const parsed = safeParse(result.bodyText);
					if (parsed && typeof parsed === 'object' && 'result' in (parsed as Record<string, unknown>)) {
						const r = (parsed as { result?: { protocolVersion?: unknown } }).result;
						if (r && typeof r.protocolVersion === 'string') protocolVersion = r.protocolVersion;
					}
					getController = openGetStream(opts.connection, opts.mountPath, sessionId, protocolVersion, writeFrame, log);
				}
				if (result.sse) {
					// Streaming POST response: each `message` event maps to a JSON-RPC frame.
					for await (const frame of result.sse) {
						if (frame.event && frame.event !== 'message') continue;
						const parsed = safeParse(frame.data);
						if (parsed) writeFrame(parsed as object);
					}
				} else if (result.bodyText) {
					const parsed = safeParse(result.bodyText);
					if (parsed) writeFrame(parsed as object);
				}
			} catch (err) {
				log(`POST failed: ${(err as Error).message}`);
				// Best-effort: emit a JSON-RPC error keyed to the original id so the
				// host doesn't hang waiting for a response.
				const id = (message as { id?: unknown })?.id ?? null;
				writeFrame({
					jsonrpc: '2.0',
					id,
					error: { code: -32603, message: (err as Error).message },
				});
			}
		}
	})();

	await stdinDone;
	getController?.abort();
}

function openGetStream(
	connection: HttpOptions,
	mountPath: string,
	sessionId: string,
	protocolVersion: string | undefined,
	writeFrame: (frame: object) => void,
	log: (msg: string) => void
): AbortController {
	const controller = new AbortController();
	(async () => {
		try {
			const { req, res } = await openRequest(connection, mountPath, 'GET', {
				accept: 'text/event-stream',
				[SESSION_HEADER]: sessionId,
				...(protocolVersion ? { [PROTOCOL_HEADER]: protocolVersion } : {}),
			});
			controller.signal.addEventListener('abort', () => {
				req.destroy();
			});
			if (res.statusCode !== 200) {
				log(`GET /mcp returned ${res.statusCode}; server-push notifications will not arrive`);
				res.resume();
				return;
			}
			for await (const frame of parseSseStream(res)) {
				if (frame.event && frame.event !== 'message') continue;
				const parsed = safeParse(frame.data);
				if (parsed) writeFrame(parsed as object);
			}
		} catch (err) {
			if ((err as { code?: string }).code === 'ABORT_ERR') return;
			log(`GET stream error: ${(err as Error).message}`);
		}
	})();
	return controller;
}

async function postMessage(
	connection: HttpOptions,
	mountPath: string,
	body: unknown,
	sessionId: string | undefined,
	protocolVersion: string | undefined
): Promise<PostResult> {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'accept': 'application/json, text/event-stream',
	};
	if (sessionId) headers[SESSION_HEADER] = sessionId;
	if (protocolVersion) headers[PROTOCOL_HEADER] = protocolVersion;
	const { req, res } = await openRequest(connection, mountPath, 'POST', headers, JSON.stringify(body));
	const contentType = (res.headers['content-type'] ?? '').toString();
	if (contentType.startsWith('text/event-stream')) {
		return {
			statusCode: res.statusCode ?? 0,
			contentType,
			headers: res.headers,
			bodyText: '',
			sse: parseSseStream(res),
		};
	}
	const bodyText = await collectBody(res);
	req.destroy();
	return { statusCode: res.statusCode ?? 0, contentType, headers: res.headers, bodyText };
}

interface OpenedRequest {
	req: http.ClientRequest;
	res: http.IncomingMessage;
}

function openRequest(
	connection: HttpOptions,
	mountPath: string,
	method: 'GET' | 'POST',
	headers: Record<string, string>,
	body?: string
): Promise<OpenedRequest> {
	return new Promise((resolve, reject) => {
		const isHttps = connection.protocol === 'https:';
		const lib = isHttps ? https : http;
		const reqHeaders: Record<string, string> = { ...headers };
		if (connection.authHeader) reqHeaders.authorization = connection.authHeader;
		const reqOptions: http.RequestOptions = {
			method,
			path: mountPath,
			headers: reqHeaders,
		};
		if (connection.socketPath) {
			reqOptions.socketPath = connection.socketPath;
		} else {
			reqOptions.hostname = connection.hostname;
			reqOptions.port = connection.port;
		}
		if (isHttps) {
			(reqOptions as https.RequestOptions).rejectUnauthorized = connection.rejectUnauthorized;
		}
		const req = lib.request(reqOptions, (res) => {
			resolve({ req, res });
		});
		req.on('error', (err) => reject(err));
		if (body !== undefined) req.write(body);
		req.end();
	});
}

async function collectBody(res: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of res) {
		chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
}

/**
 * Minimal SSE stream parser per WHATWG (server-sent events). MCP uses only
 * the `event`, `data`, and `id` fields; we ignore `retry` and comments.
 * Multi-line `data:` blocks are joined with `\n`.
 */
async function* parseSseStream(stream: NodeJS.ReadableStream): AsyncIterable<SseFrame> {
	let buffer = '';
	for await (const chunk of stream) {
		buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
		let idx: number;
		while ((idx = buffer.indexOf('\n\n')) !== -1) {
			const raw = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			const frame = parseSseFrame(raw);
			if (frame) yield frame;
		}
	}
	if (buffer.trim().length > 0) {
		const frame = parseSseFrame(buffer);
		if (frame) yield frame;
	}
}

function parseSseFrame(raw: string): SseFrame | null {
	const lines = raw.split(/\r?\n/);
	let event: string | undefined;
	let dataLines: string[] = [];
	let id: string | undefined;
	for (const line of lines) {
		if (!line || line.startsWith(':')) continue;
		const colon = line.indexOf(':');
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? '' : line.slice(colon + 1);
		if (value.startsWith(' ')) value = value.slice(1);
		if (field === 'event') event = value;
		else if (field === 'data') dataLines.push(value);
		else if (field === 'id') id = value;
	}
	if (dataLines.length === 0) return null;
	return { event, data: dataLines.join('\n'), id };
}

function headerString(headers: http.IncomingHttpHeaders, key: string): string | undefined {
	const v = headers[key.toLowerCase()];
	if (Array.isArray(v)) return v[0];
	return v;
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Resolve `--target` / UDS path + creds → HttpOptions. */
export function resolveConnection(opts: McpCliOptions): HttpOptions {
	// `--target` wins. Else fall back to local UDS via the operationsApi
	// domain socket — same path cliOperations uses.
	if (opts.target) {
		let parsed: URL;
		try {
			parsed = new URL(opts.target);
		} catch {
			parsed = new URL(`https://${opts.target}`);
		}
		const proto = parsed.protocol === 'http:' ? 'http:' : 'https:';
		const authHeader = computeAuthHeader(opts, parsed);
		return {
			protocol: proto,
			hostname: parsed.hostname,
			port: parsed.port || (proto === 'https:' ? 443 : 80),
			rejectUnauthorized: opts.rejectUnauthorized,
			authHeader,
		};
	}
	// UDS path resolution mirrors bin/cliOperations.ts:150.
	const { getConfigPath } = require('../../config/configUtils');
	const terms = require('../../utility/hdbTerms');
	const socketPath = getConfigPath(terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET);
	return {
		protocol: 'http:',
		socketPath,
		rejectUnauthorized: true,
		authHeader: undefined,
	};
}

function computeAuthHeader(opts: McpCliOptions, parsed: URL): string | undefined {
	if (opts.bearer) return `Bearer ${opts.bearer}`;
	const u = opts.username ?? parsed.username;
	const p = opts.password ?? parsed.password;
	if (u) return `Basic ${Buffer.from(`${u}:${p ?? ''}`).toString('base64')}`;
	return undefined;
}

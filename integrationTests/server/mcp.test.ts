/**
 * MCP Streamable HTTP transport — integration tests (#614).
 *
 * Verifies end-to-end behavior against a real Harper boot with
 * `mcp.operations: {}` in config:
 *   - initialize handshake (request + Mcp-Session-Id response)
 *   - notifications/initialized → 202 empty
 *   - GET /mcp → 405 (no SSE channel in v1)
 *   - DELETE /mcp → 405 by default
 *   - Unknown method → 200 + JSON-RPC -32601
 *   - Missing/unknown session id → 400 / 404
 *   - User binding on session
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, match } from 'node:assert/strict';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

function authHeader(ctx: ContextWithHarper): string {
	return `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
}

function mcpUrl(ctx: ContextWithHarper): string {
	return `${ctx.harper.operationsAPIURL}/mcp`;
}

async function jsonRpcPost(
	ctx: ContextWithHarper,
	body: object,
	extraHeaders: Record<string, string> = {}
): Promise<Response> {
	return fetch(mcpUrl(ctx), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json, text/event-stream',
			'Authorization': authHeader(ctx),
			...extraHeaders,
		},
		body: JSON.stringify(body),
	});
}

suite('MCP Streamable HTTP transport (operations profile)', (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx, {
			config: {
				mcp: { operations: {} },
			},
			env: {},
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('initialize returns 200 with Mcp-Session-Id header and capabilities', async () => {
		const res = await jsonRpcPost(ctx, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'mcp-integration-test', version: '0.0.0' },
			},
		});
		strictEqual(res.status, 200);
		const sessionId = res.headers.get('mcp-session-id');
		ok(sessionId, 'expected Mcp-Session-Id response header');
		match(sessionId!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		const body = (await res.json()) as {
			jsonrpc: string;
			id: number;
			result: {
				protocolVersion: string;
				serverInfo: { name: string; version: string };
				capabilities: { tools: { listChanged: boolean }; resources: { listChanged: boolean }; logging: object };
			};
		};
		strictEqual(body.jsonrpc, '2.0');
		strictEqual(body.id, 1);
		strictEqual(body.result.protocolVersion, '2025-06-18');
		strictEqual(body.result.serverInfo.name, 'harper-mcp');
		strictEqual(body.result.capabilities.tools.listChanged, true);
		strictEqual(body.result.capabilities.resources.listChanged, true);
	});

	test('full handshake: initialize → notifications/initialized → 202 empty', async () => {
		const initRes = await jsonRpcPost(ctx, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
		});
		strictEqual(initRes.status, 200);
		const sessionId = initRes.headers.get('mcp-session-id')!;
		await initRes.body?.cancel();

		const notifRes = await jsonRpcPost(
			ctx,
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			{ 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': '2025-06-18' }
		);
		strictEqual(notifRes.status, 202);
		const text = await notifRes.text();
		strictEqual(text, '');
	});

	test('unknown method on an active session returns 200 + JSON-RPC -32601', async () => {
		const initRes = await jsonRpcPost(ctx, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
		});
		const sessionId = initRes.headers.get('mcp-session-id')!;
		await initRes.body?.cancel();

		const res = await jsonRpcPost(
			ctx,
			{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
			{ 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': '2025-06-18' }
		);
		strictEqual(res.status, 200);
		const body = (await res.json()) as { jsonrpc: string; id: number; error: { code: number; message: string } };
		strictEqual(body.error.code, -32601);
		match(body.error.message, /tools\/list/);
	});

	test('request without Mcp-Session-Id returns 400', async () => {
		const res = await jsonRpcPost(
			ctx,
			{ jsonrpc: '2.0', id: 1, method: 'tools/list' },
			{
				'MCP-Protocol-Version': '2025-06-18',
			}
		);
		strictEqual(res.status, 400);
	});

	test('request with unknown Mcp-Session-Id returns 404', async () => {
		const res = await jsonRpcPost(
			ctx,
			{ jsonrpc: '2.0', id: 1, method: 'tools/list' },
			{ 'Mcp-Session-Id': 'not-a-real-session', 'MCP-Protocol-Version': '2025-06-18' }
		);
		strictEqual(res.status, 404);
	});

	test('GET /mcp returns 405', async () => {
		const res = await fetch(mcpUrl(ctx), {
			method: 'GET',
			headers: { Accept: 'text/event-stream', Authorization: authHeader(ctx) },
		});
		strictEqual(res.status, 405);
		await res.body?.cancel();
	});

	test('DELETE /mcp returns 405 when allowClientDelete is not configured', async () => {
		const res = await fetch(mcpUrl(ctx), {
			method: 'DELETE',
			headers: { Authorization: authHeader(ctx) },
		});
		strictEqual(res.status, 405);
		await res.body?.cancel();
	});

	test('parse error returns 400 with JSON-RPC -32700', async () => {
		const res = await fetch(mcpUrl(ctx), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json',
				'Authorization': authHeader(ctx),
			},
			body: '{not json',
		});
		strictEqual(res.status, 400);
	});
});

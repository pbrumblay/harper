const assert = require('node:assert/strict');
const rewire = require('rewire');
const transport_mod = rewire('#src/components/mcp/transport');
const { handleMcpRequest } = transport_mod;
const { _setSessionTableForTest, createSession, loadSession } = require('#src/components/mcp/session');

function makeFakeTable() {
	const store = new Map();
	return {
		store,
		async put(record) {
			store.set(record.id, { ...record });
		},
		async get(id) {
			const r = store.get(id);
			return r ? { ...r } : undefined;
		},
		async delete(id) {
			store.delete(id);
		},
	};
}

function makeReq(overrides = {}) {
	return {
		method: 'POST',
		headers: {},
		body: '{}',
		user: 'alice',
		profile: 'application',
		...overrides,
	};
}

function jsonRpc(id, method, params) {
	const msg = { jsonrpc: '2.0', method };
	if (id !== undefined) msg.id = id;
	if (params !== undefined) msg.params = params;
	return JSON.stringify(msg);
}

describe('mcp/transport', () => {
	let envOverrides;
	const envStub = {
		get(key) {
			return envOverrides[key];
		},
	};

	beforeEach(() => {
		envOverrides = {};
		transport_mod.__set__('env', envStub);
		_setSessionTableForTest(makeFakeTable());
	});

	afterEach(() => {
		_setSessionTableForTest(undefined);
	});

	describe('POST initialize', () => {
		it('creates a session and returns 200 + Mcp-Session-Id', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
				})
			);
			assert.equal(res.status, 200);
			assert.match(res.headers['Mcp-Session-Id'], /^[0-9a-f-]{36}$/);
			assert.equal(res.jsonBody.id, 1);
			assert.equal(res.jsonBody.result.protocolVersion, '2025-06-18');
			assert.equal(res.jsonBody.result.serverInfo.name, 'harper-mcp');
			assert.equal(res.jsonBody.result.capabilities.tools.listChanged, true);
		});

		it('rejects unsupported protocolVersion with 400 and the supported list', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '1999-01-01' }),
				})
			);
			assert.equal(res.status, 400);
			assert.equal(res.jsonBody.error.code, -32602);
			assert.deepEqual([...res.jsonBody.error.data.supportedVersions], ['2025-06-18', '2025-03-26']);
		});

		it('rejects missing protocolVersion with 400', async () => {
			const res = await handleMcpRequest(makeReq({ body: jsonRpc(1, 'initialize') }));
			assert.equal(res.status, 400);
		});
	});

	describe('POST after initialize', () => {
		let sessionId;
		beforeEach(async () => {
			const res = await handleMcpRequest(
				makeReq({ body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }) })
			);
			sessionId = res.headers['Mcp-Session-Id'];
		});

		it('returns 400 when Mcp-Session-Id header is missing', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(2, 'tools/list'),
					headers: { 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 400);
			assert.equal(res.jsonBody.error.code, -32600);
		});

		it('returns 404 when Mcp-Session-Id is unknown', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(2, 'tools/list'),
					headers: { 'mcp-session-id': 'not-a-session', 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 404);
		});

		it('returns 403 when session belongs to a different user', async () => {
			const res = await handleMcpRequest(
				makeReq({
					user: 'mallory',
					body: jsonRpc(2, 'tools/list'),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 403);
		});

		it('returns 400 when MCP-Protocol-Version is unsupported', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(2, 'tools/list'),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '1999-01-01' },
				})
			);
			assert.equal(res.status, 400);
		});

		it('returns 400 when MCP-Protocol-Version mismatches the session version', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(2, 'tools/list'),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-03-26' },
				})
			);
			assert.equal(res.status, 400);
			assert.match(res.jsonBody.error.message, /mismatch/);
		});

		it('treats missing MCP-Protocol-Version as 2025-03-26 (spec compatibility rule)', async () => {
			// Session is on 2025-06-18 from initialize above, so missing header
			// (treated as 2025-03-26) should mismatch.
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(2, 'tools/list'),
					headers: { 'mcp-session-id': sessionId },
				})
			);
			assert.equal(res.status, 400);
		});

		it('accepts a matching MCP-Protocol-Version and returns Method-not-found for unknown methods', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(2, 'tools/list'),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 200);
			assert.equal(res.jsonBody.error.code, -32601);
			assert.match(res.jsonBody.error.message, /tools\/list/);
		});

		it('returns 202 on notifications/initialized and flips session.initialized', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(undefined, 'notifications/initialized'),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 202);
			const session = await loadSession(sessionId);
			assert.equal(session.initialized, true);
		});

		it('returns 202 on any client notification', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(undefined, 'notifications/cancelled'),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 202);
		});

		it('returns 202 on a client response frame (result envelope)', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: JSON.stringify({ jsonrpc: '2.0', id: 99, result: 'ok' }),
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 202);
		});

		it('returns 400 PARSE_ERROR on invalid JSON', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: '{not json',
					headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
				})
			);
			assert.equal(res.status, 400);
			assert.equal(res.jsonBody.error.code, -32700);
		});
	});

	describe('GET /mcp', () => {
		it('always returns 405 in v1 (no server-push channel yet)', async () => {
			const res = await handleMcpRequest(makeReq({ method: 'GET' }));
			assert.equal(res.status, 405);
		});

		it('Allow header lists only POST when DELETE is disabled (RFC 9110 §9.1)', async () => {
			const res = await handleMcpRequest(makeReq({ method: 'GET' }));
			assert.equal(res.headers.Allow, 'POST');
		});

		it('Allow header lists POST + DELETE when DELETE is enabled', async () => {
			envOverrides.mcp_session_allowClientDelete = true;
			const res = await handleMcpRequest(makeReq({ method: 'GET' }));
			assert.equal(res.headers.Allow, 'POST, DELETE');
		});
	});

	describe('DELETE /mcp', () => {
		it('returns 405 when allowClientDelete is not configured', async () => {
			const res = await handleMcpRequest(makeReq({ method: 'DELETE' }));
			assert.equal(res.status, 405);
			assert.equal(res.headers.Allow, 'POST');
		});

		it('terminates the session and returns 204 when allowClientDelete is true', async () => {
			envOverrides.mcp_session_allowClientDelete = true;
			const session = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
			const res = await handleMcpRequest(makeReq({ method: 'DELETE', headers: { 'mcp-session-id': session.id } }));
			assert.equal(res.status, 204);
			assert.equal(await loadSession(session.id), null);
		});

		it('returns 400 when allowClientDelete is true but session-id is missing', async () => {
			envOverrides.mcp_session_allowClientDelete = true;
			const res = await handleMcpRequest(makeReq({ method: 'DELETE' }));
			assert.equal(res.status, 400);
		});

		it('returns 404 when session-id is unknown', async () => {
			envOverrides.mcp_session_allowClientDelete = true;
			const res = await handleMcpRequest(makeReq({ method: 'DELETE', headers: { 'mcp-session-id': 'nope' } }));
			assert.equal(res.status, 404);
		});

		it('returns 403 when session belongs to a different user', async () => {
			envOverrides.mcp_session_allowClientDelete = true;
			const session = await createSession({ user: 'alice', protocolVersion: '2025-06-18' });
			const res = await handleMcpRequest(
				makeReq({ method: 'DELETE', user: 'mallory', headers: { 'mcp-session-id': session.id } })
			);
			assert.equal(res.status, 403);
		});
	});

	describe('Origin validation', () => {
		it('accepts any Origin when allow-list is empty/unset', async () => {
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
					headers: { origin: 'https://anywhere.example.com' },
				})
			);
			assert.equal(res.status, 200);
		});

		it('accepts when Origin is missing (curl, server-to-server)', async () => {
			envOverrides.http_corsAccessList = ['https://app.example.com'];
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
				})
			);
			assert.equal(res.status, 200);
		});

		it('accepts any Origin when CORS is enabled but allow-list is empty', async () => {
			envOverrides.http_cors = true;
			envOverrides.http_corsAccessList = [];
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
					headers: { origin: 'https://anywhere.example.com' },
				})
			);
			assert.equal(res.status, 200);
		});

		it('accepts any Origin when CORS is disabled even if allow-list is set', async () => {
			envOverrides.http_cors = false;
			envOverrides.http_corsAccessList = ['https://only-me.example.com'];
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
					headers: { origin: 'https://evil.example.com' },
				})
			);
			assert.equal(res.status, 200);
		});

		it('returns 403 when CORS is enabled and Origin is not in the allow-list', async () => {
			envOverrides.http_cors = true;
			envOverrides.http_corsAccessList = ['https://app.example.com'];
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
					headers: { origin: 'https://evil.example.com' },
				})
			);
			assert.equal(res.status, 403);
		});

		it('uses the operations CORS list for the operations profile', async () => {
			envOverrides.operationsApi_network_cors = true;
			envOverrides.operationsApi_network_corsAccessList = ['https://ops.example.com'];
			const res = await handleMcpRequest(
				makeReq({
					profile: 'operations',
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
					headers: { origin: 'https://app.example.com' }, // app list, not ops
				})
			);
			assert.equal(res.status, 403);
		});

		it('accepts Origin in the allow-list', async () => {
			envOverrides.http_cors = true;
			envOverrides.http_corsAccessList = ['https://app.example.com'];
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
					headers: { origin: 'https://app.example.com' },
				})
			);
			assert.equal(res.status, 200);
		});

		it('honors the "*" wildcard in the allow-list', async () => {
			envOverrides.http_cors = true;
			envOverrides.http_corsAccessList = ['*'];
			const res = await handleMcpRequest(
				makeReq({
					body: jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
					headers: { origin: 'https://anywhere.example.com' },
				})
			);
			assert.equal(res.status, 200);
		});
	});

	describe('unsupported HTTP methods', () => {
		it('returns 405 for PUT with accurate Allow header', async () => {
			const res = await handleMcpRequest(makeReq({ method: 'PUT' }));
			assert.equal(res.status, 405);
			assert.equal(res.headers.Allow, 'POST');
		});

		it('PUT 405 advertises DELETE when allowClientDelete is enabled', async () => {
			envOverrides.mcp_session_allowClientDelete = true;
			const res = await handleMcpRequest(makeReq({ method: 'PUT' }));
			assert.equal(res.status, 405);
			assert.equal(res.headers.Allow, 'POST, DELETE');
		});
	});
});

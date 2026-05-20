const assert = require('node:assert/strict');
const { registerMcpProfile, createStubHandler } = require('#src/components/mcp/index');

function makeFakeFastify() {
	const calls = [];
	return {
		calls,
		post(path, optsOrHandler, maybeHandler) {
			if (typeof optsOrHandler === 'function') {
				calls.push({ path, options: undefined, handler: optsOrHandler });
			} else {
				calls.push({ path, options: optsOrHandler, handler: maybeHandler });
			}
		},
	};
}

function makeFakeReply() {
	const reply = {
		statusCode: undefined,
		headers: {},
		body: undefined,
		code(status) {
			this.statusCode = status;
			return this;
		},
		header(name, value) {
			this.headers[name] = value;
			return this;
		},
		send(payload) {
			this.body = payload;
			return this;
		},
	};
	return reply;
}

describe('components/mcp/index', () => {
	describe('registerMcpProfile', () => {
		it('does nothing when the profile is disabled', () => {
			const host = makeFakeFastify();
			registerMcpProfile({
				profile: 'operations',
				host,
				config: { mcp: { operations: { enabled: false } } },
			});
			assert.equal(host.calls.length, 0);
		});

		it('does nothing when the mcp config block is absent', () => {
			const host = makeFakeFastify();
			registerMcpProfile({ profile: 'operations', host, config: {} });
			assert.equal(host.calls.length, 0);
		});

		it('registers POST /mcp when operations profile is enabled with defaults', () => {
			const host = makeFakeFastify();
			registerMcpProfile({
				profile: 'operations',
				host,
				config: { mcp: { operations: { enabled: true } } },
			});
			assert.equal(host.calls.length, 1);
			assert.equal(host.calls[0].path, '/mcp');
			assert.equal(typeof host.calls[0].handler, 'function');
		});

		it('honors a custom mountPath', () => {
			const host = makeFakeFastify();
			registerMcpProfile({
				profile: 'application',
				host,
				config: { mcp: { application: { enabled: true, mountPath: '/agent' } } },
			});
			assert.equal(host.calls.length, 1);
			assert.equal(host.calls[0].path, '/agent');
		});

		it('forwards routeOptions to the host as the second argument', () => {
			const host = makeFakeFastify();
			const sentinel = { preValidation: ['fake-auth-handler'] };
			registerMcpProfile({
				profile: 'operations',
				host,
				config: { mcp: { operations: { enabled: true } } },
				routeOptions: sentinel,
			});
			assert.equal(host.calls.length, 1);
			assert.deepEqual(host.calls[0].options, sentinel);
			assert.equal(typeof host.calls[0].handler, 'function');
		});

		it('treats only strict-boolean enabled:true as enabled (no string truthiness)', () => {
			// Regression: env-sourced configs can deliver the literal string 'false',
			// which is truthy in JS. The caller is responsible for coercing — this test
			// just pins the component contract that `enabled` is read as-is.
			const host = makeFakeFastify();
			registerMcpProfile({
				profile: 'operations',
				host,
				config: { mcp: { operations: { enabled: 0 } } },
			});
			assert.equal(host.calls.length, 0);
		});
	});

	describe('stub handler', () => {
		it('returns 503 with mcp_not_implemented body for the operations profile', async () => {
			const handler = createStubHandler('operations');
			const reply = makeFakeReply();
			await handler({}, reply);
			assert.equal(reply.statusCode, 503);
			assert.equal(reply.headers['Retry-After'], '0');
			assert.equal(reply.headers['Content-Type'], 'application/json');
			assert.deepEqual(reply.body, { error: 'mcp_not_implemented', profile: 'operations' });
		});

		it('returns 503 with mcp_not_implemented body for the application profile', async () => {
			const handler = createStubHandler('application');
			const reply = makeFakeReply();
			await handler({}, reply);
			assert.equal(reply.statusCode, 503);
			assert.deepEqual(reply.body, { error: 'mcp_not_implemented', profile: 'application' });
		});
	});
});

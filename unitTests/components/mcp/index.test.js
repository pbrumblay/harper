const assert = require('node:assert/strict');
const indexMod = require('#src/components/mcp/index');
const {
	registerMcpProfile,
	handleApplication,
	_resetApplicationStartedForTest,
	_setGetConfigObjForTest,
	_restoreGetConfigObj,
} = indexMod;
const { _setSessionTableForTest } = require('#src/components/mcp/session');

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

function makeFakeScope() {
	const calls = [];
	return {
		calls,
		server: {
			http(handler, options) {
				calls.push({ handler, options });
			},
		},
	};
}

function makeFakeTable() {
	return {
		async put() {},
		async get() {
			return undefined;
		},
		async delete() {},
	};
}

describe('components/mcp/index', () => {
	beforeEach(() => _setSessionTableForTest(makeFakeTable()));
	afterEach(() => {
		_setSessionTableForTest(undefined);
		_resetApplicationStartedForTest();
	});

	describe('registerMcpProfile (operations side, Fastify)', () => {
		it('does nothing when the mcp config block is absent', () => {
			const host = makeFakeFastify();
			registerMcpProfile({ profile: 'operations', host, config: {} });
			assert.equal(host.calls.length, 0);
		});

		it('does nothing when the profile sub-block is absent under mcp', () => {
			const host = makeFakeFastify();
			registerMcpProfile({
				profile: 'operations',
				host,
				config: { mcp: { application: { mountPath: '/x' } } },
			});
			assert.equal(host.calls.length, 0);
		});

		it('registers POST /mcp when the operations profile block is present', () => {
			const host = makeFakeFastify();
			registerMcpProfile({ profile: 'operations', host, config: { mcp: { operations: {} } } });
			assert.equal(host.calls.length, 1);
			assert.equal(host.calls[0].path, '/mcp');
			assert.equal(typeof host.calls[0].handler, 'function');
		});

		it('honors a custom mountPath', () => {
			const host = makeFakeFastify();
			registerMcpProfile({
				profile: 'operations',
				host,
				config: { mcp: { operations: { mountPath: '/agent' } } },
			});
			assert.equal(host.calls[0].path, '/agent');
		});

		it('forwards routeOptions to the host as the second argument', () => {
			const host = makeFakeFastify();
			const sentinel = { preValidation: ['fake-auth-handler'] };
			registerMcpProfile({
				profile: 'operations',
				host,
				config: { mcp: { operations: {} } },
				routeOptions: sentinel,
			});
			assert.deepEqual(host.calls[0].options, sentinel);
		});
	});

	describe('handleApplication (application side, Harper-HTTP)', () => {
		let configReturn;
		beforeEach(() => {
			_setGetConfigObjForTest(() => configReturn);
		});
		afterEach(() => {
			_restoreGetConfigObj();
		});

		it('does nothing when the mcp.application sub-block is absent', () => {
			configReturn = { mcp: { operations: {} } };
			const scope = makeFakeScope();
			handleApplication(scope);
			assert.equal(scope.calls.length, 0);
		});

		it('registers via scope.server.http when mcp.application is present', () => {
			configReturn = { mcp: { application: {} } };
			const scope = makeFakeScope();
			handleApplication(scope);
			assert.equal(scope.calls.length, 1);
			assert.equal(scope.calls[0].options.urlPath, '/mcp');
			assert.equal(scope.calls[0].options.after, 'authentication');
			assert.equal(typeof scope.calls[0].handler, 'function');
		});

		it('honors a custom mountPath', () => {
			configReturn = { mcp: { application: { mountPath: '/agent' } } };
			const scope = makeFakeScope();
			handleApplication(scope);
			assert.equal(scope.calls[0].options.urlPath, '/agent');
		});

		it('is idempotent on repeated invocations', () => {
			configReturn = { mcp: { application: {} } };
			const scopeA = makeFakeScope();
			const scopeB = makeFakeScope();
			handleApplication(scopeA);
			handleApplication(scopeB);
			assert.equal(scopeA.calls.length, 1);
			assert.equal(scopeB.calls.length, 0);
		});

		it('does nothing when getConfigObj returns undefined', () => {
			configReturn = undefined;
			const scope = makeFakeScope();
			handleApplication(scope);
			assert.equal(scope.calls.length, 0);
		});
	});
});

const assert = require('node:assert/strict');
const {
	tryAdmit,
	clearSessionRateState,
	configFor,
	_setClockForTest,
	_resetForTest,
} = require('#src/components/mcp/rateLimit');
const env = require('#src/utility/environment/environmentManager');

describe('mcp/rateLimit', () => {
	let envOverrides;
	const originalEnvGet = env.get;
	let clock = 0;

	beforeEach(() => {
		_resetForTest();
		envOverrides = {};
		clock = 0;
		_setClockForTest(() => clock);
		env.get = (key) => (key in envOverrides ? envOverrides[key] : originalEnvGet.call(env, key));
	});

	afterEach(() => {
		_resetForTest();
		_setClockForTest(undefined);
		env.get = originalEnvGet;
	});

	describe('configFor', () => {
		it('returns the documented defaults for each profile when nothing is configured', () => {
			const ops = configFor('operations');
			assert.deepEqual(ops, { perToolPerSecond: 10, perToolBurst: 20, sessionConcurrency: 25, sessionPerSecond: 100 });
			const app = configFor('application');
			assert.deepEqual(app, { perToolPerSecond: 25, perToolBurst: 50, sessionConcurrency: 50, sessionPerSecond: 200 });
		});

		it('overrides defaults from configured values', () => {
			envOverrides.mcp_operations_rateLimit_perToolPerSecond = 5;
			envOverrides.mcp_operations_rateLimit_perToolBurst = 7;
			const cfg = configFor('operations');
			assert.equal(cfg.perToolPerSecond, 5);
			assert.equal(cfg.perToolBurst, 7);
		});
	});

	describe('tryAdmit', () => {
		it('admits up to perToolBurst calls before throttling', () => {
			envOverrides.mcp_application_rateLimit_perToolBurst = 3;
			envOverrides.mcp_application_rateLimit_perToolPerSecond = 0.001; // effectively no refill
			const releases = [];
			for (let i = 0; i < 3; i++) {
				const d = tryAdmit('s1', 'tool_x', 'application');
				assert.equal(d.allowed, true, `call ${i + 1} should be admitted`);
				releases.push(d.release);
			}
			releases.forEach((r) => r());
			const denied = tryAdmit('s1', 'tool_x', 'application');
			assert.equal(denied.allowed, false);
			assert.equal(denied.reason, 'per_tool');
		});

		it('refills the per-tool bucket over time', () => {
			envOverrides.mcp_application_rateLimit_perToolBurst = 1;
			envOverrides.mcp_application_rateLimit_perToolPerSecond = 1; // 1 token per second
			const r1 = tryAdmit('s1', 'tool_x', 'application');
			assert.equal(r1.allowed, true);
			r1.release();
			const r2 = tryAdmit('s1', 'tool_x', 'application');
			assert.equal(r2.allowed, false, 'bucket drained');
			clock += 1100; // 1.1 seconds
			const r3 = tryAdmit('s1', 'tool_x', 'application');
			assert.equal(r3.allowed, true, 'bucket refilled after 1+ second');
		});

		it('caps in-flight calls at sessionConcurrency', () => {
			envOverrides.mcp_application_rateLimit_sessionConcurrency = 2;
			envOverrides.mcp_application_rateLimit_perToolBurst = 100;
			envOverrides.mcp_application_rateLimit_sessionPerSecond = 100;
			const r1 = tryAdmit('s1', 't', 'application');
			const r2 = tryAdmit('s1', 't', 'application');
			const r3 = tryAdmit('s1', 't', 'application');
			assert.equal(r1.allowed, true);
			assert.equal(r2.allowed, true);
			assert.equal(r3.allowed, false);
			assert.equal(r3.reason, 'concurrency');
			r1.release();
			const r4 = tryAdmit('s1', 't', 'application');
			assert.equal(r4.allowed, true, 'release frees concurrency slot');
		});

		it('rejects on session_rate when sessionPerSecond is exhausted', () => {
			envOverrides.mcp_application_rateLimit_sessionPerSecond = 2;
			envOverrides.mcp_application_rateLimit_perToolBurst = 100;
			envOverrides.mcp_application_rateLimit_sessionConcurrency = 100;
			const r1 = tryAdmit('s1', 'a', 'application');
			const r2 = tryAdmit('s1', 'b', 'application');
			const r3 = tryAdmit('s1', 'c', 'application');
			r1.release();
			r2.release();
			assert.equal(r1.allowed, true);
			assert.equal(r2.allowed, true);
			assert.equal(r3.allowed, false);
			assert.equal(r3.reason, 'session_rate');
		});

		it('treats different sessions as independent', () => {
			envOverrides.mcp_application_rateLimit_perToolBurst = 1;
			envOverrides.mcp_application_rateLimit_perToolPerSecond = 0.001;
			const r1 = tryAdmit('s1', 'x', 'application');
			r1.release();
			const r2 = tryAdmit('s2', 'x', 'application');
			r2.release();
			assert.equal(r1.allowed, true);
			assert.equal(r2.allowed, true);
		});

		it('treats different tools as independent', () => {
			envOverrides.mcp_application_rateLimit_perToolBurst = 1;
			envOverrides.mcp_application_rateLimit_perToolPerSecond = 0.001;
			envOverrides.mcp_application_rateLimit_sessionPerSecond = 100;
			const a = tryAdmit('s1', 'tool_a', 'application');
			const b = tryAdmit('s1', 'tool_b', 'application');
			a.release();
			b.release();
			assert.equal(a.allowed, true);
			assert.equal(b.allowed, true, 'tool_b has its own bucket');
		});
	});

	describe('clearSessionRateState', () => {
		it('drops per-session state so re-creation starts fresh', () => {
			envOverrides.mcp_application_rateLimit_perToolBurst = 1;
			envOverrides.mcp_application_rateLimit_perToolPerSecond = 0.001;
			const r1 = tryAdmit('s1', 't', 'application');
			r1.release();
			const r2 = tryAdmit('s1', 't', 'application');
			assert.equal(r2.allowed, false);
			clearSessionRateState('s1');
			const r3 = tryAdmit('s1', 't', 'application');
			assert.equal(r3.allowed, true, 'fresh bucket after clear');
		});
	});
});

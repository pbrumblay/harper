/**
 * Custom jsResource integration tests.
 *
 * Validates custom resource patterns observed in production:
 * - Async write-then-patch (CDI RT: enqueue + AI-inference result attachment)
 * - Routing-decision endpoint with time-window filtering (Walmart USGM)
 * - Immutable audit log (RedirectChange blocks external mutations)
 * - Chain-redirect detection (409 on A→B when B→C would chain)
 * - Abuse-counter threshold (Ford PasswordResetAbuse: 403 after N attempts)
 *
 * Self-contained: deploys an inline component with schema + resources JS and
 * restarts http_workers. Skipped on Windows (restart_service http_workers
 * crashes the Harper instance on Windows — see HarperFast/harper#549).
 *
 * Implements HarperFast/harper#1190.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';
import { installAppComponent } from './utils/components.mjs';

// ---------------------------------------------------------------------------
// Component definition
// ---------------------------------------------------------------------------

const SCHEMA_GRAPHQL = `
type WorkItem @table @export {
  id: ID @primaryKey
  state: String @indexed
  payload: String
  result: String
  resultAt: Date @updatedTime
}

type RedirectRule @table @export @sealed {
  id: ID @primaryKey
  matchUrl: String @indexed
  redirectUrl: String @indexed
  statusCode: Int
  startTime: Date
  endTime: Date
  createdBy: String
}

type RedirectChange @table @export {
  id: ID @primaryKey
  redirectId: String @indexed
  operation: String
  previousState: String
  createdAt: Date @createdTime
}

type AbusCounter @table(expiration: 10) @export {
  id: ID @primaryKey
  count: Int
}
`;

const RESOURCES_JS = `
// WorkItem: async write-then-patch pattern (CDI RT enqueueing + AI inference result attachment)
export class WorkItem extends tables.WorkItem {
  async post(body, ctx) {
    const id = Math.random().toString(36).slice(2);
    // Use static class method to create a new record by explicit id
    await tables.WorkItem.put({ id, state: 'pending', payload: JSON.stringify(body) });
    return { id, state: 'pending' };
  }
  async patch(body, ctx) {
    // this is the loaded record instance; doesExist() tells us if it was found
    if (!this.doesExist()) return new Response(null, { status: 404 });
    const current = await this.get();
    // Full update via single-arg super.put (legacy: update(record, true) + save)
    await super.put({ ...current, state: 'completed', result: body.result, resultAt: new Date() });
    return { state: 'completed' };
  }
}

// RedirectRule: routing decision with audit trail (Walmart USGM pattern)
export class RedirectRule extends tables.RedirectRule {
  async post(body, ctx) {
    // chain detection: check if redirectUrl matches any existing matchUrl
    const existing = [];
    for await (const r of tables.RedirectRule.search({ conditions: [{ attribute: 'matchUrl', value: body.redirectUrl }] })) {
      existing.push(r);
    }
    if (existing.length > 0) {
      const context = this.getContext();
      context.response.status = 409;
      return { error: 'Chain redirect detected' };
    }
    const id = Math.random().toString(36).slice(2);
    const user = this.getContext()?.user;
    const record = { id, ...body, createdBy: user?.username || 'anonymous' };
    // Write the redirect rule and audit record using static methods
    await tables.RedirectRule.put(record);
    await tables.RedirectChange.put({
      id: Math.random().toString(36).slice(2),
      redirectId: id,
      operation: 'create',
      previousState: null,
    });
    return record;
  }
}

// Block external mutations on RedirectChange (audit log is immutable from outside)
export class RedirectChange extends tables.RedirectChange {
  post() { return new Response(null, { status: 405 }); }
  put() { return new Response(null, { status: 405 }); }
  patch() { return new Response(null, { status: 405 }); }
  delete() { return new Response(null, { status: 405 }); }
}

// RoutingDecision: POST-only routing lookup endpoint (Walmart USGM)
export class RoutingDecision extends Resource {
  static loadAsInstance = false;
  async post(query, body) {
    const { path } = body;
    if (!path) return {};
    const now = new Date();
    const rules = [];
    for await (const r of tables.RedirectRule.search({ conditions: [{ attribute: 'matchUrl', value: path }] })) {
      rules.push(r);
    }
    const rule = rules.find(r => {
      if (r.startTime && new Date(r.startTime) > now) return false;
      if (r.endTime && new Date(r.endTime) < now) return false;
      return true;
    });
    if (rule) return { shouldRedirect: true, status: rule.statusCode || 302, location: rule.redirectUrl };
    return {};
  }
}

// AbusCounter: atomic counter with 403 threshold (Ford PasswordResetAbuse pattern)
export class AbusCounter extends tables.AbusCounter {
  async put(body, ctx) {
    // this is the loaded record instance; get current count from the stored record
    const current = await this.get();
    const id = this.getId();
    const newCount = ((current && current.count) || 0) + 1;
    if (newCount > 5) {
      const context = this.getContext();
      context.response.status = 403;
      return { error: 'Too many attempts' };
    }
    // Full update via single-arg super.put (legacy: update(record, true) + save)
    await super.put({ id, count: newCount });
    return { count: newCount };
  }
}
`;

const CONFIG_YAML = `graphqlSchema:
  files: '*.graphql'
jsResource:
  files: resources.js
rest: true
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const skipSuite = process.platform === 'win32';

/** Issue a REST request against the running Harper instance. */
function restReq(httpURL: string, path: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
	const opts: RequestInit = {
		method,
		headers: { 'Content-Type': 'application/json', ...headers },
	};
	if (body !== undefined) opts.body = JSON.stringify(body);
	return fetch(`${httpURL}${path}`, opts);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('Custom resource patterns', { skip: skipSuite }, (ctx) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;

		await installAppComponent(client, {
			project: 'customResources',
			files: {
				'schema.graphql': SCHEMA_GRAPHQL,
				'resources.js': RESOURCES_JS,
				'config.yaml': CONFIG_YAML,
			},
			probePath: '/WorkItem/',
			restartTimeoutMs: 120_000,
		});
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// -----------------------------------------------------------------------
	// 1. Async write-then-patch (CDI RT pattern)
	// -----------------------------------------------------------------------

	suite('WorkItem: async write-then-patch', () => {
		let workItemId: string;

		test('POST WorkItem enqueues with pending state', async () => {
			const res = await restReq(httpURL, '/WorkItem/', 'POST', { task: 'infer', input: 'hello' });
			strictEqual(res.status, 200, `unexpected status: ${res.status}`);
			const body = (await res.json()) as Record<string, unknown>;
			ok(typeof body.id === 'string' && body.id.length > 0, `expected id string, got: ${JSON.stringify(body)}`);
			strictEqual(body.state, 'pending', `expected pending state, got: ${JSON.stringify(body)}`);
			workItemId = body.id as string;
		});

		test('PATCH WorkItem/:id attaches result and moves to completed', async () => {
			const res = await restReq(httpURL, `/WorkItem/${workItemId}`, 'PATCH', { result: 'positive' });
			strictEqual(res.status, 200, `unexpected status: ${res.status}`);
			const body = (await res.json()) as Record<string, unknown>;
			strictEqual(body.state, 'completed', `expected completed state, got: ${JSON.stringify(body)}`);
		});

		test('GET WorkItem/:id returns completed record with result', async () => {
			const res = await restReq(httpURL, `/WorkItem/${workItemId}`, 'GET');
			strictEqual(res.status, 200, `unexpected status: ${res.status}`);
			const body = (await res.json()) as Record<string, unknown>;
			strictEqual(body.state, 'completed', `expected completed state, got: ${JSON.stringify(body)}`);
			strictEqual(body.result, 'positive', `expected result, got: ${JSON.stringify(body)}`);
		});

		test('PATCH nonexistent WorkItem returns 404', async () => {
			const res = await restReq(httpURL, '/WorkItem/does-not-exist-xyz', 'PATCH', { result: 'nope' });
			strictEqual(res.status, 404, `expected 404, got: ${res.status}`);
		});
	});

	// -----------------------------------------------------------------------
	// 2. Routing decision — basic lookup (Walmart USGM pattern)
	// -----------------------------------------------------------------------

	suite('RoutingDecision: POST routing lookup', () => {
		test('POST /RoutingDecision with unknown path returns empty object', async () => {
			const res = await restReq(httpURL, '/RoutingDecision/', 'POST', { path: '/no-such-path' });
			strictEqual(res.status, 200, `unexpected status: ${res.status}`);
			const body = await res.json();
			deepStrictEqual(body, {}, `expected empty routing result, got: ${JSON.stringify(body)}`);
		});

		test('POST /RoutingDecision with missing path returns empty object', async () => {
			const res = await restReq(httpURL, '/RoutingDecision/', 'POST', {});
			strictEqual(res.status, 200, `unexpected status: ${res.status}`);
			const body = await res.json();
			deepStrictEqual(body, {}, `expected empty routing result, got: ${JSON.stringify(body)}`);
		});

		test('POST /RoutingDecision after adding a rule returns redirect info', async () => {
			// Create a rule for /foo → /bar
			const ruleRes = await restReq(httpURL, '/RedirectRule/', 'POST', {
				matchUrl: '/foo',
				redirectUrl: '/bar',
				statusCode: 302,
			});
			strictEqual(ruleRes.status, 200, `rule creation failed: ${ruleRes.status}`);

			const res = await restReq(httpURL, '/RoutingDecision/', 'POST', { path: '/foo' });
			strictEqual(res.status, 200, `unexpected status: ${res.status}`);
			const body = (await res.json()) as Record<string, unknown>;
			strictEqual(body.shouldRedirect, true, `expected shouldRedirect, got: ${JSON.stringify(body)}`);
			strictEqual(body.status, 302, `expected status 302, got: ${JSON.stringify(body)}`);
			strictEqual(body.location, '/bar', `expected location /bar, got: ${JSON.stringify(body)}`);
		});
	});

	// -----------------------------------------------------------------------
	// 3. Time-window filtering
	// -----------------------------------------------------------------------

	suite('RoutingDecision: time-window filtering', () => {
		test('rule with future startTime is not active', async () => {
			const futureStart = new Date(Date.now() + 3_600_000).toISOString(); // 1 hour from now
			await restReq(httpURL, '/RedirectRule/', 'POST', {
				matchUrl: '/future-path',
				redirectUrl: '/future-target',
				statusCode: 301,
				startTime: futureStart,
			});

			const res = await restReq(httpURL, '/RoutingDecision/', 'POST', { path: '/future-path' });
			strictEqual(res.status, 200, `unexpected status: ${res.status}`);
			const body = await res.json();
			deepStrictEqual(body, {}, `rule with future startTime should not match, got: ${JSON.stringify(body)}`);
		});

		test('rule with past endTime is not active', async () => {
			const pastEnd = new Date(Date.now() - 3_600_000).toISOString(); // 1 hour ago
			await restReq(httpURL, '/RedirectRule/', 'POST', {
				matchUrl: '/expired-path',
				redirectUrl: '/expired-target',
				statusCode: 301,
				endTime: pastEnd,
			});

			const res = await restReq(httpURL, '/RoutingDecision/', 'POST', { path: '/expired-path' });
			strictEqual(res.status, 200, `unexpected status: ${res.status}`);
			const body = await res.json();
			deepStrictEqual(body, {}, `expired rule should not match, got: ${JSON.stringify(body)}`);
		});

		test('rule with no time constraints matches immediately', async () => {
			await restReq(httpURL, '/RedirectRule/', 'POST', {
				matchUrl: '/always-active',
				redirectUrl: '/always-target',
				statusCode: 302,
			});

			const res = await restReq(httpURL, '/RoutingDecision/', 'POST', { path: '/always-active' });
			strictEqual(res.status, 200, `unexpected status: ${res.status}`);
			const body = (await res.json()) as Record<string, unknown>;
			strictEqual(body.shouldRedirect, true, `expected shouldRedirect, got: ${JSON.stringify(body)}`);
		});
	});

	// -----------------------------------------------------------------------
	// 4. Immutable audit log
	// -----------------------------------------------------------------------

	suite('RedirectChange: immutable audit log', () => {
		test('POST /RedirectChange returns 405', async () => {
			const res = await restReq(httpURL, '/RedirectChange/', 'POST', {
				redirectId: 'manual',
				operation: 'create',
			});
			strictEqual(res.status, 405, `expected 405 on POST, got: ${res.status}`);
		});

		test('PUT /RedirectChange/:id returns 405', async () => {
			const res = await restReq(httpURL, '/RedirectChange/manual-id', 'PUT', {
				redirectId: 'manual',
				operation: 'create',
			});
			strictEqual(res.status, 405, `expected 405 on PUT, got: ${res.status}`);
		});

		test('PATCH /RedirectChange/:id returns 405', async () => {
			const res = await restReq(httpURL, '/RedirectChange/manual-id', 'PATCH', { operation: 'modified' });
			strictEqual(res.status, 405, `expected 405 on PATCH, got: ${res.status}`);
		});

		test('DELETE /RedirectChange/:id returns 405', async () => {
			const res = await restReq(httpURL, '/RedirectChange/manual-id', 'DELETE');
			strictEqual(res.status, 405, `expected 405 on DELETE, got: ${res.status}`);
		});

		test('creating a RedirectRule auto-writes an audit entry', async () => {
			// Create a rule; the resource JS writes a RedirectChange entry
			const ruleRes = await restReq(httpURL, '/RedirectRule/', 'POST', {
				matchUrl: '/audit-test',
				redirectUrl: '/audit-target',
				statusCode: 302,
			});
			strictEqual(ruleRes.status, 200, `rule creation failed: ${ruleRes.status}`);
			const rule = (await ruleRes.json()) as Record<string, unknown>;
			const ruleId = rule.id as string;

			// Poll the audit log until the entry appears (async write)
			const deadline = Date.now() + 10_000;
			let auditEntries: unknown[] = [];
			while (Date.now() < deadline) {
				const listRes = await restReq(httpURL, '/RedirectChange/', 'GET');
				if (listRes.status === 200) {
					const all = (await listRes.json()) as unknown[];
					auditEntries = (all ?? []).filter((e: unknown) => (e as Record<string, unknown>).redirectId === ruleId);
					if (auditEntries.length > 0) break;
				}
				await new Promise((resolve) => setTimeout(resolve, 200));
			}

			ok(auditEntries.length > 0, `expected audit entry for redirectId ${ruleId}, found none`);
			const entry = auditEntries[0] as Record<string, unknown>;
			strictEqual(entry.operation, 'create', `expected operation=create, got: ${JSON.stringify(entry)}`);
		});
	});

	// -----------------------------------------------------------------------
	// 5. Chain-redirect detection
	// -----------------------------------------------------------------------

	suite('RedirectRule: chain detection', () => {
		test('creating a chain redirect (A→B when B→C exists) returns 409', async () => {
			// Create rule B→C first
			const bcRes = await restReq(httpURL, '/RedirectRule/', 'POST', {
				matchUrl: '/chain-b',
				redirectUrl: '/chain-c',
				statusCode: 302,
			});
			strictEqual(bcRes.status, 200, `rule B→C creation failed: ${bcRes.status}`);

			// Attempt to create rule A→B (would chain since B is already a matchUrl)
			const abRes = await restReq(httpURL, '/RedirectRule/', 'POST', {
				matchUrl: '/chain-a',
				redirectUrl: '/chain-b',
				statusCode: 302,
			});
			strictEqual(abRes.status, 409, `expected 409 for chain redirect, got: ${abRes.status}`);
			const body = (await abRes.json()) as Record<string, unknown>;
			ok(
				typeof body.error === 'string' && body.error.toLowerCase().includes('chain'),
				`expected chain error message, got: ${JSON.stringify(body)}`
			);
		});
	});

	// -----------------------------------------------------------------------
	// 6. Abuse counter with 403 threshold (Ford PasswordResetAbuse pattern)
	// -----------------------------------------------------------------------

	suite('AbusCounter: threshold enforcement', () => {
		test('PUT AbusCounter increments count (attempts 1–5 succeed)', async () => {
			for (let i = 1; i <= 5; i++) {
				const res = await restReq(httpURL, '/AbusCounter/counter1', 'PUT', { id: 'counter1' });
				strictEqual(res.status, 200, `attempt ${i} unexpected status: ${res.status}`);
				const body = (await res.json()) as Record<string, unknown>;
				strictEqual(body.count, i, `attempt ${i} expected count=${i}, got: ${JSON.stringify(body)}`);
			}
		});

		test('6th PUT AbusCounter returns 403', async () => {
			const res = await restReq(httpURL, '/AbusCounter/counter1', 'PUT', { id: 'counter1' });
			strictEqual(res.status, 403, `expected 403 on 6th attempt, got: ${res.status}`);
			const body = (await res.json()) as Record<string, unknown>;
			ok(typeof body.error === 'string', `expected error message on 403, got: ${JSON.stringify(body)}`);
		});

		test('independent counters do not interfere', async () => {
			const res = await restReq(httpURL, '/AbusCounter/counter2', 'PUT', { id: 'counter2' });
			strictEqual(res.status, 200, `first attempt on counter2 unexpected status: ${res.status}`);
			const body = (await res.json()) as Record<string, unknown>;
			strictEqual(body.count, 1, `expected count=1 for fresh counter, got: ${JSON.stringify(body)}`);
		});
	});
});

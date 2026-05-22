/**
 * `@embed` directive integration test (#632 / Phase 5 of #510).
 *
 * Spins up a fake Ollama HTTP server inside the test, points Harper's models
 * config at it, deploys a schema with `@embed`, and exercises three paths
 * end-to-end:
 *
 *   1. **Happy path** — POST a record → fake-ollama returns a deterministic
 *      vector → record stores the vector at the `@embed`-decorated field.
 *
 *   2. **Source-unchanged PATCH** — PATCH a record with a non-source field →
 *      no new embed call is made (fake-ollama hit count stays flat); the
 *      existing embedding survives via patch-merge.
 *
 *   3. **Replication-receiver skip** — POST with `x-replicate-from: none` and
 *      a pre-supplied vector → no embed call is made; the supplied vector is
 *      stored as-is. (The REST receiver path; the cluster-subscribe path is
 *      covered by the `options.isNotification === true` branch in
 *      `embedHook.test.js`.)
 *
 * Setup notes:
 *   - The fake-ollama server returns deterministic 3-element Float32 vectors
 *     derived from the input text so assertions can compare exact bytes.
 *   - Harper boots with `models.embedding.default` pointing at the fake host.
 *   - Schema/component installs follow the same pattern as
 *     `integrationTests/apiTests/blob.test.mjs`.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
// .mjs siblings — TypeScript needs `// @ts-expect-error` because no declaration files exist
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error utils/lifecycle.mjs has no type declarations; runtime resolves fine
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';
import request from 'supertest';

const SCHEMA_GRAPHQL = [
	'type EmbedDoc @table(database: "embedtest") @sealed @export {',
	'\tid: ID! @primaryKey',
	'\tcontent: String',
	'\ttag: String',
	'\tembedding: Vector @embed(source: "content", model: "default")',
	'}',
	'',
].join('\n');

/**
 * REST GET returns Float32Array-typed columns as a `{type: "Buffer", data: number[]}`
 * JSON shape (msgpack/Buffer round-trip). Decode back to Float32 components for
 * equality assertions.
 */
function decodeVector(field: any): number[] | undefined {
	if (field == null) return undefined;
	if (Array.isArray(field)) return field.map(Number);
	if (field instanceof Float32Array) return Array.from(field);
	if (field && field.type === 'Buffer' && Array.isArray(field.data)) {
		const bytes = Uint8Array.from(field.data);
		const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
		return Array.from(f32);
	}
	if (field instanceof Uint8Array || field instanceof ArrayBuffer) {
		const view = field instanceof ArrayBuffer ? new Uint8Array(field) : field;
		const f32 = new Float32Array(view.buffer, view.byteOffset, Math.floor(view.byteLength / 4));
		return Array.from(f32);
	}
	return undefined;
}

interface FakeOllama {
	url: string;
	host: string; // <host:port> form for Harper's `host:` config field
	close: () => Promise<void>;
	embedCallCount: () => number;
	lastEmbedInputs: () => string[][];
	reset: () => void;
}

/**
 * Deterministic embedding function: maps an input string to a 3-element
 * Float32Array. Different inputs produce different vectors; same input
 * produces the same vector across calls.
 */
function deterministicVector(input: string): number[] {
	let h1 = 0;
	let h2 = 0;
	let h3 = 0;
	for (let i = 0; i < input.length; i++) {
		const c = input.charCodeAt(i);
		h1 = (h1 * 31 + c) % 9973;
		h2 = (h2 * 37 + c) % 9967;
		h3 = (h3 * 41 + c) % 9941;
	}
	// Normalize to (0, 1) range
	return [h1 / 9973, h2 / 9967, h3 / 9941];
}

async function startFakeOllama(): Promise<FakeOllama> {
	let embedCalls = 0;
	const embedInputs: string[][] = [];
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.method === 'POST' && req.url === '/api/embed') {
			let body = '';
			req.on('data', (chunk) => (body += chunk));
			req.on('end', () => {
				try {
					const parsed = JSON.parse(body) as { model: string; input: string | string[] };
					const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
					embedCalls++;
					embedInputs.push(inputs);
					const embeddings = inputs.map((s) => deterministicVector(s));
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ embeddings, prompt_eval_count: inputs.join(' ').length }));
				} catch (err) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: String(err) }));
				}
			});
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const addr = server.address() as AddressInfo;
	const url = `http://127.0.0.1:${addr.port}`;
	const host = `127.0.0.1:${addr.port}`;
	return {
		url,
		host,
		close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
		embedCallCount: () => embedCalls,
		lastEmbedInputs: () => embedInputs,
		reset: () => {
			embedCalls = 0;
			embedInputs.length = 0;
		},
	};
}

suite('@embed directive end-to-end with fake Ollama', (ctx: any) => {
	let fake: FakeOllama;
	let client: any;

	before(async () => {
		fake = await startFakeOllama();
		// Local debugging: setting HARPER_INTEGRATION_TEST_FORCE_LOOPBACK forces the
		// 127.0.0.1 fast-path so the test runs without `harper-integration-test-setup-loopback`
		// (macOS dev machines don't have the pool by default). CI uses the pool normally.
		if (process.env.HARPER_INTEGRATION_TEST_FORCE_LOOPBACK) {
			ctx.harper = { ...ctx.harper, hostname: '127.0.0.1' };
		}
		await startHarper(ctx, {
			config: {
				logging: { auditLog: true },
				models: {
					embedding: {
						default: { backend: 'ollama', host: fake.host, model: 'fake-embed' },
					},
				},
			},
			env: {},
		});
		client = createApiClient(ctx.harper);

		await client
			.req()
			.send({ operation: 'add_component', project: 'embedtest' })
			.expect((r: any) => {
				const text = JSON.stringify(r.body);
				ok(text.includes('Successfully added project') || text.includes('Project already exists'), r.text);
			});

		await client
			.req()
			.send({ operation: 'set_component_file', project: 'embedtest', file: 'schema.graphql', payload: SCHEMA_GRAPHQL })
			.expect((r: any) => ok(r.body?.message?.includes?.('Successfully set component: schema.graphql'), r.text))
			.expect(200);

		await restartHttpWorkers(client, '/openapi');
		fake.reset();
	});

	after(async () => {
		try {
			await teardownHarper(ctx);
		} finally {
			await fake.close();
		}
	});

	test('schema with @embed creates EmbedDoc table', async () => {
		const desc = await client.req().send({ operation: 'describe_all' }).expect(200);
		const embedDoc = desc.body?.embedtest?.EmbedDoc;
		ok(embedDoc, 'EmbedDoc table not created');
		const embeddingAttr = (embedDoc.attributes || []).find((a: any) => a.attribute === 'embedding');
		ok(embeddingAttr, 'embedding attribute should be present');
		strictEqual(embeddingAttr.type, 'Vector', 'embedding type should be Vector');
		strictEqual(embeddingAttr.indexed?.type, 'HNSW', 'embedding should be auto-HNSW-indexed');
	});

	test('happy path: POST → embedder runs → vector stored on record', async () => {
		fake.reset();
		const content = 'harper is a database';
		const expected = deterministicVector(content);

		await request(ctx.harper.httpURL)
			.post('/EmbedDoc/')
			.set(client.headers)
			.send({ id: 'doc-happy', content })
			.expect((r: any) => ok([200, 201, 204].includes(r.status), `unexpected status ${r.status}: ${r.text}`));

		// Verify the fake-ollama received exactly one embed call with the source text
		strictEqual(fake.embedCallCount(), 1, 'expected exactly one embed call');
		const inputs = fake.lastEmbedInputs()[0];
		strictEqual(inputs.length, 1);
		ok(inputs[0].includes(content), `embed input "${inputs[0]}" should contain source text`);

		// GET the record back and verify the embedding was stored
		const getResp = await client.reqRest('/EmbedDoc/doc-happy').expect(200);
		const body = getResp.body as { id: string; content: string; embedding: unknown };
		strictEqual(body.id, 'doc-happy');
		strictEqual(body.content, content);
		const stored = decodeVector(body.embedding);
		ok(stored, `embedding field should be populated, got: ${JSON.stringify(body.embedding)}`);
		strictEqual(stored.length, 3, 'expected 3-element vector');
		for (let i = 0; i < 3; i++) {
			ok(
				Math.abs(stored[i] - expected[i]) < 1e-5,
				`vector[${i}] mismatch: stored=${stored[i]} expected=${expected[i]}`
			);
		}
	});

	test('PATCH unrelated field does NOT re-run embedder; existing embedding survives', async () => {
		// Seed a record first
		const content = 'patch baseline content';
		await request(ctx.harper.httpURL)
			.post('/EmbedDoc/')
			.set(client.headers)
			.send({ id: 'doc-patch', content })
			.expect((r: any) => ok([200, 201, 204].includes(r.status), `seed POST status ${r.status}: ${r.text}`));

		const baselineEmbedCalls = fake.embedCallCount();

		// PATCH a non-source field. The embed hook's source-presence predicate should skip;
		// no new embed call should fire and the existing vector should remain unchanged.
		await request(ctx.harper.httpURL)
			.patch('/EmbedDoc/doc-patch')
			.set(client.headers)
			.send({ tag: 'updated' })
			.expect((r: any) => ok([200, 204].includes(r.status), `PATCH status ${r.status}: ${r.text}`));

		strictEqual(
			fake.embedCallCount(),
			baselineEmbedCalls,
			'embed should not fire when the source field is not in the PATCH payload'
		);

		// Verify the embedding is still the one from the original content
		const expected = deterministicVector(content);
		const getResp = await client.reqRest('/EmbedDoc/doc-patch').expect(200);
		const body = getResp.body as { tag: string; embedding: unknown };
		strictEqual(body.tag, 'updated');
		const stored = decodeVector(body.embedding);
		ok(stored, `embedding should still be populated after non-source PATCH, got: ${JSON.stringify(body.embedding)}`);
		strictEqual(stored.length, 3);
		for (let i = 0; i < 3; i++) {
			ok(Math.abs(stored[i] - expected[i]) < 1e-5, 'existing embedding should survive non-source PATCH');
		}
	});

	test('replication-receiver: POST with x-replicate-from:none + supplied vector → embedder skipped', async () => {
		const content = 'replicated record content';
		const suppliedVector = [0.111, 0.222, 0.333];
		const baselineEmbedCalls = fake.embedCallCount();

		await request(ctx.harper.httpURL)
			.post('/EmbedDoc/')
			.set({ ...client.headers, 'x-replicate-from': 'none' })
			.send({ id: 'doc-replica', content, embedding: suppliedVector })
			.expect((r: any) => ok([200, 201, 204].includes(r.status), `replica POST status ${r.status}: ${r.text}`));

		strictEqual(
			fake.embedCallCount(),
			baselineEmbedCalls,
			'embed should NOT fire on a write with x-replicate-from: none (receiver context)'
		);

		const getResp = await client.reqRest('/EmbedDoc/doc-replica').expect(200);
		const body = getResp.body as { id: string; content: string; embedding: unknown };
		strictEqual(body.id, 'doc-replica');
		strictEqual(body.content, content);
		const stored = decodeVector(body.embedding);
		ok(stored, `embedding should be populated from supplied vector, got: ${JSON.stringify(body.embedding)}`);
		strictEqual(stored.length, 3);
		// The receiver must preserve the originator's vector — NOT overwrite with what
		// it would have computed locally. Compare against suppliedVector, not against
		// deterministicVector(content).
		for (let i = 0; i < 3; i++) {
			ok(
				Math.abs(stored[i] - suppliedVector[i]) < 1e-5,
				`receiver stored ${stored[i]} but should be the originator's ${suppliedVector[i]}`
			);
		}
	});
});

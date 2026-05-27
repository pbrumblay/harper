/**
 * `@embed` directive write-time hook (#632 / Phase 5 of #510).
 *
 * Two surfaces:
 *
 *   - `createDefaultEmbedder(embedConfig)` — produces the default embedder a
 *     table registers when its schema includes an `@embed` directive. The
 *     embedder reads `record[embedConfig.source]`, calls `Models.embed(...)`
 *     with `inputType: 'document'`, and returns the first vector. Component
 *     authors can replace it via `Table.setEmbedAttribute(name, customEmbedder)`
 *     when they need different logic (multi-field concatenation, custom
 *     preprocessing).
 *
 *   - `buildEmbedBefore(...)` — produces the embedder callback invoked
 *     *before* `transaction.addWrite(...)` at the put/patch site. The
 *     embedder mutates `record[attr.name]` so the new vector is on the
 *     record when the per-write `commit(...)` closure runs. (It can't ride
 *     the txn's pre-commit `before` slot because that slot is awaited at
 *     `Promise.all(completions)` at txn-commit time — AFTER each write's
 *     `commit(...)` has already stored the record. The blob pattern works
 *     there because blob IDs are pre-allocated synchronously and the blob
 *     bytes write independently of the record.) Returns `undefined` when
 *     there's no work (no embed attributes, or the write is a replication
 *     receiver) so the call site can short-circuit.
 *
 * Replicated-write predicate: the receiver should *store* the originating
 * node's already-computed embedding, not re-compute it. Three signals
 * indicate this is NOT a local-originating write, and we must skip the
 * embedder for any of them:
 *
 *   - `options.isNotification === true` — cluster-replication path; the
 *     `source.subscribe()` handler in `Table.ts` sets this when applying a
 *     write from a peer.
 *   - `context.replicateFrom === false` — REST `x-replicate-from: none`
 *     header path. NOTE: the value is the literal `false`, not a truthy
 *     identifier; `server/REST.ts` only ever assigns `replicateFrom = false`.
 *   - `context.alreadyLogged === true` — local audit-log replay path at
 *     `resources/replayLogs.ts` (process-restart catch-up). The vector is
 *     already on disk; the replay only re-emits to the in-memory state.
 *
 * Sync-by-default execution: the embedder runs during the transaction's
 * `before` phase, so commit blocks on it. Queued mode is a follow-up: it would
 * commit the record without the vector, then back-fill via the existing job
 * infrastructure at `server/jobs/`.
 *
 * Model-change invalidation: the parser sets `property.version = "embed:<model>"`
 * so the schema-load path at `databases.ts:1111` detects a model change between
 * deploys (same pattern `@computed` uses). Today the version-change pathway
 * triggers an HNSW *re-index* of stored vectors — it does NOT *re-embed* the
 * source field through the new model. New writes after a model change pick up
 * the new model; existing rows keep their old-model vectors until they are
 * re-written. Full re-embed-on-model-change backfill is tracked as a follow-up
 * to #632 — the queued-mode plumbing is the natural place to land it, since
 * it already needs the iterate-records-and-back-fill primitive.
 */

/**
 * Lazy logger resolver. A static `import { logger } from '../../utility/logging/logger.ts'`
 * would be cleaner but trips the documented `common_utils.ts ↔ harper_logger.ts`
 * CJS cycle (ERR_REQUIRE_CYCLE_MODULE) the moment this module is loaded by a
 * unit-test path that bypasses the full transaction stack. We only need the
 * logger on the failure path, so we resolve it lazily.
 */
function getLogger(): { error?: (...args: any[]) => void } {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require('#src/utility/logging/logger').logger ?? {};
	} catch {
		return {};
	}
}

export type EmbedConfig = {
	source: string;
	model: string;
};

export type EmbedAttribute = {
	name: string;
	embed: EmbedConfig;
};

export type Embedder = (record: any) => Promise<number[] | Float32Array | null | undefined>;

/**
 * Embed-function shape the default embedder calls into. Matches the public
 * `Models.embed` signature. Pulled out as a type so we can dependency-inject
 * a fake for unit tests without dragging the transaction stack into module
 * load.
 */
type EmbedFn = (
	input: string | string[],
	opts: { model?: string; inputType?: 'document' | 'query' }
) => Promise<Float32Array[]>;

/**
 * Models facade resolver for the default embedder. Lazy-imported so this
 * module can be unit-tested without loading the transaction stack that
 * `Models.ts` pulls in. Overridable via `__setEmbedFnForTest` (test seam).
 *
 * The `Models` class reads ALS-scoped context and a process-wide backend
 * registry, so per-call instantiation has the same observable behavior as a
 * singleton — we just lazy-cache for allocation churn.
 */
let _embedFn: EmbedFn | undefined;
function resolveEmbedFn(): EmbedFn {
	if (_embedFn) return _embedFn;
	// `#src/` alias goes through package.json conditional exports — resolves to
	// `./*.ts` under the `typestrip` condition (unit tests) and to `./dist/*.js`
	// in production. A bare `require('./Models.ts')` doesn't survive the dist
	// build because the `.ts` extension stays literal at runtime.
	const { Models } = require('#src/resources/models/Models'); // eslint-disable-line @typescript-eslint/no-var-requires
	const models = new Models();
	_embedFn = (input, opts) => models.embed(input, opts);
	return _embedFn;
}

/**
 * Override the embed function used by `createDefaultEmbedder`. Test seam
 * only. Pass `undefined` to reset to the lazily-loaded `Models.embed`.
 */
export function __setEmbedFnForTest(fn: EmbedFn | undefined): void {
	_embedFn = fn;
}

export function createDefaultEmbedder(embedConfig: EmbedConfig): Embedder {
	const { source, model } = embedConfig;
	return async (record: any): Promise<number[] | null | undefined> => {
		const sourceValue = record?.[source];
		if (sourceValue == null) return null;
		// `embed()` always returns an array (one vector per input). `@embed`'s
		// single-source-field semantics mean we only ever pass a single input
		// and return the first vector.
		const vectors = await resolveEmbedFn()(String(sourceValue), {
			model,
			inputType: 'document',
		});
		const v = vectors?.[0];
		if (v == null) return undefined;
		// Convert Float32Array → plain Array<number> for storage. msgpackr's default
		// Encoder (which Harper's `RecordEncoder` extends without `structuredClone`)
		// does NOT round-trip typed arrays: a `Float32Array(3)` encodes to msgpack
		// `bin8` of length 12 with zeroed bytes and decodes as a `Buffer` of zeros.
		// Flattening to `Array<number>` at the boundary keeps the values intact.
		// HNSW's `propertyResolver` / `customIndex.index` accept `number[]` (and the
		// HNSW indexStore is a separate msgpackr instance configured with
		// `useFloat32 = ALWAYS` for compact F32 storage — see
		// `HierarchicalNavigableSmallWorld.ts:106-108`).
		return v instanceof Float32Array ? Array.from(v) : Array.from(v as any);
	};
}

/**
 * Build the pre-commit `before` callback that fires registered embedders for
 * every `@embed`-decorated attribute whose source field is present in this
 * write's payload. Returns `undefined` when:
 *
 *   - the table has no `@embed` attributes,
 *   - the write is a replication receiver, or
 *   - no source field on any embed attribute appears in the write's record.
 *
 * Source-field semantics: the embedder runs only when the source field is
 * explicitly included in the write payload (PUT or PATCH that touches the
 * source). On a PATCH that omits the source, the existing embedding survives
 * via patch-merge — we don't recompute, and we don't clear. On an explicit
 * `source: null`, we clear the embedding to `null` to preserve consistency
 * between the source and its derived vector.
 *
 * The returned callback runs registered embedders in parallel via `Promise.all`.
 * Each embedder mutates a distinct attribute on the same record, so there's no
 * ordering hazard; parallelizing avoids serializing HTTP roundtrips on the rare
 * multi-`@embed`-per-table case at no cost for the common single-embed case.
 */
export function buildEmbedBefore(
	record: any,
	context: any,
	options: any,
	embedAttributes: EmbedAttribute[] | undefined,
	userEmbedders: Record<string, Embedder>
): (() => Promise<void>) | undefined {
	if (!embedAttributes || embedAttributes.length === 0) return undefined;
	if (options?.isNotification === true || context?.replicateFrom === false || context?.alreadyLogged === true) {
		return undefined;
	}
	if (!record || typeof record !== 'object') return undefined;
	// quick scan: skip the whole pass if no embed-source field is in this payload
	let anySourcePresent = false;
	for (const attr of embedAttributes) {
		const sourceKey = attr.embed?.source;
		if (sourceKey && sourceKey in record) {
			anySourcePresent = true;
			break;
		}
	}
	if (!anySourcePresent) return undefined;
	return async (): Promise<void> => {
		// Run embedders for each `@embed` attribute in parallel — typical schemas
		// have a single `@embed` field per table but a multi-`@embed` table would
		// otherwise serialize HTTP roundtrips for no benefit. Each embedder
		// mutates a distinct attribute on the same record, so there's no
		// ordering hazard between them.
		await Promise.all(
			embedAttributes.map(async (attr) => {
				const sourceKey = attr.embed?.source;
				if (!sourceKey) return;
				if (!(sourceKey in record)) return;
				const sourceValue = record[sourceKey];
				if (sourceValue == null) {
					record[attr.name] = null;
					return;
				}
				// CRDT operation payloads (`{__op__, value}`) are unwrapped at validate-time
				// (see `Table.validate`). Harper today only supports the numeric `add` op
				// (`resources/crdt.ts`), which isn't a meaningful `@embed` source — and the
				// raw op object would stringify to "[object Object]" if passed to the
				// embedder. Skip the embed call; the validate-time unwrap of `value` is
				// what gets stored, and any future write on the resolved value re-embeds.
				if (sourceValue && typeof sourceValue === 'object' && (sourceValue as any).__op__) return;
				const embedder = userEmbedders[attr.name];
				if (!embedder) return;
				let vector;
				try {
					vector = await embedder(record);
				} catch (err) {
					// Embedder backends (OpenAI, Anthropic, Bedrock, Ollama) may include
					// URLs, model identifiers, or API-key tails in error messages. Those
					// land in HTTP responses if propagated raw — Harper's threat model
					// trusts deployers but not arbitrary REST callers, so we log the raw
					// error and rethrow a sanitized one. The original error stays in
					// server logs for diagnosis.
					getLogger().error?.(`Embedder for attribute "${attr.name}" failed:`, err);
					throw new Error(`Failed to compute embedding for attribute "${attr.name}"`);
				}
				record[attr.name] = normalizeVector(vector);
			})
		);
	};
}

/**
 * Normalize an embedder's output to a plain `Array<number>` for storage. The default
 * embedder already returns `Array<number>` (see `createDefaultEmbedder`), but custom
 * embedders registered via `Table.setEmbedAttribute` are free to return any of the
 * `Embedder` return shapes — `Float32Array`, `Float64Array`, plain arrays, etc. We
 * unify here for two reasons:
 *
 *   1. msgpackr's default Encoder (which Harper's `RecordEncoder` extends without
 *      `structuredClone`) does NOT round-trip typed arrays: a `Float32Array(N)`
 *      encodes to msgpack `bin8` with zeroed bytes and decodes as a `Buffer`.
 *      Only plain `Array<number>` round-trips cleanly.
 *   2. `Table.validate()` has no `Vector` case, and `coerceType` is only called on
 *      query/PK values, not write payloads — so an unsanitized embedder result would
 *      reach the encoder as-is.
 *
 * Returns `null` for `null`/`undefined`/non-array-like input; lets through anything
 * the encoder will handle correctly. A finite-check on the values is *not* performed —
 * HNSW will reject NaN at index time, and a noisy embedder is the component author's
 * bug to fix, not Harper's to silently mask.
 */
function normalizeVector(vector: any): number[] | null {
	if (vector == null) return null;
	if (Array.isArray(vector)) return vector;
	if (vector instanceof Float32Array) return Array.from(vector);
	if (ArrayBuffer.isView(vector)) return Array.from(vector as any);
	return vector;
}

import { contextStorage } from '../transaction.ts';
import { resolveEmbedding, resolveGenerative } from './backendRegistry.ts';
import { getModelCallAnalyticsWriter, type ModelCallAnalyticsWriter, type ModelCallRecord } from './analyticsTable.ts';
import { ServerError } from '../../utility/errors/hdbError.ts';
import type {
	AccountingContext,
	BackendOpts,
	EmbedOpts,
	GenerateChunk,
	GenerateInput,
	GenerateOpts,
	GenerateResult,
	ModelBackend,
	ModelCallResult,
	Models as ModelsContract,
	TokenUsage,
} from './types.ts';

type CallMethod = ModelCallRecord['method'];

/**
 * Public `scope.models` facade. One instance per `Scope`.
 *
 * On every call:
 * - Resolves the configured backend via `backendRegistry` (config-driven).
 * - Reads the ALS-bound request `Context` to extract accounting context
 *   (tenantId, handlerPath) and an `AbortSignal`. Outside an ALS scope
 *   (app-init, internal jobs), accounting is empty and signal is undefined.
 * - Records the call to `hdb_model_calls` via the buffered writer — both
 *   successful and failed calls land in the table for billing visibility.
 *
 * The ALS pattern matches `resources/Table.ts:3517` and is rooted at
 * `resources/transaction.ts:6`.
 */
export class Models implements ModelsContract {
	#analyticsWriter: ModelCallAnalyticsWriter;

	constructor(analyticsWriter: ModelCallAnalyticsWriter = getModelCallAnalyticsWriter()) {
		this.#analyticsWriter = analyticsWriter;
	}

	async embed(input: string | string[], opts: EmbedOpts = {}): Promise<Float32Array[]> {
		const backend = resolveEmbedding(opts.model);
		requireCapability(backend, 'embed');
		const { accounting, signal } = resolveCallContext(opts.signal);
		const backendOpts: BackendOpts<EmbedOpts> = { ...opts, signal, accounting };
		const startedAt = performance.now();
		try {
			const result = await backend.embed!(input, backendOpts);
			this.#record(backend, 'embed', opts.model, accounting, undefined, result, startedAt);
			return unwrap(backend, result);
		} catch (err) {
			this.#recordFailure(backend, 'embed', opts.model, accounting, undefined, startedAt, err);
			throw err;
		}
	}

	async generate(input: GenerateInput, opts: GenerateOpts = {}): Promise<GenerateResult> {
		const backend = resolveGenerative(opts.model);
		requireCapability(backend, 'generate');
		const { accounting, signal } = resolveCallContext(opts.signal);
		const backendOpts: BackendOpts<GenerateOpts> = { ...opts, signal, accounting };
		const startedAt = performance.now();
		try {
			const result = await backend.generate!(input, backendOpts);
			this.#record(backend, 'generate', opts.model, accounting, opts, result, startedAt);
			return unwrap(backend, result);
		} catch (err) {
			this.#recordFailure(backend, 'generate', opts.model, accounting, opts, startedAt, err);
			throw err;
		}
	}

	generateStream(input: GenerateInput, opts: GenerateOpts = {}): AsyncIterable<GenerateChunk> {
		const backend = resolveGenerative(opts.model);
		requireCapability(backend, 'stream');
		const { accounting, signal } = resolveCallContext(opts.signal);
		const backendOpts: BackendOpts<GenerateOpts> = { ...opts, signal, accounting };
		return this.#wrapStream(backend, input, backendOpts, opts, accounting);
	}

	async *#wrapStream(
		backend: ModelBackend,
		input: GenerateInput,
		backendOpts: BackendOpts<GenerateOpts>,
		opts: GenerateOpts,
		accounting: AccountingContext
	): AsyncIterable<GenerateChunk> {
		const startedAt = performance.now();
		let success = true;
		let caught: unknown;
		try {
			for await (const chunk of backend.generateStream!(input, backendOpts)) {
				yield chunk;
			}
		} catch (err) {
			success = false;
			caught = err;
			throw err;
		} finally {
			if (success) {
				this.#record(backend, 'generateStream', opts.model, accounting, opts, undefined, startedAt);
			} else {
				this.#recordFailure(backend, 'generateStream', opts.model, accounting, opts, startedAt, caught);
			}
		}
	}

	#record(
		backend: ModelBackend,
		method: CallMethod,
		model: string | undefined,
		accounting: AccountingContext,
		opts: GenerateOpts | undefined,
		result: ModelCallResult<unknown> | undefined,
		startedAt: number
	): void {
		const usage = result?.status === 'completed' ? result.usage : undefined;
		this.#analyticsWriter.write(buildRecord(backend, method, model, accounting, opts, usage, startedAt, true));
	}

	#recordFailure(
		backend: ModelBackend,
		method: CallMethod,
		model: string | undefined,
		accounting: AccountingContext,
		opts: GenerateOpts | undefined,
		startedAt: number,
		err: unknown
	): void {
		this.#analyticsWriter.write({
			...buildRecord(backend, method, model, accounting, opts, undefined, startedAt, false),
			error_code: classifyError(err),
		});
	}
}

function buildRecord(
	backend: ModelBackend,
	method: CallMethod,
	model: string | undefined,
	accounting: AccountingContext,
	opts: GenerateOpts | undefined,
	usage: TokenUsage | undefined,
	startedAt: number,
	success: boolean
): ModelCallRecord {
	const record: ModelCallRecord = {
		backend: backend.name,
		method,
		model,
		tenant: accounting.tenantId,
		app: accounting.app,
		adapter: opts?.adapter,
		conversation_id: opts?.conversationId,
		latency_ms: performance.now() - startedAt,
		success,
	};
	if (usage) {
		if (usage.promptTokens !== undefined) record.prompt_tokens = usage.promptTokens;
		if (usage.completionTokens !== undefined) record.completion_tokens = usage.completionTokens;
		if (usage.embeddingTokens !== undefined) record.embedding_tokens = usage.embeddingTokens;
		if (usage.gpuMs !== undefined) record.gpu_ms = usage.gpuMs;
	}
	return record;
}

function resolveCallContext(callerSignal?: AbortSignal): { accounting: AccountingContext; signal?: AbortSignal } {
	const ctx = contextStorage.getStore() as any;
	return {
		accounting: {
			tenantId: extractTenantId(ctx?.user),
			app: ctx?.handlerPath,
		},
		signal: callerSignal ?? ctx?.signal,
	};
}

function extractTenantId(user: any): string | undefined {
	return user?.tenant ?? user?.tenantId ?? undefined;
}

function requireCapability(backend: ModelBackend, capability: 'embed' | 'generate' | 'stream'): void {
	if (!backend.capabilities()[capability]) throw new ModelCapabilityError(backend.name, capability);
}

function unwrap<T>(backend: ModelBackend, result: ModelCallResult<T>): T {
	if (result.status === 'completed') return result.output;
	throw new ModelPendingNotSupportedError(backend.name);
}

function classifyError(err: unknown): string {
	if (err && typeof err === 'object') {
		const e = err as { name?: string; code?: string };
		if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return 'aborted';
		if (e.name === 'ModelCapabilityError') return 'capability_unsupported';
	}
	return 'backend_error';
}

export class ModelCapabilityError extends ServerError {
	// Deliberately does not name the requested capability beyond what was asked for —
	// avoids enumerating what the backend *does* support in error responses.
	constructor(backendName: string, capability: 'embed' | 'generate' | 'stream') {
		super(`Backend '${backendName}' does not support '${capability}'`);
		this.name = 'ModelCapabilityError';
	}
}

export class ModelPendingNotSupportedError extends ServerError {
	constructor(backendName: string) {
		super(`Backend '${backendName}' returned 'pending'; long-running operations are not yet supported`);
		this.name = 'ModelPendingNotSupportedError';
	}
}

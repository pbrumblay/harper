import { get as envGet } from '../../utility/environment/environmentManager.ts';
import { ServerError } from '../../utility/errors/hdbError.ts';
import type { ModelBackend } from './types.ts';

/**
 * Process-wide model backend registry.
 *
 * Backends register themselves by `backend.name` (e.g. `'test'`, `'ollama'`,
 * `'ollama:fast'`). Per-kind logical-name resolution is config-driven:
 * `resolveEmbedding('default')` reads `models.embedding.default.backend` from
 * config and returns the registered backend with that name.
 *
 * Module-scope state is intentional — one registry per Harper process,
 * mirroring `contextStorage` at `resources/transaction.ts:6`.
 */

type ModelKind = 'embedding' | 'generative';

const byName: Map<string, ModelBackend> = new Map();

/**
 * Register a backend instance. Idempotent on `backend.name` — re-registering
 * with the same name replaces the prior instance (convenient for tests).
 */
export function registerBackend(backend: ModelBackend): void {
	byName.set(backend.name, backend);
}

/**
 * Resolve the backend configured as the embedding provider for `logicalName`
 * (default: `'default'`). Throws if no config entry exists or the named
 * backend is not registered.
 */
export function resolveEmbedding(logicalName: string = 'default'): ModelBackend {
	return resolve('embedding', logicalName);
}

/**
 * Resolve the backend configured as the generative provider for `logicalName`
 * (default: `'default'`). Throws if no config entry exists or the named
 * backend is not registered.
 */
export function resolveGenerative(logicalName: string = 'default'): ModelBackend {
	return resolve('generative', logicalName);
}

/** Remove all registered backends. Test-only hygiene. */
export function clearRegistry(): void {
	byName.clear();
}

function resolve(kind: ModelKind, logicalName: string): ModelBackend {
	const backendName = envGet(`models.${kind}.${logicalName}.backend`);
	if (typeof backendName !== 'string' || !backendName) {
		throw new ModelBackendNotConfiguredError(kind, logicalName);
	}
	const backend = byName.get(backendName);
	if (!backend) throw new ModelBackendNotRegisteredError(kind, logicalName);
	return backend;
}

export class ModelBackendNotConfiguredError extends ServerError {
	constructor(kind: ModelKind, logicalName: string) {
		super(`No '${kind}.${logicalName}.backend' configured`);
		this.name = 'ModelBackendNotConfiguredError';
	}
}

export class ModelBackendNotRegisteredError extends ServerError {
	// Deliberately does not name which backend was configured — avoids leaking
	// the set of registered backend identifiers in error responses.
	constructor(kind: ModelKind, logicalName: string) {
		super(`Backend configured for '${kind}.${logicalName}' is not registered`);
		this.name = 'ModelBackendNotRegisteredError';
	}
}

/**
 * YAML→registry boot bridge (#629, Phase 2 of #510).
 *
 * Reads the top-level `models` block from the root config and dispatches each
 * `models.embedding.<name>` / `models.generative.<name>` entry to the matching
 * per-backend register function. Backends self-contain in `components/<name>/`
 * (matches the pattern in `components/mcp/index.ts` from PR #649).
 *
 * Boot site: `components/componentLoader.ts` calls this after `getConfigObj()`
 * returns the root config and before per-component iteration, so that
 * `scope.models.embed(...)` works from `handleApplication(scope)`.
 *
 * Errors per entry are logged and skipped, not thrown — one misconfigured
 * backend should not block Harper boot.
 */
import harperLogger from '../../utility/logging/harper_logger.ts';
import { registerOllamaBackend, type OllamaBackendConfig } from '../../components/ollama/index.ts';

type ModelKind = 'embedding' | 'generative';

interface ModelEntry {
	backend?: string;
	host?: string;
	model?: string;
	requestTimeoutMs?: number;
}

interface ModelsConfig {
	embedding?: Record<string, ModelEntry>;
	generative?: Record<string, ModelEntry>;
}

interface RootConfig {
	models?: ModelsConfig;
}

type BackendRegisterFn = (args: { logicalName: string; kind: ModelKind; config: object }) => void;

const FACTORIES: Record<string, BackendRegisterFn> = {
	ollama: (args) => registerOllamaBackend({ ...args, config: args.config as OllamaBackendConfig }),
};

/**
 * Populate the model registry from `rootConfig.models`. No-op if the block
 * is absent or empty. Idempotent within a process: each entry overwrites any
 * prior registration under the same logical name (registry uses `.set()`).
 */
export function bootstrapModels(rootConfig: RootConfig | undefined | null): void {
	const block = rootConfig?.models;
	if (!block) return;
	registerKind('embedding', block.embedding);
	registerKind('generative', block.generative);
}

function registerKind(kind: ModelKind, entries: Record<string, ModelEntry> | undefined): void {
	if (!entries) return;
	for (const [logicalName, entry] of Object.entries(entries)) {
		if (!entry || typeof entry !== 'object') {
			// Schema validation (configValidator.ts) catches this before bootstrap
			// runs, so reaching here means config was loaded by an unusual path
			// (test, programmatic). Log at error so it's visible.
			harperLogger.error(`models.${kind}.${logicalName} is not an object; skipping`);
			continue;
		}
		const factory = entry.backend ? FACTORIES[entry.backend] : undefined;
		if (!factory) {
			// Loud because the operator opted into `models:` specifically to enable
			// a backend — silently registering nothing is a footgun. Schema-level
			// typo guards (`.unknown(false)` on modelEntrySchema) catch field-name
			// typos before this point; reaching here means `backend:` itself names
			// a type Harper doesn't ship a factory for in this version.
			harperLogger.error(
				`models.${kind}.${logicalName}: unknown backend '${entry.backend ?? '(missing)'}'; skipping`
			);
			continue;
		}
		try {
			factory({ logicalName, kind, config: entry });
		} catch (err) {
			harperLogger.error(
				`models.${kind}.${logicalName}: registration failed (${(err as Error)?.message ?? err})`
			);
		}
	}
}

/**
 * Native MCP (Model Context Protocol) server component for Harper.
 *
 * Foundation PR (#613): exports a config-gated registration hook used by the
 * operations and HTTP host servers. The hook installs a placeholder route
 * that returns HTTP 503 with body `{ error: 'mcp_not_implemented', profile }`
 * until the Streamable HTTP transport lands in #614. Tracking: #465.
 */
import harperLogger from '../../utility/logging/harper_logger.ts';

export type McpProfile = 'operations' | 'application';

interface McpProfileConfig {
	enabled?: boolean;
	mountPath?: string;
}

interface FullConfig {
	mcp?: {
		operations?: McpProfileConfig;
		application?: McpProfileConfig;
	};
}

interface FastifyLike {
	post: (path: string, ...rest: unknown[]) => unknown;
}

export interface RegisterMcpProfileArgs {
	profile: McpProfile;
	host: FastifyLike;
	config: FullConfig;
	/** Route-level options forwarded to the host's `post(path, options, handler)` 3-arg form (e.g., Fastify `preValidation`). */
	routeOptions?: Record<string, unknown>;
}

const DEFAULT_MOUNT_PATH = '/mcp';

/**
 * Register the MCP profile on its host server when enabled in config.
 *
 * The stub responder is intentionally minimal — sub-issue #614 replaces it
 * with the real Streamable HTTP transport without changing this gate.
 */
export function registerMcpProfile({ profile, host, config, routeOptions }: RegisterMcpProfileArgs): void {
	const profileConfig = config?.mcp?.[profile];
	if (!profileConfig?.enabled) {
		harperLogger.trace(`MCP ${profile} profile disabled, skipping registration`);
		return;
	}

	const mountPath = profileConfig.mountPath ?? DEFAULT_MOUNT_PATH;
	const handler = createStubHandler(profile);
	if (routeOptions) {
		host.post(mountPath, routeOptions, handler);
	} else {
		host.post(mountPath, handler);
	}
	harperLogger.info(`MCP ${profile} profile registered at ${mountPath}`);
}

/**
 * Builds the placeholder 503 handler. Returned function is Fastify-compatible:
 * `(request, reply)` where `reply` exposes `code()`, `header()`, and `send()`.
 */
export function createStubHandler(profile: McpProfile) {
	return async function mcpStubHandler(_request: unknown, reply: McpReply): Promise<void> {
		reply.code(503);
		reply.header('Retry-After', '0');
		reply.header('Content-Type', 'application/json');
		reply.send({ error: 'mcp_not_implemented', profile });
	};
}

interface McpReply {
	code: (status: number) => McpReply;
	header: (name: string, value: string) => McpReply;
	send: (body: unknown) => McpReply;
}

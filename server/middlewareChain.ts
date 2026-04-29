export type HttpEntry = {
	listener: Function;
	port: number | string;
	name?: string;
	before?: string;
	after?: string;
	urlPath?: string;
	host?: string;
};

/**
 * Topological sort of middleware entries respecting `before`/`after` constraints.
 * Uses the original registration index as a tiebreaker so config order is preserved
 * when there are no constraints between two entries.
 *
 * `before: 'X'` → this entry must run before the FIRST entry named X.
 * `after: 'X'`  → this entry must run after the LAST entry named X.
 *
 * @param onCycle - called when a cycle is detected; entries are returned unsorted.
 */
export function topoSort(entries: HttpEntry[], onCycle?: () => void): HttpEntry[] {
	const n = entries.length;
	if (n <= 1) return entries;

	// Map name → first and last index (for before/after semantics)
	const nameToFirst = new Map<string, number>();
	const nameToLast = new Map<string, number>();
	for (let i = 0; i < n; i++) {
		const name = entries[i].name;
		if (name) {
			if (!nameToFirst.has(name)) nameToFirst.set(name, i);
			nameToLast.set(name, i);
		}
	}

	// successors[i] = list of indices that must come after i
	const successors: number[][] = Array.from({ length: n }, () => []);
	const inDegree = new Int32Array(n);
	const addEdge = (from: number, to: number) => {
		successors[from].push(to);
		inDegree[to]++;
	};

	for (let i = 0; i < n; i++) {
		const { before, after } = entries[i];
		if (before) {
			const j = nameToFirst.get(before);
			if (j !== undefined && j !== i) addEdge(i, j);
		}
		if (after) {
			const j = nameToLast.get(after);
			if (j !== undefined && j !== i) addEdge(j, i);
		}
	}

	// Kahn's algorithm; use original index as tiebreaker to preserve registration/config order
	const ready: number[] = [];
	for (let i = 0; i < n; i++) {
		if (inDegree[i] === 0) ready.push(i);
	}

	const sorted: HttpEntry[] = [];
	while (ready.length > 0) {
		const i = ready.shift()!;
		sorted.push(entries[i]);
		for (const j of successors[i]) {
			if (--inDegree[j] === 0) {
				// Binary-insert to keep ready sorted by original index
				let lo = 0,
					hi = ready.length;
				while (lo < hi) {
					const mid = (lo + hi) >> 1;
					if (ready[mid] < j) lo = mid + 1;
					else hi = mid;
				}
				ready.splice(lo, 0, j);
			}
		}
	}

	if (sorted.length !== n) {
		onCycle?.();
		return entries;
	}
	return sorted;
}

/**
 * Builds a linear middleware chain from a sorted array of entries.
 * The first entry in `sorted` is the outermost (called first).
 * `fallback` is invoked when all entries call next() without handling the request.
 */
export function buildLinearChain(sorted: HttpEntry[], fallback: Function): Function {
	let next = fallback;
	for (let i = sorted.length; i > 0; ) {
		const { listener } = sorted[--i];
		const callback = next;
		next = (...args: any[]) => listener(...args, callback);
	}
	return next;
}

/**
 * Resolves transitive `after` dependencies for a set of entries.
 * If entry A says `after: 'auth'` and auth is in `nameToEntry` but not in `entries`,
 * auth is pulled into the result so that the ordering constraint can be satisfied.
 * `before` constraints do NOT pull in entries — they only affect ordering.
 */
export function resolveDeps(entries: HttpEntry[], nameToEntry: Map<string, HttpEntry>): HttpEntry[] {
	const included = new Set(entries);
	let changed = true;
	while (changed) {
		changed = false;
		for (const entry of [...included]) {
			if (entry.after) {
				const dep = nameToEntry.get(entry.after);
				if (dep && !included.has(dep)) {
					included.add(dep);
					changed = true;
				}
			}
		}
	}
	return [...included];
}

/**
 * Returns true when `request` satisfies the route's host and urlPath constraints.
 * urlPath matching is prefix-based and segment-boundary-aware:
 *   '/api' matches '/api' and '/api/foo' but NOT '/api2'.
 */
export function matchesRoute(request: any, route: { host?: string; urlPath?: string }): boolean {
	if (route.host) {
		const hostHeader: string = request.headers?.asObject?.host ?? '';
		const requestHost = hostHeader.split(':')[0];
		if (requestHost !== route.host) return false;
	}
	if (route.urlPath) {
		const pathname: string = request.pathname ?? '/';
		if (pathname !== route.urlPath && !pathname.startsWith(route.urlPath + '/')) return false;
	}
	return true;
}

/**
 * Builds a dispatching chain when sub-routes (urlPath/host) are present.
 *
 * Each sub-route gets its own complete chain. If a sub-route entry declares
 * `after: 'X'`, entry X is pulled in from any route's registry so that the
 * constraint can be satisfied without requiring X to be explicitly registered
 * in the sub-route. This is how auth on the default route propagates into
 * sub-route chains that depend on it.
 *
 * Dispatch priority: host+path > host-only > path-only; longer paths win ties.
 */
export function buildRoutedChain(portEntries: HttpEntry[], fallback: Function): Function {
	// Global name registry across all routes (first registration wins)
	const nameToEntry = new Map<string, HttpEntry>();
	for (const entry of portEntries) {
		if (entry.name && !nameToEntry.has(entry.name)) nameToEntry.set(entry.name, entry);
	}

	type RouteGroup = { host?: string; urlPath?: string; entries: HttpEntry[] };
	const routeGroups: RouteGroup[] = [];
	for (const entry of portEntries) {
		const group = routeGroups.find(g => g.host === entry.host && g.urlPath === entry.urlPath);
		if (group) group.entries.push(entry);
		else routeGroups.push({ host: entry.host, urlPath: entry.urlPath, entries: [entry] });
	}

	const defaultGroup = routeGroups.find(g => !g.host && !g.urlPath);
	const subRouteGroups = routeGroups.filter(g => g.host || g.urlPath);

	const subRouteChains = subRouteGroups.map(group => {
		const resolved = resolveDeps(group.entries, nameToEntry);
		return { host: group.host, urlPath: group.urlPath, chain: buildLinearChain(topoSort(resolved), fallback) };
	});

	subRouteChains.sort((a, b) => {
		const aSpec = (a.host ? 2 : 0) + (a.urlPath ? 1 : 0);
		const bSpec = (b.host ? 2 : 0) + (b.urlPath ? 1 : 0);
		if (aSpec !== bSpec) return bSpec - aSpec;
		return (b.urlPath?.length ?? 0) - (a.urlPath?.length ?? 0);
	});

	const defaultChain = buildLinearChain(topoSort(defaultGroup?.entries ?? []), fallback);

	return function dispatch(request: any) {
		for (const route of subRouteChains) {
			if (matchesRoute(request, route)) return route.chain(request);
		}
		return defaultChain(request);
	};
}

/**
 * Builds the complete middleware chain for a given port from the full responders list.
 * Uses a flat linear chain when no sub-routes are present (fast path),
 * or a route-dispatching chain when any entry has urlPath or host.
 */
export function makeCallbackChain(
	responders: HttpEntry[],
	portNum: number | string,
	fallback: Function
): Function {
	const portEntries = responders.filter(({ port }) => port === portNum || port === 'all');
	if (portEntries.some(e => e.urlPath || e.host)) return buildRoutedChain(portEntries, fallback);
	return buildLinearChain(topoSort(portEntries), fallback);
}

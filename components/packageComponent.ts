import { join } from 'path';
import { Readable } from 'node:stream';
import tar from 'tar-fs';
import { createGzip } from 'node:zlib';

interface PackageOptions {
	skip_node_modules?: boolean;
	skip_symlinks?: boolean;
}

const DEFAULT_OPTIONS: PackageOptions = { skip_node_modules: false, skip_symlinks: false };

/**
 * Package a directory into a tar+gzip stream. The returned Readable can be
 * piped directly into an HTTP request body, avoiding the Node.js 2GB Buffer
 * cap that the buffered variant runs into for large components.
 */
export function streamPackagedDirectory(directory: string, options: PackageOptions = DEFAULT_OPTIONS): Readable {
	const packStream = tar.pack(directory, {
		dereference: !options.skip_symlinks,
		ignore: options.skip_node_modules
			? (name: string) => {
					return name.includes('node_modules') || name.includes(join('cache', 'webpack'));
				}
			: undefined,
		map: (header) => {
			if (header.type === 'directory') {
				header.mode = 0o755;
			}
			return header;
		},
	});
	const gzip = createGzip();
	// Propagate pack errors onto the gzip stream so a single consumer can listen
	packStream.on('error', (err) => gzip.destroy(err));
	return packStream.pipe(gzip);
}

/**
 * Package a directory into a tar+gzip buffer. Retained for callers that need
 * an in-memory payload (small deploys, tests). For large directories prefer
 * `streamPackagedDirectory` to avoid the Buffer size ceiling.
 */
export function packageDirectory(directory: string, options: PackageOptions = DEFAULT_OPTIONS): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		const stream = streamPackagedDirectory(directory, options);
		stream.on('data', (chunk: Buffer) => chunks.push(chunk));
		stream.on('end', () => resolve(Buffer.concat(chunks)));
		stream.on('error', reject);
	});
}

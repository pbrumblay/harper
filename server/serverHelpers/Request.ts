import type { IncomingMessage as NodeIncomingMessage, ServerResponse as NodeServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { Readable } from 'node:stream';
import type { Headers as ResponseHeaders } from './Headers.ts';

export const isBun = typeof globalThis.Bun !== 'undefined';

// Some request compatible type-ing. We can handle both HTTP and HTTPS requests and the server is augmented.
interface IncomingMessage extends NodeIncomingMessage {
	authority?: string;
	socket: (Socket | TLSSocket) & {
		authorized?: boolean; // only for TLSSocket
		encrypted?: boolean; // only for TLSSocket
		getPeerCertificate?: (detailed?: boolean) => any; // only for TLSSocket
		server?: {
			mtlsConfig?: any;
		};
	};
}

/**
 * We define our own request class, to ensure that it has integrity against leaks in a secure environment
 * and for better conformance to WHATWG standards.
 */
export class Request {
	#body: RequestBody | undefined;
	#peerCertificate: any;
	public _nodeRequest: IncomingMessage;
	public _nodeResponse?: NodeServerResponse;
	public method: string;
	public url: string;
	public headers: RequestHeaders;
	public isWebSocket?: boolean;
	public user?: any; // User object can be attached during authentication
	public response: {
		status?: number;
		headers: ResponseHeaders;
	};
	public __harperRequestUpgraded: boolean;

	constructor(nodeRequest: IncomingMessage, nodeResponse: NodeServerResponse) {
		this.method = nodeRequest.method;
		const url = nodeRequest.url;
		this._nodeRequest = nodeRequest;
		this._nodeResponse = nodeResponse;
		this.url = url;
		this.headers = new RequestHeaders(nodeRequest.headers);
		this.__harperRequestUpgraded = false;
	}
	get absoluteURL() {
		return this.protocol + '://' + this.host + this.url;
	}
	get pathname() {
		const queryStart = this.url.indexOf('?');
		if (queryStart > -1) return this.url.slice(0, queryStart);
		return this.url;
	}
	set pathname(pathname) {
		const queryStart = this.url.indexOf('?');
		if (queryStart > -1) this.url = pathname + this.url.slice(queryStart);
		else this.url = pathname;
	}
	get protocol() {
		return this._nodeRequest.socket.encrypted ? 'https' : 'http';
	}
	get ip() {
		return this._nodeRequest.socket.remoteAddress;
	}
	get authorized() {
		return this._nodeRequest.socket.authorized;
	}
	get peerCertificate() {
		// Cache the certificate to avoid repeated parsing overhead
		// getPeerCertificate() calls translatePeerCertificate which parses
		// the raw certificate data each time (via handle.getPeerCertificate() -> SSL_get_peer_certificate)
		// This issue persists in Node.js v24 - https://github.com/nodejs/node/blob/v24.x/lib/_tls_wrap.js#L1117
		if (this.#peerCertificate === undefined) {
			// Pass true to include the full certificate chain with issuerCertificate properties
			// This is required for OCSP verification which needs both the peer cert and its issuer
			this.#peerCertificate = this._nodeRequest.socket.getPeerCertificate?.(true) || null;
		}
		return this.#peerCertificate;
	}
	get mtlsConfig() {
		return this._nodeRequest.socket.server.mtlsConfig;
	}
	get body() {
		return this.#body || (this.#body = new RequestBody(this._nodeRequest));
	}
	get host() {
		return this._nodeRequest.authority || this._nodeRequest.headers.host;
	}
	get hostname() {
		return this._nodeRequest.headers.host;
	}
	get httpVersion() {
		return this._nodeRequest.httpVersion;
	}
	get isAborted() {
		// TODO: implement this
		return false;
	}
	// Expose node request for cases that need direct access (e.g., replication)
	get nodeRequest() {
		return this._nodeRequest;
	}
	sendEarlyHints(link: string, headers: Record<string, any> = {}) {
		headers.link = link;
		this._nodeResponse.writeEarlyHints(headers);
	}
}

/**
 * Bun-compatible Request adapter. Wraps a Web Fetch API Request (from Bun.serve's fetch handler)
 * to present the same interface as the Node.js-based Request class.
 */
export class BunRequest {
	#body: BunRequestBody | undefined;
	#ip: string | undefined;
	#isSecure: boolean;
	public _webRequest: globalThis.Request;
	public _bunServer: any;
	// Provide _nodeRequest as null for code that checks it; _nodeResponse is not applicable
	public _nodeRequest: any = null;
	public _nodeResponse: any = null;
	public method: string;
	public url: string;
	public headers: RequestHeaders;
	public isWebSocket?: boolean;
	public user?: any;
	public response: {
		status?: number;
		headers: ResponseHeaders;
	};
	public __harperRequestUpgraded: boolean;

	constructor(webRequest: globalThis.Request, bunServer: any, isSecure: boolean) {
		this._webRequest = webRequest;
		this._bunServer = bunServer;
		this.#isSecure = isSecure;
		this.method = webRequest.method;
		// Web Request.url is a full URL; extract the path + query to match Node's IncomingMessage.url
		const fullUrl = webRequest.url;
		const protocolEnd = fullUrl.indexOf('//');
		const pathStart = fullUrl.indexOf('/', protocolEnd + 2);
		this.url = pathStart >= 0 ? fullUrl.slice(pathStart) : '/';
		// Convert Web Headers to plain object for our RequestHeaders wrapper
		const headersObj: Record<string, string> = {};
		webRequest.headers.forEach((value, key) => {
			headersObj[key] = value;
		});
		this.headers = new RequestHeaders(headersObj);
		this.__harperRequestUpgraded = false;
	}
	get absoluteURL() {
		return this._webRequest.url;
	}
	get pathname() {
		const queryStart = this.url.indexOf('?');
		if (queryStart > -1) return this.url.slice(0, queryStart);
		return this.url;
	}
	set pathname(pathname) {
		const queryStart = this.url.indexOf('?');
		if (queryStart > -1) this.url = pathname + this.url.slice(queryStart);
		else this.url = pathname;
	}
	get protocol() {
		return this.#isSecure ? 'https' : 'http';
	}
	get ip() {
		if (this.#ip === undefined) {
			const addr = this._bunServer?.requestIP?.(this._webRequest);
			this.#ip = addr?.address || '';
		}
		return this.#ip;
	}
	get authorized() {
		// TLS client authorization is not directly accessible via Bun.serve()
		return undefined;
	}
	get peerCertificate() {
		// Peer certificates are not accessible via Bun.serve()
		return null;
	}
	get mtlsConfig() {
		return undefined;
	}
	get body() {
		return this.#body || (this.#body = new BunRequestBody(this._webRequest));
	}
	get host() {
		return this.headers.get('host') as string;
	}
	get hostname() {
		return this.headers.get('host') as string;
	}
	get httpVersion() {
		return '1.1';
	}
	get isAborted() {
		return false;
	}
	get nodeRequest() {
		return null;
	}
	sendEarlyHints(_link: string, _headers: Record<string, any> = {}) {
		// Early hints not supported on Bun
	}
}

class RequestBody {
	#nodeRequest: IncomingMessage;
	constructor(nodeRequest: IncomingMessage) {
		this.#nodeRequest = nodeRequest;
	}
	on(event: string, listener: (...args: any[]) => void) {
		this.#nodeRequest.on(event, listener);
		return this;
	}
	pipe(destination: any, options?: any) {
		return this.#nodeRequest.pipe(destination, options);
	}
}

/**
 * Body adapter for Bun requests. Converts the Web ReadableStream to a Node-compatible
 * event-based interface (.on('data'), .on('end')) and .pipe().
 */
class BunRequestBody {
	#webRequest: globalThis.Request;
	#readable: any; // lazily created Readable stream
	constructor(webRequest: globalThis.Request) {
		this.#webRequest = webRequest;
	}
	#getReadable() {
		if (!this.#readable) {
			const body = this.#webRequest.body;
			if (body) {
				this.#readable = Readable.fromWeb(body as any);
			} else {
				// No body — create an empty readable that immediately ends
				this.#readable = new Readable({
					read() {
						this.push(null);
					},
				});
			}
		}
		return this.#readable;
	}
	on(event: string, listener: (...args: any[]) => void) {
		this.#getReadable().on(event, listener);
		return this;
	}
	pipe(destination: any, options?: any) {
		return this.#getReadable().pipe(destination, options);
	}
}

class RequestHeaders {
	public asObject: Record<string, string | string[]>;

	constructor(asObject: Record<string, string | string[]>) {
		this.asObject = asObject;
	}

	set(name: string, value: string | string[]) {
		this.asObject[name.toLowerCase()] = value;
	}
	get(name: string): string | string[] | undefined {
		return this.asObject[name.toLowerCase()];
	}
	has(name: string): boolean {
		return Object.prototype.hasOwnProperty.call(this.asObject, name.toLowerCase());
	}
	[Symbol.iterator]() {
		return Object.entries(this.asObject)[Symbol.iterator]();
	}
	keys() {
		return Object.keys(this.asObject);
	}
	values() {
		return Object.values(this.asObject);
	}
	delete(name: string) {
		delete this.asObject[name.toLowerCase()];
	}
	forEach(callback: (value: string | string[], key: string, headers: RequestHeaders) => void) {
		for (const [key, value] of this) {
			callback(value, key, this);
		}
	}
}

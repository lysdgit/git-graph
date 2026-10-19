import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { applyClientCount, dispatchRequest, markHtmlServed, panelHtml, setPanelTransport } from './adapter/vscode';
import { buildDiffPage, buildFilePage, getEntry } from './diff';
import { repoApi } from './repoApi';
import { browse, buildPickerHtml } from './repoPicker';

// `ws` is required at runtime; the type surface used here is intentionally minimal.
const wsModule: any = require('ws');
const WebSocketServer: any = wsModule.WebSocketServer;
const WebSocket: any = wsModule.WebSocket;

const CONTENT_TYPES: { [extension: string]: string } = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2'
};

export interface ServerOptions {
	/** Directory containing `package.json`, `media` and `resources`. */
	extensionPath: string;
	/** Directory containing `bridge.js` and `theme.css`. */
	assetsDir: string;
	/** Preferred TCP port; the next free port is used if it is taken. */
	port: number;
}

/**
 * The local HTTP + WebSocket server that carries the Git Graph user interface.
 *
 * It deliberately binds to the loopback interface only: the server can run arbitrary Git
 * commands on the user's repositories, so it must never be reachable from the network.
 */
export class GitGraphServer {
	private readonly serverOptions: ServerOptions;
	private server: http.Server | null = null;
	private socketServer: any = null;
	private readonly clients = new Set<any>();
	public port = 0;

	constructor(serverOptions: ServerOptions) {
		this.serverOptions = serverOptions;
	}

	public get baseUrl() {
		return 'http://127.0.0.1:' + this.port;
	}

	/**
	 * Start listening, trying successive ports when the preferred one is unavailable.
	 */
	public async start(): Promise<number> {
		this.server = http.createServer((req, res) => this.handleRequest(req, res));
		this.socketServer = new WebSocketServer({ noServer: true });

		this.server.on('upgrade', (req, socket, head) => {
			const pathname = safePathname(req);
			if (pathname !== '/ws' || !this.isAllowedOrigin(req.headers.origin)) {
				socket.destroy();
				return;
			}
			this.socketServer!.handleUpgrade(req, socket, head, (ws: any) => this.registerClient(ws));
		});

		for (let attempt = 0; attempt < 25; attempt++) {
			const candidate = this.serverOptions.port + attempt;
			const listening = await this.tryListen(candidate);
			if (listening) {
				this.port = candidate;
				setPanelTransport({
					sendMessage: (message) => this.broadcast({ type: 'response', data: message }),
					clientCount: () => this.clients.size,
					requestReload: () => this.broadcast({ type: 'reload' })
				});
				return candidate;
			}
		}
		throw new Error('Unable to find a free port to start the Git Graph server.');
	}

	public stop() {
		for (const client of this.clients) {
			try {
				client.close();
			} catch (_) { }
		}
		this.clients.clear();
		if (this.socketServer !== null) this.socketServer.close();
		if (this.server !== null) this.server.close();
		this.server = null;
		this.socketServer = null;
		setPanelTransport(null);
	}

	private tryListen(port: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const server = this.server!;
			const onError = (error: NodeJS.ErrnoException) => {
				server.removeListener('listening', onListening);
				// Any error other than a busy port is fatal, but resolve(false) lets the caller retry
				// and eventually surface a clear message.
				resolve(false);
				void error;
			};
			const onListening = () => {
				server.removeListener('error', onError);
				resolve(true);
			};
			server.once('error', onError);
			server.once('listening', onListening);
			server.listen(port, '127.0.0.1');
		});
	}

	private registerClient(ws: any) {
		this.clients.add(ws);
		ws.on('message', (raw: any) => {
			try {
				const message = JSON.parse(raw.toString());
				if (message && message.type === 'request' && message.data) {
					dispatchRequest(message.data);
				}
			} catch (_) { }
		});
		ws.on('close', () => {
			this.clients.delete(ws);
			applyClientCount();
		});
		ws.on('error', () => {
			this.clients.delete(ws);
			applyClientCount();
		});
		applyClientCount();
	}

	private broadcast(message: unknown) {
		const payload = JSON.stringify(message);
		for (const client of this.clients) {
			if (client.readyState === WebSocket.OPEN) {
				client.send(payload);
			}
		}
	}

	private isAllowedOrigin(origin: string | undefined) {
		if (typeof origin === 'undefined') return true;
		const allowed = ['http://127.0.0.1:' + this.port, 'http://localhost:' + this.port];
		return allowed.indexOf(origin) > -1;
	}

	private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
		const pathname = safePathname(req);
		const method = req.method || 'GET';

		if (method === 'POST') {
			if (pathname.indexOf('/api/') === 0) {
				this.handleApiPost(req, res, pathname);
				return;
			}
			res.writeHead(405, { 'Content-Type': 'text/plain' });
			res.end('Method Not Allowed');
			return;
		}

		if (method !== 'GET' && method !== 'HEAD') {
			res.writeHead(405, { 'Content-Type': 'text/plain' });
			res.end('Method Not Allowed');
			return;
		}

		if (pathname === '/repos') {
			const query = queryParameter(req.url || '/', 'path') || '';
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
			res.end(buildPickerHtml(query));
			return;
		}

		if (pathname === '/api/repos') {
			this.sendJson(res, repoApi().state());
			return;
		}

		if (pathname === '/api/fs') {
			this.sendJson(res, browse(queryParameter(req.url || '/', 'path') || ''));
			return;
		}

		if (pathname === '/' || pathname === '/index.html') {
			// Nothing to show yet: send the user to the repository picker instead of an empty graph.
			if (repoApi().state().repos.length === 0) {
				res.writeHead(302, { 'Location': '/repos', 'Cache-Control': 'no-store' });
				res.end();
				return;
			}
			this.serveHtml(res);
			return;
		}

		if (pathname === '/favicon.ico') {
			res.writeHead(204);
			res.end();
			return;
		}

		if (pathname === '/api/ping') {
			res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
			res.end(JSON.stringify({ ok: true, port: this.port }));
			return;
		}

		if (pathname.startsWith('/media/')) {
			this.serveFile(res, path.join(this.serverOptions.extensionPath, 'media'), pathname.substring('/media/'.length));
			return;
		}

		if (pathname.startsWith('/diff/')) {
			this.serveGeneratedPage(res, pathname.substring('/diff/'.length), 'diff');
			return;
		}

		if (pathname.startsWith('/file/')) {
			this.serveGeneratedPage(res, pathname.substring('/file/'.length), 'file');
			return;
		}

		if (pathname.startsWith('/assets/')) {
			this.serveFile(res, this.serverOptions.assetsDir, pathname.substring('/assets/'.length));
			return;
		}

		this.serveFile(res, this.serverOptions.extensionPath, pathname.substring(1), 404);
	}

	/**
	 * Ask every open Git Graph tab to reload (used after a repository is added).
	 */
	public reloadClients() {
		this.broadcast({ type: 'reload' });
	}

	private sendJson(res: http.ServerResponse, data: unknown, status: number = 200) {
		res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
		res.end(JSON.stringify(data));
	}

	private handleApiPost(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
		readJsonBody(req, (error, body) => {
			if (error !== null) {
				this.sendJson(res, { error: error }, 400);
				return;
			}
			const target = typeof body.path === 'string' ? body.path.trim() : '';

			if (pathname === '/api/repos/add') {
				if (target === '') {
					this.sendJson(res, { error: '请提供仓库路径。' }, 400);
					return;
				}
				repoApi().addRepo(target).then(
					(result) => this.sendJson(res, result),
					(err) => this.sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
				);
				return;
			}

			if (pathname === '/api/repos/remove') {
				if (target === '') {
					this.sendJson(res, { error: '请提供仓库路径。' }, 400);
					return;
				}
				repoApi().removeRepo(target).then(
					(result) => this.sendJson(res, result.ok ? result : { error: result.error }, result.ok ? 200 : 400),
					(err) => this.sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
				);
				return;
			}

			if (pathname === '/api/roots/add') {
				if (target === '') {
					this.sendJson(res, { error: '请提供目录路径。' }, 400);
					return;
				}
				repoApi().addRoot(target).then(
					() => this.sendJson(res, { ok: true }),
					(err) => this.sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
				);
				return;
			}

			if (pathname === '/api/repos/scan') {
				repoApi().scan().then(
					() => this.sendJson(res, { ok: true }),
					(err) => this.sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
				);
				return;
			}

			this.sendJson(res, { error: 'Not Found' }, 404);
		});
	}

	private serveHtml(res: http.ServerResponse) {
		const raw = panelHtml();
		if (raw === null) {
			// The view hasn't been created yet - ask the browser to retry shortly.
			res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '1' });
			res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Git Graph</title></head>'
				+ '<body style="font-family:system-ui;padding:2rem"><h2>Git Graph is starting…</h2>'
				+ '<script>setTimeout(function(){location.reload();},600);</script></body></html>');
			return;
		}

		markHtmlServed();
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
		res.end(prepareHtml(raw, this.baseUrl));
	}

	/**
	 * Serve a page produced by the standalone diff viewer (`/diff/<id>` and `/file/<id>`).
	 */
	private serveGeneratedPage(res: http.ServerResponse, id: string, kind: 'diff' | 'file') {
		const entry = getEntry(id.split('?')[0]);
		if (entry === null || entry.kind !== kind) {
			res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Git Graph</title></head>'
				+ '<body style="font-family:system-ui;padding:2rem"><h2>这个页面已失效</h2>'
				+ '<p>请回到 Git Graph 重新打开该文件的差异。</p></body></html>');
			return;
		}

		const rendered = kind === 'diff' ? buildDiffPage(entry) : buildFilePage(entry);
		rendered.then((html) => {
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
			res.end(html);
		}, () => {
			res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
			res.end('Unable to render the file.');
		});
	}

	private serveFile(res: http.ServerResponse, rootDir: string, relativePath: string, notFoundStatus: number = 404) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(relativePath.split('?')[0]);
		} catch (_) {
			res.writeHead(400);
			res.end('Bad Request');
			return;
		}

		const absolute = path.resolve(rootDir, decoded);
		const root = path.resolve(rootDir);
		if (absolute !== root && !absolute.startsWith(root + path.sep)) {
			res.writeHead(403);
			res.end('Forbidden');
			return;
		}

		fs.stat(absolute, (err, stats) => {
			if (err || !stats.isFile()) {
				res.writeHead(notFoundStatus, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end('Not Found');
				return;
			}
			const contentType = CONTENT_TYPES[path.extname(absolute).toLowerCase()] || 'application/octet-stream';
			res.writeHead(200, {
				'Content-Type': contentType,
				'Content-Length': stats.size,
				'Cache-Control': 'no-store'
			});
			const stream = fs.createReadStream(absolute);
			stream.on('error', () => res.end());
			stream.pipe(res);
		});
	}
}

function safePathname(req: http.IncomingMessage) {
	const raw = req.url || '/';
	const queryIndex = raw.indexOf('?');
	return queryIndex > -1 ? raw.substring(0, queryIndex) : raw;
}

function queryParameter(url: string, name: string): string | null {
	const queryIndex = url.indexOf('?');
	if (queryIndex === -1) return null;
	const query = url.substring(queryIndex + 1).split('#')[0];
	for (const part of query.split('&')) {
		const equals = part.indexOf('=');
		const key = equals === -1 ? part : part.substring(0, equals);
		if (key === name) {
			try {
				return decodeURIComponent(equals === -1 ? '' : part.substring(equals + 1));
			} catch (_) {
				return '';
			}
		}
	}
	return null;
}

function readJsonBody(req: http.IncomingMessage, callback: (error: string | null, body: any) => void) {
	let raw = '';
	let finished = false;
	req.on('data', (chunk) => {
		if (finished) return;
		raw += chunk;
		if (raw.length > 64 * 1024) {
			finished = true;
			callback('Request body is too large', {});
			req.destroy();
		}
	});
	req.on('end', () => {
		if (finished) return;
		finished = true;
		if (raw.trim() === '') {
			callback(null, {});
			return;
		}
		try {
			callback(null, JSON.parse(raw));
		} catch (_) {
			callback('Invalid JSON body', {});
		}
	});
	req.on('error', () => {
		if (finished) return;
		finished = true;
		callback('Unable to read the request body', {});
	});
}

/**
 * Adapt the document produced by the web view so it works outside of VS Code:
 *   - allow the WebSocket connection through the Content-Security-Policy
 *   - load the standalone theme variables
 *   - load the `acquireVsCodeApi` bridge before the web view bundle runs
 */
export function prepareHtml(html: string, baseUrl: string): string {
	const nonceMatch = /nonce="([^"]+)"/.exec(html);
	const nonce = nonceMatch !== null ? nonceMatch[1] : 'standalone';
	const wsOrigin = baseUrl.replace(/^http/, 'ws');

	let output = html.replace(
		"default-src 'none';",
		"default-src 'none'; connect-src 'self' " + wsOrigin + ' ' + wsOrigin.replace(/^ws/, 'wss') + ';'
	);

	const injection = '<link rel="stylesheet" type="text/css" href="/assets/theme.css">'
		+ '<script nonce="' + nonce + '" src="/assets/bridge.js"></script>';

	if (output.indexOf('</head>') > -1) {
		output = output.replace('</head>', '\t\t\t\t' + injection + '\n\t\t\t</head>');
	} else {
		output = injection + output;
	}

	// Floating link to the repository picker: the only UI element the standalone app adds on top
	// of the unmodified web front-end.
	const repoLinkStyle = '<style>'
		+ '#gg-repos-link{position:fixed;right:16px;bottom:16px;z-index:2147483647;display:inline-flex;'
		+ 'align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:rgba(0,120,212,.85);'
		+ 'color:#fff;font:12px/1 system-ui,sans-serif;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.25);'
		+ 'opacity:.6;transition:opacity .15s}'
		+ '#gg-repos-link:hover{opacity:1}'
		+ '</style>'
		+ '<a id="gg-repos-link" href="/repos" target="_blank" title="添加 / 切换仓库">＋ 仓库</a>';

	if (output.indexOf('</body>') > -1) {
		output = output.replace('</body>', repoLinkStyle + '\n</body>');
	} else {
		output += repoLinkStyle;
	}
	return output;
}

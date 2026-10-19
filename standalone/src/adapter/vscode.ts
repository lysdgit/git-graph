/**
 * A stand-in for the `vscode` module used by the Git Graph sources.
 *
 * The original extension code talks to Visual Studio Code through a small, well defined surface.
 * This adapter implements that surface on top of plain Node.js primitives so the very same
 * data source, repository manager and web view logic can run inside a standalone process:
 *
 *   - `WebviewPanel`       -> a browser tab reached over HTTP + WebSocket
 *   - `FileSystemWatcher`  -> `fs.watch` with the same ignore rules as VS Code
 *   - `Memento`            -> JSON files in the app's data directory
 *   - configuration        -> defaults from package.json + a user settings JSON file
 *   - clipboard / browser  -> native OS helpers (clip, pbcopy, start, open, xdg-open)
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createDiffEntry, DiffSideSpec } from '../diff';
import { JsonMemento } from './state';
import { RecursiveWatcher } from './watcher';

/* ------------------------------------------------------------------ *
 * Shim environment
 * ------------------------------------------------------------------ */

export interface ShimOptions {
	/** Absolute path of the directory that contains `package.json`, `media` and `resources`. */
	extensionPath: string;
	/** Directory where logs and persisted state are written. */
	dataDir: string;
	/** Base URL of the local server, e.g. `http://127.0.0.1:7583`. */
	httpBase: string;
	/** Folders that are scanned for Git repositories (replaces the VS Code workspace). */
	workspaceRoots: string[];
	/** User overrides keyed by the full configuration key, e.g. `git-graph.dateFormat`. */
	userConfig: { [key: string]: any };
	/** Optional sink for diagnostic messages (usually the Git Graph output channel). */
	log?: (message: string) => void;
	/** When false, pages are only logged instead of being opened in the browser (headless mode). */
	browserEnabled?: boolean;
}

let options: ShimOptions = {
	extensionPath: process.cwd(),
	dataDir: path.join(process.cwd(), 'standalone-data'),
	httpBase: 'http://127.0.0.1:7583',
	workspaceRoots: [process.cwd()],
	userConfig: {},
	browserEnabled: true
};

let configurationDefaults: { [key: string]: any } | null = null;

/**
 * Configure the shim. Must be called before any of the extension modules are used.
 */
export function configureShim(next: Partial<ShimOptions>) {
	options = Object.assign({}, options, next);
	configurationDefaults = null;
}

export function shimOptions() {
	return options;
}

/* ------------------------------------------------------------------ *
 * Basic types
 * ------------------------------------------------------------------ */

export type Thenable<T> = PromiseLike<T>;

export interface Disposable {
	dispose(): any;
}

export type Event<T> = (listener: (e: T) => any) => Disposable;

export function toDisposable(fn: () => void): Disposable {
	return { dispose: fn };
}

/* ------------------------------------------------------------------ *
 * Uri
 * ------------------------------------------------------------------ */

type UriComponents = {
	scheme?: string;
	authority?: string;
	path?: string;
	query?: string;
	fragment?: string;
};

export class Uri {
	public readonly scheme: string;
	public readonly authority: string;
	public readonly path: string;
	public readonly query: string;
	public readonly fragment: string;
	private readonly nativePath: string | null;

	constructor(scheme: string, authority: string, uriPath: string, query: string, fragment: string, nativePath: string | null = null) {
		this.scheme = scheme;
		this.authority = authority;
		this.path = uriPath;
		this.query = query;
		this.fragment = fragment;
		this.nativePath = nativePath;
	}

	get fsPath(): string {
		return this.nativePath !== null ? this.nativePath : this.path;
	}

	public static file(filePath: string): Uri {
		const native = path.normalize(filePath);
		let uriPath = native.replace(/\\/g, '/');
		if (!uriPath.startsWith('/')) uriPath = '/' + uriPath;
		return new Uri('file', '', uriPath, '', '', native);
	}

	public static parse(value: string): Uri {
		const match = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
		if (match !== null) {
			return new Uri(match[1], match[2], decodeURI(match[3] || ''), match[4] || '', match[5] || '');
		}
		return Uri.file(value);
	}

	public with(change: UriComponents): Uri {
		const scheme = typeof change.scheme === 'string' ? change.scheme : this.scheme;
		const authority = typeof change.authority === 'string' ? change.authority : this.authority;
		const uriPath = typeof change.path === 'string' ? change.path : this.path;
		const query = typeof change.query === 'string' ? change.query : this.query;
		const fragment = typeof change.fragment === 'string' ? change.fragment : this.fragment;
		const nativePath = scheme === 'file'
			? (typeof change.path === 'string' ? change.path : this.fsPath)
			: null;
		return new Uri(scheme, authority, uriPath, query, fragment, nativePath);
	}

	public toString(): string {
		if (this.scheme === 'file') {
			return 'file://' + encodeURI(this.path);
		}
		let result = this.scheme + '://' + this.authority + this.path;
		if (this.query !== '') result += '?' + this.query;
		if (this.fragment !== '') result += '#' + this.fragment;
		return result;
	}
}

/* ------------------------------------------------------------------ *
 * EventEmitter
 * ------------------------------------------------------------------ */

export class EventEmitter<T> implements Disposable {
	private listeners: Array<(e: T) => any> = [];

	public readonly event: Event<T> = (listener: (e: T) => any) => {
		this.listeners.push(listener);
		return {
			dispose: () => {
				const index = this.listeners.indexOf(listener);
				if (index > -1) this.listeners.splice(index, 1);
			}
		};
	};

	public fire(data: T) {
		for (const listener of this.listeners.slice()) {
			try {
				listener(data);
			} catch (_) { }
		}
	}

	public dispose() {
		this.listeners = [];
	}
}

/* ------------------------------------------------------------------ *
 * Enums & constants
 * ------------------------------------------------------------------ */

export enum ViewColumn {
	Active = -1,
	Beside = -2,
	One = 1,
	Two = 2,
	Three = 3,
	Four = 4,
	Five = 5,
	Six = 6,
	Seven = 7,
	Eight = 8,
	Nine = 9
}

export enum StatusBarAlignment {
	Left = 1,
	Right = 2
}

export const version = '1.30.0';

/* ------------------------------------------------------------------ *
 * State (Memento / ExtensionContext)
 * ------------------------------------------------------------------ */

export interface Memento {
	get<T>(key: string, defaultValue?: T): T;
	update(key: string, value: any): Thenable<void>;
	keys(): readonly string[];
}

export interface ExtensionContext {
	subscriptions: Disposable[];
	extensionPath: string;
	extensionUri: Uri;
	globalStoragePath: string;
	globalState: Memento;
	workspaceState: Memento;
}

let extensionContext: ExtensionContext | null = null;

/**
 * Create (once) the extension context handed to Git Graph's ExtensionState.
 */
export function createExtensionContext(): ExtensionContext {
	if (extensionContext !== null) return extensionContext;
	const storagePath = path.join(options.dataDir, 'storage');
	ensureDirectory(storagePath);
	extensionContext = {
		subscriptions: [],
		extensionPath: options.extensionPath,
		extensionUri: Uri.file(options.extensionPath),
		globalStoragePath: storagePath,
		globalState: new JsonMemento(path.join(options.dataDir, 'globalState.json')),
		workspaceState: new JsonMemento(path.join(options.dataDir, 'workspaceState.json'))
	};
	return extensionContext;
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

export interface ConfigurationChangeEvent {
	affectsConfiguration(section: string, scope?: Uri): boolean;
}

export interface WorkspaceConfiguration {
	get<T>(section: string): T | undefined;
	get<T>(section: string, defaultValue: T): T;
	has(section: string): boolean;
	inspect<T>(section: string): { key: string; defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined;
	update(section: string, value: any, configurationTarget?: any, overrideInLanguage?: boolean): Thenable<void>;
}

function loadConfigurationDefaults(): { [key: string]: any } {
	if (configurationDefaults !== null) return configurationDefaults;
	const result: { [key: string]: any } = {};
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(options.extensionPath, 'package.json')).toString());
		const configuration = pkg.contributes ? pkg.contributes.configuration : null;
		const collect = (node: any) => {
			if (!node) return;
			if (Array.isArray(node)) {
				node.forEach(collect);
			} else if (node.properties && typeof node.properties === 'object') {
				for (const key of Object.keys(node.properties)) {
					result[key] = node.properties[key].default;
				}
			}
		};
		collect(configuration);
	} catch (_) { }
	configurationDefaults = result;
	return result;
}

class WorkspaceConfigurationImpl implements WorkspaceConfiguration {
	private readonly section: string;

	constructor(section: string) {
		this.section = section;
	}

	public get<T>(section: string, defaultValue?: T): T {
		const key = this.section === '' ? section : this.section + '.' + section;
		const user = options.userConfig;
		if (Object.prototype.hasOwnProperty.call(user, key)) return user[key] as T;
		const defaults = loadConfigurationDefaults();
		if (Object.prototype.hasOwnProperty.call(defaults, key)) return defaults[key] as T;
		return defaultValue as T;
	}

	public has(section: string) {
		const key = this.section === '' ? section : this.section + '.' + section;
		return Object.prototype.hasOwnProperty.call(options.userConfig, key)
			|| Object.prototype.hasOwnProperty.call(loadConfigurationDefaults(), key);
	}

	public inspect<T>(section: string) {
		const key = this.section === '' ? section : this.section + '.' + section;
		const defaults = loadConfigurationDefaults();
		const user = options.userConfig;
		return {
			key: key,
			defaultValue: defaults[key] as T | undefined,
			globalValue: Object.prototype.hasOwnProperty.call(user, key) ? user[key] as T : undefined,
			workspaceValue: undefined,
			workspaceFolderValue: undefined
		};
	}

	public update(): Thenable<void> {
		return Promise.resolve();
	}
}

/* ------------------------------------------------------------------ *
 * File system watcher
 * ------------------------------------------------------------------ */

export interface FileSystemWatcher extends Disposable {
	onDidCreate: Event<Uri>;
	onDidChange: Event<Uri>;
	onDidDelete: Event<Uri>;
}

const noopDisposable: Disposable = { dispose: () => { } };

class FileSystemWatcherImpl implements FileSystemWatcher {
	private readonly createEmitter = new EventEmitter<Uri>();
	private readonly changeEmitter = new EventEmitter<Uri>();
	private readonly deleteEmitter = new EventEmitter<Uri>();
	private readonly watcher: RecursiveWatcher | null;

	constructor(globPattern: string) {
		const root = globRoot(globPattern);
		this.watcher = root === null ? null : new RecursiveWatcher(root, {
			onDidCreate: (filePath) => this.createEmitter.fire(Uri.file(filePath)),
			onDidChange: (filePath) => this.changeEmitter.fire(Uri.file(filePath)),
			onDidDelete: (filePath) => this.deleteEmitter.fire(Uri.file(filePath))
		});
		if (this.watcher !== null) this.watcher.start();
	}

	public get onDidCreate() { return this.createEmitter.event; }
	public get onDidChange() { return this.changeEmitter.event; }
	public get onDidDelete() { return this.deleteEmitter.event; }

	public dispose() {
		if (this.watcher !== null) this.watcher.dispose();
		this.createEmitter.dispose();
		this.changeEmitter.dispose();
		this.deleteEmitter.dispose();
	}
}

/**
 * Extract the directory a VS Code glob pattern is rooted at. Patterns that can't be rooted in a
 * single directory (e.g. `**\/*.json`) return null, and produce an inert watcher.
 */
function globRoot(globPattern: string): string | null {
	if (globPattern.endsWith('/**')) {
		const root = globPattern.substring(0, globPattern.length - 3);
		if (root !== '' && root.indexOf('*') === -1) return root;
	}
	return null;
}

/* ------------------------------------------------------------------ *
 * Webview panel
 * ------------------------------------------------------------------ */

export interface Webview {
	html: string;
	options: any;
	readonly cspSource: string;
	asWebviewUri(uri: Uri): Uri;
	postMessage(message: any): Thenable<boolean>;
	onDidReceiveMessage(listener: (message: any) => any): Disposable;
}

export interface WebviewPanel extends Disposable {
	readonly viewType: string;
	title: string;
	iconPath: any;
	readonly webview: Webview;
	readonly visible: boolean;
	readonly active: boolean;
	readonly onDidDispose: Event<void>;
	readonly onDidChangeViewState: Event<any>;
	reveal(viewColumn?: ViewColumn, preserveFocus?: boolean): void;
}

/**
 * The bridge to the browser: implemented by the HTTP/WebSocket server.
 */
export interface PanelTransport {
	sendMessage(message: unknown): void;
	clientCount(): number;
	requestReload(): void;
}

let transport: PanelTransport | null = null;
let currentPanel: WebviewPanelImpl | null = null;

export function setPanelTransport(nextTransport: PanelTransport | null) {
	transport = nextTransport;
	applyClientCount();
}

/**
 * Called by the server whenever the number of connected browsers changes, so the panel's
 * `visible` state (and therefore the view's refresh behaviour) follows reality.
 */
export function applyClientCount() {
	if (currentPanel === null) return;
	currentPanel.setVisible(transport !== null && transport.clientCount() > 0);
}

/** Called by the server when a message arrives from the browser. */
export function dispatchRequest(message: any) {
	if (currentPanel !== null) currentPanel.receive(message);
}

export function panelHtml(): string | null {
	return currentPanel === null ? null : currentPanel.getHtml();
}

export function markHtmlServed() {
	if (currentPanel !== null) currentPanel.markServed();
}

/** Remove the CSP nonces from a generated document, so two renders can be compared. */
function stripNonces(html: string) {
	if (html.indexOf('nonce') === -1) return html;
	return html
		.replace(/nonce="[^"]*"/g, 'nonce=""')
		.replace(/'nonce-[^']*'/g, "'nonce-'");
}

class WebviewImpl implements Webview {
	private readonly panel: WebviewPanelImpl;
	private htmlValue: string = '';

	constructor(panel: WebviewPanelImpl) {
		this.panel = panel;
	}

	public get html(): string {
		return this.htmlValue;
	}

	public set html(value: string) {
		// `getHtmlForWebview()` mints a fresh nonce every time it runs, so an unchanged document
		// would otherwise look different on every call. Comparing the documents without their
		// nonces is what tells us whether a reload is genuinely required.
		const changed = stripNonces(this.htmlValue) !== stripNonces(value);
		this.htmlValue = value;
		// Once a browser has loaded a page, a changed document (e.g. a different repository set)
		// is delivered by reloading it, exactly like VS Code re-renders a webview.
		// Reloading on an unchanged document would loop forever: the reload reconnects the
		// browser, which makes the view visible again, which calls `update()` and sets the HTML.
		if (changed && this.panel.served && transport !== null && transport.clientCount() > 0) {
			transport.requestReload();
		}
	}

	public get options(): any {
		return {};
	}

	public get cspSource(): string {
		return options.httpBase;
	}

	public asWebviewUri(uri: Uri): Uri {
		const mediaDir = path.join(options.extensionPath, 'media');
		const filePath = uri.fsPath;
		const relative = path.relative(mediaDir, filePath);
		if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
			return Uri.parse(options.httpBase + '/media/' + relative.replace(/\\/g, '/'));
		}
		return uri;
	}

	public postMessage(message: any): Thenable<boolean> {
		if (transport !== null) transport.sendMessage(message);
		return Promise.resolve(true);
	}

	public onDidReceiveMessage(listener: (message: any) => any): Disposable {
		return this.panel.onRequest(listener);
	}
}

class WebviewPanelImpl implements WebviewPanel {
	public readonly viewType: string;
	public title: string;
	public iconPath: any = undefined;
	public readonly webview: Webview;
	public served = false;

	private isVisible = false;
	private readonly disposeEmitter = new EventEmitter<void>();
	private readonly viewStateEmitter = new EventEmitter<{ visible: boolean }>();
	private readonly requestEmitter = new EventEmitter<any>();

	constructor(viewType: string, title: string) {
		this.viewType = viewType;
		this.title = title;
		this.webview = new WebviewImpl(this);
	}

	public get visible() { return this.isVisible; }
	public get active() { return this.isVisible; }
	public get onDidDispose() { return this.disposeEmitter.event; }
	public get onDidChangeViewState() { return this.viewStateEmitter.event; }

	public setVisible(visible: boolean) {
		if (this.isVisible === visible) return;
		this.isVisible = visible;
		this.viewStateEmitter.fire({ visible: visible });
	}

	public getHtml() { return this.webview.html; }

	public markServed() { this.served = true; }

	public receive(message: any) { this.requestEmitter.fire(message); }

	public onRequest(listener: (message: any) => any): Disposable {
		return this.requestEmitter.event(listener);
	}

	public reveal() { }

	public dispose() {
		if (currentPanel === this) currentPanel = null;
		this.disposeEmitter.fire();
		this.disposeEmitter.dispose();
		this.viewStateEmitter.dispose();
		this.requestEmitter.dispose();
	}
}

/* ------------------------------------------------------------------ *
 * Output channel & logging
 * ------------------------------------------------------------------ */

export interface OutputChannel extends Disposable {
	readonly name: string;
	append(value: string): void;
	appendLine(value: string): void;
	replace(value: string): void;
	clear(): void;
	show(preserveFocus?: boolean): void;
	hide(): void;
}

class OutputChannelImpl implements OutputChannel {
	public readonly name: string;
	private readonly logFile: string;

	constructor(name: string) {
		this.name = name;
		this.logFile = path.join(options.dataDir, 'logs', 'git-graph.log');
		ensureDirectory(path.dirname(this.logFile));
	}

	public append(value: string) {
		process.stdout.write(value);
		this.toFile(value);
	}

	public appendLine(value: string) {
		process.stdout.write(value + '\n');
		this.toFile(value + '\n');
	}

	public replace(value: string) {
		this.appendLine(value);
	}

	public clear() { }

	public show() { }

	public hide() { }

	public dispose() { }

	private toFile(value: string) {
		try {
			fs.appendFileSync(this.logFile, value);
		} catch (_) { }
	}
}

/* ------------------------------------------------------------------ *
 * Terminal & status bar
 * ------------------------------------------------------------------ */

export interface TerminalOptions {
	name?: string;
	cwd?: string;
	env?: { [key: string]: string | null };
	shellPath?: string;
	shellArgs?: string[];
}

export interface Terminal extends Disposable {
	readonly name: string;
	sendText(text: string, addNewLine?: boolean): void;
	show(preserveFocus?: boolean): void;
	hide(): void;
}

class TerminalImpl implements Terminal {
	public readonly name: string;
	private readonly cwd: string;
	private readonly commands: string[] = [];

	constructor(terminalOptions: TerminalOptions) {
		this.name = terminalOptions.name || 'Terminal';
		this.cwd = terminalOptions.cwd || process.cwd();
	}

	public sendText(text: string) {
		this.commands.push(text);
	}

	public show() {
		openTerminal(this.cwd, this.commands.join(' && '));
	}

	public hide() { }

	public dispose() { }
}

export interface StatusBarItem extends Disposable {
	alignment: StatusBarAlignment;
	priority?: number;
	text: string;
	tooltip: string | undefined;
	color: string | undefined;
	command: string | undefined;
	show(): void;
	hide(): void;
}

class StatusBarItemImpl implements StatusBarItem {
	public alignment = StatusBarAlignment.Left;
	public priority = 0;
	public text = '';
	public tooltip: string | undefined = undefined;
	public color: string | undefined = undefined;
	public command: string | undefined = undefined;
	public show() { }
	public hide() { }
	public dispose() { }
}

/* ------------------------------------------------------------------ *
 * OS helpers
 * ------------------------------------------------------------------ */

/**
 * Recursively create a directory (the Node 8 typings used for compilation predate `recursive`).
 */
export function ensureDirectory(directory: string) {
	try {
		(fs as any).mkdirSync(directory, { recursive: true });
	} catch (_) { }
}

function writeClipboard(text: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let command: string;
		let args: string[];
		if (process.platform === 'win32') {
			command = 'clip';
			args = [];
		} else if (process.platform === 'darwin') {
			command = 'pbcopy';
			args = [];
		} else {
			command = 'xclip';
			args = ['-selection', 'clipboard'];
		}
		try {
			const child = cp.spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
			child.on('error', reject);
			child.on('close', (code) => code === 0 ? resolve() : reject(new Error('clipboard exit code ' + code)));
			child.stdin.end(text);
		} catch (error) {
			reject(error);
		}
	});
}

function openWithSystem(target: string, workingDirectory?: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		try {
			let child: cp.ChildProcess;
			if (process.platform === 'win32') {
				child = cp.spawn('cmd.exe', ['/c', 'start', '', target], {
					cwd: workingDirectory,
					detached: true,
					stdio: 'ignore'
				});
			} else if (process.platform === 'darwin') {
				child = cp.spawn('open', [target], { detached: true, stdio: 'ignore' });
			} else {
				child = cp.spawn('xdg-open', [target], { cwd: workingDirectory, detached: true, stdio: 'ignore' });
			}
			child.on('error', () => resolve(false));
			child.unref();
			resolve(true);
		} catch (_) {
			resolve(false);
		}
	});
}

function openTerminal(cwd: string, command: string) {
	if (process.platform === 'win32') {
		const inner = command === '' ? 'cd /d "' + cwd + '"' : 'cd /d "' + cwd + '" && ' + command;
		cp.spawn('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', inner], { detached: true, stdio: 'ignore' }).unref();
	} else if (process.platform === 'darwin') {
		cp.spawn('open', ['-a', 'Terminal', cwd], { detached: true, stdio: 'ignore' }).unref();
	} else {
		cp.spawn('x-terminal-emulator', ['--working-directory=' + cwd], { detached: true, stdio: 'ignore' }).unref();
	}
}

/* ------------------------------------------------------------------ *
 * The `vscode` namespace members used by Git Graph
 * ------------------------------------------------------------------ */

export interface WorkspaceFolder {
	readonly uri: Uri;
	readonly name: string;
	readonly index: number;
}

export interface TextDocumentContentProvider {
	onDidChange?: Event<Uri>;
	provideTextDocumentContent(uri: Uri): string | Thenable<string>;
}

export interface QuickPickItem {
	label: string;
	description?: string;
	detail?: string;
	picked?: boolean;
	alwaysShow?: boolean;
}

const configurationEmitter = new EventEmitter<ConfigurationChangeEvent>();
const workspaceFoldersEmitter = new EventEmitter<any>();
const textDocumentCloseEmitter = new EventEmitter<any>();

export const workspace = {
	get workspaceFolders(): WorkspaceFolder[] | undefined {
		const roots = options.workspaceRoots.filter((root) => root !== '');
		if (roots.length === 0) return undefined;
		return roots.map((root, index) => ({
			uri: Uri.file(root),
			name: path.basename(root) || root,
			index: index
		}));
	},
	getConfiguration(section?: string, _scope?: Uri | null): WorkspaceConfiguration {
		return new WorkspaceConfigurationImpl(section || '');
	},
	createFileSystemWatcher(globPattern: string): FileSystemWatcher {
		return new FileSystemWatcherImpl(globPattern);
	},
	registerTextDocumentContentProvider(_scheme: string, _provider: TextDocumentContentProvider): Disposable {
		return noopDisposable;
	},
	onDidChangeConfiguration(listener: (e: ConfigurationChangeEvent) => any): Disposable {
		return configurationEmitter.event(listener);
	},
	onDidChangeWorkspaceFolders(listener: (e: any) => any): Disposable {
		return workspaceFoldersEmitter.event(listener);
	},
	onDidCloseTextDocument(listener: (e: any) => any): Disposable {
		return textDocumentCloseEmitter.event(listener);
	}
};

/**
 * Notify Git Graph that the user settings file changed (used for live configuration updates).
 */
export function fireConfigurationChanged(affects: (section: string) => boolean) {
	configurationEmitter.fire({ affectsConfiguration: affects });
}

export const window = {
	activeTextEditor: undefined as any,

	createWebviewPanel(viewType: string, title: string, _showOptions?: any, _panelOptions?: any): WebviewPanel {
		const panel = new WebviewPanelImpl(viewType, title);
		currentPanel = panel;
		applyClientCount();
		return panel;
	},

	createOutputChannel(name: string): OutputChannel {
		return new OutputChannelImpl(name);
	},

	createStatusBarItem(_alignment?: StatusBarAlignment, _priority?: number): StatusBarItem {
		return new StatusBarItemImpl();
	},

	createTerminal(terminalOptions?: TerminalOptions): Terminal {
		return new TerminalImpl(terminalOptions || {});
	},

	showInformationMessage(_message: string, ..._rest: any[]): Thenable<string | undefined> {
		return Promise.resolve(undefined);
	},

	showWarningMessage(_message: string, ..._rest: any[]): Thenable<string | undefined> {
		return Promise.resolve(undefined);
	},

	showErrorMessage(_message: string, ..._rest: any[]): Thenable<string | undefined> {
		return Promise.resolve(undefined);
	},

	showOpenDialog(_options?: any): Thenable<Uri[] | undefined> {
		return Promise.resolve(undefined);
	},

	showSaveDialog(_options?: any): Thenable<Uri | undefined> {
		return Promise.resolve(undefined);
	},

	showQuickPick(_items: any, _options?: any): Thenable<any> {
		return Promise.resolve(undefined);
	},

	showInputBox(_options?: any): Thenable<string | undefined> {
		return Promise.resolve(undefined);
	},

	onDidChangeActiveTextEditor(_listener: (e: any) => any): Disposable {
		return noopDisposable;
	}
};

const commandHandlers: { [command: string]: (...args: any[]) => any } = {};

export const commands = {
	registerCommand(command: string, callback: (...args: any[]) => any): Disposable {
		commandHandlers[command] = callback;
		return toDisposable(() => {
			delete commandHandlers[command];
		});
	},

	executeCommand(command: string, ...args: any[]): Thenable<any> {
		switch (command) {
			case 'setContext':
				return Promise.resolve(undefined);
			case 'vscode.open':
				return openUri(args[0]);
			case 'vscode.diff':
				return openDiff(args[0], args[1], typeof args[2] === 'string' ? args[2] : 'Diff');
			case 'workbench.action.openSettings':
				return openWithSystem(path.join(options.dataDir, 'settings.json'));
			case 'workbench.view.scm':
				return Promise.reject(new Error('The Source Control view is not available in the standalone app.'));
			default: {
				const handler = commandHandlers[command];
				if (typeof handler === 'function') {
					return Promise.resolve(handler(...args));
				}
				return Promise.resolve(undefined);
			}
		}
	}
};

/**
 * Decode the data that `DiffDocProvider.encodeDiffDocUri` stores in a `git-graph://` URI.
 */
interface GitGraphUriData {
	filePath: string;
	commit: string;
	repo: string;
	exists: boolean;
}

function decodeGitGraphUri(uri: Uri): GitGraphUriData | null {
	try {
		return JSON.parse(Buffer.from(uri.query, 'base64').toString());
	} catch (_) {
		return null;
	}
}

function shortenCommit(commit: string) {
	// Keep a trailing `^` (used for "the parent of this commit"), shortens only the hash part.
	let suffix = '';
	while (commit.length > 0 && commit.charAt(commit.length - 1) === '^') {
		suffix += '^';
		commit = commit.substring(0, commit.length - 1);
	}
	if (commit.length > 8) commit = commit.substring(0, 7);
	return commit + suffix;
}

/**
 * Turn one side of a `vscode.diff` call into a description the diff viewer understands.
 */
function toDiffSide(uri: any): DiffSideSpec | null {
	if (!(uri instanceof Uri)) return null;
	if (uri.scheme === 'file') {
		return { kind: 'working', repo: null, commit: null, filePath: null, absolutePath: uri.fsPath, label: '工作区' };
	}
	if (uri.scheme === 'git-graph') {
		const data = decodeGitGraphUri(uri);
		if (data === null) return null;
		return {
			kind: data.exists ? 'commit' : 'empty',
			repo: data.repo,
			commit: data.commit,
			filePath: data.filePath,
			absolutePath: null,
			label: shortenCommit(data.commit)
		};
	}
	return null;
}

/**
 * Replace the VS Code diff editor with a page rendered by the local server.
 */
function openDiff(left: any, right: any, title: string): Thenable<any> {
	const leftSide = toDiffSide(left);
	const rightSide = toDiffSide(right);
	if (leftSide === null || rightSide === null) {
		return Promise.reject(new Error('Unable to open the diff view for the requested resource.'));
	}

	const filePath = rightSide.filePath || leftSide.filePath || rightSide.absolutePath || leftSide.absolutePath || title;
	const entry = createDiffEntry({
		kind: 'diff',
		title: title,
		filePath: filePath,
		subtitle: '',
		left: leftSide,
		right: rightSide
	});
	const url = options.httpBase + '/diff/' + entry.id;
	if (options.log) options.log('Opened diff view: ' + url + ' (' + title + ')');
	if (options.browserEnabled === false) return Promise.resolve(null);
	return openWithSystem(url).then((opened) => {
		if (!opened) throw new Error('Unable to open the default browser.');
		return null;
	});
}

function openFileAtRevision(uri: Uri): Thenable<void> {
	const side = toDiffSide(uri);
	if (side === null) {
		return Promise.reject(new Error('Unable to open the requested revision of the file.'));
	}
	const title = uri.path !== '' ? uri.path : (side.filePath || '');
	const entry = createDiffEntry({
		kind: 'file',
		title: title,
		filePath: side.filePath || '',
		subtitle: '',
		left: side,
		right: side
	});
	const url = options.httpBase + '/file/' + entry.id;
	if (options.log) options.log('Opened file view: ' + url + ' (' + title + ')');
	if (options.browserEnabled === false) return Promise.resolve();
	return openWithSystem(url).then((opened) => {
		if (!opened) throw new Error('Unable to open the default browser.');
	});
}

function openUri(uri: any): Thenable<void> {
	if (uri instanceof Uri) {
		if (uri.scheme === 'file') {
			return openWithSystem(uri.fsPath).then(() => undefined);
		}
		if (uri.scheme === 'git-graph') {
			return openFileAtRevision(uri);
		}
		return Promise.reject(new Error('Unable to open the "' + uri.scheme + '" resource in the standalone app.'));
	}
	return Promise.reject(new Error('Unable to open the requested resource.'));
}

export const env = {
	clipboard: {
		writeText: (text: string): Thenable<void> => writeClipboard(text)
	},
	openExternal: (uri: Uri): Thenable<boolean> => openWithSystem(uri.toString()),
	sessionId: 'standalone-' + Math.random().toString(36).substring(2),
	machineId: 'standalone',
	appName: 'Git Graph Standalone',
	language: 'en'
};

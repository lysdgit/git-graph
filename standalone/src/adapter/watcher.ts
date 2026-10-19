import * as fs from 'fs';
import * as path from 'path';

/**
 * Path segments that should never be watched. These mirror the defaults that Visual Studio Code
 * applies through `files.watcherExclude`, and keep the watcher's memory footprint low on large
 * repositories (most importantly `node_modules` and the Git object store).
 */
const IGNORED_PATTERNS = [
	'/node_modules/',
	'/.git/objects/',
	'/.git/subtree-cache/',
	'/.hg/store/'
];

export interface WatcherHandlers {
	onDidCreate: (filePath: string) => void;
	onDidChange: (filePath: string) => void;
	onDidDelete: (filePath: string) => void;
	onError?: (error: Error) => void;
}

/**
 * A recursive file watcher built on `fs.watch`, which uses the operating system's native change
 * notifications (ReadDirectoryChangesW on Windows, FSEvents / inotify elsewhere). This is much
 * lighter than a library such as chokidar that keeps a full tree of watched paths in memory.
 */
export class RecursiveWatcher {
	private readonly root: string;
	private readonly handlers: WatcherHandlers;
	private watcher: fs.FSWatcher | null = null;
	private disposed = false;

	constructor(root: string, handlers: WatcherHandlers) {
		this.root = root;
		this.handlers = handlers;
	}

	public start() {
		if (this.watcher !== null || this.disposed) return;
		if (!isDirectory(this.root)) return;

		try {
			const watcher: fs.FSWatcher = (fs as any).watch(this.root, { recursive: true, persistent: false }, (eventType: string, fileName: any) => {
				this.handleEvent(eventType, fileName === null || typeof fileName === 'undefined' ? null : fileName.toString());
			});
			watcher.on('error', (error) => {
				if (this.handlers.onError) this.handlers.onError(error as Error);
			});
			this.watcher = watcher;
		} catch (error) {
			if (this.handlers.onError) this.handlers.onError(error as Error);
		}
	}

	public dispose() {
		this.disposed = true;
		if (this.watcher !== null) {
			try {
				this.watcher.close();
			} catch (_) { }
			this.watcher = null;
		}
	}

	private handleEvent(eventType: string, fileName: string | null) {
		if (this.disposed || fileName === null) return;

		const normalised = fileName.replace(/\\/g, '/');
		if (IGNORED_PATTERNS.some((pattern) => normalised.indexOf(pattern) > -1)) return;

		const fullPath = path.join(this.root, fileName);
		if (eventType === 'change') {
			this.handlers.onDidChange(fullPath);
			return;
		}

		// `rename` is emitted for both creation and deletion, so the file system decides which it was.
		fs.stat(fullPath, (err) => {
			if (this.disposed) return;
			if (err) {
				this.handlers.onDidDelete(fullPath);
			} else {
				this.handlers.onDidCreate(fullPath);
			}
		});
	}
}

function isDirectory(target: string) {
	try {
		return fs.statSync(target).isDirectory();
	} catch (_) {
		return false;
	}
}

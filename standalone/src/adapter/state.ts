import * as fs from 'fs';
import * as path from 'path';

/**
 * A minimal implementation of the `vscode.Memento` API, persisted as a JSON file. Writes are
 * debounced so that frequent state updates (column widths, code review progress, …) don't cause a
 * disk write per message.
 */
export class JsonMemento {
	private readonly file: string;
	private data: { [key: string]: any } = {};
	private saveTimer: NodeJS.Timer | null = null;

	constructor(file: string) {
		this.file = file;
		this.load();
	}

	/**
	 * Get a stored value.
	 */
	public get<T>(key: string, defaultValue?: T): T {
		if (Object.prototype.hasOwnProperty.call(this.data, key)) {
			return this.data[key] as T;
		}
		return defaultValue as T;
	}

	/**
	 * Store a value. Returns a promise that resolves once the change has been flushed to disk.
	 */
	public update(key: string, value: any): Promise<void> {
		this.data[key] = value;
		this.scheduleSave();
		return Promise.resolve();
	}

	/**
	 * Get all stored keys.
	 */
	public keys(): readonly string[] {
		return Object.keys(this.data);
	}

	/**
	 * Write any pending changes to disk immediately.
	 */
	public flush() {
		if (this.saveTimer !== null) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		this.save();
	}

	private load() {
		try {
			const contents = fs.readFileSync(this.file).toString();
			const parsed = JSON.parse(contents);
			if (parsed !== null && typeof parsed === 'object') {
				this.data = parsed;
			}
		} catch (_) {
			this.data = {};
		}
	}

	private scheduleSave() {
		if (this.saveTimer !== null) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			this.save();
		}, 250);
	}

	private save() {
		try {
			(fs as any).mkdirSync(path.dirname(this.file), { recursive: true });
			const temp = this.file + '.tmp';
			fs.writeFileSync(temp, JSON.stringify(this.data, null, '\t'));
			fs.renameSync(temp, this.file);
		} catch (_) { }
	}
}

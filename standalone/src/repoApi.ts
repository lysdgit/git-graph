/**
 * Repository management API used by the standalone repository picker page.
 *
 * The VS Code version of Git Graph adds repositories through `window.showOpenDialog` /
 * `showQuickPick`, neither of which exists in a browser. Instead the local server exposes a
 * small JSON API that the picker page calls; the handlers are supplied by `main.ts`, so the
 * actual work still goes through the unmodified `RepoManager`.
 */

export interface RepoEntry {
	path: string;
	name: string;
}

export interface RepoApiHandlers {
	/** Currently registered repositories and the folders that are scanned for new ones. */
	state(): { repos: RepoEntry[]; roots: string[] };
	/** Register a repository. Resolves with the repository root, or an error message. */
	addRepo(target: string): Promise<{ root: string | null; error: string | null }>;
	/**
	 * Drop a repository from the list. The folder on disk is never touched, and the repository
	 * is remembered as "ignored" so the folder scan does not add it back straight away.
	 */
	removeRepo(target: string): Promise<{ ok: boolean; error: string | null }>;
	/** Add a folder to the list of scanned roots. */
	addRoot(target: string): Promise<void>;
	/** Scan all roots for repositories that are not registered yet. */
	scan(): Promise<void>;
}

let handlers: RepoApiHandlers = {
	state: () => ({ repos: [], roots: [] }),
	addRepo: () => Promise.resolve({ root: null, error: 'The repository API is not available.' }),
	removeRepo: () => Promise.resolve({ ok: false, error: 'The repository API is not available.' }),
	addRoot: () => Promise.resolve(),
	scan: () => Promise.resolve()
};

export function configureRepoApi(next: RepoApiHandlers) {
	handlers = next;
}

export function repoApi() {
	return handlers;
}

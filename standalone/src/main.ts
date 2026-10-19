import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AvatarManager } from '../../src/avatarManager';
import { DataSource } from '../../src/dataSource';
import { ExtensionState } from '../../src/extensionState';
import { GitGraphView } from '../../src/gitGraphView';
import { Logger } from '../../src/logger';
import { RepoManager } from '../../src/repoManager';
import { UNABLE_TO_FIND_GIT_MSG, GitExecutable, findGit } from '../../src/utils';
import { EventEmitter } from '../../src/utils/event';
import { configureShim, createExtensionContext, ensureDirectory } from './adapter/vscode';
import { configureDiff } from './diff';
import { configureRepoApi } from './repoApi';
import { GitGraphServer } from './server';

const DEFAULT_PORT = 7583;

interface CommandLineArguments {
	repos: string[];
	roots: string[];
	port: number;
	openBrowser: boolean;
	dataDir: string | null;
}

interface SettingsFile {
	workspaceRoots: string[];
	repos: string[];
	config: { [key: string]: any };
}

function parseArguments(argv: string[]): CommandLineArguments {
	const args: CommandLineArguments = {
		repos: [],
		roots: [],
		port: DEFAULT_PORT,
		openBrowser: true,
		dataDir: null
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			i++;
			if (i >= argv.length) throw new Error('Missing value for ' + arg);
			return argv[i];
		};
		switch (arg) {
			case '--repo':
			case '-r':
				args.repos.push(next());
				break;
			case '--root':
				args.roots.push(next());
				break;
			case '--port':
			case '-p':
				args.port = parseInt(next(), 10);
				if (isNaN(args.port)) throw new Error('Invalid port: ' + argv[i]);
				break;
			case '--data-dir':
				args.dataDir = next();
				break;
			case '--no-open':
				args.openBrowser = false;
				break;
			case '--help':
			case '-h':
				printUsage();
				process.exit(0);
				break;
			default:
				console.warn('Ignoring unknown argument: ' + arg);
		}
	}
	return args;
}

function printUsage() {
	console.log([
		'Git Graph Standalone',
		'',
		'Usage: node out/standalone/src/main.js [options]',
		'',
		'Options:',
		'  -r, --repo <path>      Add a repository (can be repeated)',
		'      --root <path>      Workspace folder to scan for repositories (can be repeated)',
		'  -p, --port <port>      Preferred HTTP port (default: ' + DEFAULT_PORT + ')',
		'      --data-dir <path>  Directory for settings, state and logs',
		'      --no-open          Do not open the browser automatically',
		'  -h, --help             Show this help',
		'',
		'Settings file: <data-dir>/settings.json',
		'  { "workspaceRoots": ["C:/work"], "repos": ["C:/work/project"],',
		'    "config": { "git-graph.dateFormat": "Date & Time" } }'
	].join('\n'));
}

/**
 * Locate the repository root that contains `package.json`, `media` and `resources`.
 */
function resolveExtensionPath(): string {
	if (process.env.GG_EXTENSION_PATH) return path.resolve(process.env.GG_EXTENSION_PATH);
	const fromOutput = path.resolve(__dirname, '../../../..');
	if (fs.existsSync(path.join(fromOutput, 'package.json'))) return fromOutput;
	return process.cwd();
}

function loadSettings(file: string, args: CommandLineArguments): SettingsFile {
	let settings: SettingsFile;
	try {
		const parsed = JSON.parse(fs.readFileSync(file).toString());
		settings = {
			workspaceRoots: Array.isArray(parsed.workspaceRoots) ? parsed.workspaceRoots : [],
			repos: Array.isArray(parsed.repos) ? parsed.repos : [],
			config: parsed.config && typeof parsed.config === 'object' ? parsed.config : {}
		};
	} catch (_) {
		settings = {
			workspaceRoots: args.roots.length > 0 ? args.roots : [process.cwd()],
			repos: args.repos,
			// Look one level deep by default, so a workspace folder that only contains repositories
			// (the common case for a standalone app) is picked up on first run.
			config: { 'git-graph.maxDepthOfRepoSearch': 1 }
		};
		try {
			ensureDirectory(path.dirname(file));
			fs.writeFileSync(file, JSON.stringify(settings, null, '\t'));
		} catch (_) { }
	}
	return settings;
}

function openInBrowser(url: string) {
	try {
		if (process.platform === 'win32') {
			cp.spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
		} else if (process.platform === 'darwin') {
			cp.spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
		} else {
			cp.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
		}
	} catch (_) { }
}

async function main() {
	const args = parseArguments(process.argv.slice(2));
	const extensionPath = resolveExtensionPath();
	const dataDir = args.dataDir !== null ? path.resolve(args.dataDir) : path.join(extensionPath, 'standalone', 'data');
	ensureDirectory(dataDir);

	const settingsFile = path.join(dataDir, 'settings.json');
	const settings = loadSettings(settingsFile, args);
	let workspaceRoots = args.roots.length > 0
		? args.roots
		: (settings.workspaceRoots.length > 0 ? settings.workspaceRoots : [process.cwd()]);
	workspaceRoots = workspaceRoots.map((root) => path.resolve(root).replace(/\\/g, '/'));

	configureShim({
		extensionPath: extensionPath,
		dataDir: dataDir,
		httpBase: 'http://127.0.0.1:' + args.port,
		workspaceRoots: workspaceRoots.map((root) => path.resolve(root)),
		userConfig: settings.config
	});

	const server = new GitGraphServer({
		extensionPath: extensionPath,
		assetsDir: path.resolve(__dirname, '../../assets'),
		port: args.port
	});
	const port = await server.start();
	void port;
	configureShim({ httpBase: server.baseUrl, browserEnabled: args.openBrowser });

	const logger = new Logger();
	logger.log('Git Graph Standalone starting ...');
	configureShim({ log: (message) => logger.log(message) });
	logger.log('Extension path: ' + extensionPath);
	logger.log('Data directory: ' + dataDir);
	logger.log('Listening on: ' + server.baseUrl);

	const context = createExtensionContext();
	const gitExecutableEmitter = new EventEmitter<any>();
	const onDidChangeGitExecutable = gitExecutableEmitter.subscribe;
	const extensionState = new ExtensionState(context as any, onDidChangeGitExecutable);

	let gitExecutable: GitExecutable | null = null;
	try {
		gitExecutable = await findGit(extensionState);
		gitExecutableEmitter.emit(gitExecutable);
		logger.log('Using ' + gitExecutable.path + ' (version: ' + gitExecutable.version + ')');
	} catch (_) {
		logger.logError(UNABLE_TO_FIND_GIT_MSG);
	}

	const configurationEmitter = new EventEmitter<any>();
	const onDidChangeConfiguration = configurationEmitter.subscribe;

	const dataSource = new DataSource(gitExecutable, onDidChangeConfiguration, onDidChangeGitExecutable, logger);

	// The diff viewer reads file contents through the same data source as the extension,
	// so it honours the repository's configured file encoding.
	configureDiff({
		gitPath: gitExecutable !== null ? gitExecutable.path : 'git',
		readCommitFile: (repo, commit, filePath) => dataSource.getCommitFile(repo, commit, filePath)
	});

	const avatarManager = new AvatarManager(dataSource, extensionState, logger);
	const repoManager = new RepoManager(dataSource, extensionState, onDidChangeConfiguration, logger);

	// Register explicitly configured repositories first, then fall back to scanning the roots.
	const configuredRepos = args.repos.length > 0 ? args.repos : settings.repos;
	for (const repo of configuredRepos) {
		// Git reports repository roots with forward slashes, so normalise here as well.
		// Otherwise the same repository would be registered twice (once as C:\a\b, once as C:/a/b).
		const absolute = path.resolve(repo).replace(/\\/g, '/');
		repoManager.registerRepo(absolute, false);
		logger.log('Registered repository: ' + absolute);
	}

	if (repoManager.getNumRepos() === 0) {
		logger.log('Scanning workspace folders for repositories ...');
		await repoManager.searchWorkspaceForRepos();
		logger.log('Found ' + repoManager.getNumRepos() + ' repositories.');
	}

	/**
	 * Write the current repository list and scan roots back to `settings.json`, so the
	 * choices made in the browser survive a restart.
	 */
	const persistSettings = () => {
		settings.repos = Object.keys(repoManager.getRepos());
		settings.workspaceRoots = workspaceRoots;
		try {
			fs.writeFileSync(settingsFile, JSON.stringify(settings, null, '\t'));
		} catch (_) { }
	};

	configureRepoApi({
		state: () => ({
			repos: Object.keys(repoManager.getRepos()).map((repo) => ({ path: repo, name: path.basename(repo) || repo })),
			roots: workspaceRoots
		}),
		addRepo: async (target: string) => {
			const resolved = path.resolve(target).replace(/\\/g, '/');
			let result = await repoManager.registerRepo(resolved, false);
			if (result.root === null) {
				// The chosen folder can be inside a repository that is already registered.
				const known = Object.keys(repoManager.getRepos()).filter((repo) => resolved === repo || resolved.indexOf(repo + '/') === 0);
				if (known.length > 0) result = { root: known[0], error: null };
			}
			if (result.root !== null) {
				logger.log('Registered repository from the browser: ' + result.root);
				persistSettings();
				server.reloadClients();
			}
			return result;
		},
		removeRepo: async (target: string) => {
			const resolved = path.resolve(target).replace(/\\/g, '/');
			// `ignoreRepo` removes the repository *and* remembers it as ignored, so a subsequent
			// folder scan doesn't immediately add it back. Nothing on disk is deleted.
			if (!repoManager.ignoreRepo(resolved)) {
				return { ok: false, error: '仓库不在列表中：' + resolved };
			}
			logger.log('Removed repository from the browser: ' + resolved);
			persistSettings();
			server.reloadClients();
			return { ok: true, error: null };
		},
		addRoot: async (target: string) => {
			const resolved = path.resolve(target).replace(/\\/g, '/');
			if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
				throw new Error('目录不存在：' + resolved);
			}
			if (workspaceRoots.indexOf(resolved) === -1) {
				workspaceRoots = workspaceRoots.concat([resolved]);
				configureShim({ workspaceRoots: workspaceRoots });
				persistSettings();
			}
		},
		scan: async () => {
			await repoManager.searchWorkspaceForRepos();
			persistSettings();
			server.reloadClients();
		}
	});

	extensionState.expireOldCodeReviews();

	GitGraphView.createOrShow(extensionPath, dataSource, extensionState, avatarManager, repoManager, logger, null);
	logger.log('Git Graph is ready: ' + server.baseUrl);

	console.log('');
	console.log('  Git Graph is running at ' + server.baseUrl);
	console.log('  Press Ctrl+C to stop.');
	console.log('');

	if (args.openBrowser) openInBrowser(server.baseUrl);

	const shutdown = () => {
		logger.log('Shutting down.');
		server.stop();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

main().catch((error) => {
	console.error('Failed to start Git Graph Standalone:');
	console.error(error instanceof Error ? (error.stack || error.message) : error);
	process.exit(1);
});

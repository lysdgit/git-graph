/**
 * The repository picker page shown when the standalone app has no repository to display,
 * or when the user opens `/repos` from the app.
 *
 * It replaces the VS Code "Add Repository" command: the user browses folders in the browser,
 * picks a repository (or types a path), and the server registers it through `RepoManager`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { repoApi } from './repoApi';

interface BrowseEntry {
	name: string;
	path: string;
	isRepo: boolean;
	hidden: boolean;
}

interface BrowseResult {
	path: string;
	parent: string | null;
	entries: BrowseEntry[];
	isRepo: boolean;
	drives: string[];
	error: string | null;
}

const MAX_ENTRIES = 400;

function listDrives() {
	if (process.platform !== 'win32') return [] as string[];
	const drives: string[] = [];
	for (let code = 67; code <= 90; code++) {
		const drive = String.fromCharCode(code) + ':/';
		try {
			if (fs.existsSync(drive)) drives.push(drive);
		} catch (_) { }
	}
	return drives;
}

function isRepository(target: string) {
	try {
		return fs.existsSync(path.join(target, '.git'));
	} catch (_) {
		return false;
	}
}

/**
 * List the sub-directories of `target` so the user can navigate to a repository.
 */
export function browse(target: string): BrowseResult {
	const drives = listDrives();
	let resolved: string;
	if (!target) {
		resolved = process.platform === 'win32' ? (drives.length > 0 ? drives[0] : 'C:/') : os.homedir();
	} else {
		resolved = path.resolve(target);
	}
	resolved = resolved.replace(/\\/g, '/');

	const entries: BrowseEntry[] = [];
	let error: string | null = null;
	try {
		const items = (fs as any).readdirSync(resolved, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
		for (const item of items) {
			if (entries.length >= MAX_ENTRIES) break;
			const name = item.name;
			const child = resolved.replace(/\/+$/, '') + '/' + name;
			let directory = item.isDirectory();
			if (!directory && item.isSymbolicLink()) {
				try {
					directory = fs.statSync(child).isDirectory();
				} catch (_) {
					directory = false;
				}
			}
			if (!directory) continue;
			entries.push({ name: name, path: child, isRepo: isRepository(child), hidden: name.charAt(0) === '.' });
		}
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}

	entries.sort((a, b) => {
		if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
		return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0;
	});

	const parentPath = path.dirname(resolved).replace(/\\/g, '/');
	return {
		path: resolved,
		parent: parentPath === resolved ? null : parentPath,
		entries: entries,
		isRepo: isRepository(resolved),
		drives: drives,
		error: error
	};
}

function escapeHtml(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

const STYLE = `
:root {
	--bg: #ffffff; --fg: #1f2328; --muted: #656d76; --border: #d1d9e0;
	--panel: #f6f8fa; --accent: #0969da; --accent-fg: #ffffff; --ok: #1a7f37;
	--hover: #eef2f6;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --border: #3d444d;
		--panel: #151b23; --accent: #4493f8; --accent-fg: #0d1117; --ok: #3fb950;
		--hover: #1b222c;
	}
}
* { box-sizing: border-box; }
body {
	margin: 0; background: var(--bg); color: var(--fg);
	font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.wrap { max-width: 820px; margin: 0 auto; padding: 32px 20px 60px; }
h1 { font-size: 18px; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 24px; }
section { border: 1px solid var(--border); border-radius: 10px; margin-bottom: 18px; overflow: hidden; }
section > h2 {
	font-size: 13px; font-weight: 600; margin: 0; padding: 10px 14px;
	background: var(--panel); border-bottom: 1px solid var(--border);
}
section > .body { padding: 12px 14px; }
ul { list-style: none; margin: 0; padding: 0; }
li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; }
li:hover { background: var(--hover); }
li .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
li .path { color: var(--muted); font-family: ui-monospace, Consolas, monospace; font-size: 11px; }
.badge { color: var(--ok); border: 1px solid currentColor; border-radius: 999px; padding: 0 6px; font-size: 11px; }
button {
	font: inherit; cursor: pointer; border-radius: 6px; border: 1px solid var(--border);
	background: var(--bg); color: var(--fg); padding: 3px 10px;
}
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
button.danger { color: #d1242f; border-color: currentColor; }
button.danger:hover { background: rgba(209, 36, 47, .1); }
button:disabled { opacity: .5; cursor: default; }
input[type=text] {
	font: inherit; width: 100%; padding: 6px 8px; border-radius: 6px;
	border: 1px solid var(--border); background: var(--bg); color: var(--fg);
}
.row { display: flex; gap: 8px; align-items: center; }
.row > input { flex: 1; }
.crumbs { color: var(--muted); font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; margin-bottom: 8px; }
.empty { color: var(--muted); }
.hint { color: var(--muted); font-size: 11px; margin: 8px 0 0; }
#msg { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); padding: 8px 16px; border-radius: 8px;
	background: #be1100; color: #fff; font-size: 12px; display: none; }
`;

const SCRIPT = `
function toast(text) {
	var box = document.getElementById('msg');
	box.textContent = text;
	box.style.display = 'block';
	clearTimeout(window.__toastTimer);
	window.__toastTimer = setTimeout(function () { box.style.display = 'none'; }, 4000);
}
function post(url, body) {
	return fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	}).then(function (response) { return response.json(); });
}
function addRepo(target) {
	post('/api/repos/add', { path: target }).then(function (result) {
		if (result.error) { toast(result.error); return; }
		location.href = '/';
	}, function () { toast('无法连接到本地服务'); });
}
function removeRepo(target) {
	if (!confirm('要把这个仓库从列表中移除吗？\\n\\n' + target + '\\n\\n磁盘上的文件不会被删除，只是不再出现在 Git Graph 里。')) return;
	post('/api/repos/remove', { path: target }).then(function (result) {
		if (result.error) { toast(result.error); return; }
		location.reload();
	}, function () { toast('无法连接到本地服务'); });
}
function scan() {
	var button = document.getElementById('scan-button');
	if (button) { button.disabled = true; button.textContent = '扫描中…'; }
	post('/api/repos/scan', {}).then(function (result) {
		if (result.error) toast(result.error);
		location.reload();
	}, function () { toast('扫描失败'); });
}
function addRoot(input) {
	post('/api/roots/add', { path: input.value }).then(function (result) {
		if (result.error) { toast(result.error); return; }
		location.reload();
	}, function () { toast('无法连接到本地服务'); });
}
`;

export function buildPickerHtml(currentPath: string) {
	const state = repoApi().state();
	// Start the browser where the user is likely to have repositories: the first scan root.
	const startPath = currentPath !== '' ? currentPath : (state.roots.length > 0 ? state.roots[0] : os.homedir());
	const view = browse(startPath);

	const repoSections = state.repos.length === 0
		? '<div class="empty">还没有添加任何仓库。选一个目录，或直接用下面的路径输入框。</div>'
		: '<ul>' + state.repos.map((repo) => '<li>'
			+ '<span class="name">' + escapeHtml(repo.name) + '<br><span class="path">' + escapeHtml(repo.path) + '</span></span>'
			+ '<button class="primary" onclick="location.href=\'/\'">打开</button>'
			+ '<button class="danger" title="从列表中移除（不删除磁盘文件）" onclick="removeRepo(\''
			+ escapeHtml(repo.path).replace(/'/g, "\\'") + '\')">移除</button>'
			+ '</li>').join('') + '</ul>'
			+ '<p class="hint">“移除”只会把这个仓库从列表里去掉，磁盘上的文件不受影响；再次添加同一个目录即可恢复。</p>';

	const driveRow = view.drives.length > 0
		? '<div class="row" style="margin-bottom:8px">'
			+ '<span class="path">磁盘：</span>'
			+ view.drives.map((drive) => '<button onclick="location.href=\'/repos?path=' + encodeURIComponent(drive) + '\'">' + escapeHtml(drive) + '</button>').join('')
			+ '</div>'
		: '';

	const upRow = view.parent !== null
		? '<li><button onclick="location.href=\'/repos?path=' + encodeURIComponent(view.parent) + '\'">↑ 上级目录</button></li>'
		: '';

	const entries = view.entries.length === 0
		? (view.error !== null ? '<div class="empty">无法读取目录：' + escapeHtml(view.error) + '</div>' : '<div class="empty">这个目录下没有子目录。</div>')
		: '<ul>' + upRow + view.entries.map((entry) => '<li>'
			+ '<span class="name">' + escapeHtml(entry.name) + (entry.isRepo ? ' <span class="badge">git</span>' : '') + '</span>'
			+ (entry.isRepo
				? '<button class="primary" onclick="addRepo(\'' + escapeHtml(entry.path.replace(/\\/g, '/')).replace(/'/g, "\\'") + '\')">添加</button>'
				: '')
			+ '<button onclick="location.href=\'/repos?path=' + encodeURIComponent(entry.path) + '\'">进入</button>'
			+ '</li>').join('') + '</ul>';

	const roots = state.roots.length === 0
		? '<div class="empty">没有配置扫描目录。</div>'
		: '<ul>' + state.roots.map((root) => '<li><span class="name path">' + escapeHtml(root) + '</span></li>').join('') + '</ul>';

	return '<!DOCTYPE html>\n'
		+ '<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
		+ '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
		+ '<title>选择仓库 · Git Graph</title>\n'
		+ '<style>' + STYLE + '</style>\n</head>\n<body>\n'
		+ '<div class="wrap">'
		+ '<h1>选择 Git 仓库</h1>'
		+ '<p class="sub">选择一个目录，Git Graph 会把它加进仓库列表并打开。</p>'

		+ '<section><h2>已添加的仓库</h2><div class="body">' + repoSections + '</div></section>'

		+ '<section><h2>浏览目录</h2><div class="body">'
		+ driveRow
		+ '<div class="crumbs">' + escapeHtml(view.path) + (view.isRepo ? ' <span class="badge">这是一个 Git 仓库</span>' : '') + '</div>'
		+ (view.isRepo ? '<div class="row" style="margin-bottom:10px"><button class="primary" onclick="addRepo(\''
			+ escapeHtml(view.path).replace(/'/g, "\\'") + '\')">添加此仓库</button></div>' : '')
		+ entries
		+ '</div></section>'

		+ '<section><h2>直接输入路径</h2><div class="body"><div class="row">'
		+ '<input type="text" id="manual-path" placeholder="例如 D:/work/my-project">'
		+ '<button class="primary" onclick="addRepo(document.getElementById(\'manual-path\').value)">添加</button>'
		+ '</div></div></section>'

		+ '<section><h2>扫描目录</h2><div class="body">'
		+ roots
		+ '<div class="row" style="margin-top:10px">'
		+ '<input type="text" id="root-path" placeholder="添加一个要扫描的目录">'
		+ '<button onclick="addRoot(document.getElementById(\'root-path\'))">添加</button>'
		+ '<button id="scan-button" onclick="scan()">立即扫描</button>'
		+ '</div></div></section>'

		+ '</div><div id="msg"></div>\n'
		+ '<script>' + SCRIPT + '</script>\n'
		+ '</body>\n</html>';
}

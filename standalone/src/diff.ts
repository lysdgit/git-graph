/**
 * A small, dependency free diff viewer for the standalone Git Graph app.
 *
 * Visual Studio Code ships a diff editor; outside of it we have to render one ourselves.
 * The heavy lifting (line alignment) is delegated to `git diff --no-index` so the result
 * matches what the user would see in `git diff`, and the output is turned into a static
 * HTML page that the local server hands to the browser.
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** One side of a diff: a file inside a commit, a file in the working tree, or nothing at all. */
export interface DiffSideSpec {
	kind: 'commit' | 'working' | 'empty';
	/** Repository root (only for `commit`). */
	repo: string | null;
	/** Revision, e.g. `HEAD`, `a1b2c3d`, `a1b2c3d^` (only for `commit`). */
	commit: string | null;
	/** Path relative to the repository root (only for `commit`). */
	filePath: string | null;
	/** Absolute path on disk (only for `working`). */
	absolutePath: string | null;
	/** Short human readable label, e.g. `a1b2c3d` or `工作区`. */
	label: string;
}

export interface DiffEntry {
	id: string;
	/** `diff` renders a two-sided comparison, `file` renders a single revision. */
	kind: 'diff' | 'file';
	title: string;
	filePath: string;
	subtitle: string;
	left: DiffSideSpec;
	right: DiffSideSpec;
}

interface DiffOptions {
	gitPath: string;
	readCommitFile: (repo: string, commit: string, filePath: string) => Promise<string>;
}

let options: DiffOptions = {
	gitPath: 'git',
	readCommitFile: () => Promise.resolve('')
};

const entries = new Map<string, DiffEntry>();
const MAX_ENTRIES = 100;

/** Files larger than this are shown without their contents. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
/** Maximum number of rendered rows, to keep the browser responsive. */
const MAX_ROWS = 20000;

export function configureDiff(next: Partial<DiffOptions>) {
	options = Object.assign({}, options, next);
}

export function createDiffEntry(entry: Omit<DiffEntry, 'id'>): DiffEntry {
	const id = createId();
	const stored: DiffEntry = Object.assign({ id: id }, entry);
	entries.set(id, stored);
	while (entries.size > MAX_ENTRIES) {
		const oldest = entries.keys().next();
		if (oldest.done) break;
		entries.delete(oldest.value);
	}
	return stored;
}

export function getEntry(id: string) {
	return entries.has(id) ? entries.get(id)! : null;
}

function createId() {
	let id = '';
	const alphabet = 'abcdef0123456789';
	for (let i = 0; i < 16; i++) id += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	return id;
}

/**
 * Read the contents of one side of a diff.
 */
export async function readSide(side: DiffSideSpec): Promise<string | null> {
	if (side.kind === 'empty') return '';
	if (side.kind === 'working') {
		if (side.absolutePath === null) return null;
		return new Promise<string | null>((resolve) => {
			fs.stat(side.absolutePath!, (err, stats) => {
				if (err || !stats.isFile()) {
					resolve(null);
					return;
				}
				if (stats.size > MAX_TEXT_BYTES) {
					resolve(TOO_LARGE);
					return;
				}
				fs.readFile(side.absolutePath!, 'utf8', (readError, data) => resolve(readError ? null : data));
			});
		});
	}
	if (side.repo === null || side.commit === null || side.filePath === null) return null;
	try {
		return await options.readCommitFile(side.repo, side.commit, side.filePath);
	} catch (_) {
		return null;
	}
}

const TOO_LARGE = '\u0000TOO_LARGE\u0000';

function splitLines(text: string) {
	if (text === '') return [] as string[];
	const normalised = text.replace(/\r\n/g, '\n');
	const lines = normalised.split('\n');
	if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/**
 * Normalise CRLF to LF. Git compares text with `core.autocrlf` in effect, so a file that only
 * differs in its line endings must not be reported as changed.
 */
function normaliseEol(text: string) {
	return splitLines(text).join('\n');
}

function isBinary(text: string) {
	if (text.indexOf('\u0000') > -1) return true;
	const sample = text.length > 8000 ? text.substring(0, 8000) : text;
	let replacements = 0;
	for (let i = 0; i < sample.length; i++) {
		if (sample.charCodeAt(i) === 65533) replacements++;
	}
	return sample.length > 0 && replacements / sample.length > 0.02;
}

interface Op {
	type: 'context' | 'add' | 'del';
	text: string;
	leftNo: number | null;
	rightNo: number | null;
}

interface Row {
	type: 'context' | 'add' | 'del' | 'mod';
	leftNo: number | null;
	rightNo: number | null;
	left: string | null;
	right: string | null;
}

/**
 * Run `git diff --no-index` between two in-memory texts and parse the unified output.
 */
function runGitDiff(leftText: string, rightText: string): Promise<Op[]> {
	return new Promise<Op[]>((resolve) => {
		let dir: string;
		try {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-graph-diff-'));
			const leftFile = path.join(dir, 'left');
			const rightFile = path.join(dir, 'right');
			fs.writeFileSync(leftFile, leftText.replace(/\r\n/g, '\n'), 'utf8');
			fs.writeFileSync(rightFile, rightText.replace(/\r\n/g, '\n'), 'utf8');
		} catch (_) {
			resolve([]);
			return;
		}

		const args = [
			'-c', 'core.quotepath=false',
			'diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv',
			'--unified=1000000', '--', path.join(dir, 'left'), path.join(dir, 'right')
		];

		cp.execFile(options.gitPath, args, { maxBuffer: 128 * 1024 * 1024 }, (_error, stdout) => {
			try {
				(fs as any).rmSync(dir, { recursive: true, force: true });
			} catch (_) { }
			resolve(parseUnified(stdout || ''));
		});
	});
}

function parseUnified(diff: string): Op[] {
	const lines = diff.split('\n');
	const ops: Op[] = [];
	let index = 0;

	while (index < lines.length) {
		const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[index]);
		if (header === null) {
			index++;
			continue;
		}
		let leftNo = parseInt(header[1], 10);
		let rightNo = parseInt(header[2], 10);
		index++;

		while (index < lines.length) {
			const line = lines[index];
			if (line.length === 0 || (line.length > 0 && line.charAt(0) === '@' && line.charAt(1) === '@')) break;
			if (line.indexOf('diff --git ') === 0) break;
			if (line.indexOf('\\ No newline at end of file') === 0) {
				index++;
				continue;
			}
			const marker = line.charAt(0);
			if (marker === '+') {
				ops.push({ type: 'add', text: line.substring(1), leftNo: null, rightNo: rightNo++ });
			} else if (marker === '-') {
				ops.push({ type: 'del', text: line.substring(1), leftNo: leftNo++, rightNo: null });
			} else if (marker === ' ') {
				ops.push({ type: 'context', text: line.substring(1), leftNo: leftNo++, rightNo: rightNo++ });
			} else {
				break;
			}
			index++;
		}
	}
	return ops;
}

function toRows(ops: Op[]) {
	const rows: Row[] = [];
	let index = 0;
	while (index < ops.length) {
		const op = ops[index];
		if (op.type === 'context') {
			rows.push({ type: 'context', leftNo: op.leftNo, rightNo: op.rightNo, left: op.text, right: op.text });
			index++;
			continue;
		}
		const deletions: Op[] = [];
		const additions: Op[] = [];
		while (index < ops.length && ops[index].type === 'del') {
			deletions.push(ops[index]);
			index++;
		}
		while (index < ops.length && ops[index].type === 'add') {
			additions.push(ops[index]);
			index++;
		}
		if (deletions.length === 0 && additions.length === 0) break;
		const count = Math.max(deletions.length, additions.length);
		for (let i = 0; i < count; i++) {
			const deletion = i < deletions.length ? deletions[i] : null;
			const addition = i < additions.length ? additions[i] : null;
			rows.push({
				type: deletion !== null && addition !== null ? 'mod' : deletion !== null ? 'del' : 'add',
				leftNo: deletion !== null ? deletion.leftNo : null,
				rightNo: addition !== null ? addition.rightNo : null,
				left: deletion !== null ? deletion.text : null,
				right: addition !== null ? addition.text : null
			});
		}
	}
	return rows;
}

function escapeHtml(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/\t/g, '    ');
}

function renderSplitRows(rows: Row[], truncated: boolean) {
	const output: string[] = [];
	const limit = truncated ? MAX_ROWS : rows.length;
	for (let i = 0; i < limit; i++) {
		const row = rows[i];
		const leftNo = row.leftNo === null ? '' : String(row.leftNo);
		const rightNo = row.rightNo === null ? '' : String(row.rightNo);
		const leftClass = row.type === 'del' || row.type === 'mod' ? 'code del' : row.type === 'add' ? 'code empty' : 'code';
		const rightClass = row.type === 'add' || row.type === 'mod' ? 'code add' : row.type === 'del' ? 'code empty' : 'code';
		output.push('<tr>'
			+ '<td class="ln">' + leftNo + '</td>'
			+ '<td class="' + leftClass + '">' + (row.left === null ? '' : escapeHtml(row.left)) + '</td>'
			+ '<td class="ln">' + rightNo + '</td>'
			+ '<td class="' + rightClass + '">' + (row.right === null ? '' : escapeHtml(row.right)) + '</td>'
			+ '</tr>');
	}
	return output.join('\n');
}

function renderUnifiedRows(ops: Op[], truncated: boolean) {
	const output: string[] = [];
	const limit = truncated ? MAX_ROWS : ops.length;
	for (let i = 0; i < limit; i++) {
		const op = ops[i];
		const marker = op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' ';
		output.push('<tr class="' + op.type + '">'
			+ '<td class="ln">' + (op.leftNo === null ? '' : String(op.leftNo)) + '</td>'
			+ '<td class="ln">' + (op.rightNo === null ? '' : String(op.rightNo)) + '</td>'
			+ '<td class="code">' + escapeHtml(marker + op.text) + '</td>'
			+ '</tr>');
	}
	return output.join('\n');
}

const PAGE_STYLE = `
:root {
	--bg: #ffffff;
	--fg: #1f2328;
	--muted: #656d76;
	--border: #d1d9e0;
	--add-bg: #e6ffec;
	--add-fg: #1a7f37;
	--del-bg: #ffebe9;
	--del-fg: #cf222e;
	--hdr-bg: #f6f8fa;
	--ln-bg: #f6f8fa;
	--empty-bg: #fbfcfd;
	--accent: #0969da;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #0d1117;
		--fg: #e6edf3;
		--muted: #9198a1;
		--border: #3d444d;
		--add-bg: #12261e;
		--add-fg: #3fb950;
		--del-bg: #25171c;
		--del-fg: #f85149;
		--hdr-bg: #151b23;
		--ln-bg: #151b23;
		--empty-bg: #10151c;
		--accent: #4493f8;
	}
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
	background: var(--bg);
	color: var(--fg);
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
	font-size: 13px;
}
header {
	position: sticky; top: 0; z-index: 2;
	background: var(--hdr-bg);
	border-bottom: 1px solid var(--border);
	padding: 10px 16px;
}
.hdr-line { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.hdr-file { font-weight: 600; font-size: 14px; }
.hdr-range { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
.hdr-stats { margin-left: auto; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
.hdr-stats .plus { color: var(--add-fg); }
.hdr-stats .minus { color: var(--del-fg); }
.hdr-path { color: var(--muted); font-size: 12px; margin-top: 4px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; word-break: break-all; }
.modes { margin-top: 8px; display: flex; gap: 6px; }
.modes label {
	cursor: pointer; padding: 3px 10px; border: 1px solid var(--border);
	border-radius: 6px; color: var(--muted); font-size: 12px; user-select: none;
}
input[name=mode] { position: absolute; opacity: 0; pointer-events: none; }
#mode-split:checked ~ header .modes label[for=mode-split],
#mode-unified:checked ~ header .modes label[for=mode-unified] {
	border-color: var(--accent); color: var(--accent); background: var(--bg);
}
#mode-split:checked ~ main .view-unified { display: none; }
#mode-unified:checked ~ main .view-split { display: none; }
main { padding: 0 0 40px; }
table { border-collapse: collapse; width: 100%; table-layout: fixed; }
td { vertical-align: top; padding: 0 8px 0 4px; font-family: ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace; font-size: 12px; line-height: 19px; }
td.ln {
	width: 52px; text-align: right; color: var(--muted);
	background: var(--ln-bg); border-right: 1px solid var(--border);
	user-select: none; padding-right: 8px;
}
td.code { white-space: pre-wrap; word-break: break-all; }
td.code.add, td.code.del { }
td.code.add { background: var(--add-bg); }
td.code.del { background: var(--del-bg); }
td.code.empty { background: var(--empty-bg); }
tr.add td.code { background: var(--add-bg); }
tr.del td.code { background: var(--del-bg); }
tr.mod td.code { background: var(--add-bg); }
.split td.code { width: calc(50% - 52px); }
.notice { margin: 16px; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px; color: var(--muted); background: var(--hdr-bg); }
.empty-file { color: var(--muted); font-style: italic; }
footer { color: var(--muted); font-size: 12px; padding: 10px 16px; }
`;

export async function buildDiffPage(entry: DiffEntry): Promise<string> {
	const leftText = await readSide(entry.left);
	const rightText = await readSide(entry.right);

	let body: string;
	let additions = 0;
	let deletions = 0;

	if (leftText === TOO_LARGE || rightText === TOO_LARGE) {
		body = '<div class="notice">文件超过 ' + Math.round(MAX_TEXT_BYTES / 1024 / 1024) + ' MB，已跳过内容比较。</div>';
	} else if ((leftText !== null && isBinary(leftText)) || (rightText !== null && isBinary(rightText))) {
		body = '<div class="notice">这是一个二进制文件，无法显示文本差异。</div>';
	} else if (leftText === null && rightText === null) {
		body = '<div class="notice">无法读取该文件的任意一个版本。</div>';
	} else {
		const left = leftText === null ? '' : normaliseEol(leftText);
		const right = rightText === null ? '' : normaliseEol(rightText);
		const missingNote = leftText === null
			? '<div class="notice">左侧版本（' + escapeHtml(entry.left.label) + '）中不存在该文件。</div>'
			: rightText === null
				? '<div class="notice">右侧版本（' + escapeHtml(entry.right.label) + '）中不存在该文件。</div>'
				: '';

		if (left === right) {
			body = missingNote + '<div class="notice">两个版本的内容完全相同。</div>';
		} else {
			const ops = await runGitDiff(left, right);
			const rows = toRows(ops);
			for (const op of ops) {
				if (op.type === 'add') additions++;
				if (op.type === 'del') deletions++;
			}
			if (ops.length === 0) {
				body = missingNote + '<div class="notice">Git 未发现可显示的差异（可能只是换行符不同）。</div>';
			} else {
				const rowCount = rows.length > ops.length ? rows.length : ops.length;
				const truncated = rowCount > MAX_ROWS;
				body = missingNote
					+ (truncated ? '<div class="notice">差异内容过大，仅显示前 ' + MAX_ROWS + ' 行。</div>' : '')
					+ '<div class="view-split"><table><tbody>' + renderSplitRows(rows, truncated) + '</tbody></table></div>'
					+ '<div class="view-unified"><table><tbody>' + renderUnifiedRows(ops, truncated) + '</tbody></table></div>';
			}
		}
	}

	return pageShell(entry.title, headerHtml(entry, additions, deletions, true), body);
}

export async function buildFilePage(entry: DiffEntry): Promise<string> {
	const side = entry.left;
	const text = await readSide(side);
	let body: string;
	if (text === TOO_LARGE) {
		body = '<div class="notice">文件超过 ' + Math.round(MAX_TEXT_BYTES / 1024 / 1024) + ' MB，已跳过内容显示。</div>';
	} else if (text === null) {
		body = '<div class="notice">无法读取该版本的文件内容。</div>';
	} else if (isBinary(text)) {
		body = '<div class="notice">这是一个二进制文件，无法显示文本内容。</div>';
	} else {
		const lines = splitLines(text);
		const rendered: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			rendered.push('<tr><td class="ln">' + (i + 1) + '</td><td class="code">' + escapeHtml(lines[i]) + '</td></tr>');
		}
		body = '<div class="view-split"><table><tbody>' + rendered.join('\n') + '</tbody></table></div>';
	}
	return pageShell(entry.title, headerHtml(entry, 0, 0, false), body);
}

function headerHtml(entry: DiffEntry, additions: number, deletions: number, showModes: boolean) {
	const stats = additions + deletions > 0
		? '<span class="hdr-stats"><span class="plus">+' + additions + '</span> <span class="minus">-' + deletions + '</span></span>'
		: '';
	return '<header>'
		+ '<div class="hdr-line">'
		+ '<span class="hdr-file">' + escapeHtml(entry.title) + '</span>'
		+ '<span class="hdr-range">' + escapeHtml(entry.left.label) + ' &harr; ' + escapeHtml(entry.right.label) + '</span>'
		+ stats
		+ '</div>'
		+ '<div class="hdr-path">' + escapeHtml(entry.filePath) + '</div>'
		+ (showModes ? '<div class="modes"><label for="mode-split">并排</label><label for="mode-unified">统一</label></div>' : '')
		+ '</header>';
}

function pageShell(title: string, header: string, body: string) {
	return '<!DOCTYPE html>\n'
		+ '<html lang="zh-CN">\n'
		+ '<head>\n'
		+ '<meta charset="utf-8">\n'
		+ '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
		+ '<title>' + escapeHtml(title) + '</title>\n'
		+ '<style>' + PAGE_STYLE + '</style>\n'
		+ '</head>\n'
		+ '<body>\n'
		+ '<input type="radio" name="mode" id="mode-split" checked>\n'
		+ '<input type="radio" name="mode" id="mode-unified">\n'
		+ header + '\n'
		+ '<main>' + body + '</main>\n'
		+ '</body>\n'
		+ '</html>';
}

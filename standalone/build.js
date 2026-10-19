/**
 * Build script for the standalone Git Graph app.
 *
 * It performs four steps:
 *   1. Compile the original extension sources (`../src`) plus the standalone adapter (`./src`)
 *      into `./out`. The `vscode` module is mapped to `./src/adapter/vscode` at type level.
 *   2. Compile and bundle the original web front-end (`../web`) into `../media/out.min.js`
 *      and `../media/out.min.css`, reusing the same bundling order as the extension build.
 *   3. Rewrite `require("vscode")` in the compiled backend to point at the adapter, and copy
 *      the askpass shell scripts next to the compiled sources.
 *   4. Copy the browser bridge + theme assets into `./out/assets`.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const UglifyJS = require('uglify-js');

const STANDALONE_DIR = __dirname;
const REPO_ROOT = path.resolve(STANDALONE_DIR, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const WEB_DIR = path.join(REPO_ROOT, 'web');
const MEDIA_DIR = path.join(REPO_ROOT, 'media');
const OUT_DIR = path.join(STANDALONE_DIR, 'out');
const ASSETS_SRC = path.join(STANDALONE_DIR, 'assets');
const ASSETS_OUT = path.join(OUT_DIR, 'assets');
const TSC = path.join(STANDALONE_DIR, 'node_modules', 'typescript', 'bin', 'tsc');

function log(message) {
	console.log('[build] ' + message);
}

function rmrf(target) {
	if (!fs.existsSync(target)) return;
	for (const entry of fs.readdirSync(target)) {
		const full = path.join(target, entry);
		if (fs.statSync(full).isDirectory()) {
			rmrf(full);
		} else {
			fs.unlinkSync(full);
		}
	}
	fs.rmdirSync(target);
}

function copyDir(from, to) {
	fs.mkdirSync(to, { recursive: true });
	for (const entry of fs.readdirSync(from)) {
		const src = path.join(from, entry);
		const dst = path.join(to, entry);
		if (fs.statSync(src).isDirectory()) {
			copyDir(src, dst);
		} else {
			fs.copyFileSync(src, dst);
		}
	}
}

function walk(dir, callback) {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) {
			walk(full, callback);
		} else {
			callback(full);
		}
	}
}

function run(command, args) {
	const result = cp.spawnSync(command, args, { cwd: STANDALONE_DIR, stdio: 'inherit' });
	if (result.status !== 0) {
		throw new Error('Command failed: ' + command + ' ' + args.join(' '));
	}
}

/* 1. Compile backend sources */

log('Removing previous output ...');
rmrf(OUT_DIR);
fs.mkdirSync(OUT_DIR, { recursive: true });

log('Compiling extension sources + adapter ...');
run(process.execPath, [TSC, '-p', path.join(STANDALONE_DIR, 'tsconfig.json')]);

/* 2. Build the web front-end bundle (same order as the extension build) */

// The web front-end imports the shared types from `../out/types`, which is the file the extension
// build normally produces. Publish the compiled declaration into that location for the web build.
const sharedTypes = path.join(OUT_DIR, 'src', 'types.d.ts');
if (!fs.existsSync(sharedTypes)) {
	throw new Error('Missing compiled shared types: ' + sharedTypes);
}
fs.mkdirSync(path.join(REPO_ROOT, 'out'), { recursive: true });
fs.copyFileSync(sharedTypes, path.join(REPO_ROOT, 'out', 'types.d.ts'));

log('Compiling web front-end ...');
rmrf(MEDIA_DIR);
run(process.execPath, [TSC, '-p', path.join(STANDALONE_DIR, 'tsconfig.web.json')]);

const jsFiles = [];
const cssFiles = [];

for (const fileName of fs.readdirSync(MEDIA_DIR)) {
	if (fileName.endsWith('.js')) jsFiles.push(path.join(MEDIA_DIR, fileName));
}
// Order: utils.js first, main.js last, everything else in between
jsFiles.sort((a, b) => {
	const name = (p) => path.basename(p);
	if (name(a) === 'utils.js') return -1;
	if (name(b) === 'utils.js') return 1;
	if (name(a) === 'main.js') return 1;
	if (name(b) === 'main.js') return -1;
	return name(a).localeCompare(name(b));
});

let bundle = '"use strict";\n(function(document, window){\n';
for (const file of jsFiles) {
	bundle += fs.readFileSync(file).toString().replace('"use strict";\r\n', '').replace('"use strict";\n', '') + '\n';
	fs.unlinkSync(file);
}
bundle += '})(document, window);\n';

const minified = UglifyJS.minify(bundle, { mangle: true });
if (minified.error) {
	throw new Error('Failed to minify web bundle: ' + minified.error);
}
fs.writeFileSync(path.join(MEDIA_DIR, 'out.min.js'), minified.code);
log('Wrote out.min.js (' + Math.round(minified.code.length / 1024) + ' KB)');

const styleDir = path.join(WEB_DIR, 'styles');
const orderedCss = [path.join(styleDir, 'main.css')];
for (const fileName of fs.readdirSync(styleDir)) {
	if (fileName.endsWith('.css') && fileName !== 'main.css') {
		orderedCss.push(path.join(styleDir, fileName));
	}
}
let css = '';
for (const file of orderedCss) {
	const lines = fs.readFileSync(file).toString().split(/\r\n|\r|\n/g);
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];
		if (line.startsWith('\t')) line = line.substring(1);
		if (line.startsWith('/*') && line.endsWith('*/')) continue;
		css += line;
	}
}
fs.writeFileSync(path.join(MEDIA_DIR, 'out.min.css'), css);
log('Wrote out.min.css (' + Math.round(css.length / 1024) + ' KB)');

/* 3. Rewrite `require("vscode")` to the adapter, copy askpass scripts */

const adapterPath = path.join(OUT_DIR, 'standalone', 'src', 'adapter', 'vscode.js');
if (!fs.existsSync(adapterPath)) {
	throw new Error('Adapter was not compiled: ' + adapterPath);
}

let rewritten = 0;
walk(path.join(OUT_DIR, 'src'), (file) => {
	if (!file.endsWith('.js')) return;
	const contents = fs.readFileSync(file).toString();
	if (contents.indexOf('require("vscode")') === -1) return;
	const relative = path.relative(path.dirname(file), adapterPath).replace(/\\/g, '/');
	const replacement = relative.startsWith('.') ? relative : './' + relative;
	fs.writeFileSync(file, contents.split('require("vscode")').join('require("' + replacement + '")'));
	rewritten++;
});
log('Rewrote require("vscode") in ' + rewritten + ' compiled files');

const askpassSrc = path.join(SRC_DIR, 'askpass');
const askpassOut = path.join(OUT_DIR, 'src', 'askpass');
fs.mkdirSync(askpassOut, { recursive: true });
for (const fileName of fs.readdirSync(askpassSrc)) {
	if (fileName.endsWith('.sh')) {
		fs.copyFileSync(path.join(askpassSrc, fileName), path.join(askpassOut, fileName));
	}
}

/* 4. Copy browser assets */

copyDir(ASSETS_SRC, ASSETS_OUT);

log('Build completed successfully.');

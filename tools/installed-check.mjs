/**
 * 检查运行中的插件副本是否与仓库最新提交一致。
 *
 * 起因是一次误判：我改了源码、重启了 DSH，就宣布「新代码已加载」。实际上
 * 插件是以 `github:...#<commit>` 装的，运行实例读的是 `node_modules` 里那个
 * commit 的快照，根本不是工作目录。于是：
 *
 *   - 源码已经改好、测试全绿
 *   - 界面上却还是旧行为（「可更新」但没有按钮）
 *   - 我比较的是「源文件的修改时间 vs 进程启动时间」，这个比较毫无意义
 *
 * 这个脚本做真正的比较：已装副本的每个文件 vs 仓库 HEAD 里的同一文件。不一致
 * 就说明运行的不是最新代码，无论重启过多少次。
 *
 * Run: node tools/installed-check.mjs [插件名]
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const plugin = process.argv[2] ?? 'dsh-plugin-cloud';
const repoDir = join('C:', 'Data', 'deepseek', plugin);
const installedDir = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', plugin);

/**
 * 递归列出目录里的相对文件路径。
 *
 * @param {string} dir - 目录。
 * @param {boolean} [onlyPublished] - 只列 npm 包会带上的文件。
 * @returns {Promise<string[]>} 相对路径列表。
 */
async function listFiles(dir, onlyPublished = false) {
	const out = [];
	const walk = async (current, prefix) => {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			// 版本控制与依赖目录不属于「插件内容」的比较范围
			if (entry.name === '.git' || entry.name === 'node_modules') continue;
			// 仓库里有测试与文档，但 `files` 字段不会把它们打进包；把它们算作
			// 「已装副本缺失」只会制造噪声，掩盖真正的问题（源码与副本不一致）。
			if (onlyPublished && prefix === '' && entry.name === 'tools') continue;
			if (onlyPublished && prefix === '' && entry.name === '.gitignore') continue;
			const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(full, rel);
			} else if (entry.isFile()) {
				out.push(rel);
			}
		}
	};
	await walk(dir, '');
	return out.sort();
}

/** 读仓库 HEAD 里某个文件的原始内容（不经工作区，避开本地未提交改动）。 */
function gitShow(relPath) {
	try {
		return execFileSync('git', ['show', `HEAD:${relPath}`], {
			cwd: repoDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			maxBuffer: 8 * 1024 * 1024,
		});
	} catch {
		return null;
	}
}

/** 仓库 HEAD 的 commit。 */
function gitHead() {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return null;
	}
}

/** 已装副本的 package.json 版本，用于提示。 */
async function installedVersion() {
	try {
		const raw = await readFile(join(installedDir, 'package.json'), 'utf8');
		return JSON.parse(raw).version ?? null;
	} catch {
		return null;
	}
}

const head = gitHead();
console.log(`插件:   ${plugin}`);
console.log(`仓库:   ${repoDir}`);
console.log(`HEAD:   ${head ?? '(不是 git 仓库)'}`);
console.log(`已装至: ${installedDir}`);

let installedVersionText = null;
try {
	await stat(installedDir);
	installedVersionText = await installedVersion();
	console.log(`版本:   ${installedVersionText ?? '(未知)'}`);
} catch {
	console.log('版本:   (未安装)');
}
console.log('');

if (head === null) {
	console.log('仓库不是 git 仓库，无法比较。');
	process.exit(1);
}

const repoFiles = await listFiles(repoDir, true);
const installedFiles = await listFiles(installedDir, true);
const installedSet = new Set(installedFiles);

const missing = [];
const different = [];
for (const rel of repoFiles) {
	if (!installedSet.has(rel)) {
		missing.push(rel);
		continue;
	}
	const expected = gitShow(rel);
	if (expected === null) continue;
	const actual = await readFile(join(installedDir, rel), 'utf8').catch(() => null);
	if (actual === null) {
		missing.push(rel);
		continue;
	}
	// 统一换行后比较：Windows 检出会把 LF 变 CRLF，那是正常的
	const norm = (t) => t.replace(/\r\n/g, '\n');
	if (norm(expected) !== norm(actual)) different.push(rel);
}

const extra = installedFiles.filter((rel) => !repoFiles.includes(rel));

console.log(`仓库文件 ${repoFiles.length} 个，已装文件 ${installedFiles.length} 个`);
if (missing.length > 0) {
	console.log(`\n缺失（仓库有、已装没有）${missing.length} 个:`);
	for (const f of missing.slice(0, 20)) console.log(`  - ${f}`);
}
if (different.length > 0) {
	console.log(`\n不一致（内容不同）${different.length} 个:`);
	for (const f of different.slice(0, 20)) console.log(`  ≠ ${f}`);
}
if (extra.length > 0) {
	console.log(`\n多出（已装有、仓库没有）${extra.length} 个:`);
	for (const f of extra.slice(0, 20)) console.log(`  + ${f}`);
}

const stale = missing.length + different.length + extra.length;
console.log('');
if (stale === 0) {
	console.log('✓ 已装副本与仓库 HEAD 完全一致');
	process.exit(0);
}
console.log(`✗ 已装副本与仓库 HEAD 不一致（${stale} 处）——重启不会修复这一点，`);
console.log('  运行实例读的是 node_modules 里的副本，不是工作目录。');
console.log(`  修复：cd "${join(homedir(), '.dsh', 'profiles', 'desktop')}" && pnpm add "github:<owner>/<repo>#${head ?? '<sha>'}" --save-exact`);
process.exit(1);

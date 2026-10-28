/**
 * 装回逻辑的变异测试。
 *
 * 37 项全绿不算证据。这套变异要证明的是：那几条关于「git 依赖不能查注册表」
 * 「装之前必须清掉旧链接」「绝不删真实目录」的断言，真的在守着东西。
 *
 * 每条对应一次真实的失败：
 *   - git 依赖走注册表 → 跨机装回报 ERR_PNPM_FETCH_404（7 个只成功 1 个）
 *   - 不清链接 → Windows 上 rename 覆盖已存在目标报 EPERM
 *   - 删真实目录 → 那是已安装的包，不是指针，删了就是毁文件
 *
 * Run: node tools/restore-mutation.mjs
 */
import { readFile, writeFile, copyFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const SUITE = 'tools/restore-check.mjs';

const MUTATIONS = [
	{
		file: 'lib/restorer.js',
		name: '删掉 git 分支（复现 FETCH_404 那个 bug）',
		from: '\t\tif (entry.kind === "git") {',
		to: '\t\tif (false) {',
	},
	{
		file: 'lib/restorer.js',
		name: '装 git 版本前不清理 node_modules 链接',
		from: '\t\t\t\tconst unlinked = await unlinkNodeModulesEntry(profileDir, entry.name);',
		to: '\t\t\t\tconst unlinked = { kind: "absent" };',
	},
	{
		file: 'lib/restorer.js',
		name: 'git 依赖退化成 name@version',
		from: '\t\t\t\tconst result = await manager.installBundle(entry.spec, { saveExact: true });',
		to: '\t\t\t\tconst result = await manager.installBundle(`${entry.name}@${entry.version}`);',
	},
	{
		file: 'lib/detach.js',
		name: '删 node_modules 条目时不分辨链接与真实目录',
		from: '\tif (info.isSymbolicLink() !== true) {',
		to: '\tif (false) {',
	},
	{
		file: 'lib/restorer.js',
		name: 'dryRun 也去装并清理链接',
		from: '\t\t\trow.action = "install-git";\n\t\t\trow.detail = entry.spec;\n\t\t\tif (dryRun) {',
		to: '\t\t\trow.action = "install-git";\n\t\t\trow.detail = entry.spec;\n\t\t\tif (false) {',
	},
];

const run = (args) => new Promise((resolve) => {
	const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
	let out = '';
	child.stdout.on('data', (c) => { out += c; });
	child.stderr.on('data', (c) => { out += c; });
	child.on('exit', (code) => resolve({ code, out }));
	child.on('error', () => resolve({ code: 1, out: '' }));
});

const failLines = (out) => out.split('\n').filter((line) => /^\s{2}FAIL/.test(line));
const passedCount = (out) => Number(out.match(/(\d+) checks passed/)?.[1] ?? 0);

const baseline = await run([SUITE]);
console.log(`基线：${passedCount(baseline.out)} 项通过，exit=${baseline.code}`);
if (baseline.code !== 0) {
	console.error('基线就是红的，先修实现。');
	process.exit(1);
}

const originals = new Map();
let caught = 0;
let missed = 0;
const missedNames = [];

try {
	for (const mutation of MUTATIONS) {
		const path = join(ROOT, mutation.file);
		if (!originals.has(mutation.file)) originals.set(mutation.file, await readFile(path, 'utf8'));
		const original = originals.get(mutation.file);
		if (!original.includes(mutation.from)) {
			console.log(`  SKIP  ${mutation.name}（锚点不在 ${mutation.file} 里）`);
			missed += 1;
			missedNames.push(`${mutation.name} [锚点缺失]`);
			continue;
		}
		await writeFile(path, original.replace(mutation.from, mutation.to), 'utf8');
		const result = await run([SUITE]);
		const fails = failLines(result.out);
		await writeFile(path, original, 'utf8');
		if (result.code !== 0 && fails.length > 0) {
			caught += 1;
			console.log(`  ok    ${mutation.name} → 被 ${fails.length} 项抓到`);
		} else {
			missed += 1;
			missedNames.push(mutation.name);
			console.error(`  MISS  ${mutation.name} → 破坏后测试仍全绿`);
		}
	}
} finally {
	for (const [file, content] of originals) await writeFile(join(ROOT, file), content, 'utf8');
}

console.log(`\n变异测试：${caught} 个被抓住，${missed} 个漏网`);
if (missedNames.length > 0) console.log(`漏网: ${missedNames.join(', ')}`);

const after = await run([SUITE]);
console.log(`还原后：${passedCount(after.out)} 项通过，exit=${after.code}`);
if (after.code !== 0) process.exitCode = 1;
if (missed > 0) process.exitCode = 1;

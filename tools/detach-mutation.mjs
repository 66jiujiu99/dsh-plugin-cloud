/**
 * detach 模块的变异测试。
 *
 * 42 项全绿不算证据——如果断言空转，破坏实现照样绿。这个模块会改 profile 的
 * dsh.profile.bundles，最坏的结果是「插件从 profile 里消失」，所以每一条防线
 * 都必须证明它真的在守。
 *
 * Run: node tools/detach-mutation.mjs
 */
import { readFile, writeFile, copyFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const TARGET = join(ROOT, 'lib', 'detach.js');
const BACKUP = join(ROOT, 'lib', 'detach.js.mutation-backup');
const SUITE = 'tools/detach-check.mjs';

const MUTATIONS = [
	{
		name: '安装失败时不重新启用（插件会从 profile 消失）',
		from: '\tconst back = await restore();',
		to: '\tconst back = { ok: true };',
	},
	{
		name: '停用时连依赖一起删（等于卸载）',
		from: 'await writeManifest(dir, { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: bundles.filter((n) => n !== name) } } });',
		to: 'const deps = { ...manifest.dependencies }; delete deps[name]; await writeManifest(dir, { ...manifest, dependencies: deps, dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: bundles.filter((n) => n !== name) } } });',
	},
	{
		name: '重新启用放到末尾而非原位置',
		from: '\t\tconst at = Number.isInteger(index) && index >= 0 ? Math.min(index, bundles.length) : bundles.length;',
		to: '\t\tconst at = bundles.length;',
	},
	{
		name: '停用失败仍然继续安装',
		from: 'return { ok: false, detached: false, reattached: false, error: `detach-unavailable:${detached.reason}` };',
		to: '/* mutated: continue past a failed detach */',
	},
	{
		name: '重新启用失败却报成功',
		from: '\tif (back.ok !== true) {',
		to: '\tif (false) {',
	},
	{
		name: 'install 抛异常被吞掉当成功',
		from: '\tif (thrown !== null) {',
		to: '\tif (false) {',
	},
	{
		name: '重新启用时允许重复添加',
		from: '\t\tif (bundles.includes(name)) return { ok: true, already: true };',
		to: '\t\t/* mutated: duplicates allowed */',
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

await copyFile(TARGET, BACKUP);
const original = await readFile(TARGET, 'utf8');
let caught = 0;
let missed = 0;
const missedNames = [];

try {
	for (const mutation of MUTATIONS) {
		if (!original.includes(mutation.from)) {
			console.log(`  SKIP  ${mutation.name}（锚点不在源码里）`);
			missed += 1;
			missedNames.push(`${mutation.name} [锚点缺失]`);
			continue;
		}
		await writeFile(TARGET, original.replace(mutation.from, mutation.to), 'utf8');
		const result = await run([SUITE]);
		const fails = failLines(result.out);
		await writeFile(TARGET, original, 'utf8');
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
	await rename(BACKUP, TARGET);
}

console.log(`\n变异测试：${caught} 个被抓住，${missed} 个漏网`);
if (missedNames.length > 0) console.log(`漏网: ${missedNames.join(', ')}`);

const after = await run([SUITE]);
console.log(`还原后：${passedCount(after.out)} 项通过，exit=${after.code}`);
if (after.code !== 0) process.exitCode = 1;
if (missed > 0) process.exitCode = 1;

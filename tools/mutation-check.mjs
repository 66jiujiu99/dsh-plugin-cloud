/**
 * 变异测试：故意破坏 lib/manifest.js 的实现，确认 manifest-check 真的会变红。
 *
 * 83 项全绿本身不是证据——如果断言写得空转，破坏实现也照样绿。只有「破坏
 * 之后必须红」才能证明测试有牙齿。用 Node 改写文件，避免 PowerShell 的
 * 默认编码把中文源码写坏、让统计失准。
 *
 * Run: node tools/mutation-check.mjs
 */
import { readFile, writeFile, copyFile, unlink, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const TARGET = join(ROOT, 'lib', 'manifest.js');
const BACKUP = join(ROOT, 'lib', 'manifest.js.mutation-backup');

const MUTATIONS = [
	{
		name: '去掉原地写入回落',
		from: 'await io.writeFile(target, text, "utf8");',
		to: 'throw new Error("mutated: no in-place fallback");',
		expect: 'EPERM 时依赖不丢',
	},
	{
		name: '完全不重试',
		from: 'if (!transient(error) || attempt >= RETRY_LIMIT) break;',
		to: 'break;',
		expect: '瞬时失败后仍能成功',
	},
	{
		name: '退避不递增',
		from: 'delay = Math.min(delay * 2, RETRY_MAX_MS);',
		to: 'delay = RETRY_INITIAL_MS;',
		expect: '20→40→80 递增',
	},
	{
		name: '退避不封顶',
		from: 'delay = Math.min(delay * 2, RETRY_MAX_MS);',
		to: 'delay = delay * 2;',
		expect: '200ms 封顶',
	},
	{
		name: '放回时覆盖已有值',
		from: 'if (Object.hasOwn(manifest.dependencies, name)) return { ok: true, already: true };',
		to: '/* mutated: guard removed */',
		expect: '已存在时不覆盖',
	},
	{
		name: '失败后不清理临时文件',
		from: 'try { await io.unlink(temp); } catch { /* best effort */ }',
		to: '/* mutated: orphan temp left behind */',
		expect: '失败后不留 .tmp',
	},
	{
		name: '把折叠失败当成功',
		from: 'const folded = foldedFailure(result);',
		to: 'const folded = undefined; void foldedFailure(result);',
		expect: '折叠失败不当成功',
	},
	{
		name: '不做 absent 判断',
		from: 'if (!Object.hasOwn(deps, name)) return { kind: "absent" };',
		to: '/* mutated: absent path removed */',
		expect: '再删一次报告 absent',
	},
	{
		name: '替换失败后不回滚 entry',
		from: 'const back = await restoreDependency(dir, name, dropped.spec, seam);',
		to: 'const back = { ok: true };',
		expect: '替换失败放回原 entry',
	},
];

const run = (args) => new Promise((resolve) => {
	const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
	let out = '';
	child.stdout.on('data', (c) => { out += c; });
	child.stderr.on('data', (c) => { out += c; });
	child.on('exit', (code) => { resolve({ code, out }); });
	child.on('error', () => { resolve({ code: 1, out }); });
});

const failLines = (out) => out.split('\n').filter((line) => /^\s{2}FAIL/.test(line));
const passedCount = (out) => Number(out.match(/(\d+) checks passed/)?.[1] ?? 0);

// ── 基线：原始实现必须全绿 ──────────────────────────────────
const baseline = await run(['tools/manifest-check.mjs']);
console.log(`基线：${passedCount(baseline.out)} 项通过，${failLines(baseline.out).length} 项失败，exit=${baseline.code}`);
if (baseline.code !== 0) {
	console.error('基线就是红的，先修实现再谈变异。');
	process.exit(1);
}

await copyFile(TARGET, BACKUP);
const original = await readFile(TARGET, 'utf8');
let caught = 0;
let missed = 0;

try {
	for (const mutation of MUTATIONS) {
		if (!original.includes(mutation.from)) {
			console.log(`  SKIP  ${mutation.name}（锚点不在源码里，变异没生效）`);
			missed += 1;
			continue;
		}
		await writeFile(TARGET, original.replace(mutation.from, mutation.to), 'utf8');
		const result = await run(['tools/manifest-check.mjs']);
		const fails = failLines(result.out);
		if (result.code !== 0 && fails.length > 0) {
			caught += 1;
			console.log(`  ok    ${mutation.name} → 被 ${fails.length} 项抓到`);
		} else {
			missed += 1;
			console.error(`  MISS  ${mutation.name} → 破坏实现后测试仍然全绿（期望覆盖：${mutation.expect}）`);
		}
		await writeFile(TARGET, original, 'utf8');
	}
} finally {
	await rename(BACKUP, TARGET);
}

console.log(`\n变异测试：${caught} 个被抓住，${missed} 个漏网`);
// 还原之后必须回到全绿，否则说明测试污染了源码。
const after = await run(['tools/manifest-check.mjs']);
console.log(`还原后：${passedCount(after.out)} 项通过，exit=${after.code}`);
if (after.code !== 0) {
	console.error('还原后测试不绿，源码可能被污染。');
	process.exitCode = 1;
}
if (missed > 0) process.exitCode = 1;

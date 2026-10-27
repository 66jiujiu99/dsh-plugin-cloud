/**
 * 变异测试：故意破坏 lib/jobs.js，确认 jobs-check 真的会变红。
 *
 * 51 项全绿本身不是证据。这套变异要证明的是：那些关于「同一时刻只一个任务」、
 * 「取消不假装已停」、「快照不与内部共享数组」的断言，确实在守着东西。
 *
 * 这三条都不是风格问题——各自对应一个真实的坏法：
 *   - 允许多任务并发 → 两次 pnpm 打同一个 profile，lockfile 和 manifest 互相踩
 *   - 取消即改状态 → 界面显示「已停止」但 pnpm 还在写盘
 *   - 快照共享数组 → 界面改一下，后面每次轮询都看到被污染的进度
 *
 * Run: node tools/jobs-mutation.mjs
 */
import { readFile, writeFile, copyFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const TARGET = join(ROOT, 'lib', 'jobs.js');
const BACKUP = join(ROOT, 'lib', 'jobs.js.mutation-backup');
const SUITE = 'tools/jobs-check.mjs';

const MUTATIONS = [
	{
		name: '取消后直接改状态（假装已停）',
		from: '\t\t\tjob.cancelled = true;\n\t\t\tjob.phase = "cancelling";',
		to: '\t\t\tjob.cancelled = true;\n\t\t\tjob.status = "cancelled";\n\t\t\tjob.phase = "cancelling";',
		expect: '取消后状态仍是 running',
	},
	{
		name: '快照共享内部数组',
		from: '\t\t\t\tresults: job.results.map((result) => ({ ...result })),',
		to: '\t\t\t\tresults: job.results,',
		expect: '改快照不影响内部状态',
	},
	{
		name: 'running() 永不返回任务（允许多任务并发）',
		from: '\t\t\t\tif (job.status === "running") return this.get(job.id);',
		to: '\t\t\t\tif (job.status === "running") return null;',
		expect: '同一时刻只能有一个任务',
	},
	{
		name: 'completedSteps 不记录已完成步骤',
		from: '\t\t\tjob.completedSteps = job.steps.slice(0, stepIndex).map((step) => step.id);',
		to: '\t\t\tjob.completedSteps = [];',
		expect: '前面的步骤标为已完成',
	},
	{
		name: 'finish 丢掉 pipeline 统计字段',
		from: '\t\t\tjob.summary = { ...job.summary, ...summary };',
		to: '\t\t\tvoid summary;',
		expect: 'finish 把额外字段合进来',
	},
	{
		name: '已结束的任务也能取消',
		from: '\t\t\tif (job === undefined || job.status !== "running") return false;',
		to: '\t\t\tif (job === undefined) return false;',
		expect: '已完成的任务不能取消',
	},
	{
		name: '对不存在的任务抛错',
		from: '\t\t\tconst job = jobs.get(id);\n\t\t\tif (job === undefined) return;\n\t\t\tjob.status = job.cancelled ? "cancelled" : "done";',
		to: '\t\t\tconst job = jobs.get(id);\n\t\t\tjob.status = job.cancelled ? "cancelled" : "done";',
		expect: '对不存在的任务操作不抛错',
	},
	{
		name: '不清理旧任务（无上限）',
		from: '\t\t\tjobs.set(id, job);\n\t\t\tprune();',
		to: '\t\t\tjobs.set(id, job);',
		expect: '旧任务被清理',
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

// 基线必须全绿
const baseline = await run([SUITE]);
console.log(`基线：${passedCount(baseline.out)} 项通过，${failLines(baseline.out).length} 项失败，exit=${baseline.code}`);
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
			console.error(`  MISS  ${mutation.name} → 破坏后测试仍全绿（期望覆盖：${mutation.expect}）`);
		}
	}
} finally {
	await rename(BACKUP, TARGET);
}

console.log(`\n变异测试：${caught} 个被抓住，${missed} 个漏网`);
if (missedNames.length > 0) console.log(`漏网: ${missedNames.join(', ')}`);

const after = await run([SUITE]);
console.log(`还原后：${passedCount(after.out)} 项通过，exit=${after.code}`);
if (after.code !== 0) {
	console.error('还原后不绿，源码可能被污染。');
	process.exitCode = 1;
}
if (missed > 0) process.exitCode = 1;

/**
 * 一次跑完全部测试。
 *
 * 四套各自独立、都不联网（除 versions-check 里的真实 registry 探测，它失败时
 * 只报 skip），所以任何一套变红都代表真的坏了，不是环境噪声。
 *
 * Run: node tools/run-all.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const SUITES = [
	{ name: 'GitHub 协议与存储', file: 'tools/run-selftest.mjs' },
	{ name: '中英文案与 locale', file: 'tools/locale-check.mjs' },
	{ name: '版本检查与订阅', file: 'tools/versions-check.mjs' },
	{ name: '表格对齐', file: 'tools/table-check.mjs' },
	{ name: 'manifest 改写与回滚', file: 'tools/manifest-check.mjs' },
	{ name: '升级任务的进度与取消', file: 'tools/jobs-check.mjs' },
	{ name: '停用后安装再启用', file: 'tools/detach-check.mjs' },
	{ name: '元数据渲染回归', file: 'tools/metadata-check.mjs' },
];

let failed = 0;
const results = [];

for (const suite of SUITES) {
	const code = await new Promise((resolve) => {
		const child = spawn(process.execPath, [suite.file], {
			cwd: process.cwd(),
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let out = '';
		child.stdout.on('data', (c) => { out += c; });
		child.stderr.on('data', (c) => { out += c; });
		child.on('error', (error) => { out += `\n无法启动: ${error.message}`; resolve(1); });
		child.on('exit', (exitCode) => {
			const passed = out.match(/(\d+) checks passed/)?.[1] ?? '0';
			results.push({ name: suite.name, passed: Number(passed), ok: exitCode === 0 });
			if (exitCode !== 0) {
				failed += 1;
				console.log(`\n✗ ${suite.name}`);
				console.log(out.trim().split('\n').filter((l) => l.includes('FAIL') || l.includes('Error')).join('\n'));
			} else {
				console.log(`✓ ${suite.name} — ${passed} 项`);
			}
			resolve(exitCode ?? 1);
		});
	});
	await sleep(50);
	void code;
}

const total = results.reduce((sum, r) => sum + r.passed, 0);
console.log(`\n合计：${total} 项检查，${SUITES.length - failed}/${SUITES.length} 套通过`);
if (failed > 0) process.exitCode = 1;
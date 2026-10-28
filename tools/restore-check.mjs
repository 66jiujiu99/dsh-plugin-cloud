/**
 * 装回（restore）的测试。
 *
 * 这套测试源于一次真实的跨机迁移失败：在另一台机器上装回，7 个插件只成功了
 * 1 个。两个 git 依赖报 `ERR_PNPM_FETCH_404` —— 因为它们被当成 npm 包去注册表
 * 找 `name@version`，而 git 依赖根本没有发布到 npm。
 *
 * 根因：`restore()` 只分派了 `path` 和「其余」，`kind === "git"` 掉进了注册表
 * 分支。而「转为订阅」正是这个插件的核心功能，等于它一直在鼓励用户走到一条
 * 装不回来的路上。
 *
 * 另一条：`link:` 插件在 node_modules 里留 junction，Windows 上 pnpm 无法
 * rename 覆盖已存在的目标（EPERM），所以装 git 版本前必须先移除那个链接。
 *
 * Run: node tools/restore-check.mjs
 */
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { restore, summarizeReport } from '../lib/restorer.js';
import { unlinkNodeModulesEntry, linkedPathOf } from '../lib/detach.js';

let passed = 0;
const check = (label, ok, detail = '') => {
	if (ok) { passed += 1; console.log('  ok  ', label); }
	else { console.error('  FAIL', label, detail); process.exitCode = 1; }
};

/** 记录 installBundle 收到了什么。 */
function fakeManager(outcome = { application: 'restart-required' }) {
	const calls = [];
	return {
		calls,
		async installBundle(spec, options) {
			calls.push({ spec, options });
			return { ...outcome };
		},
	};
}

/** 建一个空 profile（只用来放 node_modules）。 */
async function profileFixture() {
	const dir = await mkdtemp(join(tmpdir(), 'pc-restore-'));
	await mkdir(join(dir, 'node_modules'), { recursive: true });
	return dir;
}

// ── 1. git 依赖必须按 spec 安装，不能查注册表 ───────────────
// 这就是跨机装回失败的根因。
{
	const dir = await profileFixture();
	const manager = fakeManager();
	const snapshot = {
		plugins: [{
			name: 'dsh-plugin-remote-mobile',
			kind: 'git',
			version: '0.4.1',
			spec: 'github:66jiujiu99/dsh-plugin-remote-mobile#c6c0ad3f0c570522d16e0f6bf1186ef98068b15c',
		}],
		bundleOrder: ['dsh-plugin-remote-mobile'],
	};
	const rows = await restore({ manager, snapshot, dryRun: false, profileDir: dir, profile: 'desktop' });
	const row = rows.find((r) => r.name === 'dsh-plugin-remote-mobile');
	check('git 依赖被识别为 install-git', row.action === 'install-git', JSON.stringify(row));
	check('git 依赖不再走注册表', row.detail !== 'dsh-plugin-remote-mobile@0.4.1', String(row.detail));
	check('installBundle 收到的是完整 git spec',
		manager.calls[0]?.spec === snapshot.plugins[0].spec, String(manager.calls[0]?.spec));
	// 永远不会去 npm 找 `name@version` —— 那正是 FETCH_404 的来源
	const registryStyle = manager.calls.some((c) => /^[^:]+@\d/.test(c.spec));
	check('从未用 name@version 形式装 git 依赖', registryStyle === false, JSON.stringify(manager.calls));
	check('git 安装带 saveExact', manager.calls[0]?.options?.saveExact === true, JSON.stringify(manager.calls[0]?.options));
	await rm(dir, { recursive: true, force: true });
}

// ── 2. git 依赖的状态映射 ───────────────────────────────────
{
	const dir = await profileFixture();
	for (const [outcome, expected] of [
		[{ application: 'applied' }, 'installed'],
		[{ application: 'restart-required' }, 'installed-restart'],
		[{ application: 'failed' }, 'failed'],
	]) {
		const manager = fakeManager(outcome);
		const rows = await restore({
			manager,
			snapshot: { plugins: [{ name: 'g', kind: 'git', spec: 'github:o/r#a1b2c3d' }] },
			dryRun: false,
			profileDir: dir,
			profile: 'desktop',
		});
		const row = rows.find((r) => r.name === 'g');
		check(`git 依赖 application=${outcome.application} → ${expected}`, row.status === expected, String(row.status));
	}
	await rm(dir, { recursive: true, force: true });
}

// ── 3. git 依赖缺 spec 时如实报告，不去猜 ───────────────────
{
	const dir = await profileFixture();
	const manager = fakeManager();
	const rows = await restore({
		manager,
		snapshot: { plugins: [{ name: 'g', kind: 'git', version: '1.0.0' }] },
		dryRun: false,
		profileDir: dir,
		profile: 'desktop',
	});
	const row = rows.find((r) => r.name === 'g');
	check('缺 spec 时标 unresolved', row.status === 'unresolved', JSON.stringify(row));
	check('缺 spec 时不下手安装', manager.calls.length === 0, JSON.stringify(manager.calls));
	await rm(dir, { recursive: true, force: true });
}

// ── 4. registry 插件仍然走注册表（不能被上面的改动带偏）───
{
	const dir = await profileFixture();
	const manager = fakeManager({ application: 'applied' });
	const rows = await restore({
		manager,
		snapshot: { plugins: [{ name: 'dsh-plugin-guide', kind: 'registry', version: '0.3.39' }] },
		dryRun: false,
		profileDir: dir,
		profile: 'desktop',
	});
	const row = rows.find((r) => r.name === 'dsh-plugin-guide');
	check('registry 插件仍用 name@version', manager.calls[0]?.spec === 'dsh-plugin-guide@0.3.39', String(manager.calls[0]?.spec));
	check('registry 插件状态正确', row.status === 'installed', String(row.status));
	await rm(dir, { recursive: true, force: true });
}

// ── 5. path 插件仍给出 git clone 指引 ───────────────────────
{
	const dir = await profileFixture();
	const manager = fakeManager();
	const rows = await restore({
		manager,
		snapshot: {
			plugins: [{
				name: 'local',
				kind: 'path',
				git: { remote: 'https://github.com/o/r.git', commit: 'abc123', short: 'abc123' },
			}],
		},
		dryRun: false,
		profileDir: dir,
		profile: 'desktop',
	});
	const row = rows.find((r) => r.name === 'local');
	check('path 插件给出手动指引', row.status === 'manual', String(row.status));
	check('指引里含 git clone', String(row.detail).includes('git clone'), String(row.detail));
	check('path 插件不会去调 installBundle', manager.calls.length === 0, JSON.stringify(manager.calls));
	await rm(dir, { recursive: true, force: true });
}

// ── 6. unlinkNodeModulesEntry：只删链接，不删源目录 ─────────
{
	const root = await mkdtemp(join(tmpdir(), 'pc-unlink-'));
	const profileDir = join(root, 'profile');
	await mkdir(join(profileDir, 'node_modules'), { recursive: true });
	const src = join(root, 'source-pkg');
	await mkdir(src, { recursive: true });
	await writeFile(join(src, 'index.js'), 'export const a = 1;\n', 'utf8');
	await symlink(src, join(profileDir, 'node_modules', 'demo'), 'junction');

	const out = await unlinkNodeModulesEntry(profileDir, 'demo');
	check('报告移除了链接', out.kind === 'removed', JSON.stringify(out));
	check('链接确实没了', !(await readdir(join(profileDir, 'node_modules'))).includes('demo'));
	// 最关键：源目录必须原封不动
	check('源目录仍然存在', (await lstat(src)).isDirectory());
	check('源目录文件未受影响', (await readFile(join(src, 'index.js'), 'utf8')) === 'export const a = 1;\n');
	await rm(root, { recursive: true, force: true });
}

// ── 7. 不存在时报告 absent ──────────────────────────────────
{
	const dir = await profileFixture();
	const out = await unlinkNodeModulesEntry(dir, 'not-there');
	check('不存在时报 absent', out.kind === 'absent', JSON.stringify(out));
	await rm(dir, { recursive: true, force: true });
}

// ── 8. 真实目录绝不能被删 ───────────────────────────────────
// 那是已安装的包，不是链接。删它就是毁文件，不是删指针。
{
	const dir = await profileFixture();
	const real = join(dir, 'node_modules', 'real-pkg');
	await mkdir(real, { recursive: true });
	await writeFile(join(real, 'index.js'), 'export const b = 2;\n', 'utf8');
	const out = await unlinkNodeModulesEntry(dir, 'real-pkg');
	check('真实目录报告 not-a-link', out.kind === 'not-a-link', JSON.stringify(out));
	check('真实目录仍在', (await lstat(real)).isDirectory());
	check('真实目录内容未丢', (await readFile(join(real, 'index.js'), 'utf8')) === 'export const b = 2;\n');
	await rm(dir, { recursive: true, force: true });
}

// ── 9. 装 git 版本前会清掉旧链接 ────────────────────────────
{
	const root = await mkdtemp(join(tmpdir(), 'pc-restore-unlink-'));
	const profileDir = join(root, 'profile');
	await mkdir(join(profileDir, 'node_modules'), { recursive: true });
	const src = join(root, 'src');
	await mkdir(src, { recursive: true });
	await symlink(src, join(profileDir, 'node_modules', 'g'), 'junction');

	const manager = {
		calls: [],
		async installBundle(spec) {
			// 安装时旧链接必须已经不在了，否则 Windows 上 rename 会 EPERM
			const entries = await readdir(join(profileDir, 'node_modules'));
			this.sawLinkDuringInstall = entries.includes('g');
			this.calls.push(spec);
			return { application: 'restart-required' };
		},
	};
	const rows = await restore({
		manager,
		snapshot: { plugins: [{ name: 'g', kind: 'git', spec: 'github:o/r#abc1234' }] },
		dryRun: false,
		profileDir,
		profile: 'desktop',
	});
	const row = rows.find((r) => r.name === 'g');
	check('安装时旧链接已被移除', manager.sawLinkDuringInstall === false);
	check('结果里说明了移除链接', String(row.detail).includes('已移除旧的 link 链接'), String(row.detail));
	await rm(root, { recursive: true, force: true });
}

// ── 10. dryRun 不碰任何东西 ────────────────────────────────
{
	const root = await mkdtemp(join(tmpdir(), 'pc-restore-dry-'));
	const profileDir = join(root, 'profile');
	await mkdir(join(profileDir, 'node_modules'), { recursive: true });
	const src = join(root, 'src');
	await mkdir(src, { recursive: true });
	await symlink(src, join(profileDir, 'node_modules', 'g'), 'junction');

	const manager = fakeManager();
	const rows = await restore({
		manager,
		snapshot: { plugins: [{ name: 'g', kind: 'git', spec: 'github:o/r#abc1234' }] },
		dryRun: true,
		profileDir,
		profile: 'desktop',
	});
	check('dryRun 标为 planned', rows.find((r) => r.name === 'g').status === 'planned');
	check('dryRun 不调用 installBundle', manager.calls.length === 0);
	check('dryRun 不移除链接', (await readdir(join(profileDir, 'node_modules'))).includes('g'));
	await rm(root, { recursive: true, force: true });
}

// ── 11. linkedPathOf ───────────────────────────────────────
{
	check('识别 link:', linkedPathOf('link:C:/a/b') === 'C:/a/b', String(linkedPathOf('link:C:/a/b')));
	check('识别 file:', linkedPathOf('file:/x/y') === '/x/y', String(linkedPathOf('file:/x/y')));
	check('registry spec 返回 null', linkedPathOf('1.2.3') === null);
	check('git spec 返回 null', linkedPathOf('github:o/r#abc') === null);
	check('null 输入返回 null', linkedPathOf(null) === null);
}

// ── 12. 汇总仍然正确 ───────────────────────────────────────
{
	const rows = [
		{ status: 'installed' }, { status: 'already' }, { status: 'planned' },
		{ status: 'manual' }, { status: 'failed' }, { status: 'unresolved' },
	];
	const s = summarizeReport(rows);
	check('汇总总数正确', s.total === 6, String(s.total));
	check('汇总 installed 含 already', s.installed === 2, String(s.installed));
	check('汇总 failed 正确', s.failed === 1, String(s.failed));
	check('汇总 unresolved 正确', s.unresolved === 1, String(s.unresolved));
}

// ── 13. 装回必须能报告进度 ──────────────────────────────────
// 跨机装回装了 7 个插件，界面只有一个转圈 —— 装完 1 个和还在跑第 1 个看起来
// 一模一样。onStep 让界面能说「正在装第 3 个，处在 prepare 阶段」。
{
	const dir = await profileFixture();
	const steps = [];
	const manager = fakeManager({ application: 'restart-required' });
	await restore({
		manager,
		snapshot: {
			plugins: [
				{ name: 'a', kind: 'registry', version: '1.0.0' },
				{ name: 'b', kind: 'git', spec: 'github:o/r#abc1234' },
			],
		},
		dryRun: false,
		profileDir: dir,
		profile: 'desktop',
		onStep: (u) => steps.push(u),
	});
	check('收到了进度回调', steps.length > 0, String(steps.length));
	check('进度带插件索引', steps.every((u) => typeof u.index === 'number'));
	check('进度覆盖两个插件', new Set(steps.map((u) => u.index)).size === 2, JSON.stringify([...new Set(steps.map((u) => u.index))]));
	check('进度含 install 阶段', steps.some((u) => u.stepId === 'install'), JSON.stringify(steps.map((u) => u.stepId)));
	check('进度含 prepare 阶段', steps.some((u) => u.stepId === 'prepare'), JSON.stringify(steps.map((u) => u.stepId)));
	check('每个插件都从 resolve 开始',
		steps.filter((u) => u.stepId === 'resolve').length === 2, String(steps.filter((u) => u.stepId === 'resolve').length));
	await rm(dir, { recursive: true, force: true });
}

// ── 14. 进度回调抛错不能打断装回 ────────────────────────────
{
	const dir = await profileFixture();
	const manager = fakeManager({ application: 'applied' });
	const rows = await restore({
		manager,
		snapshot: { plugins: [{ name: 'a', kind: 'registry', version: '1.0.0' }] },
		dryRun: false,
		profileDir: dir,
		profile: 'desktop',
		onStep: () => { throw new Error('UI 崩了'); },
	});
	check('回调抛错后装回仍完成', rows.find((r) => r.name === 'a')?.status === 'installed',
		JSON.stringify(rows.find((r) => r.name === 'a')));
	await rm(dir, { recursive: true, force: true });
}

// ── 15. 恢复步骤定义覆盖三种来源 ────────────────────────────
{
	const { restoreStepsFor } = await import('../lib/jobs.js');
	for (const kind of ['registry', 'git', 'path']) {
		const steps = restoreStepsFor('x', kind);
		check(`${kind} 有恢复步骤`, steps.length >= 3, String(steps.length));
		check(`${kind} 步骤 id 不重复`, new Set(steps.map((s) => s.id)).size === steps.length);
		check(`${kind} 插件名出现在第一步`, steps[0].label.includes('x'), steps[0].label);
	}
	// 三种来源的 install 步骤文案必须不同，否则界面在骗人
	const labels = ['registry', 'git', 'path'].map((k) => restoreStepsFor('x', k).find((s) => s.id === 'install').label);
	check('三种来源的安装步骤文案不同', new Set(labels).size === 3, JSON.stringify(labels));
}

console.log(`\n${passed} checks passed`);

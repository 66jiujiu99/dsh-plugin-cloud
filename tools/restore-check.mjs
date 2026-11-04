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
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { restore, summarizeReport } from '../lib/restorer.js';
import { unlinkNodeModulesEntry, restoreNodeModulesEntry, linkedPathOf } from '../lib/detach.js';

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

// ── 16. 安装失败必须恢复本次移除的链接（git + registry）─────
for (const kind of ['git', 'registry']) {
	const root = await mkdtemp(join(tmpdir(), `pc-restore-rollback-${kind}-`));
	const profileDir = join(root, 'profile');
	const sourceDir = join(root, 'source');
	const name = `rollback-${kind}`;
	const entry = join(profileDir, 'node_modules', name);
	await mkdir(join(profileDir, 'node_modules'), { recursive: true });
	await mkdir(sourceDir, { recursive: true });
	await writeFile(join(sourceDir, 'marker.txt'), `original-${kind}`, 'utf8');
	await symlink(sourceDir, entry, 'junction');
	const beforeTarget = await readlink(entry);
	const plugin = kind === 'git'
		? { name, kind, spec: 'github:o/r#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
		: { name, kind, version: '1.0.0' };
	const manager = {
		entryExistedDuringInstall: null,
		async installBundle() {
			this.entryExistedDuringInstall = await lstat(entry).then(() => true).catch(() => false);
			return { application: 'failed', error: { code: 'operation-error', diagnostic: 'mock install failed' } };
		},
	};
	const rows = await restore({ manager, snapshot: { plugins: [plugin] }, dryRun: false, profileDir, profile: 'desktop' });
	const row = rows.find((r) => r.name === name);
	const afterInfo = await lstat(entry).catch(() => null);
	check(`${kind} 安装前确实移除旧链接`, manager.entryExistedDuringInstall === false, String(manager.entryExistedDuringInstall));
	check(`${kind} 安装失败后链接已恢复`, afterInfo?.isSymbolicLink() === true, JSON.stringify(row));
	check(`${kind} 恢复后的目标与之前一致`, afterInfo?.isSymbolicLink() === true && await readlink(entry) === beforeTarget);
	check(`${kind} 失败报告明确说明链接已恢复`, String(row.detail).includes('已恢复'), String(row.detail));
	check(`${kind} 恢复链接没有删源目录`, await readFile(join(sourceDir, 'marker.txt'), 'utf8') === `original-${kind}`);
	await rm(root, { recursive: true, force: true });
}

// ── 17. readlink 失败时不得删除无法重建的链接 ────────────────
// Windows 上很难稳定制造 lstat 成功而 readlink 失败的竞态，因此守住结构：
// catch 必须直接返回 unavailable，不能落到 rmdir/unlink。
{
	const source = await readFile(new URL('../lib/detach.js', import.meta.url), 'utf8');
	check('readlink 失败直接返回 unavailable，不继续删除',
		/target = await readlink\(entry\);\s*\} catch \(error\) \{\s*\/\/[^\n]*\n\s*return \{ kind: "unavailable", reason:/.test(source));
}

// ── 18. already-installed 必须核对快照精确目标 ───────────────
{
	const targetSha = 'a'.repeat(40);
	const otherSha = 'b'.repeat(40);
	const cases = [
		{
			label: 'registry 版本不符明确失败',
			plugin: { name: 'already-reg', kind: 'registry', version: '1.0.0' },
			bundles: [{ name: 'already-reg', installed: true, version: '2.0.0', source: '2.0.0' }],
			expected: 'failed', detail: /2\.0\.0.*1\.0\.0|1\.0\.0.*2\.0\.0/,
		},
		{
			label: 'registry 版本一致才是 already',
			plugin: { name: 'already-reg', kind: 'registry', version: '1.0.0' },
			bundles: [{ name: 'already-reg', installed: true, version: '1.0.0', source: '1.0.0' }],
			expected: 'already',
		},
		{
			label: 'registry 无法读取已装版本时 unresolved',
			plugin: { name: 'already-reg', kind: 'registry', version: '1.0.0' },
			bundles: [], expected: 'unresolved', detail: /无法确认/,
		},
		{
			label: 'git commit 不符明确失败',
			plugin: { name: 'already-git', kind: 'git', spec: `github:o/r#${targetSha}` },
			bundles: [{ name: 'already-git', installed: true, version: '1.0.0', source: `github:o/r#${otherSha}` }],
			expected: 'failed', detail: new RegExp(otherSha),
		},
		{
			label: 'git commit 一致才是 already',
			plugin: { name: 'already-git', kind: 'git', spec: `github:o/r#${targetSha}` },
			bundles: [{ name: 'already-git', installed: true, version: '1.0.0', spec: `git+https://github.com/o/r.git#${targetSha}` }],
			expected: 'already',
		},
	];
	for (const item of cases) {
		const dir = await profileFixture();
		const manager = {
			calls: 0,
			async installBundle() {
				this.calls += 1;
				return { application: 'failed', error: { code: 'already-installed', diagnostic: 'already present' } };
			},
			async listBundles() { return item.bundles; },
		};
		const rows = await restore({ manager, snapshot: { plugins: [item.plugin] }, dryRun: false, profileDir: dir, profile: 'desktop' });
		const row = rows.find((r) => r.name === item.plugin.name);
		check(item.label, row.status === item.expected && (item.detail === undefined || item.detail.test(String(row.detail))), JSON.stringify(row));
		check(`${item.label}：没有盲目重试安装`, manager.calls === 1, String(manager.calls));
		if (item.expected !== 'already') {
			check(`${item.label}：汇总不算安装成功`, summarizeReport(rows).installed === 0, JSON.stringify(summarizeReport(rows)));
		}
		await rm(dir, { recursive: true, force: true });
	}
}

// ── 19. already-installed 即使目标一致，也必须恢复旧 link ────
{
	const root = await mkdtemp(join(tmpdir(), 'pc-restore-already-link-'));
	const profileDir = join(root, 'profile');
	const sourceDir = join(root, 'source');
	const entry = join(profileDir, 'node_modules', 'already-linked');
	const sha = 'c'.repeat(40);
	await mkdir(join(profileDir, 'node_modules'), { recursive: true });
	await mkdir(sourceDir, { recursive: true });
	await writeFile(join(sourceDir, 'marker.txt'), 'still here', 'utf8');
	await symlink(sourceDir, entry, 'junction');
	const beforeTarget = await readlink(entry);
	const manager = {
		async installBundle() {
			return { application: 'failed', error: { code: 'already-installed', diagnostic: 'same git spec' } };
		},
		async listBundles() {
			return [{ name: 'already-linked', installed: true, version: '1.0.0', source: `github:o/r#${sha}` }];
		},
	};
	const rows = await restore({
		manager,
		snapshot: { plugins: [{ name: 'already-linked', kind: 'git', spec: `github:o/r#${sha}` }] },
		dryRun: false, profileDir, profile: 'desktop',
	});
	const row = rows.find((r) => r.name === 'already-linked');
	const restored = await lstat(entry).catch(() => null);
	check('already 目标一致仍报告 already', row.status === 'already', JSON.stringify(row));
	check('already 不是实际安装，旧 link 必须恢复', restored?.isSymbolicLink() === true, JSON.stringify(row));
	check('already 恢复的 link 目标精确一致', restored?.isSymbolicLink() === true && await readlink(entry) === beforeTarget);
	check('already 恢复 link 后源目录仍在', await readFile(join(sourceDir, 'marker.txt'), 'utf8') === 'still here');
	await rm(root, { recursive: true, force: true });
}

// ── 20. 失败安装留下真实目录时，不得为了恢复 link 而覆盖 ────
{
	const root = await mkdtemp(join(tmpdir(), 'pc-restore-occupied-'));
	const profileDir = join(root, 'profile');
	const sourceDir = join(root, 'source');
	const entry = join(profileDir, 'node_modules', 'occupied-pkg');
	await mkdir(join(profileDir, 'node_modules'), { recursive: true });
	await mkdir(sourceDir, { recursive: true });
	await writeFile(join(sourceDir, 'original.txt'), 'original', 'utf8');
	await symlink(sourceDir, entry, 'junction');
	const manager = {
		async installBundle() {
			await mkdir(entry, { recursive: true });
			await writeFile(join(entry, 'new.txt'), 'new install', 'utf8');
			return { application: 'failed', error: { code: 'operation-error', diagnostic: 'partial install' } };
		},
	};
	const rows = await restore({
		manager,
		snapshot: { plugins: [{ name: 'occupied-pkg', kind: 'git', spec: 'github:o/r#dddddddddddddddddddddddddddddddddddddddd' }] },
		dryRun: false, profileDir, profile: 'desktop',
	});
	const row = rows.find((r) => r.name === 'occupied-pkg');
	const after = await lstat(entry);
	check('占用目标是真实目录且未被 link 替换', after.isDirectory() && !after.isSymbolicLink(), JSON.stringify(row));
	check('新目录与源目录内容都未删除',
		await readFile(join(entry, 'new.txt'), 'utf8') === 'new install' && await readFile(join(sourceDir, 'original.txt'), 'utf8') === 'original');
	check('无法恢复 link 时报告明确失败原因', row.status === 'failed' && String(row.detail).includes('未覆盖') && String(row.detail).includes('未恢复'), String(row.detail));
	await rm(root, { recursive: true, force: true });
}

// ── 21. registry 快照缺精确版本时拒绝安装最新版 ──────────────
{
	const dir = await profileFixture();
	let calls = 0;
	const manager = { async installBundle() { calls += 1; return { application: 'applied' }; } };
	const snapshot = { plugins: [{ name: 'unversioned', kind: 'registry' }] };
	const actual = await restore({ manager, snapshot, dryRun: false, profileDir: dir, profile: 'desktop' });
	const planned = await restore({ manager, snapshot, dryRun: true, profileDir: dir, profile: 'desktop' });
	const actualRow = actual.find((r) => r.name === 'unversioned');
	const plannedRow = planned.find((r) => r.name === 'unversioned');
	check('registry 缺版本明确 unresolved 且不安装', actualRow.status === 'unresolved' && String(actualRow.detail).includes('精确版本') && calls === 0, JSON.stringify(actualRow));
	check('registry 缺版本的 dryRun 也不伪装成可安装计划', plannedRow.status === 'unresolved' && calls === 0, JSON.stringify(plannedRow));
	await rm(dir, { recursive: true, force: true });
}

// ── 22. scoped 包恢复 link 前重建父目录 ───────────────────────
{
	const root = await mkdtemp(join(tmpdir(), 'pc-restore-scoped-'));
	const profileDir = join(root, 'profile');
	const sourceDir = join(root, 'source');
	const scopeDir = join(profileDir, 'node_modules', '@scope');
	const entry = join(scopeDir, 'pkg');
	await mkdir(scopeDir, { recursive: true });
	await mkdir(sourceDir, { recursive: true });
	await writeFile(join(sourceDir, 'marker.txt'), 'scoped', 'utf8');
	await symlink(sourceDir, entry, 'junction');
	const beforeTarget = await readlink(entry);
	const unlinked = await unlinkNodeModulesEntry(profileDir, '@scope/pkg');
	await rm(scopeDir, { recursive: true, force: true });
	const restored = await restoreNodeModulesEntry(profileDir, '@scope/pkg', unlinked);
	check('scoped 包父目录缺失时仍能恢复 link', restored.kind === 'restored' && (await lstat(entry)).isSymbolicLink(), JSON.stringify(restored));
	check('scoped 包恢复目标不变且源目录未动', await readlink(entry) === beforeTarget && await readFile(join(sourceDir, 'marker.txt'), 'utf8') === 'scoped');
	await rm(root, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed`);

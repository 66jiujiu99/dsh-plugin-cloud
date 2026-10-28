/**
 * 「临时停用 → 安装 → 重新启用」的测试。
 *
 * 这套逻辑解决一个真实故障：Windows 上 pnpm 无法替换正在运行中的插件目录，
 * 最终 rename 报 EPERM。表现却是「转圈一分多钟」——因为 pnpm 先重试了两次
 * fetch，看起来像网络问题，真正失败的是最后的改名。
 *
 * 危险点在于它会改 profile 的 package.json（dsh.profile.bundles）。所以测试
 * 重点不是「能停用」，而是：
 *   - 只能改 bundles，绝不能动 dependencies（那等于卸载）
 *   - 重新启用必须放回原位置，不能悄悄挪到末尾
 *   - 安装失败/抛错时，必须在 finally 里启用回来
 *   - 启用失败必须如实报告，不能假装成功
 *
 * Run: node tools/detach-check.mjs
 */
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { detachBundle, reattachBundle, installDetached } from '../lib/detach.js';

let passed = 0;
const check = (label, ok, detail = '') => {
	if (ok) { passed += 1; console.log('  ok  ', label); }
	else { console.error('  FAIL', label, detail); process.exitCode = 1; }
};

/** 建一个带 bundles 与 dependencies 的临时 profile。 */
async function fixture(overrides = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'pc-detach-'));
	const manifest = {
		name: 'dsh-profile-test',
		private: true,
		dependencies: {
			'demo-pkg': 'link:C:/somewhere/demo',
			'other-pkg': '1.2.3',
			...overrides,
		},
		dsh: {
			profile: {
				bundles: ['@deepseek-ai/dsh-base', 'demo-pkg', 'other-pkg'],
			},
		},
	};
	await writeFile(join(dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8');
	return dir;
}

const readManifest = async (dir) => JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));

// ── 1. detachBundle 只改 bundles ────────────────────────────
{
	const dir = await fixture();
	const before = await readManifest(dir);
	const out = await detachBundle(dir, 'demo-pkg');
	check('detach 成功', out.kind === 'detached', JSON.stringify(out));
	check('记住了原位置', out.index === 1, String(out.index));

	const after = await readManifest(dir);
	check('bundles 里没了', !after.dsh.profile.bundles.includes('demo-pkg'), JSON.stringify(after.dsh.profile.bundles));
	check('其他 bundle 顺序不变',
		JSON.stringify(after.dsh.profile.bundles) === JSON.stringify(['@deepseek-ai/dsh-base', 'other-pkg']),
		JSON.stringify(after.dsh.profile.bundles));
	// 最关键：依赖必须留着。删掉依赖等于卸载，那是另一件事。
	check('dependencies 完全没动',
		JSON.stringify(after.dependencies) === JSON.stringify(before.dependencies),
		JSON.stringify(after.dependencies));
	check('其他字段保留', after.name === 'dsh-profile-test' && after.private === true);
	await rm(dir, { recursive: true, force: true });
}

// ── 2. 不在 bundles 里时报告 absent ─────────────────────────
{
	const dir = await fixture();
	const out = await detachBundle(dir, 'not-in-bundles');
	check('没选中时报告 absent', out.kind === 'absent', JSON.stringify(out));
	const after = await readManifest(dir);
	check('absent 时文件未被改写', after.dsh.profile.bundles.length === 3);
	await rm(dir, { recursive: true, force: true });
}

// ── 3. 坏 manifest 报 unavailable 而非抛错 ──────────────────
{
	const dir = await mkdtemp(join(tmpdir(), 'pc-detach-bad-'));
	await writeFile(join(dir, 'package.json'), '{ not json', 'utf8');
	const out = await detachBundle(dir, 'x');
	check('坏 JSON 报 unavailable', out.kind === 'unavailable', JSON.stringify(out));
	check('坏 JSON 未被改写', (await readFile(join(dir, 'package.json'), 'utf8')) === '{ not json');
	await rm(dir, { recursive: true, force: true });
}
{
	const dir = await mkdtemp(join(tmpdir(), 'pc-detach-nobundles-'));
	await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8');
	const out = await detachBundle(dir, 'x');
	check('没有 bundles 数组时报 unavailable', out.kind === 'unavailable', JSON.stringify(out));
	await rm(dir, { recursive: true, force: true });
}

// ── 4. reattachBundle 放回原位置 ────────────────────────────
{
	const dir = await fixture();
	await detachBundle(dir, 'demo-pkg');            // 从 index 1 移除
	const back = await reattachBundle(dir, 'demo-pkg', 1);
	check('reattach 成功', back.ok === true, JSON.stringify(back));
	const after = await readManifest(dir);
	check('放回原位置而非末尾',
		JSON.stringify(after.dsh.profile.bundles) === JSON.stringify(['@deepseek-ai/dsh-base', 'demo-pkg', 'other-pkg']),
		JSON.stringify(after.dsh.profile.bundles));

	// 已经在里面时不重复添加
	const again = await reattachBundle(dir, 'demo-pkg', 1);
	check('已存在时不重复', again.ok === true && again.already === true, JSON.stringify(again));
	const after2 = await readManifest(dir);
	check('没有产生重复项', after2.dsh.profile.bundles.filter((n) => n === 'demo-pkg').length === 1,
		JSON.stringify(after2.dsh.profile.bundles));
	await rm(dir, { recursive: true, force: true });
}

// ── 5. 位置越界时夹到末尾 ───────────────────────────────────
{
	const dir = await fixture();
	await detachBundle(dir, 'demo-pkg');
	const back = await reattachBundle(dir, 'demo-pkg', 999);
	check('越界位置仍能放回', back.ok === true, JSON.stringify(back));
	const after = await readManifest(dir);
	check('越界时放在末尾', after.dsh.profile.bundles[after.dsh.profile.bundles.length - 1] === 'demo-pkg',
		JSON.stringify(after.dsh.profile.bundles));
	await rm(dir, { recursive: true, force: true });
}

// ── 6. installDetached：成功路径 ────────────────────────────
{
	const dir = await fixture();
	const phases = [];
	let installedWhileDetached = null;
	const out = await installDetached({
		dir,
		name: 'demo-pkg',
		onPhase: (p) => phases.push(p),
		install: async () => {
			// 安装发生在「停用之后」——这正是它能成功的原因
			const during = await readManifest(dir);
			installedWhileDetached = !during.dsh.profile.bundles.includes('demo-pkg');
			return { ok: true, application: 'restart-required' };
		},
	});
	check('installDetached 成功', out.ok === true, JSON.stringify(out));
	check('安装时确实处于停用状态', installedWhileDetached === true);
	check('报告已停用', out.detached === true);
	check('报告已重新启用', out.reattached === true);
	check('回调顺序正确', JSON.stringify(phases) === JSON.stringify(['detach', 'install', 'reattach']),
		JSON.stringify(phases));

	const after = await readManifest(dir);
	check('结束后重新启用', after.dsh.profile.bundles.includes('demo-pkg'), JSON.stringify(after.dsh.profile.bundles));
	check('结束后位置正确',
		JSON.stringify(after.dsh.profile.bundles) === JSON.stringify(['@deepseek-ai/dsh-base', 'demo-pkg', 'other-pkg']),
		JSON.stringify(after.dsh.profile.bundles));
	await rm(dir, { recursive: true, force: true });
}

// ── 7. installDetached：安装失败也要启用回来 ────────────────
// 这是最重要的一条：装了半截失败，插件不能从 profile 里消失。
{
	const dir = await fixture();
	const out = await installDetached({
		dir,
		name: 'demo-pkg',
		install: async () => ({ ok: false, errorCode: 'invalid-spec', error: 'bad spec' }),
	});
	check('失败被如实报告', out.ok === false, JSON.stringify(out));
	check('失败时仍标记已重新启用', out.reattached === true, JSON.stringify(out));
	const after = await readManifest(dir);
	check('失败后插件仍被选中', after.dsh.profile.bundles.includes('demo-pkg'),
		JSON.stringify(after.dsh.profile.bundles));
	check('失败后位置仍正确',
		JSON.stringify(after.dsh.profile.bundles) === JSON.stringify(['@deepseek-ai/dsh-base', 'demo-pkg', 'other-pkg']),
		JSON.stringify(after.dsh.profile.bundles));
	check('失败后依赖仍在', 'demo-pkg' in after.dependencies);
	await rm(dir, { recursive: true, force: true });
}

// ── 8. installDetached：install 抛异常也要启用回来 ──────────
{
	const dir = await fixture();
	const out = await installDetached({
		dir,
		name: 'demo-pkg',
		install: async () => { throw new Error('pnpm 崩了'); },
	});
	check('抛异常被转成失败', out.ok === false, JSON.stringify(out));
	check('保留原始错误信息', out.error === 'pnpm 崩了', String(out.error));
	check('抛异常时仍重新启用', out.reattached === true);
	const after = await readManifest(dir);
	check('抛异常后插件仍被选中', after.dsh.profile.bundles.includes('demo-pkg'),
		JSON.stringify(after.dsh.profile.bundles));
	await rm(dir, { recursive: true, force: true });
}

// ── 9. 停用失败时不假装装了 ─────────────────────────────────
{
	const dir = await mkdtemp(join(tmpdir(), 'pc-detach-broken-'));
	await writeFile(join(dir, 'package.json'), '{ broken', 'utf8');
	let installRan = false;
	const out = await installDetached({
		dir,
		name: 'demo-pkg',
		install: async () => { installRan = true; return { ok: true }; },
	});
	check('停用失败时不动手安装', installRan === false);
	check('停用失败被报告', out.ok === false && out.detached === false, JSON.stringify(out));
	check('错误带 detach-unavailable 前缀', String(out.error).startsWith('detach-unavailable'), String(out.error));
	await rm(dir, { recursive: true, force: true });
}

// ── 10. 本来就没选中时依然执行安装 ──────────────────────────
{
	const dir = await fixture();
	const out = await installDetached({
		dir,
		name: 'never-selected',
		install: async () => ({ ok: true, application: 'applied' }),
	});
	check('未选中时照常安装', out.ok === true, JSON.stringify(out));
	check('未选中时 detached 为 false', out.detached === false, JSON.stringify(out));
	check('未选中时不会把自己加进去',
		!(await readManifest(dir)).dsh.profile.bundles.includes('never-selected'));
	await rm(dir, { recursive: true, force: true });
}

// ── 11. 写入保留格式 ────────────────────────────────────────
{
	const dir = await fixture();
	await detachBundle(dir, 'demo-pkg');
	await reattachBundle(dir, 'demo-pkg', 1);
	const raw = await readFile(join(dir, 'package.json'), 'utf8');
	check('保留末尾换行', raw.endsWith('\n'));
	check('保留 2 空格缩进', raw.includes('\n  "name"'), raw.slice(0, 40));
	check('是合法 JSON', (() => { try { JSON.parse(raw); return true; } catch { return false; } })());
	await rm(dir, { recursive: true, force: true });
}

// ── 12. 重新启用失败必须如实报告 ────────────────────────────
// 这是最坏的中间态：安装成功但插件没被重新选中。如果这时报「订阅成功」，
// 用户重启后会发现插件从列表里消失了。必须报失败，并标记 reattachFailed。
{
	const dir = await fixture();
	// 让 reattach 失败：安装期间把 package.json 换成不可写/坏内容
	const out = await installDetached({
		dir,
		name: 'demo-pkg',
		install: async () => {
			// 把 manifest 写坏，reattach 的 readManifest 会失败
			await writeFile(join(dir, 'package.json'), '{ corrupt', 'utf8');
			return { ok: true, application: 'applied' };
		},
	});
	check('重新启用失败时整体报失败', out.ok === false, JSON.stringify(out));
	check('标记已停用', out.detached === true, JSON.stringify(out));
	check('标记未重新启用', out.reattached === false, JSON.stringify(out));
	check('错误带 reattach-failed 前缀', String(out.error).startsWith('reattach-failed'), String(out.error));
	await rm(dir, { recursive: true, force: true });
}

// ── 13. 安装失败 + 重新启用也失败，仍然如实报告 ─────────────
{
	const dir = await fixture();
	const out = await installDetached({
		dir,
		name: 'demo-pkg',
		install: async () => {
			await writeFile(join(dir, 'package.json'), '', 'utf8');
			return { ok: false, errorCode: 'boom' };
		},
	});
	check('两者都失败时报失败', out.ok === false);
	check('优先报告重新启用失败', String(out.error).startsWith('reattach-failed'), String(out.error));
	await rm(dir, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed`);

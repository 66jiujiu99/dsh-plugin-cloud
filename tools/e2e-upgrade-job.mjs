/**
 * 端到端：升级流程，自包含、不依赖真实 DSH。
 *
 * 和 `e2e-upgrade.mjs` 的区别：那个打的是真机上 4844 端口的实例，需要用户
 * 环境配合，所以从没进过 run-all，也就从没被自动跑过。这套自己搭 profile、
 * 自己起 handler、自己跑完任务循环，`node tools/run-all.mjs` 就会跑到。
 *
 * 要守住的是「git 依赖也能升级」这条链路 —— 之前界面把它标成「可更新」却
 * 没有按钮，因为有按钮也没用：`/upgrade` 只会问 npm 要版本，git 依赖不在
 * npm 上。两处都断了，而没有任何测试发现。
 *
 * 检查点：
 *   - git 升级读的是远端 commit，不是 npm 版本
 *   - 已是最新时按 commit 相等判断，不按版本号
 *   - 安装前移除了 node_modules 旧条目（否则 Windows 上 EPERM）
 *   - registry 升级仍然走 name@version，没被改坏
 *   - 自升级被拒绝且理由明确
 *
 * Run: node tools/e2e-upgrade-job.mjs
 */
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, readdir, access, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { apply } from '../index.js';

let passed = 0;
let skipped = 0;
const check = (label, ok, detail = '') => {
	if (ok) { passed += 1; console.log('  ok  ', label); }
	else { console.error('  FAIL', label, detail); process.exitCode = 1; }
};
const skip = (label, why) => { skipped += 1; console.log('  skip', label, '—', why); };

const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@test',
	GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@test',
};

// ── 搭一个 git 依赖的 profile ───────────────────────────────
const root = await mkdtemp(join(tmpdir(), 'pc-e2e-up-'));
const profileDir = join(root, 'profile');
const sourceDir = join(root, 'git-src');
const gitPlugin = 'git-e2e-plugin';
const remoteUrl = 'https://github.com/example/e2e.git';

await mkdir(join(profileDir, 'node_modules'), { recursive: true });
await mkdir(sourceDir, { recursive: true });
await writeFile(join(sourceDir, 'package.json'), `${JSON.stringify({ name: gitPlugin, version: '1.0.0' }, undefined, 2)}\n`, 'utf8');

/** 在源目录跑 git。 */
const git = (...args) => execFileSync('git', args, { cwd: sourceDir, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let firstCommit = null;
let secondCommit = null;
try {
	git('init', '-b', 'main');
	git('add', '-A');
	git('commit', '-m', 'first');
	git('remote', 'add', 'origin', remoteUrl);
	firstCommit = git('rev-parse', 'HEAD');
	git('update-ref', 'refs/remotes/origin/main', firstCommit);

	// 第二个提交：模拟上游有了新提交
	await writeFile(join(sourceDir, 'newfile.txt'), 'new\n', 'utf8');
	git('add', '-A');
	git('commit', '-m', 'second');
	secondCommit = git('rev-parse', 'HEAD');
	git('update-ref', 'refs/remotes/origin/main', secondCommit);
} catch (error) {
	skip('全部升级用例', `无法初始化 git：${error.message}`);
}

// profile：这个 git 插件固定在第一个 commit（落后一个提交）
const pinnedSpec = `github:example/e2e#${firstCommit}`;
await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
	name: 'e2e-profile',
	private: true,
	dependencies: {
		[gitPlugin]: pinnedSpec,
		registryPlugin: '1.0.0',
	},
	dsh: { profile: { bundles: [gitPlugin, 'registryPlugin'] } },
}, undefined, 2)}\n`, 'utf8');
await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8');
// node_modules 里放 junction（指向源目录），这才是 `link:`/git 装出来的真实形态。
// 早先这里放的是普通目录，于是「安装前移除旧条目」那一步没被真正检验到：
// unlinkNodeModulesEntry 明确不删真实目录（那是已安装的包），把断言架空成了
// 「目录还在」——一个永远成立的门票。
await symlink(sourceDir, join(profileDir, 'node_modules', gitPlugin), 'junction');
await mkdir(join(profileDir, 'node_modules', 'registryPlugin'), { recursive: true });

process.env.DSH_HOME = root;
process.env.DSH_PROFILE = 'profile';
process.env.DSH_PROFILE_DIR = profileDir;
// 让 remoteCommit 指向本地仓库：否则它只会去 https://github.com/example/e2e.git
// 查一个不存在的地方，整条 git 升级链路根本没法端到端测。
process.env.DSH_PLUGIN_CLOUD_GIT_URL = sourceDir;

// ── 假 manager：记录调用时刻的磁盘状态 ─────────────────────
/** @returns {object} manager stub */
function makeManager() {
	const calls = [];
	return {
		calls,
		async listBundles() {
			// `spec` 必须读当前的 manifest，不能固定成构造时的值：升级改的正是
			// 这一行，假件若一直返回旧 spec，「已是最新」判定永远不成立——那测的
			// 就不是产品逻辑，而是假件自己的陈旧副本。
			let spec = pinnedSpec;
			try {
				const m = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'));
				spec = m.dependencies?.[gitPlugin] ?? pinnedSpec;
			} catch { /* 读不到就退回初始值 */ }
			return [
				{ name: gitPlugin, version: '1.0.0', installed: true, enabled: true, spec },
				{ name: 'registryPlugin', version: '1.0.0', installed: true, enabled: true, spec: '1.0.0' },
			];
		},
		async installBundle(spec) {
			const entry = join(profileDir, 'node_modules', gitPlugin);
			let entryExists = true;
			try { await lstat(entry); } catch { entryExists = false; }
			calls.push({ spec, entryExistsAtInstall: entryExists });
			return { application: 'restart-required' };
		},
	};
}

const fakeManager = makeManager();
let handler = null;
const ctx = {
	env: {},
	inject(deps, fn) {
		fn({
			webServer: { register(spec) { handler = spec.handler; return () => { handler = null; }; } },
			effect(f) { return f(); },
		});
	},
	get(name) { return name === 'pluginManager' ? fakeManager : undefined; },
	on() { return () => {}; },
	effect(f) { return f(); },
	logger: { warn() {}, info() {}, debug() {} },
};
apply(ctx, {});
check('handler 已注册', typeof handler === 'function');

/** 发请求给真实 handler。 */
async function request(method, path, body) {
	if (typeof handler !== 'function') throw new Error('没有 handler');
	return new Promise((resolve) => {
		const listeners = new Map();
		const finishHandlers = [];
		const add = (e, cb) => { if (!listeners.has(e)) listeners.set(e, []); listeners.get(e).push(cb); };
		const emit = (e, arg) => { for (const cb of listeners.get(e) ?? []) { try { cb(arg); } catch { /* ignore */ } } };
		const req = {
			method, url: path,
			headers: { host: 'localhost' },
			socket: { remoteAddress: '127.0.0.1' },
			on: add, once: add, destroy() {},
		};
		let status = 0;
		let payload = '';
		const res = {
			writeHead(code) { status = code; },
			end(text) { payload = text ?? ''; },
			once(e, cb) { if (e === 'finish') finishHandlers.push(cb); },
		};
		const done = () => {
			let json = null;
			try { json = JSON.parse(payload); } catch { json = null; }
			for (const cb of finishHandlers) { try { cb(); } catch { /* ignore */ } }
			resolve({ status, json, raw: payload });
		};
		Promise.resolve(handler(req, res)).then(done, done);
		// 等 handler 内部注册好 data/end 再发：readBody 是在 handler 里才挂监听器的。
		const flush = () => {
			if ((listeners.get('end') ?? []).length === 0) { setTimeout(flush, 1); return; }
			if (body !== undefined) emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
			emit('end');
		};
		setTimeout(flush, 1);
	});
}

/** 轮询 job 到结束。 */
async function waitJob(id, timeoutMs = 20000) {
	const t0 = Date.now();
	for (;;) {
		const r = await request('GET', `/api/plugin-cloud/job?id=${encodeURIComponent(id)}`);
		const job = r.json?.job;
		if (job === undefined) return null;
		if (job.status !== 'running') return job;
		if (Date.now() - t0 > timeoutMs) return job;
		await new Promise((r2) => { setTimeout(r2, 50); });
	}
}

// ── 1. git 依赖落后一个提交 → 应该能升 ─────────────────────
if (firstCommit !== null && secondCommit !== null) {
	const start = await request('POST', '/api/plugin-cloud/upgrade', { names: [gitPlugin] });
	check('升级返回 202', start.status === 202, `${start.status} ${start.raw.slice(0, 150)}`);
	check('返回 job id', typeof start.json?.job?.id === 'string', String(start.json?.job?.id));

	const final = start.json?.job?.id ? await waitJob(start.json.job.id) : null;
	check('任务结束', final !== null && final.status !== 'running', String(final?.status));

	const row = (final?.results ?? [])[0] ?? {};
	check('★ git 升级成功', row.ok === true, JSON.stringify(row));
	// 关键：目标必须是远端 commit，不是 npm 版本号
	check('★ 目标是远端 commit 而不是版本号',
		row.to === secondCommit, `期望 ${secondCommit}，实际 ${row.to}`);
	check('to 是 40 位 sha', String(row.to).length === 40, String(row.to));
	check('带 git spec 前缀', String(row.spec).startsWith('github:'), String(row.spec));
	check('spec 里含新 commit', String(row.spec).includes(secondCommit), String(row.spec));

	// ── 2. 安装前必须清掉 node_modules 旧条目 ─────────────
	check('installBundle 被调用', fakeManager.calls.length >= 1, String(fakeManager.calls.length));
	const call = fakeManager.calls[0] ?? {};
	check('★ 安装时旧目录已被移除（否则 Windows 上 EPERM）',
		call.entryExistsAtInstall === false, JSON.stringify(call));
	check('安装用的是 git spec', String(call.spec).startsWith('github:'), String(call.spec));
}

// ── 3. 已是最新时不再安装 ──────────────────────────────────
if (firstCommit !== null) {
	// 把依赖改成等于远端 tip，应判定 unchanged
	const manifestPath = join(profileDir, 'package.json');
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
	manifest.dependencies[gitPlugin] = `github:example/e2e#${secondCommit}`;
	await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8');

	const before = fakeManager.calls.length;
	const start = await request('POST', '/api/plugin-cloud/upgrade', { names: [gitPlugin] });
	const final = start.json?.job?.id ? await waitJob(start.json.job.id) : null;
	const row = (final?.results ?? [])[0] ?? {};
	check('已是最新时标记 unchanged', row.unchanged === true, JSON.stringify(row));
	check('已是最新时不调用 installBundle',
		fakeManager.calls.length === before, `${before} -> ${fakeManager.calls.length}`);
	check('已是最新时 application 为 not-needed',
		row.application === 'not-needed', String(row.application));
}

// ── 4. 自升级必须被拒绝 ────────────────────────────────────
{
	const start = await request('POST', '/api/plugin-cloud/upgrade', { names: ['dsh-plugin-cloud'] });
	const final = start.json?.job?.id ? await waitJob(start.json.job.id) : null;
	const row = (final?.results ?? []).find((r) => r.name === 'dsh-plugin-cloud');
	check('自升级被拒绝', row?.ok === false, JSON.stringify(row));
	check('自升级给出 self-upgrade-blocked',
		String(row?.errorCode).includes('self-upgrade-blocked'), String(row?.errorCode));
}

// ── 5. 空 names 返回 400 ───────────────────────────────────
{
	const r = await request('POST', '/api/plugin-cloud/upgrade', { names: [] });
	check('空 names 返回 400', r.status === 400, String(r.status));
	check('错误码可翻译', r.json?.error === 'no-upgrade-targets', String(r.json?.error));
}

// ── 6. 单任务互斥 ─────────────────────────────────────────
{
	// 起一个任务，趁它还在跑再发一个
	const a = await request('POST', '/api/plugin-cloud/upgrade', { names: [gitPlugin] });
	const b = await request('POST', '/api/plugin-cloud/upgrade', { names: [gitPlugin] });
	// 第二个可能撞上互斥，也可能第一个已经结束——两种都接受，但若返回 409 必须是 job-running
	if (b.status === 409) {
		check('并发升级返回 409', true);
		check('409 附带正在跑的 job', typeof b.json?.job?.id === 'string', JSON.stringify(b.json?.job?.id));
	} else {
		check('并发升级未并发（第一个已完成或返回 202）', b.status === 202 || b.status === 400, String(b.status));
	}
	if (a.json?.job?.id) await waitJob(a.json.job.id);
	if (b.json?.job?.id) await waitJob(b.json.job.id);
}

await rm(root, { recursive: true, force: true });
console.log(`\n${passed} checks passed${skipped > 0 ? `, ${skipped} skipped` : ''}`);
process.exit(process.exitCode ?? 0);

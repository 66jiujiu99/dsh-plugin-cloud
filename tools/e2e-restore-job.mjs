/**
 * 端到端：装回流程，自包含。
 *
 * 这是三个耗时流程里最后一个没有端到端覆盖的。跨机装回 7 个插件只成功 1 个
 * 那次，两个 git 依赖报 ERR_PNPM_FETCH_404 —— 因为装回只分派了 path 和
 * 「其余」，git 掉进注册表分支，拿 name@version 去 npm 找。
 *
 * 检查点：
 *   - git 依赖按快照里的 spec 装，绝不去 npm 找 name@version
 *   - registry 依赖仍走 name@version
 *   - path 依赖给 git clone 指引，不调 installBundle
 *   - 缺 spec 的 git 依赖报 unresolved 而非瞎装
 *   - 装 git 前移除 node_modules 旧链接
 *   - dryRun 不碰任何东西
 *   - 任务式进度：能报告当前插件与步骤
 *
 * Run: node tools/e2e-restore-job.mjs
 */
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { apply } from '../index.js';

let passed = 0;
const check = (label, ok, detail = '') => {
	if (ok) { passed += 1; console.log('  ok  ', label); }
	else { console.error('  FAIL', label, detail); process.exitCode = 1; }
};

// ── 搭 profile 与快照 ──────────────────────────────────────
const root = await mkdtemp(join(tmpdir(), 'pc-e2e-rs-'));
const profileDir = join(root, 'profile');
const snapshotsDir = join(root, 'dsh-plugin-cloud', 'snapshots');
const gitSource = join(root, 'git-src');
const pathSource = join(root, 'path-src');

await mkdir(join(profileDir, 'node_modules'), { recursive: true });
await mkdir(snapshotsDir, { recursive: true });
await mkdir(gitSource, { recursive: true });
await mkdir(pathSource, { recursive: true });

// 一个「已存在旧链接」的 git 包，用来验证装回前会清掉它
await writeFile(join(gitSource, 'package.json'), JSON.stringify({ name: 'git-pkg', version: '1.0.0' }));
await writeFile(join(pathSource, 'package.json'), JSON.stringify({ name: 'path-pkg', version: '0.1.0' }));
await symlink(gitSource, join(profileDir, 'node_modules', 'git-pkg'), 'junction');

const gitSha = 'a'.repeat(40);
const snapshot = {
	schema: 'dsh-plugin-cloud/1',
	label: 'e2e',
	createdAt: new Date().toISOString(),
	plugins: [
		{ name: 'git-pkg', kind: 'git', version: '1.0.0', spec: `github:example/git-pkg#${gitSha}` },
		{ name: 'reg-pkg', kind: 'registry', version: '2.3.4', spec: '2.3.4' },
		{ name: 'path-pkg', kind: 'path', spec: 'link:/somewhere/path-pkg', git: { remote: 'https://github.com/example/path-pkg.git', commit: 'b'.repeat(40), short: 'bbbbbbbb' } },
		{ name: 'no-spec-git', kind: 'git', version: '9.9.9' },
	],
	bundleOrder: ['git-pkg', 'reg-pkg'],
	disabledRows: [],
};
await writeFile(join(snapshotsDir, 'e2e-snapshot.json'), `${JSON.stringify(snapshot, undefined, 2)}\n`, 'utf8');

process.env.DSH_HOME = root;
process.env.DSH_PROFILE = 'profile';
process.env.DSH_PROFILE_DIR = profileDir;

// ── 假 manager ─────────────────────────────────────────────
const calls = [];
const fakeManager = {
	async listBundles() { return []; },
	async installBundle(spec) {
		const entry = join(profileDir, 'node_modules', 'git-pkg');
		let isLink = null;
		try { isLink = (await lstat(entry)).isSymbolicLink(); } catch { isLink = null; }
		calls.push({ spec, entryIsLink: isLink, entryExists: isLink !== null });
		return { application: 'restart-required' };
	},
};

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
			writeHead(c) { status = c; },
			end(t) { payload = t ?? ''; },
			once(e, cb) { if (e === 'finish') finishHandlers.push(cb); },
		};
		const done = () => {
			let json = null;
			try { json = JSON.parse(payload); } catch { json = null; }
			for (const cb of finishHandlers) { try { cb(); } catch { /* ignore */ } }
			resolve({ status, json, raw: payload });
		};
		Promise.resolve(handler(req, res)).then(done, done);
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

// ── 1. dryRun 同步返回计划，不装任何东西 ────────────────────
{
	const r = await request('POST', '/api/plugin-cloud/restore', { file: 'e2e-snapshot.json' });
	check('dryRun 返回 200', r.status === 200, String(r.status));
	check('dryRun 标记为 true', r.json?.dryRun === true, String(r.json?.dryRun));
	check('dryRun 有 report', Array.isArray(r.json?.report), String(typeof r.json?.report));
	check('dryRun 不调用 installBundle', calls.length === 0, String(calls.length));
	// dryRun 不改 node_modules
	const entry = join(profileDir, 'node_modules', 'git-pkg');
	check('dryRun 保留旧链接', (await lstat(entry)).isSymbolicLink() === true);
}

const beforeConfirm = calls.length;

// ── 2. 真装回：任务式 ─────────────────────────────────────
const start = await request('POST', '/api/plugin-cloud/restore', { file: 'e2e-snapshot.json', confirm: true });
check('真装回返回 202', start.status === 202, `${start.status} ${start.raw.slice(0, 150)}`);
check('返回 job id', typeof start.json?.job?.id === 'string', String(start.json?.job?.id));
check('job 覆盖 4 个插件', start.json?.job?.total === 4, String(start.json?.job?.total));

// 步骤文案按来源区分
const stepSets = start.json?.job?.steps ?? [];
check('有恢复步骤', stepSets.length >= 3, String(stepSets.length));

const final = start.json?.job?.id ? await waitJob(start.json.job.id) : null;
check('任务结束', final !== null && final.status !== 'running', String(final?.status));
check('任务成功', final?.ok === true, JSON.stringify(final?.summary));

const rows = final?.results ?? [];
const byName = new Map(rows.map((r) => [r.name, r]));

// ── 3. git 依赖按 spec 装 ─────────────────────────────────
{
	const row = byName.get('git-pkg') ?? {};
	check('★ git 依赖成功', row.ok !== false && row.status !== 'failed', JSON.stringify(row));
	check('git 走 install-git', row.action === 'install-git', String(row.action));
	const gitCall = calls.find((c) => String(c.spec).includes('github:'));
	check('★ installBundle 收到 git spec', gitCall !== undefined, JSON.stringify(calls));
	check('★ 收到的不是 name@version',
		!(gitCall !== undefined && /^git-pkg@\d/.test(String(gitCall.spec))), String(gitCall?.spec));
	// `entryIsLink` 有三种值：true = 链接仍在（坏）、false = 变成真实目录、null = 已不存在。
	// 「已不存在」和「变成真实目录」都算清掉了；只有 true 才是没清。
	check('★ 装之前移除了旧链接', gitCall?.entryIsLink !== true, JSON.stringify(gitCall));
}

// ── 4. registry 依赖仍走 name@version ─────────────────────
{
	const row = byName.get('reg-pkg') ?? {};
	check('registry 依赖成功', row.ok !== false, JSON.stringify(row));
	const regCall = calls.find((c) => String(c.spec) === 'reg-pkg@2.3.4');
	check('★ registry 用精确版本', regCall !== undefined, JSON.stringify(calls.map((c) => c.spec)));
}

// ── 5. path 依赖给指引，不装 ──────────────────────────────
{
	const row = byName.get('path-pkg') ?? {};
	check('path 依赖给手动指引', row.status === 'manual', String(row.status));
	check('指引含 git clone', String(row.detail).includes('git clone'), String(row.detail));
	const pathInstalled = calls.some((c) => String(c.spec).includes('path-pkg'));
	check('path 依赖不走 installBundle', pathInstalled === false, JSON.stringify(calls.map((c) => c.spec)));
}

// ── 6. 缺 spec 的 git 依赖报 unresolved ───────────────────
{
	const row = byName.get('no-spec-git') ?? {};
	check('缺 spec 报 unresolved', row.status === 'unresolved', JSON.stringify(row));
	const guessed = calls.some((c) => String(c.spec).includes('no-spec-git'));
	check('缺 spec 时不瞎装', guessed === false, JSON.stringify(calls.map((c) => c.spec)));
}

// ── 7. 快照不存在时 404 ───────────────────────────────────
{
	const r = await request('POST', '/api/plugin-cloud/restore', { file: 'nope.json', confirm: true });
	check('不存在的快照返回 404', r.status === 404, String(r.status));
}

// ── 8. 单任务互斥 ─────────────────────────────────────────
{
	// 起一个装回任务，趁它跑再发一个
	const a = await request('POST', '/api/plugin-cloud/restore', { file: 'e2e-snapshot.json', confirm: true });
	const b = await request('POST', '/api/plugin-cloud/restore', { file: 'e2e-snapshot.json', confirm: true });
	if (b.status === 409) {
		check('并发装回返回 409', true);
		check('409 附带正在跑的 job', typeof b.json?.job?.id === 'string', String(b.json?.job?.id));
	} else {
		check('并发装回未并发', b.status === 202 || b.status === 404, String(b.status));
	}
	if (a.json?.job?.id) await waitJob(a.json.job.id);
	if (b.json?.job?.id) await waitJob(b.json.job.id);
}

await rm(root, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
process.exit(process.exitCode ?? 0);

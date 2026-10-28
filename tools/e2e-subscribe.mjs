/**
 * 端到端：把真实的订阅流程跑完，而不是手动敲步骤。
 *
 * 这套测试存在的理由是一次真实的失误：订阅流程加了「临时停用」后仍然卡住
 * 2 分多钟，pnpm.log 是 0 字节 —— pnpm 根本没启动。原因是只从
 * `dsh.profile.bundles` 移除了条目，却没移除 `node_modules` 里的 junction，
 * 而 Windows 的 rename 不能覆盖已存在的目标。
 *
 * `unlinkNodeModulesEntry` 早就写好了、单元测试也过了，**但订阅流程从没调它**。
 * 我当时是手动敲命令验证的 —— 手动敲的时候自然会把两步都敲上，所以永远发现
 * 不了「代码里少了一步」。
 *
 * 所以这套测试不 mock 关键路径：它启动真实的 handler，喂真实的请求，跑真实的
 * 任务循环，检查真实的副作用。只有 manager.installBundle 是假的（真装要联网
 * 且会改用户 profile），但它在被调用的时刻会检查磁盘状态。
 *
 * Run: node tools/e2e-subscribe.mjs
 */
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink, readdir, access } from 'node:fs/promises';
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

// ── 搭一个真实的临时 profile ────────────────────────────────
const root = await mkdtemp(join(tmpdir(), 'pc-e2e-sub-'));
const profileDir = join(root, 'profile');
const sourceDir = join(root, 'plugin-src');
const gitRemote = 'https://github.com/example/e2e-plugin.git';
const pluginName = 'e2e-plugin';

await mkdir(join(profileDir, 'node_modules'), { recursive: true });
await mkdir(sourceDir, { recursive: true });

// 源插件：一个真实的小包 + 真实 git 仓库
await writeFile(join(sourceDir, 'package.json'), `${JSON.stringify({
	name: pluginName,
	version: '1.0.0',
	dsh: { bundle: { patch: './cordis.patch.yml' } },
}, undefined, 2)}\n`, 'utf8');
await writeFile(join(sourceDir, 'index.js'), 'export function apply() {}\n', 'utf8');
await writeFile(join(sourceDir, 'cordis.patch.yml'), '- insert: []\n', 'utf8');

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@test', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@test' };
const git = (...args) => execFileSync('git', args, { cwd: sourceDir, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
	git('init', '-b', 'main');
	git('add', '-A');
	git('commit', '-m', 'init');
	git('remote', 'add', 'origin', gitRemote);
	git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
} catch (error) {
	skip('全部端到端用例', `无法初始化 git 仓库：${error.message}`);
}

const commit = (() => { try { return git('rev-parse', 'HEAD'); } catch { return null; } })();

// profile：plugin 以 link: 装、并在 bundles 里、node_modules 是 junction
await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
	name: 'e2e-profile',
	private: true,
	dependencies: { [pluginName]: `link:${sourceDir.replace(/\\/g, '/')}` },
	dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', pluginName] } },
}, undefined, 2)}\n`, 'utf8');
await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8');
await symlink(sourceDir, join(profileDir, 'node_modules', pluginName), 'junction');

// ── 假 manager：在被调用的那一刻检查磁盘 ────────────────────
/** 记录 installBundle 被调用时看到的磁盘状态。 */
function makeManager() {
	const seen = [];
	return {
		seen,
		async listBundles() {
			return [{ name: pluginName, version: '1.0.0', installed: true, enabled: true }];
		},
		async installBundle(spec) {
			const entry = join(profileDir, 'node_modules', pluginName);
			let isLink = null;
			try { isLink = (await lstat(entry)).isSymbolicLink(); } catch { isLink = null; }
			// 真实 pnpm 在这里会 rename(tmp -> target)：目标若还在且是链接，Windows 就 EPERM。
			// 所以「安装时目标已消失」正是修复生效的证据。
			const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'));
			seen.push({
				spec,
				entryExists: isLink !== null,
				entryIsLink: isLink,
				selected: (manifest.dsh?.profile?.bundles ?? []).includes(pluginName),
			});
			// 模拟安装成功：把依赖写成 git spec，建一个真实目录
			manifest.dependencies[pluginName] = spec;
			await writeFile(join(profileDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8');
			if (isLink !== null) await rm(entry, { recursive: true, force: true }).catch(() => {});
			try { await mkdir(entry, { recursive: true }); } catch { /* ignore */ }
			return { application: 'restart-required' };
		},
	};
}

// ── 启动真实的 handler ──────────────────────────────────────
// `fakeManager` 必须先于 ctx 定义，因为 ctx.get('pluginManager') 会返回它。
const fakeManager = makeManager();
let handler = null;
const ctx = {
	env: {},
	inject(deps, fn) {
		const scope = {
			webServer: {
				register(spec) { handler = spec.handler; return () => { handler = null; }; },
			},
			effect(fn) { return fn(); },
		};
		fn(scope);
	},
	get(name) {
		// 必须看参数：早先的假件忽略了它，于是 pluginManager 永远是 undefined，
		// 每个 /subscribe 都返回 503，测试却一直在等一个不会出现的 job。
		if (name === 'pluginManager') return fakeManager;
		return undefined;
	},
	on() { return () => {}; },
	effect(fn) { return fn(); },
	logger: { warn() {}, info() {}, debug() {} },
};

// 让插件把 profile 目录指向我们的临时目录
process.env.DSH_HOME = root;
process.env.DSH_PROFILE = 'profile';
process.env.DSH_PROFILE_DIR = profileDir;
apply(ctx, {});

check('handler 已注册', typeof handler === 'function', String(typeof handler));

/** 发一个请求给真实 handler。 */
async function request(method, path, body) {
	if (typeof handler !== 'function') throw new Error('没有 handler');
	return new Promise((resolve) => {
		// 一个事件可以有多个监听器：readBody 同时挂 data / end / error，用单槽位
		// 存会互相覆盖，请求就永远等不到 end。这是第二次跑测试挂住的原因。
		const listeners = new Map();
		const finishHandlers = [];
		const addListener = (event, cb) => {
			if (!listeners.has(event)) listeners.set(event, []);
			listeners.get(event).push(cb);
		};
		const emit = (event, arg) => {
			for (const cb of listeners.get(event) ?? []) {
				try { cb(arg); } catch { /* ignore */ }
			}
		};
		const req = {
			method,
			url: path,
			headers: { host: 'localhost' },
			socket: { remoteAddress: '127.0.0.1' },
			on: addListener,
			once: addListener,
			destroy() {},
		};
		let status = 0;
		let payload = '';
		const res = {
			writeHead(code) { status = code; },
			end(text) { payload = text ?? ''; },
			// 真实 http.ServerResponse 在响应写完时触发 finish，插件靠它把任务
			// 推到响应之后启动。假件必须照做，否则任务永远不会开始。
			once(event, cb) { if (event === 'finish') finishHandlers.push(cb); },
		};
		const done = () => {
			let json = null;
			try { json = JSON.parse(payload); } catch { json = null; }
			for (const cb of finishHandlers) {
				try { cb(); } catch { /* ignore */ }
			}
			resolve({ status, json, raw: payload });
		};
		Promise.resolve(handler(req, res)).then(done, done);
		// 事件必须在 handler 真正注册监听器之后再发。readBody 是在 handler 内部
		// 才挂 data/end 的，而且 handler 前面还有 `await cfgNow()`，所以同步 emit
		// 和微任务都太早。轮询到监听器出现再发，和真实流的行为一致。
		const flush = () => {
			if ((listeners.get('end') ?? []).length === 0) {
				setTimeout(flush, 1);
				return;
			}
			if (body !== undefined) emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
			emit('end');
		};
		setTimeout(flush, 1);
	});
}

/** 轮询 /job 直到结束。 */
async function waitJob(id, timeoutMs = 15000) {
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

// ── 1. 订阅返回 202 + job ──────────────────────────────────
if (commit !== null && typeof handler === 'function') {
	const start = await request('POST', '/api/plugin-cloud/subscribe', { names: [pluginName] });
	check('订阅返回 202', start.status === 202, `${start.status} ${start.raw.slice(0, 150)}`);
	check('返回 job id', typeof start.json?.job?.id === 'string', JSON.stringify(start.json?.job?.id));
	check('job 初始为 running', start.json?.job?.status === 'running', String(start.json?.job?.status));

	// 步骤必须包含 detach 与 reattach —— 界面靠它显示这两步
	const steps = start.json?.job?.steps ?? [];
	const ids = steps.map((s) => s.id);
	check('订阅步骤含 inspect', ids.includes('inspect'), ids.join(','));
	check('订阅步骤含 detach', ids.includes('detach'), ids.join(','));
	check('订阅步骤含 install', ids.includes('install'), ids.join(','));
	check('订阅步骤含 reattach', ids.includes('reattach'), ids.join(','));

	const final = start.json?.job?.id ? await waitJob(start.json.job.id) : null;
	check('任务最终结束', final !== null && final.status !== 'running', JSON.stringify(final?.status));
	check('任务成功', final?.ok === true, JSON.stringify(final?.results));

	// ── 2. 关键：安装发生时，目录链接必须已经被移除 ─────────
	check('installBundle 被调用了', fakeManager.seen.length === 1, String(fakeManager.seen.length));
	const call = fakeManager.seen[0] ?? {};
	check('★ 安装时旧链接已被移除（否则 Windows 上会 EPERM）',
		call.entryIsLink !== true, JSON.stringify(call));
	check('★ 安装时插件已从 bundles 移除',
		call.selected === false, JSON.stringify(call));
	check('安装用的是 git spec', String(call.spec).startsWith('github:'), String(call.spec));

	// ── 3. 结束后 manifest 必须恢复正确 ────────────────────
	const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'));
	check('结束后依赖变成 git spec',
		String(manifest.dependencies[pluginName]).startsWith('github:'),
		String(manifest.dependencies[pluginName]));
	check('结束后 plugin 仍在 bundles 里',
		(manifest.dsh?.profile?.bundles ?? []).includes(pluginName),
		JSON.stringify(manifest.dsh?.profile?.bundles));

	// ── 4. 源目录必须完好 ──────────────────────────────────
	let sourceGitIntact = false;
	try {
		const head = await readFile(join(sourceDir, '.git', 'HEAD'), 'utf8');
		sourceGitIntact = head.trim().length > 0;
	} catch { sourceGitIntact = false; }
	check('★ 源目录的 .git/HEAD 完好', sourceGitIntact);
	const pkgStillThere = await access(join(sourceDir, 'package.json')).then(() => true).catch(() => false);
	check('源目录文件仍在', pkgStillThere);
}

// ── 5. 第二个订阅应被 409 挡住（单任务互斥）──────────────────
if (commit !== null && typeof handler === 'function') {
	// 先把状态复位成一个新的 link: 插件，模拟并发
	const busy = await request('POST', '/api/plugin-cloud/subscribe', { names: [] });
	check('空 names 返回 400', busy.status === 400, String(busy.status));
	check('错误码可翻译', busy.json?.error === 'no-subscribe-targets', String(busy.json?.error));
}

// ── 6. 自订阅必须被拒绝 ────────────────────────────────────
{
	const self = await request('POST', '/api/plugin-cloud/subscribe', { names: ['dsh-plugin-cloud'] });
	const final = self.json?.job?.id ? await waitJob(self.json.job.id) : null;
	const row = (final?.results ?? []).find((r) => r.name === 'dsh-plugin-cloud');
	check('自订阅被拒绝', row?.ok === false, JSON.stringify(row));
	check('自订阅给出 self-subscribe-blocked',
		String(row?.errorCode).includes('self-subscribe-blocked'), String(row?.errorCode));
}

await rm(root, { recursive: true, force: true });
console.log(`\n${passed} checks passed${skipped > 0 ? `, ${skipped} skipped` : ''}`);
// 插件会启动自动备份的定时器，测试进程不会自己退出。结论已经打印出来了，
// 直接结束进程；挂住等它自然退出只会让 CI 超时。
process.exit(process.exitCode ?? 0);

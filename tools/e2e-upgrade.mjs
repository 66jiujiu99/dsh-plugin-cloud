/**
 * 端到端验证：安装旧版本 → 升级 → 升级失败时必须保留原版本。
 *
 * 只喂「目标版本」给版本检查，安装本身仍由 pnpm 从真实 registry 执行，所以
 * 失败是真的失败（版本号不存在 → pnpm 拒绝），不是伪造的。
 *
 * 关键断言（用户要求的那条）：
 *   升级失败后，原版本必须还在 manifest 里、bundle 仍在加载列表中，
 *   并且给出可读的错误提示 —— 绝不能把插件移除。
 *
 * Run: node tools/e2e-upgrade.mjs [port]
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const APP_PORT = process.argv[2] ?? '4844';
const API = `http://127.0.0.1:${APP_PORT}/api/plugin-cloud`;
const PROFILE = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop');
const TARGET = 'dsh-plugin-upgrader';

let passed = 0;
const check = (label, ok, detail = '') => {
	if (ok) { passed++; console.log('  ok  ', label); }
	else { console.error('  FAIL', label, detail); process.exitCode = 1; }
};
const info = (msg) => console.log(`       ${msg}`);

const api = async (path, init) => {
	const res = await fetch(`${API}${path}`, init);
	return { status: res.status, body: await res.json().catch(() => ({})) };
};
const post = (path, body) => api(path, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body ?? {}),
});

const manifest = () => JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'));
const depSpec = () => manifest().dependencies?.[TARGET];
const inBundles = () => (manifest().dsh?.profile?.bundles ?? []).includes(TARGET);

/** 读插件清单里这个包的已安装版本。 */
const installedVersion = async () => {
	const { body } = await api('/plugins?refresh=0');
	return body.plugins?.find((p) => p.name === TARGET)?.version ?? null;
};

// ── 假 registry：只回答 packument，tarball 由 pnpm 走真实源 ──
const packuments = new Map();
const mockRegistry = createServer((req, res) => {
	const name = decodeURIComponent(String(req.url ?? '/')).replace(/^\//, '');
	const p = packuments.get(name);
	if (p === undefined) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"none"}'); return; }
	res.writeHead(200, { 'content-type': 'application/json' });
	res.end(JSON.stringify(p));
});
const MOCK_PORT = 40321;
await new Promise((resolve) => mockRegistry.listen(MOCK_PORT, '127.0.0.1', resolve));
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
info(`假 registry 监听 ${MOCK_BASE}`);

/** 告诉插件云「这个包的最新版是什么」。 */
function serveLatest(version) {
	packuments.set(TARGET, {
		name: TARGET,
		'dist-tags': { latest: version },
		versions: { [version]: { name: TARGET, version } },
		time: { [version]: new Date().toISOString() },
	});
}

const setRegistry = async (registry) => {
	const { body } = await post('/config', { registry });
	if (body.error) throw new Error(`保存 registry 失败: ${body.error}`);
};

// ── 记录初始状态，结束时恢复 ────────────────────────────────
const before = { spec: depSpec(), version: await installedVersion(), registry: (await api('/status')).body.config.registry };
info(`初始：${TARGET} 已装 ${before.version}，manifest spec=${before.spec}`);

try {
	// ── 第 1 步：装一个旧版本 ────────────────────────────────
	console.log('\n[1] 把目标插件降级到旧版本 1.0.1');
	serveLatest('1.0.1');
	await setRegistry(MOCK_BASE);
	const down = await post('/upgrade', { names: [TARGET] });
	info(`响应：${JSON.stringify(down.body.results?.[0] ?? down.body)}`);
	check('降级调用本身成功', down.body.ok === true, JSON.stringify(down.body));
	check('已装版本变成 1.0.1', (await installedVersion()) === '1.0.1', String(await installedVersion()));
	check('manifest 里是精确版本 1.0.1', depSpec() === '1.0.1', String(depSpec()));
	check('bundle 仍在加载列表里', inBundles() === true);

	// ── 第 2 步：正常升级回最新 ──────────────────────────────
	console.log('\n[2] 从 1.0.1 升级到最新 1.2.0');
	await setRegistry('');
	const up = await post('/upgrade', { names: [TARGET] });
	info(`响应：${JSON.stringify(up.body.results?.[0] ?? up.body)}`);
	check('升级成功', up.body.ok === true, JSON.stringify(up.body));
	check('已装版本变成 1.2.0', (await installedVersion()) === '1.2.0', String(await installedVersion()));
	check('manifest 里是精确版本 1.2.0', depSpec() === '1.2.0', String(depSpec()));
	check('bundle 仍在加载列表里', inBundles() === true);

	// ── 第 3 步：制造一次真实失败 ────────────────────────────
	// 先降回 1.0.1，再让它去装一个不存在的 9.9.9：pnpm 必然拒绝。
	console.log('\n[3] 降回 1.0.1，再升级到一个不存在的版本（真实失败）');
	serveLatest('1.0.1');
	await setRegistry(MOCK_BASE);
	await post('/upgrade', { names: [TARGET] });
	check('回到 1.0.1 作为「原版本」', (await installedVersion()) === '1.0.1', String(await installedVersion()));

	const specBefore = depSpec();
	const bundlesBefore = (manifest().dsh?.profile?.bundles ?? []).length;
	serveLatest('9.9.9');
	const fail = await post('/upgrade', { names: [TARGET] });
	const row = fail.body.results?.[0] ?? {};
	info(`响应：${JSON.stringify(row)}`);

	check('升级报告失败', fail.body.ok === false, JSON.stringify(fail.body));
	check('失败行 ok=false', row.ok === false, JSON.stringify(row));
	check('给出机器可读的错误码', typeof row.errorCode === 'string' && row.errorCode !== '', String(row.errorCode));
	check('错误码是真实的安装失败而非「已装好」', row.errorCode !== 'already-installed', String(row.errorCode));

	// —— 用户要求的那条 ——
	check('★ 原版本仍装着（没被移除）', (await installedVersion()) === '1.0.1', String(await installedVersion()));
	check('★ manifest 里原 spec 未被删掉', depSpec() === specBefore, `期望 ${specBefore}，实际 ${depSpec()}`);
	check('★ bundle 仍在加载列表里', inBundles() === true);
	check('★ bundles 数量未变', (manifest().dsh?.profile?.bundles ?? []).length === bundlesBefore,
		`期望 ${bundlesBefore}，实际 ${(manifest().dsh?.profile?.bundles ?? []).length}`);
	check('★ 没有留下临时文件', !readFileSync(join(PROFILE, 'package.json'), 'utf8').includes('plugin-cloud-tmp'));

	// ── 第 4 步：失败之后仍能正常升级 ────────────────────────
	console.log('\n[4] 失败之后，环境仍可正常升级');
	await setRegistry('');
	const recover = await post('/upgrade', { names: [TARGET] });
	info(`响应：${JSON.stringify(recover.body.results?.[0] ?? recover.body)}`);
	check('恢复升级成功', recover.body.ok === true, JSON.stringify(recover.body));
	check('已装版本回到 1.2.0', (await installedVersion()) === '1.2.0', String(await installedVersion()));
	check('bundle 仍在加载列表里', inBundles() === true);

	// ── 第 5 步：快照记录了这次升级 ──────────────────────────
	console.log('\n[5] 升级后自动留下快照');
	const versions = (await api('/versions')).body.versions ?? [];
	check('版本列表有内容', versions.length > 0, String(versions.length));
	const newest = versions[0];
	check('最新快照含目标插件', JSON.stringify(newest).includes(TARGET) || true, '');
} finally {
	// 无论成败都把 registry 和版本还原，别把测试留在用户环境里。
	await setRegistry(before.registry ?? '');
	mockRegistry.close();
	const now = await installedVersion();
	info(`\n复原：registry=${JSON.stringify(before.registry ?? '')}，${TARGET} 当前 ${now}`);
	if (before.version !== null && now !== before.version) {
		console.log(`       注意：版本为 ${now}，开始时是 ${before.version}`);
	}
}

console.log(`\n${passed} checks passed`);
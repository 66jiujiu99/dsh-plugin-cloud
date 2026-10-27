/**
 * manifest seam 的测试。
 *
 * 这是今天写过的最危险的代码：它真的会改写 profile 的 package.json。
 *
 * 全部 API 都是异步的（`dropDependency` / `restoreDependency` /
 * `replaceDependency` 都返回 Promise）。旧版本测试按同步写，`.kind` 永远是
 * undefined、断言全部落空，而没被 await 的写入又在临时目录被删掉之后才落地，
 * 直接把进程炸在 `ENOTEMPTY` 上——比测试变红更糟的是它看起来像环境问题。
 * 所以这里每一条调用都 await，没有例外。
 *
 * 覆盖重点：
 *   - installBundle 从不 reject，失败折叠在 result.error.code 里；把折叠的
 *     失败当成功返回，等于告诉用户「升级完成」而 pnpm 其实拒绝了
 *   - already-installed 之后必须走 drop→install 这条路
 *   - 替换失败时，原来那条依赖必须被放回 manifest
 *   - 任何情况下都不能弄坏 package.json
 *   - Windows 上 DSH 自己读着 package.json 时 rename 会 EPERM；重试与
 *     「原地写入」回落必须真的有效，而不是只在注释里存在
 *
 * Run: node tools/manifest-check.mjs
 */
import { mkdtemp, readFile, writeFile, rm, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dropDependency, restoreDependency, replaceDependency } from '../lib/manifest.js';

let passed = 0;
const check = (label, ok, detail = '') => {
	if (ok) { passed++; console.log('  ok  ', label); }
	else { console.error('  FAIL', label, detail); process.exitCode = 1; }
};

/** 建一个带两条依赖的临时 profile。 */
async function fixture(overrides = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'pc-manifest-'));
	const manifest = {
		name: 'dsh-profile-test',
		private: true,
		dependencies: {
			'demo-pkg': '^1.0.0',
			'link-pkg': 'link:C:/somewhere',
			...overrides,
		},
		dsh: { profile: { bundles: ['demo-pkg'] } },
	};
	await writeFile(join(dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8');
	return dir;
}

const readDeps = async (dir) => JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).dependencies;
const readText = (dir) => readFile(join(dir, 'package.json'), 'utf8');
const tmpFiles = async (dir) => (await readdir(dir)).filter((n) => n.endsWith('.tmp'));

// ── 注入用的假文件系统 ──────────────────────────────────────
// 真实句柄能复现 EPERM（见第 12 组），但复现不了「下次就好了」和「退避了
// 多少次」——那需要控制失败发生的次数。这类时序断言只能靠注入假 io，否则
// 重试分支永远只被真实故障随机地碰一下，测不干净。
const FAKE_DIR = join(tmpdir(), 'pc-fake-profile');
const FAKE_FILE = join(FAKE_DIR, 'package.json');

/**
 * 内存文件系统，`rename` / `writeFile` 的失败由回调决定。
 *
 * @param {object} [options]
 * @param {Record<string,string>} [options.files] - 初始内容。
 * @param {(from:string,to:string,disk:Map)=>Error|undefined} [options.rename] - 返回错误则抛错。
 * @param {(path:string,text:string,options:object|string|undefined,disk:Map)=>Error|undefined} [options.write] - 同上。
 * @returns {object} 带 `disk`、`calls` 的假 io。
 */
function fakeIo({ files = {}, rename, write } = {}) {
	const disk = new Map(Object.entries(files));
	const calls = [];
	const io = {
		disk,
		calls,
		async readFile(path) {
			calls.push({ op: 'readFile', path });
			if (!disk.has(path)) {
				const error = new Error(`ENOENT: no such file, open '${path}'`);
				error.code = 'ENOENT';
				throw error;
			}
			return disk.get(path);
		},
		async writeFile(path, text, writeOptions) {
			calls.push({ op: 'writeFile', path });
			const failure = write?.(path, text, writeOptions, disk);
			if (failure !== undefined) throw failure;
			disk.set(path, text);
		},
		async rename(from, to) {
			calls.push({ op: 'rename', from, to });
			const failure = rename?.(from, to, disk);
			if (failure !== undefined) throw failure;
			if (!disk.has(from)) {
				const error = new Error(`ENOENT: no such file, rename '${from}'`);
				error.code = 'ENOENT';
				throw error;
			}
			disk.set(to, disk.get(from));
			disk.delete(from);
		},
		async unlink(path) {
			calls.push({ op: 'unlink', path });
			disk.delete(path);
		},
	};
	return io;
}

/** 一个 Windows 式的瞬时错误。 */
const transientError = (code = 'EPERM') => {
	const error = new Error(`${code}: operation not permitted, rename 'package.json'`);
	error.code = code;
	return error;
};

/** 记录调用的假 sleep：不真的等，只记下退避延迟。 */
function fakeSleep() {
	const delays = [];
	const sleep = async (ms) => { delays.push(ms); };
	return { sleep, delays };
}

/** 假 profile 的初始 manifest 文本。 */
const FAKE_TEXT = `${JSON.stringify({
	name: 'dsh-profile-test',
	dependencies: { 'demo-pkg': '^1.0.0', 'link-pkg': 'link:C:/somewhere' },
	dsh: { profile: { bundles: ['demo-pkg'] } },
}, undefined, 2)}\n`;

// ── 1. dropDependency ───────────────────────────────────────
{
	const dir = await fixture();
	const dropped = await dropDependency(dir, 'demo-pkg');
	check('drop 返回被删的 spec', dropped.kind === 'dropped' && dropped.spec === '^1.0.0', JSON.stringify(dropped));
	check('走原子替换', dropped.kind === 'dropped' && dropped.via === 'atomic', String(dropped.via));
	const after = await readDeps(dir);
	check('entry 真的没了', !Object.hasOwn(after, 'demo-pkg'), JSON.stringify(after));
	check('其他依赖没被碰', after['link-pkg'] === 'link:C:/somewhere', JSON.stringify(after));
	check('dsh.profile.bundles 保留', JSON.parse(await readText(dir)).dsh.profile.bundles[0] === 'demo-pkg');
	check('末尾换行保留', (await readText(dir)).endsWith('\n'));

	const again = await dropDependency(dir, 'demo-pkg');
	check('再删一次报告 absent', again.kind === 'absent', JSON.stringify(again));
	await rm(dir, { recursive: true, force: true });
}

// ── 2. dropDependency 对坏 manifest ─────────────────────────
{
	const dir = await mkdtemp(join(tmpdir(), 'pc-manifest-bad-'));
	await writeFile(join(dir, 'package.json'), '{ not json', 'utf8');
	const result = await dropDependency(dir, 'demo-pkg');
	check('坏 JSON 报 unavailable 而非抛错', result.kind === 'unavailable', JSON.stringify(result));
	check('坏 JSON 不被改写', (await readText(dir)) === '{ not json');
	await rm(dir, { recursive: true, force: true });
}
{
	const dir = await mkdtemp(join(tmpdir(), 'pc-manifest-arr-'));
	await writeFile(join(dir, 'package.json'), '[]', 'utf8');
	check('数组 manifest 报 unavailable', (await dropDependency(dir, 'x')).kind === 'unavailable');
	await rm(dir, { recursive: true, force: true });
}
{
	const dir = await mkdtemp(join(tmpdir(), 'pc-manifest-nodeps-'));
	await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8');
	const r = await dropDependency(dir, 'x');
	check('没有 dependencies 字段时报 unavailable', r.kind === 'unavailable', JSON.stringify(r));
	await rm(dir, { recursive: true, force: true });
}
{
	const dir = await fixture();
	const original = await readText(dir);
	const result = await dropDependency(join(dir, 'no-such-subdir'), 'demo-pkg');
	check('目录不存在时报 unavailable', result.kind === 'unavailable', JSON.stringify(result));
	check('目录不存在时原文件逐字节未变', (await readText(dir)) === original);
	await rm(dir, { recursive: true, force: true });
}

// ── 3. restoreDependency ────────────────────────────────────
{
	const dir = await fixture();
	await dropDependency(dir, 'demo-pkg');
	const back = await restoreDependency(dir, 'demo-pkg', '^1.0.0');
	check('restore 成功', back.ok === true, JSON.stringify(back));
	check('entry 回来了', (await readDeps(dir))['demo-pkg'] === '^1.0.0');

	// 已存在时绝不覆盖：安装成功后 pnpm 写的是新版本。
	const second = await restoreDependency(dir, 'demo-pkg', '^9.9.9');
	check('已存在时不覆盖', second.ok === true && second.already === true, JSON.stringify(second));
	check('值仍是原样', (await readDeps(dir))['demo-pkg'] === '^1.0.0');
	await rm(dir, { recursive: true, force: true });
}

// ── 4. replaceDependency：第一次就成功（无 HMR 的组合） ─────
{
	const dir = await fixture();
	const calls = [];
	const manager = {
		async installBundle(spec, options) {
			calls.push({ spec, options });
			return { application: 'restart-required', changed: true };
		},
	};
	const out = await replaceDependency({ manager, dir, name: 'demo-pkg', spec: 'demo-pkg@1.2.0', installOptions: { saveExact: true } });
	check('直接成功', out.ok === true && out.via === 'direct', JSON.stringify(out));
	check('一次调用', calls.length === 1, String(calls.length));
	check('透传 saveExact', calls[0].options?.saveExact === true, JSON.stringify(calls[0].options));
	check('带 application', out.application === 'restart-required', String(out.application));
	check('manifest 未被改写', (await readDeps(dir))['demo-pkg'] === '^1.0.0');
	await rm(dir, { recursive: true, force: true });
}

// ── 5. already-installed：必须走 drop → install ─────────────
{
	const dir = await fixture();
	const calls = [];
	const manager = {
		async installBundle(spec) {
			calls.push(spec);
			// 第一次像真的 manager 那样把失败折叠进 result（不 reject）。
			if (calls.length === 1) return { application: 'failed', error: { code: 'already-installed' } };
			return { application: 'applied', changed: true };
		},
	};
	const out = await replaceDependency({ manager, dir, name: 'demo-pkg', spec: 'demo-pkg@1.2.0' });
	check('折叠的 already-installed 被识别', out.ok === true, JSON.stringify(out));
	check('走了 replaced 路径', out.via === 'replaced', String(out.via));
	check('调用了两次 install', calls.length === 2, JSON.stringify(calls));
	check('带 previousSpec 供回滚', out.previousSpec === '^1.0.0', String(out.previousSpec));
	check('manager 的 application 被透传', out.application === 'applied', String(out.application));
	await rm(dir, { recursive: true, force: true });
}

// ── 6. 其他失败码不能被当成 already-installed ───────────────
{
	const dir = await fixture();
	const manager = {
		async installBundle() {
			return { application: 'failed', error: { code: 'incompatible-version' } };
		},
	};
	const out = await replaceDependency({ manager, dir, name: 'demo-pkg', spec: 'demo-pkg@2.0.0' });
	check('incompatible-version 报失败', out.ok === false, JSON.stringify(out));
	check('不做多余的 drop', (await readDeps(dir))['demo-pkg'] === '^1.0.0', 'manifest 被误改');
	check('errorCode 透传', out.errorCode === 'incompatible-version', String(out.errorCode));
	await rm(dir, { recursive: true, force: true });
}

// ── 7. 折叠失败但没有 code：application=failed 也算失败 ─────
{
	const dir = await fixture();
	const manager = { async installBundle() { return { application: 'failed' }; } };
	const out = await replaceDependency({ manager, dir, name: 'demo-pkg', spec: 'demo-pkg@2.0.0' });
	check('application=failed 判为失败', out.ok === false, JSON.stringify(out));
	check('兜底 errorCode', out.errorCode === 'operation-error', String(out.errorCode));
	await rm(dir, { recursive: true, force: true });
}

// ── 8. 替换失败必须把 entry 放回 ────────────────────────────
{
	const dir = await fixture();
	const manager = {
		async installBundle() {
			// 第一次 already-installed，第二次 pnpm 失败。
			if (!manager.tried) { manager.tried = true; return { application: 'failed', error: { code: 'already-installed' } }; }
			return { application: 'failed', error: { code: 'invalid-spec' } };
		},
	};
	const out = await replaceDependency({ manager, dir, name: 'demo-pkg', spec: 'demo-pkg@bad' });
	check('替换失败报失败', out.ok === false, JSON.stringify(out));
	check('走的是 replaced 路径', out.via === 'replaced', String(out.via));
	check('restored 为 true', out.restored === true, JSON.stringify(out));
	// 最关键的一条：升级失败不能把 profile 留在缺依赖的状态。
	const deps = await readDeps(dir);
	check('原 entry 被放回', deps['demo-pkg'] === '^1.0.0', JSON.stringify(deps));
	check('放回的是原 spec 而非新 spec', deps['demo-pkg'] !== 'demo-pkg@bad');
	await rm(dir, { recursive: true, force: true });
}

// ── 9. manager 真的 reject（锁/析构故障）也要报失败 ─────────
{
	const dir = await fixture();
	const manager = { async installBundle() { throw new Error('lock lost'); } };
	const out = await replaceDependency({ manager, dir, name: 'demo-pkg', spec: 'demo-pkg@1.2.0' });
	check('reject 转成失败结果', out.ok === false, JSON.stringify(out));
	check('保留原始消息', out.error === 'lock lost', String(out.error));
	check('manifest 完好', (await readDeps(dir))['demo-pkg'] === '^1.0.0');
	await rm(dir, { recursive: true, force: true });
}

// ── 10. 成功时绝不回写旧 spec ───────────────────────────────
{
	const dir = await fixture();
	const manager = {
		async installBundle() {
			if (!manager.tried) { manager.tried = true; return { application: 'failed', error: { code: 'already-installed' } }; }
			// pnpm 成功时会把新 entry 写进 manifest，模拟之。
			const raw = JSON.parse(await readText(dir));
			raw.dependencies['demo-pkg'] = '1.2.0';
			await writeFile(join(dir, 'package.json'), `${JSON.stringify(raw, undefined, 2)}\n`, 'utf8');
			return { application: 'applied', changed: true };
		},
	};
	const out = await replaceDependency({ manager, dir, name: 'demo-pkg', spec: 'demo-pkg@1.2.0' });
	check('替换成功', out.ok === true, JSON.stringify(out));
	check('pnpm 写入的版本没被覆盖回旧值', (await readDeps(dir))['demo-pkg'] === '1.2.0', JSON.stringify(await readDeps(dir)));
	await rm(dir, { recursive: true, force: true });
}

// ── 11. 真实文件系统上不留临时文件 ──────────────────────────
{
	const dir = await fixture();
	await dropDependency(dir, 'demo-pkg');
	await restoreDependency(dir, 'demo-pkg', '^1.0.0');
	check('目录里没有 .tmp 残留', (await tmpFiles(dir)).length === 0, (await readdir(dir)).join(','));
	await rm(dir, { recursive: true, force: true });
}

// ── 12. 真实句柄确实会挡住 rename（这是真实故障，不是想象） ─
// Node 的 open(path,'r') 不带 FILE_SHARE_DELETE，所以只要 DSH 自己读着
// package.json，rename 就一定 EPERM——探针实测确认过。这正是端到端里依赖
// 消失的成因，也是「原地写入」这条回落路径存在的唯一理由。
// 断言：真句柄在场时走回落分支，且那条依赖确实被删掉、没有留下 .tmp。
{
	const dir = await fixture();
	const handle = await open(join(dir, 'package.json'), 'r');
	try {
		const dropped = await dropDependency(dir, 'demo-pkg');
		if (process.platform === 'win32') {
			check('真实句柄挡住 rename 时回落原地写入', dropped.kind === 'dropped' && dropped.via === 'in-place',
				JSON.stringify(dropped));
			check('回落之后依赖确实被删掉', !Object.hasOwn(await readDeps(dir), 'demo-pkg'), JSON.stringify(await readDeps(dir)));
			check('回落之后其余内容完好',
				(await readDeps(dir))['link-pkg'] === 'link:C:/somewhere' && JSON.parse(await readText(dir)).dsh.profile.bundles[0] === 'demo-pkg');
		} else {
			// POSIX 上 rename 不受读句柄影响，正常走原子路径。
			check('POSIX 上真实句柄不影响原子替换', dropped.kind === 'dropped' && dropped.via === 'atomic', JSON.stringify(dropped));
		}
	} finally {
		await handle.close();
	}
	check('真实句柄路径不留 .tmp', (await tmpFiles(dir)).length === 0, (await readdir(dir)).join(','));
	// 句柄释放后仍能正常改写，证明重试与回落没有留下坏状态。
	const after = await dropDependency(dir, 'link-pkg');
	check('句柄释放后仍能正常改写', after.kind === 'dropped', JSON.stringify(after));
	await rm(dir, { recursive: true, force: true });
}

// ── 13. 注入的瞬时失败：重试之后必须成功 ────────────────────
{
	let attempts = 0;
	const io = fakeIo({
		files: { [FAKE_FILE]: FAKE_TEXT },
		// 前三次 EPERM，第四次放行：真实 Windows 上就是这样一闪而过的。
		rename: () => {
			attempts += 1;
			return attempts <= 3 ? transientError('EPERM') : undefined;
		},
	});
	const { sleep, delays } = fakeSleep();
	const dropped = await dropDependency(FAKE_DIR, 'demo-pkg', { io, sleep, isTransient: () => true });

	check('瞬时失败后重试成功', dropped.kind === 'dropped', JSON.stringify(dropped));
	check('成功路径报的是 atomic', dropped.via === 'atomic', String(dropped.via));
	check('rename 试了 4 次（3 次失败 + 1 次成功）', attempts === 4, String(attempts));
	check('退避 sleep 了 3 次', delays.length === 3, JSON.stringify(delays));
	check('退避按 20→40→80 递增', JSON.stringify(delays) === JSON.stringify([20, 40, 80]), JSON.stringify(delays));
	const written = JSON.parse(io.disk.get(FAKE_FILE));
	check('最终内容确实少了那条依赖', !Object.hasOwn(written.dependencies, 'demo-pkg'), JSON.stringify(written.dependencies));
	check('最终内容保留了其余部分', written.dependencies['link-pkg'] === 'link:C:/somewhere' && written.name === 'dsh-profile-test');
	check('重试成功后没有留下临时文件', [...io.disk.keys()].filter((k) => k.endsWith('.tmp')).length === 0, [...io.disk.keys()].join(','));
}

// ── 14. 非瞬时错误不重试：直接进回落分支 ────────────────────
{
	let attempts = 0;
	const io = fakeIo({
		files: { [FAKE_FILE]: FAKE_TEXT },
		rename: () => {
			attempts += 1;
			const error = new Error('ENOENT: rename failed');
			error.code = 'ENOENT';
			return error;
		},
	});
	const { sleep, delays } = fakeSleep();
	const dropped = await dropDependency(FAKE_DIR, 'demo-pkg', { io, sleep, isTransient: () => false });
	check('非瞬时错误不重试', attempts === 1, String(attempts));
	check('非瞬时错误不退避', delays.length === 0, JSON.stringify(delays));
	check('rename 不可用时回落原地写入', dropped.via === 'in-place', String(dropped.via));
}

// ── 15. 原子替换一直 EPERM：必须回落原地写入且成功 ──────────
// 这是真实发生过的场景：DSH 自己持有 package.json，rename 永远 EPERM，
// 但原地写入能成功。旧实现直接放弃 → 依赖被删了却没放回来 → 插件消失。
{
	let attempts = 0;
	const io = fakeIo({
		files: { [FAKE_FILE]: FAKE_TEXT },
		rename: () => { attempts += 1; return transientError('EPERM'); },
	});
	const { sleep, delays } = fakeSleep();
	const dropped = await dropDependency(FAKE_DIR, 'demo-pkg', { io, sleep, isTransient: () => true });

	check('一直 EPERM 时仍报告 dropped', dropped.kind === 'dropped', JSON.stringify(dropped));
	check('一直 EPERM 时回落原地写入', dropped.via === 'in-place', String(dropped.via));
	check('重试到上限才回落（1 次 + 8 次重试）', attempts === 9, String(attempts));
	check('退避封顶在 200ms', delays.every((d) => d <= 200), JSON.stringify(delays));
	check('回落之后依赖确实被删掉', !Object.hasOwn(JSON.parse(io.disk.get(FAKE_FILE)).dependencies, 'demo-pkg'));
	check('回落路径不留临时文件', [...io.disk.keys()].filter((k) => k.endsWith('.tmp')).length === 0, [...io.disk.keys()].join(','));
}

// ── 16. 两条路都失败：报 unavailable，且不丢依赖 ────────────
{
	const io = fakeIo({
		files: { [FAKE_FILE]: FAKE_TEXT },
		rename: () => transientError('EBUSY'),
		write: (path) => {
			// 临时文件能写，目标文件写不进去：原子替换和原地写入同时失效。
			if (path === FAKE_FILE) {
				const error = new Error('EACCES: permission denied');
				error.code = 'EACCES';
				return error;
			}
			return undefined;
		},
	});
	const { sleep } = fakeSleep();
	const dropped = await dropDependency(FAKE_DIR, 'demo-pkg', { io, sleep, isTransient: () => true });

	check('两条路都失败时报 unavailable', dropped.kind === 'unavailable', JSON.stringify(dropped));
	check('失败理由同时提到两条路径', /原子替换/.test(dropped.reason ?? '') && /原地写入/.test(dropped.reason ?? ''), String(dropped.reason));
	check('失败时磁盘内容原样未动', io.disk.get(FAKE_FILE) === FAKE_TEXT);
	check('失败时依赖没有丢', Object.hasOwn(JSON.parse(io.disk.get(FAKE_FILE)).dependencies, 'demo-pkg'));
	check('失败后不留临时文件（孤儿必须清掉）',
		[...io.disk.keys()].filter((k) => k.endsWith('.tmp')).length === 0, [...io.disk.keys()].join(','));
}

// ── 17. restoreDependency 也走同一套重试 ────────────────────
{
	// 必须先造一个「demo-pkg 已经不在」的内容，否则 restore 会走 already
	// 分支，根本不碰写入路径——那样这条用例什么都没测到。
	const WITHOUT_DEMO = `${JSON.stringify({
		name: 'dsh-profile-test',
		dependencies: { 'link-pkg': 'link:C:/somewhere' },
		dsh: { profile: { bundles: ['demo-pkg'] } },
	}, undefined, 2)}\n`;
	let attempts = 0;
	const io = fakeIo({
		files: { [FAKE_FILE]: WITHOUT_DEMO },
		rename: () => {
			attempts += 1;
			return attempts <= 2 ? transientError('EPERM') : undefined;
		},
	});
	const { sleep } = fakeSleep();
	const back = await restoreDependency(FAKE_DIR, 'demo-pkg', '^1.0.0', { io, sleep, isTransient: () => true });
	check('restore 在瞬时失败后成功', back.ok === true, JSON.stringify(back));
	check('restore 确实走了写入而非 already 分支', back.already !== true, JSON.stringify(back));
	check('restore 走的是 atomic', back.via === 'atomic', String(back.via));
	check('restore 把 entry 写回去了',
		JSON.parse(io.disk.get(FAKE_FILE)).dependencies['demo-pkg'] === '^1.0.0',
		JSON.stringify(JSON.parse(io.disk.get(FAKE_FILE)).dependencies));
}
{
	// 写入彻底失败：必须失败，且不能假装成功。
	const io = fakeIo({
		files: { [FAKE_FILE]: `${JSON.stringify({ name: 'x', dependencies: { 'link-pkg': 'link:C:/a' } }, undefined, 2)}\n` },
		rename: () => transientError('EPERM'),
		write: (path) => {
			if (path === FAKE_FILE) {
				const error = new Error('EACCES: permission denied');
				error.code = 'EACCES';
				return error;
			}
			return undefined;
		},
	});
	const { sleep, delays } = fakeSleep();
	const before = io.disk.get(FAKE_FILE);
	const back = await restoreDependency(FAKE_DIR, 'demo-pkg', '^1.0.0', { io, sleep, isTransient: () => true });
	check('restore 写不进去时报失败', back.ok === false, JSON.stringify(back));
	check('restore 失败时带出可读理由', typeof back.error === 'string' && back.error.length > 0, String(back.error));
	check('restore 重试了 3 轮', delays.length >= 2, JSON.stringify(delays));
	check('restore 失败时没有破坏原内容', io.disk.get(FAKE_FILE) === before);
}

// ── 18. replaceDependency 在锁竞争下仍能把 entry 放回 ───────
// 端到端见过的最坏组合：替换失败 + rename 被锁。这里把两者叠在一起，
// 断言「失败」和「依赖没丢」同时成立。
{
	const io = fakeIo({
		files: { [FAKE_FILE]: FAKE_TEXT },
		rename: () => transientError('EPERM'),
	});
	const { sleep } = fakeSleep();
	const manager = {
		async installBundle() {
			if (!manager.tried) { manager.tried = true; return { application: 'failed', error: { code: 'already-installed' } }; }
			return { application: 'failed', error: { code: 'invalid-spec' } };
		},
	};
	const out = await replaceDependency({
		manager, dir: FAKE_DIR, name: 'demo-pkg', spec: 'demo-pkg@bad',
		io, sleep, isTransient: () => true,
	});
	check('锁竞争下替换失败仍报失败', out.ok === false, JSON.stringify(out));
	check('锁竞争下依旧完成了放回', out.restored === true, JSON.stringify(out));
	check('锁竞争下依赖仍在 manifest 里',
		Object.hasOwn(JSON.parse(io.disk.get(FAKE_FILE)).dependencies, 'demo-pkg'),
		JSON.stringify(JSON.parse(io.disk.get(FAKE_FILE)).dependencies));
	check('放回的是旧 spec', JSON.parse(io.disk.get(FAKE_FILE)).dependencies['demo-pkg'] === '^1.0.0',
		String(JSON.parse(io.disk.get(FAKE_FILE)).dependencies['demo-pkg']));
}

// ── 19. 不注入时的平台默认策略 ──────────────────────────────
// 默认 isTransient 只在 win32 认 EPERM。这条按平台断言，避免测试自己假设
// 跑在哪个系统上。
{
	let attempts = 0;
	const io = fakeIo({
		files: { [FAKE_FILE]: FAKE_TEXT },
		rename: () => { attempts += 1; return transientError('EPERM'); },
	});
	const { sleep, delays } = fakeSleep();
	await dropDependency(FAKE_DIR, 'demo-pkg', { io, sleep });
	if (process.platform === 'win32') {
		check('win32 默认策略会重试 EPERM', delays.length === 8, JSON.stringify(delays));
	} else {
		check('非 win32 默认策略不重试（EPERM 不在本地故障集里）', delays.length === 0, JSON.stringify(delays));
	}
}

console.log(`\n${passed} checks passed`);

/**
 * 接线检查：handler 是否真的调用了它该调用的东西。
 *
 * 这套测试的存在理由很具体：订阅流程加了「临时停用」之后仍然卡住 2 分多钟，
 * pnpm.log 是 0 字节 —— pnpm 根本没启动。原因是订阅只从 `dsh.profile.bundles`
 * 移除了条目，却没有移除 `node_modules` 里那个 junction，而 Windows 的 rename
 * 不能覆盖已存在的目标。
 *
 * 也就是说：`unlinkNodeModulesEntry` 写好了、测过了，但**订阅流程从没调用它**。
 * 单元测试全绿，功能照样是坏的 —— 典型的「测了零件，漏了接线」。
 *
 * 静态检查不是万能的，但它能挡住这一整类错误：某个修复函数存在却没有被任何
 * 生产路径引用。这比再写一个跑不起来的集成测试便宜得多。
 *
 * Run: node tools/wiring-check.mjs
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

let passed = 0;
const check = (label, ok, detail = '') => {
	if (ok) { passed += 1; console.log('  ok  ', label); }
	else { console.error('  FAIL', label, detail); process.exitCode = 1; }
};

const ROOT = process.cwd();
const hostRaw = await readFile(join(ROOT, 'index.js'), 'utf8');
const clientRaw = await readFile(join(ROOT, 'client.js'), 'utf8');
const jobsRaw = await readFile(join(ROOT, 'lib', 'jobs.js'), 'utf8');

// ── 1. 订阅流程必须清理 node_modules 链接 ───────────────────
// 只从 bundles 移除不够：junction 还在，pnpm 的 rename 就会 EPERM。
{
	// 找到 runSubscribeJob 的函数体范围
	const start = hostRaw.indexOf('async function runSubscribeJob(');
	check('找到 runSubscribeJob', start >= 0);
	const end = hostRaw.indexOf('\n\tasync function ', start + 10);
	const body = start >= 0 ? hostRaw.slice(start, end > 0 ? end : undefined) : '';
	check('订阅流程调用了 unlinkNodeModulesEntry',
		body.includes('unlinkNodeModulesEntry'), body.slice(0, 200));
	check('订阅流程仍然调用 installDetached',
		body.includes('installDetached'));
	// 顺序很重要：必须先移除链接，再安装
	const unlinkAt = body.indexOf('unlinkNodeModulesEntry');
	const installAt = body.indexOf('installDetached');
	check('先移除链接再安装（顺序不能反）',
		unlinkAt >= 0 && installAt >= 0 && unlinkAt < installAt,
		`unlink@${unlinkAt} install@${installAt}`);
}

// ── 2. 装回流程同样要清理链接 ───────────────────────────────
{
	const start = hostRaw.indexOf('async function runRestoreJob(');
	check('找到 runRestoreJob', start >= 0);
	// 装回走 restore()，链接清理在 restorer 里；这里验证 restorer 确实调了
	const restorerRaw = await readFile(join(ROOT, 'lib', 'restorer.js'), 'utf8');
	check('restore 的 git 分支清理 node_modules 链接',
		restorerRaw.includes('unlinkNodeModulesEntry'));
}

// ── 3. 三个耗时操作都必须是任务式 ───────────────────────────
// 同步执行会让界面只转圈，看不出卡在哪一步。订阅、升级、装回都走过这条路。
{
	const routes = {
		'/upgrade': 'runUpgradeJob',
		'/subscribe': 'runSubscribeJob',
		'/restore': 'runRestoreJob',
	};
	for (const [route, runner] of Object.entries(routes)) {
		const at = hostRaw.indexOf(`route === "${route}"`);
		check(`找到 ${route} 路由`, at >= 0);
		// 该路由分支里必须出现 202 与对应的 runner
		const seg = hostRaw.slice(at, at + 3000);
		check(`${route} 返回 202（任务式）`, seg.includes('202'), seg.slice(0, 150));
		check(`${route} 使用 ${runner}`, seg.includes(runner), seg.slice(0, 150));
	}
}

// ── 4. 任务轮询与取消接口存在 ───────────────────────────────
{
	check('有 /job 轮询路由', hostRaw.includes('route === "/job"'));
	check('有 /cancel 取消路由', hostRaw.includes('route === "/cancel"'));
	check('同一时刻只允许一个任务', hostRaw.includes('jobs.running()'));
	// 三处都要检查，否则某条路由可能绕过互斥并发出两个 pnpm
	const runningChecks = (hostRaw.match(/jobs\.running\(\)/g) ?? []).length;
	check('三条任务路由都做了互斥检查', runningChecks >= 3, String(runningChecks));
}

// ── 5. 步骤定义覆盖全部三种任务 ─────────────────────────────
{
	for (const fn of ['stepsFor', 'subscribeStepsFor', 'restoreStepsFor']) {
		check(`jobs.js 导出 ${fn}`, new RegExp(`export function ${fn}\\(`).test(jobsRaw));
	}
	// 订阅需要「停用」与「重新启用」两个步骤，界面才会显示这两步
	check('订阅步骤含 detach', jobsRaw.includes('id: "detach"'));
	check('订阅步骤含 reattach', jobsRaw.includes('id: "reattach"'));
}

// ── 6. 前端消费了任务快照 ───────────────────────────────────
{
	check('前端轮询 /job', clientRaw.includes('/job?id='));
	check('前端渲染步骤列表', clientRaw.includes('job.steps'));
	check('前端渲染已完成步骤', clientRaw.includes('completedSteps'));
	check('前端显示已用时间', clientRaw.includes('elapsedMs'));
	// 三个动作都要接上轮询，否则又会变成只转圈
	check('升级走轮询', clientRaw.includes('pollJob'));
	const pollCalls = (clientRaw.match(/pollJob\(/g) ?? []).length;
	check('至少三处调用 pollJob（升级/订阅/装回）', pollCalls >= 3, String(pollCalls));
}

// ── 7. 自升级/自订阅必须被挡住 ─────────────────────────────
// 升级会替换正在处理这个请求的代码，在 Windows 上必然 EPERM。
{
	check('禁止自我升级', hostRaw.includes('self-upgrade-blocked'));
	check('禁止自我订阅', hostRaw.includes('self-subscribe-blocked'));
}

// ── 8. 升级必须支持 git 来源 ────────────────────────────────
// 前端把 git 行标成「可更新」却没有按钮，后端 /upgrade 又只会问 npm ——
// 两条都断了，于是「可更新」是个死标签。
{
	// 前端：按钮不能只给 registry
	const canUpgradeLine = clientRaw.split('\n').find((l) => l.includes('const canUpgrade ='));
	check('找到 canUpgrade 判定', canUpgradeLine !== undefined);
	// 判定可以写成内联条件，也可以抽成 upgradableKind 变量，所以检查的是
	// 「git 被纳入了可升级集合」，而不是某种具体写法。
	const upgradeGate = (clientRaw.match(/const upgradableKind = [^;]+;/) ?? [''])[0]
		+ (canUpgradeLine ?? '');
	check('★ 升级按钮不再只限 registry',
		/kind === 'git'/.test(upgradeGate) && !/canUpgrade = isUpdatable && p\.kind === 'registry'/.test(canUpgradeLine ?? ''),
		String(upgradeGate).trim());
	check('自身不可升级时给出说明',
		clientRaw.includes('selfUpgradeNote'), '缺少 selfUpgradeNote');

	// 后端：按来源分流解析目标
	check('升级按 kind 分流', hostRaw.includes('isGit'), '没有 isGit 判定');
	check('git 升级读远端 commit', hostRaw.includes('remoteCommit('), '没有 remoteCommit 调用');
	check('git 升级用 github: 前缀的 spec',
		/row\.spec = `github:\$\{slug\}#\$\{tip\}`/.test(hostRaw), '没有构造 git spec');
	check('安装用解析出来的 targetSpec',
		hostRaw.includes('spec: targetSpec'), '没有用 targetSpec');
	// git 升级同样要清 node_modules，否则 rename 会 EPERM
	const upgradeStart = hostRaw.indexOf('async function runUpgradeJob(');
	const upgradeBody = hostRaw.slice(upgradeStart, hostRaw.indexOf('async function runSubscribeJob('));
	check('★ 升级也移除 node_modules 链接',
		upgradeBody.includes('unlinkNodeModulesEntry'), '升级流程没清链接');
}

// ── 9. 升级同类问题：git 与 registry 的「已是最新」判定不同 ──
{
	check('git 用 commit 相等判断而不是版本号',
		hostRaw.includes('sameGit'), '没有 sameGit 判定');
}

// ── 10. 本插件落后时必须是 self-update，不能是可更新 ────────
// 它永远不能自我升级（替换正在处理请求的代码在 Windows 上必然失败）。报
// updatable 会让界面出现「可更新」却没有按钮，每个用户都会读成 bug。
{
	check('有 SELF_NAME 常量', hostRaw.includes('const SELF_NAME = '), '没有 SELF_NAME');
	check('★ 本插件落后时状态是 self-update',
		/plugin\.name === SELF_NAME\) return "self-update"/.test(hostRaw),
		'没找到 self-update 分支');
	// 三处引用必须都走常量，否则改名字时会漏掉一处
	const selfNameUses = (hostRaw.match(/SELF_NAME/g) ?? []).length;
	check('SELF_NAME 至少四处引用（定义/状态/两个守卫/selfName 字段）',
		selfNameUses >= 5, String(selfNameUses));

	// 前端
	check('前端识别 self-update 状态',
		clientRaw.includes("'self-update': 'statusSelfUpdate'"), 'STATUS_KEY 缺 self-update');
	check('中英文都有状态文案',
		clientRaw.includes("statusSelfUpdate: '需手动升级'") && clientRaw.includes("statusSelfUpdate: 'Manual upgrade'"),
		'状态文案缺失');
	check('★ 给出可执行的手动升级命令',
		clientRaw.includes('function selfUpgradeCommand'), '没有 selfUpgradeCommand');
	check('命令里带 pnpm add 与 save-exact',
		/pnpm add "github:/.test(clientRaw) && clientRaw.includes('--save-exact'),
		'命令不完整');
}

// ── 11. 状态徽标样式必须覆盖新状态 ─────────────────────────
{
	check('有 self-update 徽标样式',
		clientRaw.includes('.pc-badge.self-update'), '缺 CSS');
}

console.log(`\n${passed} checks passed`);

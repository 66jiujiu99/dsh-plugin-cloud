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
	check('★ 订阅安装失败也恢复移除的链接',
		body.includes('restoreRemovedNodeModulesEntry')
		&& body.includes('guarded.outcome?.ok !== true')
		&& body.includes('link-restore-failed'));
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
	const restoreBody = hostRaw.slice(start, hostRaw.indexOf('\n\tasync function ', start + 10));
	check('★ manual/unresolved 不再被当作装回成功',
		restoreBody.includes('["installed", "installed-restart", "already"].includes(r.status)')
		&& !restoreBody.includes('rows.every((r) => r.status !== "failed")'));
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
	// 前端：批量与单按钮都必须调用同一个 helper，避免条件再次漂移。
	const canUpgradeLine = clientRaw.split('\n').find((l) => l.includes('const canUpgrade ='));
	check('找到 canUpgrade 判定', canUpgradeLine !== undefined);
	check('★ 单按钮与批量共用 canUpgradePlugin',
		canUpgradeLine?.includes('canUpgradePlugin(p, data.selfName)') === true
		&& clientRaw.includes('rows.filter((r) => canUpgradePlugin(r, data?.selfName))'));
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
	check('★ registry 地址从 cfgNow 读取',
		upgradeBody.includes('const { registry } = await cfgNow()')
		&& upgradeBody.includes('fetchPackument(name, registry)')
		&& !upgradeBody.includes('fetchPackument(name, cfg.registry)'));
	check('★ path/未知来源在 registry 请求前被拒绝',
		upgradeBody.includes('classifySpec(rawSpec)')
		&& upgradeBody.indexOf('path-upgrade-blocked') >= 0
		&& upgradeBody.indexOf('unsupported-upgrade-kind') >= 0
		&& upgradeBody.indexOf('path-upgrade-blocked') < upgradeBody.indexOf('fetchPackument(name, registry)')
		&& upgradeBody.indexOf('unsupported-upgrade-kind') < upgradeBody.indexOf('fetchPackument(name, registry)'));
	check('★ 升级失败恢复链接且恢复失败有错误码',
		upgradeBody.includes('restoreRemovedNodeModulesEntry')
		&& upgradeBody.includes('row.linkRestored')
		&& upgradeBody.includes('link-restore-failed'));
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

// ── 12. 前端升级资格的行为回归，而不是只找一行字符串 ─────────────
{
	const match = clientRaw.match(/\t\tfunction canUpgradePlugin\(plugin, selfName\) \{[\s\S]*?\n\t\t\}/);
	check('找到可独立执行的 canUpgradePlugin', match !== null);
	if (match !== null) {
		const source = `${match[0]}\nexport { canUpgradePlugin };`;
		const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
		const { canUpgradePlugin } = await import(url);
		const row = (kind, extra = {}) => ({ name: 'example', kind, update: { updateAvailable: true }, ...extra });
		check('★ registry/git 都可升级', canUpgradePlugin(row('registry'), 'self')
			&& canUpgradePlugin(row('git'), 'self'));
		check('★ path/tarball/unknown 不可升级', !canUpgradePlugin(row('path'), 'self')
			&& !canUpgradePlugin(row('tarball'), 'self') && !canUpgradePlugin(row('unknown'), 'self'));
		check('★ 自身与无更新都不可升级', !canUpgradePlugin(row('registry'), 'example')
			&& !canUpgradePlugin(row('registry', { update: { updateAvailable: false } }), 'self'));
		check('★ 保持 disabled 插件原有升级语义',
			canUpgradePlugin(row('registry', { enabled: false }), 'self'));
	}
}

// ── 13. 前后端可更新数量使用同一口径 ─────────────────────────
{
	const summaryAt = hostRaw.indexOf('updatable: rows.filter');
	const summaryLine = hostRaw.slice(summaryAt, summaryAt + 260);
	check('★ Host summary 排除自身与 path/未知来源',
		summaryLine.includes('r.name !== SELF_NAME')
		&& summaryLine.includes('r.kind === "registry"')
		&& summaryLine.includes('r.kind === "git"'), summaryLine);
}

// ── 14. 装回确认分支消费最终 Job，删除失败不再被吞掉 ─────────────
{
	const start = clientRaw.indexOf('function VersionsPanel(');
	const end = clientRaw.indexOf('function SettingsPanel(', start);
	const body = clientRaw.slice(start, end);
	check('★ 装回确认分支轮询 Job 并显示进度',
		body.includes('pollJob(body.job.id, setJob)') && body.includes('h(JobProgress, { t, job })'));
	check('★ 装回报告使用 final.results/final.summary',
		body.includes('rows: final.results ?? []') && body.includes('summary: final.summary'));
	check('★ dry-run 仍同步使用 body.report',
		body.includes('rows: body.report ?? []') && body.includes('dryRun: true'));
	check('★ 删除检查 HTTP/local/cloud 错误',
		body.includes('body.error ?? body.local?.error ?? body.cloud?.error')
		&& body.includes('if (!res.ok || failure) throw new Error'));
}

// ── 15. 新增机器码均有中英文案 ───────────────────────────────
{
	for (const key of ['errPathUpgradeBlocked', 'errUnsupportedUpgradeKind', 'errLinkRestoreFailed', 'blockPushUnverified']) {
		const uses = clientRaw.split('\n').filter((line) => line.includes(`${key}:`)).length;
		check(`${key} 中英文文案齐全`, uses === 2, String(uses));
	}
	check('push-unverified blocker 已接线', clientRaw.includes("'push-unverified': 'blockPushUnverified'"));
}

console.log(`\n${passed} checks passed`);

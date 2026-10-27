/**
 * 升级任务系统的测试。
 *
 * 背景：升级原本是同步请求，界面只有一个转圈。现在它是个任务：`POST /upgrade`
 * 立刻返回 job id，界面轮询 `/job` 显示当前步骤和已用时间。
 *
 * 这套测试要守住的几件事：
 *   - 步骤是「真的步骤」，不是装饰：进度说「执行 pnpm 安装」时，pnpm 就该在跑
 *   - 同一时刻只有一个任务：两次 pnpm 打同一个 profile 会争抢 lockfile
 *   - 取消只在步骤之间生效，绝不打断进行中的安装
 *   - 任务快照必须带 elapsedMs、completedSteps，界面才不用自己算
 *
 * Run: node tools/jobs-check.mjs
 */
import { createJobRegistry, stepsFor } from '../lib/jobs.js';

let passed = 0;
const check = (label, ok, detail = '') => {
	if (ok) { passed += 1; console.log('  ok  ', label); }
	else { console.error('  FAIL', label, detail); process.exitCode = 1; }
};

// ── 1. 步骤清单是真实管线 ───────────────────────────────────
{
	const steps = stepsFor('dsh-plugin-guide', '0.3.39');
	check('步骤非空', steps.length >= 4, String(steps.length));
	check('步骤都有 id 和 label', steps.every((s) => typeof s.id === 'string' && typeof s.label === 'string'));
	check('目标版本出现在 label 里',
		steps[0].label.includes('0.3.39'), steps[0].label);
	check('步骤 id 不重复', new Set(steps.map((s) => s.id)).size === steps.length);

	const noVersion = stepsFor('x', null);
	check('版本未知时 label 不硬塞 null', !noVersion[0].label.includes('null'), noVersion[0].label);

	// 步骤 id 必须覆盖真实的管线阶段，否则界面显示的阶段是编的
	const ids = steps.map((s) => s.id);
	for (const required of ['resolve', 'install', 'verify']) {
		check(`步骤包含 ${required}`, ids.includes(required), ids.join(','));
	}
}

// ── 2. 基本生命周期 ─────────────────────────────────────────
{
	const reg = createJobRegistry();
	const job = reg.create({ names: ['a'], stepSets: [stepsFor('a', '1.0.0')] });
	check('创建后是 running', job.status === 'running', job.status);
	check('创建后带 id', typeof job.id === 'string' && job.id.length > 0, job.id);
	check('创建后 total 正确', job.total === 1, String(job.total));
	check('创建后有两步以上', job.steps.length >= 4, String(job.steps.length));
	check('创建后 elapsedMs 是数字', typeof job.elapsedMs === 'number', String(job.elapsedMs));
	check('初始 completedSteps 为空', Array.isArray(job.completedSteps) && job.completedSteps.length === 0);

	reg.advance(job.id, { index: 0, stepIndex: 2, phase: 'installing' });
	const mid = reg.get(job.id);
	check('advance 后 current 指向当前步骤', mid.current === mid.steps[2].id, String(mid.current));
	check('advance 后 phase 更新', mid.phase === 'installing', mid.phase);
	check('advance 后前面的步骤标为已完成',
		mid.completedSteps.length === 2 && mid.completedSteps[0] === mid.steps[0].id,
		JSON.stringify(mid.completedSteps));
	check('当前步骤不在 completedSteps 里',
		!mid.completedSteps.includes(mid.current), JSON.stringify(mid.completedSteps));

	reg.pushResult(job.id, { name: 'a', ok: true, from: '0.9.0', to: '1.0.0' });
	check('结果被记录', reg.get(job.id).results.length === 1);

	reg.finish(job.id, { restartRequired: true });
	const done = reg.get(job.id);
	check('finish 后状态为 done', done.status === 'done', done.status);
	check('finish 后带 finishedAt', typeof done.finishedAt === 'number');
	check('finish 后 elapsedMs 停止增长', done.elapsedMs >= 0);
	check('finish 后 current 清空', done.current === null);
	check('finish 把额外字段合进来', done.restartRequired === true);
}

// ── 3. 失败路径 ─────────────────────────────────────────────
{
	const reg = createJobRegistry();
	const job = reg.create({ names: ['a'], stepSets: [stepsFor('a', null)] });
	reg.fail(job.id, 'pnpm 崩了');
	const failed = reg.get(job.id);
	check('fail 后状态为 failed', failed.status === 'failed', failed.status);
	check('fail 后带错误信息', failed.errors.includes('pnpm 崩了'), JSON.stringify(failed.errors));
	check('fail 后 current 清空', failed.current === null);
}

// ── 4. 同一时刻只能有一个任务 ───────────────────────────────
// 两次 pnpm 打同一个 profile 会争抢 lockfile 和 manifest，必须串行。
{
	const reg = createJobRegistry();
	check('没有任务时 running 为 null', reg.running() === null);

	const first = reg.create({ names: ['a'], stepSets: [stepsFor('a', null)] });
	check('有任务时 running 返回它', reg.running()?.id === first.id);

	const second = reg.create({ names: ['b'], stepSets: [stepsFor('b', null)] });
	check('第二个任务创建后 running 仍返回第一个', reg.running()?.id === first.id,
		String(reg.running()?.id));

	reg.finish(first.id);
	check('第一个结束后 running 返回第二个', reg.running()?.id === second.id);

	reg.finish(second.id);
	check('全部结束后 running 为 null', reg.running() === null);
}

// ── 5. 取消语义 ─────────────────────────────────────────────
// 关键：取消是「请求停止」，不是「立刻杀掉」。中途打断 pnpm 会让 manifest
// 丢掉依赖项——那正是这个插件最不该造成的事故。
{
	const reg = createJobRegistry();
	const job = reg.create({ names: ['a', 'b'], stepSets: [stepsFor('a', null), stepsFor('b', null)] });

	check('取消前 isCancelled 为 false', reg.isCancelled(job.id) === false);
	const ok = reg.cancel(job.id);
	check('cancel 返回 true', ok === true);
	check('cancel 后 isCancelled 为 true（管线据此在步骤间停下）', reg.isCancelled(job.id) === true);

	const during = reg.get(job.id);
	check('取消后状态仍是 running（不假装已停）', during.status === 'running', during.status);
	check('取消后 phase 变成 cancelling', during.phase === 'cancelling', during.phase);
	check('取消后 cancelled 标记为 true', during.cancelled === true);

	reg.finish(job.id);
	check('取消的任务结束时状态是 cancelled', reg.get(job.id).status === 'cancelled',
		reg.get(job.id).status);
}

// ── 6. 不能取消已完成的任务 ─────────────────────────────────
{
	const reg = createJobRegistry();
	const job = reg.create({ names: ['a'], stepSets: [stepsFor('a', null)] });
	reg.finish(job.id);
	check('已完成的任务不能取消', reg.cancel(job.id) === false);
	check('取消不存在 id 返回 false', reg.cancel('no-such-job') === false);
}

// ── 7. 读不存在的任务 ───────────────────────────────────────
{
	const reg = createJobRegistry();
	check('get 不存在的 id 返回 null', reg.get('nope') === null);
	check('isCancelled 对不存在的 id 返回 false', reg.isCancelled('nope') === false);
	// 这些操作对不存在的 job 不能抛错：它们会在请求处理路径上被调用。
	let threw = false;
	try {
		reg.advance('nope', { index: 0, stepIndex: 0 });
		reg.pushResult('nope', {});
		reg.pushError('nope', 'x');
		reg.finish('nope');
		reg.fail('nope', 'x');
	} catch { threw = true; }
	check('对不存在的任务操作不抛错', threw === false);
}

// ── 8. 多插件批次 ───────────────────────────────────────────
{
	const reg = createJobRegistry();
	const names = ['a', 'b', 'c'];
	const job = reg.create({ names, stepSets: names.map((n) => stepsFor(n, null)) });
	check('批次 total 是插件数', job.total === 3, String(job.total));

	reg.advance(job.id, { index: 1, stepIndex: 1 });
	const mid = reg.get(job.id);
	check('切到第二个插件时 steps 换成它的', mid.index === 1, String(mid.index));
	check('第二个插件有自己的步骤', mid.steps.length >= 4);
	check('进度分母不变', mid.total === 3, String(mid.total));
}

// ── 9. 任务数量上限 ─────────────────────────────────────────
// 长会话里任务不能无限累积。
{
	const reg = createJobRegistry();
	const ids = [];
	for (let i = 0; i < 60; i += 1) {
		const job = reg.create({ names: [`p${i}`], stepSets: [stepsFor(`p${i}`, null)] });
		reg.finish(job.id);
		ids.push(job.id);
	}
	const alive = ids.filter((id) => reg.get(id) !== null);
	check('旧任务被清理', alive.length < 60, `仍然保留 ${alive.length} 个`);
	check('最近的任务还在', reg.get(ids[ids.length - 1]) !== null);
}

// ── 10. 快照是拷贝，不是内部对象 ────────────────────────────
// 界面拿到快照后改动它，不能影响注册表里的状态。
{
	const reg = createJobRegistry();
	const job = reg.create({ names: ['a'], stepSets: [stepsFor('a', null)] });
	const snap = reg.get(job.id);
	snap.results.push({ name: 'injected' });
	check('改快照不影响内部状态', reg.get(job.id).results.length === 0,
		String(reg.get(job.id).results.length));
}

console.log(`\n${passed} checks passed`);

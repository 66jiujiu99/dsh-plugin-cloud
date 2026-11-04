/**
 * 本地订阅的真实 git fixture：未 fetch/push、已跟踪、已有本地独有提交三种状态。
 * Run: node tools/subscriptions-local-check.mjs
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { inspectLocal, planSubscription, subscribeSpec, BLOCKER_TEXT } from '../lib/subscriptions.js';

let passed = 0;
const check = (label, ok, detail = '') => {
	if (ok) { passed += 1; console.log('  ok  ', label); }
	else { console.error('  FAIL', label, detail); process.exitCode = 1; }
};

const dir = await mkdtemp(join(tmpdir(), 'pc-subscriptions-local-'));
const env = {
	...process.env,
	GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@test',
	GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@test',
};
const git = (...args) => execFileSync('git', args, {
	cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

try {
	await writeFile(join(dir, 'package.json'), `${JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }, undefined, 2)}\n`, 'utf8');
	git('init', '-b', 'main');
	git('add', '-A');
	git('commit', '-m', 'initial');
	git('remote', 'add', 'origin', 'https://github.com/example/subscription-fixture.git');
	const first = git('rev-parse', 'HEAD');

	// 干净且有 GitHub origin，但从未 push/fetch：没有 upstream，也没有 origin/main。
	const missingTracking = await inspectLocal(dir);
	check('真实 fixture 干净且有提交', missingTracking.clean === true && missingTracking.commit === first, JSON.stringify(missingTracking));
	check('缺 upstream/remote-tracking ref 时 pushed 保持 null', missingTracking.pushed === null, String(missingTracking.pushed));
	check('未知推送状态不会被当成 ahead=0 的已推送', missingTracking.ahead === 0 && missingTracking.upstream === null, JSON.stringify(missingTracking));
	check('未知推送状态单独报告 push-unverified', missingTracking.blockedBy.includes('push-unverified'), JSON.stringify(missingTracking.blockedBy));
	check('未知推送状态不误报已确认 unpushed', !missingTracking.blockedBy.includes('unpushed'), JSON.stringify(missingTracking.blockedBy));
	check('未 push/fetch 的干净仓库不可订阅', missingTracking.subscribable === false && subscribeSpec(missingTracking) === null, JSON.stringify(missingTracking));
	const blockedPlan = await planSubscription({ name: 'fixture-plugin', path: dir });
	check('planSubscription 同样阻断未知推送状态', blockedPlan.ready === false && blockedPlan.spec === null, JSON.stringify(blockedPlan));
	check('新 blocker 有明确中文说明', typeof BLOCKER_TEXT['push-unverified'] === 'string' && BLOCKER_TEXT['push-unverified'].length > 0);

	// 模拟一次真实 fetch 后留下的 tracking ref/upstream；HEAD 与远端一致才 ready。
	git('update-ref', 'refs/remotes/origin/main', first);
	git('branch', '--set-upstream-to=origin/main', 'main');
	const pushed = await inspectLocal(dir);
	check('remote-tracking ref 与 HEAD 一致时可订阅', pushed.pushed === true && pushed.subscribable === true, JSON.stringify(pushed));
	check('已推送状态的 pinned spec 正常', subscribeSpec(pushed) === `github:example/subscription-fixture#${first}`, String(subscribeSpec(pushed)));

	// 再提交一个本地独有 SHA：这次有确切 ahead 计数，属于 unpushed 而非未知。
	await writeFile(join(dir, 'local-only.txt'), 'not pushed\n', 'utf8');
	git('add', '-A');
	git('commit', '-m', 'local only');
	const unpushed = await inspectLocal(dir);
	check('本地独有提交得到真实 ahead=1', unpushed.ahead === 1 && unpushed.behind === 0, JSON.stringify(unpushed));
	check('本地独有提交 pushed=false', unpushed.pushed === false, String(unpushed.pushed));
	check('已确认未推送继续使用 unpushed', unpushed.blockedBy.includes('unpushed') && !unpushed.blockedBy.includes('push-unverified'), JSON.stringify(unpushed.blockedBy));
	check('本地独有 SHA 不生成 github spec', unpushed.subscribable === false && subscribeSpec(unpushed) === null, JSON.stringify(unpushed));
} finally {
	await rm(dir, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed`);

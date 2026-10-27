/**
 * 版本检查与订阅计划的单元测试。
 *
 * 不联网的部分（semver、状态判定、slug 解析）直接断言；联网的部分（npm
 * packument）跑真实请求，失败时只报 skip 而不让整套测试变红——网络不是
 * 这个插件的正确性条件。
 *
 * Run: node tools/versions-check.mjs
 */
import * as v from '../lib/versions.js';
import * as s from '../lib/subscriptions.js';

let passed = 0;
let skipped = 0;
const check = (label, ok, detail = '') => {
	if (ok) { passed++; console.log('  ok  ', label); }
	else { console.error('  FAIL', label, detail); process.exitCode = 1; }
};
const skip = (label, why) => { skipped++; console.log('  skip', label, '—', why); };

// ── semver 解析 ─────────────────────────────────────────────
check('解析 1.2.3', JSON.stringify(v.parseSemver('1.2.3')) === '{"major":1,"minor":2,"patch":3,"pre":""}');
check('解析 v 前缀', v.parseSemver('v2.0.0')?.major === 2);
check('解析预发布', v.parseSemver('1.0.0-beta.2')?.pre === 'beta.2');
check('解析构建元数据被忽略', v.parseSemver('1.0.0+build.9')?.patch === 0);
check('拒绝非法版本', v.parseSemver('not-a-version') === null);
check('拒绝空值', v.parseSemver(undefined) === null);

// ── semver 比较 ─────────────────────────────────────────────
check('1.2.3 < 1.3.0', v.compareSemver('1.2.3', '1.3.0') < 0);
check('1.3.0 > 1.2.3', v.compareSemver('1.3.0', '1.2.3') > 0);
check('1.0.0 == 1.0.0', v.compareSemver('1.0.0', '1.0.0') === 0);
check('1.3.0-rc < 1.3.0（预发布低于正式版）', v.compareSemver('1.3.0-rc', '1.3.0') < 0);
check('1.3.0 > 1.3.0-rc', v.compareSemver('1.3.0', '1.3.0-rc') > 0);
check('1.2.10 > 1.2.9（数字而非字典序）', v.compareSemver('1.2.10', '1.2.9') > 0);

// ── latestStable ────────────────────────────────────────────
check('latestStable 跳过预发布', v.latestStable(['1.0.0', '2.0.0-beta', '1.5.0']) === '1.5.0');
check('latestStable 全预发布时返回 null', v.latestStable(['1.0.0-a', '1.0.0-b']) === null);
check('latestStable 空数组返回 null', v.latestStable([]) === null);

// ── updateStatus ────────────────────────────────────────────
check('1.0.0 → 1.2.0 可更新', v.updateStatus('1.0.0', '1.2.0') === true);
check('1.2.0 → 1.2.0 不可更新', v.updateStatus('1.2.0', '1.2.0') === false);
check('1.2.0 → 1.0.0 不回退', v.updateStatus('1.2.0', '1.0.0') === false);
check('缺最新版时不报更新', v.updateStatus('1.0.0', null) === false);
check('缺已安装版时不报更新', v.updateStatus(null, '1.0.0') === false);

// ── countBehind ─────────────────────────────────────────────
{
	const versions = ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '2.0.0-rc'];
	// 从 1.0.0 到 1.3.0 实际经过 1.1.0 / 1.2.0 / 1.3.0 三个正式版本。
	check('1.0.0 到 1.3.0 落后 3 个（不含预发布）', v.countBehind('1.0.0', versions, '1.3.0') === 3,
		String(v.countBehind('1.0.0', versions, '1.3.0')));
	check('已是最新时落后 0 个', v.countBehind('1.3.0', versions, '1.3.0') === 0);
}

// ── githubSlug ──────────────────────────────────────────────
check('SSH 形式', v.githubSlug('git@github.com:o/r.git') === 'o/r');
check('HTTPS 形式', v.githubSlug('https://github.com/o/r.git') === 'o/r');
check('HTTPS 无 .git', v.githubSlug('https://github.com/o/r') === 'o/r');
check('github: 简写', v.githubSlug('github:o/r') === 'o/r');
check('非 GitHub 返回 null', v.githubSlug('https://gitlab.com/o/r.git') === null);
check('非法输入返回 null', v.githubSlug(null) === null);

// ── 真实 npm registry ───────────────────────────────────────
{
	const p = await v.fetchPackument('dsh-plugin-upgrader');
	if (p === null) {
		skip('npm packument 真实读取', '网络不可用');
	} else {
		check('packument 有 latest', typeof p.latest === 'string' && p.latest !== '');
		check('packument 有版本列表', p.versions.length > 0);
		check('latest 在版本列表里', p.versions.includes(p.latest));
		const canUpdate = v.updateStatus('1.0.0', p.latest);
		check('1.0.0 对比真实 latest 可更新', canUpdate === true, p.latest);
	}
	const missing = await v.fetchPackument('this-package-should-not-exist-dsh-xyz-000');
	check('不存在的包返回 null 而非抛错', missing === null);
}

// ── checkUpdates 混合来源 ───────────────────────────────────
{
	const plugins = [
		{ name: 'dsh-plugin-upgrader', kind: 'registry', version: '1.0.0' },
		{ name: 'weird', kind: 'tarball', version: '0.0.1' },
	];
	const out = await v.checkUpdates(plugins);
	const reg = out.get('dsh-plugin-upgrader');
	const tar = out.get('weird');
	if (reg?.latest === null) {
		skip('checkUpdates registry 分支', '网络不可用');
	} else {
		check('checkUpdates registry 分支标可更新', reg.updateAvailable === true);
		check('checkUpdates registry 分支带 behind', typeof reg.behind === 'number');
	}
	check('checkUpdates 不支持的 spec 标 unsupported', tar.note === 'unsupported-spec');
	check('checkUpdates 不支持时不可更新', tar.updateAvailable === false);
}

// ── githubSlug 必须认全 npm 的 git 写法 ─────────────────────
// 这组是回归测试：`installBundle` 安装 git 依赖后会把 spec 改写成
// `git+https://github.com/o/r.git#sha`，而最初的 githubSlug 只认
// `github:` / `https://` 等几种形态，于是「转为订阅」成功后 slug 变 null、
// 插件永久显示「无法检查」。订阅这个动作为了能查更新，结果让检查失效了。
{
	const same = '66jiujiu99/dsh-plugin-session-restore';
	const forms = [
		[`github:${same}#62c24020`, 'github: 简写'],
		[`git+https://github.com/${same}.git#62c24020`, 'git+https（installBundle 写的形态）'],
		[`git+https://github.com/${same}.git`, 'git+https 无 ref'],
		[`https://github.com/${same}.git`, 'https'],
		[`https://github.com/${same}`, 'https 无 .git'],
		[`git+ssh://git@github.com/${same}.git#abc`, 'git+ssh'],
		[`git@github.com:${same}.git`, 'scp 风格'],
		[`git://github.com/${same}.git`, 'git 协议'],
	];
	for (const [spec, label] of forms) {
		check(`githubSlug 认得 ${label}`, v.githubSlug(spec) === same, `${v.githubSlug(spec)} <- ${spec}`);
	}

	// 反向：非 GitHub 的不能被误认成 GitHub
	for (const spec of [
		'not-a-github-spec',
		'https://gitlab.com/o/r.git',
		'git+https://bitbucket.org/o/r.git',
		'registry-pkg@1.2.3',
		'link:C:/local/dir',
	]) {
		check(`githubSlug 不误认 ${spec}`, v.githubSlug(spec) === null, String(v.githubSlug(spec)));
	}

	// 最关键的一条：真实订阅后的 spec 必须能通过 checkGitDependency，
	// 而不是落进 unsupported-spec。这是用户实际遇到的失败。
	const realSpec = 'git+https://github.com/octocat/Hello-World.git#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
	const realInfo = await v.checkGitDependency({ name: 'probe', spec: realSpec, version: '0.0.0' }, { branch: 'master' });
	check('installBundle 写回的 git+https spec 不再标 unsupported',
		realInfo.note !== 'unsupported-spec', JSON.stringify(realInfo));
	check('该 spec 能解析出 slug', realInfo.slug === 'octocat/Hello-World', String(realInfo.slug));
}

// ── checkUpdates 对 git 依赖必须真的检查 ────────────────────
// 这组是回归测试：`github:owner/repo#sha` 曾经落进「unsupported-spec」，
// 于是每个刚订阅成功的插件都永久显示「无法检查」——订阅的全部意义就是能查更新。
//
// 用公开的、长期稳定的仓库做「真实远端」用例，而不是某台机器上的本地插件：
// 测试写死本机某个私有仓库的 commit，换台机器就必然失败，公开出去更是跑不了。
{
	const olderSha = 'a'.repeat(40);

	// 直接测判定函数：它接受 plugin 和 options，内部调用 remoteCommit。
	const { checkGitDependency } = v;

	// (a) slug 解析不出来 → unsupported-spec
	const noSlug = await checkGitDependency({ name: 'x', spec: 'not-a-github-spec' });
	check('git 依赖里非 GitHub 的 spec 才标 unsupported', noSlug.note === 'unsupported-spec', JSON.stringify(noSlug));

	// (b) 真实远端：用一个公开且稳定的仓库，先读它的 tip，再用同一个 sha 构造
	// 一份「锁定值等于 tip」的依赖，断言判定为最新。这样测试不依赖任何本机状态。
	const probeSlug = 'octocat/Hello-World';
	// 这个仓库的主分支是 master，不是 main。必须显式传下去：
	// `checkGitDependency` 默认按 main 比对，探到的 tip 却是 master，两者对不上。
	const probeBranch = 'master';
	const tip = await v.remoteCommit(probeSlug, probeBranch);
	if (tip === null) {
		skip('git 依赖的远端比对', '网络不可用或该公开仓库不可达');
	} else {
		const real = await checkGitDependency({
			name: 'probe',
			spec: `github:${probeSlug}#${tip}`,
			version: '0.0.0',
		}, { branch: probeBranch });
		check('git 依赖能读到远端 tip', real.latestCommit === tip, String(real.latestCommit));
		// 回归：`latest` 在 registry 语义里是版本号。把它填成 40 位 sha，界面就会
		// 把 commit 当作版本号渲染在「最新」列——用户看到 `c6c0ad3f…` 会以为
		// 版本号解析错了。这条断言就是防止那个 bug 回来。
		check('git 依赖不把 sha 塞进 latest（那是版本字段）', real.latest === null, String(real.latest));
		check('git 依赖不再标 unsupported', real.note !== 'unsupported-spec', String(real.note));
		check('锁定 commit 等于远端 tip 时判为最新', real.updateAvailable === false, JSON.stringify(real));

		// (c) 锁定一个必然不等于 tip 的 commit → 应该判为「上游有新提交」
		const behind = await checkGitDependency({
			name: 'probe',
			spec: `github:${probeSlug}#${olderSha}`,
			version: '0.0.0',
		}, { branch: probeBranch });
		check('锁定的 commit 落后时判为可更新', behind.updateAvailable === true, JSON.stringify(behind));
		check('落后时给出 upstream-ahead 说明', behind.note === 'upstream-ahead', String(behind.note));
		check('落后时 latest 依然为空', behind.latest === null, String(behind.latest));
		check('落后时 latestCommit 是新 tip', behind.latestCommit === tip, String(behind.latestCommit));
	}

	// (d) 远端读不到 → remote-unreachable，而不是假装最新
	const unreachable = await checkGitDependency({
		name: 'x',
		spec: 'github:definitely-not-a-real-owner-xyz/nonexistent-repo-xyz#abc1234',
		version: '1.0.0',
	});
	check('远端读不到时不谎报最新', unreachable.updateAvailable === false, JSON.stringify(unreachable));
	check('远端读不到时标 remote-unreachable', unreachable.note === 'remote-unreachable', String(unreachable.note));

	// (e) 接线测试：checkUpdates 必须把 kind==='git' 的插件交给上面的逻辑。
	// 只测 checkGitDependency 本身是不够的——删掉 checkUpdates 里的 git 分支，
	// 单测照样全绿（这里之前就漏过一次）。所以必须从 checkUpdates 这一侧验证。
	// 指向不存在的仓库即可：这条只验证「是否进入 git 分支」，不验证远端内容。
	const wired = await v.checkUpdates([
		{ name: 'git-pkg', kind: 'git', version: '0.4.1', spec: `github:${probeSlug}#${olderSha}` },
	]);
	const gitRow = wired.get('git-pkg');
	check('checkUpdates 走 git 分支而非 unsupported',
		gitRow?.note !== 'unsupported-spec', JSON.stringify(gitRow));
	check('checkUpdates 的 git 行标明 source=git', gitRow?.source === 'git', String(gitRow?.source));
	check('checkUpdates 的 git 行带 slug', typeof gitRow?.slug === 'string', String(gitRow?.slug));
}

// ── 订阅：不可订阅的目录 ────────────────────────────────────
{
	const missing = await s.planSubscription({ name: 'x', path: 'C:/definitely/not/here' });
	check('不存在的路径不可订阅', missing.ready === false);
	check('不存在的路径报告 missing-path', missing.blockedBy.includes('missing-path'));

	const notRepo = await s.planSubscription({ name: 'x', path: 'C:/Data/deepseek' });
	check('非 git 目录不可订阅', notRepo.ready === false);
	check('非 git 目录报告 not-a-git-repo', notRepo.blockedBy.includes('not-a-git-repo'));
}

// ── 订阅：真实的本地插件 ────────────────────────────────────
{
	const report = await s.inspectLocal('C:/Data/deepseek/remote-mobile');
	if (!report.isRepo) {
		skip('真实本地插件订阅检查', '目录不是 git 仓库（环境变化）');
	} else {
		check('识别为 git 仓库', report.isRepo === true);
		check('识别出 GitHub slug', typeof report.slug === 'string' && report.slug.includes('/'), report.slug);
		check('记录当前提交短哈希', typeof report.short === 'string' && report.short.length === 12, report.short);
		const spec = s.subscribeSpec(report);
		if (report.subscribable) {
			check('可订阅时给出 pinned spec', /^github:[^/]+\/[^#]+#[0-9a-f]{40}$/.test(spec), spec);
			check('spec 固定到具体提交而非分支', !spec.includes('#main') && !spec.includes('#master'), spec);
		} else {
			check('不可订阅时 spec 为 null', spec === null, String(report.blockedBy));
		}
	}
}

// ── 订阅：阻断原因都有中文说明 ──────────────────────────────
{
	const codes = ['missing-path', 'not-a-git-repo', 'no-remote', 'not-github', 'dirty', 'unpushed', 'no-commit', 'name-mismatch'];
	const missingText = codes.filter((c) => typeof s.BLOCKER_TEXT[c] !== 'string' || s.BLOCKER_TEXT[c] === '');
	check('全部阻断原因都有中文说明', missingText.length === 0, missingText.join(','));
}

console.log(`\n${passed} checks passed${skipped > 0 ? `, ${skipped} skipped` : ''}`);

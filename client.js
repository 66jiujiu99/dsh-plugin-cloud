window.__ModuleLoader__.load({
	id: 'dsh-plugin-cloud',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		const { useState, useEffect, useCallback, useMemo } = React;

		const NS = 'plugin-cloud';

		/**
		 * Resolve API paths against the page's real base URL.
		 *
		 * The Desktop shell serves the UI from `dsh-app://app/`, and the
		 * phone-sync plugin reverse-proxies the same UI under `/m/`. A leading
		 * `"/api/…"` leaves whichever mount served the page, so the Host answers
		 * 404. `document.baseURI` keeps requests under the live prefix.
		 */
		function api(path) {
			try { return new URL(`./api/plugin-cloud${path}`, document.baseURI).href; }
			catch { return `/api/plugin-cloud${path}`; }
		}

		// ───────────────────────────── 文案 ─────────────────────────────
		/** 简体中文字典：本插件的文案源。 */
		const ZH = {
			tab: '插件云',
			title: '插件云',
			subtitle: '插件版本管理 · 自动备份 · 一键迁移',
			sectionPlugins: '插件',
			sectionVersions: '版本',
			sectionSettings: '设置',
			colName: '插件',
			colVersion: '当前版本',
			colLatest: '最新',
			colStatus: '状态',
			colActions: '操作',
			statusCurrent: '最新',
			statusUpdatable: '可更新',
			statusDisabled: '已停用',
			statusMissing: '未安装',
			statusUntracked: '本地未跟踪',
			statusUnsupported: '无法检查',
			statusUnreachable: '远端读取失败',
			statusSelfUpdate: '需手动升级',
			statusBehindUpstream: '上游有新提交',
			noVersionUpstream: '按提交跟踪',
			jobProgress: '正在处理 {done}/{total}',
			cancel: '取消',
			cancelling: '正在取消…',
			jobLost: '与升级任务的连接中断了，请刷新查看结果',
			selfUpgradeNote: '需手动升级',
			selfUpgradeCopied: '已复制命令',
			selfUpgradeHint: '本插件不能升级自己：替换正在处理请求的代码在 Windows 上必然失败。请在源目录 git pull 后重启 DSH。',
			errJobRunning: '已有升级任务在运行，请等它结束',
			errJobNotFound: '找不到这个升级任务',
			errNoRunningJob: '当前没有正在运行的升级任务',
			errUnsupportedSpec: '快照里的安装地址无法识别，不能升级',
			errRemoteUnreachable: '读不到远端仓库，暂时无法判断有没有更新',
			upgrade: '升级',
			upgradeAll: '全部升级',
			checkUpdates: '检查更新',
			behindN: '落后 {n} 个版本',
			upToDate: '全部已是最新',
			noPlugins: '没有读取到插件。',
			pluginsSummary: '{total} 个插件 · {updatable} 个可更新 · {local} 个本地',
			upgradeDone: '{names} 已升级，{restart}',
			upgradeFailed: '升级失败',
			subscribe: '转为订阅',
			subscribeHint: '把这个本地目录插件改从它的 GitHub 仓库安装，之后就能检查更新。',
			subscribeDone: '{names} 已改为订阅其仓库，{restart}',
			subscribeFailed: '订阅失败',
			restartSuffix: '重启 DSH 后生效',
			liveSuffix: '已即时生效',
			subscriptionTitle: '可转为订阅的本地插件',
			nodeLocal: '本地目录',
			nodeRegistry: 'npm 仓库',
			nodeGit: 'Git 仓库',
			cloud: '云端',
			repo: '仓库（owner/name）',
			tokenRef: '凭证名',
			auto: '自动备份',
			interval: '间隔（小时）',
			keep: '保留快照数',
			autoChange: '插件变动时自动备份',
			autoChangeHint: '安装、卸载、启停插件后立即备份',
			saveCfg: '保存配置',
			saved: '配置已保存',
			reachable: '已连接',
			unreachable: '连不上',
			private: '私有',
			public: '公开仓库！快照会被任何人看到',
			versions: '备份版本',
			noVersions: '还没有备份。',
			backupNow: '立即备份',
			restore: '装回',
			check: '预检',
			del: '删除',
			confirm: '确认装回',
			details: '详情',
			close: '关闭',
			local: '本机',
			cloudBadge: '云端',
			both: '本机+云端',
			lastPush: '最近推送',
			lastChange: '最近变动',
			report: '装回报告',
			dryRun: '预检——没有写入任何东西',
			realRun: '装回已执行',
			order: 'Bundle 顺序',
			summary: '{total} 个插件 · {local} 个本地 · {disabled} 个已停用',
			emptyRepo: '例如 your-name/dsh-env',
			token: 'GitHub 令牌',
			tokenHint: '粘贴具有 repo 权限的细粒度 PAT——存入凭证服务，绝不写进配置',
			tokenSet: '已存有令牌——只在需要更换时填写',
			needsConfig: '还没配置仓库。填好下面的仓库和令牌后点「保存配置」。',
			statusPending: '待处理',
			statusPlanned: '计划中',
			statusInstalled: '已安装',
			statusInstalledRestart: '已安装（重启生效）',
			statusAlready: '已符合',
			statusManual: '需手动',
			statusUnresolved: '未解决',
			statusFailed: '失败',
			disabledTag: '已停用',
			errNotFound: '找不到这个快照',
			errInvalidName: '快照文件名不合法',
			errUnreadable: '快照文件读不出来',
			errNoToken: '还没配置 GitHub 令牌',
			// 管理器与插件云自身的失败码，界面按当前语言解释。
			errManagerUnavailable: '插件管理器不可用',
			errNoUpgradeTargets: '没有指定要升级的插件',
			errNoSubscribeTargets: '没有指定要订阅的插件',
			errSelfUpgrade: '本插件不能升级自己',
			errSelfSubscribe: '本插件不能订阅自己',
			errUnknownPlugin: '这个插件不在当前 profile 里',
			errNotLocalPlugin: '只有本地目录插件需要转为订阅',
			errRegistryUnreachable: 'npm registry 里没有这个包，或读取失败',
			errManifestWrite: '无法写入 profile 的 package.json',
			errAlreadyInstalled: '这个版本已经装好了',
			errIncompatibleVersion: '这个版本与当前 DSH 运行时不兼容',
			errInvalidSpec: '安装地址不合法',
			errNotBundle: '这个包不是 bundle，不能这样装',
			errAmbiguousInstall: '安装结果不明确，请到插件页确认',
			errNotRemovable: '这个包不能由插件移除',
			errBundleInUse: '插件正在被使用，装卸需要先停用',
			errManagementRequired: '这一项只能由 DSH 自身管理',
			errStopProfile: '需要先停止当前 profile 才能改',
			errOperationError: '操作失败',
			errStaleApproval: '构建审批已过期，请重新确认',
			errSubscribeBlocked: '不能订阅',
			// 订阅阻断原因。
			blockMissingPath: '本地目录不存在',
			blockNotGitRepo: '本地目录不是 git 仓库',
			blockNoRemote: '没有配置 origin 远程',
			blockNotGithub: '远程不是 GitHub 仓库',
			blockDirty: '有未提交的改动',
			blockUnpushed: '有提交还没推送',
			blockNoCommit: '仓库里还没有提交',
			blockNameMismatch: '目录里的包名与依赖名不一致',
			errNoCredentialService: '凭证服务不可用',
			errInvalidRepo: '仓库必须写成 owner/name',
			errNoFields: '没有要保存的内容',
			errEmptyToken: '令牌是空的',
			errRejectedFields: '这些字段不被接受',
			updateCheckFailed: '版本检查失败',
			never: '从未',
			justNow: '刚刚',
			minutesAgo: '{n} 分钟前',
			hoursAgo: '{n} 小时前',
			daysAgo: '{n} 天前',
			switchPlugin: '本插件',
			restartTip: '插件改动需要重启 DSH 才会完全生效。',
		};

		/** English dictionary, checked against the Chinese key set. */
		const EN = {
			tab: 'Plugin Cloud',
			title: 'Plugin Cloud',
			subtitle: 'Version management · automatic backup · one-click migration',
			sectionPlugins: 'Plugins',
			sectionVersions: 'Versions',
			sectionSettings: 'Settings',
			colName: 'Plugin',
			colVersion: 'Installed',
			colLatest: 'Latest',
			colStatus: 'Status',
			colActions: 'Actions',
			statusCurrent: 'Up to date',
			statusUpdatable: 'Update',
			statusDisabled: 'Disabled',
			statusMissing: 'Missing',
			statusUntracked: 'Local, untracked',
			statusUnsupported: 'Uncheckable',
			statusUnreachable: 'Remote unreachable',
			statusSelfUpdate: 'Manual upgrade',
			statusBehindUpstream: 'Upstream ahead',
			noVersionUpstream: 'tracked by commit',
			jobProgress: 'Working on {done}/{total}',
			cancel: 'Cancel',
			cancelling: 'Cancelling…',
			jobLost: 'Lost contact with the upgrade; refresh to see the result',
			selfUpgradeNote: 'manual upgrade',
			selfUpgradeCopied: 'command copied',
			selfUpgradeHint: 'This plugin cannot upgrade itself: replacing the code handling this request fails on Windows. Run git pull in the source directory, then restart DSH.',
			errJobRunning: 'An upgrade is already running; wait for it to finish',
			errJobNotFound: 'That upgrade job was not found',
			errNoRunningJob: 'No upgrade job is running',
			errUnsupportedSpec: 'The recorded install spec cannot be understood',
			errRemoteUnreachable: 'The remote could not be read, so updates cannot be checked',
			upgrade: 'Upgrade',
			upgradeAll: 'Upgrade all',
			checkUpdates: 'Check',
			behindN: '{n} versions behind',
			upToDate: 'Everything is up to date',
			noPlugins: 'No plugins were read.',
			pluginsSummary: '{total} plugins · {updatable} updatable · {local} local',
			upgradeDone: '{names} upgraded — {restart}',
			upgradeFailed: 'Upgrade failed',
			subscribe: 'Subscribe',
			subscribeHint: 'Reinstall this local plugin from its GitHub repository so updates can be tracked.',
			subscribeDone: '{names} now subscribe to their repository — {restart}',
			subscribeFailed: 'Subscribe failed',
			restartSuffix: 'restart DSH to apply',
			liveSuffix: 'applied live',
			subscriptionTitle: 'Local plugins that can subscribe',
			nodeLocal: 'Local directory',
			nodeRegistry: 'npm registry',
			nodeGit: 'Git repository',
			cloud: 'Cloud',
			repo: 'Repository (owner/name)',
			tokenRef: 'Credential name',
			auto: 'Auto backup',
			interval: 'Interval (hours)',
			keep: 'Keep snapshots',
			autoChange: 'Back up on plugin changes',
			autoChangeHint: 'Snapshot right after install, uninstall or enablement',
			saveCfg: 'Save configuration',
			saved: 'Configuration saved',
			reachable: 'Connected',
			unreachable: 'Unreachable',
			private: 'private',
			public: 'PUBLIC — snapshots would be world-readable',
			versions: 'Backup versions',
			noVersions: 'No backups yet.',
			backupNow: 'Back up now',
			restore: 'Restore',
			check: 'Check',
			del: 'Delete',
			confirm: 'Confirm restore',
			details: 'Details',
			close: 'Close',
			local: 'local',
			cloudBadge: 'cloud',
			both: 'local+cloud',
			lastPush: 'Last push',
			lastChange: 'Last change',
			report: 'Restore report',
			dryRun: 'Dry run — nothing written',
			realRun: 'Restore executed',
			order: 'Bundle order',
			summary: '{total} plugins · {local} local · {disabled} disabled',
			emptyRepo: 'e.g. your-name/dsh-env',
			token: 'GitHub token',
			tokenHint: 'Paste a fine-grained PAT with repo scope — stored in the credential service, never in config',
			tokenSet: 'A token is already stored — enter one only to replace it',
			needsConfig: 'No repository yet. Fill in the repository and token above, then Save.',
			statusPending: 'pending',
			statusPlanned: 'planned',
			statusInstalled: 'installed',
			statusInstalledRestart: 'installed (restart)',
			statusAlready: 'already',
			statusManual: 'manual',
			statusUnresolved: 'unresolved',
			statusFailed: 'failed',
			disabledTag: 'disabled',
			// Manager and plugin-cloud failure codes, rendered in the active language.
			errAlreadyInstalled: 'That version is already installed',
			errIncompatibleVersion: 'This version is incompatible with the running DSH',
			errInvalidSpec: 'Invalid install spec',
			errNotBundle: 'That package is not a bundle and cannot be installed this way',
			errAmbiguousInstall: 'The install outcome is unclear; check the Plugins page',
			errNotRemovable: 'This package cannot be removed by a plugin',
			errBundleInUse: 'The plugin is in use; disable it first',
			errManagementRequired: 'Only DSH itself may manage this entry',
			errStopProfile: 'Stop the current profile before changing this',
			errOperationError: 'The operation failed',
			errStaleApproval: 'The build approval expired; confirm again',
			errUnknownPlugin: 'That plugin is not in the current profile',
			errNotLocalPlugin: 'Only local-directory plugins can subscribe',
			errRegistryUnreachable: 'The npm registry has no such package, or could not be read',
			errManifestWrite: 'The profile package.json could not be rewritten',
			errSelfUpgrade: 'This plugin cannot upgrade itself',
			errSelfSubscribe: 'This plugin cannot subscribe itself',
			errSubscribeBlocked: 'Cannot subscribe',
			errInvalidRepo: 'The repository must be owner/name',
			errNoFields: 'Nothing to save',
			errEmptyToken: 'The token is empty',
			errManagerUnavailable: 'The plugin manager is unavailable',
			errNoUpgradeTargets: 'No plugins were named to upgrade',
			errNoSubscribeTargets: 'No plugins were named to subscribe',
			errRejectedFields: 'These fields were rejected',
			updateCheckFailed: 'Version check failed',
			blockMissingPath: 'The local directory does not exist',
			blockNotGitRepo: 'The local directory is not a git repository',
			blockNoRemote: 'No origin remote is configured',
			blockNotGithub: 'The remote is not a GitHub repository',
			blockDirty: 'There are uncommitted changes',
			blockUnpushed: 'Some commits have not been pushed',
			blockNoCommit: 'The repository has no commits yet',
			blockNameMismatch: 'The package name in the directory differs from the dependency key',
			errNotFound: 'Snapshot not found',
			errInvalidName: 'Invalid snapshot file name',
			errUnreadable: 'Snapshot file is unreadable',
			errNoToken: 'No GitHub token configured yet',
			errNoCredentialService: 'The credential service is unavailable',
			never: 'never',
			justNow: 'just now',
			minutesAgo: '{n} min ago',
			hoursAgo: '{n} h ago',
			daysAgo: '{n} d ago',
			switchPlugin: 'this plugin',
			restartTip: 'Plugin changes need a DSH restart to take full effect.',
		};

		/** 语言切换时重渲染。 */
		function useLocaleRevision(locale) {
			const [revision, setRevision] = useState(0);
			useEffect(() => {
				const subscribe = locale?.subscribe;
				if (locale === undefined || locale === null || typeof subscribe !== 'function') return undefined;
				return subscribe.call(locale, () => setRevision((v) => v + 1));
			}, [locale]);
			return revision;
		}

		/** 读取当前生效语言，取不到时按中文。 */
		function activeLocaleId(locale) {
			try {
				const read = locale?.getLocale;
				if (typeof read !== 'function') return 'zh';
				const active = read.call(locale)?.active;
				return active === undefined ? 'zh' : String(active);
			} catch { return 'zh'; }
		}

		/** 先问 locale 服务，再回落到本地字典；中文优先。 */
		function makeT(bound, active) {
			return (key, params) => {
				if (bound !== undefined) {
					try {
						const value = bound(key, params);
						if (typeof value === 'string' && value !== key) return value;
					} catch { /* 未注册时走回落 */ }
				}
				const zh = String(active()).toLowerCase().startsWith('zh');
				const value = (zh ? ZH : EN)[key] ?? ZH[key] ?? key;
				if (typeof value !== 'string') return String(key);
				if (!params) return value;
				return value.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
			};
		}

		/**
		 * Failure code → dictionary key.
		 *
		 * The Host reports machine codes (the manager's own, plus plugin-cloud's).
		 * Showing `already-installed` to a Chinese reader is not a translation, and
		 * a bare pnpm message is worse than useless. Anything absent here falls
		 * through as raw text, so an unknown code still reaches the user.
		 */
		const CODE_KEYS = {
			'not-found': 'errNotFound',
			'invalid-name': 'errInvalidName',
			'unreadable': 'errUnreadable',
			'already-installed': 'errAlreadyInstalled',
			'incompatible-version': 'errIncompatibleVersion',
			'invalid-spec': 'errInvalidSpec',
			'not-bundle': 'errNotBundle',
			'ambiguous-install': 'errAmbiguousInstall',
			'not-removable': 'errNotRemovable',
			'bundle-in-use': 'errBundleInUse',
			'management-required': 'errManagementRequired',
			'stop-profile': 'errStopProfile',
			'operation-error': 'errOperationError',
			'stale-approval': 'errStaleApproval',
			'unknown-plugin': 'errUnknownPlugin',
			'not-a-local-plugin': 'errNotLocalPlugin',
			'registry-unreachable': 'errRegistryUnreachable',
			'manifest-unavailable': 'errManifestWrite',
			'manifest-write-failed': 'errManifestWrite',
			'self-upgrade-blocked': 'errSelfUpgrade',
			'self-subscribe-blocked': 'errSelfSubscribe',
			'invalid-repo': 'errInvalidRepo',
			'no-fields': 'errNoFields',
			'empty-token': 'errEmptyToken',
			'manager-unavailable': 'errManagerUnavailable',
			'no-upgrade-targets': 'errNoUpgradeTargets',
			'no-subscribe-targets': 'errNoSubscribeTargets',
			'credential-unavailable': 'errNoCredentialService',
			'rejected-fields': 'errRejectedFields',
			// Job endpoints: an upgrade runs in the background, so these report on
			// the job rather than on the install itself.
			'job-running': 'errJobRunning',
			'job-not-found': 'errJobNotFound',
			'no-running-job': 'errNoRunningJob',
			'unsupported-spec': 'errUnsupportedSpec',
			'remote-unreachable': 'errRemoteUnreachable',
		};

		/** Subscription blocker code → dictionary key. */
		const BLOCKER_KEYS = {
			'missing-path': 'blockMissingPath',
			'not-a-git-repo': 'blockNotGitRepo',
			'no-remote': 'blockNoRemote',
			'not-github': 'blockNotGithub',
			'dirty': 'blockDirty',
			'unpushed': 'blockUnpushed',
			'no-commit': 'blockNoCommit',
			'name-mismatch': 'blockNameMismatch',
		};

		/** Translate one machine code, or return the raw text when unknown. */
		function codeText(t, code) {
			const key = CODE_KEYS[code];
			return key === undefined ? code : t(key);
		}

		/** Translate a blocker list into readable phrases. */
		function blockerText(t, codes) {
			return (codes ?? []).map((c) => (BLOCKER_KEYS[c] === undefined ? c : t(BLOCKER_KEYS[c])));
		}

		/**
		 * Explain a Host error.
		 *
		 * Codes arrive in three shapes: a bare code (`invalid-repo`), a code with
		 * a payload (`rejected-fields:repo,token`, `subscribe-blocked:dirty`), or
		 * a genuine message (a pnpm line, a GitHub `401: Bad credentials`). The
		 * first two are translated; the third is shown as-is, because inventing a
		 * translation for text we did not write would hide what actually failed.
		 */
		function errorText(t, raw) {
			const text = String(raw ?? '');
			if (text === '') return '';
			if (CODE_KEYS[text] !== undefined) return t(CODE_KEYS[text]);
			// `code:payload` — translate the code, then render the payload in the
			// language that fits it (blocker codes have their own table).
			const split = text.indexOf(':');
			if (split > 0) {
				const head = text.slice(0, split);
				const tail = text.slice(split + 1).trim();
				if (head === 'subscribe-blocked') {
					const list = blockerText(t, tail.split(',').filter(Boolean));
					return list.length > 0 ? `${t('errSubscribeBlocked')}：${list.join('、')}` : t('errSubscribeBlocked');
				}
				if (head === 'rejected-fields') {
					return `${t('errRejectedFields')}：${tail.split(',').filter(Boolean).join('、')}`;
				}
			}
			// A credential reference the service could not resolve still names the
			// old, human-written form; keep matching it so stored messages work.
			if (/凭证 .* 未配置/.test(text)) return t('errNoToken');
			return text;
		}

		/**
		 * Coerce a package metadata field to display text.
		 *
		 * `meta.title` is a locale map (`{ zh, en }`) while `description` is a
		 * plain string, and either may be absent. Interpolating the map straight
		 * into a template string is what produced `[object Object]` in the list,
		 * so every field goes through here before it reaches the DOM.
		 *
		 * @param {unknown} value - string, locale map, or array of either.
		 * @param {string} lang - active locale id (`zh` / `en`).
		 * @returns {string} display text, possibly empty.
		 */
		function textOf(value, lang) {
			if (value === null || value === undefined) return '';
			if (typeof value === 'string') return value;
			if (typeof value === 'number' || typeof value === 'boolean') return String(value);
			if (Array.isArray(value)) {
				return value.map((item) => textOf(item, lang)).filter(Boolean).join(' · ');
			}
			if (typeof value === 'object') {
				// A locale map: prefer the active language, then English, then any.
				const pick = value[lang] ?? value.en ?? value.zh
					?? Object.values(value).find((v) => typeof v === 'string');
				return typeof pick === 'string' ? pick : '';
			}
			return '';
		}

		/** 相对时间，避免整页都是 ISO 串。 */
		function ago(t, iso) {
			if (!iso) return t('never');
			const ms = Date.now() - new Date(iso).getTime();
			if (!Number.isFinite(ms) || ms < 0) return String(iso).slice(0, 19).replace('T', ' ');
			const min = Math.floor(ms / 60000);
			if (min < 1) return t('justNow');
			if (min < 60) return t('minutesAgo', { n: min });
			const hrs = Math.floor(min / 60);
			if (hrs < 24) return t('hoursAgo', { n: hrs });
			return t('daysAgo', { n: Math.floor(hrs / 24) });
		}

		// ───────────────────────────── 样式 ─────────────────────────────
		const STYLE_ID = 'dsh-plugin-cloud-style';
		const CSS = `
.pc-root { display:flex; flex-direction:column; gap:14px; font-size:13px; line-height:1.5; }
.pc-hero { border:1px solid var(--dsw-border,rgba(128,128,128,.24)); border-radius:14px; padding:16px 18px;
  background:linear-gradient(135deg, rgba(77,163,255,.10), rgba(120,110,255,.06) 55%, transparent); }
.pc-hero-top { display:flex; align-items:flex-start; gap:12px; flex-wrap:wrap; }
.pc-title { font-size:16px; font-weight:650; letter-spacing:.2px; }
.pc-sub { font-size:12px; color:var(--dsw-text-secondary,#8b95a5); margin-top:2px; }
.pc-spacer { flex:1 1 auto; }
.pc-tabs { display:flex; gap:4px; padding:3px; border-radius:10px; background:rgba(128,128,128,.10); }
.pc-tab { border:0; background:transparent; color:inherit; font:inherit; font-size:12px; padding:5px 12px;
  border-radius:8px; cursor:pointer; opacity:.7; transition:background .15s, opacity .15s; }
.pc-tab:hover { opacity:1; }
.pc-tab.on { background:var(--dsw-surface,#fff); opacity:1; font-weight:600; box-shadow:0 1px 3px rgba(0,0,0,.10); }
.pc-card { border:1px solid var(--dsw-border,rgba(128,128,128,.24)); border-radius:14px; overflow:hidden;
  background:var(--dsw-surface,rgba(128,128,128,.03)); }
.pc-card-head { display:flex; align-items:center; gap:10px; padding:12px 16px;
  border-bottom:1px solid var(--dsw-border,rgba(128,128,128,.16)); }
.pc-card-title { font-weight:620; font-size:13px; }
.pc-card-body { padding:12px 16px; }
.pc-muted { color:var(--dsw-text-secondary,#8b95a5); font-size:12px; }
.pc-btn { border:1px solid var(--dsw-border,rgba(128,128,128,.32)); background:var(--dsw-surface,#fff); color:inherit;
  font:inherit; font-size:12px; padding:5px 12px; border-radius:9px; cursor:pointer;
  transition:transform .08s, border-color .15s, background .15s, opacity .15s; white-space:nowrap; }
.pc-btn:hover:not(:disabled) { border-color:var(--dsw-accent,#4da3ff); }
.pc-btn:active:not(:disabled) { transform:translateY(1px); }
.pc-btn:disabled { opacity:.45; cursor:not-allowed; }
.pc-btn.primary { background:var(--dsw-accent,#4da3ff); border-color:transparent; color:#fff; font-weight:600; }
.pc-btn.primary:hover:not(:disabled) { filter:brightness(1.08); }
.pc-btn.danger { color:#e06c6c; }
.pc-btn.danger:hover:not(:disabled) { border-color:#e06c6c; }
.pc-btn.sm { padding:3px 9px; font-size:11.5px; }
/* Every column is a fixed track, so a row with one button and a row with two
   occupy identical columns. The actions track used to be sized by content,
   which is what made the whole table look ragged: each row sized that column
   to its own buttons. */
.pc-row { display:grid;
  grid-template-columns:minmax(0,1fr) 88px 88px 136px 152px;
  gap:12px; align-items:center;
  padding:9px 16px; border-bottom:1px solid var(--dsw-border,rgba(128,128,128,.10)); }
.pc-row:last-child { border-bottom:0; }
.pc-row.head { background:rgba(128,128,128,.06); font-size:11.5px; font-weight:600;
  color:var(--dsw-text-secondary,#8b95a5); }
.pc-row:not(.head):hover { background:rgba(128,128,128,.05); }
/* Cells share one vertical rhythm: fixed min-height keeps single-line and
   two-line rows the same height, and each cell declares its own alignment. */
.pc-row > * { min-width:0; min-height:32px; display:flex; align-items:center; }
.pc-c-name { flex-direction:column; align-items:flex-start; justify-content:center; gap:1px; }
.pc-c-ver { justify-content:flex-end; text-align:right; }
.pc-c-status { flex-direction:column; align-items:flex-start; justify-content:center; gap:2px; }
.pc-c-act { justify-content:flex-end; gap:6px; flex-wrap:nowrap; }
.pc-name-main { font-weight:550; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
.pc-name-meta { font-size:11px; color:var(--dsw-text-secondary,#8b95a5); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; max-width:100%; }
.pc-ver { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px;
  white-space:nowrap; font-variant-numeric:tabular-nums; }
.pc-badge { display:inline-flex; align-items:center; gap:4px; font-size:11px; font-weight:600;
  padding:2px 8px; border-radius:999px; white-space:nowrap; border:1px solid transparent;
  /* Fixed height + no shrink keeps every badge the same box, so a row with a
     two-line status cell still lines its badge up with its neighbours. */
  height:20px; flex:none; line-height:1; }
.pc-badge.current { color:#4a9d5f; background:rgba(87,178,106,.14); border-color:rgba(87,178,106,.30); }
.pc-badge.updatable { color:#3d8ee0; background:rgba(77,163,255,.16); border-color:rgba(77,163,255,.34); }
.pc-badge.behind-upstream { color:#3d8ee0; background:rgba(77,163,255,.16); border-color:rgba(77,163,255,.34); }
.pc-badge.disabled { color:#9aa4b2; background:rgba(128,128,128,.14); border-color:rgba(128,128,128,.26); }
.pc-badge.missing { color:#e06c6c; background:rgba(224,108,108,.14); border-color:rgba(224,108,108,.30); }
.pc-badge.untracked { color:#c9a84c; background:rgba(201,168,76,.15); border-color:rgba(201,168,76,.32); }
.pc-badge.unsupported { color:#9aa4b2; background:rgba(128,128,128,.12); border-color:rgba(128,128,128,.22); }
.pc-badge.unreachable { color:#c9a84c; background:rgba(201,168,76,.14); border-color:rgba(201,168,76,.30); }
.pc-badge.self-update { color:#c9a84c; background:rgba(201,168,76,.14); border-color:rgba(201,168,76,.30); }
/* Live upgrade progress: the real pipeline steps, not an indeterminate bar. */
.pc-job { border:1px solid var(--dsw-border,rgba(128,128,128,.26)); border-radius:12px;
  padding:10px 14px; background:rgba(77,163,255,.05); display:flex; flex-direction:column; gap:6px; }
.pc-job-head { display:flex; align-items:center; gap:10px; }
.pc-job-title { font-size:12.5px; font-weight:600; }
.pc-job-elapsed { font-size:11.5px; color:var(--dsw-text-secondary,#8b95a5);
  font-variant-numeric:tabular-nums; margin-left:auto; }
.pc-job-sub { font-size:11.5px; color:var(--dsw-text-secondary,#8b95a5); }
.pc-job-err { font-size:12px; color:#e06c6c; }
.pc-steps { list-style:none; margin:2px 0 0; padding:0; display:flex; flex-direction:column; gap:4px; }
.pc-step { display:flex; align-items:center; gap:8px; font-size:12px;
  color:var(--dsw-text-secondary,#8b95a5); }
.pc-step-dot { width:7px; height:7px; border-radius:999px; flex:none;
  border:1.5px solid currentColor; background:transparent; }
.pc-step.on { color:var(--dsw-accent,#4da3ff); font-weight:600; }
.pc-step.on .pc-step-dot { background:currentColor; box-shadow:0 0 0 3px rgba(77,163,255,.20); }
.pc-step.done { color:#4a9d5f; }
.pc-step.done .pc-step-dot { background:currentColor; }
.pc-dot { width:6px; height:6px; border-radius:999px; background:currentColor; flex:none; }
.pc-btn { border:1px solid var(--dsw-border,rgba(128,128,128,.32)); background:var(--dsw-surface,#fff); color:inherit;
  font:inherit; font-size:12px; padding:5px 12px; border-radius:9px; cursor:pointer;
  transition:transform .08s, border-color .15s, background .15s, opacity .15s; white-space:nowrap; }
.pc-input { padding:5px 10px; font:inherit; font-size:12px; border-radius:9px;
  border:1px solid var(--dsw-border,rgba(128,128,128,.32)); background:transparent; color:inherit; }
.pc-input:focus { outline:none; border-color:var(--dsw-accent,#4da3ff); }
.pc-field { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.pc-label { font-size:12px; color:var(--dsw-text-secondary,#8b95a5); white-space:nowrap; }
.pc-note { font-size:12px; border-radius:10px; padding:8px 12px; }
.pc-note.warn { color:#c9a84c; background:rgba(201,168,76,.10); border:1px solid rgba(201,168,76,.26); }
.pc-note.err { color:#e06c6c; background:rgba(224,108,108,.10); border:1px solid rgba(224,108,108,.26); }
.pc-note.ok { color:#4a9d5f; background:rgba(87,178,106,.10); border:1px solid rgba(87,178,106,.26); }
.pc-ver-item { padding:10px 16px; border-bottom:1px solid var(--dsw-border,rgba(128,128,128,.10)); }
.pc-ver-item:last-child { border-bottom:0; }
.pc-ver-line { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.pc-ver-line > * { flex:none; }
.pc-ver-actions { display:flex; align-items:center; gap:6px; flex-wrap:nowrap; }
.pc-ver-label { font-weight:600; }
.pc-chip { font-size:10.5px; padding:1px 7px; border-radius:6px;
  border:1px solid var(--dsw-border,rgba(128,128,128,.28)); color:var(--dsw-text-secondary,#8b95a5); }
.pc-empty { padding:26px 16px; text-align:center; color:var(--dsw-text-secondary,#8b95a5); font-size:12.5px; }
.pc-skel { height:34px; border-radius:8px; margin:6px 16px;
  background:linear-gradient(90deg, rgba(128,128,128,.10), rgba(128,128,128,.18), rgba(128,128,128,.10));
  background-size:200% 100%; animation:pc-shimmer 1.3s ease-in-out infinite; }
@keyframes pc-shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
.pc-spin { width:11px; height:11px; border-radius:999px; border:2px solid currentColor;
  border-right-color:transparent; display:inline-block; animation:pc-spin .7s linear infinite;
  vertical-align:-1px; flex:none; }
@keyframes pc-spin { to { transform:rotate(360deg) } }
.pc-sub-item { display:flex; align-items:center; gap:10px; padding:10px 16px;
  border-bottom:1px solid var(--dsw-border,rgba(128,128,128,.10)); }
.pc-sub-item:last-child { border-bottom:0; }
.pc-sub-item > div:first-child { min-width:0; flex:1 1 auto; }
.pc-sub-item > .pc-btn { flex:none; }
/* Narrow: drop the two version tracks. Name, status and actions keep their
   alignment, so the grid still reads as a grid. */
@media (max-width:720px) {
  .pc-row { grid-template-columns:minmax(0,1fr) 116px 132px; gap:10px; }
  .pc-row .pc-col-opt { display:none; }
}
`;

		function ensureStyles() {
			if (typeof document === 'undefined') return () => {};
			if (document.getElementById(STYLE_ID)) return () => {};
			const el = document.createElement('style');
			el.id = STYLE_ID;
			el.textContent = CSS;
			document.head.appendChild(el);
			return () => {
				const node = document.getElementById(STYLE_ID);
				if (node) node.remove();
			};
		}

		// ───────────────────────────── 小组件 ─────────────────────────────
		/**
		 * What to show in the "latest" column.
		 *
		 * Registry packages have a published version. Path and git packages do not
		 * — a git checkout's newest artefact is a commit — so showing a raw sha here
		 * read as if `c6c0ad3f…` were a version number. Shorten it and mark it, so
		 * the column cannot be mistaken for a version that failed to resolve.
		 *
		 * @param {object} plugin - row from the Host.
		 * @param {(key:string, vars?:object)=>string} t - translator.
		 * @returns {string} cell text.
		 */
		function latestCell(plugin, t) {
			const update = plugin.update ?? {};
			if (update.latest) return update.latest;
			if (typeof update.latestCommit === 'string' && update.latestCommit.length > 0) {
				return `${update.latestCommit.slice(0, 8)}`;
			}
			if (plugin.kind === 'git' || plugin.kind === 'path') return t('noVersionUpstream');
			return '—';
		}

		/**
		 * The exact command a user runs to upgrade this plugin by hand.
		 *
		 * Self-upgrade is refused server-side, so this string is the whole remedy.
		 * Deriving it from the row (rather than hardcoding) keeps the pinned commit
		 * and the remote URL in sync with what the Host actually recorded.
		 *
		 * @param {object} plugin - row from the Host.
		 * @returns {string} a copy-pasteable command.
		 */
		function selfUpgradeCommand(plugin) {
			const update = plugin.update ?? {};
			const slug = update.slug ?? 'owner/repo';
			const commit = update.latestCommit ?? update.pinned ?? '<commit>';
			return `cd ~/.dsh/profiles/desktop && pnpm add "github:${slug}#${commit}" --save-exact`;
		}

		const STATUS_KEY = {
			current: 'statusCurrent',
			updatable: 'statusUpdatable',
			'behind-upstream': 'statusBehindUpstream',
			disabled: 'statusDisabled',
			missing: 'statusMissing',
			untracked: 'statusUntracked',
			unsupported: 'statusUnsupported',
			// 本插件自己落后时不能自我升级，用独立状态说明，而不是「可更新」+没按钮
			'self-update': 'statusSelfUpdate',
			// Distinguished from `unsupported`: the spec is fine and the plugin is
			// subscribed, but the remote could not be read just now. Collapsing the
			// two told users their setup was broken when the network was.
			unreachable: 'statusUnreachable',
		};

		const RESTORE_KEY = {
			installed: 'statusInstalled',
			'installed-restart': 'statusInstalledRestart',
			already: 'statusAlready',
			planned: 'statusPlanned',
			manual: 'statusManual',
			unresolved: 'statusUnresolved',
			failed: 'statusFailed',
		};

		function Badge({ status, t }) {
			const key = STATUS_KEY[status] ?? 'statusUnsupported';
			return h('span', { className: `pc-badge ${status}` },
				h('span', { className: 'pc-dot' }), t(key));
		}

		function Spinner() {
			return h('span', { className: 'pc-spin' });
		}

		function Card({ title, extra, children }) {
			return h('div', { className: 'pc-card' },
				title ? h('div', { className: 'pc-card-head' },
					h('div', { className: 'pc-card-title' }, title),
					h('div', { className: 'pc-spacer' }),
					extra ?? null) : null,
				children);
		}

		function Skeleton({ rows = 3 }) {
			return h('div', { style: { padding: '6px 0' } },
				Array.from({ length: rows }, (_, i) => h('div', { key: i, className: 'pc-skel' })));
		}

		/** Human elapsed time: seconds below a minute, then m:ss. */
		function elapsedText(ms) {
			if (!Number.isFinite(ms) || ms < 0) return '0s';
			const total = Math.round(ms / 1000);
			if (total < 60) return `${total}s`;
			return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
		}

		/**
		 * Live progress for a running upgrade.
		 *
		 * Shows the real pipeline steps rather than an indeterminate bar: the user
		 * can see that it is on "执行 pnpm 安装" and has been for 20 seconds, which
		 * is the difference between "it is working" and "it is stuck".
		 *
		 * @param {object} props
		 */
		function JobProgress({ t, job, onCancel }) {
			const steps = Array.isArray(job.steps) ? job.steps : [];
			const current = job.current;
			const running = job.status === 'running';
			return h('div', { className: 'pc-job' },
				h('div', { className: 'pc-job-head' },
					running ? h(Spinner) : null,
					h('span', { className: 'pc-job-title' },
						t('jobProgress', { done: job.index + 1, total: job.total })),
					h('span', { className: 'pc-job-elapsed' }, elapsedText(job.elapsedMs)),
					running && typeof onCancel === 'function'
						? h('button', {
							className: 'pc-btn sm',
							disabled: job.phase === 'cancelling',
							onClick: onCancel,
						}, job.phase === 'cancelling' ? t('cancelling') : t('cancel'))
						: null),
				job.names.length > 1
					? h('div', { className: 'pc-job-sub' }, job.names.join('、'))
					: null,
				h('ol', { className: 'pc-steps' }, steps.map((step) => {
					const done = job.completedSteps !== undefined
						? job.completedSteps.includes(step.id)
						: false;
					const active = step.id === current;
					return h('li', {
						key: step.id,
						className: `pc-step${active ? ' on' : ''}${done ? ' done' : ''}`,
					},
						h('span', { className: 'pc-step-dot' }),
						h('span', { className: 'pc-step-label' }, step.label));
				})),
				Array.isArray(job.errors) && job.errors.length > 0
					? h('div', { className: 'pc-job-err' }, job.errors.join('；'))
					: null);
		}

		// ───────────────────────────── 插件页 ─────────────────────────────
		function PluginsPanel({ t, lang, refreshToken }) {
			const [data, setData] = useState(null);
			const [busy, setBusy] = useState(null);
			const [error, setError] = useState(null);
			const [notice, setNotice] = useState(null);
			/** Live upgrade job: its steps and elapsed time render while it runs. */
			const [job, setJob] = useState(null);

			const load = useCallback(async (refresh) => {
				try {
					setError(null);
					const res = await fetch(api(`/plugins${refresh ? '' : '?refresh=0'}`), { credentials: 'same-origin' });
					const body = await res.json();
					if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
					setData(body);
				} catch (e) {
					setError(errorText(t, e?.message ?? e));
				}
			}, [t]);

			useEffect(() => { load(true); }, [load, refreshToken]);

			const rows = data?.plugins ?? [];
			const updatable = useMemo(
				() => rows.filter((r) => r.update?.updateAvailable === true && r.name !== data?.selfName).map((r) => r.name),
				[rows, data]);

			/**
			 * Summarise a batch result from the Host.
			 *
			 * `restartRequired` is authoritative: the manager applies an install
			 * live when HMR is available and says `applied`, so telling the user to
			 * restart in that case would be wrong. Partial failure keeps the
			 * successes visible instead of collapsing everything into one error.
			 *
			 * @param {object} body - Host response with `results` and `restartRequired`.
			 * @param {string} failedKey - label for the failure prefix.
			 * @param {string} doneKey - success template for the moved names.
			 */
			const reportBatch = (body, failedText, doneText) => {
				const results = body?.results ?? [];
				const failed = results.filter((r) => r.ok !== true);
				const moved = results.filter((r) => r.ok === true && r.unchanged !== true);
				if (failed.length > 0) {
					setError(`${failedText}：${failed.map((r) => {
						// The Host sends a machine code next to the message; the code
						// is what can be translated. A structured blocker list beats
						// even that, because it renders as phrases rather than a sentence.
						const why = Array.isArray(r.blockedBy) && r.blockedBy.length > 0
							? blockerText(t, r.blockedBy).join('、')
							: errorText(t, r.errorCode ?? r.error);
						return `${r.name}（${why}）`;
					}).join('；')}`);
				}
				if (failed.length > 0 && moved.length === 0) return;
				if (moved.length === 0) {
					setNotice(t('upToDate'));
					return;
				}
				// A batch where some moved and some did not is still a success for the
				// ones that moved; say which, so the list cannot look silently wrong.
				setNotice(doneText({
					names: moved.map((r) => r.name).join('、'),
					restart: body?.restartRequired === true ? t('restartSuffix') : t('liveSuffix'),
				}));
			};

			/**
			 * Poll a running upgrade job until it settles.
			 *
			 * Polls at 400ms: fast enough that a short step is not skipped over,
			 * slow enough that a 30-second pnpm run does not hammer the host. The
			 * job id comes back with the start response, so a page reload during an
			 * upgrade can pick the job back up.
			 *
			 * @param {string} id - job id.
			 * @param {(job:object)=>void} onUpdate - called on every snapshot.
			 * @returns {Promise<object|null>} the final snapshot, or null if lost.
			 */
			const pollJob = useCallback(async (id, onUpdate) => {
				const POLL_MS = 400;
				for (;;) {
					await new Promise((resolve) => { setTimeout(resolve, POLL_MS); });
					let body;
					try {
						const res = await fetch(api(`/job?id=${encodeURIComponent(id)}`), { credentials: 'same-origin' });
						body = await res.json();
						if (!res.ok) return null;
					} catch {
						// A dropped poll is not a failed job: give up quietly and let the
						// caller reload, rather than reporting a phantom error.
						return null;
					}
					const job = body.job;
					if (job === undefined) return null;
					onUpdate(job);
					if (job.status !== 'running') return job;
				}
			}, []);

			const doUpgrade = useCallback(async (names) => {
				if (names.length === 0) return;
				setBusy('upgrade'); setError(null); setNotice(null); setJob(null);
				try {
					const res = await fetch(api('/upgrade'), {
						method: 'POST', credentials: 'same-origin',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ names }),
					});
					const body = await res.json();
					if (res.status === 409 && body?.job) {
						// Another upgrade is already running: adopt it instead of
						// starting a second pnpm run against the same profile.
						setJob(body.job);
						const final = await pollJob(body.job.id, setJob);
						if (final !== null) reportBatch(final, t('upgradeFailed'), (vars) => t('upgradeDone', vars));
						await load(true);
						return;
					}
					if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
					setJob(body.job ?? null);
					const final = await pollJob(body.job.id, setJob);
					if (final === null) {
						setError(t('jobLost'));
						await load(true);
						return;
					}
					reportBatch(final, t('upgradeFailed'), (vars) => t('upgradeDone', vars));
					await load(true);
				} catch (e) {
					setError(errorText(t, e?.message ?? e));
				} finally { setBusy(null); setJob(null); }
			}, [load, t, lang, pollJob]);

			/**
			 * Ask the running job to stop.
			 *
			 * Cancellation lands between steps, never mid-install: killing pnpm
			 * halfway is how a manifest ends up without its dependency entry. So the
			 * button disables itself and the phase flips to "cancelling" while the
			 * current step finishes.
			 */
			const doCancel = useCallback(async () => {
				try {
					const res = await fetch(api('/cancel'), {
						method: 'POST', credentials: 'same-origin',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({}),
					});
					const body = await res.json();
					if (body?.job) setJob(body.job);
				} catch { /* the poll will surface the outcome */ }
			}, []);

			const doSubscribe = useCallback(async (names) => {
				if (names.length === 0) return;
				setBusy('subscribe'); setError(null); setNotice(null); setJob(null);
				try {
					const res = await fetch(api('/subscribe'), {
						method: 'POST', credentials: 'same-origin',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ names }),
					});
					const body = await res.json();
					// 409 carries the job that is already running: adopt it rather than
					// starting a second pnpm run against the same profile.
					if (res.status === 409 && body?.job) {
						setJob(body.job);
						const final = await pollJob(body.job.id, setJob);
						if (final !== null) reportBatch(final, t('subscribeFailed'), (vars) => t('subscribeDone', vars));
						await load(true);
						return;
					}
					if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
					setJob(body.job ?? null);
					// Subscribing runs several git commands and then pnpm, so it is a
					// job like an upgrade: poll it so the panel shows which step is
					// running instead of an opaque spinner.
					const final = await pollJob(body.job.id, setJob);
					if (final === null) {
						setError(t('jobLost'));
						await load(true);
						return;
					}
					reportBatch(final, t('subscribeFailed'), (vars) => t('subscribeDone', vars));
					await load(true);
				} catch (e) {
					setError(errorText(t, e?.message ?? e));
				} finally { setBusy(null); setJob(null); }
			}, [load, t, lang, pollJob]);

			const kindLabel = (p) => {
				if (p.kind === 'path') return t('nodeLocal');
				if (p.kind === 'git') return t('nodeGit');
				return t('nodeRegistry');
			};

			// One cell class per column, shared by the header and every row, so a
			// column cannot drift out of alignment when a row has fewer controls.
			const head = h('div', { className: 'pc-row head' },
				h('div', { className: 'pc-c-name' }, t('colName')),
				h('div', { className: 'pc-c-ver pc-col-opt' }, t('colVersion')),
				h('div', { className: 'pc-c-ver pc-col-opt' }, t('colLatest')),
				h('div', { className: 'pc-c-status' }, t('colStatus')),
				h('div', { className: 'pc-c-act' }, t('colActions')));

			let body;
			if (data === null) body = h(Skeleton, { rows: 5 });
			else if (rows.length === 0) body = h('div', { className: 'pc-empty' }, t('noPlugins'));
			else body = h('div', {}, head, ...rows.map((p) => {
				const isUpdatable = p.update?.updateAvailable === true;
				// Registry packages and git dependencies are both upgradable — a
				// subscribed plugin whose upstream moved on is exactly the case this
				// tab exists for. Restricting the button to `registry` left a git row
				// showing "可更新" with nothing to click.
				const upgradableKind = p.kind === 'registry' || p.kind === 'git';
				const canUpgrade = isUpdatable && upgradableKind && p.name !== data.selfName;
				// This plugin cannot upgrade itself: the install would replace the code
				// handling the request, and Windows refuses to rename over a directory
				// the running host holds open. The Host reports that as its own status
				// (`self-update`) so the badge itself says what to do — a "可更新" badge
				// with no button is indistinguishable from a broken tab.
				const selfUpdatable = p.status === 'self-update'
					|| (isUpdatable && p.name === data.selfName && p.kind !== 'path');
				const canSubscribe = p.kind === 'path'
					&& (data.subscriptions ?? []).some((s) => s.name === p.name && s.ready);
				// Newer Hosts split the locale-mapped title into titleZh / titleEn;
				// an older module generation still sends the map itself. textOf
				// accepts both, so the row never degrades to `[object Object]`.
				const rawTitle = p.title
					?? (lang === 'zh' ? (p.titleZh ?? p.titleEn) : (p.titleEn ?? p.titleZh));
				const meta = [
					textOf(rawTitle, lang),
					textOf(p.description, lang),
					kindLabel(p),
				].filter(Boolean).join(' · ');
				return h('div', { key: p.name, className: 'pc-row' },
					h('div', { className: 'pc-c-name' },
						h('div', { className: 'pc-name-main', title: p.name },
							p.name,
							p.name === data.selfName
								? h('span', { className: 'pc-chip', style: { marginLeft: 6 } }, t('switchPlugin'))
								: null),
						h('div', { className: 'pc-name-meta', title: meta }, meta)),
					h('div', { className: 'pc-c-ver pc-col-opt' },
						h('span', { className: 'pc-ver' }, p.version ?? '—')),
					h('div', { className: 'pc-c-ver pc-col-opt' },
						h('span', {
							className: 'pc-ver',
							style: isUpdatable ? { color: '#3d8ee0', fontWeight: 600 } : undefined,
							// A git dependency has no published version: its newest
							// artefact is a commit. Show the short sha in that column
							// instead of a 40-character blob that reads like a version
							// number but cannot be compared with one.
							title: p.update?.latestCommit ?? undefined,
						}, latestCell(p, t))),
					h('div', { className: 'pc-c-status' },
						h(Badge, { status: p.status, t }),
						isUpdatable && p.update?.behind > 0
							? h('div', { className: 'pc-muted' }, t('behindN', { n: p.update.behind }))
							: null),
					h('div', { className: 'pc-c-act' },
						canUpgrade
							? h('button', {
								className: 'pc-btn sm primary',
								disabled: busy !== null,
								onClick: () => doUpgrade([p.name]),
							}, busy === 'upgrade' ? h(Spinner) : t('upgrade'))
							: null,
						// A dead "可更新" badge with no button and no reason is worse than
						// A dead badge with no way forward is worse than no badge: the
						// user cannot tell whether the tab is broken or the plugin is
						// simply special. Show the exact command instead.
						selfUpdatable
							? h('span', {
								className: 'pc-muted pc-self-update',
								title: t('selfUpgradeHint'),
								// Clicking copies the command, so "需手动升级" is actionable
								// rather than a dead end.
								onClick: (event) => {
									const text = selfUpgradeCommand(p);
									try {
										void navigator.clipboard?.writeText?.(text);
										event.currentTarget.textContent = t('selfUpgradeCopied');
										setTimeout(() => { event.currentTarget.textContent = t('selfUpgradeNote'); }, 1500);
									} catch { /* clipboard unavailable: the title still explains */ }
								},
							}, t('selfUpgradeNote'))
							: null,
						canSubscribe
							? h('button', {
								className: 'pc-btn sm',
								disabled: busy !== null,
								title: t('subscribeHint'),
								onClick: () => doSubscribe([p.name]),
							}, busy === 'subscribe' ? h(Spinner) : t('subscribe'))
							: null));
			}));

			const blockedSubs = (data?.subscriptions ?? []).filter((s) => !s.ready && s.name !== data?.selfName);

			return h('div', { className: 'pc-root' },
				error ? h('div', { className: 'pc-note err' }, error) : null,
				notice ? h('div', { className: 'pc-note ok' }, notice) : null,
				job ? h(JobProgress, { t, job, onCancel: doCancel }) : null,
				h(Card, {
					title: t('sectionPlugins'),
					extra: h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
						data
							? h('span', { className: 'pc-muted' }, t('pluginsSummary', {
								total: rows.length,
								updatable: data.summary?.updatable ?? 0,
								local: data.summary?.local ?? 0,
							}))
							: null,
						updatable.length > 0
							? h('button', {
								className: 'pc-btn sm primary',
								disabled: busy !== null,
								onClick: () => doUpgrade(updatable),
							}, busy === 'upgrade' ? h(Spinner) : t('upgradeAll'))
							: null,
						h('button', {
							className: 'pc-btn sm',
							disabled: busy !== null,
							onClick: () => load(true),
						}, t('checkUpdates'))),
				}, body),
				blockedSubs.length > 0
					? h(Card, { title: t('subscriptionTitle') },
						...blockedSubs.map((s) => h('div', { key: s.name, className: 'pc-sub-item' },
							h('div', { className: 'pc-name', style: { flex: 1 } },
								h('div', { className: 'pc-name-main' }, s.name),
								// Prefer the machine codes so the wording follows the
								// active language; fall back to whatever the Host sent.
								h('div', { className: 'pc-name-meta' }, (() => {
									const translated = blockerText(t, s.blockedBy);
									return (translated.length > 0 ? translated : (s.blockedText ?? [])).join('、');
								})())),
							h('button', { className: 'pc-btn sm', disabled: true }, t('subscribe')))))
					: null,
				data?.updateError
					? h('div', { className: 'pc-note warn' }, `${t('updateCheckFailed')}：${errorText(t, data.updateError)}`)
					: null,
				h('div', { className: 'pc-muted' }, t('restartTip')));
		}

		// ───────────────────────────── 版本页 ─────────────────────────────
		function VersionsPanel({ t, lang, status, refreshToken, onChanged }) {
			const [versions, setVersions] = useState(null);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState(null);
			const [report, setReport] = useState(null);
			const [openVer, setOpenVer] = useState(null);

			const load = useCallback(async () => {
				try {
					setError(null);
					const res = await fetch(api('/versions'), { credentials: 'same-origin' });
					const body = await res.json();
					if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
					setVersions(body.versions ?? []);
				} catch (e) { setError(errorText(t, e?.message ?? e)); }
			}, [t]);

			useEffect(() => { load(); }, [load, refreshToken]);

			const backupNow = useCallback(async () => {
				setBusy(true); setError(null);
				try {
					const res = await fetch(api('/backup'), {
						method: 'POST', credentials: 'same-origin',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ label: 'manual' }),
					});
					const body = await res.json();
					if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
					await load();
					onChanged?.();
				} catch (e) { setError(errorText(t, e?.message ?? e)); }
				finally { setBusy(false); }
			}, [load, t, onChanged]);

			const runRestore = useCallback(async (file, confirm) => {
				setBusy(true); setError(null);
				try {
					const res = await fetch(api('/restore'), {
						method: 'POST', credentials: 'same-origin',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ file, confirm }),
					});
					const body = await res.json();
					if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
					setReport({ file, dryRun: body.dryRun, rows: body.report ?? [], summary: body.summary });
				} catch (e) { setError(errorText(t, e?.message ?? e)); }
				finally { setBusy(false); }
			}, [t]);

			const del = useCallback(async (file) => {
				setBusy(true);
				try {
					await fetch(api('/delete'), {
						method: 'POST', credentials: 'same-origin',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ file }),
					});
					await load();
				} catch (e) { setError(errorText(t, e?.message ?? e)); }
				finally { setBusy(false); }
			}, [load, t]);

			const view = useCallback(async (file) => {
				try {
					const res = await fetch(api(`/version/${encodeURIComponent(file)}`), { credentials: 'same-origin' });
					const body = await res.json();
					if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
					setOpenVer(body.snapshot);
				} catch (e) { setError(errorText(t, e?.message ?? e)); }
			}, [t]);

			const tone = (s) => {
				if (s === 'installed' || s === 'installed-restart' || s === 'already') return '#4a9d5f';
				if (s === 'planned') return '#3d8ee0';
				if (s === 'failed') return '#e06c6c';
				if (s === 'manual' || s === 'unresolved') return '#c9a84c';
				return '#8b95a5';
			};

			let list;
			if (versions === null) list = h(Skeleton, { rows: 3 });
			else if (versions.length === 0) list = h('div', { className: 'pc-empty' }, t('noVersions'));
			else list = versions.map((v) => {
				const s = v.summary ?? {};
				return h('div', { key: v.file, className: 'pc-ver-item' },
					h('div', { className: 'pc-ver-line' },
						h('span', { className: 'pc-ver-label' }, textOf(v.label, lang) || v.file),
						h('span', { className: 'pc-muted' }, ago(t, v.createdAt)),
						h('span', { className: 'pc-muted' }, t('summary', {
							total: s.total ?? 0,
							local: s.local ?? 0,
							disabled: s.disabled ?? 0,
						})),
						h('span', { className: 'pc-chip' }, v.storedAt === 'cloud' ? t('both') : t('local')),
						v.reasonDetail ? h('span', { className: 'pc-chip' }, v.reasonDetail) : null,
						// The action group floats right as one block, so its buttons
						// stay a single vertically-centred row regardless of how many
						// metadata chips preceded it.
						h('span', { style: { flex: 1 } }),
						h('span', { className: 'pc-ver-actions' },
							h('button', { className: 'pc-btn sm', onClick: () => view(v.file), disabled: busy }, t('details')),
							h('button', { className: 'pc-btn sm', onClick: () => runRestore(v.file, false), disabled: busy }, t('check')),
							h('button', { className: 'pc-btn sm', onClick: () => runRestore(v.file, true), disabled: busy }, t('restore')),
							h('button', { className: 'pc-btn sm danger', onClick: () => del(v.file), disabled: busy }, t('del')))));
			});

			const reportBlock = report && h(Card, {
				title: `${t('report')} — ${report.dryRun ? t('dryRun') : t('realRun')}`,
			}, h('div', { className: 'pc-card-body' },
				report.rows.map((r, i) => h('div', { key: i, style: { fontSize: 12, marginTop: i === 0 ? 0 : 4 } },
					h('span', { style: { color: tone(r.status), fontWeight: 600, marginRight: 8 } },
						t(RESTORE_KEY[r.status] ?? 'statusPending')),
					h('span', { style: { fontWeight: 500, marginRight: 8 } }, r.name ?? r.action),
					h('span', { className: 'pc-muted' }, String(r.detail ?? '').slice(0, 240)))),
				report.dryRun
					? h('button', {
						className: 'pc-btn primary',
						style: { marginTop: 10 },
						disabled: busy,
						onClick: () => runRestore(report.file, true),
					}, t('confirm'))
					: null));

			const detailBlock = openVer && h(Card, {
				title: textOf(openVer.label, lang) || '',
				extra: h('button', { className: 'pc-btn sm', onClick: () => setOpenVer(null) }, t('close')),
			}, h('div', { className: 'pc-card-body' },
				h('div', { className: 'pc-muted', style: { marginBottom: 8 } },
					`${t('order')}: ${(openVer.bundleOrder ?? []).join(' → ')}`),
				(openVer.plugins ?? []).map((p) => h('div', { key: p.name, style: { fontSize: 12, marginTop: 3 } },
					h('span', { style: { fontWeight: 500, marginRight: 8 } }, p.name),
					h('span', { className: 'pc-muted' },
						`${p.version ?? p.spec ?? ''}${p.git ? ` @ ${p.git.short}` : ''}${p.enabled === false ? ` · ${t('disabledTag')}` : ''}`)))));

			return h('div', { className: 'pc-root' },
				error ? h('div', { className: 'pc-note err' }, error) : null,
				h(Card, {
					title: t('versions'),
					extra: h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
						status?.lastPush
							? h('span', { className: 'pc-muted' },
								`${t('lastPush')}: ${ago(t, status.lastPush.at)} · ${status.lastPush.where === 'cloud' ? t('cloudBadge') : t('local')}`)
							: null,
						h('button', { className: 'pc-btn sm primary', onClick: backupNow, disabled: busy },
							busy ? h(Spinner) : t('backupNow'))),
				}, list),
				reportBlock,
				detailBlock);
		}

		// ───────────────────────────── 设置页 ─────────────────────────────
		function SettingsPanel({ t, status, onSaved }) {
			const [cfg, setCfg] = useState(null);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState(null);
			const [notice, setNotice] = useState(null);

			useEffect(() => {
				if (!status) return;
				setCfg((c) => c ?? {
					repo: status.config.repo ?? '',
					tokenRef: status.config.tokenRef ?? 'GITHUB_TOKEN',
					autoBackup: status.config.autoBackup !== false,
					autoPushOnChange: status.config.autoPushOnChange !== false,
					intervalHours: status.config.intervalHours ?? 6,
					maxSnapshots: status.config.maxSnapshots ?? 50,
				});
			}, [status]);

			const save = useCallback(async () => {
				if (!cfg) return;
				setBusy(true); setError(null); setNotice(null);
				try {
					const res = await fetch(api('/config'), {
						method: 'POST', credentials: 'same-origin',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(cfg),
					});
					const body = await res.json();
					if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
					if (cfg.token) {
						const tr = await fetch(api('/token'), {
							method: 'POST', credentials: 'same-origin',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ value: cfg.token, ref: cfg.tokenRef }),
						});
						const tb = await tr.json();
						if (!tr.ok) throw new Error(tb.error ?? `HTTP ${tr.status}`);
					}
					if (cfg.repo) {
						const vr = await fetch(api('/verify'), {
							method: 'POST', credentials: 'same-origin',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ repo: cfg.repo }),
						});
						const vb = await vr.json();
						if (!vr.ok) throw new Error(vb.error ?? `HTTP ${vr.status}`);
						if (vb.repo && vb.repo.private !== true) setError(t('public'));
					}
					setCfg((c) => ({ ...c, token: '' }));
					setNotice(t('saved'));
					onSaved?.();
				} catch (e) { setError(errorText(t, e?.message ?? e)); }
				finally { setBusy(false); }
			}, [cfg, t, onSaved]);

			const cloudLine = (() => {
				if (!status) return h('span', { className: 'pc-muted' }, '…');
				const c = status.cloud ?? {};
				if (!c.ready) return h('span', { className: 'pc-muted' }, t('needsConfig'));
				if (c.error) return h('span', { style: { color: '#c9a84c', fontSize: 12 } }, `${t('unreachable')}：${errorText(t, c.error)}`);
				if (c.isPrivate === false) return h('span', { style: { color: '#e06c6c', fontSize: 12, fontWeight: 600 } }, t('public'));
				return h('span', { className: 'pc-badge current' },
					h('span', { className: 'pc-dot' }), `${t('reachable')} · ${c.repo} · ${t('private')}`);
			})();

			if (!cfg) return h('div', { className: 'pc-root' }, h(Skeleton, { rows: 4 }));

			return h('div', { className: 'pc-root' },
				error ? h('div', { className: 'pc-note err' }, error) : null,
				notice ? h('div', { className: 'pc-note ok' }, notice) : null,
				h(Card, { title: t('cloud'), extra: cloudLine },
					h('div', { className: 'pc-card-body', style: { display: 'grid', gap: 12 } },
						h('div', { className: 'pc-field' },
							h('span', { className: 'pc-label' }, t('repo')),
							h('input', {
								className: 'pc-input',
								style: { flex: '1 1 220px' },
								value: cfg.repo,
								placeholder: t('emptyRepo'),
								onChange: (e) => setCfg({ ...cfg, repo: e.target.value }),
							}),
							h('span', { className: 'pc-label' }, t('tokenRef')),
							h('input', {
								className: 'pc-input',
								style: { width: 150 },
								value: cfg.tokenRef,
								onChange: (e) => setCfg({ ...cfg, tokenRef: e.target.value }),
							})),
						h('div', { className: 'pc-field' },
							h('span', { className: 'pc-label' }, t('token')),
							h('input', {
								className: 'pc-input',
								style: { flex: '1 1 260px' },
								type: 'password',
								value: cfg.token ?? '',
								placeholder: status?.token?.configured ? t('tokenSet') : t('tokenHint'),
								onChange: (e) => setCfg({ ...cfg, token: e.target.value }),
							}),
							status?.token?.configured
								? h('span', { className: 'pc-badge current' }, h('span', { className: 'pc-dot' }), status.token.ref)
								: null),
						h('div', { className: 'pc-field' },
							h('label', { className: 'pc-label', style: { display: 'flex', alignItems: 'center', gap: 6 } },
								h('input', {
									type: 'checkbox',
									checked: cfg.autoBackup !== false,
									onChange: (e) => setCfg({ ...cfg, autoBackup: e.target.checked }),
								}), t('auto')),
							h('span', { className: 'pc-label' }, t('interval')),
							h('input', {
								className: 'pc-input', type: 'number', min: 0, max: 168, style: { width: 76 },
								value: cfg.intervalHours ?? 6,
								onChange: (e) => setCfg({ ...cfg, intervalHours: Number(e.target.value) }),
							}),
							h('span', { className: 'pc-label' }, t('keep')),
							h('input', {
								className: 'pc-input', type: 'number', min: 1, max: 500, style: { width: 76 },
								value: cfg.maxSnapshots ?? 50,
								onChange: (e) => setCfg({ ...cfg, maxSnapshots: Number(e.target.value) }),
							})),
						h('div', { className: 'pc-field' },
							h('label', { className: 'pc-label', style: { display: 'flex', alignItems: 'center', gap: 6 } },
								h('input', {
									type: 'checkbox',
									checked: cfg.autoPushOnChange !== false,
									onChange: (e) => setCfg({ ...cfg, autoPushOnChange: e.target.checked }),
								}), t('autoChange')),
							h('span', { className: 'pc-muted' }, t('autoChangeHint'))),
						h('div', { className: 'pc-field' },
							h('button', { className: 'pc-btn primary', onClick: save, disabled: busy },
								busy ? h(Spinner) : t('saveCfg')),
							status?.lastPush
								? h('span', { className: 'pc-muted' },
									`${t('lastPush')}: ${ago(t, status.lastPush.at)} · ${status.lastPush.where === 'cloud' ? t('cloudBadge') : t('local')}${status.lastPush.error ? ` · ${errorText(t, status.lastPush.error)}` : ''}`)
								: null,
							status?.lastChange
								? h('span', { className: 'pc-muted' },
									`${t('lastChange')}: ${ago(t, status.lastChange.at)}`)
								: null))));
		}

		// ───────────────────────────── 入口 ─────────────────────────────
		function Cloud(props) {
			useLocaleRevision(props.locale);
			const t = props.t;
			// Active language for locale maps coming from the Host (package
			// titles/descriptions are `{zh, en}` objects, not strings).
			const lang = activeLocaleId(props.locale).toLowerCase().startsWith('zh') ? 'zh' : 'en';
			const [tab, setTab] = useState('plugins');
			const [status, setStatus] = useState(null);
			const [tick, setTick] = useState(0);

			const loadStatus = useCallback(async () => {
				try {
					const res = await fetch(api('/status'), { credentials: 'same-origin' });
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					setStatus(await res.json());
				} catch { /* 各面板各自报告具体错误 */ }
			}, []);

			useEffect(() => { loadStatus(); }, [loadStatus, tick]);

			const bump = useCallback(() => setTick((v) => v + 1), []);

			const tabBtn = (id, label) => h('button', {
				key: id,
				className: `pc-tab${tab === id ? ' on' : ''}`,
				onClick: () => setTab(id),
			}, label);

			return h('div', { className: 'pc-root' },
				h('div', { className: 'pc-hero' },
					h('div', { className: 'pc-hero-top' },
						h('div', null,
							h('div', { className: 'pc-title' }, t('title')),
							h('div', { className: 'pc-sub' }, t('subtitle'))),
						h('div', { className: 'pc-spacer' }),
						h('div', { className: 'pc-tabs' },
							tabBtn('plugins', t('sectionPlugins')),
							tabBtn('versions', t('sectionVersions')),
							tabBtn('settings', t('sectionSettings'))))),
				tab === 'plugins' ? h(PluginsPanel, { t, lang, refreshToken: tick }) : null,
				tab === 'versions' ? h(VersionsPanel, { t, lang, status, refreshToken: tick, onChanged: bump }) : null,
				tab === 'settings' ? h(SettingsPanel, { t, status, onSaved: bump }) : null);
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				ctx.effect(() => ensureStyles(), 'plugin-cloud: styles');
				const locale = ctx.get('locale', false);
				const active = () => activeLocaleId(locale);
				let bound;
				if (locale !== undefined && locale !== null) {
					try {
						ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'plugin-cloud: locale');
						if (typeof locale.bind === 'function') bound = locale.bind(NS);
					} catch (error) {
						console.warn('[plugin-cloud] locale 服务不可用，回落本地字典', error);
					}
				}
				const t = makeT(bound, active);

				ctx.slots.inject('plugins.tab', () => ctx.slots.register({
					name: 'plugins.tab',
					id: 'plugin-cloud',
					order: 3,
					label: () => t('tab'),
				}, (props) => h(Cloud, { ...props, t, locale })));
			},
		};
	},
});

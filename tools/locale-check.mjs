/**
 * 用真实的 locale 服务语义驱动 client.js，验证中文文案能被选中。
 *
 * 关键约定全部照抄 dsh-client-locale/lib/client.js（已从 app.asar 中提取核对）：
 *  - getLocale() 返回 { active, locales, revision }
 *  - register(ns, {zh, en}) 同一 locale 重复注册会抛错，返回 disposer
 *  - bind(ns) 返回 (key, params) => translate，params 是单个对象
 *  - translate 对字典值调用 .replace()，所以值必须是字符串而不是函数
 *  - subscribe(fn) 返回 unsubscribe
 *
 * Run: node tools/locale-check.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** 最小 locale 运行时，语义对齐官方实现。 */
function createLocale({ active = 'zh' } = {}) {
	const dicts = new Map();
	const bound = new Map();
	const listeners = new Set();
	let snapshot = { active, locales: ['zh', 'en'], revision: 0 };
	const chain = () => (snapshot.active === 'zh' ? ['zh', 'en'] : ['en']);
	const publish = () => {
		snapshot = { ...snapshot, revision: snapshot.revision + 1 };
		for (const fn of listeners) fn();
	};
	return {
		getLocale: () => snapshot,
		subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
		register(ns, localeOrDicts, dict) {
			const pairs = typeof localeOrDicts === 'string' ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts);
			let locales = dicts.get(ns);
			if (!locales) { locales = new Map(); dicts.set(ns, locales); }
			for (const [locale] of pairs) if (locales.has(locale)) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`);
			for (const [locale, entries] of pairs) {
				for (const [k, v] of Object.entries(entries)) {
					if (typeof v !== 'string') throw new Error(`字典值必须是字符串：${ns}/${locale}/${k} 是 ${typeof v}`);
				}
				locales.set(locale, entries);
			}
			publish();
			return () => { for (const [locale] of pairs) locales.delete(locale); publish(); };
		},
		bind(ns) {
			if (!bound.has(ns)) bound.set(ns, (key, params) => {
				const template = chain().map((l) => dicts.get(ns)?.get(l)?.[key]).find((v) => v !== undefined) ?? key;
				if (!params) return template;
				return template.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
			});
			return bound.get(ns);
		},
		setLocale(next) { snapshot = { ...snapshot, active: next }; publish(); },
	};
}

/** 在隔离 VM 里加载 client.js，取回 factory。 */
function loadFactory() {
	let factory;
	const sandbox = {
		window: { __ModuleLoader__: { load: (def) => { factory = def.factory; } } },
		document: {
			baseURI: 'http://127.0.0.1:5522/',
			// ensureStyles 会碰 document；这里给一个不落地的实现。
			getElementById: () => null,
			createElement: () => ({ set textContent(v) { this._t = v; }, get textContent() { return this._t; } }),
			head: { appendChild: () => {} },
		},
		console,
		fetch: async () => ({ ok: false, status: 599, json: async () => ({}) }),
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: 'client.js' });
	if (!factory) throw new Error('client.js 没有调用 __ModuleLoader__.load');
	return factory;
}

/** 假 React：组件当普通函数调用，元素当普通对象，便于抽取文本。 */
function createReact() {
	return {
		createElement: (type, props, ...children) => ({
			type,
			props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
		}),
		useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
		useEffect: () => {},
		useCallback: (fn) => fn,
		useMemo: (fn) => fn(),
	};
}

/** apply 插件并拿到注册的 slot。 */
function mount(locale) {
	const registered = [];
	const ctx = {
		get: (n) => (n === 'locale' ? locale : undefined),
		effect: (fn) => fn(),
		slots: {
			inject: (_slot, fn) => fn(),
			register: (meta, Component) => { registered.push({ meta, Component }); return () => {}; },
		},
	};
	const React = createReact();
	const plugin = loadFactory()((id) => {
		if (id === 'react') return React;
		throw new Error(`未预期的 require: ${id}`);
	});
	plugin.apply(ctx);
	return registered[0];
}

/** 递归抽取元素树里的可见文本：函数组件就地调用，等价于最小渲染器。 */
function toText(node) {
	if (node === null || node === undefined || node === false || node === true) return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(toText).join(' ');
	if (typeof node === 'object' && node.props) {
		if (typeof node.type === 'function') return toText(node.type(node.props));
		return toText(node.props.children);
	}
	return '';
}

let passed = 0;
const check = (label, ok, detail = '') => {
	if (ok) { passed++; console.log('  ok  ', label); }
	else { console.error('  FAIL', label, detail); process.exitCode = 1; }
};

// ── 1. 中文环境：tab 与首屏 ─────────────────────────────────
{
	const locale = createLocale({ active: 'zh' });
	const slot = mount(locale);
	check('注册了 plugins.tab', slot?.meta?.name === 'plugins.tab', slot?.meta?.name);
	check('tab id 是 plugin-cloud', slot.meta.id === 'plugin-cloud', slot.meta.id);
	check('tab label 是中文', slot.meta.label() === '插件云', slot.meta.label());

	const text = toText(slot.Component({ locale }));
	check('首屏标题是中文', text.includes('插件云'), text.slice(0, 80));
	check('首屏有三个分区页签',
		text.includes('插件') && text.includes('版本') && text.includes('设置'), text.slice(0, 160));
	check('首屏没有英文残留',
		!/Plugin Cloud|Back up now|Save configuration|Versions|Settings/.test(text), text.slice(0, 200));
	check('首屏显示骨架屏或读取态', text.includes('读取中') || text.includes('插件'), text.slice(0, 120));
}

// ── 2. 英文环境 ─────────────────────────────────────────────
{
	const locale = createLocale({ active: 'en' });
	const slot = mount(locale);
	check('英文 tab label', slot.meta.label() === 'Plugin Cloud', slot.meta.label());
	const text = toText(slot.Component({ locale }));
	check('英文首屏',
		text.includes('Plugin Cloud') && text.includes('Plugins') && text.includes('Settings'),
		text.slice(0, 160));
}

// ── 3. locale 服务整体缺席时回落中文 ────────────────────────
{
	const registered = [];
	const ctx = {
		get: () => undefined,
		effect: (fn) => fn(),
		slots: { inject: (_s, fn) => fn(), register: (m, C) => { registered.push({ meta: m, Component: C }); return () => {}; } },
	};
	const React = createReact();
	const plugin = loadFactory()((id) => {
		if (id === 'react') return React;
		throw new Error(id);
	});
	plugin.apply(ctx);
	check('无 locale 服务时回落中文', registered[0].meta.label() === '插件云', registered[0].meta.label());
	const text = toText(registered[0].Component({}));
	check('无 locale 服务时首屏是中文', text.includes('插件云') && text.includes('设置'), text.slice(0, 120));
}

// ── 4. 字典自洽：键集相等 + 引用与定义完全对应 ──────────────
{
	const clientSrc = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
	/** 取某个字典常量的键集合。 */
	function dictKeys(name) {
		const start = clientSrc.indexOf(`const ${name} = {`);
		if (start < 0) throw new Error(`找不到字典 ${name}`);
		const end = clientSrc.indexOf('\n\t\t};', start);
		const block = clientSrc.slice(start, end);
		return [...block.matchAll(/^\t\t\t([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]);
	}

	const zh = dictKeys('ZH');
	const en = dictKeys('EN');
	check('ZH/EN 键数量一致', zh.length === en.length, `ZH ${zh.length} / EN ${en.length}`);
	const onlyZh = zh.filter((k) => !en.includes(k));
	const onlyEn = en.filter((k) => !zh.includes(k));
	check('没有只在中文里存在的键', onlyZh.length === 0, onlyZh.join(','));
	check('没有只在英文里存在的键', onlyEn.length === 0, onlyEn.join(','));
	check('字典键无重复', new Set(zh).size === zh.length,
		zh.filter((k, i) => zh.indexOf(k) !== i).join(','));

	// 所有被引用的键：静态 t('k')、动态传入 reportBatch 的键名、以及
	// STATUS_KEY / RESTORE_KEY 映射表的值。
	const referenced = new Set();
	for (const m of clientSrc.matchAll(/\bt\('([A-Za-z][A-Za-z0-9]*)'/g)) referenced.add(m[1]);
	// 兜底形式：t(映射[k] ?? 'statusPending')，也是真实引用。
	for (const m of clientSrc.matchAll(/\?\?\s*'([A-Za-z][A-Za-z0-9]*)'\)/g)) referenced.add(m[1]);
	for (const m of clientSrc.matchAll(/reportBatch\(body,\s*'([A-Za-z]+)',\s*'([A-Za-z]+)'\)/g)) {
		referenced.add(m[1]);
		referenced.add(m[2]);
	}
	for (const table of ['STATUS_KEY', 'RESTORE_KEY', 'CODE_KEYS', 'BLOCKER_KEYS']) {
		const at = clientSrc.indexOf(`const ${table} = {`);
		if (at < 0) continue;
		const end = clientSrc.indexOf('\n\t\t};', at);
		// 映射表的 *值* 才是字典键（'already-installed': 'errAlreadyInstalled'）。
		for (const m of clientSrc.slice(at, end).matchAll(/:\s*'([A-Za-z][A-Za-z0-9]*)'/g)) referenced.add(m[1]);
	}
	// 占位符模板里用到的键（t('summary', …) 之类已含在静态匹配内）。

	const missing = [...referenced].filter((k) => !zh.includes(k)).sort();
	check('引用的键在字典里都有定义', missing.length === 0, missing.join(','));
	const dead = zh.filter((k) => !referenced.has(k)).sort();
	check('字典里没有未被引用的死键', dead.length === 0, dead.join(','));
	check('字典规模合理（不少于 60 个键）', zh.length >= 60, String(zh.length));

	// locale 服务路径：注册后按 key 取值，占位符由服务替换。
	const locale = createLocale({ active: 'zh' });
	mount(locale);
	const t = locale.bind('plugin-cloud');
	const rendered = t('summary', { total: 8, local: 5, disabled: 0 });
	check('summary 占位符替换正确', rendered === '8 个插件 · 5 个本地 · 0 个已停用', rendered);
	check('占位符不残留花括号', !rendered.includes('{'), rendered);
	check('behindN 占位符替换正确', t('behindN', { n: 4 }) === '落后 4 个版本', t('behindN', { n: 4 }));
	check('pluginsSummary 占位符替换正确',
		t('pluginsSummary', { total: 7, updatable: 1, local: 4 }) === '7 个插件 · 1 个可更新 · 4 个本地',
		t('pluginsSummary', { total: 7, updatable: 1, local: 4 }));
	check('upgradeDone 带插件名与生效方式',
		t('upgradeDone', { names: 'a、b', restart: '已即时生效' }) === 'a、b 已升级，已即时生效',
		t('upgradeDone', { names: 'a、b', restart: '已即时生效' }));
	// 英文覆盖由上面的「键集相等」保证；逐个键再问一次 locale 是多余的，
	// 而且 never / local / private 这类词中英同形，用「返回值 ≠ 键名」判
	// 缺失会误报，所以不做这种断言。
	const sameAsZh = [...referenced].filter((k) => {
		const zhLocale = createLocale({ active: 'zh' });
		mount(zhLocale);
		const enLocale = createLocale({ active: 'en' });
		mount(enLocale);
		const a = zhLocale.bind('plugin-cloud')(k);
		const b = enLocale.bind('plugin-cloud')(k);
		// 只要求含中文的键在英文下确实换了词，其余键允许同形。
		return /[\u4e00-\u9fff]/.test(a) && a === b;
	});
	check('含中文的键在英文环境下都换了词', sameAsZh.length === 0, sameAsZh.join(','));
}

// ── 5. Host 发的每个错误码，前端都有翻译 ────────────────────
// 后端只发机器码，界面语言只有前端知道；漏一个码就会把 `invalid-repo`
// 这种英文码直接甩到中文界面上。
{
	const hostSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const clientSrc = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
	const codeTable = (() => {
		const at = clientSrc.indexOf('const CODE_KEYS = {');
		if (at < 0) throw new Error('client.js 里没有 CODE_KEYS 映射表');
		return clientSrc.slice(at, clientSrc.indexOf('\n\t\t};', at));
	})();

	// Host 直接写出的错误码字面量。
	const emitted = new Set();
	for (const m of hostSrc.matchAll(/error:\s*"([a-z][a-z0-9-]*)"/g)) emitted.add(m[1]);
	for (const m of hostSrc.matchAll(/new Error\("([a-z][a-z0-9-]*(?:-[a-z0-9-]+)*)"\)/g)) emitted.add(m[1]);
	// 带 payload 的码（`rejected-fields:…`）只登记前缀。
	for (const m of hostSrc.matchAll(/error:\s*`([a-z][a-z0-9-]+):/g)) emitted.add(m[1]);
	// 订阅阻断码走的是 BLOCKER_KEYS，不是 CODE_KEYS。
	const blockerTable = (() => {
		const at = clientSrc.indexOf('const BLOCKER_KEYS = {');
		return at < 0 ? '' : clientSrc.slice(at, clientSrc.indexOf('\n\t\t};', at));
	})();
	const subSrc = readFileSync(new URL('../lib/subscriptions.js', import.meta.url), 'utf8');
	const blockers = new Set([...subSrc.matchAll(/blockedBy\.push\("([a-z-]+)"\)/g)].map((m) => m[1]));
	for (const m of subSrc.matchAll(/blockedBy\.push\(([^)]+)\)/g)) {
		// `remote === null ? "no-remote" : "not-github"` 这类三元形式。
		for (const lit of m[1].matchAll(/"([a-z-]+)"/g)) blockers.add(lit[1]);
	}

	const untranslated = [...emitted].filter((c) => !codeTable.includes(`'${c}'`) && !blockerTable.includes(`'${c}'`));
	check(`Host 的 ${emitted.size} 个错误码都有翻译`, untranslated.length === 0, untranslated.join(','));
	const unblocked = [...blockers].filter((c) => !blockerTable.includes(`'${c}'`) && !codeTable.includes(`'${c}'`));
	check(`订阅阻断码 ${blockers.size} 个都有翻译`, unblocked.length === 0, unblocked.join(','));

	// 映射表的值必须是字典里真实存在的键（否则 t() 会把键名当文案显示）。
	const zhStart = clientSrc.indexOf('const ZH = {');
	const zhKeys = new Set([...clientSrc.slice(zhStart, clientSrc.indexOf('\n\t\t};', zhStart))
		.matchAll(/^\t\t\t([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]));
	const mapped = [...codeTable.matchAll(/:\s*'([A-Za-z][A-Za-z0-9]*)'/g), ...blockerTable.matchAll(/:\s*'([A-Za-z][A-Za-z0-9]*)'/g)]
		.map((m) => m[1]);
	const dangling = mapped.filter((k) => !zhKeys.has(k));
	check('映射表指向的键都存在于字典', dangling.length === 0, dangling.join(','));
}

console.log(`\n${passed} checks passed`);

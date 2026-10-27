/**
 * 元数据渲染的回归测试。
 *
 * 曾经的真实故障：`meta.title` 是 `{zh, en}` 语言映射对象，被直接插进模板
 * 字符串后渲染成 `[object Object]`。这类 bug 只在真实数据里出现，靠读代码
 * 很难发现，所以这里用「Host 真实返回的数据形状」跑一遍渲染，断言输出里
 * 不含对象占位符。
 *
 * Run: node tools/metadata-check.mjs
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { collect } from '../lib/collector.js';

let passed = 0;
const check = (label, ok, detail = '') => {
	if (ok) { passed++; console.log('  ok  ', label); }
	else { console.error('  FAIL', label, detail); process.exitCode = 1; }
};

// ── 一、Host 侧：collector 必须把对象拆成字符串 ─────────────
{
	// A fixture profile: one registry dep, so listBundles' metadata is the only
	// source of title/description and the shape under test is exactly the real one.
	const dir = await mkdtemp(join(tmpdir(), 'pc-meta-'));
	await writeFile(join(dir, 'package.json'), JSON.stringify({
		dependencies: { demo: '^1.2.3' },
		dsh: { profile: { bundles: ['demo'] } },
	}, null, 2), 'utf8');
	const fakeManager = {
		async listBundles() {
			return [{
				name: 'demo',
				version: '1.2.3',
				enabled: true,
				installed: true,
				official: false,
				// 真实的两个形状：description 是字符串，title 是语言映射对象。
				description: '一个插件',
				meta: { title: { zh: '演示插件', en: 'Demo Plugin' } },
			}];
		},
	};
	const withMeta = await collect({ manager: fakeManager, profileDir: dir, profile: 'test', label: 't', note: '' });
	await rm(dir, { recursive: true, force: true });
	const demo = withMeta.plugins.find((p) => p.name === 'demo');
	check('fixture 插件被采集到', demo !== undefined, JSON.stringify(withMeta.plugins.map((p) => p.name)));
	if (demo !== undefined) {
		check('title 被拆成 titleZh', demo.titleZh === '演示插件', String(demo.titleZh));
		check('title 被拆成 titleEn', demo.titleEn === 'Demo Plugin', String(demo.titleEn));
		check('description 保持字符串', demo.description === '一个插件', String(demo.description));
		check('不再输出 title 对象字段', demo.title === undefined, String(demo.title));
	}
	// 所有快照字段都不应该是会被 toString 成 [object Object] 的裸对象。
	const offenders = [];
	for (const p of withMeta.plugins) {
		for (const [k, v] of Object.entries(p)) {
			if (k === 'git') continue; // git 是结构化子对象，前端按字段读
			if (v !== null && typeof v === 'object' && !Array.isArray(v)) offenders.push(`${p.name}.${k}`);
		}
	}
	check('快照没有语言映射对象残留', offenders.length === 0, offenders.join(', '));
}

// ── 二、前端：用真实形状渲染，输出不能有 [object Object] ─────
/** 在隔离 VM 里加载 client.js，取回 factory。fetchMock 驱动数据行渲染。 */
function loadFactory(fetchMock) {
	let factory;
	const sandbox = {
		window: { __ModuleLoader__: { load: (d) => { factory = d.factory; } } },
		document: {
			baseURI: 'http://x/',
			getElementById: () => null,
			createElement: () => ({ textContent: '' }),
			head: { appendChild: () => {} },
		},
		console,
		fetch: fetchMock ?? (async () => ({ ok: false, status: 599, json: async () => ({}) })),
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox, { filename: 'client.js' });
	return factory;
}

function createLocale(active) {
	const dicts = new Map();
	const bound = new Map();
	const listeners = new Set();
	let snapshot = { active, locales: ['zh', 'en'], revision: 0 };
	const chain = () => (snapshot.active === 'zh' ? ['zh', 'en'] : ['en']);
	const publish = () => { snapshot = { ...snapshot, revision: snapshot.revision + 1 }; for (const f of listeners) f(); };
	return {
		getLocale: () => snapshot,
		subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
		register(ns, a, b) {
			const pairs = typeof a === 'string' ? [[a, b]] : Object.entries(a);
			let locales = dicts.get(ns);
			if (!locales) { locales = new Map(); dicts.set(ns, locales); }
			for (const [l, e] of pairs) locales.set(l, e);
			publish();
			return () => {};
		},
		bind(ns) {
			if (!bound.has(ns)) bound.set(ns, (key, params) => {
				const tpl = chain().map((l) => dicts.get(ns)?.get(l)?.[key]).find((v) => v !== undefined) ?? key;
				if (!params) return tpl;
				return tpl.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
			});
			return bound.get(ns);
		},
	};
}

/**
 * 最小可重渲染 React：useState 存真槽位，setter 写回槽位。
 * 组件由 toText 就地调用，所以每次遍历都会读到最新状态。
 * 没有状态槽，面板只会停在 data===null 的骨架屏，测不到数据行。
 */
function createReact() {
	let slots = [];
	let cursor = 0;
	return {
		createElement: (type, props, ...children) => ({
			type,
			props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
		}),
		useState(init) {
			const i = cursor++;
			if (slots[i] === undefined) slots[i] = { value: typeof init === 'function' ? init() : init };
			const slot = slots[i];
			return [slot.value, (next) => {
				slot.value = typeof next === 'function' ? next(slot.value) : next;
			}];
		},
		useEffect(fn) {
			const i = cursor++;
			if (slots[i] === undefined) {
				slots[i] = { done: true };
				try { fn(); } catch { /* mock 的 fetch 不会 reject */ }
			}
		},
		useCallback: (fn) => { cursor++; return fn; },
		useMemo: (fn) => { cursor++; return fn(); },
		/** 遍历一棵树：每轮重置游标，让 hook 槽位按调用顺序对齐。 */
		visit(node) {
			cursor = 0;
			return toText(node);
		},
		/** 换一棵新树时重置全部槽位。 */
		fresh() { slots = []; cursor = 0; },
	};
}

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

/**
 * 遍历渲染直到不再有异步状态写入：每轮 flush 微任务与宏任务，让组件里
 * useEffect 发出的 fetch 兑现并写回状态，下一轮才渲染出数据行。
 */
async function renderUntilSettled(React, node, rounds = 6) {
	let text = '';
	for (let i = 0; i < rounds; i += 1) {
		text = React.visit(node);
		await new Promise((resolve) => setImmediate(resolve));
	}
	return React.visit(node);
}

/** 一行插件，title 是语言映射对象（旧 Host 形状，正是当初出 bug 的形状）。 */
const LEGACY_ROW = {
	name: 'dsh-agent-browser-auto',
	kind: 'path',
	version: '0.1.0',
	enabled: true,
	installed: true,
	official: false,
	description: 'DeepSeek Harness 桌面版的「浏览器眼睛与手」',
	title: { en: 'Agent Browser (Auto)', zh: 'Agent 浏览器（自动）' },
	path: 'C:/Data/deepseek/browser-hands',
};

/** 同一行，Host 已归一化成 titleZh / titleEn（新形状）。 */
const NORMALIZED_ROW = {
	...LEGACY_ROW,
	name: 'dsh-normalized-plugin',
	title: undefined,
	titleZh: '已归一化插件',
	titleEn: 'Normalized Plugin',
};

/** 最恶劣的形状：嵌套对象、缺当前语言、纯数组。 */
const HOSTILE_ROW = {
	name: 'dsh-hostile-plugin',
	kind: 'registry',
	version: '1.0.0',
	enabled: true,
	installed: true,
	official: false,
	description: { deep: { nested: 1 } },
	title: [{ fr: 'Bonjour' }, null],
};

/** 造一个按 URL 分派的 fetch mock。 */
function createFetch(payloads) {
	return async (url) => {
		const path = String(url);
		for (const [key, body] of Object.entries(payloads)) {
			if (path.includes(key)) return { ok: true, status: 200, json: async () => body };
		}
		return { ok: false, status: 404, json: async () => ({ error: 'not-found' }) };
	};
}

function mount(locale, fetchImpl) {
	const registered = [];
	const ctx = {
		get: (n) => (n === 'locale' ? locale : undefined),
		effect: (fn) => fn(),
		slots: { inject: (_s, fn) => fn(), register: (m, C) => { registered.push({ meta: m, Component: C }); return () => {}; } },
	};
	const React = createReact();
	loadFactory(fetchImpl)((id) => { if (id === 'react') return React; throw new Error(id); }).apply(ctx);
	return { slot: registered[0], React };
}

const payloads = {
	'/status': { config: {}, cloud: { ready: false }, token: { configured: false }, auto: {} },
	'/plugins': {
		plugins: [LEGACY_ROW, NORMALIZED_ROW, HOSTILE_ROW],
		subscriptions: [],
		summary: { total: 3, updatable: 0, local: 2 },
		selfName: 'dsh-plugin-cloud',
		updateError: null,
	},
};

// ── 二、前端：真实数据行渲染后不能有对象占位符 ───────────────
for (const lang of ['zh', 'en']) {
	const locale = createLocale(lang);
	const { slot, React } = mount(locale, createFetch(payloads));
	const text = await renderUntilSettled(React, slot.Component({ locale }));

	check(`[${lang}] 数据行已渲染出来`, text.includes('dsh-agent-browser-auto'), text.slice(0, 200));
	check(`[${lang}] 没有 [object Object]`, !text.includes('[object Object]'), (text.match(/.{0,60}object Object.{0,40}/) ?? [''])[0]);
	check(`[${lang}] 没有 [object Array]`, !text.includes('[object Array]'), '');
	check(`[${lang}] 没有 undefined 漏出`, !/\bundefined\b/.test(text), (text.match(/.{0,60}undefined.{0,40}/) ?? [''])[0]);
	check(`[${lang}] 没有 null 漏出`, !/\bnull\b/.test(text), (text.match(/.{0,60}null.{0,40}/) ?? [''])[0]);

	// 旧形状的语言映射必须按当前语言取对的一边。
	if (lang === 'zh') {
		check('[zh] 旧形状 title 取中文', text.includes('Agent 浏览器（自动）'), text.slice(0, 260));
		check('[zh] 归一化 title 取 titleZh', text.includes('已归一化插件'), text.slice(0, 260));
	} else {
		check('[en] 旧形状 title 取英文', text.includes('Agent Browser (Auto)'), text.slice(0, 260));
		check('[en] 归一化 title 取 titleEn', text.includes('Normalized Plugin'), text.slice(0, 260));
	}
	// 嵌套对象行应被降级成空文本，而不是崩或漏出对象。
	check(`[${lang}] 恶劣形状不炸`, text.includes('dsh-hostile-plugin'), text.slice(0, 260));
}

// ── 三、textOf 的行为（从源码里取函数本体，避免重复实现） ────
{
	const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
	const body = src.match(/function textOf\([\s\S]*?\n\t\t\}/);
	if (body === null) {
		check('client.js 里有 textOf', false, '未匹配到函数体');
	} else {
		const { textOf } = await import('data:text/javascript,' + encodeURIComponent(`${body[0]}\nexport { textOf };`));
		check('对象取中文', textOf({ zh: '中文', en: 'English' }, 'zh') === '中文');
		check('对象取英文', textOf({ zh: '中文', en: 'English' }, 'en') === 'English');
		check('字符串原样返回', textOf('纯文本', 'zh') === '纯文本');
		check('null 返回空串', textOf(null, 'zh') === '');
		check('undefined 返回空串', textOf(undefined, 'zh') === '');
		check('数组拼接', textOf(['a', 'b'], 'zh') === 'a · b');
		check('缺当前语言时回落英文', textOf({ en: 'Only English' }, 'zh') === 'Only English');
		check('嵌套对象不会输出 [object Object]',
			!/\[object Object\]/.test(textOf({ zh: { deep: 1 }, en: 'x' }, 'zh')),
			textOf({ zh: { deep: 1 }, en: 'x' }, 'zh'));
		check('全非字符串值的对象返回空串', textOf({ deep: { x: 1 } }, 'zh') === '');
	}
}

console.log(`\n${passed} checks passed`);

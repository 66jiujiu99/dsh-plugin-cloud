# dsh-plugin-cloud · 插件云

**一个插件**，同时做三件事：管插件版本、自动备份整套环境、迁移到另一台机器。

不再需要分开装「升级器 + 备份器 + 迁移器」——它们共享同一份插件清单，
拆开只会让你在两个地方各配一遍。

| 能力 | 说明 |
|---|---|
| **版本管理** | 列出已装插件、当前版本、最新版本、落后几个版本，一键升级 |
| **自动备份** | 定时 + **每次插件变动**（安装 / 卸载 / 启停 / 升级）自动快照 |
| **云端存储** | 快照推到你的 GitHub 私有仓库，换机器一键装回 |
| **订阅线上** | 本地目录插件（`link:`）转为从它的 GitHub 仓库安装，从此能检查更新 |

内部拆成 8 个组件，但**只有一个 bundle，一次安装**：

| 组件 | 文件 | 职责 |
|---|---|---|
| 配置 | `lib/config.js` | 读写 `$DSH_HOME/dsh-plugin-cloud/config.json` |
| 采集 | `lib/collector.js` | 读实时 profile → 可移植快照 |
| 云端 | `lib/github.js` | GitHub Contents API 当存储 |
| 版本库 | `lib/store.js` | 本地镜像 + 云端索引合并 |
| 自动备份 | `lib/autobackup.js` | 定时 + 变更触发 + 指纹去重 |
| 装回 | `lib/restorer.js` | 快照 → 已安装插件集 |
| **版本检查** | `lib/versions.js` | npm registry / git 上游，判断有没有更新 |
| **订阅** | `lib/subscriptions.js` | 本地 checkout → `github:owner/repo#<sha>` |
| **manifest 接缝** | `lib/manifest.js` | 替换已存在的依赖，失败时放回原 entry |

---

## 界面

插件页新增「插件云」标签，三个分区：

**插件** —— 表格列出每个插件的当前版本、最新版本、状态徽标（最新 / 可更新 /
已停用 / 本地未跟踪）、落后几个版本，行内「升级」按钮，顶部「全部升级」。
可订阅的本地插件单列一块，点「转为订阅」一次性切换。

**版本** —— 所有备份快照，含时间、插件数、存于本机还是本机+云端；可预检、装回、删除、查看详情。

**设置** —— 仓库、令牌、自动备份开关、间隔、保留数量、插件变动时自动备份开关。

界面跟随 DSH 语言设置，中英文齐全。

---

## 为什么需要它

一个 profile 的全部真相只有四个文件：

| 文件 | 决定 |
|---|---|
| `package.json` | 装了哪些包 + `dsh.profile.bundles` **加载顺序** |
| `pnpm-lock.yaml` | 每个包的**精确版本** |
| `cordis.patch.yml` | 行级配置 + `disabled` 启停 |
| `pnpm-workspace.yaml` | `allowBuilds` 等策略 |

直接把 `package.json` 拷到新机器会挂：里面是 `^0.4.1` 这样的**范围**，装回来
可能是另一个版本；`link:` 本地插件只记路径、没有内容标识。

本插件把 **精确版本 + bundle 顺序 + 启停状态 + 本地插件 git commit** 一起存成
快照，推到你的私有仓库。

---

## 快照内容

```jsonc
{
  "schema": "dsh-plugin-cloud/1",
  "label": "auto",
  "createdAt": "2026-10-26T04:02:43Z",
  "reasonDetail": "新装插件",          // 这次为什么备份
  "source": { "profile": "desktop", "platform": "win32", "node": "v24.21.0" },
  "bundleOrder": ["@deepseek-ai/dsh-base", "..."],   // 顺序 = 优先级
  "disabledRows": [],
  "plugins": [
    { "name": "dsh-plugin-upgrader", "kind": "registry", "version": "1.2.0", "enabled": true },
    { "name": "dsh-secret-vault", "kind": "path",
      "git": { "commit": "09c10f6…", "remote": "https://github.com/…", "branch": "main", "dirty": false } }
  ],
  "summary": { "total": 6, "registry": 1, "local": 5, "disabled": 0, "dirty": 0 }
}
```

---

## 版本检查怎么判

| 依赖形态 | 检查来源 | 判定 |
|---|---|---|
| `^1.2.3` / `~1.2.3` / `1.2.3` | npm registry packument | 最新**正式版** > 已装版本 |
| `github:o/r` / `git+https://…` | git 上游 | 上游有新提交 |
| `link:C:/…` | 本地 checkout 的 git 上游 | 上游有新提交；无上游则标「本地未跟踪」 |

预发布版（`1.3.0-beta`）**不算更新**——它低于同号的正式版。
`1.2.10 > 1.2.9`：按数字比较，不按字典序。

registry 请求并发上限 6，结果缓存；`refresh=0` 复用缓存，但**缓存为空时不会
假装一切最新**——那会把「没查过」显示成「已是最新」。

---

## 订阅：本地插件怎么转线上

`link:` 依赖在 `pnpm-lock.yaml` 里只记路径，没有内容标识，永远查不出更新。
订阅就是把它改成从它自己的 GitHub 仓库安装：

```
link:C:/Data/deepseek/remote-mobile
  → github:66jiujiu99/dsh-plugin-remote-mobile#c6c0ad3f0c57…
```

**固定到具体 commit，不固定到分支**——分支会在安装时解析成当时的 HEAD，
让快照「精确版本」的承诺变成空话。

转换前会逐项检查，任何一项不满足就拒绝，并说明原因：

| 阻断原因 | 中文说明 |
|---|---|
| `missing-path` | 本地目录不存在 |
| `not-a-git-repo` | 本地目录不是 git 仓库 |
| `no-remote` | 没有配置 origin 远程 |
| `not-github` | 远程不是 GitHub 仓库 |
| `dirty` | 有未提交的改动 |
| `unpushed` | 有提交还没推送 |
| `no-commit` | 仓库里还没有提交 |
| `name-mismatch` | 目录里的包名与依赖名不一致 |

`dirty` 和 `unpushed` 尤其重要：仓库里没有你正在运行的代码时，订阅等于
悄悄降级你的工作区。

---

## 自动备份

三种触发，共用一个指纹去重（`SHA-256` over bundles + disabled + 每个插件的
name/version/enabled/commit）：

- **定时** —— 默认 6 小时，可配
- **插件变动** —— 监听 `plugin-manager/changed`，安装 / 卸载 / 启停后立即快照，
  并把变动原因写进快照的 `reasonDetail`
- **启动** —— 进程起来时对齐一次

指纹在**启动时从磁盘最新的快照读取**，所以重启进程不会重复推一份没变化的快照。
只有手动「立即备份」才允许存一份未变化的状态。

---

## HTTP 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/status` | 配置、云端连通性、令牌状态、最近推送/变动 |
| GET | `/plugins` | 插件清单 + 更新信息 + 订阅计划 |
| POST | `/updates` | 强制重新检查 registry |
| POST | `/upgrade` | `{names:[…]}` 升级指定插件 |
| POST | `/subscribe` | `{names:[…]}` 把本地插件转为订阅 |
| GET | `/versions` | 合并后的版本列表（本机 + 云端） |
| POST | `/backup` | `{label}` 立即备份 |
| POST | `/restore` | `{file, confirm}` 预检或装回 |
| POST | `/delete` | `{file}` 删除快照 |
| GET | `/version/<file>` | 读单个快照 |
| GET/POST | `/token` | 查询 / 写入凭证 |
| POST | `/config` | 保存配置 |
| POST | `/verify` | 验证仓库可达且私有 |

基础路径 `/api/plugin-cloud`。前端用 `document.baseURI` 拼，所以 Desktop 的
`dsh-app://app/` 和手机同步的 `/m/` 前缀都能正常请求。

---

## 安全

- 令牌只进**凭证服务**（`credentials.set`），不进 `config.json`、不进快照、不进日志
- `/token` 读回来的只有 `configured` / `source`，绝不返回值
- 快照里只有包名和版本，不含任何凭据
- 仓库建议设为 **private**；公开仓库会给出醒目警告

---

## 边界

**不写 `cordis.patch.yml`。**

安装、卸载、升级一律走 `pluginManager.installBundle`——它负责 pnpm 调用、
manifest 锁、失败回滚和激活。

**一条必须先知道的契约：`installBundle` 从不 reject。** 它把失败折叠进返回值
（`result.application === "failed"` + `result.error.code`），只有锁或析构故障
才会抛出。所以 `await manager.installBundle(...)` **不抛错不等于成功**：把它当
成功，就会在 pnpm 明明拒绝时告诉用户「升级完成」。本插件的成功判定读的是
`result.error.code` / `result.application`，不是 try/catch。

### 升级为什么要改 package.json

有 HMR 时，`installBundle` 对**已在 manifest 里的包**一律拒绝，返回
`already-installed`——即使这次调用的目的就是替换那个版本。官方文档给出的出路
是先 `removeBundle` 再装，但那会先把 bundle 取消选择：插件从页面上消失整个
pnpm 时长，中间失败还会留在半路。

`lib/manifest.js` 用更窄的办法：守卫只读 `package.json`，不读磁盘，所以**只删掉
那一条依赖项**就能通过检查，pnpm 的 `add` 本来就会覆盖已存在的依赖，条目在新
版本写入时立刻回来。bundle 全程没有被取消选择，插件一直挂载运行。替换失败时
原条目会被放回——把 profile 留在缺依赖的状态比升级失败更糟。

这个模块只改这一条依赖项，其余一律不碰：不动 bundle 顺序、不碰启停、不写它
没被要求写的任何版本。装回报告只**建议**目标 `bundleOrder` / `disabledRows`，
不直接改：运行时替换 bundle 列表可能让下一次启动直接失败。

### Windows 上这一步为什么需要重试

DSH 自己会读 `package.json`，而 **Node 的 `open(path, 'r')` 不带
`FILE_SHARE_DELETE`**，所以只要还有句柄没关，`rename` 覆盖目标就必然
`EPERM`（实测确认，不是推测）。于是写入分两级：

1. 写到带随机后缀的同目录兄弟文件，再 `rename` 覆盖目标——原子，读者要么看到
   旧内容要么看到新内容。遇到 `EPERM`/`EBUSY`/`EACCES` 按 20ms 起步、翻倍、
   200ms 封顶退避重试 8 次。
2. 仍然不行就**原地写**目标文件。读者占着句柄但并没有要求独占写入，所以这一步
   经常正好能成；而它是安全的：磁盘上留一份旧 `package.json` 是可恢复的，
   manifest 少一条依赖则会不可逆地丢插件。

两条都失败才报 `unavailable`，此时**文件一个字节都没动**、依赖也还在，调用方
拿到的是「什么都没发生」，而不是「删掉了但没装回来」。

`saveExact` 是必需的：不带它 pnpm 会写 `^1.2.0`，那样一份快照在另一台机器上
就会解析成别的版本，"精确版本"的承诺当场作废。

**不能自我升级。** 本插件不出现在自己的可升级列表里——那等于让正在处理这个
请求的代码把自己换掉。

---

## 界面语言

后端只发**机器码**（`invalid-repo`、`already-installed`、`subscribe-blocked:dirty`），
界面语言只有前端知道。`client.js` 里 `CODE_KEYS` / `BLOCKER_KEYS` 两张表负责翻译，
未知码原样透出——为我们没写过的文本编造翻译会掩盖真实的失败原因。

`tools/locale-check.mjs` 会扫后端源码，断言**每一个发出来的码都有翻译**，并断言
映射表指向的键确实存在于字典。新增错误时漏翻译会让测试变红。

---

## 验证

```bash
node tools/run-all.mjs
```

七套，共 301 项。总数会在 297–301 之间浮动：`版本检查与订阅` 里有两组真的去探
npm registry 和 GitHub 远端，网络不通时它们报 `skip` 而不是失败，所以 `run-all`
的合计会少几项。**合计变小不等于有东西坏了**，看的是「7/7 套通过」和退出码。

| 套件 | 项数 | 覆盖 |
|---|---|---|
| GitHub 协议与存储 | 13 | Contents sha 链、三次提交、索引合并、keep 截断 |
| 中英文案与 locale | 27 | locale 注册、占位符、死键、**每个错误码都有翻译** |
| 版本检查与订阅 | 61 | semver、预发布排序、真实 registry、订阅阻断、**git 订阅的远端比对** |
| 表格对齐 | 35 | 固定列轨、逐列对齐、徽标尺寸、窄屏仍成网格 |
| manifest 改写与回滚 | 83 | 折叠失败不当成功、替换失败放回原 entry、不碰其他依赖、重试与原地回落 |
| 升级任务的进度与取消 | 51 | 真实步骤序列、单任务互斥、取消不打断安装、快照不与内部共享 |
| 元数据渲染回归 | 31 | `{zh,en}` 语言映射不渲染成 `[object Object]` |

`lib/manifest.js` 是唯一会真改 profile `package.json` 的代码，所以它的测试
除了「全绿」还要证明自己有牙齿：

```bash
node tools/mutation-check.mjs   # 故意破坏实现，确认 9 个变异都被抓
```

重试与回落分支在真实环境里只有 Windows 才会触发（`EPERM`/`EBUSY`/`EACCES`
只在 win32 算瞬时），而**这些分支恰恰是最危险的**：一条依赖删掉了却没放回，
插件就从 profile 里消失。所以 `dropDependency` / `restoreDependency` /
`replaceDependency` 都接受一个 `{ io, sleep, isTransient }` 测试接缝，默认
用真实文件系统，只有测试才注入假实现——否则要么分支永远没被执行过，要么
测试只能靠真实故障随机碰一下。生产调用方一个参数都不用传。


---

## 配置

`$DSH_HOME/dsh-plugin-cloud/config.json`：

```jsonc
{
  "repo": "owner/name",        // 空 = 只存本机
  "tokenRef": "GITHUB_TOKEN",  // 凭证服务里的名字
  "autoBackup": true,
  "intervalHours": 6,
  "maxSnapshots": 50,
  "autoPushOnChange": true,    // 插件变动时备份
  "apiBase": "https://api.github.com"
}
```

### GitHub 令牌权限

细粒度 PAT，只勾两项：

| 权限 | 级别 | 用途 |
|---|---|---|
| **Contents** | Read and write | 读写快照文件 |
| **Metadata** | Read-only（自动） | 校验仓库存在与私有性 |

`Repository access` 只选这一个仓库。其余全部 `No access`。

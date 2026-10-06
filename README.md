# dsh-plugins

两个自己写的 [DeepSeek Harness](https://github.com/deepseek-ai)（下称 DSH）插件，一个仓库分发：

| 包 | 作用 | 文档 |
|---|---|---|
| [`dsh-balance-float`](dsh-balance-float/) | 可拖动浮窗：账户余额 + 当前计费是高峰还是低谷 | [README](dsh-balance-float/README.md) |
| [`dsh-audio-reward`](dsh-audio-reward/) | agent 完成一轮后播放一段音频；音频选择器并入上面那个浮窗 | [README](dsh-audio-reward/README.md) |

两个包各自独立：可以只装一个。音频插件把选择器注册进浮窗，所以**两个都装**才有图形界面（只装音频也能出声，用控制台 API 设置）。

**本仓库针对并实测于 DSH `0.2.0-rc.2`（Windows Desktop 版，`desktop` profile）。** DSH 的插件接口在不同 rc 之间会变，升级 DSH 后请按下面的[「自己核对契约」](#自己核对契约dsh-源码怎么读)重新确认一遍，不要假设本文还准确。

---

## 目录

- [快速开始](#快速开始)
- [插件在 DSH 里是怎么工作的](#插件在-dsh-里是怎么工作的) ← **要改代码先读这节**
- [两个插件的架构](#两个插件的架构)
- [怎么改：常见需求 → 改哪里](#怎么改常见需求--改哪里)
- [测试与验证](#测试与验证)
- [隐私与安全](#隐私与安全)
- [排错](#排错)
- [给新会话里的 AI：从这里开始](#给新会话里的-ai从这里开始)
- [许可](#许可)

---

## 快速开始

### 0. 先找到 `dsh` 命令

| 你的 DSH 怎么装的 | 命令 |
|---|---|
| `npm i -g @deepseek-ai/dsh` 或 `npx` | `dsh`（不在 PATH 就用 `npx @deepseek-ai/dsh`） |
| **Windows Desktop 版**（本仓库的开发环境） | Desktop 独占 `desktop` profile，必须用它自带的 CLI。见下方说明 |

Desktop 版的 CLI 在安装目录里，形如：

```
<DSH Desktop 安装目录>\resources\runtime\cli\bin\dsh.cmd
```

本文用 `<dsh-desktop>` 代表这个路径。**怎么找**：任务管理器里看 `DeepSeek Harness.exe` 的「命令行」，第一段就是安装路径；或在安装目录里搜 `dsh.cmd`。已知它不可用时，也可以直接问 DSH 自己的 AI（新开一个会话问「我的 desktop profile 的 dsh CLI 在哪」）。

本文所有 `<repo>` 代表你 clone 本仓库后的目录，例如 `X:\code\dsh-plugins`。

### 1. 安装

```powershell
# Windows Desktop 版（desktop profile 由应用独占，必须用自带 CLI）
& '<dsh-desktop>' plugin --profile desktop add '<repo>/dsh-balance-float'
& '<dsh-desktop>' plugin --profile desktop add '<repo>/dsh-audio-reward'

# 普通 Web 版
dsh plugin --profile web add '<repo>/dsh-balance-float'
dsh plugin --profile web add '<repo>/dsh-audio-reward'
```

三个必须注意的点：

1. **路径写绝对路径。** 裸目录名会被当成 npm 包名去 registry 拉取然后 404；相对路径按 `dsh` 的**调用目录**解析，不是按仓库目录。
2. **PowerShell 里 `#` 是注释符**，含 `#` 的 spec 要加引号（本仓库没有这种情况，但换别的插件会遇到）。
3. 安装会真的跑 pnpm，把它 `link:` 进 profile。本仓库的两个包**没有任何 dependencies / peerDependencies**（Host 半边只用 Node 内置模块，浏览器半边只用页面提供的 React），所以安装不需要联网。

### 2. 生效

| 变化 | 怎么生效 |
|---|---|
| 新增一个插件包 | Host 半边**热装载**（本次实测：装完立刻 `GET /api/...` 就 200），**浏览器半边要刷新页面** —— 页面的 boot 载荷是加载时读的 |
| 改了 `cordis.patch.yml` 的配置 | 配置热重载，或刷新页面 |
| 改了 `index.js`（Host 半边） | 热重载，或重启 DSH |
| 改了 `client.js`（浏览器半边） | 本次实测**运行中的进程会重新组合**（见 `dsh-balance-float/scripts/probe-bundle.mjs`），刷新页面即可；不放心就重启 DSH —— 重启一定生效 |
| 换了包的**路径**（移动目录） | 会被当成包替换，**需要重启 DSH** 才能加载新的 JS 模块代 |

### 3. 确认装上了

```powershell
& '<dsh-desktop>' plugin --profile desktop list          # 应看到两个包
cd <repo>/dsh-balance-float; node scripts\probe-bundle.mjs   # 浏览器半边是否已就绪（200 = 刷新页面即可）
cd <repo>/dsh-audio-reward; node scripts\verify-env.mjs      # 路由是否活着 + 音频目录里有什么
```

Host 半边可以不用浏览器直接查（下面用默认端口举例）：

```powershell
Invoke-WebRequest 'http://127.0.0.1:19387/api/dsh-balance-float/state'            | Select-Object -ExpandProperty Content
Invoke-WebRequest 'http://127.0.0.1:19387/api/dsh-audio-reward/state'             | Select-Object -ExpandProperty Content
Invoke-WebRequest 'http://127.0.0.1:19387/api/dsh-audio-reward/events?since=0'    | Select-Object -ExpandProperty Content
```

---

## 插件在 DSH 里是怎么工作的

这一节是**实测总结**，不是从官方文档抄的。每条都写了「怎么自己核对」，因为 DSH 的接口会变。看懂这节就能照着改，或者自己加第三个插件。

### 包清单（`package.json`）

```jsonc
{
  "name": "dsh-something",          // 同时是 loader row 的模块名、浏览器 bundle 的 id
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",              // Host 半边（Node）
    "./client": "./client.js",      // 浏览器半边（web）
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // 往 profile 里插一行
    "client": {
      "platform": "web",
      "immediately": true,          // 预取（性能提示，不影响正确性）
      "inject": ["@deepseek-ai/dsh-client-ui-layout"]  // 只影响加载顺序，不是服务注入
    }
  }
}
```

要点：

- **声明了 `dsh.client` 就必须有 `exports["./client"]`**，否则 client-modules 在扫描时**直接抛错**（`declares dsh.client but exports no "./client" bundle`）。
- `dsh.client.platform` 必须是 `"web"`，否则这个包压根不进浏览器名单。
- `dsh.client.inject` 里的**是包名**，不是 cordis 服务名。它只用来排加载顺序 / 给页面诊断用，**不会**让你的插件 park。真正决定"等哪个服务"的是浏览器半边 `apply` 那个对象里的 `inject` 数组。
- **本仓库两个包故意不写任何 `dependencies` / `peerDependencies`**：profile 安装会先做 peer 兼容性检查（不匹配就拒绝安装，还要走 `allow-version` 批准流程）。不声明就没有这个问题。
- `cordis.patch.yml` 长这样（把插件行插进 profile 的插件树）：

  ```yaml
  - insert:
      - id: my-plugin          # loader row id
        name: dsh-something    # 包名
        config: { ... }        # 原样传给 apply(ctx, config)
  ```

### Host 半边（`index.js`，跑在 Node 里）

```js
export const name = 'my-plugin'                    // 可选
export const inject = ['webServer', 'credentials'] // 服务名；缺一个就不激活
export function apply(ctx, config) { ... }
```

- `config` 就是 patch 里 `config:` 那段。**本仓库不导出 `Config`**（那需要 `@deepseek-ai/schemastery`，会引入依赖），改为在 `normalizeSettings()` 里手写校验 + 兜底：配置写错只会退回默认值，不会让插件激活失败。
- **所有资源都挂在 `ctx.effect(execute, label)` 里**，`execute` 的返回值被当成 disposer：插件卸载 → 清理。定时器、事件监听、路由注册都这么写。
- 服务：
  - `ctx.webServer.register({ kind: 'exact' | 'prefix', path, handler })` → 返回 disposer。
  - `ctx.credentials.resolve('DEEPSEEK_API_KEY')` → `{ value, source }` 或 `undefined`。**每次操作重新 resolve**，这样凭据热更新无需重启插件。凭据引用在运行期就是个普通字符串（`brandString` 是恒等函数），所以不 import `@deepseek-ai/dsh-credentials` 也能用。
  - `ctx.logger.warn(...)` 可用；本仓库仍包了 try/catch，日志拿不到也不该影响功能。
- **路由匹配规则（容易踩）**：先查 exact 表，命中就赢；否则在 prefix 表里**最长前缀优先**。prefix 的判定是 `pathname === prefix || pathname.startsWith(prefix + '/')` —— 所以 **prefix 千万不要以 `/` 结尾**，否则只有双斜杠才能匹配上。`/api` 这个前缀属于 api-gateway（要页面凭据，未登录返回 401），但你的 exact 路由或更长的 prefix 会赢过它。

### 浏览器半边（`client.js`，跑在页面里）

这个文件**不是普通 ES 模块**，是页面模块加载器的注册脚本，格式固定：

```js
window.__ModuleLoader__.load({
  id: 'dsh-something',        // 必须等于包名
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // ...你的代码...
    return { name: 'my-plugin', inject: ['slots'], apply(ctx) { ... } }
  },
})
```

- `require('react')` / `require('react/jsx-runtime')` 来自页面的模块表，**所有 bundle 共用同一个 React 实例**，所以 A 插件创建的 React 元素，B 插件能直接渲染。
- 工厂返回的对象就是插件面：`{ name, inject, apply }` 或直接一个 `apply` 函数（用对象形式才能声明 `inject`）。
- **profile 安装的静态 bundle 拿到的是真正的 cordis context**（不是给「运行期动态包」准备的那套受限沙箱），所以 `setTimeout` / `fetch` / `localStorage` / `document` 都能直接用。**但请仍然照官方建议把定时器和监听放进 `ctx.effect`/`ctx.on` 并返回清理函数** —— 页面热重载时会调用它们。
- 资源地址：`/plugins/??<包名>/client.js&rev=<12位十六进制>`。`rev` 由 bundle 文件的 mtime/ctime/size 推导，所以**改文件必然换 rev**。
- 不要 require 其它 DSH 客户端包（`@deepseek-ai/dsh-client-ui-primitives` 等）：它们会变，而纯 JS 插件没有类型检查，组件一抛错就会让整个插槽条目空白。要用控件就自己写、照主题变量配色。

### 插槽与浮层（`shell.overlay`）

```js
ctx.slots.inject('shell.overlay', () => ctx.slots.register({
  name: 'shell.overlay', id: 'my-thing', order: 60,
  inject: () => ({ runtime }),
}, MyComponent))
```

- `ctx.slots.inject(key, cb)` 的意思是"**等这个插槽被声明出来**再注册，声明塌掉就自动注销"。直接用 `ctx.slots.register` 注册到未声明的插槽会抛错，所以外层一定要包 `inject`。
- `shell.overlay` 是 `kind: 'list'`、`scope: 'root'`：**新增一个 `id` 就是加一个**，不会顶掉别人。
- 它渲染在 `.overlayLayer` 里：`position:absolute; inset:0; z-index:20; pointer-events:none`，直接子元素被置回 `pointer-events:auto`。层级契约是 menu 100 / Modal 1000，所以浮层天然在菜单和弹窗**下面** —— 这是对的，别去比它大。
- ⚠️ **最容易踩的坑**：插槽出口会给每个条目套一层锚点 `<div data-slot="…" style="display:contents">`。`display:contents` **不生成盒子**，`getBoundingClientRect()` 全是 0。所以：
  - **绝不要用 `element.parentElement` 量参照盒**（那量到的是 0×0 锚点，会把你的元素夹到 `(0,0)` 并且卡死在左上角）；
  - 要量就用 `offsetParent` / `offsetLeft` / `offsetTop` / `offsetParent.clientWidth` —— 那才是 `left`/`top` 真正解析所依据的盒子。
  - `dsh-balance-float/test/gesture.test.mjs` 里有一条回归测试专门守这件事。
- 想让文本走宿主语言：`ctx.inject(['locale'], (c) => c.locale.register(NS, { zh, en }))`，然后在 register 时传 `locale: NS` 拿 `t` 座位；或者像 `dsh-audio-reward` 那样自己包一层 `t()` 兜底（locale 服务不在也能显示内置文案）。

### 会话事件（"agent 什么时候干完活"）

```js
ctx.on('session/event', (session, event) => {
  if (event.type !== 'turn/end') return
  // event.data = { turn, reason: { kind } }
  // session.id
})
```

- `event` 有 `type` / `data` / `seq` / `time`；`session` 至少有 `id`。
- 事件类型包括 `turn/start`、`turn/end`、`step/start`、`step/end`、`assistant/message`、`tool/result` 等。
- 官方 `practices.md` 的原话是「wait on durable events such as `turn/end`, `assistant/message`, or `tool/result`；**不要轮询 `agent/status`**」。这也是已发布的 `dsh-damage-pulse` 在用的通道。
- **一次任务会有多个 `turn/end`**：agent 自己的回合 + 它 spawn 的每个子 agent 各一个。要"一个任务响一次"就必须自己做合并 —— 见 `dsh-audio-reward` 的 `CueFeed`。

### 自己核对契约：DSH 源码怎么读

Desktop 版把运行时打在 `app.asar` 里，**普通 shell 工具、ripgrep、node、pnpm 都读不进去**（那是归档，不是目录），`glob`/`grep` 会报"路径不存在"。两条可行路径：

1. **本仓库自带读取器**（推荐）：

   ```powershell
   node <repo>/tools/asar-read.mjs list '<dsh-asar>' 'dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/'
   node <repo>/tools/asar-read.mjs read '<dsh-asar>' 'dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js'
   ```

   `<dsh-asar>` 形如 `<DSH Desktop 安装目录>\resources\app.asar`。

2. **`npx` 缓存里也有一份完整的 node_modules**（版本可能不同，注意对照）：
   `%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\@deepseek-ai\`

几个特别值得先读的文件：

| 想看什么 | 读哪 |
|---|---|
| 插槽契约（有哪些槽、什么 kind） | `dsh-client-ui-layout/lib/client.js`（`shell.overlay` 的声明与 CSS 都在里面） |
| 插槽出口怎么渲染（那个 `display:contents` 锚点） | `dsh-client-ui-renderer/lib/client.js` |
| 浏览器 bundle 怎么被组合、rev 怎么算 | `dsh-client-modules/lib/index.js`（host）与 `lib/client.js`（browser） |
| 路由匹配规则 | `dsh-host-webserver/lib/index.js` 的 `match()` |
| 插件安装、`dsh.profile.bundles` 怎么维护 | `dsh-plugin-manager/lib/index.js`、`lib/types/operations.js` |
| 官方插件开发指南（本机就有） | `dsh-agent-preset/skills/cordis-plugin-development/`（`SKILL.md` + `references/*.md`） |

另外：`dsh --profile <name> --dump-config` 能打印组合后的配置树，但 **`desktop` 被拒绝**（"managed exclusively by the Electron application"），只有 `plugin` 子命令能操作它。

---

## 两个插件的架构

两个包的分工是同一个模式：**Host 拥有密钥、网络、磁盘；浏览器拥有时钟和声音。**

### `dsh-balance-float`

```
Host (index.js)                        Browser (client.js)
─────────────                          ──────────────────
credentials.resolve(apiKeyRef)         fetch /api/dsh-balance-float/state  每 60s
  ↓ 每 pollMs 拉一次                    ↓
GET api.deepseek.com/user/balance      本地时钟每 15s 重算峰谷
  ↓ 缓存快照                            （跨过 12:00 立刻翻转，不等下次轮询）
GET /api/dsh-balance-float/state  ───→ 渲染进 shell.overlay
  { status, balance, schedule,           整窗长按 280ms 或位移 >12px 即拖动
    period, periodEndsAt, ... }          位置/折叠状态存 localStorage
```

- **为什么峰谷算在浏览器**：它只是"当前时间 + 规则"的纯函数，浏览器每 15s 重算就能在边界上**立刻**翻转；放在 Host 就得等下一次轮询。规则本身（时区偏移 + 高峰窗口）由 Host 发布，客户端只负责**代入自己的时钟**，所以规则只有一份权威定义。
- **规则**：默认北京时间**工作日 09:00–12:00 与 14:00–18:00 为高峰**，周末全天低谷。改 `cordis.patch.yml` 的 `peakWindows` 即可（`[开始分钟, 结束分钟)`，从当地 0 点算）。
- 两份 `periodAt` 实现（Host 一份、浏览器一份）有测试逐分钟比对：`test/client.test.mjs` 里"both halves classify the same rule identically"。

### `dsh-audio-reward`

```
Host (index.js)                             Browser (client.js)
─────────────                               ──────────────────
ctx.on('session/event')                     轮询 /events?since=<cursor>  每 2s
  event.type === 'turn/end'                   ↓ 首次轮询只记录 baseline（不回放历史）
  ↓                                         ↓ 新 cue → <audio>.play()
CueFeed：尾随合并 coalesceMs=600ms            ↓ 被自动播放策略拒绝 → 面板提示 + 下次手势重试
  ↓（一个任务多个 turn → 只出一个 cue）
有界队列（maxEvents）
  ↓
GET /api/dsh-audio-reward/state   ───→ 音频列表 → 选择器（下拉 + 试听）
GET /api/dsh-audio-reward/events?since=
GET /api/dsh-audio-reward/track/<name>  ───→ 流式提供音频（支持 Range）
```

- **音频不进包**：Host 从 `audioDir` 直接流式读盘，所以换音频不用改代码。
- **路径守卫**：文件名必须是单个路径段，且解析后**正好落在 `audioDir` 里**（用 `dirname(path) === root` 判定，不是"在其之下"）；目录外的名字、非白名单扩展名、目录、空文件、>32MiB 全部返回同一个 `404`，不给外部探测文件系统的机会。
- **两个真实约束**（都已在代码里处理，改代码时别删）：
  1. 浏览器自动播放策略：cue 由 Host 事件触发、没有用户手势，`play()` 可能被拒 → 面板显示提示，并在下一次 `pointerdown`/`keydown` 重试**一次**。
  2. 子 agent 的 `turn/end`：靠 `coalesceMs` 尾随合并成一个 cue。

### 两者之间的接口：`registerPanel`

浮窗对外发布的扩展点（`window.__DSH_BALANCE_FLOAT__`）：

```js
const dispose = window.__DSH_BALANCE_FLOAT__.registerPanel({
  id: 'my-panel',     // 按 id 覆盖：同一个 id 再注册一次就是"更新自己"
  order: 20,          // 面板之间的顺序，余额那几行在上面
  render: () => ReactNode,   // 普通元素工厂：不要用 hooks
})
```

- `render` 是在**卡片自己的 render 期间**被调用的，所以它必须是个纯函数式的元素工厂（用 hooks 会把 hook 挂到卡片组件上，属于未定义行为）。面板要跟随自己的状态更新就**重新注册同一个 id**（`dsh-audio-reward` 就是这么做的）。
- 卡片会 try/catch 每个面板的 `render`：某个面板抛错只会让那一行空着，不会把整张卡片弄白。
- 卡片挂载时会派发 `dsh-balance-float:ready` 事件（`detail` 就是 api 对象），后加载的插件不必轮询这个全局变量。

---

## 怎么改：常见需求 → 改哪里

| 想做的事 | 改哪里 |
|---|---|
| 改高峰时段 | `dsh-balance-float/cordis.patch.yml` 的 `peakWindows`（不用碰代码）。改完记得 `node --test` —— 两边实现的一致性测试会守住 |
| 改轮询间隔 / 请求超时 / 换个凭据变量名 | 同上，`pollMs` / `timeoutMs` / `apiKeyRef` |
| 改浮窗里的文案 | `dsh-balance-float/client.js` 顶部的 `COPY`（zh + en），或走 locale 服务的字典 |
| 换浮窗皮肤 | **不用改源码**：覆盖 `--dbf-*` 变量，或用 `[data-dbf-skin='…']` / `[data-dbf-state='peak']` 选择器。变量清单见包的 README |
| 换高峰/低谷的颜色 | `--dbf-peak` / `--dbf-valley`，兜底是 `--dsw-alias-state-warn-primary` / `--dsw-alias-state-success-primary` |
| 改拖动的手感（长按时长、位移容差） | `dsh-balance-float/client.js` 的 `HOLD_MS` / `MOVE_TOLERANCE`；判定逻辑在 `isDragGesture` + `createDragMachine`（纯函数，有测试） |
| 让浮窗支持新的类型（比如点击展开明细） | 在 `FloatingCard` 的 `body` 里加节点；持久化照 `readStored`/`writeStored` 加 key，并**升 `POSITION_SCHEMA` 那类版本号**（旧值格式变了必须让它作废，否则坏值会一直生效） |
| 加/换完成音效 | 把文件丢进 `audioDir` 就行；想固定显示名就在 `dsh-audio-reward/cordis.patch.yml` 的 `labels` 加一条 |
| 一个任务响太多次 | 调大 `dsh-audio-reward` 的 `coalesceMs`（比如 1500） |
| 只在特定情况响（比如排除取消的回合） | `dsh-audio-reward/index.js` 里 `ctx.on('session/event', ...)` 的过滤条件；`event.data.reason.kind` 就是原因 |
| 加第三个插件 | 复制任一包改名：改 `package.json` 的 `name`、`cordis.patch.yml` 的 `id`/`name`、`client.js` 里 `__ModuleLoader__.load` 的 `id`（**必须等于包名**）；然后把它加进**仓库根 `.gitignore` 的白名单**（否则不会被提交） |

---

## 测试与验证

设计原则：**能在没有浏览器、没有网络、没有凭据的情况下测的，全部测掉。** 两个包合计 42 个单元测试。

```powershell
cd <repo>/dsh-balance-float; node --test        # 23 个
cd <repo>/dsh-audio-reward;  node --test        # 19 个
```

测到了什么（挑关键的）：

- 峰谷规则：一周内逐分钟比对 Host 与浏览器两份实现；边界日/周末、下一个切换点。
- 余额解析：多币种挑选、字段缺失、HTTP 失败、未配置凭据、跨站请求被拒。
- 拖动状态机：长按触发、位移触发、容差内抖动仍是点击、拖动只吞一次 click、单指针独占、**参照盒取自包含块而非 DOM 父节点**（就是那个 `display:contents` 坑的回归测试）。
- 音频：目录扫描与排序、**路径穿越的十种写法**、`Range` 解析、cue 合并、路由鉴权、音频目录为空、默认选中项消失后的回退、自动播放被拒后的重试。
- 面板：注册/排序/按 id 覆盖/非法输入被拒/卸载时注销；插槽条目与生命周期资源。

另外两个脚本（需要真实环境）：

| 脚本 | 干什么 |
|---|---|
| `dsh-balance-float/scripts/verify-env.mjs` | 清单与 patch 形状、**真实调用一次 `/user/balance`**（只读，不打印密钥）、当前峰谷 |
| `dsh-balance-float/scripts/probe-bundle.mjs` | 复算 client-modules 的 bundle `rev`，直接请求那条带版本的 URL：200 = 运行中的进程已收下浏览器半边，刷新页面即可；404 = 没组合上或版本算法不同（以页面为准） |
| `dsh-audio-reward/scripts/verify-env.mjs` | 清单与 patch 形状、真实音频目录里找到了什么、运行中 DSH 的三条路由、bundle 是否已组合 |

**因为我看不到浏览器**，视觉部分只能靠这些间接证据 + 你自己看一眼。改 UI 时请务必刷新页面确认。

---

## 隐私与安全

### 仓库里有什么、没有什么

- **没有任何凭据。** 两个包都不含 API key、token、密码、cookie。余额插件的 key 是**运行期**从 `$DSH_HOME/.credentials.yaml` 经 `ctx.credentials.resolve('DEEPSEEK_API_KEY')` 读的，只存在于 DSH 进程内；浏览器半边从头到尾拿不到它。
- **不含用户账号路径。** 文档和脚本里没有 `C:\Users\<你>` 这类路径；脚本用 `$DSH_HOME` / `os.homedir()` 推导位置。
- **`.gitignore` 是白名单制**（`/*` 然后只放行这两个包和根文件）。这个仓库的工作目录同时是一个更大的临时工作区，里面躺着无关的个人文件；白名单保证一次手滑的 `git add -A` 也**不可能**把它们发出去。
- **推之前先自查一遍**（这也是我推之前跑的）：

  ```powershell
  cd <repo>
  git ls-files                                        # 只应看到两个包 + 根文件
  git grep -nIE 'sk-[A-Za-z0-9]{16,}|Bearer [A-Za-z0-9_-]{16,}|api[_-]?key\s*[:=]\s*["'"'][^"'"']'
  git grep -nIE '[A-Za-z]:\\\\Users|/home/[a-z]|/Users/[a-z]|AppData'
  ```

  第一条若列出任何不属于这两个包的路径，**先停下来**。余额插件的测试里有一个假夹具 `Bearer sk-test`，是预期的，不是真 key。

### 运行期的暴露面（诚实说明）

- 两个插件的 HTTP 路由都做了**同源校验**（`Origin` 与 `Host` 必须一致，且拒绝 `Sec-Fetch-Site: cross-site`），但**不校验页面会话凭据** —— 和 DSH 里其它插件路由一样。也就是说：**任何能访问 DSH 端口的本机程序都能读到余额快照、音频列表，并且能拉走音频文件**（音频本来就在你自己盘上，不算新增暴露）。
- 余额路由**只暴露缓存快照，永不暴露 API Key**，也不暴露目录路径（`state` 里没有 `audioDir`）。
- 想收紧：把 DSH 的 `webServer` 绑回 `127.0.0.1`（默认就是），不要让端口暴露到局域网。
- 音频路由只提供 `audioDir` 里的白名单扩展名文件，路径穿越有测试守着。

---

## 排错

| 现象 | 原因与处理 |
|---|---|
| 页面完全看不到浮窗 | 插件没激活。DSH 启动审计会直接报错并列出条目名（`pending (waiting for service: …)` / `failed`）。也可以在控制台找 `slot entry crashed in 'shell.overlay'` |
| 浮窗卡在左上角、拖不动 | 老问题，已修：参照盒量成了 `display:contents` 锚点。如果又出现，跑 `__DSH_BALANCE_FLOAT__.getDiagnostics()` 看 `trace` 里的 `source` 与 `bounds` |
| `add` 报 404 | 用了裸目录名或相对路径。用**绝对路径** |
| `add` 报 peer 不匹配 / 要 `allow-version` | 那个包声明了和你 DSH 版本不匹配的 peerDependencies。本仓库两个包不声明任何依赖，不会遇到 |
| 装完 Host 路由 404（或 401） | 404 = row 没插进 profile（检查 `package.json` 的 `dsh.profile.bundles`）；**401 = 路由没注册，请求落到了 api-gateway 的 `/api` 前缀上**，也就是插件没激活 |
| 路由活着但页面没变化 | 浏览器半边要**刷新页面**才会被加载 |
| 改了 `client.js` 但页面还是老行为 | 刷新页面；还不行就重启 DSH（重启一定生效） |
| 音频面板显示"音频目录里没有可用的音频" | `audioDir` 写错了，或里面没有白名单扩展名的文件。`verify-env.mjs` 会直接告诉你找到了几个 |
| 任务完成没声音 | 先点面板里的「试听」确认能出声；再确认下拉不是「关闭」；子 agent 连发被合并是预期行为 |
| 面板显示"浏览器拦截了自动播放" | 正常：点一下页面任意处即可（会自动补播一次） |
| `--dump-config` 对 desktop profile 报错 | 预期：desktop profile 由 Electron 应用独占，只有它的 `plugin` 子命令能操作 |

---

## 给新会话里的 AI：从这里开始

如果你是新会话里的 AI，用户让你改这两个插件中的任何一个，按这个顺序做：

1. **先读本文件上面那节**「插件在 DSH 里是怎么工作的」。里面的接口结论是实测的，但**标了 DSH 版本**；先用 `& '<dsh-desktop>' --version` 确认版本没变，变了就按「自己核对契约」重新读一遍源码 —— 尤其是 `dsh-client-ui-renderer`（插槽出口）和 `dsh-client-modules`（bundle 组合），这两处一变，量参照盒和资源地址的写法就会失效。
2. **先跑测试建立基线**：`node --test`（两个包）。全绿再动手。
3. **改代码时守住这几条**：资源都用 `ctx.effect` 挂；DOM 测量只走 `offsetParent`；持久化格式变了要升版本号；跨 `turn/end` 的行为要考虑子 agent 连发；音频播放要考虑自动播放策略；浮窗面板的 `render` 不许用 hooks。
4. **改完必跑**：`node --test` + `node scripts/verify-env.mjs`，有 UI 改动再加 `probe-bundle.mjs`，然后**让用户刷新页面确认视觉**。
5. **推之前**跑[隐私与安全](#隐私与安全)那三条 `git grep` 自查。

常用环境事实（本次实测）：

- DSH 桌面版运行时：`0.2.0-rc.2`；profile：`desktop`；GUI：`http://127.0.0.1:19387`。
- 这个仓库的工作目录同时是一个更大的临时工作区 —— 新增插件包时**记得加进根 `.gitignore` 白名单**，否则不会被提交。
- 改 `client.js` 后运行中的进程会重新组合 bundle（`probe-bundle.mjs` 可验证），刷新页面即可；不确定就让用户重启 DSH。

---

## 许可

MIT。两个包各自带 `LICENSE`，根 `LICENSE` 覆盖仓库其余部分。

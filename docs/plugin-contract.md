# DSH 插件接口速查（实测）

这份文档是**实测总结**，不是从官方文档抄的。目标：改本仓库的插件、或者照着写第三个插件时，不用再去翻 DSH 的源码。每条都写了「怎么自己核对」，因为 DSH 的插件接口在不同 rc 之间会变。

> 实测版本：**DSH `0.2.0-rc.2`**（Windows Desktop 版，`desktop` profile）。
> 用 `dsh --version`（Desktop 版用 `<dsh-desktop> --version`）确认你的版本；不一致就按本文最后一节重新核对，不要假设本文还准确。

---

## 1. 包清单（`package.json`）

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

- **声明了 `dsh.client` 就必须有 `exports["./client"]`**，否则 client-modules 在扫描时**直接抛错**（`declares dsh.client but exports no "./client" bundle`）。
- `dsh.client.platform` 必须是 `"web"`，否则这个包不进浏览器名单。
- `dsh.client.inject` 里填的是**包名**，不是 cordis 服务名。它只用来排加载顺序（模块图）与页面诊断，**不会**让你的插件 park。真正决定"等哪个服务"的，是浏览器半边 `apply` 那个对象里的 `inject` 数组。
- 本仓库两个包**故意不写任何 `dependencies` / `peerDependencies`**：profile 安装前会做 peer 兼容性检查，不匹配就拒绝安装并要求 `allow-version` 批准。不声明就没有这个问题，也顺带让安装不需要联网。
- `cordis.patch.yml` 把插件行插进 profile 的插件树：

  ```yaml
  - insert:
      - id: my-plugin          # loader row id
        name: dsh-something    # 包名
        config: { ... }        # 原样传给 apply(ctx, config)
  ```

  插件行也支持 `disabled: true`，以及用 `!!js` 表达式算配置。

## 2. Host 半边（`index.js`，跑在 Node 里）

```js
export const name = 'my-plugin'                    // 可选
export const inject = ['webServer', 'credentials'] // 服务名；缺一个就不激活
export function apply(ctx, config) { ... }
```

- `config` 就是 patch 里 `config:` 那段。本仓库**不导出 `Config`**（那需要 `@deepseek-ai/schemastery`，会引入依赖），改为手写 `normalizeSettings()` 做校验 + 兜底：**配置写错只退回默认值，不会让插件激活失败**。
- **所有资源都挂在 `ctx.effect(execute, label)` 里**，`execute` 的返回值被当作 disposer：插件卸载 → 清理。定时器、事件监听、路由注册都这么写。
- 常用服务：
  - `ctx.webServer.register({ kind: 'exact' | 'prefix', path, handler })` → 返回 disposer。
  - `ctx.credentials.resolve('DEEPSEEK_API_KEY')` → `{ value, source }` 或 `undefined`。**每次操作重新 resolve**，凭据热更新无需重启插件。凭据引用在运行期就是普通字符串（`brandString` 是恒等函数），所以不 import `@deepseek-ai/dsh-credentials` 也能用。
  - `ctx.logger.warn(...)` 可用；本仓库仍然包了 try/catch —— 拿不到日志不该影响功能。
- **路由匹配规则（容易踩）**：先查 exact 表，命中即赢；否则在 prefix 表里**最长前缀优先**。prefix 的判定是 `pathname === prefix || pathname.startsWith(prefix + '/')`，所以 **prefix 千万不要以 `/` 结尾**，否则只有双斜杠才能匹配。`/api` 这个前缀属于 api-gateway（要页面凭据，未认证返回 **401**），但你的 exact 路由或更长的 prefix 会赢过它 —— 这也是为什么"插件没激活"表现为 401 而不是 404。

## 3. 浏览器半边（`client.js`，跑在页面里）

这个文件**不是普通 ES 模块**，是页面模块加载器的注册脚本，格式固定：

```js
window.__ModuleLoader__.load({
  id: 'dsh-something',        // 必须等于包名
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // ...
    return { name: 'my-plugin', inject: ['slots'], apply(ctx) { ... } }
  },
})
```

- `require('react')` / `require('react/jsx-runtime')` 来自页面模块表。**所有 bundle 共用同一个 React 实例**，所以 A 插件创建的 React 元素，B 插件能直接渲染。
- 工厂返回的对象就是插件面：`{ name, inject, apply }`，或直接一个 `apply` 函数（要用对象形式才能声明 `inject`）。
- **profile 安装的静态 bundle 拿到的是真正的 cordis context**（不是给"运行期动态包"准备的那套受限沙箱），所以 `setTimeout` / `fetch` / `localStorage` / `document` 都能直接用。但**仍应照官方建议把定时器、监听放进 `ctx.effect` / `ctx.on` 并返回清理函数**，页面热重载时会调用它们。
- 资源地址：`/plugins/??<包名>/client.js&rev=<12 位十六进制>`。`rev` 由 bundle 文件的 mtime/ctime/size 推导，所以**改文件必然换 rev**。改完 `client.js` 后运行中的进程会重新组合（用 `dsh-balance-float/scripts/probe-bundle.mjs` 验证），刷新页面即可；不确定就重启 DSH。
- 不要 require 其它 DSH 客户端包（`@deepseek-ai/dsh-client-ui-primitives` 等）：它们会变，而纯 JS 插件没有类型检查，组件一抛错就会让整个插槽条目空白。要用控件就自己写、照主题变量配色。

## 4. 插槽与浮层（`shell.overlay`）

```js
ctx.slots.inject('shell.overlay', () => ctx.slots.register({
  name: 'shell.overlay', id: 'my-thing', order: 60,
  inject: () => ({ runtime }),
}, MyComponent))
```

- `ctx.slots.inject(key, cb)` 的含义是「**等这个插槽被声明出来**再注册，声明塌掉就自动注销」。直接 `ctx.slots.register` 到未声明的插槽会抛错，所以外层必须包 `inject`。
- `shell.overlay` 是 `kind: 'list'`、`scope: 'root'`：**新增一个 `id` 就是加一个**，不会顶掉别人。
- 它渲染在 `.overlayLayer` 里：`position:absolute; inset:0; z-index:20; pointer-events:none`，直接子元素被置回 `pointer-events:auto`。层级契约是 menu 100 / Modal 1000，浮层天然在菜单和弹窗**下面** —— 这是对的，别去比它大。
- 其它有用的事实：`display:contents` 锚点（下一节）、`--dsh-frame-overlay-top` 这个变量由宿主在 darwin / windows-titlebar 场景下定义，浮层里的元素可以用它避开标题栏。

### ⚠️ 最容易踩的坑：插槽出口的 `display:contents` 锚点

插槽出口会给每个条目套一层锚点：

```html
<div class="overlayLayer">                 <!-- 真实尺寸 -->
  <div data-slot="shell.overlay"
       style="display:contents">           <!-- getBoundingClientRect() 全是 0 -->
    <div>你的元素</div>
  </div>
</div>
```

`display:contents` **不生成盒子**，所以它的 `getBoundingClientRect()` 全是 0。后果：

- **绝不要用 `element.parentElement` 量参照盒** —— 那量到的是 0×0 锚点，任何"夹进边界"的计算都会把你的元素固定到 `(0,0)`。这就是本项目 `dsh-balance-float` 曾经"浮窗卡在左上角拖不动"的真正原因。
- 要量就用 `offsetParent` / `offsetLeft` / `offsetTop` / `offsetParent.clientWidth` / `clientHeight` —— 那才是 `left`/`top` 真正解析所依据的盒子（对绝对定位元素而言，`offsetParent` 就是它的包含块）。
- 回归测试：`dsh-balance-float/test/gesture.test.mjs` 里 "the frame is measured from the card's containing block, not its DOM parent"。

文本书写想跟宿主语言走：`ctx.inject(['locale'], (c) => c.locale.register(NS, { zh, en }))`，注册时传 `locale: NS` 拿 `t` 座位；或者像 `dsh-audio-reward` 那样自己包一层 `t()` 兜底（locale 服务不在也能显示内置文案）。

## 5. 会话事件（"agent 什么时候干完活"）

```js
ctx.on('session/event', (session, event) => {
  if (event.type !== 'turn/end') return
  // event.data = { turn, reason: { kind } }
  // session.id
})
```

- `event` 有 `type` / `data` / `seq` / `time`；`session` 至少有 `id`。
- 事件类型包括 `turn/start`、`turn/end`、`step/start`、`step/end`、`assistant/message`、`tool/result` 等。
- 官方 `practices.md` 的原话：「wait on durable events such as `turn/end`, `assistant/message`, or `tool/result`；**不要轮询 `agent/status`**」。这也是已发布的 `dsh-damage-pulse` 在用的通道。
- ⚠️ **一次任务会有多个 `turn/end`**：agent 自己的回合 + 它 spawn 的每个子 agent 各一个。要"一个任务响一次"必须自己合并 —— 见 `dsh-audio-reward` 的 `CueFeed`。
- 官方还提醒：不要把新事件类型写进会话日志（未知类型的存储事件需要 `ignorable: true`，而 `session.append()` 设不了），插件自己的状态请另存。

## 6. 安装与激活语义

| 操作 | 生效方式 |
|---|---|
| `dsh plugin --profile <名> add <绝对路径 或 github: spec>` | CLI 在 profile 目录里跑 pnpm，成功后把包名追加进 profile `package.json` 的 `dsh.profile.bundles`。**新包的 Host 半边会热装载**（实测：装完立刻请求它的路由就返回 200），浏览器半边要**刷新页面** |
| `dsh plugin --profile <名> remove <包名>` | 先从 bundle 列表摘掉并卸载，再跑 pnpm |
| `dsh plugin --profile <名> list` | 确认包装上了 |
| `dsh --profile <名> --dump-config` | 打印组合后的配置树；**`desktop` 会被拒绝**（"managed exclusively by the Electron application"），只有 `plugin` 子命令能操作它 |

### 改一个**已装**插件的代码或配置（0.2.0-rc.2 desktop 实测）

注意这跟上表不是一回事：**首次安装**会热装载，**改已经装好的包**不会。

| 改了什么 | 实测结果 | 结论 |
|---|---|---|
| `client.js`（浏览器半边） | 复算 bundle `rev` 请求新 URL → **200**，内容已是新代码 | 进程会重新组合，**刷新页面**即可 |
| `client.js` 但页面行为没变 | — | 刷新页面；仍不对就重启 DSH |
| `index.js`（Host 半边代码） | 新加的 `/state` 字段**不出现**，新增的音频名 **404** | **需要重启 DSH** —— 运行中的进程用的是它已经 import 过的那个模块 |
| `cordis.patch.yml`（配置） | 改一个已发布的配置值、等 6 秒，`/state` 里**仍是旧值** | 官方文档说配置热重载需要 HMR 生效；本机实测 bundle patch 的改动没热生效，**保险做法是重启 DSH** |
| 换了包的**路径**（移动目录） | — | 会被当成包替换，**需要重启 DSH** 才能加载新的 JS 模块代 |

**一句话：改 `client.js` → 刷新页面；改 `index.js`、改配置、移动目录 → 重启 DSH。**

想确认运行中的进程跑的是哪一版代码，用「新字段探针」：给某个路由的响应加一个新字段，请求它看向不出现。本仓库两个 `scripts/verify-env.mjs` 就是这么自检的（`live Host routes` 那一行会在进程偏旧时明确说出来）。

## 7. 自己核对契约：DSH 源码怎么读

Desktop 版把运行时打在 `app.asar` 里，**普通 shell 工具、ripgrep、node 都读不进去**（它是归档不是目录；`glob`/`grep` 会报"路径不存在"）。两条可行路径：

1. **本仓库自带读取器**：

   ```powershell
   node tools/asar-read.mjs list '<dsh-asar>' 'dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/'
   node tools/asar-read.mjs read '<dsh-asar>' 'dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js'
   ```

   `<dsh-asar>` 形如 `<DSH Desktop 安装目录>\resources\app.asar`。

2. **`npx` 缓存里也有一份完整的 `node_modules`**（版本可能不同，注意对照）：
   `%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\@deepseek-ai\`

值得先读的文件：

| 想看什么 | 读哪 |
|---|---|
| 插槽契约（有哪些槽、什么 kind） | `dsh-client-ui-layout/lib/client.js`（`shell.overlay` 的声明与 CSS 都在里面） |
| 插槽出口怎么渲染（那个 `display:contents` 锚点） | `dsh-client-ui-renderer/lib/client.js` |
| 浏览器 bundle 怎么被组合、`rev` 怎么算 | `dsh-client-modules/lib/index.js`（host）与 `lib/client.js`（browser） |
| 路由匹配规则 | `dsh-host-webserver/lib/index.js` 的 `match()` |
| 插件安装、`dsh.profile.bundles` 怎么维护 | `dsh-plugin-manager/lib/index.js`、`lib/types/operations.js` |
| 官方插件开发指南（本机就有） | `dsh-agent-preset/skills/cordis-plugin-development/`（`SKILL.md` + `references/*.md`） |
| 会话事件类型清单 | `dsh-session/lib/index.js` |

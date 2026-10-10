# 开发说明

面向改这个仓库的人（或 AI 会话）。安装和使用请看[根 README](../README.md)；DSH 插件接口的实测速查在 [plugin-contract.md](plugin-contract.md)。

---

## 仓库结构

```
README.md                  面向使用者：装什么、怎么装、怎么用
README.en.md               同上，英文简版
docs/plugin-contract.md    DSH 插件接口实测速查（改代码前先读）
docs/development.md        本文件
tools/asar-read.mjs        读 DSH 运行时源码的工具（核对接口用）
dsh-balance-float/         插件包 1
dsh-audio-reward/          插件包 2
```

每个插件包的结构：

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边（Node）：网络、磁盘、凭据、路由、会话事件 |
| `client.js` | 浏览器半边：不是普通 ES 模块，是 `window.__ModuleLoader__.load({...})` 注册脚本 |
| `cordis.patch.yml` | 往 profile 插一行，并承载**全部**可调配置 |
| `test/*.test.mjs` | 单元测试，`node --test` 跑 |
| `scripts/verify-env.mjs` | 需要真实环境：清单/patch 形状、真实端口、真实目录 |
| `scripts/probe-bundle.mjs` | 只余额插件有：问运行中的 DSH 是否已组合好浏览器半边 |

### 为什么仓库根不是插件目录

这个仓库的工作目录同时是一个更大的临时工作区（旁边还有别的个人文件），插件目录必须留在原地 —— 移动它们会改掉 DSH profile 里的 `link:` 路径，而被改动路径的包需要**重启 DSH** 才能加载。

所以根 `.gitignore` 用的是**白名单制**：

```gitignore
/*
!/dsh-balance-float/
!/dsh-audio-reward/
!/tools/
!/docs/
!/.gitignore
!/.gitattributes
!/README.md
!/README.en.md
!/LICENSE
!/package.json
```

**新增一个插件包时必须加进这个白名单**，否则它不会被提交。好处是一次手滑的 `git add -A` 也不可能把无关的个人文件发出去。

---

## 架构

两个包是同一个模式：**Host 拥有密钥、网络、磁盘；浏览器拥有时钟和声音。**

### dsh-balance-float

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

- **为什么峰谷算在浏览器**：它只是"当前时间 + 规则"的纯函数，浏览器每 15s 重算就能在边界上立刻翻转；放 Host 就得等下一次轮询。规则（时区偏移 + 高峰窗口）由 Host 发布，客户端只负责代入自己的时钟，所以规则只有一份权威定义。
- 两份 `periodAt`（Host 一份、浏览器一份）由测试逐分钟比对：`test/client.test.mjs` 的 "both halves classify the same rule identically"。
- 拖动的手势逻辑刻意抽成**纯函数 + 纯状态机**（`isDragGesture` / `clampToFrame` / `measureFrame` / `createDragMachine`），时钟与定时器都可注入，所以能用假时钟测，不需要浏览器。这几个还通过 `window.__DSH_BALANCE_FLOAT__.gesture` 暴露出来。

### dsh-audio-reward

```
Host (index.js)                             Browser (client.js)
─────────────                               ──────────────────
ctx.on('session/event')                     轮询 /events?since=<cursor>  每 2s
  event.type === 'turn/end'                   ↓ 首次轮询只记 baseline（不回放历史）
  ↓                                         ↓ 新 cue → <audio>.play()
CueFeed：尾随合并 coalesceMs=600ms            ↓ 被自动播放策略拒绝 → 面板提示 + 下次手势重试一次
  ↓（一个任务多个 turn → 只出一个 cue）
有界队列（maxEvents）
  ↓
GET /api/dsh-audio-reward/state      ───→ 音频列表 → 选择器（下拉 + 试听）
GET /api/dsh-audio-reward/events?since=
GET /api/dsh-audio-reward/track/<name> ───→ 流式提供音频（支持 Range）
```

- **音频不进包**：Host 从 `audioDir` 流式读盘，换音频不用改代码。
- **路径守卫**：文件名必须是单个路径段，且解析后**正好落在 `audioDir` 里**（判定用 `dirname(path) === root`，不是"在其之下"）；目录外的名字、非白名单扩展名、目录、空文件、>32MiB 一律同一个 `404`，不给外部探测文件系统的机会。
- **两个真实约束，改代码时别删**：
  1. 浏览器自动播放策略：cue 由 Host 事件触发、没有用户手势，`play()` 可能被拒 → 面板显示提示，并在下一次 `pointerdown` / `keydown` 重试**一次**。
  2. 子 agent 的 `turn/end`：靠 `coalesceMs` 尾随合并成一个 cue。

### 两者之间的接口：`registerPanel`

浮窗对外发布的扩展点：

```js
const dispose = window.__DSH_BALANCE_FLOAT__.registerPanel({
  id: 'my-panel',     // 按 id 覆盖：同一 id 再注册一次 = 更新自己
  order: 20,          // 面板之间排序，余额那几行在面板之上
  render: () => ReactNode,   // 普通元素工厂：不要用 hooks
})
```

- `render` 是在**卡片自己的 render 期间**被调用的，所以它必须是无 hooks 的元素工厂（在里面用 hooks 会把 hook 挂到卡片组件上，属于未定义行为）。面板要跟随自己的状态更新，就**重新注册同一个 id** —— `dsh-audio-reward` 就是这么做的。
- 卡片对每个面板的 `render` 都做了 try/catch：某个面板抛错只会让那一行空着，不会把整张卡片弄白。
- 卡片挂载时会派发 `dsh-balance-float:ready`（`detail` 是 api 对象），后加载的插件不必轮询这个全局变量。

---

## 常见改法 → 改哪里

| 想做的事 | 改哪里 |
|---|---|
| 改高峰时段 | `dsh-balance-float/cordis.patch.yml` 的 `peakWindows`（不用碰代码）；改完 `npm test`，两边一致性测试会守住 |
| 改轮询间隔 / 超时 / 凭据变量名 | 同上：`pollMs` / `timeoutMs` / `apiKeyRef` |
| 改浮窗文案 | `dsh-balance-float/client.js` 顶部的 `COPY`（zh + en），或走 locale 服务字典 |
| 换皮肤 | **不用改源码**：覆盖 `--dbf-*` 变量，或用 `[data-dbf-skin='…']` / `[data-dbf-state='peak']` 选择器 |
| 改拖动手感 | `dsh-balance-float/client.js` 的 `HOLD_MS` / `MOVE_TOLERANCE`；判定在 `isDragGesture` + `createDragMachine`（有测试） |
| 让浮窗支持新内容 | 在 `FloatingCard` 的 `body` 里加节点；持久化照 `readStored`/`writeStored` 加 key，**格式变了必须升版本号**（旧格式值要作废，否则坏值会一直生效） |
| 加/换完成音效 | 文件丢进 `audioDir` 即可；想固定显示名就在 `labels` 加一条 |
| 一个任务响太多次 | 调大 `dsh-audio-reward` 的 `coalesceMs` |
| 只在特定情况响 | `dsh-audio-reward/index.js` 里 `ctx.on('session/event', ...)` 的过滤条件；`event.data.reason.kind` 是原因 |
| 加第三个插件 | 复制任一包改名：`package.json` 的 `name`、`cordis.patch.yml` 的 `id`/`name`、`client.js` 里 `__ModuleLoader__.load` 的 `id`（**必须等于包名**）；**并加进根 `.gitignore` 白名单** |

---

## 测试与验证

设计原则：**能在没有浏览器、没有网络、没有凭据的情况下测的，全部测掉。**

```powershell
npm test                                          # 两个包一起跑，42 个单元测试
cd dsh-balance-float; node --test                 # 23 个
cd dsh-audio-reward;  node --test                 # 19 个
```

测到了什么（挑关键的）：

- 峰谷规则：一周内逐分钟比对 Host 与浏览器两份实现；边界日/周末；下一个切换点。
- 余额解析：多币种挑选、字段缺失、HTTP 失败、未配置凭据、跨站请求被拒。
- 拖动状态机：长按触发、位移触发、容差内抖动仍算点击、拖动只吞一次 click、单指针独占、**参照盒取自包含块而非 DOM 父节点**（那个 `display:contents` 坑的回归测试）。
- 音频：目录扫描与排序、**路径穿越的十种写法**、`Range` 解析、cue 合并、路由鉴权、目录为空、默认选中项消失后的回退、自动播放被拒后的重试。
- 面板：注册/排序/按 id 覆盖/非法输入被拒/卸载时注销；插槽条目与生命周期资源。

需要真实环境的脚本：

| 脚本 | 干什么 |
|---|---|
| `dsh-balance-float/scripts/verify-env.mjs` | 清单与 patch 形状、**真实调用一次 `/user/balance`**（只读，不打印密钥）、当前峰谷 |
| `dsh-balance-float/scripts/probe-bundle.mjs` | 复算 client-modules 的 bundle `rev` 并请求那条带版本的 URL：200 = 运行中的进程已收下浏览器半边；404 = 没组合上或版本算法不同（以页面为准）。端口可传参 |
| `dsh-audio-reward/scripts/verify-env.mjs` | 清单与 patch 形状、真实音频目录里找到了什么、运行中 DSH 的三条路由、bundle 是否已组合 |

**改 UI 后请让使用者刷新页面确认视觉** —— 单元测试看不到渲染结果。

---

## 提交前自查

```powershell
git ls-files                                        # 只应看到两个包 + 根文件 + docs + tools
git grep -nIE 'sk-[A-Za-z0-9]{16,}|Bearer [A-Za-z0-9_-]{16,}|api[_-]?key\s*[:=]\s*["'"'][^"'"']'
git grep -nIE '[A-Za-z]:\\\\Users|/home/[a-z]|/Users/[a-z]|AppData'
```

- 第一条若列出任何不属于本项目的路径，**先停下来**。
- 余额插件的测试里有一个假夹具 `Bearer sk-test`，是预期的，不是真 key。
- 不要提交 `.credentials.yaml`、日志、`node_modules/`。

---

## 给接手这个仓库的 AI 会话

1. **先读 [plugin-contract.md](plugin-contract.md)**。里面的接口结论是实测的、标了 DSH 版本；先用 `--version` 确认版本没变，变了就按该文最后一节重新读源码 —— 尤其是 `dsh-client-ui-renderer`（插槽出口）和 `dsh-client-modules`（bundle 组合），这两处一变，"量参照盒"和"资源地址"的写法就会失效。
2. **先跑 `npm test` 建立基线**，全绿再动手。
3. **改代码守住这几条**：资源都用 `ctx.effect` 挂；DOM 测量只走 `offsetParent`；持久化格式变了升版本号；跨 `turn/end` 的行为考虑子 agent 连发；音频播放考虑自动播放策略；浮窗面板的 `render` 不许用 hooks；新增包要加进根 `.gitignore` 白名单。
4. **改完必跑**：`npm test` + 相关 `scripts/verify-env.mjs`；有 UI 改动再加 `probe-bundle.mjs`，然后让使用者刷新页面确认。
5. **推之前**跑上面的提交前自查。

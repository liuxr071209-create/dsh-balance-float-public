# dsh-balance-float · 余额与峰谷悬浮窗

DeepSeek Harness Web GUI 的一个插件：在界面右上角显示一个**可拖动、可折叠的浮窗**，内容为

- 当前 DeepSeek 账户**余额**（来自官方 `/user/balance`）；
- 当前计费是**高峰**还是**低谷**，以及本时段到几点结束。

外观只用宿主主题变量和 `--dbf-*` 自定义属性写成，**皮肤与动图通过变量和公开 API 接入，不需要改源码**。

```
┌───────────────────────────┐
│ ●  账户余额            ▾  │   ← 长按浮窗内任意位置都能拖动
│ ¥ 12.34                   │   ← 点击刷新
│ ● 高峰计价  至 12:00       │
│ 赠送 4.85   充值 8.54      │
└───────────────────────────┘
```

## 操作

| 手势 | 效果 |
|---|---|
| **在浮窗内任意位置长按**（≥280ms） | 进入拖动，接着移动就能把浮窗放到任意位置 |
| 在任意位置快速拖动（位移 >12px） | 同样进入拖动，不必等长按 |
| 短按金额 | 立刻向 Host 要一次新余额（Host 侧有 5 秒冷却） |
| 短按右上角 ▾ | 折叠 / 展开 |
| `Tab` 聚焦浮窗后按方向键 | 每次 8px；按住 `Shift` 为 32px |
| 短按动图舞台 | 触发 `activate`（`source: 'stage'`） |

拖动与点击的界线是明确的：**一旦变成拖动，紧随其后的那次 click 会被吞掉**，所以拖完不会顺手把浮窗折叠掉或触发刷新。位移在 12px 以内、且短于 280ms 的按压仍然算点击，完全交给下面的控件处理。松手后位置存进 `localStorage`，窗口缩放时会自动拉回可视范围。

## 组成

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：解析 API Key、定时拉取余额、注册同源 JSON 路由、发布计费规则 |
| `client.js` | 浏览器半边：注册进 `shell.overlay`，负责渲染、拖动、折叠、时钟判断 |
| `cordis.patch.yml` | bundle patch：插入一行 Host 插件，并给出可调配置 |
| `test/` | 23 个单元测试（无需网络、无需凭据） |
| `scripts/verify-env.mjs` | 环境验证：清单形状、patch YAML、真实余额接口、当前峰谷 |
| `scripts/probe-bundle.mjs` | 探活：问正在运行的 DSH 是否已备好浏览器半边 |

分工是刻意的：**Host 拥有密钥、网络和计费规则本身；浏览器半边拥有时钟**。所以跨过 12:00 这种边界时，峰谷标签立刻翻转，不必等下一次轮询；余额接口挂掉时，峰谷依然准确。

配套插件：[`dsh-audio-reward`](../dsh-audio-reward/) 通过本插件提供的 `registerPanel` 扩展点，把"完成音效"选择器挂进这张卡片。

## 安装

Desktop 版 DSH 的 `desktop` profile 由应用独占，需要用应用自带的 CLI（下称 `<dsh-desktop>`，怎么找见[仓库根 README](../README.md#0-先找到-dsh-命令)）：

```powershell
& '<dsh-desktop>' plugin --profile desktop add '<repo>/dsh-balance-float'
```

普通 `dsh web` 装配（`web` profile）用：

```powershell
dsh plugin --profile web add '<repo>/dsh-balance-float'
```

`<repo>` 是本仓库的 clone 目录。路径必须是**绝对路径**：裸目录名会被当作 npm 包名去 registry 拉取。`#` 在 PowerShell 里是注释符，含 `#` 的 spec 记得加引号。

新增插件包后需要**刷新页面**才能看到浮窗（Host 半边会热装载；不放心就重启 DSH）；之后改本插件的 JS 源码，重新加载页面即可。

卸载：

```powershell
& '<dsh-desktop>' plugin --profile desktop remove dsh-balance-float
```

## 配置

所有配置都在本包的 `cordis.patch.yml` 的 `config` 段里；删掉整段即回到默认值。

| 键 | 默认 | 说明 |
|---|---|---|
| `apiKeyRef` | `DEEPSEEK_API_KEY` | 从凭据库里读哪个环境变量名的值，可换成别的引用 |
| `pollMs` | `60000` | 余额轮询间隔，夹在 15000–3600000 |
| `timeoutMs` | `10000` | 单次余额请求超时 |
| `utcOffsetMinutes` | `480` | 计费时区相对 UTC 的分钟数（+8 即北京时间；Asia/Shanghai 无夏令时，固定偏移即精确） |
| `peakWindows` | `[[540,720],[840,1080]]` | 高峰时段，`[开始分钟, 结束分钟)`，从当地 0 点算起 |

默认规则 = **北京时间工作日 09:00–12:00 与 14:00–18:00 为高峰，周末全天低谷**。改规则只需改 `peakWindows`，例如把高峰改成每天 10:00–11:00：

```yaml
        peakWindows:
          - [600, 660]
```

`weekendPeak` 不在配置里：本插件按“周末不属于高峰”处理，这与官方计费一致。要覆盖它就得改 `index.js` / `client.js` 里各自的 `periodAt`——两处逻辑有测试保证一致（`test/client.test.mjs` 会逐分钟比对两份实现）。

## 皮肤与动图扩展位

### 1. CSS 变量（推荐，零代码）

浮窗根节点是 `.dbf-root`，并带三个状态属性，可以直接用属性选择器做皮肤：

| 属性 | 取值 |
|---|---|
| `data-dbf-skin` | 当前皮肤名，默认 `default` |
| `data-dbf-state` | `peak` / `offPeak` |
| `data-dbf-status` | `ok` / `pending` / `unconfigured` / `error` |
| `data-dbf-collapsed` | 折叠时存在 |

可覆盖的变量（每一个都有宿主 token 兜底，所以只覆盖想改的即可）：

| 变量 | 兜底 | 作用 |
|---|---|---|
| `--dbf-surface` | `--dsw-alias-bg-overlay` | 卡片底色 |
| `--dbf-border` | `--dsw-alias-border-l2` | 描边 |
| `--dbf-shadow` | `--dsw-shadow-lv2` | 阴影 |
| `--dbf-shadow-drag` | 品牌色描边 + `--dbf-shadow` | 拖动中的阴影（默认给一圈高亮反馈） |
| `--dbf-radius` / `--dbf-radius-pill` | `--dsw-radius-lg` / `999px` | 圆角（展开 / 折叠） |
| `--dbf-label` / `--dbf-title-label` / `--dbf-until-label` | 各级 `--dsw-alias-label-*` | 文字色 |
| `--dbf-font` / `--dbf-title-font` / `--dbf-amount-font` / `--dbf-state-font` / `--dbf-detail-font` / `--dbf-note-font` | 各级 `--dsw-font-*` | 字体 |
| `--dbf-amount-label` | `--dsw-alias-label-primary` | 金额颜色 |
| `--dbf-grip` | `--dsw-alias-label-tertiary` | 把手圆点 |
| `--dbf-peak` / `--dbf-valley` | `--dsw-alias-state-warn-primary` / `--dsw-alias-state-success-primary` | 高峰 / 低谷指示灯色 |
| `--dbf-error` | `--dsw-alias-state-error-primary` | 出错态指示灯色 |
| `--dbf-stage-width` / `--dbf-stage-max-height` | `auto` / `96px` | 动图舞台尺寸 |

想换皮肤又不写新插件，最省事的做法是把变量挂到浮窗根节点的一个祖先上（`shell.overlay` 层、`#root`、或 `document.documentElement`）：

```js
document.documentElement.style.setProperty('--dbf-surface', 'rgba(12,20,40,.72)')
document.documentElement.style.setProperty('--dbf-radius', '8px')
```

### 2. 公开 API（`window.__DSH_BALANCE_FLOAT__`）

给“皮肤插件 / 动图互动”用的稳定接口，版本号在 `version`。插件卸载时这个全局会被自己撤掉。

| 成员 | 说明 |
|---|---|
| `getState()` | `{ snapshot, period, periodEndsAt, schedule, skin, stage }` |
| `periodAt(ts?)` / `nextChangeAt(ts?)` | 纯函数，按当前生效规则判断；不传 `ts` 用当前时间 |
| `getSkin()` / `setSkin(name)` | 皮肤名，写入 `localStorage` 的 `dsh-balance-float:skin`，同步到 `data-dbf-skin` |
| `getStage()` / `setStage(stage)` | 动图舞台：`{ kind: 'image', src, alt }` 或 `null` |
| `refresh()` | 立刻向 Host 要一次新余额（Host 侧有 5 秒冷却，防止刷页面打爆接口） |
| `gesture` | 浮窗实际使用的拖动判定：`holdMs`（280）、`moveTolerance`（12）、`isDragGesture(heldMs, distance)`、`clampToFrame(position, bounds)`、`measureFrame(card)`、`createDragMachine(options)`。皮肤可以照着调自己的提示动效；测试直接驱动同一个状态机与同一套测量 |
| `getDiagnostics()` | `{ positionSchema, storedPosition, renderPosition, trace }`，拖动异常时用来读现场（见下） |
| `registerPanel(panel)` | **给别的插件用的扩展点**：把 `{ id, order, render }` 注册成卡片里的一个面板，返回注销函数。`render` 是普通元素工厂（不许用 hooks），要跟随自己的状态更新就用同一个 `id` 重新注册 |
| `listPanels()` | 当前已注册的面板 id |
| `on(event, handler)` | 订阅事件，返回取消订阅函数 |

事件：

| 事件 | 载荷 | 触发时机 |
|---|---|---|
| `state` | `{ snapshot }` | 每次拿到/失败于 Host 快照 |
| `balance` | `{ balance }` | 余额数值变化 |
| `period` | `{ period, periodEndsAt }` | 高峰↔低谷真正切换 |
| `drag` | `{ phase: 'start'\|'move'\|'end', position? }` | 拖动 |
| `collapse` | `{ collapsed }` | 折叠/展开 |
| `skin` / `stage` | `{ skin }` / `{ stage }` | 皮肤、舞台变更 |
| `activate` | `{ source: 'amount'\|'stage' }` | 点击金额或舞台 |

**怎么接一张动图**（写个小插件、或直接在控制台试）：

```js
const api = window.__DSH_BALANCE_FLOAT__
api.setSkin('whale')
api.setStage({ src: '/path/to/whale-idle.webp', alt: '鲸鱼娘' })

// 让动图跟着峰谷换帧
api.on('period', ({ period }) => {
  api.setStage({ src: period === 'peak' ? '/path/to/whale-panic.gif' : '/path/to/whale-idle.gif' })
})

// 点击舞台时做点互动
api.on('activate', ({ source }) => console.log('poked', source))
```

`src` 可以是 URL 或 `data:` URI，所以外部皮肤包可以把动图打包成 data URI 注入，不依赖远端资源。舞台默认最大高度 96px，用 `--dbf-stage-max-height` 调。

### 3. 面板：把别的插件的控件放进卡片

```js
const dispose = window.__DSH_BALANCE_FLOAT__.registerPanel({
  id: 'my-panel',          // 按 id 覆盖：同一个 id 再注册一次 = 更新自己
  order: 20,               // 面板之间排序；余额那几行在面板之上
  render: () => React.createElement('div', null, '我的控件'),
})
window.addEventListener('dsh-balance-float:ready', (e) => { /* e.detail 就是 api */ })
```

卡片挂载时会派发 `dsh-balance-float:ready`，所以后加载的插件不用轮询这个全局变量。卡片对每个面板的 `render` 都做了 try/catch：某个面板抛错只会让那一行空着，不会把整张卡片弄白。真实的例子见 [`dsh-audio-reward/client.js`](../dsh-audio-reward/client.js)。

## 验证

```powershell
cd <repo>\dsh-balance-float
node --test                        # 23 个单元测试：峰谷规则、余额解析、路由鉴权、半边注册、拖动状态机与测量、面板扩展点、两份实现一致性
node scripts\verify-env.mjs        # 环境验证：清单/patch 形状、真实余额接口、当前峰谷
node scripts\probe-bundle.mjs      # 问正在运行的 DSH：浏览器半边是否已就绪（200 = 刷新页面即可）
```

`verify-env.mjs` 会真的调用一次 `api.deepseek.com/user/balance`（只读，不打印密钥）。凭据缺失时那一项显示 `skipped`，其余照常。

`probe-bundle.mjs` 复算客户端模块注册表用的版本号，去请求那一条带版本的 bundle URL：`200` 说明进程已经收下浏览器半边、刷新页面就能看到；`404` 说明组合还没跟上（重启 DSH），或者这个 DSH 版本的版本号算法不同——这种情况探针分不出来，以页面为准。端口不同就传参：`node scripts\probe-bundle.mjs http://127.0.0.1:3080`。也可以直接查 Host 半边：

```powershell
Invoke-WebRequest 'http://127.0.0.1:19387/api/dsh-balance-float/state' | Select-Object -ExpandProperty Content
```

装完后确认插件已进入 profile：

```powershell
& '<dsh-desktop>' plugin --profile desktop list
```

## 出错时看哪里

| 现象 | 原因与处理 |
|---|---|
| 浮窗显示「未配置 API Key」 | 凭据库里没有 `DEEPSEEK_API_KEY`（或把 `apiKeyRef` 改成了不存在的名字） |
| 浮窗显示「余额不可用」 | `/user/balance` 请求失败：看 DSH 日志里 `[dsh-balance-float] 余额查询失败: …`；401 说明 key 无效 |
| 页面完全看不到浮窗 | 插件没激活。Host 与浏览器的入口若没激活，Web boot 会直接报错并在加载页列出条目名（`pending (waiting for service…)` / `failed`）；也可在浏览器控制台看有无 `slot entry crashed in 'shell.overlay'` |
| 浮窗卡在左上角、拖不动 | 旧版本量错了参照盒（槽位出口会套一层 `display:contents` 的锚点，它的盒子是 0×0），把位置夹成了 (0,0) 并写进了 localStorage。现在改为用 `offsetParent` 量，并且**位置格式升到了 v2**：旧值会被直接忽略，浮窗回到默认的右上角 |
| 拖动后位置没保存 | 浏览器禁用了 localStorage；位置**不会**跨设备同步 |

拖动不听话时，先在浏览器控制台读一次诊断（不需要装任何东西）：

```js
__DSH_BALANCE_FLOAT__.getDiagnostics()
// { positionSchema, storedPosition, renderPosition, trace: [ {kind:'press', source:'offsetParent', originX, originY, bounds}, … ] }
```

`trace` 里 `kind:'press'` 那条记录了真正用来夹取位置的 `source` 与 `bounds`：`source: 'offsetParent'` 是正常路径，`'viewport'` 说明找不到定位祖先、退回了视口，`kind:'measure-failed'` 说明两个盒子都量不出来（此时插件会**拒绝**这次按压，而不是把浮窗丢到角落）。

## 已知边界

- 浮窗只读取余额，不做充值、不做预算告警，也不写任何 session 事件。
- `GET /api/dsh-balance-float/state` 是**同源可读**的路由：它只接受同源请求（`Origin`/`Sec-Fetch-Site` 校验），但不校验页面会话凭据，和 DSH 里其它插件路由一样。它只暴露缓存下来的余额快照，**永远不暴露 API Key**；如果本机有别的程序能访问 DSH 的端口，它也能读到这个余额。要收紧就把 Host 的 `webServer` 绑回 `127.0.0.1` 并限制本机端口访问。
- 计费规则是“本地时间 + 工作日窗口”的模型；官方若改成按模型或按节假日计价，需要改 `periodAt`（两处，用 `node --test` 保住一致性）。
- 浮窗层级在 `shell.overlay`（z-index 20），位于菜单（100）与弹窗（1000）之下，这是 DSH 的层级契约，不会被浮窗遮挡或遮挡别人。

## 许可

MIT。

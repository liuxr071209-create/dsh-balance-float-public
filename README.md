# dsh-plugins · DeepSeek Harness 插件

[English](README.en.md) · **简体中文**

两个为 [DeepSeek Harness](https://github.com/deepseek-ai)（下称 DSH）写的 Web 插件，一个仓库分发：

| 插件 | 作用 |
|---|---|
| **[dsh-balance-float](dsh-balance-float/)** | 浮窗显示账户余额 + 当前计费是**高峰**还是**低谷**，可拖动、可折叠 |
| **[dsh-audio-reward](dsh-audio-reward/)** | agent 完成任务后播一段音频；音频选择器就在上面那个浮窗里 |

```
┌───────────────────────────┐
│ ●  账户余额            ▾  │   ← 长按浮窗内任意位置都能拖动
│ ¥ 12.34                   │   ← 点击刷新
│ ● 高峰计价  至 12:00       │
│ 赠送 4.85   充值 8.54      │
├───────────────────────────┤
│ 完成音效  [ 爱坤  ▾ ] [试听] │   ← 由音频插件注册进来
└───────────────────────────┘
```

两个插件互相独立：只装余额插件就是纯浮窗；只装音频插件也能出声（只是没有界面可选，要用控制台 API）。**都装**才有上图的效果。

---

## 要求

| | |
|---|---|
| DSH | **0.2.0-rc.2** 或同代版本（开发与实测版本）。不同 rc 之间插件接口会变；升级 DSH 后若插件不工作，见 [docs/plugin-contract.md](docs/plugin-contract.md) |
| 装插件的方式 | 能执行 `dsh plugin --profile <名字> add <路径>`。Desktop 版要用它自带的 CLI，见下 |
| **余额插件额外需要** | DSH 里配好 DeepSeek API Key（[第 3 步](#3-配好-api-key只有余额插件需要)）。不配也能装，浮窗会显示「未配置 API Key」 |
| **音频插件额外需要** | 一个放音频文件的目录，路径写进配置（默认 `D:/音频`，**别人用请改成自己的**） |

两个插件都**没有任何第三方依赖**（Host 半边只用 Node 内置模块，浏览器半边只用页面自带的 React），所以安装过程不需要联网。

---

## 安装

### 1. 拿到代码

```powershell
git clone https://github.com/<owner>/dsh-plugins.git
cd dsh-plugins
```

下文用 `<clone>` 表示这个目录的**绝对路径**，例如 `X:\code\dsh-plugins`。

### 2. 装插件

**普通 Web 版 DSH**（`dsh` 在 PATH 里）：

```powershell
dsh plugin --profile web add '<clone>/dsh-balance-float'
dsh plugin --profile web add '<clone>/dsh-audio-reward'
```

**Windows Desktop 版**：`desktop` profile 由应用独占，必须用它自带的 CLI：

```powershell
& '<dsh-desktop>' plugin --profile desktop add '<clone>/dsh-balance-float'
& '<dsh-desktop>' plugin --profile desktop add '<clone>/dsh-audio-reward'
```

`<dsh-desktop>` 是自带 CLI 的完整路径，形如 `<DSH Desktop 安装目录>\resources\runtime\cli\bin\dsh.cmd`。**怎么找**：任务管理器里看 `DeepSeek Harness.exe` 的「命令行」，第一段就是安装目录；或在安装目录下搜 `dsh.cmd`。

> 两个容易踩的点：
> - **路径必须写绝对路径。** 写 `dsh-balance-float` 会被当成 npm 包名去网上拉取然后 404；写相对路径则按你**执行命令时所在的目录**解析，不是按仓库目录。
> - 装完 Host 半边会立即热装载，但**浏览器半边要刷新页面**才会加载。刷新后就能看到浮窗。

### 3. 配好 API Key（只有余额插件需要）

余额插件从 DSH 的凭据里读 `DEEPSEEK_API_KEY`。两种方式任选其一：

- **在 DSH 界面里配**（推荐）：设置 → 账户，按提示填入 DeepSeek API Key。
- **写进凭据文件** `%USERPROFILE%\.dsh\.credentials.yaml`，在 `refs` 段加一行：

  ```yaml
  version: 1
  refs:
    DEEPSEEK_API_KEY: sk-你的key
  ```

  也可以直接设成环境变量 `DEEPSEEK_API_KEY`（插件会优先读环境变量）。

插件**不会**把 key 写进任何日志或响应，浏览器端也拿不到它 —— 见[隐私](#隐私)。

### 4. 确认能用

刷新 DSH 页面，界面右上角应该出现浮窗。没出现就先查 Host 半边（端口按你的实际值改）：

```powershell
Invoke-WebRequest 'http://127.0.0.1:19387/api/dsh-balance-float/state' | Select-Object -ExpandProperty Content
Invoke-WebRequest 'http://127.0.0.1:19387/api/dsh-audio-reward/state'  | Select-Object -ExpandProperty Content
```

- 返回 JSON → Host 半边正常，问题在浏览器端（刷新页面 / 看控制台报错）。
- 返回 **401** → 路由没注册，插件没激活（请求落到了 DSH 的 `/api` 网关上）。
- 连接被拒 → 端口不对，去 DSH 启动日志里看实际端口。

---

## 配置

配置写在**各插件自己的** `cordis.patch.yml` 的 `config:` 段里，改完刷新页面即可。删掉整段就回到默认值。

### dsh-balance-float

| 键 | 默认 | 说明 |
|---|---|---|
| `apiKeyRef` | `DEEPSEEK_API_KEY` | 从凭据里读哪个名字，可改成别的 |
| `pollMs` | `60000` | 余额轮询间隔（15000–3600000 毫秒） |
| `timeoutMs` | `10000` | 单次余额请求超时 |
| `utcOffsetMinutes` | `480` | 计费时区相对 UTC 的分钟数（480 = 北京时间） |
| `peakWindows` | `[[540,720],[840,1080]]` | 高峰时段，`[开始分钟, 结束分钟)`，从当地 0 点算 |

默认规则：**北京时间工作日 09:00–12:00 与 14:00–18:00 为高峰，其余时间与周末为低谷**。比如把高峰改成每天 10:00–11:00：

```yaml
        peakWindows:
          - [600, 660]
```

### dsh-audio-reward

| 键 | 默认 | 说明 |
|---|---|---|
| `audioDir` | `D:/音频` | 扫描哪个目录（**别人用请改成自己的目录**）。文件是流式读的，不会拷进插件 |
| `extensions` | `.mp3 .wav .ogg .opus .m4a .aac .flac` | 只列出、只提供这些扩展名 |
| `coalesceMs` | `600` | 一次任务响一次的去抖窗口，见下 |
| `maxEvents` | `64` | 保留多少个「完成」事件供浏览器追赶 |
| `labels` | — | 下拉里显示的名字，例如 `'ciallo.mp3': ciallo` |

**`coalesceMs` 是干什么的**：一次任务里 agent 可能结束好几个回合（它自己的 + 每个子 agent 的），每个回合都会触发一次「完成」。窗口内的多次触发会被合并成一次播放，所以一个任务只响一声。**还是响好几次就调大**（比如 `1500`），**连续两个任务被吞掉就调小**，设 `0` 表示不合并。

换音频很简单：把文件丢进 `audioDir` 即可，不用改代码。想固定显示名就在 `labels` 里加一条。

---

## 用起来

### 浮窗

| 手势 | 效果 |
|---|---|
| **在浮窗内任意位置长按**（约 280ms） | 开始拖动，接着移动即可摆放 |
| 快速拖动（位移超过 12px） | 同样开始拖动，不用等长按 |
| 短按金额 | 立刻刷新余额 |
| 短按右上角 ▾ | 折叠 / 展开成一个小胶囊 |
| `Tab` 聚焦浮窗后按方向键 | 微调位置（`Shift` 加速） |

拖动过的那次点击会被忽略，所以拖完不会顺手把浮窗折叠掉。位置和折叠状态记在浏览器里；窗口变小时浮窗会自动拉回可视范围。

想换外观**不用改代码**：覆盖 `--dbf-*` 变量即可，清单见 [dsh-balance-float/README.md](dsh-balance-float/README.md#皮肤与动图扩展位)。也能挂一张动图当伴侣：

```js
const api = window.__DSH_BALANCE_FLOAT__
api.setStage({ src: '/path/to/idle.gif' })
api.on('period', ({ period }) => api.setStage({ src: period === 'peak' ? '/peak.gif' : '/idle.gif' }))
```

### 完成音效

刷新页面后浮窗底部会多一行：`完成音效 [ 音频 ▾ ] [试听]`。

- 下拉选音频，或选「关闭」。
- **第一次可能没声音**：浏览器只允许「用户操作之后」播放声音，而这个音效是 agent 完成时自动触发的。这时面板会提示「浏览器拦截了自动播放 · 点击页面任意处启用」，你随便点一下页面，那一声音效会自动补播一次。想提前解除限制就点一下「试听」。

---

## 卸载

```powershell
dsh plugin --profile web remove dsh-balance-float
dsh plugin --profile web remove dsh-audio-reward
```

Desktop 版把 `dsh` 换成 `& '<dsh-desktop>'`、`web` 换成 `desktop`。卸载后刷新页面。浮窗留下的浏览器存储以 `dsh-balance-float:` / `dsh-audio-reward:` 开头，想清干净可在控制台删掉。

---

## 排错

| 现象 | 处理 |
|---|---|
| 页面完全看不到浮窗 | 插件没激活。刷新页面看控制台；DSH 启动时若条目没激活，加载页会直接列出插件名和原因 |
| 浮窗显示「未配置 API Key」 | 按[第 3 步](#3-配好-api-key只有余额插件需要)配好 key |
| 浮窗显示「余额不可用」 | `/user/balance` 请求失败。看 DSH 日志里的 `[dsh-balance-float] 余额查询失败: …`；`401` 说明 key 无效 |
| 浮窗卡住拖不动 | 控制台跑 `__DSH_BALANCE_FLOAT__.getDiagnostics()`，把结果发出来（里面记录了拖动时用的参照盒与边界） |
| 面板显示「音频目录里没有可用的音频」 | `audioDir` 写错了或里面没有受支持的音频。`node dsh-audio-reward/scripts/verify-env.mjs` 会告诉你找到了几个 |
| 一个任务响好几次 | 调大 `coalesceMs` |
| 改了 `client.js` 但页面行为没变 | 刷新页面；还不行就重启 DSH（重启一定生效） |
| `--dump-config` 对 desktop profile 报错 | 预期行为：desktop profile 由桌面应用独占 |

---

## 隐私

- **仓库里没有任何凭据。** API Key 只在运行时由 DSH 进程读取，浏览器端拿不到；插件的日志和 HTTP 响应里都不会出现它。
- 插件的 HTTP 路由做了**同源校验**（拒绝跨站请求），但和 DSH 里其它插件路由一样**不校验页面会话凭据**。也就是说：能访问 DSH 端口的本机程序可以读到余额快照和音频列表。DSH 默认只绑 `127.0.0.1`，别把端口暴露到局域网就行。
- 音频路由只提供 `audioDir` 里白名单扩展名的文件，路径穿越有测试守着（目录外的名字一律 404）。

---

## 开发

```powershell
npm test                 # 42 个单元测试，不需要网络、不需要凭据、不需要 DSH
```

想改代码、加插件，或者你是接手这个仓库的 AI 会话，请看：

- **[docs/plugin-contract.md](docs/plugin-contract.md)** —— DSH 插件接口的实测速查（包清单、Host / 浏览器半边、路由匹配、插槽、会话事件），以及怎么自己从 DSH 安装目录里核对。
- **[docs/development.md](docs/development.md)** —— 两个插件的架构、常见改法的对照表、测试与验证脚本、仓库结构的来龙去脉。

## 许可

MIT。

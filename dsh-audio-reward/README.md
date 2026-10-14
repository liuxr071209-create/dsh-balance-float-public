# dsh-audio-reward · 完成音效

DeepSeek Harness 的一个插件：**agent 完成一轮任务后播放一段音频**。音频可以是 `ciallo`、`爱坤`，或者你自己丢进目录里的任何音频；**选择器就长在余额浮窗里**（由 [dsh-balance-float](../dsh-balance-float) 提供的 `registerPanel` 扩展点承载），所以不额外占屏幕。

```
┌───────────────────────────┐
│ ●  账户余额            ▾  │
│ ¥ 12.34                   │
│ ● 高峰计价  至 12:00       │
│ 赠送 3.70   充值 8.54      │
├───────────────────────────┤   ← 浮窗里的插件面板区
│ 完成音效  [ 爱坤  ▾ ] [试听] │
└───────────────────────────┘
```

## 组成

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：监听 `session/event` 里的 `turn/end`、合并连发、列出音频库、流式提供音频文件 |
| `client.js` | 浏览器半边：轮询 cue、播放选中音频、把选择器注册进余额浮窗 |
| `cordis.patch.yml` | bundle patch：插入插件行，音频目录 / 自带音频 / 合并窗口 / 标签都在这里配 |
| `audio/` | **自带的音频**，别人装完即可用（见下） |
| `test/` | 21 个单元测试（不需要网络、不需要音频目录、不需要 DSH） |
| `scripts/verify-env.mjs` | 环境验证：清单/patch 形状、两个音频来源各找到什么、运行中 DSH 的路由与 bundle |
| `scripts/make-chime.mjs` | 生成 `audio/chime.wav`（`npm run chime`），纯正弦合成，不依赖任何素材 |

分工：**Host 监听会话事件、读磁盘**；**浏览器播放**。密钥、路径、文件句柄都不进浏览器。

## 自带音频（装完即用）

`audio/` 里放了三个文件，所以**不配任何东西也能出声**：

| 文件 | 来源 |
|---|---|
| `chime.wav` | 由 `scripts/make-chime.mjs` 合成（两音正弦 + 指数衰减），**没有第三方版权** |
| `ciallo.mp3` | 作者提供的梗音 |
| `aikun.mp3` | 作者提供的梗音 |

默认 `bundledAudio: fallback`：**你自己的 `audioDir` 里只要有可用音频，就只用你自己的**；目录不存在或为空时才用自带的。想让两边都出现在下拉里，把它改成 `merge`；想完全关掉自带音频就改成 `off`。

默认播放哪个由 `defaultTrack` 决定（出厂值是中性的 `chime.wav`，不是梗音）。

## 安装

见[仓库根 README 的安装一节](../README.md#安装)。简要版：

```powershell
dsh plugin --profile web add '<clone>/dsh-audio-reward'                    # Web 版
& '<dsh-desktop>' plugin --profile desktop add '<clone>/dsh-audio-reward'   # Desktop 版
```

装完**刷新页面**。装了之后如果改了 `index.js` 或配置，要**重启 DSH** 才生效。

**依赖**：这个插件把选择器注册进余额浮窗，所以要同时装 [dsh-balance-float](../dsh-balance-float)。没装也能跑（音频照样播），只是没有界面可点，只能靠 `localStorage` 或控制台 API 设置。

## 配置

都在本包 `cordis.patch.yml` 的 `config` 段里；删掉整段即回默认值。

| 键 | 默认 | 说明 |
|---|---|---|
| `audioDir` | `D:/音频` | 你自己的音频目录，**优先使用**（**别人用请改成自己的目录**）。文件是**流式读**的，不会拷进包里；目录不存在也没关系 |
| `bundledAudio` | `fallback` | `fallback` / `merge` / `off`，见上 |
| `defaultTrack` | `chime.wav` | 默认播哪个（按文件名）；名字不在列表里就退回第一个 |
| `extensions` | `.mp3 .wav .ogg .opus .m4a .aac .flac` | 只有列出的扩展名会被列出和提供 |
| `coalesceMs` | `600` | 尾随合并窗口：一次任务可能关掉好几个 turn（agent 自己的 + 每个子 agent 的），窗口内只发一个 cue。**任务仍响多次就调大，连续两次任务被吞掉就调小，设 `0` 表示不合并** |
| `maxEvents` | `64` | 保留多少个 cue 供浏览器追赶 |
| `labels` | 见 `cordis.patch.yml` 内注释 | 下拉里显示的名字。没配的名字会自动去掉 `_[…]` 这类来源噪音 |

换音频只需把文件丢进 `audioDir`，浏览器每 5 分钟重读一次目录；想立刻生效在控制台跑 `__DSH_AUDIO_REWARD__.reload()`，或刷新页面。

## 音频文件、路径与安全

- 文件名必须是**单个路径段**：`..`、`a/b`、绝对路径、反斜杠一律拒绝，且解析后必须**正好落在 `audioDir` 里**（不是"在其之下"）。
- 目录外的名字、非白名单扩展名、目录本身、空文件、超过 32 MiB 的文件，全部返回同一个 `404` —— 外部调用者无法用它探测文件系统。
- 路由只接受**同源**请求（校验 `Origin` / `Sec-Fetch-Site`），并且会处理 `Range:` 请求（`<audio>` 打开时可能发 Range，重播/拖动进度也依赖它）。
- 目录路径不会出现在任何响应里。

## 两个真实约束

1. **浏览器自动播放策略**：cue 是 Host 事件触发的，不是用户点的，所以 `play()` 可能被拒。这时浮窗面板会显示「浏览器拦截了自动播放 · 点击页面任意处启用」，并在你**下一次点击或按键**时自动重试那个 cue（只重试一次，不会重复播）。
2. **子 agent**：子 agent 的 turn 也会产生 `turn/end`，所以有 `coalesceMs` 做尾随合并。一个任务里的 N 个 turn 只会响一次。

## 公开 API

`window.__DSH_AUDIO_REWARD__`：

| 成员 | 说明 |
|---|---|
| `getState()` | `{ tracks, track, enabled, status, error, cursor, attached }` |
| `setTrack(name)` | 选择音频；传 `''` 等于关闭 |
| `preview()` | 试听当前选中项（这次点击本身就能解开自动播放限制） |
| `reload()` | 立刻重读音频目录 |
| `flushPending()` | 立刻播放那个在等用户手势的 cue |

事件状态 `status`：`loading` / `idle` / `playing` / `blocked` / `empty` / `error`。

## 验证

```powershell
cd <repo>\dsh-audio-reward
node --test                     # 19 个单元测试：目录与路径守卫、Range、cue 合并、路由、面板注册、自动播放被拒
node scripts\verify-env.mjs     # 清单/patch、真实音频目录、运行中 DSH 的路由与 bundle
```

装完可以直接查 Host：

```powershell
Invoke-WebRequest 'http://127.0.0.1:19387/api/dsh-audio-reward/state'  | Select-Object -ExpandProperty Content
Invoke-WebRequest 'http://127.0.0.1:19387/api/dsh-audio-reward/events?since=0' | Select-Object -ExpandProperty Content
```

## 出错时看哪里

| 现象 | 原因与处理 |
|---|---|
| 面板显示「音频目录里没有可用的音频」 | `audioDir` 里没有白名单扩展名的文件，或路径写错了（`verify-env.mjs` 会直接告诉你找到了几个） |
| 面板显示「浏览器拦截了自动播放」 | 正常现象，点一下页面任意处即可；想彻底避免就先点一次「试听」 |
| 任务完成没声音 | 先在面板里点「试听」确认能出声；再确认下拉不是「关闭」；子 agent 连发被合并是预期行为（`coalesceMs`） |
| 一次任务响了好几次 | 调大 `coalesceMs`（比如 `1500`） |
| 完全没见到面板 | 余额浮窗没装或没启用；音频仍会播放，用 `__DSH_AUDIO_REWARD__.getState()` 确认 `attached` |

## 已知边界

- 只按 `turn/end` 触发，不区分"这是个正经任务"还是"就是问了一句"。要更挑剔只能改 `index.js` 里的过滤条件。
- 两个浏览器窗口同时开着，两边都会响。
- 音频文件是从磁盘实时读的；文件正在被别的程序改写时可能读到半个文件（会返回 `404` 或截断的内容，不会崩）。
- 不做音量控制、不做淡入淡出、不做播放队列。

## 许可

MIT。

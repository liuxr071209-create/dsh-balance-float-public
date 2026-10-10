# dsh-plugins · DeepSeek Harness plugins

**English** · [简体中文](README.md)

Two web plugins for [DeepSeek Harness](https://github.com/deepseek-ai) ("DSH"), distributed from one repository:

| Plugin | What it does |
|---|---|
| **[dsh-balance-float](dsh-balance-float/)** | A draggable, collapsible window showing your account balance and whether the current billing period is **peak** or **off-peak** |
| **[dsh-audio-reward](dsh-audio-reward/)** | Plays a short clip when the agent finishes a task; its clip chooser lives inside the window above |

```
┌───────────────────────────┐
│ ●  Balance             ▾  │   ← press and hold anywhere to drag
│ ¥ 12.34                   │   ← click to refresh
│ ● Peak rate   until 12:00 │
│ Granted 4.85  Top-up 8.54 │
├───────────────────────────┤
│ Finish cue  [ clip ▾ ] [▶] │   ← registered by the audio plugin
└───────────────────────────┘
```

They are independent: install either one. Install **both** to get the chooser in the window (the audio plugin still plays without it — you just have no UI, only a console API).

## Requirements

- **DSH `0.2.0-rc.2`** (the version these were built and verified against). Plugin interfaces change between release candidates.
- The ability to run `dsh plugin --profile <name> add <path>`. On **DSH Desktop for Windows**, the `desktop` profile is owned by the application, so you must use its bundled CLI (see below).
- **Balance plugin only:** a DeepSeek API key configured in DSH. It reads the credential named by `apiKeyRef` (default `DEEPSEEK_API_KEY`). Without it the plugin still loads and the window says "no API key".
- **Audio plugin only:** a directory holding your audio files, set via `audioDir` (default `D:/音频` — **change it**).

Neither package has third-party dependencies, so installing needs no network access.

## Install

```powershell
git clone https://github.com/<owner>/dsh-plugins.git
```

**Web DSH** (`dsh` on your PATH):

```powershell
dsh plugin --profile web add '<clone>/dsh-balance-float'
dsh plugin --profile web add '<clone>/dsh-audio-reward'
```

**DSH Desktop for Windows** (`desktop` is owned by the app):

```powershell
& '<dsh-desktop>' plugin --profile desktop add '<clone>/dsh-balance-float'
& '<dsh-desktop>' plugin --profile desktop add '<clone>/dsh-audio-reward'
```

`<clone>` is the absolute path of your checkout. `<dsh-desktop>` is the bundled CLI, e.g. `<DSH Desktop install dir>\resources\runtime\cli\bin\dsh.cmd`.

Two things to get right:

- **Use an absolute path.** A bare `dsh-balance-float` is treated as an npm package name and 404s; a relative path resolves against the directory you ran the command from, not the repository.
- After installing, **refresh the DSH page** — the Host half hot-loads, but the browser half is only fetched on page load.

Then set your API key (Settings → Account in DSH, or the `refs` section of `%USERPROFILE%\.dsh\.credentials.yaml`, or the `DEEPSEEK_API_KEY` environment variable). The key is never written to logs or HTTP responses, and the browser never sees it.

## Configure

Each plugin's settings live in its own `cordis.patch.yml`, under `config:`. Delete that block to get the defaults back.

| `dsh-balance-float` | Default | |
|---|---|---|
| `apiKeyRef` | `DEEPSEEK_API_KEY` | which credential to read |
| `pollMs` | `60000` | balance poll interval (15000–3600000) |
| `utcOffsetMinutes` | `480` | billing time zone offset (480 = UTC+8) |
| `peakWindows` | `[[540,720],[840,1080]]` | peak windows as `[startMinute, endMinute)` from local midnight — default is UTC+8 weekdays 09:00–12:00 and 14:00–18:00, weekends all off-peak |

| `dsh-audio-reward` | Default | |
|---|---|---|
| `audioDir` | `D:/音频` | directory to scan; files are streamed, never copied into the package |
| `extensions` | `.mp3 .wav .ogg .opus .m4a .aac .flac` | only these are listed and served |
| `coalesceMs` | `600` | debounce window that collapses a burst of finished turns into one cue — one task can close several turns (one per subagent). Raise it if a task still fires more than once; lower it if two quick tasks feel swallowed; `0` disables coalescing |
| `maxEvents` | `64` | how many cues the browser can catch up on |
| `labels` | — | display names, e.g. `'ciallo.mp3': ciallo` |

Drop a file into `audioDir` to add a clip — no code change needed.

## Usage

| Gesture (window) | Effect |
|---|---|
| **Press and hold anywhere** (~280 ms) | starts a drag; move to place it |
| Quick drag (>12 px) | also starts a drag, no hold needed |
| Click the amount | refresh the balance now |
| Click ▾ | collapse to a small pill |
| Tab to the window, arrow keys | nudge it (hold Shift for bigger steps) |

The click that ends a drag is swallowed, so dragging never also collapses the window. Position and collapsed state are remembered per browser.

Appearance needs no code change: override the `--dbf-*` variables (see [dsh-balance-float/README.md](dsh-balance-float/README.md)), or attach an animation:

```js
const api = window.__DSH_BALANCE_FLOAT__
api.setStage({ src: '/path/to/idle.gif' })
api.on('period', ({ period }) => api.setStage({ src: period === 'peak' ? '/peak.gif' : '/idle.gif' }))
```

**First cue may be silent.** Browsers only allow audio after a user interaction, and a cue is triggered by the agent finishing. The panel then says the autoplay was blocked; click anywhere on the page and that one cue is replayed once. Clicking *Preview* clears the restriction up front.

## Uninstall

```powershell
dsh plugin --profile web remove dsh-balance-float
dsh plugin --profile web remove dsh-audio-reward
```

## Privacy

- **No credentials in this repository.** The API key is read at runtime by the DSH process only.
- Plugin HTTP routes are same-origin guarded but, like other DSH plugin routes, are **not** session-authenticated: a local process that can reach the DSH port can read the cached balance and the track list. DSH binds `127.0.0.1` by default — do not expose the port.
- The audio route serves only allow-listed extensions from `audioDir`; path traversal is rejected and covered by tests.

## Development

```powershell
npm test        # 42 unit tests: no network, no credentials, no audio directory, no running DSH
```

- **[docs/plugin-contract.md](docs/plugin-contract.md)** — the DSH plugin interface as verified against the installed runtime (manifest fields, both halves, route matching, slots, session events), plus how to re-verify it yourself.
- **[docs/development.md](docs/development.md)** — architecture, a "what to change where" table, the verification scripts.

## License

MIT.

# dsh-capability-aware

> Self-awareness for your DSH (DeepSeek Harness) agent: it scans what the machine can actually do,
> keeps a live inventory of capabilities, and answers "what can do what / what do I have / what may I use"
> in one line.

[中文说明见 README.md](./README.md) · Part of the DSH plugin ecosystem.

## Why

An agent that doesn't know its own machine wastes turns guessing: *is ffmpeg installed? what GPU is this?
which skill should handle Bilibili subtitles? is that connector still alive?* This plugin gives the harness
that answer in **one command or one tool call**.

## What it does

| Capability | How |
|---|---|
| **Self-awareness** | 10 probes scan the real capability terrain → fingerprint-level diff → JSON snapshot |
| **Fast lookup** | mixed CJK/Latin tokenizer + BM25-lite IDF scoring + curated alias layer + negative/disabled downweight |
| **Missing guidance** | on no-match or drift, tells you *what's missing*, *where to get it*, *how to verify* |
| **Live updates** | boot scan + filesystem watchers (debounced) + 20-min periodic fallback + daily patrol automation |

## One-line "at a glance" view

```
$ node cap.mjs brief "GPU accelerated transcription"
1. [hardware] GPU: AMD Radeon RX 7800 XT — ... ｜ call: ... ｜ who: me (primary) ｜ bounds: hardware can't be "installed"; check ROCm/DirectML support first
2. [skill]    capability-lookup — ...            ｜ call: skill_index.py query ... ｜ who: skill-use-router (I assist) ｜ bounds: ...
```

Three surfaces share the exact same line format (single source of truth):
CLI `cap.mjs brief` · HTTP `/api/capability-aware/*` · agent tool `capability_query`.

## Positioning: index draft + fallback, never a duplicate wheel

Per-domain **authority contract** — every entry carries `authority{system, strength, onFailure}` and `bounds{use, limits, prereq}`:

| Domain | Authority (use it) | This plugin |
|---|---|---|
| Skill routing / scoring / learning | **skill-use-router** | index draft (absorbed its index: 366 entries incl. sub-skills) |
| Memory item retrieval | **dsh-mneme** (`memory_search`) | registers `memory/` topic files only |
| MCP connector state / tool list | **host** (`mcp_connector_status`) | connection + tool snapshot draft |
| Scheduled tasks CRUD | **host** (`automation_list`) | name/schedule draft |
| Knowledge pages | **Hindsight** | data-dir existence only |
| **Local hardware / software / env facts** | **this plugin** (no DSH equivalent) | sole source |

- *Primary where strong* → local environment facts.
- *Assist where weak* → routing/retrieval stay with their dedicated systems; this plugin is the draft.
- *Fallback when they break* → `cap.mjs doctor` probes authority reachability and tells you when to switch to the draft (with an explicit "from index draft, not live" caveat).

## Probes (10)

`skill` · `plugin` · `mcp` · `memory` · `automation` · `knowledge` · `tool` · `env` · `hardware` · `software`

- **hardware**: single WMI pass — CPU / RAM / **physical GPUs only** (virtual display adapters such as Todesk/OrayIdd/MuMu are filtered out) / disks / OS.
- **software**: dev toolchain with exact versions (`python/node/git/uv/pnpm/gh/docker/ffmpeg/yt-dlp`) + installed-software list from the three uninstall-registry views (KB/update noise filtered).
- **env**: machine facts (console codepage, local proxy, playwright path) + web-intel channel-boundary knowledge.

## Install

```powershell
dsh plugin --profile desktop add "file:D:/path/to/dsh-capability-aware"
# then RESTART DSH — plugins are evaluated at boot, no hot-load
```

Zero runtime dependencies (no imports from `@deepseek-ai/*`), so no peer-resolution pitfalls.
Note: `file:` installs are **snapshots** — after editing the source, `remove` + `add` again.

## Usage

```powershell
node cap.mjs scan                  # full rescan + diff
node cap.mjs brief "<intent>"      # one-line at-a-glance view
node cap.mjs query "<intent>"      # matched capabilities + how to call them (+ authority/bounds)
node cap.mjs doctor                # health report + authority reachability
node cap.mjs stale                 # what disappeared since last snapshot
node cap.mjs guide "<name>" [type] # targeted "how to obtain it" guidance
node cap.mjs alias "<entry>" <aka> # curated aliases (bridges lexical gaps like A-share→stock)
```

## Verified on a real machine

- 18/18 unit tests green (`node --test`)
- Real inventory: **549 entries** — skill 366 · software 109 · env 27 · memory 16 · plugin 10 · automation 8 · hardware 7 · tool 5 · mcp 1
- Live host evidence: boot scan, **reactive watcher** (`reason="mcp/automation change (whale.json)"`) and **20-min periodic** scans all observed in a running DSH Desktop
- No secrets, no absolute personal paths in the shipped files

## License

MIT

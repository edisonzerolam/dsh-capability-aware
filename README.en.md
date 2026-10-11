# dsh-efficiency · DSH Efficiency Machine

> Self-awareness **and** self-observation for your DSH (DeepSeek Harness) agent:
> it scans what the machine can actually do, watches how the host is actually running,
> and turns every error the agent has ever hit into a ranked, fixable work list.

[中文说明见 README.md](./README.md) · Part of the DSH plugin ecosystem.

## The three jobs (v0.9.0)

**① Index & fast-locate tools / plugins / env / interfaces** — so other plugins can reuse the host.
Beyond the capability inventory, v0.9.0 adds an **interface surface** (`lib/interfaces.js`):
host Cordis services (13 known services + runtime `ctx.get` probing for real `available` values),
Typert Remote methods (statically extracted from each package's `lib/typert.host.js`),
19 client UI slots (each with **semantically specific triggers**, otherwise retrieval degenerates into
arbitrary ties) and HTTP route prefixes — **174 interface entries** measured, all `type: 'interface'`,
riding the same retrieval pipeline as capability entries.

**② Monitor runtime resource scheduling; prevent hangs and crashes** — `lib/monitor/`.
The **process layer** reads Win32 directly through koffi FFI (`OpenProcess` / `GetProcessTimes` /
`K32GetProcessMemoryInfo` / `GetProcessIoCounters`); the **session layer** diffs the host's official
`sessionStats` projection; the **plugin layer** reads loader entries' Fiber phase. One heartbeat
(3 s default, backing off to 10 s when idle) + bounded ring storage (20 000 samples, block trimming)
+ **self-cost disclosure** (`process.cpuUsage`, measured **0.000%** per tick).
Six detection rules `PLUGIN_FAILED`(P0) / `PROCESS_GONE` / `HOT_PROCESS` / `MEMORY_GROWTH` /
`IO_STORM` / `SESSION_STALL`, each carrying `evidence.basis` — the discipline is
**better to miss than to false-alarm** (threshold rules need N consecutive hits plus a cooldown window).

**③ Record every error → tiered diagnosis → fix prompt** — `lib/diagnose.js` merges the error ledger
with monitor events into a **versioned diagnostic envelope**
(schema `dsh-efficiency/diagnostics/v1`, following the dshmarket diagnostics convention), tiered by
**certainty, not severity**: **P0** the host/loader itself reported it · **P1** locally fixable with
sufficient evidence · **P2** needs inference or low impact · **P3 not this machine's to fix**
(provider rate limits / quota / transport / network). On a real 13 303-record ledger: 151 findings
`{P0:1, P1:21, P2:104, P3:25}`, `fixable=126`; **provider-class errors are 40.6% of all records**
(RATE_LIMIT 2794 + SERVER 1115 + TIMEOUT 402 + TRANSPORT 283 …) — which is exactly why P3 exists.
`lib/fixprompt.js` produces a prompt you can paste into a fresh session (with an "identify yourself first"
preamble so it isn't applied to the **wrong** DSH instance), and **only generates text — it never
executes a fix**. P3 is marked "do not touch" and never enters the fixable list.

**Five surfaces**: three resident prompt sections (`efficiency:capability-index` 2950 /
`efficiency:error-index` 2951 / `efficiency:resource-index` 2952) + agent tools
(`efficiency_query`, `error_ledger_query`) + RPC (`/api/efficiency/*`, incl. read-only `/diagnose`
and `/fixprompt`) + CLI + the self-provisioned skill.

**Honest boundaries (written into the prompt text, not left to good intentions)**: the process layer is a
**measurement**, but several plugins share one process, so it **cannot be attributed to a single plugin**;
the plugin layer is a **relevance ranking, not CPU attribution** (DSH exposes no per-plugin resource
metering); session-layer deltas are "since this plugin last read", **not the host's official billing basis**;
error↔resource correlation is **correlation, not causation** (the field is literally named `correlatedWith`).

### Self-provisioning (install-and-get)

- **Skill entry** (on by default): on first boot after install, the plugin writes the `efficiency-lookup`
  skill into `~/.dsh/skills/` (idempotent, version-stamped) — the harness skill catalog picks it up
  automatically, zero manual configuration.
- **AGENTS.md pointer** (off by default — it edits a user file, so it requires an explicit
  `provisionAgentsPointer: true`): injects a marker-managed block. Idempotent, auto-refreshed on upgrade,
  and it **retires the previous brand's block** rather than stacking a second one.

## Why

An agent that doesn't know its own machine wastes turns guessing: *is ffmpeg installed? what GPU is this?
which skill should handle Bilibili subtitles? is that connector still alive?* And an agent that can't see
its own runtime can't answer *why is this slow? did this plugin ever load? am I leaking memory?*
This plugin gives the harness both answers in **one command or one tool call**.

## What it does

| Capability | How |
|---|---|
| **Self-awareness** | 10 probes scan the real capability terrain → fingerprint-level diff → JSON snapshot |
| **Interface surface** (v0.9.0) | host Cordis services + Typert Remotes + 19 client slots + route prefixes → `type:'interface'` entries |
| **Fast lookup** | mixed CJK/Latin tokenizer + BM25-lite IDF scoring + curated alias layer + negative/disabled downweight |
| **Missing guidance** | on no-match or drift, tells you *what's missing*, *where to get it*, *how to verify* |
| **Error ledger** (v0.8.0) | live `session/event` subscription + historical backfill → ten-facet aggregation → self-repair candidates (`owner=local` only) |
| **Resource monitor** (v0.9.0) | koffi FFI process layer + session projection diffs + plugin Fiber phase → 3 s heartbeat, bounded ring, six detection rules |
| **Tiered diagnosis** (v0.9.0) | ledger records + monitor events → versioned envelope, tiered P0–P3 by **certainty** |
| **Fix prompt** (v0.9.0) | diagnostics → a paste-ready prompt for a fresh session (identity preamble included; **generates text only**) |
| **Live updates** | boot scan + filesystem watchers (debounced) + 20-min periodic fallback + daily patrol automation |

## One-line "at a glance" view

```
$ node cap.mjs brief "GPU accelerated transcription"
1. [hardware] GPU: AMD Radeon RX 7800 XT — ... ｜ call: ... ｜ who: me (primary) ｜ bounds: hardware can't be "installed"; check ROCm/DirectML support first
2. [skill]    efficiency-lookup — ...            ｜ call: skill_index.py query ... ｜ who: skill-use-router (I assist) ｜ bounds: ...
```

Three surfaces share the exact same line format (single source of truth):
CLI `cap.mjs brief` · HTTP `/api/efficiency/*` · agent tool `efficiency_query`.

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
dsh plugin --profile desktop add "file:D:/path/to/dsh-efficiency"
```

> **When changes take effect** (measured, 2026-10-11):
> - **First install**: the host watches profile changes and re-applies immediately — no restart.
> - **Updating an already-installed plugin's code**: `remove` + `add` only refreshes the on-disk copy and
>   re-applies; it does **not** run the new code. Modules load via `import()`, and Node's ESM cache is keyed
>   by resolved URL — the same path is evaluated once per process. **Changing code requires restarting
>   DSH Desktop** (tray menu → Restart, or `POST /api/desktop/restart`).

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
node cap.mjs interface             # interface surface: services / Typert Remotes / client slots / routes
node cap.mjs monitor --live        # resource monitor: sample the whole process tree right now
node cap.mjs diagnose              # tiered diagnosis: P0–P3 by certainty
node cap.mjs fixprompt             # generate a fix prompt (text only — nothing is executed)
```

Data lives under `~/.dsh/data/efficiency/` — `capabilities.json`, `ledger/` (`events.v1.jsonl`),
`monitor/` (`monitor.v1.jsonl` + `events.v1.jsonl`). One plugin, one data directory.

## Verified on a real machine

- **199/199 unit tests green** (`npm test` → `node --test test/capability.test.mjs test/ledger.test.mjs test/efficiency.test.mjs`; 44 + 55 + 100)
- Real inventory: **549 entries** — skill 366 · software 109 · env 27 · memory 16 · plugin 10 · automation 8 · hardware 7 · tool 5 · mcp 1
  (plus **174** interface entries from the v0.9.0 surface)
- Live host evidence: boot scan, **reactive watcher** (`reason="mcp/automation change (whale.json)"`), **20-min periodic** scans, real `session/event` error capture, a **13 303-record** ledger backfilled from 1.2 GB of session logs in 22.7 s, and a **0.000% self-cost** heartbeat measured in-process
- No secrets, no absolute personal paths in the shipped files

## License

MIT

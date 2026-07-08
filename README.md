# codex-awake

Small TypeScript CLI that scans CPA Codex auth files, refreshes quota metadata from ChatGPT's Codex usage endpoint, stores observations in SQLite, and wakes likely dormant accounts through the official `codex exec` CLI.

## Quick Start

```powershell
npm install
npm run build
npm run start -- doctor
npm run start -- scan --dry-run
npm run start -- run --limit-probes 1
npm run show-quota-resets
npm run set-cpa-priorities
```

The default auth directory is `C:\Users\wuuconix\.cli-proxy-api`; override settings with `codex-awake.config.json`.
Quota refresh uses `proxyUrl` when configured, otherwise it falls back to `HTTPS_PROXY`, `HTTP_PROXY`, or `ALL_PROXY`.

## Commands

- `doctor`: checks auth directory, SQLite setup, Codex CLI, and endpoint reachability.
- `scan`: refreshes quota metadata and stores wake candidates without probing.
- `probe-candidates`: probes stored pending candidates.
- `run`: performs `scan` followed by `probe-candidates`.
- `show`: prints recent accounts, candidates, snapshots, and probe runs.
- `show-quota-resets`: prints each account's latest quota reset time, sorted earliest first.
- `set-cpa-priorities`: sets CPA Codex auth file priorities from SQLite quota reset times without refreshing quotas, disables files whose latest quota is exhausted, re-enables disabled files when quota is available, and removes priority fields from disabled files.

All commands accept `--config <path>`. Commands that would wake accounts also accept `--dry-run` and `--limit-probes <n>`.
For one-off experiments, `run` and `probe-candidates` also accept `--probe-model <model>` and `--probe-prompt <prompt>`.

## Safety Notes

- Access tokens are read from CPA auth files but are not logged or stored in SQLite.
- Probe execution is serialized globally and waits at least `probeMinIntervalMs` between starts.
- `codex exec` runs with an isolated temporary `CODEX_HOME` under `codexHomeParentDir` instead of the system temp directory.
- A hung `codex exec` is killed after `probeTimeoutMs` and recorded as a failed probe instead of blocking the run forever.
- Probe subprocesses clear `OPENAI_API_KEY`/provider env vars, force ChatGPT auth in the temporary config, and store the Codex CLI output summary in `probe_runs.output`.
- After a probe, quota verification waits `probeVerifyDelayMs` and retries `probeVerifyAttempts` times with `probeVerifyIntervalMs` between attempts. It uses `probeVerifyToleranceSeconds` to decide whether a reset window is still effectively full.

## Windows Task Scheduler

After `npm install` and `npm run build`, schedule this command from the project directory:

```powershell
npm run start -- run
```

For first rollout, use a small batch:

```powershell
npm run start -- run --dry-run --limit-accounts 5
npm run start -- run --limit-accounts 5 --limit-probes 1
npm run start -- run --limit-probes 1 --probe-model gpt-5.5 --probe-prompt "Reply with exactly OK."
```

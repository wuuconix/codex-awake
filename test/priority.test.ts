import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAuthAccounts } from '../src/auth.js';
import type { LatestQuotaSnapshotRow } from '../src/db.js';
import { applyCpaPriorityPlan, buildCpaPriorityPlan } from '../src/priority.js';

const observedAtMs = 1_800_000_000_000;

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
}

function snapshot(accountKey: string, fileName: string, resetAtMs: number, usedPercent = 50): LatestQuotaSnapshotRow {
  return {
    accountKey,
    email: accountKey,
    fileName,
    planType: null,
    disabled: 0,
    statusCode: 200,
    ok: 1,
    observedAtMs,
    createdAtMs: observedAtMs,
    windowsJson: JSON.stringify([
      {
        scope: 'rate_limit.primary_window',
        kind: 'weekly',
        resetAtMs,
        remainingSeconds: (resetAtMs - observedAtMs) / 1000,
        limitWindowSeconds: 604_800,
        usedPercent
      }
    ]),
    error: null
  };
}

describe('CPA priority assignment', () => {
  it('sets priorities and syncs disabled state from quota availability', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-awake-priority-test-'));
    try {
      const files = {
        soon: path.join(dir, 'codex-soon.json'),
        later: path.join(dir, 'codex-later.json'),
        missing: path.join(dir, 'codex-missing.json'),
        exhausted: path.join(dir, 'codex-exhausted.json'),
        disabledAvailable: path.join(dir, 'codex-disabled-available.json'),
        disabledCleanup: path.join(dir, 'codex-disabled-cleanup.json')
      };

      await writeFile(files.soon, JSON.stringify({ type: 'codex', email: 'soon@example.com', access_token: 'soon' }));
      await writeFile(files.later, JSON.stringify({ type: 'codex', email: 'later@example.com', access_token: 'later' }));
      await writeFile(
        files.missing,
        JSON.stringify({ type: 'codex', email: 'missing@example.com', access_token: 'missing', priority: 9 })
      );
      await writeFile(
        files.exhausted,
        JSON.stringify({ type: 'codex', email: 'exhausted@example.com', access_token: 'exhausted', priority: 99 })
      );
      await writeFile(
        files.disabledAvailable,
        JSON.stringify({
          type: 'codex',
          email: 'disabled-available@example.com',
          access_token: 'disabled-available',
          disabled: true,
          priority: 99
        })
      );
      await writeFile(
        files.disabledCleanup,
        JSON.stringify({
          type: 'codex',
          email: 'disabled-cleanup@example.com',
          access_token: 'disabled-cleanup',
          disabled: true,
          priority: 88
        })
      );

      const accounts = await loadAuthAccounts(dir);
      const plan = buildCpaPriorityPlan(accounts, [
        snapshot('soon@example.com', 'codex-soon.json', observedAtMs + 60_000),
        snapshot('later@example.com', 'codex-later.json', observedAtMs + 120_000),
        snapshot('exhausted@example.com', 'codex-exhausted.json', observedAtMs + 180_000, 100),
        snapshot('disabled-available@example.com', 'codex-disabled-available.json', observedAtMs + 90_000, 25),
        snapshot('deleted@example.com', 'codex-deleted.json', observedAtMs + 1)
      ]);

      expect(plan.map((item) => [item.account.email, item.priority, item.disabled, item.reason])).toEqual([
        ['soon@example.com', 3, false, 'reset-known'],
        ['disabled-available@example.com', 2, false, 'disabled-with-quota'],
        ['later@example.com', 1, false, 'reset-known'],
        ['missing@example.com', 0, false, 'missing-reset'],
        ['disabled-cleanup@example.com', 0, true, 'disabled-cleanup'],
        ['exhausted@example.com', 0, true, 'quota-exhausted']
      ]);

      const results = await applyCpaPriorityPlan(plan);
      expect(results.filter((item) => item.changed)).toHaveLength(6);

      await expect(readJson(files.soon)).resolves.toMatchObject({ priority: 3, websockets: true });
      await expect(readJson(files.later)).resolves.toMatchObject({ priority: 1, websockets: true });
      const missing = await readJson(files.missing);
      expect(missing).not.toHaveProperty('priority');
      expect(missing).toMatchObject({ websockets: true });
      const exhausted = await readJson(files.exhausted);
      expect(exhausted).toMatchObject({ disabled: true });
      expect(exhausted).not.toHaveProperty('priority');
      expect(exhausted).not.toHaveProperty('websockets');
      const disabledAvailable = await readJson(files.disabledAvailable);
      expect(disabledAvailable).toMatchObject({ priority: 2, websockets: true });
      expect(disabledAvailable).not.toHaveProperty('disabled');
      const disabledCleanup = await readJson(files.disabledCleanup);
      expect(disabledCleanup).toMatchObject({ disabled: true });
      expect(disabledCleanup).not.toHaveProperty('priority');
      expect(disabledCleanup).not.toHaveProperty('websockets');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

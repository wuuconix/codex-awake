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

function snapshot(accountKey: string, fileName: string, resetAtMs: number): LatestQuotaSnapshotRow {
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
        usedPercent: 50
      }
    ]),
    error: null
  };
}

describe('CPA priority assignment', () => {
  it('sets higher priorities for nearer quota resets and skips disabled files', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-awake-priority-test-'));
    try {
      const files = {
        soon: path.join(dir, 'codex-soon.json'),
        later: path.join(dir, 'codex-later.json'),
        missing: path.join(dir, 'codex-missing.json'),
        disabled: path.join(dir, 'codex-disabled.json')
      };

      await writeFile(files.soon, JSON.stringify({ type: 'codex', email: 'soon@example.com', access_token: 'soon' }));
      await writeFile(files.later, JSON.stringify({ type: 'codex', email: 'later@example.com', access_token: 'later' }));
      await writeFile(
        files.missing,
        JSON.stringify({ type: 'codex', email: 'missing@example.com', access_token: 'missing', priority: 9 })
      );
      await writeFile(
        files.disabled,
        JSON.stringify({
          type: 'codex',
          email: 'disabled@example.com',
          access_token: 'disabled',
          disabled: true,
          priority: 99
        })
      );

      const accounts = await loadAuthAccounts(dir);
      const plan = buildCpaPriorityPlan(accounts, [
        snapshot('soon@example.com', 'codex-soon.json', observedAtMs + 60_000),
        snapshot('later@example.com', 'codex-later.json', observedAtMs + 120_000),
        snapshot('deleted@example.com', 'codex-deleted.json', observedAtMs + 1)
      ]);

      expect(plan.map((item) => [item.account.email, item.priority, item.reason])).toEqual([
        ['soon@example.com', 2, 'reset-known'],
        ['later@example.com', 1, 'reset-known'],
        ['missing@example.com', 0, 'missing-reset']
      ]);

      const results = await applyCpaPriorityPlan(plan);
      expect(results.filter((item) => item.changed)).toHaveLength(3);

      await expect(readJson(files.soon)).resolves.toMatchObject({ priority: 2 });
      await expect(readJson(files.later)).resolves.toMatchObject({ priority: 1 });
      expect(await readJson(files.missing)).not.toHaveProperty('priority');
      await expect(readJson(files.disabled)).resolves.toMatchObject({ priority: 99, disabled: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

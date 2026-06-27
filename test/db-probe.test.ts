import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from '../src/db.js';
import { probeCandidates } from '../src/probe.js';
import type { AppConfig, AuthAccount, WakeCandidate } from '../src/types.js';

const account: AuthAccount = {
  accountKey: 'acct',
  authIndex: 'idx',
  filePath: 'a.json',
  fileName: 'a.json',
  email: 'a@example.com',
  accountId: 'acct',
  planType: null,
  disabled: false,
  accessToken: 'token',
  idToken: 'id',
  refreshToken: 'refresh',
  rawAuth: {}
};

const candidate: WakeCandidate = {
  accountKey: 'acct',
  authIndex: 'idx',
  fileName: 'a.json',
  accountId: 'acct',
  email: 'a@example.com',
  reason: 'weekly window still has a full reset duration',
  windowScope: 'rate_limit.secondary_window',
  windowKind: 'weekly',
  remainingSeconds: 604_800,
  limitWindowSeconds: 604_800,
  usedPercent: 0
};

describe('sqlite and probe queue', () => {
  it('stores candidates and dry-runs probe queue without executing codex', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-awake-db-test-'));
    const store = openStore(path.join(dir, 'test.sqlite'));
    try {
      store.upsertAccount(account);
      store.replaceCandidates('run-test', [candidate]);
      const pending = store.listPendingCandidates();
      expect(pending).toHaveLength(1);
      const config: AppConfig = {
        authDir: dir,
        dbPath: path.join(dir, 'test.sqlite'),
        quotaUrl: 'https://chatgpt.com/backend-api/wham/usage',
        quotaConcurrency: 1,
        quotaDelayMs: 0,
        quotaTimeoutMs: 1000,
        proxyUrl: null,
        probeMinIntervalMs: 180_000,
        probeCooldownMs: 86_400_000,
        probeTimeoutMs: 120_000,
        dormantToleranceSeconds: 180,
        dormantMaxUsedPercent: 5,
        probeModel: 'gpt-5.4-mini',
        probePrompt: 'hi',
        codexBin: 'codex',
        userAgent: 'test'
      };
      const results = await probeCandidates(pending, [account], config, store, { dryRun: true });
      expect(results).toHaveLength(1);
      expect(results[0]!.status).toBe('skipped');
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

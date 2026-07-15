import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { buildWakeCandidates, buildWakeCandidatesFromSnapshot, collectQuotaWindows, refreshQuotas } from '../src/quota.js';
import type { AppConfig, AuthAccount, QuotaFetchResult, QuotaSnapshot } from '../src/types.js';

const observedAtMs = 1_700_000_000_000;

describe('quota parsing', () => {
  it('normalizes reset_at seconds and monthly windows', () => {
    const resetAt = observedAtMs / 1000 + 30 * 86_400;
    const windows = collectQuotaWindows(
      {
        rate_limit: {
          secondary_window: {
            used_percent: 0,
            limit_window_seconds: 30 * 86_400,
            reset_at: resetAt
          }
        }
      },
      observedAtMs
    );
    expect(windows[0]).toMatchObject({
      kind: 'monthly',
      resetAtMs: resetAt * 1000,
      remainingSeconds: 30 * 86_400
    });
  });

  it('parses reset_after_seconds and additional weekly windows', () => {
    const windows = collectQuotaWindows(
      {
        additional_rate_limits: [
          {
            limit_name: 'extra',
            rate_limit: {
              primary_window: {
                limit_window_seconds: 604_800,
                reset_after_seconds: 604_800
              }
            }
          }
        ]
      },
      observedAtMs
    );
    expect(windows[0]).toMatchObject({
      scope: 'additional_rate_limits.extra.primary_window',
      kind: 'weekly',
      remainingSeconds: 604_800
    });
  });
});

describe('candidate detection', () => {
  const baseResult: QuotaFetchResult = {
    account: {
      accountKey: 'acct',
      authIndex: 'idx',
      filePath: 'a.json',
      fileName: 'a.json',
      email: 'a@example.com',
      accountId: 'acct',
      planType: null,
      disabled: false,
      accessToken: 'token',
      idToken: null,
      refreshToken: null,
      rawAuth: {}
    },
    statusCode: 200,
    ok: true,
    observedAtMs,
    planType: null,
    subscriptionActiveUntil: null,
    bodySummary: null,
    error: null,
    windows: []
  };

  it('detects full weekly window candidates', () => {
    const candidates = buildWakeCandidates(
      {
        ...baseResult,
        windows: [
          {
            scope: 'rate_limit.secondary_window',
            kind: 'weekly',
            usedPercent: 0,
            limitWindowSeconds: 604_800,
            resetAtMs: null,
            resetAfterSeconds: 604_800,
            remainingSeconds: 604_800
          }
        ]
      },
      180,
      5,
      false
    );
    expect(candidates).toHaveLength(1);
  });

  it('skips windows outside tolerance or recent probe cooldown', () => {
    const result = {
      ...baseResult,
      windows: [
        {
          scope: 'rate_limit.secondary_window',
          kind: 'weekly' as const,
          usedPercent: 0,
          limitWindowSeconds: 604_800,
          resetAtMs: null,
          resetAfterSeconds: 604_000,
          remainingSeconds: 604_000
        }
      ]
    };
    expect(buildWakeCandidates(result, 180, 5, false)).toHaveLength(0);
    expect(
      buildWakeCandidates(
        {
          ...result,
          windows: [{ ...result.windows[0]!, remainingSeconds: 604_800, resetAfterSeconds: 604_800 }]
        },
        180,
        5,
        true
      )
    ).toHaveLength(0);
  });

  it('allows low baseline used_percent for dormant free accounts', () => {
    const candidates = buildWakeCandidates(
      {
        ...baseResult,
        windows: [
          {
            scope: 'rate_limit.primary_window',
            kind: 'monthly',
            usedPercent: 5,
            limitWindowSeconds: 2_592_000,
            resetAtMs: null,
            resetAfterSeconds: 2_592_000,
            remainingSeconds: 2_592_000
          }
        ]
      },
      180,
      5,
      false
    );
    expect(candidates).toHaveLength(1);
  });

  it('selects candidates from persisted quota data without fetching quota again', () => {
    const snapshot: QuotaSnapshot = {
      statusCode: 200,
      ok: 1,
      observedAtMs,
      createdAtMs: observedAtMs,
      planType: null,
      windowsJson: JSON.stringify([
        {
          scope: 'rate_limit.secondary_window',
          kind: 'weekly',
          usedPercent: 0,
          limitWindowSeconds: 604_800,
          resetAtMs: null,
          resetAfterSeconds: 604_800,
          remainingSeconds: 604_800
        }
      ]),
      error: null
    };
    expect(buildWakeCandidatesFromSnapshot(baseResult.account, snapshot, 180, 5, false)).toHaveLength(1);
  });
});

describe('quota refresh', () => {
  it('refreshes disabled accounts as well as enabled accounts', async () => {
    const authorizationHeaders: string[] = [];
    const server = createServer((request, response) => {
      authorizationHeaders.push(request.headers.authorization ?? '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port');
      const config: AppConfig = {
        authDir: '',
        dbPath: '',
        quotaUrl: `http://127.0.0.1:${address.port}`,
        quotaConcurrency: 1,
        quotaDelayMs: 0,
        quotaTimeoutMs: 1_000,
        proxyUrl: '',
        userAgent: 'quota-test',
        codexBin: 'codex',
        codexHomeParentDir: '',
        probeModel: 'gpt-5',
        probePrompt: 'test',
        probeTimeoutMs: 1_000,
        probeMinIntervalMs: 0,
        probeCooldownMs: 0,
        probeVerifyAttempts: 1,
        probeVerifyDelayMs: 0,
        probeVerifyToleranceSeconds: 0,
        probeVerifyIntervalMs: 0,
        dormantToleranceSeconds: 0,
        dormantMaxUsedPercent: 0
      };
      const enabled: AuthAccount = {
        ...baseAccount(),
        accountKey: 'enabled',
        accessToken: 'enabled-token'
      };
      const disabled: AuthAccount = {
        ...baseAccount(),
        accountKey: 'disabled',
        disabled: true,
        accessToken: 'disabled-token'
      };

      const results = await refreshQuotas([enabled, disabled], config, () => undefined);

      expect(results.map((result) => result.account.accountKey)).toEqual(['enabled', 'disabled']);
      expect(authorizationHeaders).toEqual(['Bearer enabled-token', 'Bearer disabled-token']);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});

function baseAccount(): AuthAccount {
  return {
    accountKey: 'account',
    authIndex: 'idx',
    filePath: 'a.json',
    fileName: 'a.json',
    email: 'a@example.com',
    accountId: 'account',
    planType: null,
    disabled: false,
    accessToken: 'token',
    idToken: null,
    refreshToken: null,
    rawAuth: {}
  };
}

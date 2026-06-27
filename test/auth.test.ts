import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { authJsonForCodexCli, loadAuthAccounts } from '../src/auth.js';

function fakeJwt(payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `x.${encoded}.y`;
}

describe('auth reader', () => {
  it('loads CPA codex auth files and projects official Codex auth shape', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-awake-auth-test-'));
    try {
      await writeFile(
        path.join(dir, 'codex.json'),
        JSON.stringify({
          type: 'codex',
          access_token: 'access-secret',
          id_token: fakeJwt({
            email: 'a@example.com',
            'https://api.openai.com/auth': {
              chatgpt_account_id: 'acct-1',
              chatgpt_plan_type: 'plus'
            }
          }),
          refresh_token: 'refresh-secret',
          disabled: false
        })
      );
      const accounts = await loadAuthAccounts(dir);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        email: 'a@example.com',
        accountId: 'acct-1',
        planType: 'plus'
      });
      const projected = authJsonForCodexCli(accounts[0]!);
      expect(projected).toMatchObject({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: 'access-secret',
          refresh_token: 'refresh-secret',
          account_id: 'acct-1'
        }
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

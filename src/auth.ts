import path from 'node:path';
import type { AuthAccount } from './types.js';
import {
  boolValue,
  decodeJwtPayload,
  extractNestedRecord,
  isRecord,
  normalizeString,
  readJsonFile,
  sha256,
  walkJsonFiles
} from './util.js';

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return null;
}

function nested(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return extractNestedRecord(source, key);
}

function tokenFrom(source: Record<string, unknown>, key: string): string | null {
  const direct = firstString(source[key]);
  if (direct) return direct;
  const token = nested(source, 'token');
  return token ? firstString(token[key]) : null;
}

function extractAccountIdFromJwt(token: unknown): string | null {
  const payload = decodeJwtPayload(token);
  const auth = extractNestedRecord(payload, 'https://api.openai.com/auth');
  return firstString(
    payload?.chatgpt_account_id,
    payload?.chatgptAccountId,
    payload?.account_id,
    payload?.accountId,
    auth?.chatgpt_account_id,
    auth?.chatgptAccountId,
    auth?.account_id,
    auth?.accountId
  );
}

function extractPlanFromJwt(token: unknown): string | null {
  const payload = decodeJwtPayload(token);
  const auth = extractNestedRecord(payload, 'https://api.openai.com/auth');
  return firstString(payload?.plan_type, payload?.planType, auth?.chatgpt_plan_type);
}

function extractEmailFromJwt(token: unknown): string | null {
  const payload = decodeJwtPayload(token);
  const profile = extractNestedRecord(payload, 'https://api.openai.com/profile');
  return firstString(payload?.email, profile?.email);
}

function isCodexAuth(fileName: string, raw: Record<string, unknown>): boolean {
  const type = firstString(raw.type, raw.provider)?.toLowerCase();
  if (type === 'codex') return true;
  if (fileName.toLowerCase().includes('codex')) return true;
  return Boolean(firstString(raw.access_token, raw.id_token, raw.refresh_token));
}

export function authJsonForCodexCli(account: AuthAccount): Record<string, unknown> {
  return {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: account.idToken ?? '',
      access_token: account.accessToken,
      ...(account.refreshToken ? { refresh_token: account.refreshToken } : {}),
      ...(account.accountId ? { account_id: account.accountId } : {})
    },
    last_refresh: new Date().toISOString()
  };
}

export async function loadAuthAccounts(authDir: string): Promise<AuthAccount[]> {
  const files = await walkJsonFiles(authDir);
  const accounts: AuthAccount[] = [];

  for (const filePath of files) {
    let parsed: unknown;
    try {
      parsed = await readJsonFile(filePath);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    const fileName = path.basename(filePath);
    if (!isCodexAuth(fileName, parsed)) continue;

    const metadata = nested(parsed, 'metadata');
    const attributes = nested(parsed, 'attributes');
    const accessToken = firstString(
      parsed.access_token,
      parsed.accessToken,
      metadata?.access_token,
      metadata?.accessToken,
      attributes?.access_token,
      attributes?.accessToken,
      tokenFrom(parsed, 'access_token'),
      tokenFrom(parsed, 'accessToken')
    );
    if (!accessToken) continue;

    const idToken = firstString(parsed.id_token, parsed.idToken, metadata?.id_token, metadata?.idToken);
    const refreshToken = firstString(
      parsed.refresh_token,
      parsed.refreshToken,
      metadata?.refresh_token,
      metadata?.refreshToken
    );
    const accountId =
      firstString(
        parsed.account_id,
        parsed.accountId,
        parsed.chatgpt_account_id,
        parsed.chatgptAccountId,
        metadata?.account_id,
        metadata?.accountId,
        attributes?.account_id,
        attributes?.accountId
      ) ??
      extractAccountIdFromJwt(idToken) ??
      extractAccountIdFromJwt(accessToken);
    const email =
      firstString(parsed.email, metadata?.email, attributes?.email) ??
      extractEmailFromJwt(idToken) ??
      extractEmailFromJwt(accessToken);
    const planType =
      firstString(parsed.plan_type, parsed.planType, metadata?.plan_type, metadata?.planType) ??
      extractPlanFromJwt(idToken) ??
      extractPlanFromJwt(accessToken);
    const authIndex = firstString(parsed.auth_index, parsed.authIndex, parsed.index, parsed.id) ?? sha256(filePath);
    const accountKey = accountId ?? email ?? authIndex;

    accounts.push({
      accountKey,
      authIndex,
      filePath,
      fileName,
      email,
      accountId,
      planType,
      disabled: boolValue(parsed.disabled),
      accessToken,
      idToken,
      refreshToken,
      rawAuth: parsed
    });
  }

  return accounts;
}

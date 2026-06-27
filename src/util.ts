import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DAY_SECONDS = 86_400;
export const WEEK_SECONDS = 7 * DAY_SECONDS;
export const MIN_MONTH_SECONDS = 28 * DAY_SECONDS;
export const MAX_MONTH_SECONDS = 31 * DAY_SECONDS;

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function normalizeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function boolValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  if (typeof value === 'number') return value !== 0;
  return false;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  const value = normalizeString(token);
  if (!value) return null;
  const segments = value.split('.');
  if (segments.length < 2) return null;
  try {
    const normalized = segments[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function extractNestedRecord(
  source: Record<string, unknown> | null,
  key: string
): Record<string, unknown> | null {
  if (!source) return null;
  const value = source[key];
  return isRecord(value) ? value : null;
}

export async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

export async function walkJsonFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        out.push(fullPath);
      }
    }
  }
  await visit(root);
  return out.sort((a, b) => a.localeCompare(b));
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function removeDirQuiet(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function truncate(value: string, max = 1000): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

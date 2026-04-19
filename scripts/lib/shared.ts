/**
 * Shared utilities for data extraction scripts
 */

import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Sort an object by numeric keys ascending.
 */
export function sortByNumericKey<T>(obj: Record<string, T>): Record<string, T> {
  return Object.keys(obj)
    .sort((a, b) => parseInt(a) - parseInt(b))
    .reduce(
      (acc, key) => {
        acc[key] = obj[key];
        return acc;
      },
      {} as Record<string, T>,
    );
}

/**
 * Derive a unique skill ID from an outfit ID.
 * Formula mirrors make_global_uma_info.pl:
 *   i = middle digits of outfit id, v = last 2 digits
 *   skill_id = 100000 + 10000 * (v - 1) + i * 10 + 1
 */
export function uniqueSkillForOutfit(outfitId: string): string {
  const i = parseInt(outfitId.slice(1, -2));
  const v = parseInt(outfitId.slice(-2));
  return (100000 + 10000 * (v - 1) + i * 10 + 1).toString();
}

/**
 * Write JSON data to a file, minified with a trailing newline.
 * Mirrors the output of JSON::PP->canonical(1) from the Perl scripts.
 */
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(data) + '\n', 'utf8');
}

/**
 * Read and parse a JSON file, throwing if it doesn't exist.
 */
export async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf8');
  return JSON.parse(content) as T;
}

/**
 * Read and parse a JSON file, returning null if the file doesn't exist.
 */
export async function readJsonFileIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return await readJsonFile<T>(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Resolve master.mdb path: explicit arg → local db/master.mdb → error.
 */
export async function resolveMasterDbPath(cliPath?: string): Promise<string> {
  if (cliPath) return cliPath;

  const localPath = path.join(process.cwd(), 'db/master.mdb');
  try {
    await access(localPath);
    return localPath;
  } catch {
    throw new Error(
      'master.mdb not found. Pass a path as an argument, or run `npm run db:fetch <version>` first.',
    );
  }
}

#!/usr/bin/env node
/**
 * Extract uma musume info (names + outfit epithets) from master.mdb.
 * TypeScript port of umalator-global/make_global_uma_info.pl.
 *
 * Only includes umas whose unique skill is present in skill_meta.json,
 * which filters out characters not yet released on the global server.
 *
 * Must be run after extract-skill-meta (skill_meta.json must exist).
 *
 * Writes to:
 *   umalator-global/umas.json
 */

import path from 'node:path';
import { Command } from 'commander';
import { closeDatabase, openDatabase, queryAll, queryAllWithParams } from './lib/database';
import { readJsonFile, readJsonFileIfExists, resolveMasterDbPath, sortByNumericKey, uniqueSkillForOutfit, writeJsonFile } from './lib/shared';

interface UmaNameRow { index: number; text: string }
interface OutfitRow { index: number; text: string }

type UmaInfo = { name: [string, string]; outfits: Record<string, string> };

type Options = { replaceMode: boolean; dbPath?: string };

function parseCliArgs(argv: Array<string>): Options {
  const program = new Command();
  program
    .name('extract-uma-info')
    .description('Extract uma musume info from master.mdb')
    .option('-r, --replace', 'replace existing data instead of merging')
    .argument('[dbPath]', 'path to master.mdb');
  program.parse(argv);
  const opts = program.opts<{ replace?: boolean }>();
  const [dbPath] = program.args as Array<string>;
  return { replaceMode: Boolean(opts.replace), dbPath };
}

export async function extractUmaInfo(options: Options = { replaceMode: false }): Promise<void> {
  console.log('📖 Extracting uma musume info...\n');

  const { replaceMode, dbPath: cliPath } = options;
  const dbPath = await resolveMasterDbPath(cliPath);

  console.log(`Mode: ${replaceMode ? '⚠️  Full Replacement' : '✓ Merge (preserves existing data)'}`);
  console.log(`Database: ${dbPath}\n`);

  // Load skill_meta to check which outfits are implemented on global.
  // This mirrors the Perl's `exists $meta->{$s_id}` check.
  const metaPath = path.join(process.cwd(), 'umalator-global/skill_meta.json');
  const skillMeta = await readJsonFile<Record<string, unknown>>(metaPath);

  const db = openDatabase(dbPath);

  try {
    const umaRows = queryAll<UmaNameRow>(
      db,
      `SELECT [index], text FROM text_data WHERE category = 6 AND [index] < 2000`,
    );

    console.log(`Found ${umaRows.length} uma musume\n`);

    const extracted: Record<string, UmaInfo> = {};

    for (const umaRow of umaRows) {
      const umaId = umaRow.index;

      const outfitRows = queryAllWithParams<OutfitRow>(
        db,
        `SELECT [index], text FROM text_data
         WHERE category = 5 AND [index] BETWEEN ? AND ?
         ORDER BY [index] ASC`,
        umaId * 100,
        (umaId + 1) * 100,
      );

      const outfits: Record<string, string> = {};
      for (const outfit of outfitRows) {
        const skillId = uniqueSkillForOutfit(outfit.index.toString());
        if (skillMeta[skillId]) {
          outfits[outfit.index.toString()] = outfit.text;
        }
      }

      if (Object.keys(outfits).length > 0) {
        extracted[umaId.toString()] = {
          name: ['', umaRow.text], // English name left empty (filled manually or via separate data source)
          outfits,
        };
      }
    }

    const outputPath = path.join(process.cwd(), 'umalator-global/umas.json');
    let final: Record<string, UmaInfo>;

    if (replaceMode) {
      final = extracted;
      console.log(`⚠️  Full replacement: ${Object.keys(extracted).length} umas from DB`);
    } else {
      const existing = await readJsonFileIfExists<Record<string, UmaInfo>>(outputPath);
      if (existing) {
        // Merge: update known umas, preserve manually added English names
        final = { ...existing };
        for (const [id, info] of Object.entries(extracted)) {
          const existingEn = existing[id]?.name[0] ?? '';
          final[id] = { name: [existingEn, info.name[1]], outfits: info.outfits };
        }
        const preserved = Object.keys(final).length - Object.keys(extracted).length;
        console.log(`✓ Merge: ${Object.keys(extracted).length} from DB, ${preserved} preserved → ${Object.keys(final).length} total`);
      } else {
        final = extracted;
        console.log(`✓ No existing file, writing fresh`);
      }
    }

    await writeJsonFile(outputPath, sortByNumericKey(final));

    const totalOutfits = Object.values(final).reduce(
      (n, uma) => n + Object.keys(uma.outfits).length,
      0,
    );
    console.log(`\n✓ Written to ${outputPath}`);
    console.log(`  ${Object.keys(final).length} umas, ${totalOutfits} outfits`);
  } finally {
    closeDatabase(db);
  }
}

if (require.main === module) {
  const opts = parseCliArgs(process.argv);
  extractUmaInfo(opts).catch((err: Error) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

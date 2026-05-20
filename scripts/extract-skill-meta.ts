#!/usr/bin/env node
/**
 * Extract skill metadata (groupId, iconId, cost, order) from master.mdb.
 * TypeScript port of umalator-global/make_global_skill_meta.pl.
 *
 * Writes to:
 *   umalator-global/skill_meta.json
 */

import path from 'node:path';
import { Command } from 'commander';
import { closeDatabase, openDatabase, queryAll } from './lib/database';
import { readJsonFileIfExists, resolveMasterDbPath, sortByNumericKey, writeJsonFile } from './lib/shared';

interface SkillMetaRow {
  id: number;
  group_id: number;
  icon_id: number;
  sp_cost: number;
  disp_order: number;
}

type SkillMetaEntry = { groupId: string; iconId: string; baseCost: number; order: number };

type Options = { replaceMode: boolean; dbPath?: string };

function parseCliArgs(argv: Array<string>): Options {
  const program = new Command();
  program
    .name('extract-skill-meta')
    .description('Extract skill metadata from master.mdb')
    .option('-r, --replace', 'replace existing data instead of merging')
    .argument('[dbPath]', 'path to master.mdb');
  program.parse(argv);
  const opts = program.opts<{ replace?: boolean }>();
  const [dbPath] = program.args as Array<string>;
  return { replaceMode: Boolean(opts.replace), dbPath };
}

export async function extractSkillMeta(options: Options = { replaceMode: false }): Promise<void> {
  console.log('📖 Extracting skill metadata...\n');

  const { replaceMode, dbPath: cliPath } = options;
  const dbPath = await resolveMasterDbPath(cliPath);

  console.log(`Mode: ${replaceMode ? '⚠️  Full Replacement' : '✓ Merge (preserves existing data)'}`);
  console.log(`Database: ${dbPath}\n`);

  const db = openDatabase(dbPath);

  try {
    const rows = queryAll<SkillMetaRow>(
      db,
      `  SELECT s.id, s.group_id, s.icon_id, COALESCE(sp.need_skill_point, 0) AS sp_cost, s.disp_order
         FROM skill_data s
    LEFT JOIN single_mode_skill_need_point sp ON s.id = sp.id
        WHERE s.is_general_skill = 1 OR s.rarity >= 3`,
    );

    console.log(`Found ${rows.length} skill records`);

    const extracted: Record<string, SkillMetaEntry> = {};
    for (const row of rows) {
      extracted[row.id.toString()] = {
        groupId: row.group_id.toString(),
        iconId: row.icon_id.toString(),
        baseCost: row.sp_cost,
        order: row.disp_order,
      };
    }

    const outputPath = path.join(process.cwd(), 'umalator-global/skill_meta.json');
    let final: Record<string, SkillMetaEntry>;

    if (replaceMode) {
      final = extracted;
      console.log(`\n⚠️  Replacing ${outputPath}`);
    } else {
      const existing = await readJsonFileIfExists<Record<string, SkillMetaEntry>>(outputPath);
      if (existing) {
        final = { ...existing, ...extracted };
        const preserved = Object.keys(final).length - Object.keys(extracted).length;
        console.log(`\n✓ Merge: ${Object.keys(extracted).length} from DB, ${preserved} preserved → ${Object.keys(final).length} total`);
      } else {
        final = extracted;
        console.log(`\n✓ No existing file, writing fresh`);
      }
    }

    await writeJsonFile(outputPath, sortByNumericKey(final));
    console.log(`✓ Written to ${outputPath}`);
  } finally {
    closeDatabase(db);
  }
}

if (require.main === module) {
  const opts = parseCliArgs(process.argv);
  extractSkillMeta(opts).catch((err: Error) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

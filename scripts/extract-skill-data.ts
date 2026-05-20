#!/usr/bin/env node
/**
 * Extract skill activation data from master.mdb.
 * TypeScript port of uma-skill-tools/tools/make_skill_data.pl.
 *
 * Writes to:
 *   umalator-global/skill_data.json
 */

import path from 'node:path';
import { Command } from 'commander';
import { closeDatabase, openDatabase, queryAll } from './lib/database';
import { readJsonFileIfExists, resolveMasterDbPath, sortByNumericKey, writeJsonFile } from './lib/shared';

interface SkillRow {
  id: number;
  rarity: number;
  precondition_1: string;
  condition_1: string;
  float_ability_time_1: number;
  ability_type_1_1: number;
  float_ability_value_1_1: number;
  target_type_1_1: number;
  ability_type_1_2: number;
  float_ability_value_1_2: number;
  target_type_1_2: number;
  ability_type_1_3: number;
  float_ability_value_1_3: number;
  target_type_1_3: number;
  precondition_2: string;
  condition_2: string;
  float_ability_time_2: number;
  ability_type_2_1: number;
  float_ability_value_2_1: number;
  target_type_2_1: number;
  ability_type_2_2: number;
  float_ability_value_2_2: number;
  target_type_2_2: number;
  ability_type_2_3: number;
  float_ability_value_2_3: number;
  target_type_2_3: number;
}

type SkillEffect = { type: number; modifier: number; target: number };
type SkillAlternative = {
  precondition: string;
  condition: string;
  baseDuration: number;
  effects: Array<SkillEffect>;
};
type SkillEntry = { rarity: number; alternatives: Array<SkillAlternative> };

// Scenario skills receive a 1.2x multiplier not present in the raw data.
// Mirrors patch_modifier() in make_skill_data.pl.
const SCENARIO_SKILLS = new Set([
  210011, 210012, 210021, 210022, 210031, 210032, 210041, 210042, 210051, 210052,
  210061, 210062,
  210071, 210072,
  210081, 210082,
  210261, 210262, 210271, 210272, 210281, 210282,
  210291,
]);

function patchModifier(id: number, value: number): number {
  return SCENARIO_SKILLS.has(id) ? value * 1.2 : value;
}

function buildEffects(row: SkillRow, prefix: '1' | '2'): Array<SkillEffect> {
  const effects: Array<SkillEffect> = [];
  const p = prefix;

  const type1 = row[`ability_type_${p}_1`];
  const val1 = row[`float_ability_value_${p}_1`];
  const tgt1 = row[`target_type_${p}_1`];
  const type2 = row[`ability_type_${p}_2`];
  const val2 = row[`float_ability_value_${p}_2`];
  const tgt2 = row[`target_type_${p}_2`];
  const type3 = row[`ability_type_${p}_3`];
  const val3 = row[`float_ability_value_${p}_3`];
  const tgt3 = row[`target_type_${p}_3`];

  effects.push({ type: type1, modifier: patchModifier(row.id, val1), target: tgt1 });
  if (type2 !== 0) effects.push({ type: type2, modifier: patchModifier(row.id, val2), target: tgt2 });
  if (type3 !== 0) effects.push({ type: type3, modifier: patchModifier(row.id, val3), target: tgt3 });

  return effects;
}

function buildAlternatives(row: SkillRow): Array<SkillAlternative> {
  const alternatives: Array<SkillAlternative> = [
    {
      precondition: row.precondition_1 === '0' ? '' : row.precondition_1,
      condition: row.condition_1,
      baseDuration: row.float_ability_time_1,
      effects: buildEffects(row, '1'),
    },
  ];

  if (row.condition_2 && row.condition_2 !== '' && row.condition_2 !== '0') {
    alternatives.push({
      precondition: row.precondition_2 === '0' ? '' : row.precondition_2,
      condition: row.condition_2,
      baseDuration: row.float_ability_time_2,
      effects: buildEffects(row, '2'),
    });
  }

  return alternatives;
}

type Options = { replaceMode: boolean; dbPath?: string };

function parseCliArgs(argv: Array<string>): Options {
  const program = new Command();
  program
    .name('extract-skill-data')
    .description('Extract skill activation data from master.mdb')
    .option('-r, --replace', 'replace existing data instead of merging')
    .argument('[dbPath]', 'path to master.mdb');
  program.parse(argv);
  const opts = program.opts<{ replace?: boolean }>();
  const [dbPath] = program.args as Array<string>;
  return { replaceMode: Boolean(opts.replace), dbPath };
}

export async function extractSkillData(options: Options = { replaceMode: false }): Promise<void> {
  console.log('📖 Extracting skill data...\n');

  const { replaceMode, dbPath: cliPath } = options;
  const dbPath = await resolveMasterDbPath(cliPath);

  console.log(`Mode: ${replaceMode ? '⚠️  Full Replacement' : '✓ Merge (preserves existing data)'}`);
  console.log(`Database: ${dbPath}\n`);

  const db = openDatabase(dbPath);

  try {
    const rows = queryAll<SkillRow>(
      db,
      `SELECT id, rarity,
              precondition_1, condition_1, float_ability_time_1,
              ability_type_1_1, float_ability_value_1_1, target_type_1_1,
              ability_type_1_2, float_ability_value_1_2, target_type_1_2,
              ability_type_1_3, float_ability_value_1_3, target_type_1_3,
              precondition_2, condition_2, float_ability_time_2,
              ability_type_2_1, float_ability_value_2_1, target_type_2_1,
              ability_type_2_2, float_ability_value_2_2, target_type_2_2,
              ability_type_2_3, float_ability_value_2_3, target_type_2_3
       FROM skill_data
       WHERE is_general_skill = 1 OR rarity >= 3`,
    );

    console.log(`Found ${rows.length} skill records`);

    const extracted: Record<string, SkillEntry> = {};
    for (const row of rows) {
      extracted[row.id.toString()] = {
        rarity: row.rarity,
        alternatives: buildAlternatives(row),
      };
    }

    const outputPath = path.join(process.cwd(), 'umalator-global/skill_data.json');
    let final: Record<string, SkillEntry>;

    if (replaceMode) {
      final = extracted;
      console.log(`\n⚠️  Replacing ${outputPath}`);
    } else {
      const existing = await readJsonFileIfExists<Record<string, SkillEntry>>(outputPath);
      if (existing) {
        final = { ...existing, ...extracted };
        const preserved = Object.keys(final).length - Object.keys(extracted).length;
        console.log(`\n✓ Merge: ${Object.keys(extracted).length} from DB, ${preserved} preserved → ${outputPath}`);
      } else {
        final = extracted;
        console.log(`\n✓ No existing file, writing fresh → ${outputPath}`);
      }
    }

    await writeJsonFile(outputPath, sortByNumericKey(final));
    console.log('\n✓ Done');
  } finally {
    closeDatabase(db);
  }
}

if (require.main === module) {
  const opts = parseCliArgs(process.argv);
  extractSkillData(opts).catch((err: Error) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

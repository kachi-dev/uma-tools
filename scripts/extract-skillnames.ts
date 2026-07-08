#!/usr/bin/env node
/**
 * Extract skill names from master.mdb.
 * TypeScript port of umalator-global/make_global_skillnames.pl.
 *
 * For each unique skill (ID starting with 1), an inherited/gene version entry
 * is also generated (ID + 800000, i.e. the leading '1' becomes '9').
 *
 * Writes to:
 *   umalator-global/skillnames.json
 */

import path from 'node:path';
import { Command } from 'commander';
import { closeDatabase, openDatabase, queryAll } from './lib/database';
import { readJsonFileIfExists, resolveMasterDbPath, sortByNumericKey, writeJsonFile } from './lib/shared';

interface NameRow {
  index: number;
  text: string;
}

// Global skillnames format: { id: [name] }
type SkillNames = Record<string, [string]>;

type Options = { replaceMode: boolean; dbPath?: string };

function parseCliArgs(argv: Array<string>): Options {
  const program = new Command();
  program
    .name('extract-skillnames')
    .description('Extract skill names from master.mdb')
    .option('-r, --replace', 'replace existing data instead of merging')
    .argument('[dbPath]', 'path to master.mdb');
  program.parse(argv);
  const opts = program.opts<{ replace?: boolean }>();
  const [dbPath] = program.args as Array<string>;
  return { replaceMode: Boolean(opts.replace), dbPath };
}

export async function extractSkillnames(options: Options = { replaceMode: false }): Promise<void> {
  console.log('📖 Extracting skill names...\n');

  const { replaceMode, dbPath: cliPath } = options;
  const dbPath = await resolveMasterDbPath(cliPath);

  console.log(`Mode: ${replaceMode ? '⚠️  Full Replacement' : '✓ Merge (preserves existing data)'}`);
  console.log(`Database: ${dbPath}\n`);

  const db = openDatabase(dbPath);

  try {
    const rows = queryAll<NameRow>(
      db,
      `SELECT [index], text FROM text_data WHERE category = 47`,
    );

    console.log(`Found ${rows.length} skill name records`);

    const extracted: SkillNames = {};

    for (const row of rows) {
      const id = row.index.toString();
      const name = row.text;

      extracted[id] = [name];

      // Generate the inherited/gene version for unique skills (IDs starting with '1').
      // The gene ID is original_id + 800000, which flips the leading '1' to '9'.
      if (id.startsWith('1')) {
        const geneId = (row.index + 800000).toString();
        extracted[geneId] = [name + ' (inherited)'];
      }
    }

    const outputPath = path.join(process.cwd(), 'umalator-global/skillnames.json');
    let final: SkillNames;

    if (replaceMode) {
      final = extracted;
      console.log(`\n⚠️  Replacing ${outputPath}`);
    } else {
      const existing = await readJsonFileIfExists<SkillNames>(outputPath);
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
  extractSkillnames(opts).catch((err: Error) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

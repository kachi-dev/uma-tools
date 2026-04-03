#!/usr/bin/env node
/**
 * Run all data extraction scripts in sequence.
 *
 * Order matters: extract-skill-meta must run before extract-uma-info
 * because the uma info script reads umalator-global/skill_meta.json.
 */

import { Command } from 'commander';
import { extractSkillData } from './extract-skill-data';
import { extractSkillMeta } from './extract-skill-meta';
import { extractSkillnames } from './extract-skillnames';
import { extractCourseData } from './extract-course-data';
import { extractUmaInfo } from './extract-uma-info';

type Options = { replaceMode: boolean; dbPath?: string };

function parseCliArgs(argv: Array<string>): Options {
  const program = new Command();
  program
    .name('extract-all')
    .description('Run all data extraction scripts in sequence')
    .option('-r, --replace', 'replace existing data instead of merging')
    .argument('[dbPath]', 'path to master.mdb');
  program.parse(argv);
  const opts = program.opts<{ replace?: boolean }>();
  const [dbPath] = program.args as Array<string>;
  return { replaceMode: Boolean(opts.replace), dbPath };
}

async function extractAll(options: Options = { replaceMode: false }): Promise<void> {
  const { replaceMode, dbPath } = options;

  console.log('🚀 Starting full data extraction...\n');
  console.log(
    `Mode: ${replaceMode ? '⚠️  Full Replacement' : '✓ Merge (default — preserves future content)'}`,
  );
  console.log('='.repeat(60));

  const start = Date.now();
  const results: Array<{ name: string; success: boolean; error?: string }> = [];

  // skill-meta must precede uma-info (uma-info reads skill_meta.json)
  const steps: Array<{ name: string; fn: (opts: Options) => Promise<void> }> = [
    { name: 'Skill Data',  fn: extractSkillData },
    { name: 'Skill Meta',  fn: extractSkillMeta },
    { name: 'Skillnames',  fn: extractSkillnames },
    { name: 'Course Data', fn: extractCourseData },
    { name: 'Uma Info',    fn: extractUmaInfo },
  ];

  for (const { name, fn } of steps) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📦 ${name}`);
    console.log('='.repeat(60));
    try {
      await fn({ replaceMode, dbPath });
      results.push({ name, success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n❌ Failed: ${message}`);
      results.push({ name, success: false, error: message });
    }
  }

  const duration = ((Date.now() - start) / 1000).toFixed(2);
  const ok = results.filter((r) => r.success).length;

  console.log(`\n${'='.repeat(60)}`);
  console.log('📊 Summary');
  console.log('='.repeat(60));
  for (const r of results) {
    console.log(`${r.success ? '✓' : '✗'} ${r.name}${r.error ? ': ' + r.error : ''}`);
  }
  console.log(`\n✨ ${ok}/${results.length} extractions completed in ${duration}s`);

  if (ok < results.length) {
    console.error('\n⚠️  Some extractions failed. Check the errors above.');
    process.exit(1);
  }
}

if (require.main === module) {
  const opts = parseCliArgs(process.argv);
  extractAll(opts).catch((err: Error) => {
    console.error('\n💥 Fatal error:', err.message);
    process.exit(1);
  });
}

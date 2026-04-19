#!/usr/bin/env node
/**
 * Extract course data from master.mdb and courseeventparams JSON files.
 * TypeScript port of umalator-global/make_global_course_data.pl.
 *
 * Writes to:
 *   umalator-global/course_data.json
 */

import path from 'node:path';
import { Command } from 'commander';
import { closeDatabase, openDatabase, queryAll } from './lib/database';
import { readJsonFile, readJsonFileIfExists, resolveMasterDbPath, sortByNumericKey, writeJsonFile } from './lib/shared';

interface CourseSetStatusRow {
  course_set_status_id: number;
  target_status_1: number;
  target_status_2: number;
}

interface CourseRow {
  id: number;
  race_track_id: number;
  distance: number;
  ground: number;
  inout: number;
  turn: number;
  float_lane_max: number;
  course_set_status_id: number;
  finish_time_min: number;
  finish_time_max: number;
}

interface CourseEvent {
  _paramType: number;
  _distance: number;
  _values: Array<number>;
}

interface CourseEventParams {
  courseParams: Array<CourseEvent>;
}

interface Corner { start: number; length: number }
interface Straight { start: number; end: number; frontType: number }
interface Slope { start: number; length: number; slope: number }

interface CourseData {
  raceTrackId: number;
  distance: number;
  distanceType: number;
  surface: number;
  turn: number;
  course: number;
  laneMax: number;
  finishTimeMin: number;
  finishTimeMax: number;
  courseSetStatus: Array<number>;
  corners: Array<Corner>;
  straights: Array<Straight>;
  slopes: Array<Slope>;
}

function distanceType(distance: number): number {
  if (distance <= 1400) return 1; // Short
  if (distance <= 1800) return 2; // Mile
  if (distance < 2500)  return 3; // Mid
  return 4;                        // Long
}

type Options = { replaceMode: boolean; dbPath?: string; courseEventParamsPath?: string };

function parseCliArgs(argv: Array<string>): Options {
  const program = new Command();
  program
    .name('extract-course-data')
    .description('Extract course data from master.mdb and courseeventparams')
    .option('-r, --replace', 'replace existing data instead of merging')
    .argument('[dbPath]', 'path to master.mdb')
    .argument('[courseEventParamsPath]', 'path to courseeventparams directory');
  program.parse(argv);
  const opts = program.opts<{ replace?: boolean }>();
  const [dbPath, courseEventParamsPath] = program.args as Array<string>;
  return { replaceMode: Boolean(opts.replace), dbPath, courseEventParamsPath };
}

export async function extractCourseData(options: Options = { replaceMode: false }): Promise<void> {
  console.log('📖 Extracting course data...\n');

  const { replaceMode, dbPath: cliPath, courseEventParamsPath: cliEventsPath } = options;
  const dbPath = await resolveMasterDbPath(cliPath);
  // courseeventparams live inside the umalator-global sub-directory
  const eventsDir = cliEventsPath ?? path.join(process.cwd(), 'umalator-global/courseeventparams');

  console.log(`Mode: ${replaceMode ? '⚠️  Full Replacement' : '✓ Merge (preserves existing data)'}`);
  console.log(`Database: ${dbPath}`);
  console.log(`Course event params: ${eventsDir}\n`);

  const db = openDatabase(dbPath);

  try {
    const statusRows = queryAll<CourseSetStatusRow>(
      db,
      `SELECT course_set_status_id, target_status_1, target_status_2 FROM race_course_set_status`,
    );

    const courseSetStatus: Record<number, Array<number>> = {};
    for (const row of statusRows) {
      courseSetStatus[row.course_set_status_id] = row.target_status_2 !== 0
        ? [row.target_status_1, row.target_status_2]
        : [row.target_status_1];
    }

    const courseRows = queryAll<CourseRow>(
      db,
      `SELECT id, race_track_id, distance, ground, inout, turn, float_lane_max,
              course_set_status_id, finish_time_min, finish_time_max
       FROM race_course_set`,
    );

    console.log(`Found ${courseRows.length} courses`);

    const extracted: Record<string, CourseData> = {};
    let processed = 0;

    for (const row of courseRows) {
      // Incomplete Longchamp courses — mirrors the Perl skip
      if (row.id === 11201 || row.id === 11202) {
        console.log(`  Skipping incomplete course ${row.id} (Longchamp)`);
        continue;
      }

      const eventsPath = path.join(eventsDir, `${row.id}.json`);
      let eventParams: CourseEventParams;
      try {
        eventParams = await readJsonFile<CourseEventParams>(eventsPath);
      } catch {
        // Skip courses whose event params haven't been extracted yet
        console.warn(`  Warning: no event params for course ${row.id}, skipping`);
        continue;
      }

      const corners: Array<Corner> = [];
      const straights: Array<Straight> = [];
      const slopes: Array<Slope> = [];
      let pendingStraight: Partial<Straight> | null = null;
      let straightState = 0;

      for (const event of eventParams.courseParams) {
        if (event._paramType === 0) {
          corners.push({ start: event._distance, length: event._values[1] });
        } else if (event._paramType === 2) {
          if (straightState === 0) {
            if (event._values[0] !== 1) {
              throw new Error(`Straight ended before it started (course ${row.id})`);
            }
            pendingStraight = { start: event._distance, frontType: event._values[1] };
            straightState = 1;
          } else {
            if (event._values[0] !== 2) {
              throw new Error(`New straight started before previous ended (course ${row.id})`);
            }
            straights.push({ start: pendingStraight!.start!, end: event._distance, frontType: pendingStraight!.frontType! });
            pendingStraight = null;
            straightState = 0;
          }
        } else if (event._paramType === 11) {
          slopes.push({ start: event._distance, length: event._values[1], slope: event._values[0] });
        }
      }

      corners.sort((a, b) => a.start - b.start);
      straights.sort((a, b) => a.start - b.start);
      slopes.sort((a, b) => a.start - b.start);

      extracted[row.id.toString()] = {
        raceTrackId: row.race_track_id,
        distance: row.distance,
        distanceType: distanceType(row.distance),
        surface: row.ground,
        turn: row.turn,
        course: row.inout,
        laneMax: row.float_lane_max,
        finishTimeMin: row.finish_time_min,
        finishTimeMax: row.finish_time_max,
        courseSetStatus: courseSetStatus[row.course_set_status_id] ?? [],
        corners,
        straights,
        slopes,
      };
      processed++;
    }

    const outputPath = path.join(process.cwd(), 'umalator-global/course_data.json');
    let final: Record<string, CourseData>;

    if (replaceMode) {
      final = extracted;
      console.log(`\n⚠️  Replacing ${outputPath}`);
    } else {
      const existing = await readJsonFileIfExists<Record<string, CourseData>>(outputPath);
      if (existing) {
        final = { ...existing, ...extracted };
        const preserved = Object.keys(final).length - processed;
        console.log(`\n✓ Merge: ${processed} from DB, ${preserved} preserved → ${outputPath}`);
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
  extractCourseData(opts).catch((err: Error) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

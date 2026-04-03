#!/usr/bin/env node
/**
 * Master Database Fetcher for Uma Musume Pretty Derby.
 *
 * Manifest chain:
 *   app-ver -> root manifest -> platform manifest -> master manifest -> master.mdb
 *
 * For fetching the version ID fetch from the following URL:
 * https://uma.moe/api/ver
 *
 * Credits to Werseter (@werseter) from Gametora's Discord for the original python script.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Command, Option } from 'commander';
import lz4jsModule from 'lz4js';
import { UMA_MOE_VERSION_URL, resolveResourceVersion } from './lib/uma-api';

type Lz4JsModule = {
  decompress: (data: Uint8Array, maxSize?: number) => Uint8Array;
  decompressBlock: (
    src: Uint8Array,
    dst: Uint8Array,
    sIndex: number,
    sLength: number,
    dIndex: number,
  ) => number;
};
const lz4js = lz4jsModule as Lz4JsModule;

// =============================================================================
// CONSTANTS
// =============================================================================

const BASE_URL = 'https://assets-umamusume-en.akamaized.net';
const PATH_ROOT_MANIFEST = 'dl/vertical/{appVer}/manifests/manifestdat/root.manifest.bsv.lz4';
const PATH_MANIFEST = 'dl/vertical/resources/Manifest/{prefix}/{hname}';
const PATH_GENERIC = 'dl/vertical/resources/Generic/{prefix}/{hname}';

const BSV_MAGIC = 0xbf;
const BSV_FORMAT_VERSION = 1;
const BSV_FORMAT_ANONYMOUS = 1;

const LZ4_FRAME_MAGIC = [0x04, 0x22, 0x4d, 0x18];

const DEFAULT_PLATFORM = 'Windows';
const DEFAULT_OUTPUT_DIR = './db';
const DEFAULT_TIMEOUT = 30;
const PLATFORM_CHOICES = ['Windows', 'iOS', 'Android'] as const;

const textDecoder = new TextDecoder('utf-8');

// =============================================================================
// DATA STRUCTURES
// =============================================================================

class ManifestEntry {
  readonly name: string;
  readonly size: bigint;
  readonly checksum: bigint;
  readonly hname: string;

  constructor(name: string, size: bigint, checksum: bigint, hname?: string) {
    this.name = name;
    this.size = size;
    this.checksum = checksum;
    this.hname = hname ?? calcHName(checksum, size, Buffer.from(name, 'utf-8'));
  }
}

class RootEntry {
  readonly platform: string;
  readonly size: bigint;
  readonly checksum: bigint;

  constructor(platform: string, size: bigint, checksum: bigint) {
    this.platform = platform;
    this.size = size;
    this.checksum = checksum;
  }

  get hname(): string {
    return calcHName(this.checksum, this.size, Buffer.from(this.platform, 'utf-8'));
  }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function toBase32(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 0x1f];
  }

  return output;
}

function calcHName(checksum: bigint, size: bigint, name: Uint8Array): string {
  const header = Buffer.alloc(16);
  header.writeBigUInt64BE(checksum, 0);
  header.writeBigUInt64BE(size, 8);
  const sha1Hash = createHash('sha1')
    .update(Buffer.concat([header, Buffer.from(name)]))
    .digest();
  return toBase32(sha1Hash);
}

function formatBigInt(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatHex64(value: bigint): string {
  return value.toString(16).toUpperCase().padStart(16, '0');
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


async function downloadFile(
  url: string,
  timeoutSeconds: number = DEFAULT_TIMEOUT,
): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'UnityPlayer/2022.3.46f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)',
        Accept: '*/*',
        'Accept-Encoding': 'identity',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText} for ${url}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutSeconds}s for ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function isLz4Compressed(data: Uint8Array): boolean {
  return (
    data.length >= 4 &&
    data[0] === LZ4_FRAME_MAGIC[0] &&
    data[1] === LZ4_FRAME_MAGIC[1] &&
    data[2] === LZ4_FRAME_MAGIC[2] &&
    data[3] === LZ4_FRAME_MAGIC[3]
  );
}

function decompressLz4(data: Uint8Array): Uint8Array {
  if (data.length < 4) {
    throw new Error('Data too short for LZ4 header');
  }

  if (isLz4Compressed(data)) {
    return Uint8Array.from(lz4js.decompress(data));
  }

  const uncompressedSize = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
  const dst = new Uint8Array(uncompressedSize);
  const written = lz4js.decompressBlock(data, dst, 4, data.length - 4, 0);
  return written === dst.length ? dst : dst.slice(0, written);
}

// =============================================================================
// BSV PARSING
// =============================================================================

type BsvValue = string | bigint;
type Schema = [typeByte: number, fixedSize: number | null];

function asString(value: BsvValue): string {
  if (typeof value !== 'string') {
    throw new Error(`Expected string BSV value, got ${typeof value}`);
  }
  return value;
}

function asBigInt(value: BsvValue): bigint {
  if (typeof value !== 'bigint') {
    throw new Error(`Expected bigint BSV value, got ${typeof value}`);
  }
  return value;
}

class BsvParser {
  private readonly data: Uint8Array;
  private offset = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  setOffset(offset: number): void {
    this.offset = offset;
  }

  readVlq(maxBytes = 8): bigint {
    let value = 0n;
    let bytesRead = 0;

    while (bytesRead < maxBytes && this.offset < this.data.length) {
      const byte = this.data[this.offset];
      this.offset += 1;
      bytesRead += 1;

      value = (value << 7n) | BigInt(byte & 0x7f);

      if ((byte & 0x80) === 0) {
        break;
      }
    }

    return value;
  }

  readUnum(numBytes: number): bigint {
    if (this.offset + numBytes > this.data.length) {
      throw new Error('Unexpected end of BSV data while reading integer');
    }

    let value = 0n;
    for (let i = 0; i < numBytes; i += 1) {
      value = (value << 8n) | BigInt(this.data[this.offset + i]);
    }
    this.offset += numBytes;
    return value;
  }

  readText(): string {
    const start = this.offset;
    while (this.offset < this.data.length && this.data[this.offset] !== 0) {
      this.offset += 1;
    }
    const text = textDecoder.decode(this.data.slice(start, this.offset));
    if (this.offset < this.data.length) {
      this.offset += 1;
    }
    return text;
  }

  readByte(): number {
    if (this.offset >= this.data.length) {
      throw new Error('Unexpected end of BSV data while reading byte');
    }
    const value = this.data[this.offset];
    this.offset += 1;
    return value;
  }
}

function parseAnonymousBsv(
  data: Uint8Array,
): [rows: Array<Array<BsvValue>>, schemas: Array<Schema>] {
  if (data.length < 2) {
    throw new Error('BSV data too short');
  }

  if (data[0] !== BSV_MAGIC) {
    throw new Error(
      `Invalid BSV magic: expected 0x${BSV_MAGIC.toString(16)}, got 0x${data[0].toString(16)}`,
    );
  }

  const formatByte = data[1];
  const version = (formatByte >> 4) & 0x0f;
  const formatType = formatByte & 0x0f;

  if (version !== BSV_FORMAT_VERSION) {
    throw new Error(`Unsupported BSV version: ${version}, expected ${BSV_FORMAT_VERSION}`);
  }
  if (formatType !== BSV_FORMAT_ANONYMOUS) {
    throw new Error(`Expected ANONYMOUS format (${BSV_FORMAT_ANONYMOUS}), got ${formatType}`);
  }

  const parser = new BsvParser(data);
  parser.setOffset(2);

  parser.readUnum(2); // header_size
  const rowCount = Number(parser.readVlq());
  parser.readVlq(); // max_row_size
  parser.readVlq(); // schema_version
  const schemaCount = Number(parser.readVlq());

  const schemas: Array<Schema> = [];
  for (let i = 0; i < schemaCount; i += 1) {
    const typeByte = parser.readByte();
    let fixedSize: number | null = null;

    if (((typeByte - 0x21) & 0xcf) === 0 && typeByte !== 0x51) {
      fixedSize = Number(parser.readVlq());
    }

    schemas.push([typeByte, fixedSize]);
  }

  const rows: Array<Array<BsvValue>> = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row: Array<BsvValue> = [];

    for (const [typeByte, fixedSize] of schemas) {
      const baseType = typeByte & 0xf0;

      if (typeByte === 0x40 || baseType === 0x40) {
        row.push(parser.readText());
      } else if (typeByte === 0x11 || typeByte === 0x12 || typeByte === 0x13 || baseType === 0x10) {
        row.push(parser.readVlq());
      } else if (fixedSize !== null) {
        row.push(parser.readUnum(fixedSize));
      } else {
        throw new Error(`Unknown BSV type: 0x${typeByte.toString(16).toUpperCase()}`);
      }
    }

    rows.push(row);
  }

  return [rows, schemas];
}

function parseRootManifest(data: Uint8Array): Array<RootEntry> {
  const [rows] = parseAnonymousBsv(data);
  const entries: Array<RootEntry> = [];

  for (const row of rows) {
    if (row.length >= 3) {
      entries.push(new RootEntry(asString(row[0]), asBigInt(row[1]), asBigInt(row[2])));
    }
  }

  return entries;
}

function parseContentManifest(data: Uint8Array): Array<ManifestEntry> {
  const [rows] = parseAnonymousBsv(data);
  const entries: Array<ManifestEntry> = [];

  for (const row of rows) {
    if (row.length >= 7) {
      entries.push(new ManifestEntry(asString(row[0]), asBigInt(row[4]), asBigInt(row[5])));
    } else if (row.length >= 3) {
      entries.push(new ManifestEntry(asString(row[0]), asBigInt(row[1]), asBigInt(row[2])));
    }
  }

  return entries;
}

// =============================================================================
// URL BUILDERS
// =============================================================================

function getRootManifestUrl(appVer: string): string {
  return `${BASE_URL}/${PATH_ROOT_MANIFEST.replace('{appVer}', appVer)}`;
}

function getManifestUrl(hname: string): string {
  return `${BASE_URL}/${PATH_MANIFEST.replace('{prefix}', hname.slice(0, 2)).replace('{hname}', hname)}`;
}

function getGenericUrl(hname: string): string {
  return `${BASE_URL}/${PATH_GENERIC.replace('{prefix}', hname.slice(0, 2)).replace('{hname}', hname)}`;
}

// =============================================================================
// MAIN PIPELINE
// =============================================================================

interface FetchMasterDbOptions {
  appVer: string;
  platform: string;
  outputDir: string;
  verbose: boolean;
}

async function fetchMasterDb({
  appVer,
  platform,
  outputDir,
  verbose,
}: FetchMasterDbOptions): Promise<string> {
  const log = (message: string): void => {
    if (verbose) {
      console.log(message);
    }
  };

  const normalizedOutputDir = outputDir.trim();
  const outputBasePath = path.resolve(
    process.cwd(),
    normalizedOutputDir.length > 0 ? normalizedOutputDir : DEFAULT_OUTPUT_DIR,
  );
  await mkdir(outputBasePath, { recursive: true });

  log('='.repeat(70));
  log(`STEP 1: Downloading Root Manifest (app-ver: ${appVer})`);
  log('='.repeat(70));

  const rootUrl = getRootManifestUrl(appVer);
  log(`URL: ${rootUrl}`);

  const rootDataCompressed = await downloadFile(rootUrl);
  log(`Downloaded: ${rootDataCompressed.length.toLocaleString()} bytes (compressed)`);

  const rootData = decompressLz4(rootDataCompressed);
  log(`Decompressed: ${rootData.length.toLocaleString()} bytes`);

  const rootPath = path.join(outputBasePath, 'root.manifest.bsv');
  await writeFile(rootPath, rootData);
  log(`Saved: ${rootPath}`);

  const rootEntries = parseRootManifest(rootData);
  log(`\nFound ${rootEntries.length} platform(s):`);
  for (const entry of rootEntries) {
    log(
      `  - ${entry.platform}: size=${formatBigInt(entry.size)}, checksum=0x${formatHex64(entry.checksum)}`,
    );
    log(`    HName: ${entry.hname}`);
  }

  log(`\n${'='.repeat(70)}`);
  log(`STEP 2: Downloading ${platform} Manifest`);
  log('='.repeat(70));

  const platformEntry = rootEntries.find(
    (entry) => entry.platform.toLowerCase() === platform.toLowerCase(),
  );
  if (!platformEntry) {
    throw new Error(`Platform '${platform}' not found in root manifest`);
  }

  const platformUrl = getManifestUrl(platformEntry.hname);
  log(`HName: ${platformEntry.hname}`);
  log(`URL: ${platformUrl}`);

  let platformData = await downloadFile(platformUrl);
  log(`Downloaded: ${platformData.length.toLocaleString()} bytes`);

  if (isLz4Compressed(platformData)) {
    platformData = decompressLz4(platformData);
    log(`Decompressed: ${platformData.length.toLocaleString()} bytes`);
  }

  const platformPath = path.join(outputBasePath, `${platform}.manifest.bsv`);
  await writeFile(platformPath, platformData);
  log(`Saved: ${platformPath}`);

  const platformEntries = parseContentManifest(platformData);
  log(`\nFound ${platformEntries.length} content categories:`);
  for (const entry of platformEntries) {
    log(`  - ${entry.name}: size=${formatBigInt(entry.size)}, hname=${entry.hname}`);
  }

  log(`\n${'='.repeat(70)}`);
  log('STEP 3: Downloading Master Manifest');
  log('='.repeat(70));

  const masterEntry = platformEntries.find((entry) => entry.name.toLowerCase() === 'master');
  if (!masterEntry) {
    throw new Error("'master' entry not found in platform manifest");
  }

  const masterManifestUrl = getManifestUrl(masterEntry.hname);
  log(
    `Master entry: size=${formatBigInt(masterEntry.size)}, checksum=0x${formatHex64(masterEntry.checksum)}`,
  );
  log(`HName: ${masterEntry.hname}`);
  log(`URL: ${masterManifestUrl}`);

  let masterManifestData = await downloadFile(masterManifestUrl);
  log(`Downloaded: ${masterManifestData.length.toLocaleString()} bytes`);

  if (isLz4Compressed(masterManifestData)) {
    masterManifestData = decompressLz4(masterManifestData);
    log(`Decompressed: ${masterManifestData.length.toLocaleString()} bytes`);
  }

  const masterManifestPath = path.join(outputBasePath, 'master.manifest.bsv');
  await writeFile(masterManifestPath, masterManifestData);
  log(`Saved: ${masterManifestPath}`);

  const masterEntries = parseContentManifest(masterManifestData);
  log(`\nFound ${masterEntries.length} entries in master manifest:`);
  for (const entry of masterEntries) {
    log(`  - ${entry.name}: size=${formatBigInt(entry.size)}, hname=${entry.hname}`);
  }

  log(`\n${'='.repeat(70)}`);
  log('STEP 4: Downloading master.mdb');
  log('='.repeat(70));

  const mdbEntry = masterEntries.find((entry) => entry.name.toLowerCase().includes('master.mdb'));
  if (!mdbEntry) {
    throw new Error("'master.mdb.lz4' entry not found in master manifest");
  }

  const mdbUrl = getGenericUrl(mdbEntry.hname);
  log(`Entry: ${mdbEntry.name}`);
  log(`Size: ${formatBigInt(mdbEntry.size)} bytes`);
  log(`Checksum: 0x${formatHex64(mdbEntry.checksum)}`);
  log(`HName: ${mdbEntry.hname}`);
  log(`URL: ${mdbUrl}`);

  const mdbCompressed = await downloadFile(mdbUrl);
  log(`Downloaded: ${mdbCompressed.length.toLocaleString()} bytes`);

  const mdbData = decompressLz4(mdbCompressed);
  log(`Decompressed: ${mdbData.length.toLocaleString()} bytes`);

  const mdbPath = path.join(outputBasePath, 'master.mdb');
  await writeFile(mdbPath, mdbData);
  log(`Saved: ${mdbPath}`);

  log(`\n${'='.repeat(70)}`);
  log('SUCCESS!');
  log('='.repeat(70));
  log(`\nmaster.mdb saved to: ${mdbPath}`);
  log(
    `File size: ${mdbData.length.toLocaleString()} bytes (${(mdbData.length / (1024 * 1024)).toFixed(2)} MB)`,
  );

  return mdbPath;
}

// =============================================================================
// CLI
// =============================================================================

async function main(): Promise<number> {
  const program = new Command();

  program
    .name('fetch-master-db')
    .description('Fetch master.mdb from Uma Musume manifest chain')
    .argument('[appVer]', 'Resource version (defaults to latest current.resource_version from https://uma.moe/api/ver)')
    .option(
      '-o, --output <dir>',
      `Output directory (default: ${DEFAULT_OUTPUT_DIR})`,
      DEFAULT_OUTPUT_DIR,
    )
    .addOption(
      new Option('-p, --platform <platform>', `Target platform (default: ${DEFAULT_PLATFORM})`)
        .choices(PLATFORM_CHOICES)
        .default(DEFAULT_PLATFORM),
    )
    .option('-q, --quiet', 'Suppress progress messages', false)
    .addHelpText(
      'after',
      `
Examples:
  npx tsx scripts/fetch_master_db.ts
  npx tsx scripts/fetch_master_db.ts 10004010
  npx tsx scripts/fetch_master_db.ts --output ./downloads
  npx tsx scripts/fetch_master_db.ts 10004010 --platform Android --quiet

Manifest Chain:
  Root Manifest -> Platform Manifest -> Master Manifest -> master.mdb
`,
    )
    .action(
      async (appVer: string | undefined, options: { output: string; platform: string; quiet: boolean }) => {
        try {
          const resolvedVersion = await resolveResourceVersion(appVer);
          if (!options.quiet) {
            console.log(
              appVer
                ? `Using explicit resource version: ${resolvedVersion}`
                : `Resolved latest resource version from ${UMA_MOE_VERSION_URL}: ${resolvedVersion}`,
            );
          }

          const outputPath = await fetchMasterDb({
            appVer: resolvedVersion,
            platform: options.platform,
            outputDir: options.output,
            verbose: !options.quiet,
          });
          console.log(`\nOutput: ${outputPath}`);
        } catch (error) {
          console.error(`\nERROR: ${getErrorMessage(error)}`);
          process.exitCode = 1;
        }
      },
    );

  await program.parseAsync(process.argv);
  return Number(process.exitCode ?? 0);
}

if (require.main === module) {
  main()
    .then((exitCode) => {
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    })
    .catch((error) => {
      console.error(`\nERROR: ${getErrorMessage(error)}`);
      process.exit(1);
    });
}

export { fetchMasterDb };

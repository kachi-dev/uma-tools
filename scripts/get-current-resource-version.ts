#!/usr/bin/env node

import { fetchCurrentResourceVersion } from './lib/uma-api';

async function main(): Promise<void> {
  const version = await fetchCurrentResourceVersion();
  process.stdout.write(version);
}

if (require.main === module) {
  main().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}

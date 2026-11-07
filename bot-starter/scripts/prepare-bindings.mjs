import { cpSync, existsSync, readFileSync } from 'node:fs';

// Use the organizer's checked-in bindings; no server publication is needed.
const source = new URL('../../src/module_bindings/', import.meta.url);
const destination = new URL('../src/module_bindings/', import.meta.url);
const marker = new URL('index.ts', source);
if (!existsSync(marker)) {
  throw new Error('Organizer bindings are missing. Restore src/module_bindings from the pinned upstream checkout.');
}
const header = readFileSync(marker, 'utf8').slice(0, 500);
if (!header.includes('version 2.12.0')) {
  throw new Error('Unexpected binding version: this bot is pinned to SpacetimeDB SDK 2.12.0.');
}
cpSync(source, destination, { recursive: true });

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { loadDictionary } from './dictionary.js';
import { StrategyWorker } from './worker-client.js';

test('dictionary file URLs preserve Windows spaces and encoded filename characters', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'scrabble dictionary '));
  const filename = join(directory, 'words #1.txt');
  writeFileSync(filename, 'at\r\ndog\n');
  t.after(() => { unlinkSync(filename); rmdirSync(directory); });
  assert.deepEqual(loadDictionary(pathToFileURL(filename)), ['AT', 'DOG']);
  const worker = new StrategyWorker(filename);
  t.after(() => worker.stop());
  await worker.start();
  const decision = await worker.evaluate({matchId: 1n, auctionId: 2n, letter: 'D', myBalance: 3,
    score: 0, myRack: new Map([['A', 1], ['T', 1]]), bagTotal: 0, participantCount: 6,
    auctionType: 'Vickrey', closesAtMs: Date.now() + 1000, estimatedPrice: 3});
  assert.equal(decision?.word, 'AT');
  assert.equal(decision?.bid, 0);
});

test('missing and empty dictionaries fail instead of producing a silent idle bot', t => {
  const directory = mkdtempSync(join(tmpdir(), 'scrabble dictionary empty '));
  const filename = join(directory, 'empty.txt');
  writeFileSync(filename, '\n\r\n');
  t.after(() => { unlinkSync(filename); rmdirSync(directory); });
  assert.throws(() => loadDictionary(filename), /no valid words/);
  assert.throws(() => loadDictionary(join(directory, 'missing.txt')), /ENOENT/);
});

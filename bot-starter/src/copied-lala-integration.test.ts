import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconstructInitialRack, snapshotKey, type MatchSnapshot } from './client.js';
import { StrategyWorker } from './worker-client.js';
const rack=(s:string)=>{const m=new Map<string,number>();for(const ch of s)m.set(ch,(m.get(ch)??0)+1);return m;};
const own=9007199254740997n;
test('copied Lala reconstructs the exact initial five after purchases and own cashout, including cold replay',()=>{
 const auctions=['C','A','T'].map((letter,i)=>({auctionId:BigInt(i),letter,winnerBotId:own,paid:1,closedAtMicros:BigInt(i)}));
 const plays=[{botId:own,word:'CAT',playedAtMicros:9n}];
 const current=rack('AEIRT');const before=[...current];
 assert.deepEqual(reconstructInitialRack(own,current,auctions,plays),rack('AEIRT'));
 assert.deepEqual([...current],before);
 assert.equal(reconstructInitialRack(own,rack('AEIR'),[],[]),null);
 assert.equal(reconstructInitialRack(own,current,[{...auctions[0]!,letter:'Z'}],[]),null);
});
test('copied public revisions invalidate an otherwise identical in-flight own snapshot',()=>{
 const s:MatchSnapshot={matchId:2n,auctionId:3n,letter:'A',myBalance:100,score:0,myRack:rack('AEIRT'),bagTotal:60,participantCount:6,auctionType:'Vickrey',closesAtMs:performance.now()+1000,estimatedPrice:12};
 assert.notEqual(snapshotKey({...s,copiedLalaRevision:'opponent:100:0/word:CAT'}),snapshotKey({...s,copiedLalaRevision:'opponent:105:5/word:CAT'}));
 assert.equal(snapshotKey(s),snapshotKey({...s}));
});
test('native copied opt-in uses the actual copied policy, preserves bigint identity and leaves normal worker mode alone',async()=>{
 const previous=process.env.BOT_COPIED_POLICY;const directory=mkdtempSync(join(tmpdir(),'copied-lala-native-'));const file=join(directory,'words.txt');writeFileSync(file,'CAT\nACT\nCATER\nRATE\nTEAR\nAT\n');
 process.env.BOT_COPIED_POLICY='lala';const worker=new StrategyWorker(file,150);
 try {
  await worker.start();const s:MatchSnapshot={matchId:9007199254740999n,auctionId:9007199254740998n,letter:'S',myBalance:1,score:0,myRack:rack('CATER'),bagTotal:0,participantCount:2,auctionType:'Vickrey',closesAtMs:performance.now()+1000,estimatedPrice:12,copiedLalaRevision:'terminal',copiedLala:{ownBotId:own,initialOwnRack:rack('CATER'),participants:[{botId:own,balance:1,score:0},{botId:3n,balance:100,score:0}],observedAuctions:[],plays:[]}};
  const out=await worker.evaluate(s);assert.ok(out);assert.equal(out.policy,'Copied-Lala-v2.7.5');assert.equal(out.bid,0);assert.equal(out.word,'CATER');assert.ok((out.elapsedMs??Infinity)<=95);assert.ok((out.roundTripMs??Infinity)<=150);
 }finally{worker.stop();if(previous===undefined)delete process.env.BOT_COPIED_POLICY;else process.env.BOT_COPIED_POLICY=previous;rmSync(directory,{recursive:true,force:true});}
});

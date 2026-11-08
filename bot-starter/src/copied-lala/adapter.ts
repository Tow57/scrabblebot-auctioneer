import { readFileSync } from 'node:fs';
import { Dict } from './engine/dict.js';
import { Tracker } from './engine/tracker.js';
import { rewardFor, baseScore } from './engine/letters.js';
import { Lala } from './strategy/lala.js';
import { TUNED, VERSION } from './strategy/params.js';
import type { View } from './sim/types.js';

export type Id = bigint | number | string;
export interface CopiedContext {
  myRack: ReadonlyMap<string, number>; myBalance: number; letter: string;
  bagTotal: number; participantCount: number; auctionType: 'Vickrey'|'FirstPrice'; estimatedPrice: number;
  matchId: Id; auctionId: Id; ownBotId: Id; initialOwnRack: ReadonlyMap<string, number>;
  participants: readonly {botId: Id; balance: number; score: number; isSimulated?: boolean}[];
  observedAuctions: readonly {auctionId: Id; letter: string; winnerBotId: Id|null; paid: number; closedAtMicros: bigint}[];
  plays: readonly {botId: Id; word: string; playedAtMicros: bigint}[];
}
export function counts(rack: ReadonlyMap<string, number>): Uint8Array {
  const out = new Uint8Array(26);
  for (const [letter,n] of rack) {
    if (!/^[A-Z]$/.test(letter) || !Number.isSafeInteger(n) || n<0 || n>98) throw new Error('Invalid own rack');
    out[letter.charCodeAt(0)-65]=n;
  }
  return out;
}
export function createCopiedDictionary(words?: Iterable<string>): Dict {
  return new Dict(words ? [...words] : readFileSync(new URL('./wordlist.txt', import.meta.url),'utf8').split('\n'));
}
export function copiedView(ctx: CopiedContext): View {
  if (!/^[A-Z]$/.test(ctx.letter)) throw new Error('Copied Lala requires current auction letter');
  if (!ctx.initialOwnRack || !ctx.participants || !ctx.observedAuctions || !ctx.plays) throw new Error('Copied Lala requires public history and own initial rack; no fabricated opponent inputs');
  const seats=new Map(ctx.participants.map((p,i)=>[String(p.botId),i]));
  const me=seats.get(String(ctx.ownBotId));
  if (me===undefined || seats.size!==ctx.participantCount) throw new Error('Participant identity mismatch');
  const tracker=new Tracker(me,[...seats.values()],counts(ctx.initialOwnRack),ctx.auctionType);
  const events: ({time:bigint;type:'auction';a:CopiedContext['observedAuctions'][number]}|{time:bigint;type:'word';w:CopiedContext['plays'][number]})[]=[];
  const seen=new Set<string>();
  for(const a of ctx.observedAuctions){if(seen.has(String(a.auctionId)))continue;seen.add(String(a.auctionId));events.push({time:a.closedAtMicros,type:'auction',a});}
  for(const w of ctx.plays)events.push({time:w.playedAtMicros,type:'word',w});
  // Public timestamps determine chronology; IDs are never used as clocks.
  events.sort((a,b)=>a.time<b.time?-1:a.time>b.time?1:a.type===b.type?0:a.type==='auction'?-1:1);
  for(const e of events){
    if(e.type==='auction'){
      const k=e.a.letter.charCodeAt(0)-65;
      tracker.onAuction(k,0);
      tracker.onResult(k,e.a.winnerBotId===null?null:seats.get(String(e.a.winnerBotId))??null,e.a.paid);
    } else { const seat=seats.get(String(e.w.botId));if(seat!==undefined)tracker.onWord(seat,e.w.word); }
  }
  tracker.onAuction(ctx.letter.charCodeAt(0)-65,ctx.bagTotal);
  for(const p of ctx.participants) tracker.setStanding(seats.get(String(p.botId))!,p.balance,p.score);
  return {auctionType:ctx.auctionType,me,n:seats.size,round:tracker.round,letter:ctx.letter.charCodeAt(0)-65,auctionsLeft:ctx.bagTotal+1,rack:counts(ctx.myRack),balance:ctx.myBalance,score:ctx.participants[me]!.score,tracker,wonLast:false};
}
export function createCopiedPolicy(input?: Iterable<string>|Dict) {
  const dict=input instanceof Dict ? input : createCopiedDictionary(input);
  const agent=new Lala(dict,TUNED,'Copied-Lala-'+VERSION);
  return { dictionary:dict, sourceVersion:VERSION, decide(ctx:CopiedContext) {
    const t=performance.now();
    const action=agent.act(copiedView(ctx), true);
    const word=action.words[0]??null;
    // Our reliable client cashes a single word, awaits ACK+authoritative rack,
    // then re-evaluates. A bid computed after hypothetical words is never sent early.
    return {bid:word?0:Math.max(0,Math.min(Math.floor(ctx.myBalance),action.bid)),word,plan:[...action.words],cashout:action.words.reduce((s,w)=>s+rewardFor(baseScore(w),w.length),0),exact:false,elapsedMs:performance.now()-t,rawBid:action.bid};
  }};
}

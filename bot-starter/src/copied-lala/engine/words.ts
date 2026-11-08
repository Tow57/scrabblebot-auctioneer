// Word selection from a rack: best single plays and the best way to cash a
// whole rack out into disjoint words.

import type { Dict } from "./dict.js";
import { A_CODE, VALUE, multiplier, type Counts } from "./letters.js";

export interface Partition {
  words: string[];
  reward: number;
}

// The highest-reward set of disjoint words that fits in `rack`.
// Branch and bound: pivot on the most valuable letter left, which either
// goes into some word containing it or stays unused. The bound is the
// rack's letter sum times the best multiplier its size allows. Anytime:
// after `budgetMs` it returns the best partition found so far.
export function bestPartition(dict: Dict, rack: Counts, minLen = 2, budgetMs = 40): Partition {
  const cands = dict.findWords(rack, minLen);
  const byLetter: number[][] = Array.from({ length: 26 }, () => []);
  for (const i of cands) {
    for (let p = dict.dOff[i]!, e = dict.dOff[i + 1]!; p < e; p++) byLetter[dict.dl[p]!]!.push(i);
  }
  for (const b of byLetter) b.sort((x, y) => dict.reward[y]! - dict.reward[x]!);

  const cur = new Uint8Array(rack);
  const stack: number[] = [];
  let best: Partition = { words: [], reward: 0 };
  const deadline = performance.now() + budgetMs;
  let nodes = 0;
  let timedOut = false;

  const bound = (): number => {
    let sum = 0;
    let n = 0;
    for (let k = 0; k < 26; k++) {
      sum += cur[k]! * VALUE[k]!;
      n += cur[k]!;
    }
    const [num, den] = multiplier(n);
    return (sum * num) / den;
  };

  const dfs = (acc: number): void => {
    if (acc > best.reward) best = { words: stack.map((i) => dict.words[i]!), reward: acc };
    if (timedOut) return;
    if ((++nodes & 255) === 0 && performance.now() > deadline) {
      timedOut = true;
      return;
    }
    if (acc + bound() <= best.reward) return;
    let pivot = -1;
    for (let k = 0; k < 26; k++) {
      if (cur[k] && (pivot < 0 || VALUE[k]! > VALUE[pivot]!)) pivot = k;
    }
    if (pivot < 0) return;
    for (const i of byLetter[pivot]!) {
      if (!dict.fits(i, cur)) continue;
      for (let p = dict.dOff[i]!, e = dict.dOff[i + 1]!; p < e; p++) cur[dict.dl[p]!]! -= dict.dc[p]!;
      stack.push(i);
      dfs(acc + dict.reward[i]!);
      stack.pop();
      for (let p = dict.dOff[i]!, e = dict.dOff[i + 1]!; p < e; p++) cur[dict.dl[p]!]! += dict.dc[p]!;
      if (timedOut) return;
    }
    // Leave every copy of the pivot unused: words using it were all tried.
    const saved = cur[pivot]!;
    cur[pivot] = 0;
    dfs(acc);
    cur[pivot] = saved;
  };
  dfs(0);
  return best;
}

// Words of at least `minLen` letters playable from `rack`, best reward first.
export function playable(dict: Dict, rack: Counts, minLen: number, limit = 50): number[] {
  const ws = dict.findWords(rack, minLen);
  ws.sort((x, y) => dict.reward[y]! - dict.reward[x]! || dict.len[y]! - dict.len[x]!);
  return ws.slice(0, limit);
}

export function removeWord(rack: Counts, word: string): Counts {
  const out = new Uint8Array(rack);
  for (let i = 0; i < word.length; i++) out[word.charCodeAt(i) - A_CODE]!--;
  return out;
}

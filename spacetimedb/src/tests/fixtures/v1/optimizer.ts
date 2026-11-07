// Frozen tournament-v1.0 baseline from f4569e067a1d6fafcdc773d525268856f6d1542a. Dictionary path adjusted only for fixture location.
import { countsKey, DictionaryIndex, LETTER_VALUE, type DictionaryEntry, type TileCounts } from "./dictionary.js";

export interface CashoutPlan {
  score: number;
  words: string[];
  exact: boolean;
  states: number;
}

export interface SearchBudget {
  deadlineMs: number;
  maxStates: number;
  states: number;
}

interface Solution { score: number; words: string[] }
const EMPTY: Solution = { score: 0, words: [] };
const EXHAUSTED = Symbol("cashout search budget exhausted");
const VALUES = Array.from({ length: 26 }, (_, i) => LETTER_VALUE[String.fromCharCode(65 + i)]);

const fits = (entry: DictionaryEntry, counts: TileCounts): boolean =>
  entry.tiles.every(([letter, count]) => counts[letter] >= count);

const change = (entry: DictionaryEntry, counts: TileCounts, direction: number): void => {
  for (const [letter, count] of entry.tiles) counts[letter] += direction * count;
};

function greedy(entries: readonly DictionaryEntry[], counts: TileCounts): Solution {
  const remaining = counts.slice();
  const words: string[] = [];
  let score = 0;
  for (const entry of entries) {
    while (fits(entry, remaining)) {
      words.push(entry.word);
      score += entry.score;
      change(entry, remaining, -1);
    }
  }
  return { score, words };
}

/** All returned plans are legal; exact is true only after exhaustive search. */
export class RackOptimizer {
  private readonly cache = new Map<string, Solution>();

  constructor(readonly dictionary: DictionaryIndex, private readonly cacheSize = 10_000) {}

  optimize(counts: TileCounts, budget: SearchBudget = {
    deadlineMs: performance.now() + 100, maxStates: 10_000, states: 0,
  }): CashoutPlan {
    const startStates = budget.states;
    const rootKey = countsKey(counts);
    const cached = this.cache.get(rootKey);
    if (cached) return { score: cached.score, words: [...cached.words], exact: true, states: 0 };
    const available = this.dictionary.playable(counts, budget.deadlineMs);
    available.entries.sort((a, b) => b.score - a.score || a.word.localeCompare(b.word));
    let incumbent = greedy(available.entries, counts);
    if (!available.complete || performance.now() >= budget.deadlineMs || budget.states >= budget.maxStates) {
      return { ...incumbent, exact: false, states: 0 };
    }
    const groups = Array.from({ length: 26 }, () => [] as DictionaryEntry[]);
    for (const entry of available.entries) for (const [letter] of entry.tiles) groups[letter].push(entry);
    const remaining = counts.slice();
    let iterations = 0;
    const check = (): void => {
      if (budget.states >= budget.maxStates || ((iterations++ & 31) === 0 && performance.now() >= budget.deadlineMs)) {
        throw EXHAUSTED;
      }
    };
    const upperBound = (): number => {
      let score = 0;
      for (let letter = 0; letter < 26; letter++) score += remaining[letter] * VALUES[letter] * 3;
      return score;
    };
    const remember = (key: string, solution: Solution): Solution => {
      this.cache.set(key, solution);
      if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
      return solution;
    };
    const solve = (isRoot = false): Solution => {
      check();
      const key = countsKey(remaining);
      const known = this.cache.get(key);
      if (known) return known;
      budget.states++;
      let pivot = -1;
      for (let letter = 0; letter < 26; letter++) {
        if (remaining[letter] && (pivot < 0 || groups[letter].length < groups[pivot].length)) pivot = letter;
      }
      if (pivot < 0) return remember(key, EMPTY);
      let best = isRoot ? incumbent : EMPTY;
      const bound = upperBound();
      for (const entry of groups[pivot]) {
        check();
        if (!fits(entry, remaining)) continue;
        change(entry, remaining, -1);
        try {
          if (entry.score + upperBound() <= best.score) continue;
          const tail = solve();
          if (entry.score + tail.score > best.score) {
            best = { score: entry.score + tail.score, words: [entry.word, ...tail.words] };
            if (isRoot) incumbent = best;
          }
        } finally {
          change(entry, remaining, 1);
        }
        if (best.score >= bound) break;
      }
      if (best.score < bound) {
        remaining[pivot]--;
        try {
          if (upperBound() > best.score) {
            const without = solve();
            if (without.score > best.score) {
              best = without;
              if (isRoot) incumbent = best;
            }
          }
        } finally {
          remaining[pivot]++;
        }
      }
      return remember(key, best);
    };
    try {
      const solution = solve(true);
      return { score: solution.score, words: [...solution.words], exact: true, states: budget.states - startStates };
    } catch (error) {
      if (error !== EXHAUSTED) throw error;
      return { score: incumbent.score, words: [...incumbent.words], exact: false, states: budget.states - startStates };
    }
  }
}

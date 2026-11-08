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

function greedy(entries: readonly DictionaryEntry[], counts: TileCounts,
  check: (force?: boolean) => void, progress: (solution: Solution) => void): Solution {
  const remaining = counts.slice();
  const words: string[] = [];
  let score = 0;
  for (const entry of entries) {
    check();
    while (fits(entry, remaining)) {
      check(true);
      words.push(entry.word);
      score += entry.score;
      change(entry, remaining, -1);
      progress({ score, words });
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
    if (performance.now() >= budget.deadlineMs) {
      return { score: 0, words: [], exact: false, states: 0 };
    }
    const available = this.dictionary.playable(counts, budget.deadlineMs);
    const seed = available.best ?? available.entries[0];
    let incumbent: Solution = seed ? { score: seed.score, words: [seed.word] } : EMPTY;
    const approximate = (): CashoutPlan => ({ score: incumbent.score, words: [...incumbent.words],
      exact: false, states: budget.states - startStates });
    // A partial traversal has already spent its deadline. Retain its strongest
    // completed single word instead of starting an unchecked sort/greedy pass.
    if (!available.complete) return approximate();
    let iterations = 0;
    const checkTime = (force = false): void => {
      if ((force || (iterations++ & 31) === 0) && performance.now() >= budget.deadlineMs) throw EXHAUSTED;
    };
    const groups = Array.from({ length: 26 }, () => [] as DictionaryEntry[]);
    try {
      checkTime(true);
      available.entries.sort((a, b) => { checkTime(); return b.score - a.score || a.word.localeCompare(b.word); });
      checkTime(true);
      incumbent = greedy(available.entries, counts, checkTime, solution => {
        if (solution.score >= incumbent.score) incumbent = { score: solution.score, words: [...solution.words] };
      });
      checkTime(true);
      // The DP state allowance does not count legal greedy construction. Keep
      // its original fallback when states are exhausted but time remains.
      if (budget.states >= budget.maxStates) return approximate();
      for (const entry of available.entries) {
        checkTime();
        for (const [letter] of entry.tiles) groups[letter].push(entry);
      }
      checkTime(true);
    } catch (error) {
      if (error !== EXHAUSTED) throw error;
      return approximate();
    }
    const check = (): void => {
      if (budget.states >= budget.maxStates) throw EXHAUSTED;
      checkTime();
    };
    const remaining = counts.slice();
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

// Frozen tournament-v1.0 baseline from f4569e067a1d6fafcdc773d525268856f6d1542a. Dictionary path adjusted only for fixture location.
import { readFileSync } from "node:fs";

export type TileCounts = Uint8Array;
export const LETTER_VALUE: Readonly<Record<string, number>> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

export function scoreWord(word: string): number {
  const upper = word.toUpperCase();
  if (!/^[A-Z]{2,}$/.test(upper)) return 0;
  let base = 0;
  for (const letter of upper) base += LETTER_VALUE[letter];
  const multiplier = upper.length <= 3 ? 1 : upper.length === 4 ? 1.5
    : upper.length === 5 ? 2 : upper.length === 6 ? 2.5 : 3;
  return Math.floor(base * multiplier);
}

export function rackToCounts(rack: ReadonlyMap<string, number>): TileCounts {
  const counts = new Uint8Array(26);
  let total = 0;
  for (const [letter, count] of rack) {
    if (!/^[A-Z]$/.test(letter) || !Number.isInteger(count) || count < 0 || count > 98) {
      throw new Error("Rack must contain uppercase letters and nonnegative integer counts");
    }
    counts[letter.charCodeAt(0) - 65] = count;
    total += count;
  }
  if (total > 98) throw new Error("Rack exceeds the 98-tile game bag");
  return counts;
}

export function canSpell(word: string, rack: ReadonlyMap<string, number>): boolean {
  const upper = word.toUpperCase();
  if (!/^[A-Z]{2,}$/.test(upper)) return false;
  const used = new Map<string, number>();
  for (const letter of upper) {
    const count = (used.get(letter) ?? 0) + 1;
    if (count > (rack.get(letter) ?? 0)) return false;
    used.set(letter, count);
  }
  return true;
}

export function countsKey(counts: TileCounts): string {
  return String.fromCharCode(...counts);
}

export function loadDictionary(path: string | URL = new URL("../../../../wordlist.txt", import.meta.url)): string[] {
  const words = readFileSync(path, "utf8").split(/\s+/)
    .map(word => word.toUpperCase()).filter(word => /^[A-Z]{2,}$/.test(word));
  if (words.length === 0) throw new Error("Dictionary contains no valid words");
  return words;
}

export interface DictionaryEntry {
  word: string;
  readonly length: number;
  readonly score: number;
  readonly tiles: readonly (readonly [number, number])[];
}

interface TrieNode {
  readonly children: Map<number, TrieNode>;
  entry?: DictionaryEntry;
}

export class DictionaryIndex {
  readonly entries: readonly DictionaryEntry[];
  readonly words: ReadonlySet<string>;
  private readonly root: TrieNode = { children: new Map() };
  private readonly byLetterAndLength = Array.from({ length: 26 }, () => new Map<number, DictionaryEntry[]>());

  constructor(words: readonly string[]) {
    const normalized = new Set(words.map(word => word.toUpperCase()).filter(word => /^[A-Z]{2,}$/.test(word)));
    if (normalized.size === 0) throw new Error("Dictionary contains no valid words");
    this.words = normalized;
    const signatures = new Map<string, DictionaryEntry>();
    for (const word of normalized) {
      const signature = [...word].sort().join("");
      const existing = signatures.get(signature);
      if (existing) {
        if (word < existing.word) existing.word = word;
        continue;
      }
      const letterCounts = new Map<number, number>();
      for (const letter of signature) {
        const index = letter.charCodeAt(0) - 65;
        letterCounts.set(index, (letterCounts.get(index) ?? 0) + 1);
      }
      signatures.set(signature, {
        word, length: word.length, score: scoreWord(word), tiles: [...letterCounts],
      });
    }
    this.entries = [...signatures.values()];
    for (const entry of this.entries) {
      let node = this.root;
      for (const [letter, count] of entry.tiles) {
        for (let i = 0; i < count; i++) {
          let child = node.children.get(letter);
          if (!child) {
            child = { children: new Map() };
            node.children.set(letter, child);
          }
          node = child;
        }
        const lengths = this.byLetterAndLength[letter];
        const entries = lengths.get(entry.length) ?? [];
        entries.push(entry);
        lengths.set(entry.length, entries);
      }
      node.entry = entry;
    }
  }

  playable(counts: TileCounts, deadlineMs = Infinity): { entries: DictionaryEntry[]; complete: boolean } {
    const remaining = counts.slice();
    const entries: DictionaryEntry[] = [];
    let complete = true;
    let visits = 0;
    const walk = (node: TrieNode): void => {
      if (!complete) return;
      if ((visits++ & 63) === 0 && performance.now() >= deadlineMs) {
        complete = false;
        return;
      }
      if (node.entry) entries.push(node.entry);
      for (const [letter, child] of node.children) {
        if (remaining[letter] === 0) continue;
        remaining[letter]--;
        walk(child);
        remaining[letter]++;
        if (!complete) return;
      }
    };
    walk(this.root);
    return { entries, complete };
  }

  completionValue(counts: TileCounts, letter: number, maxMissing: number, deadlineMs = Infinity): number {
    if (letter < 0 || letter >= 26 || maxMissing < 0) return 0;
    const augmented = counts.slice();
    augmented[letter]++;
    let size = 0;
    for (const count of augmented) size += count;
    let best = 0;
    let checks = 0;
    for (let length = 2; length <= size + maxMissing; length++) {
      for (const entry of this.byLetterAndLength[letter].get(length) ?? []) {
        if ((checks++ & 127) === 0 && performance.now() >= deadlineMs) return best;
        let deficit = 0;
        let usesNewTile = false;
        for (const [index, count] of entry.tiles) {
          if (index === letter && count > counts[index]) usesNewTile = true;
          deficit += Math.max(0, count - augmented[index]);
          if (deficit > maxMissing) break;
        }
        if (usesNewTile && deficit <= maxMissing) {
          best = Math.max(best, entry.score / entry.length / 2 ** deficit);
        }
      }
    }
    return best;
  }
}

// Isolated face-bid experiment: boost only an offered copy that belongs to a
// valuable near-complete long word. This does not commit to that future word.
import { makeScaledV1, type OpponentPolicy } from "./opponent-policies";
import { DictionaryIndex, LETTER_VALUE, rackToCounts, type DictionaryEntry } from "./v1/dictionary";

type DictionaryInput = readonly string[] | {
  readonly words: ReadonlySet<string>;
  readonly entries?: readonly DictionaryEntry[];
};
interface QualityRecord extends DictionaryEntry { readonly requiredCopies: number }
interface SharedRecords {
  baseInput: DictionaryInput;
  byLetter: readonly (readonly QualityRecord[])[];
}
const sharedRecords = new WeakMap<object, SharedRecords>();
const values = Array.from({ length: 26 }, (_, index) => LETTER_VALUE[String.fromCharCode(65 + index)]);

function recordsFor(source: DictionaryInput): SharedRecords {
  const existing = sharedRecords.get(source);
  if (existing) return existing;
  // Reuse the immutable canonical entries provided by either dictionary index.
  // Arrays/word sets are indexed once and that same index also backs v1.
  const indexed = "entries" in source && source.entries ? source
    : new DictionaryIndex("words" in source ? [...source.words] : source);
  const byLetter = Array.from({ length: 26 }, () => [] as QualityRecord[]);
  for (const entry of indexed.entries!) {
    if (entry.length < 7 || entry.score < 36) continue;
    for (const [letter, requiredCopies] of entry.tiles) byLetter[letter]!.push({ ...entry, requiredCopies });
  }
  for (const group of byLetter) group.sort((a, b) => a.length - b.length || b.score - a.score);
  const result = { baseInput: indexed, byLetter };
  sharedRecords.set(source, result);
  return result;
}

export function makeQualityFaceCandidate(
  dictionary: DictionaryInput,
  weight: number,
  maxMissing: 1 | 2,
): OpponentPolicy {
  if (!Number.isFinite(weight) || weight < 0 || weight > 0.5) {
    throw new Error("Quality face weight must be a finite number between 0 and 0.5");
  }
  if (maxMissing !== 1 && maxMissing !== 2) throw new Error("Quality face missing limit must be 1 or 2");
  // A zero-weight control does not construct or search the extra record index.
  if (weight === 0) return makeScaledV1(1, dictionary);
  const records = recordsFor(dictionary);
  const frozen = makeScaledV1(1, records.baseInput);
  return {
    decide(ctx) {
      const started = performance.now();
      const deadline = Math.min(started + 100, ctx.deadlineMs ?? Infinity);
      const base = frozen.decide({ ...ctx, deadlineMs: deadline });
      const unboosted = () => ({ ...base, elapsedMs: performance.now() - started });
      const face = /^[A-Z]$/.test(ctx.letter) ? LETTER_VALUE[ctx.letter] : undefined;
      if (ctx.bagTotal <= 1 || base.bid <= 0 || face === undefined || face <= 1 || performance.now() >= deadline) return unboosted();
      const counts = rackToCounts(ctx.myRack);
      const letter = ctx.letter.charCodeAt(0) - 65;
      const augmented = counts.slice();
      augmented[letter]!++;
      // The final awarded tile is unusable, so at most bagTotal-1 future buys
      // can complete a word after the current offered tile.
      const futureMissing = Math.min(maxMissing, Math.max(0, Math.floor(ctx.bagTotal) - 1));
      let checks = 0;
      for (const target of records.byLetter[letter]!) {
        if ((checks++ & 63) === 0 && performance.now() >= deadline) return unboosted();
        if (target.requiredCopies <= counts[letter]!) continue;
        let missing = 0;
        let allowed = true;
        for (const [slot, need] of target.tiles) {
          const deficit = Math.max(0, need - augmented[slot]!);
          if (deficit && values[slot] !== 1) { allowed = false; break; }
          missing += deficit;
          if (missing > futureMissing) { allowed = false; break; }
        }
        if (!allowed) continue;
        const balance = Number.isFinite(ctx.myBalance) ? Math.max(0, Math.floor(ctx.myBalance)) : 0;
        const price = Number.isFinite(ctx.estimatedPrice) ? Math.max(1, ctx.estimatedPrice) : 3;
        const reservedCap = Math.max(0, Math.floor(balance - missing * price));
        const proposed = Math.ceil(base.bid * (1 + weight * (face - 1)));
        // Reserve only limits the added boost; it must never weaken frozen v1.
        return { ...base, bid: Math.min(balance, Math.max(base.bid, Math.min(proposed, reservedCap))),
          elapsedMs: performance.now() - started };
      }
      return unboosted();
    },
  };
}

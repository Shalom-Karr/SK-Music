// Catalog search index for SK Music (original implementation). Every track is indexed twice — once on its
// latin words and once on Hebrew-aware sound skeletons — so a romanised query finds a Hebrew title and vice
// versa, with typo tolerance. Ranking combines: idf (rare words count more), match quality (whole word >
// prefix-of-the-word-being-typed > fuzzy), field/position (artist hits and start-of-name hits weigh more),
// and query coverage (a result must cover enough of the query, and covering more ranks higher).
//
// Cost stays sub-linear: prefixes resolve by binary search over the sorted vocabulary, and fuzzy candidates
// come from a shared-bigram index (only tokens that share a 2-gram are distance-checked). Deterministic.

import { plainTokens, skeletonTokens, skeletonKey, damerau } from "./normalize.mjs";
import { expandQuery } from "./synonyms.mjs";

const IN_TITLE = 1, IN_ARTIST = 2;

// Base match weights. `pre` (prefix) only applies to the final, still-being-typed query word. Skeleton
// matching never fuzzes — vowel-dropping already covers vowel typos and fuzzing skeletons matches junk.
const WEIGHT = {
  wordExact: 10, wordPrefix: 9, wordFuzzy: 5,   // latin field
  skelExact: 8,  skelPrefix: 7,                 // skeleton field (no fuzzy)
};
const ARTIST_AFFINITY = 25;   // per query word matching the ARTIST name — being BY the artist beats a mention
// Keep only hits within this fraction of the top score. A lower floor keeps more partial/fuzzy hits.
const PRECISION_FLOOR = Number((typeof process !== "undefined" && process.env && process.env.REL_FLOOR) || 0.28);

const dedupe = (arr) => Array.from(new Set(arr));

// Boundary-anchored bigrams: "abc" -> "^a","ab","bc","c$". Anchoring keeps first/last-letter typos linkable.
function bigrams(tok) {
  if (!tok) return [];
  if (tok.length === 1) return ["^" + tok, tok + "$"];
  const g = ["^" + tok[0]];
  for (let i = 0; i + 1 < tok.length; i++) g.push(tok[i] + tok[i + 1]);
  g.push(tok[tok.length - 1] + "$");
  return g;
}

// A field is one inverted index: token -> Map(doc -> field-bitmask), plus idf, a sorted vocab (for prefix
// binary search), and a bigram -> tokens map (for fuzzy candidates).
class Field {
  constructor() { this.post = new Map(); this.idf = new Map(); this.vocab = []; this.gram = new Map(); }
  add(tok, doc, bit) {
    let m = this.post.get(tok);
    if (!m) { m = new Map(); this.post.set(tok, m); }
    m.set(doc, (m.get(doc) || 0) | bit);
  }
  seal(n) {
    for (const [tok, docs] of this.post) {
      this.idf.set(tok, Math.log(1 + n / docs.size));
      for (const g of bigrams(tok)) {
        let s = this.gram.get(g);
        if (!s) { s = new Set(); this.gram.set(g, s); }
        s.add(tok);
      }
    }
    this.vocab = [...this.post.keys()].sort();
  }
  // tokens in the sorted vocab that start with `p` (excluding an exact equal, handled separately)
  prefixed(p) {
    let lo = 0, hi = this.vocab.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.vocab[mid] < p) lo = mid + 1; else hi = mid; }
    const out = [];
    for (let i = lo; i < this.vocab.length && this.vocab[i].startsWith(p); i++) if (this.vocab[i] !== p) out.push(this.vocab[i]);
    return out;
  }
  // distinct vocab tokens sharing at least one bigram with `q` (the fuzzy candidate pool)
  neighbours(q) {
    const cand = new Set();
    for (const g of bigrams(q)) { const s = this.gram.get(g); if (s) for (const t of s) cand.add(t); }
    cand.delete(q);
    return cand;
  }
}

export function buildIndex(tracks, synonyms = []) {
  const n = tracks.length || 1;
  const words = new Field(), skels = new Field();
  const titleWord = [], titleSkel = [], artistWord = [], artistSkel = [];
  tracks.forEach((t, i) => {
    const tw = dedupe(plainTokens(t.title)), aw = dedupe(plainTokens(t.artistName || ""));
    const ts = dedupe(skeletonTokens(t.title)), as = dedupe(skeletonTokens(t.artistName || ""));
    tw.forEach((w) => words.add(w, i, IN_TITLE));
    aw.forEach((w) => words.add(w, i, IN_ARTIST));
    ts.forEach((s) => skels.add(s, i, IN_TITLE));
    as.forEach((s) => skels.add(s, i, IN_ARTIST));
    titleWord.push(tw.join(" ")); artistWord.push(aw.join(" "));
    titleSkel.push(skeletonKey(t.title)); artistSkel.push(skeletonKey(t.artistName || ""));
  });
  words.seal(n); skels.seal(n);
  return { tracks, plain: words, skel: skels, synonyms, keys: { titleP: titleWord, artistP: artistWord, titleS: titleSkel, artistS: artistSkel } };
}

const bitCount = (x) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
const beginsWith = (s, p) => !!p && s.startsWith(p);

// Resolve one query token against a field. Calls sink(doc, weight, mask) for every posting it reaches.
// `strong` distinguishes confident hits (exact/prefix, mask carries the field bits) from fuzzy hits (mask 0,
// so a typo match can't earn an artist/position bonus it didn't really justify).
function reach(field, q, editCap, weights, minPrefixLen, sink) {
  const emit = (tok, base, strong) => {
    const docs = field.post.get(tok); if (!docs) return;
    const w = base * (field.idf.get(tok) || 1);
    for (const [doc, mask] of docs) sink(doc, w, strong ? mask : 0);
  };
  if (field.post.has(q)) emit(q, weights.exact, true);
  if (weights.prefix && q.length >= minPrefixLen) for (const v of field.prefixed(q)) emit(v, weights.prefix, true);
  if (weights.fuzzy && q.length >= 3) {
    for (const v of field.neighbours(q)) {
      if (v.length >= 3 && Math.abs(v.length - q.length) <= editCap && damerau(v, q, editCap) <= editCap) emit(v, weights.fuzzy, false);
    }
  }
}

export function search(index, query, k = 10) {
  const rawWords = dedupe(plainTokens(query)), rawSkels = dedupe(skeletonTokens(query));
  if (!rawWords.length && !rawSkels.length) return [];
  const { plain: qWords, skel: qSkels } = expandQuery(rawWords, rawSkels, index.synonyms || []);
  const wordKey = rawWords.join(" ");
  const skKeyFull = skeletonKey(query);
  const skKey = skKeyFull.length >= 3 ? skKeyFull : "";          // 2-char skeletons too ambiguous for the exact boost
  const need = Math.max(1, Math.ceil(Math.max(rawWords.length, rawSkels.length) / 2));
  const origCount = Math.max(rawWords.length, rawSkels.length);

  // Per-doc accumulator: total score + coverage bitmasks (whole query and artist-field only) for the word
  // and skeleton passes. popcount of the mask = how many distinct query words landed.
  const acc = new Map();
  const cell = (doc) => { let a = acc.get(doc); if (!a) { a = { s: 0, cw: 0, cs: 0, aw: 0, as: 0 }; acc.set(doc, a); } return a; };

  const typing = !/\s$/.test(query);                            // no trailing space => last word is a live prefix
  const lastWord = typing ? qWords.length - 1 : -1, lastSkel = typing ? qSkels.length - 1 : -1;

  qWords.forEach((q, i) => {
    const bit = i < 31 ? (1 << i) : 0, last = i === lastWord;
    const cap = q.length >= 7 ? 2 : 1;                          // longer words tolerate a double typo
    const wts = { exact: WEIGHT.wordExact, prefix: last ? WEIGHT.wordPrefix : 0, fuzzy: WEIGHT.wordFuzzy };
    reach(index.plain, q, cap, wts, last ? 2 : 3, (doc, w, mask) => {
      const a = cell(doc); a.s += w; a.cw |= bit; if (mask & IN_ARTIST) a.aw |= bit;
    });
  });
  qSkels.forEach((q, i) => {
    if (q.length < 3) return;                                   // skip short skeletons (cross-script needs ≥3)
    const bit = i < 31 ? (1 << i) : 0, last = i === lastSkel;
    const wts = { exact: WEIGHT.skelExact, prefix: last ? WEIGHT.skelPrefix : 0, fuzzy: 0 };
    reach(index.skel, q, q.length <= 4 ? 1 : 2, wts, 2, (doc, w, mask) => {
      const a = cell(doc); a.s += w; a.cs |= bit; if (mask & IN_ARTIST) a.as |= bit;
    });
  });

  const K = index.keys, out = [];
  for (const [doc, a] of acc) {
    const cov = Math.max(bitCount(a.cw), bitCount(a.cs));
    if (cov < need) continue;                                   // coverage gate
    const artistCov = Math.max(bitCount(a.aw), bitCount(a.as));
    // Multiplicative boost, layered exact > begins-with > contains so a better landing spot never ties a worse one.
    let boost = 1 + (cov >= origCount ? 0.4 : 0);
    if (K.artistP[doc] === wordKey || (skKey && K.artistS[doc] === skKey)) boost += 2.5;         // query IS the artist
    else if (beginsWith(K.artistP[doc], wordKey) || beginsWith(K.artistS[doc], skKey)) boost += 1.6;
    else if (artistCov >= origCount) boost += 0.8;                                               // artist merely contains it
    if (K.titleP[doc] === wordKey || (skKey && K.titleS[doc] === skKey)) boost += 2.0;           // query IS the title
    else if (beginsWith(K.titleP[doc], wordKey) || beginsWith(K.titleS[doc], skKey)) boost += 1.4;
    // Reward covering more query words; give the artist-affinity bonus only to multi-word queries (a single
    // common word shouldn't let a coincidental mid-name match beat a title that begins with it).
    const score = (a.s + cov * 8 + (origCount >= 2 ? artistCov * ARTIST_AFFINITY : 0)) * boost;
    out.push({ doc, track: index.tracks[doc], score, coverage: cov });
  }
  if (!out.length) return out;
  out.sort((x, y) => y.score - x.score
    || x.track.title.length - y.track.title.length
    || String(x.track.videoId ?? x.track.id ?? "").localeCompare(String(y.track.videoId ?? y.track.id ?? "")));
  const floor = out[0].score * PRECISION_FLOOR, kept = [];
  for (const r of out) { if (r.score < floor || kept.length >= k) break; kept.push(r); }
  return kept;
}

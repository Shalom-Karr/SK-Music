// Text folding for cross-script, typo-tolerant matching (SK Music, original implementation).
//
// Every string is reduced to two comparable views:
//   • latin words   — accents/niqqud removed, lower-cased, kept to [a-z0-9]; matches romanized text and
//                     the transliterations already baked into many titles.
//   • sound skeleton — a vowel-less consonant signature. Hebrew is written unvowelled, so we map each
//                     Hebrew consonant to a Latin class, drop the vowel-carriers (א ה ו י ע) and Latin
//                     vowels, and collapse look/sound-alike pairs (b/v, k/ch/kaf/kuf, p/f, s/sh, t/th,
//                     tz/ts). A romanised query ("kevakarat", "dudi polak") then lines up with the Hebrew
//                     title (כבקרת, דודי פולק).
// Pure, deterministic string ops — no ICU, portable to any JS runtime.

const DIACRITICS = /\p{Mn}+/gu;                              // niqqud + combining accents
const ELIDE = /['’‘`´"׳״]/g;        // apostrophes/geresh: elided, never a word break

// decompose → drop marks → lower-case → drop apostrophes
const flatten = (s) => (s == null ? "" : String(s)).normalize("NFD").replace(DIACRITICS, "").replace(ELIDE, "").toLowerCase();

const LATIN_WORD = /[a-z0-9]+/g;
const HEB_LO = 0x0590, HEB_HI = 0x05ff;
const isHeb = (cp) => cp >= HEB_LO && cp <= HEB_HI;

export function plainTokens(str) {
  // words = maximal runs of latin-alnum OR hebrew letters
  const out = [];
  let buf = "";
  for (const ch of flatten(str)) {
    const cp = ch.codePointAt(0);
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || isHeb(cp)) buf += ch;
    else if (buf) { out.push(buf); buf = ""; }
  }
  if (buf) out.push(buf);
  return out;
}

// Hebrew consonant → Latin class, derived by folding each class's Hebrew letters (final forms
// included) into a single sound. The vowel-carriers (alef/he/vav/yod/ayin) are deliberately absent:
// they carry no consonant, so they drop out of the skeleton entirely.
const CLASSES = { b: "ב", g: "ג", d: "ד", z: "ז", k: "חכךק", t: "טת", l: "ל", m: "מם", n: "נן", s: "סש", p: "פף", c: "צץ", r: "ר" };
const HEB = {};
for (const [latin, letters] of Object.entries(CLASSES)) for (const ch of letters) HEB[ch] = latin;

// One character-scan that both romanises Hebrew and collapses Latin look-alikes. Returns the consonant
// skeleton of a single (already-flattened) word. Digraphs are consumed greedily left-to-right.
function skeletonize(word) {
  let sk = "";
  for (let i = 0; i < word.length; i++) {
    const c = word[i], n = word[i + 1];
    const cp = c.codePointAt(0);
    if (isHeb(cp)) { sk += HEB[c] || ""; continue; }        // hebrew letter → class (or dropped carrier)
    if ("aeiou".includes(c)) continue;                       // latin vowels dropped
    switch (c) {
      case "s": if (n === "h") { i++; sk += "s"; } else sk += "s"; break;   // sh → s
      case "ş": sk += "s"; break;                                       // ş → s
      case "c":
        if (n === "h") { i++; sk += "k"; }                   // ch → k
        else sk += "c"; break;
      case "k": if (n === "h") { i++; sk += "k"; } else sk += "k"; break;   // kh → k
      case "ḥ": case "x": sk += "k"; break;             // ḥ / x → k
      case "t":
        if (n === "z" || n === "s") { i++; sk += "c"; }      // tz / ts → c
        else if (n === "h") { i++; sk += "t"; }              // th → t
        else sk += "t"; break;
      case "w": case "y": case "h": break;                   // semivowels / silent dropped
      case "v": sk += "b"; break;                            // v → b
      case "f": sk += "p"; break;                            // f → p
      case "q": sk += "k"; break;                            // q → k
      default: if (c >= "a" && c <= "z" || c >= "0" && c <= "9") sk += c;   // pass through remaining
    }
  }
  // Collapse doubled consonants to one. Hebrew writes a geminated sound as a single letter, but
  // romanizations double it ("Rebbe"→רבי, "Tehillim"→תהילים, "Yossi"→יוסי) — folding runs to a single
  // char makes the two spellings share a skeleton.
  return sk.replace(/(.)\1+/g, "$1");
}

// Matching skeletons: one per word, only when it carries ≥2 consonants (shorter is too ambiguous to match on).
export function skeletonTokens(str) {
  const out = [];
  for (const w of plainTokens(str)) { const s = skeletonize(w); if (s.length >= 2) out.push(s); }
  return out;
}

// Ranking skeleton: word-aligned, one slot per latin word (a word that skeletonises to nothing keeps its
// plain form). Preserves word count/order so a multi-word name can't collapse onto a one-word query.
export function skeletonKey(str) {
  return plainTokens(str).map((w) => skeletonize(w) || w).join(" ");
}

// Optimal-string-alignment edit distance with adjacent transposition (a single swap costs 1 — the most
// common real typo). Bails out as soon as every cell in a row exceeds `cap`. O(|a|·|b|) on short tokens.
export function damerau(a, b, cap = 2) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > cap) return cap + 1;
  if (!la) return lb <= cap ? lb : cap + 1;
  if (!lb) return la <= cap ? la : cap + 1;
  let row0 = null;                                           // the i-2 row (for transpositions)
  let row1 = Array.from({ length: lb + 1 }, (_, j) => j);    // the i-1 row
  for (let i = 1; i <= la; i++) {
    const row2 = new Array(lb + 1);
    row2[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const sub = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(row1[j] + 1, row2[j - 1] + 1, row1[j - 1] + sub);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, row0[j - 2] + 1);
      row2[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;                         // whole row already past the budget
    row0 = row1; row1 = row2;
  }
  return row1[lb];
}

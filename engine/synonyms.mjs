// Query aliases — equivalences the consonant skeleton can't infer on its own: acronyms and nicknames
// (e.g. "mbd" ⇄ "Mordechai Ben David"). Each group is a list of interchangeable surface forms. At compile
// time we flatten every form into its latin + skeleton tokens; at query time, a query touching any of a
// group's tokens is widened with all of them. Curated + data-driven (data/synonyms.json), kept small.

import { plainTokens, skeletonTokens } from "./normalize.mjs";

// [["mbd","mordechai ben david"], ...] -> [{ plain:[...tokens], skel:[...tokens] }, ...]
export function compileSynonyms(groups) {
  const compiled = [];
  for (const forms of groups || []) {
    if (!Array.isArray(forms) || forms.length < 2) continue;
    const plain = new Set(), skel = new Set();
    for (const form of forms) {
      for (const t of plainTokens(form)) plain.add(t);
      // Only skeletons of 3+ consonants trigger a group. A 2-char skeleton (e.g. "ben" → "bn") is too
      // ambiguous — it would fire on unrelated words like "benny" ("bnn" → "bn"). Acronyms still trigger
      // on their plain form, so this costs nothing.
      for (const t of skeletonTokens(form)) if (t.length >= 3) skel.add(t);
    }
    compiled.push({ plain: [...plain], skel: [...skel] });
  }
  return compiled;
}

// Widen a query's token sets with every alias group it hits. Matching is tested ONLY against the original
// query (qp/qs), never the growing output — so a token contributed by one group can't chain-trigger another
// (aliases are direct equivalences, not a transitive graph).
export function expandQuery(qPlain, qSkel, syns) {
  const seedP = new Set(qPlain), seedS = new Set(qSkel);
  const outP = new Set(qPlain), outS = new Set(qSkel);
  for (const g of syns || []) {
    const hit = g.plain.some((t) => seedP.has(t)) || g.skel.some((t) => seedS.has(t));
    if (!hit) continue;
    for (const t of g.plain) outP.add(t);
    for (const t of g.skel) outS.add(t);
  }
  return { plain: [...outP], skel: [...outS] };
}

// Build-time loader (Node). The browser gets the compiled groups baked into data/synonyms.json instead.
export async function loadSynonyms(file) {
  try {
    const { readFileSync } = await import("node:fs");
    return compileSynonyms(JSON.parse(readFileSync(file, "utf8")));
  } catch { return []; }
}

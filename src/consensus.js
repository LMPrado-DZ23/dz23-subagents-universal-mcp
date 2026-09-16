/**
 * Lexical consensus heuristics over reviewer text. They highlight overlap, possible
 * contradictions and execution claims for a human or harness to verify. They are not
 * a fact check, and agreement between models is not evidence of truth.
 */
const STOPWORDS = new Set(('the and but for with this that these those from into onto over under are was were been being have has had will would should could '
  + 'can may might must shall its than then there their them they you your our also only just very more most such each other some any all both via per about '
  + 'after before when where which who whom what why how into uma umas uns para com por dos das nos nas que sao foi ser esta estao como mais muito tambem pelo '
  + 'pela pelos pelas este estes estas esse essa isso isto aos deve devem pode podem').split(/\s+/));
const NEGATION_TOKENS = new Set(['not', 'never', 'none', 'cannot', 'dont', 'don', 'doesn', 'isn', 'aren', 'won', 'shouldn', 'mustn', 'avoid', 'without', 'nao', 'nunca', 'nenhum', 'nenhuma', 'sem', 'evite', 'evitar']);
const NEGATION = /(?:^|[^\p{L}])(?:not|no|never|none|cannot|can't|don't|doesn't|isn't|aren't|won't|shouldn't|mustn't|avoid|without|não|nao|nunca|nenhum|nenhuma|sem|evite|evitar)(?=[^\p{L}]|$)/iu;
const EXECUTION_CLAIM = /(?:^|[^\p{L}])(?:tested|verified|executed|ran|benchmarked|deployed|measured|confirmed|passed|passes|passing|validated|reproduced|testei|testado|testados|verifiquei|verificado|executei|executado|implantado|medido|confirmado|aprovado|aprovados|reproduzido)(?=[^\p{L}]|$)/iu;
const THRESHOLD = 0.5;
const LIMIT = 10;

export function extractClaims(text, max = 80) {
  const claims = [];
  const seen = new Set();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/u, '').replace(/[`*_#>]/g, '').trim();
    for (const sentence of line.split(/(?<=[.!?;])\s+/)) {
      const claim = sentence.trim();
      const key = claim.toLowerCase();
      if (claim.length < 12 || claim.length > 400 || seen.has(key)) continue;
      seen.add(key);
      claims.push(claim);
      if (claims.length >= max) return claims;
    }
  }
  return claims;
}

const normalize = text => String(text).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
const hasDigit = word => /\p{N}/u.test(word);

export function claimTokens(text) {
  const words = normalize(text).match(/[\p{L}\p{N}]+/gu) || [];
  // Numbers are kept whatever their length: "30 seconds" and "90 seconds" are different claims.
  return new Set(words.filter(word => (word.length >= 3 || hasDigit(word)) && !STOPWORDS.has(word) && !NEGATION_TOKENS.has(word)));
}

const COMPARISON = /([\p{L}\p{N}][\p{L}\p{N}_.-]*)\s+(?:rather than|instead of|versus|vs\.?|over|em vez de|ao inves de|no lugar de)\s+([\p{L}\p{N}][\p{L}\p{N}_.-]*)/gu;

/** "X rather than Y" pairs; the same pair reversed in another claim is a divergence even with identical words. */
export function comparisons(text) {
  return [...normalize(text).matchAll(COMPARISON)].map(match => [match[1].replace(/[.]+$/, ''), match[2].replace(/[.]+$/, '')]);
}

export function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return shared / (a.size + b.size - shared);
}

const round2 = value => Math.round(value * 100) / 100;

function agreement(analyzed, divergent) {
  if (analyzed.length < 2) return {level: 'insufficient', score: null, method: 'lexical_overlap'};
  const sets = analyzed.map(response => new Set(response.claims.flatMap(claim => [...claim.tokens])));
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) { total += jaccard(sets[i], sets[j]); pairs++; }
  const score = round2(total / pairs);
  const level = score >= 0.5 ? 'high' : score >= 0.25 ? 'medium' : 'low';
  // Shared wording around different key terms ("use Postgres" vs "use Redis") is not agreement.
  return {level: divergent && level === 'high' ? 'medium' : level, score, method: 'lexical_overlap'};
}

// Inflections of one word ("deploy" / "deploying") are paraphrase, not a different key term. Numbers never are, and
// suffixes that invert meaning ("server" / "serverless") make a different term.
const NEGATING_SUFFIX = /^(?:less|free)$/;
function related(x, y) {
  if (hasDigit(x) || hasDigit(y)) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (long.startsWith(short)) return !NEGATING_SUFFIX.test(long.slice(short.length));
  return short.length >= 5 && short.slice(0, 5) === long.slice(0, 5);
}

/** Key terms only one of two similar claims uses, or null when the difference looks like mere paraphrase. */
export function divergentTerms(a, b) {
  const onlyA = [...a].filter(token => !b.has(token));
  const onlyB = [...b].filter(token => !a.has(token));
  const distinctA = onlyA.filter(x => !onlyB.some(y => related(x, y)));
  const distinctB = onlyB.filter(y => !onlyA.some(x => related(x, y)));
  const keyTerms = list => list.length >= 1 && list.length <= 2 && list.every(token => token.length >= 4 || hasDigit(token));
  return keyTerms(distinctA) && keyTerms(distinctB) ? {a: distinctA, b: distinctB} : null;
}

/** A comparison stated in one claim and reversed in the other ("Postgres rather than Redis" vs the opposite). */
export function reversedComparison(textA, textB) {
  const pairsB = comparisons(textB);
  for (const [x, y] of comparisons(textA)) {
    if (x !== y && pairsB.some(([p, q]) => p === y && q === x)) return {a: [x], b: [y]};
  }
  return null;
}

/** @param responses successful reviewer answers: [{provider, model, content}] */
export function heuristicSynthesis(responses) {
  const analyzed = responses.map(response => ({
    source: `${response.provider}:${response.model}`,
    claims: extractClaims(response.content)
      .map(text => ({text: text.slice(0, 300), tokens: claimTokens(text), negated: NEGATION.test(text)}))
      .filter(claim => claim.tokens.size >= 2)
  }));
  const common = [];
  const contradictions = [];
  const divergences = [];
  const unverified = [];
  const covered = new Set();
  analyzed.forEach((response, i) => {
    for (const claim of response.claims) {
      if (EXECUTION_CLAIM.test(claim.text)) unverified.push({source: response.source, text: claim.text});
      if (covered.has(claim)) continue;
      const supporters = new Set([i]);
      analyzed.forEach((other, j) => {
        if (j === i) return;
        for (const candidate of other.claims) {
          const similarity = jaccard(claim.tokens, candidate.tokens);
          if (similarity < THRESHOLD) continue;
          if (candidate.negated !== claim.negated) {
            if (j > i) contradictions.push({similarity: round2(similarity), a: {source: response.source, text: claim.text}, b: {source: other.source, text: candidate.text}});
            continue;
          }
          const terms = reversedComparison(claim.text, candidate.text) || divergentTerms(claim.tokens, candidate.tokens);
          if (terms) {
            if (j > i) divergences.push({similarity: round2(similarity), a: {source: response.source, text: claim.text, terms: terms.a}, b: {source: other.source, text: candidate.text, terms: terms.b}});
            continue;
          }
          supporters.add(j);
          covered.add(candidate);
        }
      });
      if (supporters.size >= 2) common.push({text: claim.text, supporters: supporters.size, sources: [...supporters].map(index => analyzed[index].source)});
    }
  });
  return {
    method: 'heuristic_lexical_overlap',
    disclaimer: 'Lexical heuristic over model text. It does not verify facts, and agreement between models is not objective truth.',
    responses_analyzed: analyzed.length,
    agreement: agreement(analyzed, divergences.length > 0),
    common_claims: common.sort((a, b) => b.supporters - a.supporters).slice(0, LIMIT),
    contradictions: contradictions.sort((a, b) => b.similarity - a.similarity).slice(0, LIMIT),
    possible_divergences: divergences.sort((a, b) => b.similarity - a.similarity).slice(0, LIMIT),
    unverified_claims: unverified.slice(0, LIMIT),
    unverified_note: 'Advisory reviewers cannot run tests, deployments or measurements; execution claims need independent evidence.'
  };
}

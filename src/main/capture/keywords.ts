/**
 * keywords.ts — RAKE (Rapid Automatic Keyword Extraction), pure JS. Turns a blob
 * of text (a transcript or OCR'd screen text) into a ranked list of keyword
 * phrases, with NO model, NO network, NO cost. Runs in well under a millisecond.
 *
 * How RAKE works (Rose et al. 2010), briefly:
 *   1. Split text into candidate phrases at stopwords + punctuation.
 *   2. Score each WORD by deg(w)/freq(w): words that co-occur in longer phrases
 *      (high degree) and aren't just frequent rank higher.
 *   3. A phrase's score = sum of its word scores. Rank phrases, take the top K.
 *
 * This is deliberately a heuristic, not an LLM — it's the free "tags" layer. If
 * we later want semantic tags we add an opt-in LLM call; the interface here
 * stays put.
 */

// A compact English stoplist — enough to break phrases sensibly without pulling
// in a dependency. Extend as real captures surface noise words.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'here',
  'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me',
  'my', 'no', 'not', 'of', 'on', 'or', 'our', 'out', 'over', 'so', 'than', 'that',
  'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'too',
  'up', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why',
  'will', 'with', 'would', 'you', 'your', 'yeah', 'okay', 'ok', 'like', 'um', 'uh',
  'gonna', 'wanna', 'really', 'actually', 'basically', 'something', 'thing', 'things',
  'about', 'after', 'again', 'all', 'also', 'am', 'another', 'any', 'anything', 'bit',
  'both', 'each', 'even', 'every', 'everything', 'kind', 'lot', 'maybe', 'more', 'much',
  'now', 'one', 'ones', 'only', 'other', 'should', 'some', 'sort', 'still', 'stuff',
  'sure', 'those', 'very', 'way', 'well', 'may', 'might', 'must', 'able', 'let', 'lets',
  'want', 'need', 'get', 'got', 'make', 'see', 'know', 'think', 'go', 'going', 'say',
  'said', 'tell', 'look', 'give', 'take', 'try', 'come', 'put', 'keep', 'use', 'start',
  'done', 'doing', 'mean', 'guess', 'yes', 'yep', 'hey', 'hi', 'hello', 'sorry', 'please',
  'thanks', 'listen', 'wait', 'right', 'good', 'great', 'cool', 'awesome', 'nice', 'super',
  'sounds', 'boom', 'alright', 'oh', 'hmm', 'i\'m', 'i\'ll', 'i\'ve', 'i\'d', 'it\'s',
  'that\'s', 'there\'s', 'what\'s', 'here\'s', 'let\'s', 'don\'t', 'doesn\'t', 'didn\'t',
  'can\'t', 'won\'t', 'isn\'t', 'aren\'t', 'wasn\'t', 'hasn\'t', 'haven\'t', 'you\'re',
  'we\'re', 'they\'re', 'you\'ll', 'we\'ll', 'you\'ve', 'we\'ve', 'because', 'already',
  'ahead', 'supposed', 'believe', 'looks', 'seeing', 'better', 'work', 'works',
  'working', 'show', 'showing', 'help', 'add', 'probably', 'whatever', 'though', 'course',
  'bunch', 'wondering'
])

// Single-word tags shorter than this are fragments ("ri"), not topics; "ads" and "mcp" still pass.
const MIN_SINGLE_WORD_CHARS = 3

// Phrases longer than this many words are almost always sentence fragments, not
// tags — drop them so chips stay short and useful.
const MAX_PHRASE_WORDS = 4

// Sentinel marking a real phrase boundary (sentence punctuation / newline). It's
// a single space, which can never be a real token, so it never collides.
const BREAK = ' '

/**
 * Extract up to `limit` keyword phrases from text, ranked by RAKE score.
 * Returns lowercase phrases, de-duplicated, longest-meaningful first. Empty
 * input → [].
 */
export function extractKeywords(text: string, limit = 8): string[] {
  if (!text || !text.trim()) return []

  // Split into candidate phrases. Real RAKE breaks at BOTH sentence punctuation
  // AND stopwords — but NOT at a plain space (that's how multi-word phrases like
  // "machine learning pipeline" survive). We split keeping the delimiters, then
  // map each delimiter to a BREAK sentinel only when it contains a non-space char
  // (`.`, `,`, `!`, newline…); a pure-space delimiter is dropped so the words on
  // either side stay in the same phrase. Phrases then cut on BREAK / stopword /
  // short token. (Breaking only on stopwords would glue "report. budget" into one.)
  const tokens = text
    .toLowerCase()
    .split(/([^a-z0-9'+#]+)/)
    .map((t) => {
      if (!/[^a-z0-9'+#]/.test(t)) return t // a content word (or '')
      return /\S/.test(t) ? BREAK : '' // has punctuation → break; pure space → drop
    })
    .filter(Boolean)
  const phrases: string[][] = []
  let current: string[] = []
  for (const tok of tokens) {
    if (tok === BREAK || STOPWORDS.has(tok) || tok.length < 2) {
      if (current.length) phrases.push(current)
      current = []
    } else {
      current.push(tok)
    }
  }
  if (current.length) phrases.push(current)

  // Per-word degree + frequency. degree(w) = sum of phrase lengths it appears in
  // (so a word in long phrases scores higher); freq(w) = occurrences.
  const freq = new Map<string, number>()
  const degree = new Map<string, number>()
  for (const phrase of phrases) {
    const deg = phrase.length - 1
    for (const w of phrase) {
      freq.set(w, (freq.get(w) ?? 0) + 1)
      degree.set(w, (degree.get(w) ?? 0) + deg + 1)
    }
  }
  const wordScore = (w: string): number => (degree.get(w) ?? 0) / (freq.get(w) ?? 1)

  // Score each unique phrase = sum of its word scores. Keep the best instance.
  const phraseScore = new Map<string, number>()
  for (const phrase of phrases) {
    if (phrase.length > MAX_PHRASE_WORDS) continue
    const key = phrase.join(' ')
    const score = phrase.reduce((s, w) => s + wordScore(w), 0)
    if (!phraseScore.has(key) || score > phraseScore.get(key)!) {
      phraseScore.set(key, score)
    }
  }

  const picked: string[] = []
  for (const [phrase] of [...phraseScore.entries()].sort((a, b) => b[1] - a[1])) {
    if (picked.length >= limit) break
    if (!phrase.includes(' ') && phrase.length < MIN_SINGLE_WORD_CHARS) continue
    if (picked.some((p) => ` ${p} `.includes(` ${phrase} `))) continue
    picked.push(phrase)
  }
  return picked
}

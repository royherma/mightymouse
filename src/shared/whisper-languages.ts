// The languages dictation can transcribe. Whisper's multilingual models decode
// exactly 100; every code here was validated against whisper-cli itself (an
// unknown code exits with `unknown language '<x>'`, so the set is enforced by
// the binary rather than by us).
//
// Two rules that are product decisions, not styling:
//   1. `native` is the identifier the user reads. A picker that says "Hebrew"
//      to a Hebrew speaker is a picker they have to translate first.
//   2. `flag` is decoration and is DELIBERATELY absent for languages spoken
//      across many countries. Spanish, Portuguese, Arabic, Chinese and English
//      have no single flag, and choosing one reads as careless to exactly the
//      users this feature exists for.

/** whisper's own value for "work it out from the audio" (`-l auto`). Not a
 *  language, so it is never in WHISPER_LANGUAGES — the picker prepends it. */
export const AUTO_LANGUAGE = 'auto'

export interface WhisperLanguage {
  /** Whisper's own 2-letter code, passed to `-l`. */
  code: string
  /** The language's name in that language — what the picker shows. */
  native: string
  /** English name, shown as a secondary label so Roy can scan the list. */
  english: string
  /** Regional-indicator flag, only where the language maps to one country. */
  flag?: string
}

// Ordered by rough speaker population, so the languages most users want are
// reachable without scrolling. English leads because it stays the default.
export const COMMON_LANGUAGE_CODES = [
  'en',
  'es',
  'pt',
  'fr',
  'de',
  'zh',
  'ar',
  'hi',
  'ru',
  'it',
  'ja',
  'ko'
]

export const WHISPER_LANGUAGES: WhisperLanguage[] = [
  { code: 'en', native: 'English', english: 'English' },
  { code: 'es', native: 'Español', english: 'Spanish' },
  { code: 'pt', native: 'Português', english: 'Portuguese' },
  { code: 'fr', native: 'Français', english: 'French' },
  { code: 'de', native: 'Deutsch', english: 'German', flag: '🇩🇪' },
  { code: 'zh', native: '中文', english: 'Chinese' },
  { code: 'ar', native: 'العربية', english: 'Arabic' },
  { code: 'hi', native: 'हिन्दी', english: 'Hindi', flag: '🇮🇳' },
  { code: 'ru', native: 'Русский', english: 'Russian', flag: '🇷🇺' },
  { code: 'it', native: 'Italiano', english: 'Italian', flag: '🇮🇹' },
  { code: 'ja', native: '日本語', english: 'Japanese', flag: '🇯🇵' },
  { code: 'ko', native: '한국어', english: 'Korean', flag: '🇰🇷' },
  { code: 'af', native: 'Afrikaans', english: 'Afrikaans' },
  { code: 'am', native: 'አማርኛ', english: 'Amharic', flag: '🇪🇹' },
  { code: 'as', native: 'অসমীয়া', english: 'Assamese' },
  { code: 'az', native: 'Azərbaycan', english: 'Azerbaijani', flag: '🇦🇿' },
  { code: 'ba', native: 'Башҡортса', english: 'Bashkir' },
  { code: 'be', native: 'Беларуская', english: 'Belarusian', flag: '🇧🇾' },
  { code: 'bg', native: 'Български', english: 'Bulgarian', flag: '🇧🇬' },
  { code: 'bn', native: 'বাংলা', english: 'Bengali' },
  { code: 'bo', native: 'བོད་སྐད་', english: 'Tibetan' },
  { code: 'br', native: 'Brezhoneg', english: 'Breton' },
  { code: 'bs', native: 'Bosanski', english: 'Bosnian', flag: '🇧🇦' },
  { code: 'ca', native: 'Català', english: 'Catalan' },
  { code: 'cs', native: 'Čeština', english: 'Czech', flag: '🇨🇿' },
  { code: 'cy', native: 'Cymraeg', english: 'Welsh' },
  { code: 'da', native: 'Dansk', english: 'Danish', flag: '🇩🇰' },
  { code: 'el', native: 'Ελληνικά', english: 'Greek', flag: '🇬🇷' },
  { code: 'et', native: 'Eesti', english: 'Estonian', flag: '🇪🇪' },
  { code: 'eu', native: 'Euskara', english: 'Basque' },
  { code: 'fa', native: 'فارسی', english: 'Persian', flag: '🇮🇷' },
  { code: 'fi', native: 'Suomi', english: 'Finnish', flag: '🇫🇮' },
  { code: 'fo', native: 'Føroyskt', english: 'Faroese', flag: '🇫🇴' },
  { code: 'gl', native: 'Galego', english: 'Galician' },
  { code: 'gu', native: 'ગુજરાતી', english: 'Gujarati' },
  { code: 'ha', native: 'Hausa', english: 'Hausa' },
  { code: 'haw', native: 'ʻŌlelo Hawaiʻi', english: 'Hawaiian' },
  { code: 'he', native: 'עברית', english: 'Hebrew', flag: '🇮🇱' },
  { code: 'hr', native: 'Hrvatski', english: 'Croatian', flag: '🇭🇷' },
  { code: 'ht', native: 'Kreyòl Ayisyen', english: 'Haitian Creole', flag: '🇭🇹' },
  { code: 'hu', native: 'Magyar', english: 'Hungarian', flag: '🇭🇺' },
  { code: 'hy', native: 'Հայերեն', english: 'Armenian', flag: '🇦🇲' },
  { code: 'id', native: 'Bahasa Indonesia', english: 'Indonesian', flag: '🇮🇩' },
  { code: 'is', native: 'Íslenska', english: 'Icelandic', flag: '🇮🇸' },
  { code: 'jw', native: 'Basa Jawa', english: 'Javanese' },
  { code: 'ka', native: 'ქართული', english: 'Georgian', flag: '🇬🇪' },
  { code: 'kk', native: 'Қазақша', english: 'Kazakh', flag: '🇰🇿' },
  { code: 'km', native: 'ភាសាខ្មែរ', english: 'Khmer', flag: '🇰🇭' },
  { code: 'kn', native: 'ಕನ್ನಡ', english: 'Kannada' },
  { code: 'la', native: 'Latina', english: 'Latin' },
  { code: 'lb', native: 'Lëtzebuergesch', english: 'Luxembourgish', flag: '🇱🇺' },
  { code: 'ln', native: 'Lingála', english: 'Lingala' },
  { code: 'lo', native: 'ລາວ', english: 'Lao', flag: '🇱🇦' },
  { code: 'lt', native: 'Lietuvių', english: 'Lithuanian', flag: '🇱🇹' },
  { code: 'lv', native: 'Latviešu', english: 'Latvian', flag: '🇱🇻' },
  { code: 'mg', native: 'Malagasy', english: 'Malagasy', flag: '🇲🇬' },
  { code: 'mi', native: 'Te Reo Māori', english: 'Maori' },
  { code: 'mk', native: 'Македонски', english: 'Macedonian', flag: '🇲🇰' },
  { code: 'ml', native: 'മലയാളം', english: 'Malayalam' },
  { code: 'mn', native: 'Монгол', english: 'Mongolian', flag: '🇲🇳' },
  { code: 'mr', native: 'मराठी', english: 'Marathi' },
  { code: 'ms', native: 'Bahasa Melayu', english: 'Malay' },
  { code: 'mt', native: 'Malti', english: 'Maltese', flag: '🇲🇹' },
  { code: 'my', native: 'မြန်မာ', english: 'Burmese', flag: '🇲🇲' },
  { code: 'ne', native: 'नेपाली', english: 'Nepali', flag: '🇳🇵' },
  { code: 'nl', native: 'Nederlands', english: 'Dutch' },
  { code: 'nn', native: 'Nynorsk', english: 'Norwegian Nynorsk' },
  { code: 'no', native: 'Norsk', english: 'Norwegian', flag: '🇳🇴' },
  { code: 'oc', native: 'Occitan', english: 'Occitan' },
  { code: 'pa', native: 'ਪੰਜਾਬੀ', english: 'Punjabi' },
  { code: 'pl', native: 'Polski', english: 'Polish', flag: '🇵🇱' },
  { code: 'ps', native: 'پښتو', english: 'Pashto' },
  { code: 'ro', native: 'Română', english: 'Romanian', flag: '🇷🇴' },
  { code: 'sa', native: 'संस्कृतम्', english: 'Sanskrit' },
  { code: 'sd', native: 'سنڌي', english: 'Sindhi' },
  { code: 'si', native: 'සිංහල', english: 'Sinhala', flag: '🇱🇰' },
  { code: 'sk', native: 'Slovenčina', english: 'Slovak', flag: '🇸🇰' },
  { code: 'sl', native: 'Slovenščina', english: 'Slovenian', flag: '🇸🇮' },
  { code: 'sn', native: 'ChiShona', english: 'Shona' },
  { code: 'so', native: 'Soomaali', english: 'Somali', flag: '🇸🇴' },
  { code: 'sq', native: 'Shqip', english: 'Albanian', flag: '🇦🇱' },
  { code: 'sr', native: 'Српски', english: 'Serbian', flag: '🇷🇸' },
  { code: 'su', native: 'Basa Sunda', english: 'Sundanese' },
  { code: 'sv', native: 'Svenska', english: 'Swedish', flag: '🇸🇪' },
  { code: 'sw', native: 'Kiswahili', english: 'Swahili' },
  { code: 'ta', native: 'தமிழ்', english: 'Tamil' },
  { code: 'te', native: 'తెలుగు', english: 'Telugu' },
  { code: 'tg', native: 'Тоҷикӣ', english: 'Tajik', flag: '🇹🇯' },
  { code: 'th', native: 'ไทย', english: 'Thai', flag: '🇹🇭' },
  { code: 'tk', native: 'Türkmen', english: 'Turkmen', flag: '🇹🇲' },
  { code: 'tl', native: 'Tagalog', english: 'Tagalog', flag: '🇵🇭' },
  { code: 'tr', native: 'Türkçe', english: 'Turkish', flag: '🇹🇷' },
  { code: 'tt', native: 'Татарча', english: 'Tatar' },
  { code: 'uk', native: 'Українська', english: 'Ukrainian', flag: '🇺🇦' },
  { code: 'ur', native: 'اردو', english: 'Urdu', flag: '🇵🇰' },
  { code: 'uz', native: 'Oʻzbekcha', english: 'Uzbek', flag: '🇺🇿' },
  { code: 'vi', native: 'Tiếng Việt', english: 'Vietnamese', flag: '🇻🇳' },
  { code: 'yi', native: 'ייִדיש', english: 'Yiddish' },
  { code: 'yo', native: 'Yorùbá', english: 'Yoruba' },
  { code: 'yue', native: '粵語', english: 'Cantonese' }
]

const BY_CODE = new Map(WHISPER_LANGUAGES.map((l) => [l.code, l]))

export function findLanguage(code: string): WhisperLanguage | undefined {
  return BY_CODE.get(code)
}

/** The label a picker or HUD shows for a code, falling back to the raw code. */
export function languageLabel(code: string): string {
  return BY_CODE.get(code)?.native ?? code
}

/**
 * The picker's two groups: the languages most people want, then everything else
 * alphabetically by English name (the native names sort by script, which puts
 * every non-Latin language in one unreachable clump).
 */
export function groupedLanguages(): {
  common: WhisperLanguage[]
  rest: WhisperLanguage[]
} {
  const common = COMMON_LANGUAGE_CODES.map((c) => BY_CODE.get(c)).filter(
    (l): l is WhisperLanguage => Boolean(l)
  )
  const commonSet = new Set(COMMON_LANGUAGE_CODES)
  const rest = WHISPER_LANGUAGES.filter((l) => !commonSet.has(l.code)).sort((a, b) =>
    a.english.localeCompare(b.english)
  )
  return { common, rest }
}

/** Everything except plain English needs the multilingual model — including
 *  auto-detect, since working out WHICH language it is is itself a thing only
 *  the multilingual model can do. */
export function needsMultilingualModel(code: string): boolean {
  return code !== 'en'
}

/**
 * Search across BOTH names plus the code, so "esp"/"spanish"/"es" all find
 * Español. Diacritics are stripped from the haystack AND the needle — someone
 * typing "portugues" on a US keyboard must still find "Português".
 */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

export function searchLanguages(query: string): WhisperLanguage[] {
  const q = fold(query.trim())
  if (!q) return []
  const hit = (l: WhisperLanguage): boolean =>
    fold(l.native).includes(q) || fold(l.english).includes(q) || l.code === q
  // Prefix matches first: typing "en" should put English above Slovenian.
  const starts = (l: WhisperLanguage): boolean =>
    fold(l.native).startsWith(q) || fold(l.english).startsWith(q) || l.code === q
  const found = WHISPER_LANGUAGES.filter(hit)
  return [...found.filter(starts), ...found.filter((l) => !starts(l))]
}

// The 25 European languages Parakeet v3 decodes (NVIDIA model card). Whisper's
// other ~75 — Hebrew, Arabic, Chinese, Japanese, Korean, Hindi, Turkish — stay
// on whisper turbo, and so does `auto`: picking the language is itself work only
// the multilingual whisper model does.
const PARAKEET_LANGS = new Set([
  'bg',
  'hr',
  'cs',
  'da',
  'nl',
  'en',
  'et',
  'fi',
  'fr',
  'de',
  'el',
  'hu',
  'it',
  'lv',
  'lt',
  'mt',
  'pl',
  'pt',
  'ro',
  'sk',
  'sl',
  'es',
  'sv',
  'ru',
  'uk'
])

export function parakeetCanTranscribe(code: string): boolean {
  return PARAKEET_LANGS.has(code)
}

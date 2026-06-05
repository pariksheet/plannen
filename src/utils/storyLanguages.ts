export interface StoryLanguage { code: string; label: string }

export const STORY_LANGUAGES: StoryLanguage[] = [
  { code: 'en', label: 'English' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'mr', label: 'मराठी' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '中文' },
  { code: 'ar', label: 'العربية' },
]

const VALID_CODES = new Set(STORY_LANGUAGES.map(l => l.code))

export function isValidLangCode(code: string): boolean {
  return VALID_CODES.has(code)
}

export type ValidateResult =
  | { ok: true; value: string[] }
  | { ok: false; error: string }

export function validateStoryLanguages(input: readonly string[]): ValidateResult {
  if (input.length === 0) return { ok: false, error: 'At least one language is required.' }
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of input) {
    if (!isValidLangCode(c)) return { ok: false, error: `Unknown language: ${c}` }
    if (!seen.has(c)) { seen.add(c); out.push(c) }
  }
  if (out.length > 3) return { ok: false, error: 'Maximum 3 languages.' }
  return { ok: true, value: out }
}

export function labelFor(code: string): string {
  return STORY_LANGUAGES.find(l => l.code === code)?.label ?? code.toUpperCase()
}

/**
 * Язык, выбранный в установщике (R64, ADR 0001 §6). Мастер NSIS пишет LCID в
 * `HKCU\Software\Cord\Language` (`build/installer.nsh`); при первом запуске — когда `settings.json`
 * ещё нет — оболочка читает его, запоминает в настройках и отдаёт вебу через `Bootstrap.language`.
 * Дальше язык меняется в настройках Cord, и реестр больше не читается.
 *
 * Реестр читается через `reg.exe` — без нативных зависимостей; ошибка или не Windows — null.
 */

/** Язык веба (`web/src/i18n/languages.ts`, `LANGUAGES`). */
export type Language = 'ru' | 'en' | 'es' | 'fr' | 'it' | 'zh-Hans' | 'de' | 'pt-BR';

/** LCID языков мастера (`installerLanguages` в electron-builder.yml) → код веба. */
export const INSTALLER_LANGUAGES: Readonly<Record<number, Language>> = {
  1049: 'ru',
  1033: 'en',
  3082: 'es',
  1036: 'fr',
  1040: 'it',
  2052: 'zh-Hans',
  1031: 'de',
  1046: 'pt-BR',
};

export function languageFromLcid(lcid: number): Language | null {
  if (!Number.isInteger(lcid) || lcid <= 0) return null;
  return INSTALLER_LANGUAGES[lcid] ?? null;
}

/** Значение из вывода `reg.exe query … /v <name>`: строка `    <name>    REG_SZ    <значение>`. */
export function parseRegQuery(output: string, name: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+REG_\w+\s+(.*?)\s*$/.exec(line);
    if (match && match[1] === name && match[2]) return match[2];
  }
  return null;
}

export type RegQuery = (key: string, name: string) => string;

/** `reg.exe query HKCU\Software\Cord /v Language` — только Windows; любая ошибка — null. */
export function readInstallerLanguage(platform: NodeJS.Platform, query: RegQuery): Language | null {
  if (platform !== 'win32') return null;
  try {
    const value = parseRegQuery(query('HKCU\\Software\\Cord', 'Language'), 'Language');
    return value ? languageFromLcid(Number(value)) : null;
  } catch {
    return null;
  }
}

const LANGUAGES: readonly Language[] = Object.values(INSTALLER_LANGUAGES);

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/** Код языка системы → язык Cord: точное совпадение, затем по основе (`zh-CN` → `zh-Hans`), как `matchLanguage` веба. */
export function matchLanguage(tag: string | null | undefined): Language | null {
  if (!tag) return null;
  const exact = LANGUAGES.find((language) => language.toLowerCase() === tag.toLowerCase());
  if (exact) return exact;
  const base = tag.toLowerCase().split('-')[0];
  if (base === 'zh') return 'zh-Hans';
  if (base === 'pt') return 'pt-BR';
  return LANGUAGES.find((language) => language === base) ?? null;
}

/**
 * Язык своих текстов оболочки (трей, его диалоги, панель задач): язык интерфейса, который назвала
 * страница (`state.language`), до неё — выбор в установщике, затем язык Windows
 * (`app.getPreferredSystemLanguages()`), без всего — русский, как `detectLanguage` веба.
 */
export function shellLanguage(page: Language | null, installer: Language | null, system: readonly string[]): Language {
  if (page) return page;
  if (installer) return installer;
  for (const tag of system) {
    const match = matchLanguage(tag);
    if (match) return match;
  }
  return 'ru';
}

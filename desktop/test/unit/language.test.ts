import { describe, expect, it } from 'vitest';
import { INSTALLER_LANGUAGES, languageFromLcid, parseRegQuery, readInstallerLanguage } from '../../src/main/language';

describe('язык из установщика → язык приложения (R64)', () => {
  it('каждый из восьми языков мастера NSIS знает свой код веба', () => {
    expect(languageFromLcid(1049)).toBe('ru');
    expect(languageFromLcid(1033)).toBe('en');
    expect(languageFromLcid(3082)).toBe('es');
    expect(languageFromLcid(1036)).toBe('fr');
    expect(languageFromLcid(1040)).toBe('it');
    expect(languageFromLcid(2052)).toBe('zh-Hans');
    expect(languageFromLcid(1031)).toBe('de');
    expect(languageFromLcid(1046)).toBe('pt-BR');
    expect(Object.keys(INSTALLER_LANGUAGES)).toHaveLength(8);
  });

  it('чужой или кривой LCID — null: веб выберет язык сам', () => {
    expect(languageFromLcid(1041)).toBeNull();
    expect(languageFromLcid(Number.NaN)).toBeNull();
    expect(languageFromLcid(-1)).toBeNull();
  });

  it('разбор ответа reg.exe: значение REG_SZ с LCID', () => {
    const output = '\r\nHKEY_CURRENT_USER\\Software\\Cord\r\n    Language    REG_SZ    1031\r\n\r\n';
    expect(parseRegQuery(output, 'Language')).toBe('1031');
    expect(parseRegQuery('ERROR: The system was unable to find the specified registry key or value.', 'Language')).toBeNull();
    expect(parseRegQuery('', 'Language')).toBeNull();
  });

  it('чтение из реестра: только Windows, ошибки reg.exe — null', () => {
    expect(readInstallerLanguage('linux', () => '    Language    REG_SZ    1049')).toBeNull();
    expect(readInstallerLanguage('win32', () => '    Language    REG_SZ    1049')).toBe('ru');
    expect(readInstallerLanguage('win32', () => '    Language    REG_SZ    9999')).toBeNull();
    expect(
      readInstallerLanguage('win32', () => {
        throw new Error('нет ключа');
      }),
    ).toBeNull();
  });
});

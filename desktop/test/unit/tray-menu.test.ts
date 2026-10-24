import { describe, expect, it } from 'vitest';
import { INSTALLER_LANGUAGES, matchLanguage, shellLanguage, type Language } from '../../src/main/language';
import { SHELL_TEXT, shellText } from '../../src/main/shell-text';
import { trayMenu, trayTooltip, type TrayItem, type TrayState } from '../../src/main/tray-menu';
import { HOST_MESSAGES } from '../../src/shared/bridge';

/*
  R103: меню трея как у Телемоста (n10, DESIGN.md → Трей) — состояние, «Вернуться во встречу»,
  «Новая встреча», «Чат · N», микрофон, «Уведомления», «Настройки», «Выйти из Cord»; подсказка
  значка — то же состояние. Тексты — на языке Cord, все восемь (X1).
*/
const ru = shellText('ru');
const idle: TrayState = { inCall: false, mic: false, title: '', unread: 0, notifications: true };
const call: TrayState = { inCall: true, mic: true, title: 'Наша встреча', unread: 3, notifications: true };

/** Меню одной строкой на пункт: «—» — разделитель, «[x]»/«[ ]» — галочка, «(выкл.)» — неактивный. */
function lines(items: TrayItem[]): string[] {
  return items.map((item) => {
    if (item.type === 'separator') return '—';
    const mark = item.checked === undefined ? '' : item.checked ? '[x] ' : '[ ] ';
    return `${mark}${item.label}${item.enabled === false ? ' (выкл.)' : ''}`;
  });
}

describe('trayMenu — состав по состоянию (R103)', () => {
  it('вне встречи: состояние, «Новая встреча», уведомления, настройки, выход', () => {
    expect(lines(trayMenu(idle, ru))).toEqual(['○ Не во встрече (выкл.)', '—', 'Новая встреча', '—', '[x] Уведомления', 'Настройки', '—', 'Выйти из Cord']);
  });

  it('во встрече: название встречи, «Вернуться» первым, чат с непрочитанными, микрофон галочкой', () => {
    expect(lines(trayMenu(call, ru))).toEqual([
      '● Во встрече · Наша встреча (выкл.)',
      '—',
      'Вернуться во встречу',
      'Новая встреча',
      '—',
      'Чат · 3',
      '[x] Микрофон',
      '—',
      '[x] Уведомления',
      'Настройки',
      '—',
      'Выйти из Cord',
    ]);
  });

  it('без непрочитанных — просто «Чат»; микрофон выключен и уведомления выключены — без галочки', () => {
    const items = lines(trayMenu({ ...call, unread: 0, mic: false, notifications: false }, ru));
    expect(items).toContain('Чат');
    expect(items).toContain('[ ] Микрофон');
    expect(items).toContain('[ ] Уведомления');
  });

  it('у каждого пункта своё действие; без названия встречи — только «Во встрече»', () => {
    const ids = trayMenu({ ...call, title: '' }, ru).flatMap((item) => (item.type === 'separator' ? [] : [item.id]));
    expect(ids).toEqual(['status', 'return', 'new', 'chat', 'mic', 'notifications', 'settings', 'quit']);
    expect(lines(trayMenu({ ...call, title: '  ' }, ru))[0]).toBe('● Во встрече (выкл.)');
  });

  it('«Чат · N» открывает чат встречи событием chat.open — оно объявлено в мосте', () => {
    expect(HOST_MESSAGES).toContain('chat.open');
  });

  it('длинное название обрезается, «&» не становится подчёркнутой буквой меню Windows', () => {
    const [status] = trayMenu({ ...call, title: 'Планёрка & ретро ' + 'очень '.repeat(20) }, ru);
    expect(status).toMatchObject({ id: 'status' });
    const label = (status as { label: string }).label;
    expect(label).toContain('Планёрка && ретро');
    expect(label.endsWith('…')).toBe(true);
    expect(label.length).toBeLessThanOrEqual('● Во встрече · '.length + 41);
  });
});

describe('trayTooltip — подсказка значка = состояние', () => {
  it('вне встречи и во встрече; микрофон выключен — сказано', () => {
    expect(trayTooltip(idle, ru)).toBe('Cord · Не во встрече');
    expect(trayTooltip(call, ru)).toBe('Cord · Во встрече · Наша встреча');
    expect(trayTooltip({ ...call, mic: false }, ru)).toBe('Cord · Во встрече · Наша встреча · микрофон выключен');
  });

  it('не длиннее 127 знаков (предел Windows), «&» как есть', () => {
    const tip = trayTooltip({ ...call, mic: false, title: 'A & B ' + 'x'.repeat(200) }, ru);
    expect(tip.length).toBeLessThanOrEqual(127);
    expect(tip).toContain('A & B');
  });
});

describe('тексты оболочки — восемь языков Cord (X1)', () => {
  const languages = Object.values(INSTALLER_LANGUAGES);

  it('каталог есть на каждом языке Cord, ни одной пустой строки', () => {
    expect(Object.keys(SHELL_TEXT).sort()).toEqual([...languages].sort());
    const keys = Object.keys(SHELL_TEXT.ru).sort();
    for (const language of languages) {
      const text = SHELL_TEXT[language] as unknown as Record<string, unknown>;
      expect(Object.keys(text).sort(), language).toEqual(keys);
      for (const [key, value] of Object.entries(text)) expect(typeof value === 'string' && value.trim().length > 0, `${language}.${key}`).toBe(true);
    }
  });

  it('кириллица — только в русском; «Cord» не переводится', () => {
    for (const language of languages.filter((item) => item !== 'ru'))
      for (const [key, value] of Object.entries(SHELL_TEXT[language])) expect(value, `${language}.${key}`).not.toMatch(/[А-Яа-яЁё]/);
    for (const language of languages) expect(SHELL_TEXT[language].quit).toContain('Cord');
  });

  it('меню на английском и китайском', () => {
    expect(lines(trayMenu(call, shellText('en')))).toEqual([
      '● In a meeting · Наша встреча (выкл.)',
      '—',
      'Return to meeting',
      'New meeting',
      '—',
      'Chat · 3',
      '[x] Microphone',
      '—',
      '[x] Notifications',
      'Settings',
      '—',
      'Quit Cord',
    ]);
    expect(trayTooltip(idle, shellText('zh-Hans'))).toBe('Cord · 未在会议中');
  });
});

describe('язык оболочки — как у веба', () => {
  it('код системы → язык Cord: точно, затем по основе (как matchLanguage веба)', () => {
    expect(matchLanguage('ru-RU')).toBe('ru');
    expect(matchLanguage('pt-PT')).toBe('pt-BR');
    expect(matchLanguage('zh-CN')).toBe('zh-Hans');
    expect(matchLanguage('zh-Hans-CN')).toBe('zh-Hans');
    expect(matchLanguage('de')).toBe('de');
    expect(matchLanguage('ja-JP')).toBeNull();
    expect(matchLanguage('')).toBeNull();
  });

  it('страница назвала язык — он; иначе выбор в установщике; иначе язык системы; иначе русский', () => {
    const page: Language = 'fr';
    expect(shellLanguage(page, 'de', ['en-US'])).toBe('fr');
    expect(shellLanguage(null, 'de', ['en-US'])).toBe('de');
    expect(shellLanguage(null, null, ['ja-JP', 'it-IT'])).toBe('it');
    expect(shellLanguage(null, null, ['ja-JP'])).toBe('ru');
  });
});

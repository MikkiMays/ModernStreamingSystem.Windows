import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { APP_ID } from '../../src/main/config';

describe('APP_ID — один идентификатор приложения для ярлыков и уведомлений (R59)', () => {
  it('совпадает с appId в electron-builder.yml: ярлыки получают его от установщика, процесс — от app.setAppUserModelId', () => {
    const yml = load(readFileSync(join(__dirname, '..', '..', 'electron-builder.yml'), 'utf8')) as { appId?: unknown };
    expect(yml.appId).toBe(APP_ID);
  });

  it('это обратное доменное имя, а не отображаемое имя', () => {
    expect(APP_ID).toMatch(/^[a-z]+(\.[a-z]+)+$/);
    expect(APP_ID).not.toBe('Cord');
  });
});

import { describe, expect, it } from 'vitest';
import {
  decideMini,
  decideRebuild,
  displayChange,
  dragPosition,
  miniActionRoute,
  MINI_MARGIN,
  MINI_REBUILDS,
  MINI_WATCH,
  nearestArea,
  placeMini,
  readGrab,
  spareMini,
  watchStep,
  type MiniInput,
} from '../../src/main/mini-policy';

const away: MiniInput = {
  inCall: true,
  enabled: true,
  dismissed: false,
  main: { exists: true, visible: true, focused: false },
  foreground: { cord: false, fullscreen: false },
  overlayVisible: false,
  sameDisplay: true,
};

describe('decideMini — когда видно мини-окно звонка (R93)', () => {
  it('во встрече, Cord закрыт другим окном на том же мониторе — видно', () => {
    expect(decideMini(away)).toBe(true);
  });

  it('Cord спрятан в трей или свёрнут — видно, на каком бы мониторе ни было окно впереди', () => {
    expect(decideMini({ ...away, main: { exists: true, visible: false, focused: false }, sameDisplay: false })).toBe(true);
  });

  it('Cord впереди — не видно; впереди своё окно Cord — тоже', () => {
    expect(decideMini({ ...away, main: { exists: true, visible: true, focused: true } })).toBe(false);
    expect(decideMini({ ...away, foreground: { cord: true, fullscreen: false } })).toBe(false);
  });

  it('вне встречи, выключено, свёрнуто «—», нет главного окна — не видно', () => {
    expect(decideMini({ ...away, inCall: false })).toBe(false);
    expect(decideMini({ ...away, enabled: false })).toBe(false);
    expect(decideMini({ ...away, dismissed: true })).toBe(false);
    expect(decideMini({ ...away, main: null })).toBe(false);
  });

  it('над игрой с оверлеем и над окном во весь экран — не видно', () => {
    expect(decideMini({ ...away, overlayVisible: true })).toBe(false);
    expect(decideMini({ ...away, foreground: { cord: false, fullscreen: true } })).toBe(false);
  });

  it('главное окно видно на другом мониторе — не нужно', () => {
    expect(decideMini({ ...away, sameDisplay: false })).toBe(false);
  });

  it('без cord-native (о переднем окне неизвестно) — по главному окну: не в фокусе — видно', () => {
    expect(decideMini({ ...away, foreground: null, sameDisplay: null })).toBe(true);
    expect(decideMini({ ...away, foreground: null, sameDisplay: null, main: { exists: true, visible: true, focused: true } })).toBe(false);
  });
});

describe('сторож мини-окна (R137): окно, переставшее рисовать кадры, пересоздаётся', () => {
  it('кадр раз в 2 с, ответ ждём 1,5 с, два пропуска подряд — пересоздать', () => {
    expect(MINI_WATCH).toMatchObject({ intervalMs: 2000, timeoutMs: 1500, misses: 2 });
    const first = watchStep(0, false);
    expect(first).toEqual({ misses: 1, rebuild: false });
    expect(watchStep(first.misses, false), 'второй пропуск подряд').toEqual({ misses: 0, rebuild: true });
  });

  it('ответ между пропусками обнуляет счёт: два пропуска не подряд — не повод', () => {
    const missed = watchStep(0, false);
    const answered = watchStep(missed.misses, true);
    expect(answered).toEqual({ misses: 0, rebuild: false });
    expect(watchStep(answered.misses, false)).toEqual({ misses: 1, rebuild: false });
  });

  it('человек не трогает мышь и клавиатуру (экран мог погаснуть) — пропуски не считаются', () => {
    expect(watchStep(1, false, false)).toEqual({ misses: 0, rebuild: false });
  });
});

describe('лимит пересозданий (R137): не больше 3 за 5 минут', () => {
  const minute = 60_000;
  it('три подряд — можно, четвёртое в те же 5 минут — нет, и известно, когда снова можно', () => {
    expect(MINI_REBUILDS).toEqual({ count: 3, windowMs: 5 * minute });
    let history: number[] = [];
    for (const at of [0, minute, 2 * minute]) {
      const decision = decideRebuild(history, at);
      expect(decision.allowed).toBe(true);
      history = decision.history;
    }
    const fourth = decideRebuild(history, 3 * minute);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAt).toBe(5 * minute);
    expect(fourth.history, 'отказ ничего не записывает').toEqual([0, minute, 2 * minute]);
  });

  it('старше 5 минут — забыто', () => {
    const decision = decideRebuild([0, minute, 2 * minute], 5 * minute + 1);
    expect(decision.allowed).toBe(true);
    expect(decision.history).toEqual([minute, 2 * minute, 5 * minute + 1]);
  });
});

describe('смена мониторов (R137): что пересоздаёт окно', () => {
  it('размер, масштаб и поворот — пересоздать; только рабочая область (панель задач) — нет', () => {
    expect(displayChange(['scaleFactor'])).toBe('renew');
    expect(displayChange(['bounds', 'workArea'])).toBe('renew');
    expect(displayChange(['rotation'])).toBe('renew');
    expect(displayChange([])).toBeNull();
  });

  it('только рабочая область (панель задач переехала или стала шире) — не пересоздать, а снова поставить окно целиком в неё (R188)', () => {
    expect(displayChange(['workArea'])).toBe('place');
  });
});

describe('нажатия мини-окна и трея — кто исполняет (R93, R137, R156)', () => {
  it('«звук встречи» исполняет встреча, не поднимая Cord, — как микрофон, камера и выход', () => {
    for (const id of ['mic', 'deafen', 'camera', 'leave']) expect(miniActionRoute(id, undefined, false), id).toBe('page');
    expect(miniActionRoute('deafen', true, false)).toBe('page');
    expect(miniActionRoute('deafen', false, true)).toBe('page');
  });

  it('участники, чат, настройки и начало показа — окно Cord впереди; остановить показ — без него', () => {
    for (const id of ['people', 'chat', 'settings']) expect(miniActionRoute(id, undefined, false), id).toBe('page-focus');
    expect(miniActionRoute('screen', undefined, false)).toBe('page-focus');
    expect(miniActionRoute('screen', true, true)).toBe('page-focus');
    expect(miniActionRoute('screen', undefined, true)).toBe('page');
    expect(miniActionRoute('screen', false, false)).toBe('page');
  });

  it('развернуть, свернуть, открыть — сама оболочка; незнакомое — unknown (мини-окну сразу ignored)', () => {
    for (const id of ['open', 'collapse', 'expand', 'compact']) expect(miniActionRoute(id, undefined, false), id).toBe('main');
    expect(miniActionRoute('record', undefined, false)).toBe('unknown');
  });
});

describe('место мини-окна (R188): где поставил человек, но целиком в рабочей области своего экрана', () => {
  // Основной экран 1920×1080 с панелью задач 48 px внизу; второй — справа, 2560×1440 без панели.
  const primary = { x: 0, y: 0, width: 1920, height: 1032 };
  const right = { x: 1920, y: 0, width: 2560, height: 1440 };
  const areas = [primary, right];
  const compact = { width: 220, height: 200 };
  const expanded = { width: 260, height: 545 };

  it('места нет — снизу справа основного экрана с отступом', () => {
    expect(placeMini({}, compact, areas, primary)).toEqual({ x: 1920 - 220 - MINI_MARGIN, y: 1032 - 200 - MINI_MARGIN });
    expect(placeMini({ x: Number.NaN, y: 10 }, compact, areas, primary), 'не число — как нет места').toEqual({ x: 1920 - 220 - MINI_MARGIN, y: 1032 - 200 - MINI_MARGIN });
  });

  it('целиком на экране — ровно там, где поставили', () => {
    expect(placeMini({ x: 300, y: 400 }, compact, areas, primary)).toEqual({ x: 300, y: 400 });
    expect(placeMini({ x: 3000, y: 900 }, compact, areas, primary), 'на втором экране — тоже').toEqual({ x: 3000, y: 900 });
  });

  it('владелец: подвинул вниз, развернул — окно поднимается над панелью задач целиком; свернул — опускается на своё место', () => {
    const anchor = { x: 1600, y: 800 };
    expect(placeMini(anchor, compact, areas, primary)).toEqual({ x: 1600, y: 800 });
    const up = placeMini(anchor, expanded, areas, primary);
    expect(up).toEqual({ x: 1600, y: 1032 - 545 });
    expect(up.y + expanded.height, 'низ развёрнутого — над панелью задач, «Выйти из встречи» видно').toBeLessThanOrEqual(primary.y + primary.height);
    expect(placeMini(anchor, compact, areas, primary), 'место человека не потерялось').toEqual(anchor);
  });

  it('частью за краем — сдвигается внутрь со всех четырёх сторон', () => {
    expect(placeMini({ x: -100, y: -50 }, compact, areas, primary)).toEqual({ x: 0, y: 0 });
    expect(placeMini({ x: 1800, y: 1000 }, compact, [primary], primary), 'за правым и нижним краем одного экрана').toEqual({ x: 1920 - 220, y: 1032 - 200 });
  });

  it('на стыке двух экранов — на том, где его больше', () => {
    // 220 px: 40 на основном, 180 на втором — на второй.
    expect(placeMini({ x: 1880, y: 100 }, compact, areas, primary)).toEqual({ x: 1920, y: 100 });
    // 180 на основном, 40 на втором — на основной.
    expect(placeMini({ x: 1740, y: 100 }, compact, areas, primary)).toEqual({ x: 1700, y: 100 });
  });

  it('второй экран у нижнего края — поднимается в его рабочей области, а не прыгает на основной', () => {
    expect(placeMini({ x: 3000, y: 1300 }, expanded, areas, primary)).toEqual({ x: 3000, y: 1440 - 545 });
  });

  it('монитор с запомненным местом отключили — на ближайший экран, целиком', () => {
    expect(placeMini({ x: 5000, y: 300 }, compact, [primary], primary)).toEqual({ x: 1920 - 220, y: 300 });
    expect(placeMini({ x: -2000, y: 2000 }, compact, areas, primary)).toEqual({ x: 0, y: 1032 - 200 });
  });

  it('окно больше рабочей области — к её левому верхнему углу: полоса и «—» / «⧉» на экране', () => {
    expect(placeMini({ x: 50, y: 50 }, { width: 260, height: 640 }, [{ x: 0, y: 0, width: 1024, height: 560 }], primary)).toEqual({ x: 50, y: 0 });
  });

  it('экран слева от основного (отрицательные координаты)', () => {
    const left = { x: -1280, y: 200, width: 1280, height: 984 };
    expect(nearestArea({ x: -600, y: 900, width: 220, height: 200 }, [primary, left])).toBe(left);
    expect(placeMini({ x: -600, y: 1100 }, compact, [primary, left], primary)).toEqual({ x: -600, y: 200 + 984 - 200 });
  });
});

describe('перетаскивание (R188): точка, за которую взяли, — под настоящим курсором', () => {
  it('за какую точку взяли — с полосы, в пределах окна; мусор — null', () => {
    expect(readGrab({ phase: 'start', x: 40, y: 14 }, { width: 220, height: 200 })).toEqual({ x: 40, y: 14 });
    expect(readGrab({ x: -5, y: 900 }, { width: 220, height: 200 })).toEqual({ x: 0, y: 200 });
    for (const bad of [null, 'x', {}, { x: '40', y: 14 }, { x: Number.POSITIVE_INFINITY, y: 1 }, { x: 1, y: Number.NaN }]) expect(readGrab(bad, { width: 220, height: 200 })).toBeNull();
  });

  it('окно — курсор минус точка захвата; сдвиги не копятся: где курсор, там и окно', () => {
    const grab = { x: 40, y: 14 };
    expect(dragPosition({ x: 1000, y: 500 }, grab)).toEqual({ x: 960, y: 486 });
    // Курсор вернулся туда же — окно на том же месте, сколько бы событий ни потерялось по дороге.
    expect(dragPosition({ x: 1000, y: 500 }, grab)).toEqual(dragPosition({ x: 1000, y: 500 }, grab));
    expect(dragPosition({ x: -700, y: 300 }, grab), 'экран слева').toEqual({ x: -740, y: 286 });
    expect(dragPosition({ x: 100.6, y: 50.4 }, { x: 0.2, y: 0 })).toEqual({ x: 100, y: 50 });
  });
});

describe('заготовка мини-окна (R188): новое окно — когда Cord впереди или окно нужно сейчас', () => {
  const base = { inCall: true, enabled: true, main: true, quitting: false, wanted: false, cordInFront: true };

  it('человек вернулся в Cord — заготовить: следующий показ без задержки', () => {
    expect(spareMini(base)).toBe('prepare');
  });

  it('окно нужно сейчас — создать, даже если Cord не впереди', () => {
    expect(spareMini({ ...base, cordInFront: false, wanted: true })).toBe('prepare');
  });

  it('окно ушло ради игры, окна во весь экран или «—», а Cord не впереди — новое не создаётся, но и не убирается', () => {
    expect(spareMini({ ...base, cordInFront: false })).toBe('wait');
  });

  it('вне встречи, выключено, нет главного окна, выход — окна нет вовсе', () => {
    expect(spareMini({ ...base, inCall: false })).toBe('release');
    expect(spareMini({ ...base, enabled: false, wanted: true })).toBe('release');
    expect(spareMini({ ...base, main: false })).toBe('release');
    expect(spareMini({ ...base, quitting: true, wanted: true })).toBe('release');
  });
});

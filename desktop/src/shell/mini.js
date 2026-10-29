// Мини-окно звонка (R93, DESIGN.md → Мини-оверлей звонка; n06/n07 — Телемост). Компактное — до трёх
// плиток (показ экрана первым, затем тот, кто говорил последним) и пульт: микрофон, показ, «ещё»;
// развёрнутое — своя плитка, всё управление звонком и красная «Выйти из встречи». Нажатия уходят в
// main (`mini.action`), состояние встречи — `mini.state`, состав — `overlay.roster`, кто говорит —
// по порту уровней прямо со страницы встречи (`overlay.levels`). Пока связь со звуком восстанавливается
// (`state.status`), встреча не исполняет микрофон, камеру и показ — эти кнопки погашены, сверху полоса
// «Связь восстанавливается… 18 с», кольца говорящих сняты.
//
// R137 — окно не «замерзает» и не теряет нажатий:
// - узлы создаются один раз и дальше правятся на месте (плитки — по id): нажатие, начатое до того, как
//   пришёл новый состав или сообщение в чат, не попадает в удалённую кнопку;
// - одно делегированное нажатие на всё окно по `data-action`;
// - нажатие несёт нужное состояние (`want`: включить или выключить, а не «переключить») и номер; кнопка
//   показывает «ожидание», пока встреча не ответит (`mini.ack`), не придёт новое состояние или не
//   пройдут 4 с — тогда main просит у встречи всё заново (`mini.resync`);
// - перетаскивание за полосу — своим кодом (сдвиг мыши → `mini.drag`), без `app-region: drag`;
// - на вопрос сторожа main (`mini.ping`) страница отвечает из `requestAnimationFrame`: окно рисует.
(() => {
  const $ = (id) => document.getElementById(id);
  const mini = $('mini');
  const bar = $('bar');
  const tiles = $('tiles');
  /** Порядок плиток пересчитывается не чаще раза в секунду: плитки не прыгают на каждом «угу». */
  const REORDER_MS = 1000;
  const SLOTS = 3;
  /** Уровни перестали приходить дольше этого — кольца гаснут, а не светятся последним «угу». */
  const LEVELS_STALE_MS = 1500;
  /** Нажатие ждёт ответа встречи или нового состояния не дольше этого; дальше — `mini.resync`. */
  const PENDING_MS = 4000;
  /** Сдвиг мыши по полосе, после которого это перетаскивание, а не щелчок. */
  const DRAG_SLOP = 3;
  /** После перетаскивания двойной щелчок по полосе не считается: это было не «развернуть». */
  const DRAG_QUIET_MS = 600;

  let config = { expanded: false, language: 'ru', text: {} };
  let state = { room: '', self: '', mic: false, camera: false, screen: false, unread: 0, count: 0, status: 'connected', remaining: 0 };
  let people = [];
  const tiers = new Map();
  /** Когда человек говорил последний раз (ступень ≥ 2). */
  const spoke = new Map();
  let order = [];
  let levelsAt = 0;

  /** Встреча исполняет микрофон, камеру и показ — только пока связь идёт (как пульт встречи). */
  const live = () => state.status === 'connected';
  /** Это встреча исполняет только при связи — без неё нажатие не уходит, даже если кнопка не успела погаснуть. */
  const NEEDS_LINK = new Set(['mic', 'camera', 'screen']);
  /** Что просить у встречи: включить или выключить — по тому, что видно сейчас. */
  const WANT = { mic: () => !state.mic, camera: () => !state.camera, screen: () => !state.screen };
  /** Это исполняет встреча, не поднимая Cord: кнопка ждёт её ответа. */
  const AWAITED = new Set(['mic', 'camera', 'screen', 'leave']);
  /** Ждут ответа: id действия → номер нажатия и таймер. */
  const pending = new Map();
  let seq = 0;

  const call = (method, payload) => void window.cordShell.call(method, payload).catch(() => {});

  function markPending(id, on) {
    for (const element of document.querySelectorAll(`[data-action="${id}"]`)) {
      if (on) {
        element.dataset.pending = 'true';
        element.setAttribute('aria-busy', 'true');
      } else if (element.dataset.pending) {
        delete element.dataset.pending;
        element.removeAttribute('aria-busy');
      }
    }
  }

  function settle(id) {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    markPending(id, false);
  }

  function act(id) {
    if (NEEDS_LINK.has(id) && !live()) return;
    seq += 1;
    const mine = seq;
    const want = WANT[id] ? WANT[id]() : undefined;
    if (AWAITED.has(id)) {
      settle(id);
      const timer = setTimeout(() => {
        if (pending.get(id)?.seq !== mine) return;
        settle(id);
        // Ни ответа, ни нового состояния: пусть main и встреча пришлют всё, что знают, заново.
        call('mini.resync');
      }, PENDING_MS);
      pending.set(id, { seq: mine, timer });
      markPending(id, true);
    }
    call('mini.action', want === undefined ? { id, seq: mine } : { id, want, seq: mine });
  }

  // Одно нажатие на всё окно: кнопка — ближайший `data-action`. Значки и подписи внутри кнопок мышь
  // не ловят (`button * { pointer-events: none }`), так что нажатие всегда приходит в саму кнопку.
  mini.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target || target.disabled || !mini.contains(target)) return;
    act(target.dataset.action);
  });

  // ----- перетаскивание за полосу -----

  let drag = null;
  let dragFrame = 0;
  let draggedAt = 0;
  bar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button'))) return;
    drag = { pointerId: event.pointerId, x: event.screenX, y: event.screenY, dx: 0, dy: 0, moving: false };
    // Мышь быстро уходит за полосу и за окно — события всё равно приходят сюда.
    try {
      bar.setPointerCapture(event.pointerId);
    } catch {
      /* указатель уже отпущен */
    }
  });
  // Слушаем документ, а не полосу: первый сдвиг часто уже за ней, а захват указателя мог не встать.
  document.addEventListener(
    'pointermove',
    (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      // Кнопку отпустили, а `pointerup` потерялся (отпустили за окном) — перетаскивание кончилось.
      if (!(event.buttons & 1)) return endDrag();
      drag.dx = event.screenX - drag.x;
      drag.dy = event.screenY - drag.y;
      if (!drag.moving) {
        if (Math.hypot(drag.dx, drag.dy) < DRAG_SLOP) return;
        drag.moving = true;
        call('mini.drag', { phase: 'start' });
      }
      if (dragFrame) return;
      dragFrame = requestAnimationFrame(() => {
        dragFrame = 0;
        if (drag && drag.moving) call('mini.drag', { phase: 'move', dx: drag.dx, dy: drag.dy });
      });
    },
    true,
  );
  function endDrag() {
    if (!drag) return;
    const was = drag;
    drag = null;
    if (dragFrame) cancelAnimationFrame(dragFrame);
    dragFrame = 0;
    if (!was.moving) return;
    draggedAt = performance.now();
    call('mini.drag', { phase: 'move', dx: was.dx, dy: was.dy });
    call('mini.drag', { phase: 'end' });
  }
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, endDrag, true);
  bar.addEventListener('lostpointercapture', endDrag);
  window.addEventListener('blur', endDrag);
  bar.addEventListener('dblclick', (event) => {
    if ((event.target instanceof Element && event.target.closest('button')) || performance.now() - draggedAt < DRAG_QUIET_MS) return;
    act(config.expanded ? 'compact' : 'expand');
  });

  // ----- узлы: создаются один раз, правятся на месте -----

  function setText(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  function setAttr(element, name, value) {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  }

  /** Значок первым ребёнком; тот же значок не перерисовывается. */
  function setIcon(host, name, size) {
    if (host.dataset.icon === name) return;
    host.dataset.icon = name;
    const icon = window.cordIcon(name, size);
    const old = host.querySelector(':scope > .icon');
    if (old) old.replaceWith(icon);
    else host.prepend(icon);
  }

  function button(element, icon, label, pressed) {
    setIcon(element, icon, 20);
    setAttr(element, 'aria-label', label);
    if (element.title !== label) element.title = label;
    if (pressed !== undefined) setAttr(element, 'aria-pressed', String(pressed));
  }

  /** Лицо: картинка `data:` или первая буква — перестраивается, только когда сменились имя или аватар. */
  const faces = new WeakMap();
  function face(element, person) {
    const name = person ? person.name : '';
    const picture = person && typeof person.avatar === 'string' && person.avatar.startsWith('data:image/') ? person.avatar : '';
    const key = picture || `\u0000${name}`;
    if (faces.get(element) === key) return;
    faces.set(element, key);
    element.dataset.face = String(window.cordFace(name));
    if (picture) {
      const image = document.createElement('img');
      image.alt = '';
      image.src = picture;
      element.replaceChildren(image);
    } else element.replaceChildren(document.createTextNode((name.trim().slice(0, 1) || '?').toLocaleUpperCase()));
  }

  function makeTile() {
    const element = document.createElement('div');
    element.className = 'tile';
    const picture = document.createElement('span');
    picture.className = 'face';
    const name = document.createElement('span');
    name.className = 'tile__name';
    const muted = document.createElement('span');
    muted.className = 'tile__muted';
    muted.append(window.cordIcon('mic-off', 12));
    const ring = document.createElement('span');
    ring.className = 'tile__ring';
    element.append(picture, name, muted, ring);
    return { element, face: picture, name };
  }

  function fillTile(tile, person, label) {
    const id = person ? person.id : '';
    if (tile.element.dataset.id !== id) tile.element.dataset.id = id;
    const tier = String(tiers.get(id) ?? 0);
    if (tile.element.dataset.tier !== tier) tile.element.dataset.tier = tier;
    const muted = String(!!person && person.muted);
    if (tile.element.dataset.muted !== muted) tile.element.dataset.muted = muted;
    face(tile.face, person);
    setText(tile.name, label);
  }

  /** Плитки компактного вида — по id человека: узел живёт, пока человек во встрече. */
  const tileNodes = new Map();
  function tileFor(person) {
    let tile = tileNodes.get(person.id);
    if (!tile) tileNodes.set(person.id, (tile = makeTile()));
    return tile;
  }

  // Своя плитка развёрнутого вида.
  const own = makeTile();
  own.element.classList.add('tile--self');
  own.element.id = 'self';
  $('self').replaceWith(own.element);

  // Плитка «Вы показываете экран» с «Завершить» и плитка «+N».
  const share = document.createElement('div');
  share.className = 'tile tile--share';
  const shareLabel = document.createElement('span');
  shareLabel.className = 'tile__label';
  const shareText = document.createElement('span');
  shareLabel.append(window.cordIcon('monitor-up', 14), shareText);
  const stop = document.createElement('button');
  stop.className = 'tile__stop';
  stop.type = 'button';
  stop.dataset.action = 'screen';
  share.append(shareLabel, stop);
  const more = document.createElement('div');
  more.className = 'tile tile--more';

  // Полоса связи: значок, текст, секунды.
  const link = $('link');
  const linkText = link.querySelector('.link__text');
  const linkSeconds = link.querySelector('.link__seconds');
  link.prepend(window.cordIcon('wifi', 14));

  // Действия развёрнутого вида.
  const actionNodes = new Map();
  for (const id of ['mic', 'camera', 'screen', 'people', 'chat', 'settings']) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'action';
    element.dataset.action = id;
    const label = document.createElement('span');
    label.className = 'action__label';
    const extra = document.createElement('span');
    extra.className = 'action__extra';
    element.append(label, extra);
    $('actions').append(element);
    actionNodes.set(id, { element, label, extra, extraKey: '' });
  }
  const leaveLabel = $('leave').querySelector('.leave__label');

  /** Подпись справа у действия: «вкл./выкл.», бейдж числа или ничего — меняется, только если другое. */
  function setExtra(node, kind, value) {
    const key = `${kind}:${value}`;
    if (node.extraKey === key) return;
    node.extraKey = key;
    if (!kind) return node.extra.replaceChildren();
    const element = document.createElement(kind === 'small' ? 'small' : 'span');
    if (kind !== 'small') element.className = kind === 'alert' ? 'badge badge--alert' : 'badge';
    element.textContent = value;
    node.extra.replaceChildren(element);
  }

  function action(id, icon, label, extraKind, extraValue, on, disabled) {
    const node = actionNodes.get(id);
    setIcon(node.element, icon, 20);
    setText(node.label, label);
    setExtra(node, extraKind, extraValue);
    const live = String(!!on);
    if (node.element.dataset.live !== live) node.element.dataset.live = live;
    if (node.element.disabled !== !!disabled) node.element.disabled = !!disabled;
  }

  const count = (value) => (value > 99 ? '99+' : String(value));

  /** Полоса связи: текст и секунды. Секунды меняются раз в секунду — только они. */
  function renderLink() {
    const text = config.text;
    if (link.hidden !== live()) link.hidden = live();
    if (link.hidden) return;
    setText(linkText, state.status === 'recovering' ? text.recovering || '' : text.connecting || '');
    setText(linkSeconds, state.status === 'recovering' && state.remaining > 0 ? (text.seconds || '{n}').replace('{n}', String(state.remaining)) : '');
  }

  function others() {
    return people.filter((person) => person.id !== state.self);
  }

  /**
   * Состав или своё id сменились: порядок прежний, ушедшие убраны, новые — в конце. Пересчёт по
   * говорящим — только по таймеру раз в секунду, а не на каждый состав (он меняется на каждое «вкл.»).
   */
  function syncOrder() {
    const ids = others().map((person) => person.id);
    const present = new Set(ids);
    const kept = order.filter((id) => present.has(id));
    const known = new Set(kept);
    order = [...kept, ...ids.filter((id) => !known.has(id))];
  }

  function reorder() {
    const index = new Map(people.map((person, position) => [person.id, position]));
    order = others()
      .slice()
      .sort((a, b) => (spoke.get(b.id) ?? 0) - (spoke.get(a.id) ?? 0) || index.get(a.id) - index.get(b.id))
      .map((person) => person.id);
  }

  function sameChildren(parent, list) {
    const children = parent.children;
    if (children.length !== list.length) return false;
    return list.every((element, index) => children[index] === element);
  }

  function renderCompact() {
    const text = config.text;
    const list = [];
    if (state.screen) {
      setText(shareText, text.youShare || '');
      button(stop, 'monitor-x', text.stopShare || '');
      if (stop.disabled !== !live()) stop.disabled = !live();
      list.push(share);
    }
    const byId = new Map(people.map((person) => [person.id, person]));
    const rest = order.map((id) => byId.get(id)).filter(Boolean);
    const slots = SLOTS - list.length;
    const add = (person, label) => {
      const tile = tileFor(person);
      fillTile(tile, person, label);
      list.push(tile.element);
    };
    if (!rest.length) {
      const self = byId.get(state.self);
      if (self) add(self, text.you || self.name);
    } else if (rest.length > slots) {
      for (const person of rest.slice(0, slots - 1)) add(person, person.name);
      setText(more, `+${rest.length - slots + 1}`);
      list.push(more);
    } else for (const person of rest) add(person, person.name);
    if (!sameChildren(tiles, list)) tiles.replaceChildren(...list);
    const mic = $('dock-mic');
    const screen = $('dock-screen');
    button(mic, state.mic ? 'mic' : 'mic-off', state.mic ? text.micMute || '' : text.micUnmute || '', state.mic);
    button(screen, state.screen ? 'monitor-x' : 'monitor-up', state.screen ? text.stopShare || '' : text.screenShare || '');
    if (screen.dataset.live !== String(state.screen)) screen.dataset.live = String(state.screen);
    if (mic.disabled !== !live()) mic.disabled = !live();
    if (screen.disabled !== !live()) screen.disabled = !live();
    button($('dock-more'), 'more', text.more || '');
  }

  function renderExpanded() {
    const text = config.text;
    const self = people.find((person) => person.id === state.self) || null;
    fillTile(own, self, text.you || '');
    action('mic', state.mic ? 'mic' : 'mic-off', text.microphone || '', 'small', state.mic ? text.on || '' : text.off || '', false, !live());
    action('camera', state.camera ? 'video' : 'video-off', text.camera || '', 'small', state.camera ? text.on || '' : text.off || '', false, !live());
    action('screen', 'monitor-up', text.screenShare || '', state.screen ? 'small' : '', state.screen ? text.screenStop || '' : '', state.screen, !live());
    action('people', 'users', text.people || '', state.count ? 'badge' : '', state.count ? count(state.count) : '');
    action('chat', 'message', text.chat || '', state.unread ? 'alert' : '', state.unread ? count(state.unread) : '');
    action('settings', 'sliders', text.soundSettings || '', '', '');
    setIcon($('leave'), 'phone-off', 20);
    setText(leaveLabel, text.leave || '');
  }

  function render() {
    const text = config.text;
    setAttr(document.documentElement, 'lang', config.language || 'ru');
    const mode = config.expanded ? 'expanded' : 'compact';
    if (mini.dataset.mode !== mode) mini.dataset.mode = mode;
    setAttr(mini, 'aria-label', [text.label, state.room].filter(Boolean).join(' · '));
    setText($('title'), config.expanded ? state.room : '');
    button($('compact'), 'minimize-2', text.compact || '');
    button($('collapse'), 'minus', text.collapse || '');
    button($('open'), 'maximize-2', text.open || '');
    if (mini.dataset.link !== state.status) mini.dataset.link = state.status;
    renderLink();
    if (!live()) applyLevels([]);
    if (config.expanded) renderExpanded();
    else renderCompact();
    for (const id of pending.keys()) markPending(id, true);
  }

  /** Уровни с порта: кольца у плиток — точечно; порядок плиток — по таймеру. */
  function applyLevels(levels) {
    const now = Date.now();
    levelsAt = now;
    tiers.clear();
    for (const entry of Array.isArray(levels) && live() ? levels : []) {
      if (!Array.isArray(entry)) continue;
      const tier = Number(entry[1]) || 0;
      tiers.set(String(entry[0]), tier);
      if (tier >= 2) spoke.set(String(entry[0]), now);
    }
    for (const element of document.querySelectorAll('.tile[data-id]')) {
      const tier = String(tiers.get(element.dataset.id) ?? 0);
      if (element.dataset.tier !== tier) element.dataset.tier = tier;
    }
  }

  setInterval(() => {
    if (tiers.size && Date.now() - levelsAt > LEVELS_STALE_MS) applyLevels([]);
    if (config.expanded) return;
    const before = order.join(',');
    reorder();
    if (order.join(',') !== before) renderCompact();
  }, REORDER_MS);

  // Размер окна — по карточке: main подстраивает окно.
  const frame = $('frame');
  new ResizeObserver(() => call('mini.size', { width: frame.offsetWidth, height: frame.offsetHeight })).observe(frame);

  window.cordShell.on('mini.config', (next) => {
    if (!next || typeof next !== 'object') return;
    config = { ...config, ...next, text: { ...config.text, ...(next.text || {}) } };
    render();
  });
  window.cordShell.on('mini.state', (next) => {
    if (!next || typeof next !== 'object') return;
    state = { ...state, ...next };
    // Новое состояние — ответ на всё, что ждало: видно, исполнила ли встреча нажатие.
    for (const id of [...pending.keys()]) settle(id);
    syncOrder();
    render();
  });
  window.cordShell.on('overlay.roster', (data) => {
    people = data && Array.isArray(data.participants) ? data.participants.map((entry) => ({ id: String(entry.id), name: String(entry.name || ''), avatar: entry.avatar || '', muted: entry.muted === true })) : [];
    const present = new Set(people.map((person) => person.id));
    for (const id of tileNodes.keys()) if (!present.has(id)) tileNodes.delete(id);
    syncOrder();
    render();
  });
  window.cordShell.on('overlay.levels', (data) => applyLevels(data && data.levels));
  window.cordShell.on('mini.ack', (data) => {
    if (!data || typeof data.seq !== 'number') return;
    for (const [id, entry] of pending) if (entry.seq === data.seq) settle(id);
  });
  // Сторож main: «окно рисует?» — ответ из кадра, а не сразу: застывшее окно кадров не даёт.
  window.cordShell.on('mini.ping', (data) => {
    const asked = data && typeof data.seq === 'number' ? data.seq : 0;
    requestAnimationFrame(() => call('mini.pong', { seq: asked }));
  });
  render();
})();

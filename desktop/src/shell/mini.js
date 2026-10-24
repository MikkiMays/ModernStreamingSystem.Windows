// Мини-окно звонка (R93, DESIGN.md → Мини-оверлей звонка; n06/n07 — Телемост). Компактное — до трёх
// плиток (показ экрана первым, затем тот, кто говорил последним) и пульт: микрофон, показ, «ещё»;
// развёрнутое — своя плитка, всё управление звонком и красная «Выйти из встречи». Нажатия уходят в
// main (`mini.action`), состояние встречи — `mini.state`, состав — `overlay.roster`, кто говорит —
// по порту уровней прямо со страницы встречи (`overlay.levels`).
(() => {
  const $ = (id) => document.getElementById(id);
  const mini = $('mini');
  const tiles = $('tiles');
  /** Порядок плиток пересчитывается не чаще раза в секунду: плитки не прыгают на каждом «угу». */
  const REORDER_MS = 1000;
  const SLOTS = 3;

  let config = { expanded: false, language: 'ru', text: {} };
  let state = { room: '', self: '', mic: false, camera: false, screen: false, unread: 0, count: 0 };
  let people = [];
  const tiers = new Map();
  /** Когда человек говорил последний раз (ступень ≥ 2). */
  const spoke = new Map();
  let order = [];

  const act = (id) => void window.cordShell.call('mini.action', { id });
  for (const button of document.querySelectorAll('[data-action]')) button.addEventListener('click', () => act(button.dataset.action));
  $('bar').addEventListener('dblclick', (event) => {
    if (event.target.closest('button')) return;
    act(config.expanded ? 'compact' : 'expand');
  });

  function face(person, size) {
    const element = document.createElement('span');
    element.className = 'face';
    const name = person ? person.name : '';
    element.dataset.face = String(window.cordFace(name));
    const picture = person && typeof person.avatar === 'string' && person.avatar.startsWith('data:image/') ? person.avatar : '';
    if (picture) {
      const image = document.createElement('img');
      image.alt = '';
      image.src = picture;
      element.append(image);
    } else element.textContent = (name.trim().slice(0, 1) || '?').toLocaleUpperCase();
    if (size) element.style.fontSize = `${size}px`;
    return element;
  }

  function tile(person, label) {
    const element = document.createElement('div');
    element.className = 'tile';
    element.dataset.id = person ? person.id : '';
    element.dataset.tier = String(tiers.get(element.dataset.id) ?? 0);
    element.dataset.muted = String(!!person && person.muted);
    const ring = document.createElement('span');
    ring.className = 'tile__ring';
    const name = document.createElement('span');
    name.className = 'tile__name';
    name.textContent = label;
    const muted = document.createElement('span');
    muted.className = 'tile__muted';
    muted.append(window.cordIcon('mic-off', 12));
    element.append(face(person), name, muted, ring);
    return element;
  }

  function button(element, icon, label, pressed) {
    element.replaceChildren(window.cordIcon(icon, 20));
    element.setAttribute('aria-label', label);
    element.title = label;
    if (pressed !== undefined) element.setAttribute('aria-pressed', String(pressed));
  }

  function others() {
    return people.filter((person) => person.id !== state.self);
  }

  function reorder() {
    const index = new Map(people.map((person, position) => [person.id, position]));
    order = others()
      .slice()
      .sort((a, b) => (spoke.get(b.id) ?? 0) - (spoke.get(a.id) ?? 0) || index.get(a.id) - index.get(b.id))
      .map((person) => person.id);
  }

  function renderCompact() {
    const text = config.text;
    const list = [];
    if (state.screen) {
      const share = document.createElement('div');
      share.className = 'tile tile--share';
      const label = document.createElement('span');
      label.className = 'tile__label';
      label.append(window.cordIcon('monitor-up', 14), document.createTextNode(text.youShare || ''));
      const stop = document.createElement('button');
      stop.className = 'tile__stop';
      stop.type = 'button';
      button(stop, 'monitor-x', text.stopShare || '');
      stop.addEventListener('click', () => act('screen'));
      share.append(label, stop);
      list.push(share);
    }
    const byId = new Map(people.map((person) => [person.id, person]));
    const rest = order.map((id) => byId.get(id)).filter(Boolean);
    const slots = SLOTS - list.length;
    if (!rest.length) {
      const self = byId.get(state.self);
      if (self) list.push(tile(self, text.you || self.name));
    } else if (rest.length > slots) {
      for (const person of rest.slice(0, slots - 1)) list.push(tile(person, person.name));
      const more = document.createElement('div');
      more.className = 'tile tile--more';
      more.textContent = `+${rest.length - slots + 1}`;
      list.push(more);
    } else for (const person of rest) list.push(tile(person, person.name));
    tiles.replaceChildren(...list);
    button($('dock-mic'), state.mic ? 'mic' : 'mic-off', state.mic ? text.micMute || '' : text.micUnmute || '', state.mic);
    button($('dock-screen'), state.screen ? 'monitor-x' : 'monitor-up', state.screen ? text.stopShare || '' : text.screenShare || '');
    $('dock-screen').dataset.live = String(state.screen);
    button($('dock-more'), 'more', text.more || '');
  }

  function action(id, icon, label, extra, live) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'action';
    element.dataset.live = String(!!live);
    element.append(window.cordIcon(icon, 20), document.createTextNode(label));
    if (extra) element.append(extra);
    element.addEventListener('click', () => act(id));
    return element;
  }

  function small(text) {
    const element = document.createElement('small');
    element.textContent = text;
    return element;
  }

  function badge(count, alert) {
    const element = document.createElement('span');
    element.className = alert ? 'badge badge--alert' : 'badge';
    element.textContent = count > 99 ? '99+' : String(count);
    return element;
  }

  function renderExpanded() {
    const text = config.text;
    const self = people.find((person) => person.id === state.self) || null;
    const own = tile(self, text.you || '');
    own.classList.add('tile--self');
    own.id = 'self';
    $('self').replaceWith(own);
    $('actions').replaceChildren(
      action('mic', state.mic ? 'mic' : 'mic-off', text.microphone || '', small(state.mic ? text.on || '' : text.off || '')),
      action('camera', state.camera ? 'video' : 'video-off', text.camera || '', small(state.camera ? text.on || '' : text.off || '')),
      action('screen', 'monitor-up', text.screenShare || '', state.screen ? small(text.screenStop || '') : null, state.screen),
      action('people', 'users', text.people || '', state.count ? badge(state.count, false) : null),
      action('chat', 'message', text.chat || '', state.unread ? badge(state.unread, true) : null),
      action('settings', 'sliders', text.soundSettings || ''),
    );
    const leave = $('leave');
    leave.replaceChildren(window.cordIcon('phone-off', 20), document.createTextNode(text.leave || ''));
  }

  function render() {
    const text = config.text;
    document.documentElement.lang = config.language || 'ru';
    mini.dataset.mode = config.expanded ? 'expanded' : 'compact';
    mini.setAttribute('aria-label', [text.label, state.room].filter(Boolean).join(' · '));
    $('title').textContent = config.expanded ? state.room : '';
    button($('compact'), 'minimize-2', text.compact || '');
    button($('collapse'), 'minus', text.collapse || '');
    button($('open'), 'maximize-2', text.open || '');
    if (config.expanded) renderExpanded();
    else renderCompact();
  }

  /** Уровни с порта: кольца у плиток — точечно; порядок плиток — по таймеру. */
  function applyLevels(levels) {
    const now = Date.now();
    tiers.clear();
    for (const entry of Array.isArray(levels) ? levels : []) {
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
    if (config.expanded) return;
    const before = order.join(',');
    reorder();
    if (order.join(',') !== before) renderCompact();
  }, REORDER_MS);

  // Размер окна — по содержимому (с полем под тень): main подстраивает окно.
  const frame = $('frame');
  new ResizeObserver(() => void window.cordShell.call('mini.size', { width: frame.offsetWidth, height: frame.offsetHeight })).observe(frame);

  window.cordShell.on('mini.config', (next) => {
    if (!next || typeof next !== 'object') return;
    config = { ...config, ...next, text: { ...config.text, ...(next.text || {}) } };
    render();
  });
  window.cordShell.on('mini.state', (next) => {
    if (!next || typeof next !== 'object') return;
    state = { ...state, ...next };
    reorder();
    render();
  });
  window.cordShell.on('overlay.roster', (data) => {
    people = data && Array.isArray(data.participants) ? data.participants.map((entry) => ({ id: String(entry.id), name: String(entry.name || ''), avatar: entry.avatar || '', muted: entry.muted === true })) : [];
    reorder();
    render();
  });
  window.cordShell.on('overlay.levels', (data) => applyLevels(data && data.levels));
  render();
})();

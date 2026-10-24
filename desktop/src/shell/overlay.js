// Виджет говорящих в игре (R63, DESIGN.md → Оверлей). Состав приходит через main (`overlay.roster`),
// уровни голоса — по порту прямо со страницы встречи (`overlay.levels`, до 30 раз в секунду).
// Обновления точечные: у карточки меняется только `data-tier`, список не перерисовывается; порядок —
// стабильный, по составу встречи (говорящие не прыгают наверх, как у Discord). Вход и уход людей —
// 160 и 120 мс, остальные сдвигаются переходом `transform` (FLIP).
(() => {
  /** Больше карточек — последняя становится «+N». */
  const MAX = 12;
  const MORE = '__more';
  const $ = (id) => document.getElementById(id);
  const corner = $('corner');
  const widget = $('widget');
  const list = $('people');
  const unlocked = $('unlocked');
  const card = $('card');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  let config = { corner: 'tl', size: 'm', names: 'always', opacity: 100, offset: { x: 0, y: 0 }, locked: true, lockHotkey: null, language: 'ru', text: {} };
  /** Состав: `[{id, name, avatar, muted}]` по порядку встречи. */
  let people = [];
  /** Ступени голоса 0–4 по id. */
  const tiers = new Map();
  /** Карточки на экране по id (уходящие сюда не входят). */
  const items = new Map();

  // ---------- карточки ----------

  function create(person) {
    const item = document.createElement('li');
    item.className = 'person';
    item.dataset.id = person.id;
    item.dataset.tier = '0';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    const ring = document.createElement('span');
    ring.className = 'ring';
    const face = document.createElement('span');
    face.className = 'face';
    const micOff = document.createElement('span');
    micOff.className = 'mic-off';
    micOff.append(window.cordIcon('mic-off', 10));
    avatar.append(ring, face, micOff);
    const name = document.createElement('span');
    name.className = 'name';
    item.append(avatar, name);
    update(item, person);
    return item;
  }

  function update(item, person) {
    const face = item.querySelector('.face');
    const name = item.querySelector('.name');
    if (person.id === MORE) {
      item.classList.add('more');
      face.textContent = `+${person.count}`;
      name.textContent = '';
      name.hidden = true;
      return;
    }
    if (name.textContent !== person.name) name.textContent = person.name;
    item.dataset.muted = String(!!person.muted);
    item.querySelector('.mic-off').title = config.text.muted || '';
    // Картинка — только `data:image/` (main уже проверил); иначе — первая буква на цвете лица, как в вебе.
    const picture = typeof person.avatar === 'string' && person.avatar.startsWith('data:image/') ? person.avatar : '';
    if (face.dataset.picture !== picture || face.dataset.name !== person.name) {
      face.dataset.picture = picture;
      face.dataset.name = person.name;
      face.dataset.face = String(window.cordFace(person.name));
      face.replaceChildren();
      if (picture) {
        const image = document.createElement('img');
        image.alt = '';
        image.src = picture;
        face.append(image);
      } else face.textContent = (person.name.trim().slice(0, 1) || '?').toLocaleUpperCase();
    }
    const tier = String(tiers.get(person.id) ?? 0);
    if (item.dataset.tier !== tier) item.dataset.tier = tier;
  }

  /** Сдвиг остальных — переходом `transform` от старого места к новому. */
  function flip(change) {
    const before = new Map();
    for (const item of list.children) before.set(item, item.getBoundingClientRect().top);
    change();
    if (reduced.matches) return;
    for (const item of list.children) {
      const top = before.get(item);
      if (top === undefined || item.dataset.state === 'exit') continue;
      const delta = top - item.getBoundingClientRect().top;
      if (!delta) continue;
      item.classList.remove('moving');
      item.style.transform = `translateY(${delta}px)`;
      void item.offsetWidth;
      item.classList.add('moving');
      item.style.transform = '';
      item.addEventListener('transitionend', () => item.classList.remove('moving'), { once: true });
    }
  }

  function leave(item) {
    if (reduced.matches) {
      flip(() => item.remove());
      return;
    }
    item.dataset.state = 'exit';
    let done = false;
    const remove = () => {
      if (done) return;
      done = true;
      flip(() => item.remove());
    };
    item.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 200);
  }

  function render() {
    const shown = people.length > MAX ? people.slice(0, MAX - 1) : people;
    const wanted = people.length > MAX ? [...shown, { id: MORE, name: '', count: people.length - shown.length }] : shown;
    const keep = new Set(wanted.map((person) => person.id));
    flip(() => {
      for (const [id, item] of items)
        if (!keep.has(id)) {
          items.delete(id);
          leave(item);
        }
      let previous = null;
      for (const person of wanted) {
        let item = items.get(person.id);
        if (!item) {
          item = create(person);
          if (!reduced.matches) {
            const entering = item;
            entering.dataset.state = 'enter';
            entering.addEventListener('animationend', () => delete entering.dataset.state, { once: true });
          }
          items.set(person.id, item);
        } else update(item, person);
        const place = previous ? previous.nextSibling : list.firstChild;
        if (place !== item) list.insertBefore(item, place);
        previous = item;
      }
    });
  }

  /** Уровни с порта: только `data-tier` у тех, у кого он сменился. */
  function applyLevels(levels) {
    tiers.clear();
    for (const entry of Array.isArray(levels) ? levels : []) if (Array.isArray(entry)) tiers.set(String(entry[0]), Number(entry[1]) || 0);
    for (const [id, item] of items) {
      if (id === MORE) continue;
      const tier = String(tiers.get(id) ?? 0);
      if (item.dataset.tier !== tier) item.dataset.tier = tier;
    }
  }

  // ---------- вид, замок, перетаскивание ----------

  function applyConfig() {
    document.documentElement.lang = config.language || 'ru';
    corner.dataset.corner = config.corner;
    widget.dataset.size = config.size;
    widget.dataset.names = config.names;
    widget.style.opacity = String(Math.min(100, Math.max(30, Number(config.opacity) || 100)) / 100);
    widget.setAttribute('aria-label', config.text.label || '');
    place(config.offset);
    unlocked.textContent = (config.text.unlocked || '').replace('{hotkey}', config.lockHotkey || '');
    applyLock();
    renderCard();
    for (const [id, item] of items) {
      const person = people.find((entry) => entry.id === id);
      if (person) update(item, person);
    }
  }

  let drag = null;

  function applyLock() {
    document.body.dataset.locked = String(config.locked !== false);
    unlocked.hidden = config.locked !== false;
    if (config.locked !== false) {
      drag = null;
      widget.classList.remove('dragging');
    }
  }

  function place(offset) {
    const x = Number(offset && offset.x) || 0;
    const y = Number(offset && offset.y) || 0;
    corner.style.transform = x || y ? `translate(${x}px, ${y}px)` : '';
  }

  widget.addEventListener('pointerdown', (event) => {
    if (config.locked !== false || event.button !== 0) return;
    const rect = corner.getBoundingClientRect();
    const offset = config.offset || { x: 0, y: 0 };
    // Границы — от места без смещения: виджет не уезжает за монитор.
    const base = { left: rect.left - offset.x, top: rect.top - offset.y, right: rect.right - offset.x, bottom: rect.bottom - offset.y };
    drag = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, offset: { ...offset }, base };
    widget.setPointerCapture(event.pointerId);
    widget.classList.add('dragging');
  });
  widget.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const { base } = drag;
    const x = Math.round(Math.min(window.innerWidth - base.right, Math.max(-base.left, drag.offset.x + event.clientX - drag.startX)));
    const y = Math.round(Math.min(window.innerHeight - base.bottom, Math.max(-base.top, drag.offset.y + event.clientY - drag.startY)));
    config.offset = { x, y };
    place(config.offset);
  });
  const drop = (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    drag = null;
    widget.classList.remove('dragging');
    void window.cordShell.call('overlay.offset', config.offset);
  };
  widget.addEventListener('pointerup', drop);
  widget.addEventListener('pointercancel', drop);

  // ---------- карточка «Показать игру» (R104) ----------

  let offer = null;
  $('card-brand').append(window.cordIcon('gamepad', 28));
  $('card-close').append(window.cordIcon('x', 16));
  $('card-close').addEventListener('click', () => void window.cordShell.call('overlay.card.close'));
  $('card-go').addEventListener('click', () => void window.cordShell.call('overlay.golive'));

  function renderCard() {
    card.hidden = !offer;
    if (!offer) return;
    const text = config.text;
    $('card-title').textContent = text.cardTitle || '';
    $('card-close').setAttribute('aria-label', text.close || '');
    $('card-go').textContent = text.goLive || '';
    // Без сочетания разблокировки оверлей не нажать — кнопка остаётся в уведомлении Windows.
    $('card-go').hidden = !offer.keys;
    const hint = $('card-hint');
    hint.replaceChildren();
    if (offer.keys) {
      const [before, after = ''] = (text.cardHint || '{keys}').split('{keys}');
      if (before.trim()) hint.append(document.createTextNode(before.trim()));
      offer.keys.forEach((key, index) => {
        if (index) hint.append(document.createTextNode('+'));
        const pill = document.createElement('span');
        pill.className = 'kbd';
        pill.textContent = key;
        hint.append(pill);
      });
      if (after.trim()) hint.append(document.createTextNode(after.trim()));
    }
  }

  // ---------- события оболочки ----------

  window.cordShell.on('overlay.config', (next) => {
    if (!next || typeof next !== 'object') return;
    config = { ...config, ...next, text: { ...config.text, ...(next.text || {}) } };
    applyConfig();
  });
  window.cordShell.on('overlay.lock', (data) => {
    config.locked = !data || data.locked !== false;
    applyLock();
  });
  window.cordShell.on('overlay.roster', (data) => {
    const entries = data && Array.isArray(data.participants) ? data.participants : [];
    if (data && data.legacy) {
      // Веб до R63 (`overlay.state`): имена и ступени без id — id по месту в списке.
      people = entries.slice(0, 20).map((entry, index) => ({ id: `n${index}:${entry.name}`, name: String(entry.name || ''), avatar: '', muted: false }));
      tiers.clear();
      entries.slice(0, 20).forEach((entry, index) => tiers.set(`n${index}:${entry.name}`, Number(entry.tier) || (entry.speaking ? 2 : 0)));
    } else people = entries.map((entry) => ({ id: String(entry.id), name: String(entry.name || ''), avatar: entry.avatar || '', muted: entry.muted === true }));
    render();
  });
  window.cordShell.on('overlay.levels', (data) => applyLevels(data && data.levels));
  window.cordShell.on('overlay.card', (data) => {
    offer = data && typeof data.game === 'string' ? { game: data.game, keys: Array.isArray(data.keys) ? data.keys.map(String) : null } : null;
    renderCard();
  });
  applyConfig();
})();

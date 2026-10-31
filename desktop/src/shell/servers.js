// Окно серверов: только выбор из каталога Cord. Флаг — круглый SVG по коду страны (простые
// полосные флаги для стран каталога; остальным — круг с кодом), справа — загрузка сервера четырьмя
// палочками одной высоты и пинг (медиана трёх запросов) — R143, Р-37. Пока окно открыто, пинг и
// загрузка обновляются раз в 10 с (`servers.status`, запросы делает main). Тексты — на языке Cord
// (`servers.text`, как меню трея); русские в разметке — запасные, пока ответ не пришёл.
(() => {
  const FLAGS = {
    NL: ['#AE1C28', '#FFFFFF', '#21468B'],
    DE: ['#000000', '#DD0000', '#FFCE00'],
    RU: ['#FFFFFF', '#0039A6', '#D52B1E'],
    FR: ['#0055A4', '#FFFFFF', '#EF4135'],
    IT: ['#009246', '#FFFFFF', '#CE2B37'],
    US: ['#B22234', '#FFFFFF', '#3C3B6E'],
    GB: ['#012169', '#FFFFFF', '#C8102E'],
    FI: ['#FFFFFF', '#003580', '#FFFFFF'],
    PL: ['#FFFFFF', '#DC143C', '#DC143C'],
    ES: ['#AA151B', '#F1BF00', '#AA151B'],
    KZ: ['#00AFCA', '#00AFCA', '#00AFCA'],
    TR: ['#E30A17', '#E30A17', '#E30A17'],
  };
  /** Как часто спрашивать пинг и загрузку, пока окно открыто. */
  const REFRESH_MS = 10_000;
  const vertical = new Set(['FR', 'IT']);
  const flag = (country) => {
    const colors = FLAGS[country];
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('aria-hidden', 'true');
    if (!colors) {
      svg.innerHTML = `<circle cx="18" cy="18" r="18" fill="#2b3140"/><text x="18" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">${country}</text>`;
      return svg;
    }
    const stripes = vertical.has(country)
      ? colors.map((color, index) => `<rect x="${index * 12}" y="0" width="12" height="36" fill="${color}"/>`)
      : colors.map((color, index) => `<rect x="0" y="${index * 12}" width="36" height="12" fill="${color}"/>`);
    svg.innerHTML = `<clipPath id="c-${country}"><circle cx="18" cy="18" r="18"/></clipPath><g clip-path="url(#c-${country})">${stripes.join('')}</g><circle cx="18" cy="18" r="17.5" fill="none" stroke="rgba(255,255,255,.18)"/>`;
    return svg;
  };
  const list = document.getElementById('list');
  let language = 'ru';
  /** Тексты окна; до ответа `servers.text` — русские из разметки. */
  let text = { ping: '{n} мс', unknown: 'Загрузка сервера: неизвестна' };
  /** Строки окна: адрес сервера → элементы пинга и палочек. */
  const rows = [];

  const applyText = () => {
    document.documentElement.lang = language;
    const title = document.getElementById('title');
    if (text.title) {
      title.textContent = text.title;
      document.title = text.title;
    }
    if (text.list) list.setAttribute('aria-label', text.list);
    if (text.note) document.getElementById('note').textContent = text.note;
    if (text.close) document.getElementById('close').setAttribute('aria-label', text.close);
  };

  const makeBars = () => {
    const bars = document.createElement('span');
    bars.className = 'load';
    bars.setAttribute('role', 'img');
    for (let index = 0; index < 4; index++) bars.append(document.createElement('i'));
    return bars;
  };

  /** Пинг и палочки строки — по ответу `servers.status`; нет ответа — «—» и пустые палочки. */
  const show = (row, status) => {
    const ms = status ? status.ping : null;
    row.ping.textContent = ms === null || ms === undefined ? '—' : String(text.ping || '{n}').replace('{n}', String(ms));
    row.ping.dataset.tone = ms === null || ms === undefined ? 'bad' : ms < 80 ? 'good' : ms < 200 ? 'fair' : 'bad';
    const bars = status && status.bars ? status.bars : { filled: 0, tone: null, label: '' };
    if (bars.tone) row.bars.dataset.tone = bars.tone;
    else delete row.bars.dataset.tone;
    [...row.bars.children].forEach((bar, index) => {
      if (index < bars.filled) bar.dataset.on = 'true';
      else delete bar.dataset.on;
    });
    // Нет ответа — палочки всё равно названы: «Загрузка сервера: неизвестна».
    const label = bars.label || text.unknown;
    row.bars.setAttribute('aria-label', label);
    row.bars.title = label;
  };

  const refresh = (row) => {
    if (row.asking) return;
    row.asking = true;
    window.cordShell
      .call('servers.status', { url: row.url })
      .then((status) => show(row, status), () => show(row, null))
      .finally(() => {
        row.asking = false;
      });
  };

  const render = (servers) => {
    list.replaceChildren();
    rows.length = 0;
    for (const server of servers) {
      const item = document.createElement('li');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(server.current));
      item.tabIndex = 0;
      const badge = document.createElement('span');
      badge.className = 'flag';
      badge.append(flag(server.country));
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = server.name[language] || server.name[language.split('-')[0]] || server.name.ru;
      const host = document.createElement('small');
      host.textContent = new URL(server.url).host;
      name.append(host);
      const status = document.createElement('span');
      status.className = 'status';
      const bars = makeBars();
      bars.setAttribute('aria-label', text.unknown);
      const ping = document.createElement('span');
      ping.className = 'ping';
      ping.textContent = '…';
      status.append(bars, ping);
      item.append(badge, name, status);
      const choose = () => {
        if (server.current) return;
        window.cordShell.call('servers.choose', { url: server.url });
      };
      item.addEventListener('click', choose);
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); }
      });
      list.append(item);
      const row = { url: server.url, ping, bars, asking: false };
      rows.push(row);
      refresh(row);
    }
  };

  const texts = window.cordShell.call('servers.text').then(
    (answer) => {
      if (answer && typeof answer === 'object') {
        if (typeof answer.language === 'string') language = answer.language;
        if (answer.text && typeof answer.text === 'object') text = { ...text, ...answer.text };
      }
      applyText();
    },
    () => {},
  );
  // Имена серверов — на языке Cord: список рисуется, когда тексты уже пришли (или не пришли).
  texts.finally(() => window.cordShell.call('servers.list').then(render));
  setInterval(() => {
    if (document.visibilityState !== 'hidden') rows.forEach(refresh);
  }, REFRESH_MS);
  document.getElementById('close').addEventListener('click', () => window.cordShell.call('servers.close'));
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.cordShell.call('servers.close'); });
})();

// Окно серверов: только выбор из каталога Cord. Флаг — круглый SVG по коду страны (простые
// полосные флаги для стран каталога; остальным — круг с кодом), пинг — медиана трёх запросов.
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
  const language = (navigator.language || 'ru').split('-')[0];
  const render = (servers) => {
    list.replaceChildren();
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
      name.textContent = server.name[language] || server.name.ru;
      const host = document.createElement('small');
      host.textContent = new URL(server.url).host;
      name.append(host);
      const ping = document.createElement('span');
      ping.className = 'ping';
      ping.textContent = '…';
      item.append(badge, name, ping);
      const choose = () => {
        if (server.current) return;
        window.cordShell.call('servers.choose', { url: server.url });
      };
      item.addEventListener('click', choose);
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); }
      });
      list.append(item);
      window.cordShell.call('servers.ping', { url: server.url }).then((ms) => {
        ping.textContent = ms === null ? '—' : `${ms} мс`;
        ping.dataset.tone = ms === null ? 'bad' : ms < 80 ? 'good' : ms < 200 ? 'fair' : 'bad';
      });
    }
  };
  window.cordShell.call('servers.list').then(render);
  document.getElementById('close').addEventListener('click', () => window.cordShell.call('servers.close'));
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.cordShell.call('servers.close'); });
})();

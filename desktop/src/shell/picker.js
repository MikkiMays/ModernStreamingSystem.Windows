// Окно выбора источника: показывает экраны и окна, отдаёт выбор оболочке (`capture.pick`).
// Звук: «Звук системы» — loopback Electron (участники услышат и встречу); «Звук приложения»
// (только для окна) и «Система кроме Cord» — process loopback в cord-native (ADR 0001 §4.1).
(() => {
  const grid = document.getElementById('grid');
  const share = document.getElementById('share');
  const audioRow = document.getElementById('audio-row');
  const hint = document.getElementById('hint');
  const HINTS = {
    none: '',
    system: 'Участники услышат и голоса встречи. Для звука без эха выберите «Система кроме Cord».',
    app: 'Только звук выбранного приложения — голоса встречи в показ не попадут.',
    'system-except-cord': 'Весь звук компьютера, кроме самого Cord.',
  };
  let sources = [];
  let kind = 'screen';
  let chosen = null;
  let systemAudio = false;
  let appAudio = false;
  const audioMode = () => (audioRow.querySelector('input[name="audio"]:checked') || {}).value || 'none';
  const renderAudio = () => {
    const window = chosen ? sources.some((source) => source.id === chosen && source.kind === 'window') : false;
    const allowed = { system: systemAudio, app: appAudio && window, 'system-except-cord': appAudio };
    for (const label of audioRow.querySelectorAll('label[data-mode]')) label.hidden = !allowed[label.dataset.mode];
    if (!allowed[audioMode()] && audioMode() !== 'none') audioRow.querySelector('input[value="none"]').checked = true;
    audioRow.classList.toggle('hidden', !systemAudio && !appAudio);
    hint.textContent = HINTS[audioMode()] || '';
  };
  const render = () => {
    grid.replaceChildren();
    const shown = sources.filter((source) => source.kind === kind);
    if (shown.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = kind === 'screen' ? 'Экраны не найдены.' : 'Открытых окон нет.';
      grid.append(empty);
      return;
    }
    for (const source of shown) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'source';
      button.setAttribute('aria-pressed', String(chosen === source.id));
      const thumb = document.createElement('img');
      thumb.className = 'thumb';
      thumb.alt = '';
      if (source.thumbnail) thumb.src = source.thumbnail;
      const label = document.createElement('div');
      label.className = 'label';
      if (source.icon) {
        const icon = document.createElement('img');
        icon.src = source.icon;
        icon.alt = '';
        label.append(icon);
      }
      const name = document.createElement('span');
      name.textContent = source.name;
      label.append(name);
      button.append(thumb, label);
      button.addEventListener('click', () => {
        chosen = source.id;
        share.disabled = false;
        render();
        renderAudio();
      });
      button.addEventListener('dblclick', () => submit());
      grid.append(button);
    }
  };
  const submit = () => {
    if (!chosen) return;
    window.cordShell.call('capture.pick', { id: chosen, audio: audioMode() });
  };
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    tab.addEventListener('click', () => {
      kind = tab.dataset.kind;
      for (const other of document.querySelectorAll('[role="tab"]')) other.setAttribute('aria-selected', String(other === tab));
      render();
    });
  }
  share.addEventListener('click', submit);
  document.getElementById('close').addEventListener('click', () => window.cordShell.call('capture.cancel'));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.cordShell.call('capture.cancel');
  });
  audioRow.addEventListener('change', renderAudio);
  window.cordShell.call('capture.sources').then((answer) => {
    sources = (answer && answer.sources) || [];
    systemAudio = !!(answer && answer.systemAudio);
    appAudio = !!(answer && answer.appAudio);
    render();
    renderAudio();
  });
})();

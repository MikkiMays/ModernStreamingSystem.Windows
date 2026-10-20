// Окно выбора источника: показывает экраны и окна, отдаёт выбор оболочке (`capture.pick`).
(() => {
  const grid = document.getElementById('grid');
  const share = document.getElementById('share');
  const audio = document.getElementById('audio');
  const audioRow = document.getElementById('audio-row');
  const hint = document.getElementById('hint');
  let sources = [];
  let kind = 'screen';
  let chosen = null;
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
      });
      button.addEventListener('dblclick', () => submit());
      grid.append(button);
    }
  };
  const submit = () => {
    if (!chosen) return;
    window.cordShell.call('capture.pick', { id: chosen, audio: audio.checked ? 'system' : 'none' });
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
  window.cordShell.call('capture.sources').then((answer) => {
    sources = (answer && answer.sources) || [];
    if (!(answer && answer.systemAudio)) {
      audioRow.classList.add('hidden');
    } else {
      hint.textContent = 'Со звуком системы участники услышат и голоса комнаты. Звук отдельного приложения появится позже.';
    }
    render();
  });
})();

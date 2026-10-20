// Заставка: одна строка и полоса; кнопки — только при сбое.
(() => {
  const status = document.getElementById('status');
  const bar = document.getElementById('bar');
  const fill = bar.querySelector('i');
  const choice = document.getElementById('choice');
  const text = (state) => {
    switch (state.stage) {
      case 'checking': return 'Проверяем обновления…';
      case 'downloading': return `Загружаем обновление… ${Math.min(100, Math.max(0, Math.floor(state.progress * 100)))}%`;
      case 'installing': return 'Устанавливаем…';
      default: return state.problem || 'Не удалось обновить Cord.';
    }
  };
  window.cordShell.on('splash.state', (state) => {
    status.textContent = text(state);
    const failed = state.stage === 'failed';
    choice.classList.toggle('hidden', !failed);
    bar.classList.toggle('hidden', failed);
    bar.classList.toggle('busy', state.stage !== 'downloading');
    if (state.stage === 'downloading') fill.style.width = `${Math.floor(state.progress * 100)}%`;
    if (failed) document.getElementById('retry').focus();
  });
  document.getElementById('retry').addEventListener('click', () => window.cordShell.emit('splash.retry'));
  document.getElementById('open').addEventListener('click', () => window.cordShell.emit('splash.open'));
})();

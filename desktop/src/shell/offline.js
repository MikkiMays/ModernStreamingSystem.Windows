(() => {
  const server = new URLSearchParams(location.search).get('server');
  if (server) {
    try {
      document.getElementById('server').textContent = `Cord не смог открыть ${new URL(server).host}. Проверьте подключение к интернету и повторите.`;
    } catch { /* как есть */ }
  }
  const retry = document.getElementById('retry');
  retry.addEventListener('click', () => {
    retry.disabled = true;
    window.cordShell.call('offline.retry').finally(() => { retry.disabled = false; });
  });
  window.addEventListener('online', () => window.cordShell.call('offline.retry'));
})();

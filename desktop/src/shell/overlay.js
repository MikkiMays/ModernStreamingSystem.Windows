(() => {
  const list = document.getElementById('list');
  window.cordShell.on('overlay.state', (state) => {
    const participants = (state && state.participants) || [];
    list.replaceChildren(
      ...participants.slice(0, 10).map((person) => {
        const item = document.createElement('li');
        item.dataset.tier = String(person.tier);
        item.dataset.speaking = String(!!person.speaking);
        const dot = document.createElement('i');
        dot.className = 'dot';
        const name = document.createElement('span');
        name.textContent = person.name;
        item.append(dot, name);
        return item;
      }),
    );
  });
})();

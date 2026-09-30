(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  const names = ['Overview', 'Sessions', 'Storage', 'Trust', 'Settings', 'Help'];
  const view = document.querySelector('#view'); const tabs = document.querySelector('#tabs');
  const connection = document.querySelector('#connection'); const result = document.querySelector('#result');
  let active = 'Overview'; let snapshot; let settings; let trustFilter = 'all'; let socket;
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (className) node.className = className; return node; };
  function request(path, options = {}) {
    if (!token) throw new Error('Missing bootstrap token. Reopen the GUI through agent-maintenance.');
    return fetch(path, { ...options, headers: { 'X-Auth-Token': token, ...(options.headers || {}) } }).then(async (response) => {
      const body = await response.json(); if (!response.ok) throw new Error(body.error || body.message || `HTTP ${response.status}`); return body;
    });
  }
  function action(command) {
    const description = command.kind === 'session' ? command.action : command.kind;
    if (!window.confirm(`Confirm ${description}? Native operations may remain disabled by capability policy.`)) return;
    request('/api/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) })
      .then((outcome) => { result.textContent = outcome.message; return refresh(); }).catch((error) => { result.textContent = error.message; });
  }
  function refresh() { return request('/api/snapshot').then((data) => { snapshot = data; render(); }); }
  function setTab(name) { active = name; render(); view.focus(); }
  function renderTabs() {
    tabs.replaceChildren();
    for (const name of names) { const button = el('button', name); button.type = 'button'; if (active === name) button.setAttribute('aria-current', 'page'); button.addEventListener('click', () => setTab(name)); tabs.append(button); }
  }
  function render() {
    renderTabs(); view.replaceChildren();
    if (!snapshot) { view.append(el('p', 'Loading inventory…')); return; }
    if (active === 'Overview') renderOverview();
    else if (active === 'Sessions') renderSessions();
    else if (active === 'Storage') renderStorage();
    else if (active === 'Trust') renderTrust();
    else if (active === 'Settings') renderSettings();
    else renderHelp();
  }
  function card(title, detail, disabled = false) { const box = el('article', undefined, `card${disabled ? ' disabled' : ''}`); box.append(el('h3', title), el('p', detail)); return box; }
  function renderOverview() {
    view.append(el('h2', 'Overview'), el('p', `${snapshot.inventory.sessions.length} session records; ownership is determined only by validated adapters.`));
    const grid = el('section', undefined, 'grid');
    for (const adapter of snapshot.inventory.adapters) {
      const box = card(`${adapter.agentId} ${adapter.version || '(version unknown)'}`, adapter.explanation);
      for (const [name, capability] of Object.entries(adapter.capabilities)) box.append(el('p', `${name}: ${capability.enabled ? 'available' : `disabled — ${capability.reason}`}`, capability.enabled ? '' : 'muted'));
      grid.append(box);
    }
    view.append(grid);
  }
  function renderSessions() {
    view.append(el('h2', 'Sessions'));
    const rows = [...snapshot.inventory.sessions, ...snapshot.inventory.verifiedSubagents];
    if (!rows.length) view.append(el('p', 'No session records were returned by validated readers.'));
    const grid = el('section', undefined, 'grid');
    for (const session of rows) {
      const box = card(`${session.agentId}: ${session.title}`, `${session.ownership} • ${session.ownershipExplanation}`);
      box.append(el('p', `ID ${session.id} • ${session.updatedAt}`));
      const actions = el('div', undefined, 'actions');
      for (const [key, value] of [['archive', 'archive'], ['soft-delete', 'soft-delete'], ['temp-move', 'move to temp'], ['terminate', 'terminate']]) {
        const button = el('button', value); button.addEventListener('click', () => action({ kind: 'session', action: key, agentId: session.agentId, sessionId: session.id })); actions.append(button);
      }
      box.append(actions); grid.append(box);
    }
    view.append(grid);
  }
  function renderStorage() {
    view.append(el('h2', 'Storage'));
    if (!snapshot.archiveAvailable) view.append(el('p', snapshot.archiveReason || 'Archive listing is unavailable.', 'disabled'));
    const grid = el('section', undefined, 'grid');
    for (const archive of snapshot.archives) {
      const box = card(`${archive.category}: ${archive.agentId} ${archive.sessionId}`, `Archive ID ${archive.archiveId} • ${archive.status}`);
      box.append(el('p', archive.relativePath)); const button = el('button', 'Restore exact archive');
      button.addEventListener('click', () => action({ kind: 'restore', archiveId: archive.archiveId })); box.append(button); grid.append(box);
    }
    view.append(grid);
  }
  function renderTrust() {
    view.append(el('h2', 'Trust maintenance'));
    const field = el('div', undefined, 'field'); const select = el('select');
    for (const [value, label] of [['all', 'All agents'], ['codex_cli', 'Codex'], ['claude_code_cli', 'Claude'], ['agy_cli', 'Agy'], ['opencode_cli', 'OpenCode']]) { const option = el('option', label); option.value = value; select.append(option); }
    select.value = trustFilter; select.addEventListener('change', () => { trustFilter = select.value; render(); }); field.append(el('label', 'Filter'), select);
    const path = document.createElement('input'); path.placeholder = 'Absolute directory path'; path.setAttribute('aria-label', 'Directory path');
    const agent = document.createElement('select'); for (const value of ['codex_cli', 'claude_code_cli', 'agy_cli', 'opencode_cli']) { const option = el('option', value); option.value = value; agent.append(option); }
    const add = el('button', 'Add directory'); add.addEventListener('click', () => action({ kind: 'trust-add', agentId: agent.value, path: path.value }));
    const addLabel = el('label', 'Agent'); addLabel.append(agent); field.append(path, addLabel, add); view.append(field);
    const entries = snapshot.inventory.trustEntries.filter((entry) => trustFilter === 'all' || entry.agentId === trustFilter);
    const grid = el('section', undefined, 'grid');
    for (const entry of entries) {
      const box = card(`${entry.agentId}: ${entry.path}`, `${entry.trustLevel} • ${entry.state} • ${entry.explanation}`);
      const controls = el('div', undefined, 'actions'); const sync = el('button', 'Sync across agents'); sync.addEventListener('click', () => action({ kind: 'trust-sync', agentId: entry.agentId, path: entry.path }));
      const prune = el('button', 'Prune'); prune.addEventListener('click', () => action({ kind: 'trust-prune', agentId: entry.agentId, path: entry.path })); controls.append(sync, prune); box.append(controls); grid.append(box);
    }
    view.append(grid);
  }
  function renderSettings() {
    view.append(el('h2', 'Settings')); if (!settings) { view.append(el('p', 'Loading preferences…')); return; }
    const form = document.createElement('form'); const fields = [['tempFolder', 'Temporary folder', 'text'], ['defaultPort', 'Default loopback port', 'number']];
    for (const [key, label, type] of fields) { const wrapper = el('label', label); const input = document.createElement('input'); input.name = key; input.type = type; input.value = settings[key];
      if (key === 'defaultPort') { input.min = '1'; input.max = '65535'; input.step = '1'; }
      wrapper.append(input); form.append(wrapper); }
    for (const key of ['confirmDelete', 'displayWarnings', 'showArchiveNotice']) { const wrapper = el('label', key); const input = document.createElement('input'); input.type = 'checkbox'; input.name = key; input.checked = settings[key]; wrapper.append(input); form.append(wrapper); }
    const save = el('button', 'Save preferences'); save.type = 'submit'; form.append(save);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const portInput = form.elements.namedItem('defaultPort'); const defaultPort = portInput.valueAsNumber;
      if (!Number.isInteger(defaultPort) || defaultPort < 1 || defaultPort > 65535) { result.textContent = 'Default loopback port must be an integer from 1 through 65535.'; return; }
      const next = { ...settings, tempFolder: form.elements.namedItem('tempFolder').value, defaultPort };
      for (const key of ['confirmDelete', 'displayWarnings', 'showArchiveNotice']) next[key] = form.elements.namedItem(key).checked;
      request('/api/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'settings-save', settings: next }) })
        .then((outcome) => { result.textContent = outcome.message; return loadSettings(); }).catch((error) => { result.textContent = error.message; });
    }); view.append(form);
  }
  function renderHelp() { view.append(el('h2', 'Help'), el('p', 'Use the tabs to inspect validated inventory and capability status.'), el('p', 'Every action requires confirmation and is rechecked by shared core policies. Unsupported native operations show their capability reason.'), el('p', 'The loopback GUI authenticates API requests and the WebSocket session. Closing all windows starts a grace-period shutdown.')); }
  function loadSettings() { return request('/api/settings').then((data) => { settings = data; if (active === 'Settings') render(); }); }
  function connectSocket() {
    socket = new WebSocket(`ws://${location.host}/ws`);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'AUTH', token })));
    socket.addEventListener('message', (event) => { let message; try { message = JSON.parse(event.data); } catch { return; } if (message.type === 'AUTH_OK') { connection.textContent = 'Authenticated loopback session'; setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'PING' })); }, 5000); } });
    socket.addEventListener('close', () => { connection.textContent = 'Connection closed; reopen the GUI to reconnect.'; });
  }
  if (!token) { connection.textContent = 'Missing bootstrap token; reopen the GUI through the launcher.'; return; }
  Promise.all([refresh(), loadSettings()]).then(connectSocket).catch((error) => { connection.textContent = error.message; });
})();

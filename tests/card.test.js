const assert = require('node:assert/strict');

class ShadowRootStub {
  constructor() { this.innerHTML = ''; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getElementById() { return null; }
}

global.HTMLElement = class {
  attachShadow() { this.shadowRoot = new ShadowRootStub(); return this.shadowRoot; }
  dispatchEvent(event) { this.lastEvent = event; return true; }
};
global.CustomEvent = class {
  constructor(type, options) { this.type = type; Object.assign(this, options); }
};
global.window = { customCards: [] };
global.document = { createElement: () => ({}) };
global.alert = () => {};
global.confirm = () => true;

const registry = new Map();
global.customElements = {
  define: (name, value) => registry.set(name, value),
  get: (name) => registry.get(name)
};

require('../todoist-task-flow.js');

const task = {
  id: 'task-1', content: 'Change furnace filter', description: 'Use MERV 11',
  project_name: 'Home', labels: ['house'], priority: 1,
  due: { date: '2026-08-20', datetime: null, is_recurring: false },
  deadline: { date: '2026-08-31' }, is_completed: false
};

function newCard(config) {
  const Card = registry.get('todoist-kiosk-card');
  const card = new Card();
  Object.defineProperty(card, 'localName', { value: 'todoist-kiosk-card' });
  card.setConfig(config);
  return card;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function run() {
  const Card = registry.get('todoist-kiosk-card');
  assert.ok(Card, 'Todoist Kiosk custom element should be registered');
  assert.ok(window.customCards.some(card => card.type === 'todoist-kiosk-card'));
  const stub = Card.getStubConfig();
  assert.equal(stub.filter, '(due before: first day | deadline before: first day) & (!#Daily Checklist | today)');
  assert.deepEqual(stub.default_source, { kind: 'raw_filter', id: 'default_query' });
  assert.equal(stub.raw_filters[0].query, stub.filter);

  // Legacy cards continue to send their existing selector unchanged.
  const legacyCard = newCard({ filter_name: 'Kiosk Upcoming', title: 'Tasks' });
  const legacyRequests = [];
  legacyCard._hass = { states: {}, callWS: async request => {
    legacyRequests.push(request);
    if (request.type === 'todoist_kiosk/tasks') return { tasks: [task] };
    return { success: true };
  } };
  await legacyCard.fetchTasks();
  assert.deepEqual(legacyRequests[0], { type: 'todoist_kiosk/tasks', filter_name: 'Kiosk Upcoming' });
  assert.equal(legacyCard.tasks[0].uid, 'task-1');
  assert.match(legacyCard.shadowRoot.innerHTML, /Home/);
  assert.match(legacyCard.shadowRoot.innerHTML, /Deadline/);
  assert.match(legacyCard.shadowRoot.innerHTML, /P1/);

  const config = {
    title: 'Tasks', default_source: { kind: 'saved_filter', id: 'f1' },
    raw_filters: [
      { id: 'month', name: 'Month Ahead', query: 'due before: first day' },
      { id: 'same', name: 'Agenda', query: 'today | overdue' }
    ],
    allow_complete: true, allow_quick_add: true
  };
  const card = newCard(config);
  const requests = [];
  card._hass = { states: {}, callWS: async request => {
    requests.push(request);
    if (request.type === 'todoist_kiosk/sources') return { sources: [
      { kind: 'project', id: 'p2', name: 'Work' },
      { kind: 'project', id: 'p1', name: 'Home' },
      { kind: 'saved_filter', id: 'f2', name: 'Tomorrow' },
      { kind: 'saved_filter', id: 'f1', name: 'Agenda' }
    ] };
    if (request.type === 'todoist_kiosk/tasks') return { tasks: [task] };
    return { success: true };
  } };

  assert.equal(await card.loadKioskSources(), true);
  assert.deepEqual(card.kioskSources.map(source => source.label), [
    'Project: Home', 'Project: Work', 'Filter: Agenda (Saved)',
    'Filter: Agenda (Raw)', 'Filter: Month Ahead', 'Filter: Tomorrow'
  ]);
  assert.equal(card.activeSource.id, 'f1');
  assert.deepEqual(card.getKioskTaskRequest(card.kioskSources[0]), { type: 'todoist_kiosk/tasks', project_id: 'p1' });
  assert.deepEqual(card.getKioskTaskRequest(card.kioskSources[3]), { type: 'todoist_kiosk/tasks', filter: 'today | overdue' });

  await card.selectKioskSource('project:p1');
  assert.equal(card.activeSource.id, 'p1');
  assert.ok(requests.some(request => request.type === 'todoist_kiosk/tasks' && request.project_id === 'p1'));

  // A failed source switch restores the prior selection and task list.
  const previousTasks = card.tasks;
  card._hass.callWS = async request => {
    if (request.type === 'todoist_kiosk/tasks' && request.filter_id === 'f2') throw new Error('Filter unavailable');
    return { tasks: [task] };
  };
  assert.equal(await card.selectKioskSource('saved_filter:f2'), false);
  assert.equal(card.activeSource.id, 'p1');
  assert.strictEqual(card.tasks, previousTasks);

  // Later selections win even when an earlier request completes afterward.
  const first = deferred();
  const second = deferred();
  card._hass.callWS = request => {
    if (request.filter_id === 'f1') return first.promise;
    if (request.filter === 'due before: first day') return second.promise;
    return Promise.resolve({ tasks: [] });
  };
  const firstSwitch = card.selectKioskSource('saved_filter:f1');
  const secondSwitch = card.selectKioskSource('raw_filter:month');
  second.resolve({ tasks: [{ ...task, id: 'latest', content: 'Latest task' }] });
  await secondSwitch;
  first.resolve({ tasks: [{ ...task, id: 'stale', content: 'Stale task' }] });
  await firstSwitch;
  assert.equal(card.activeSource.id, 'month');
  assert.equal(card.tasks[0].id, 'latest');

  // Completion and Quick Add both refresh the active runtime source.
  requests.length = 0;
  card._hass.callWS = async request => {
    requests.push(request);
    if (request.type === 'todoist_kiosk/sources') return { sources: card._backendSources };
    if (request.type === 'todoist_kiosk/tasks') return { tasks: [task] };
    return { success: true };
  };
  await card.toggleTask('task-1', task.content, false, { style: {} });
  assert.ok(requests.some(request => request.type === 'todoist_kiosk/complete_task' && request.task_id === 'task-1'));
  assert.ok(requests.some(request => request.type === 'todoist_kiosk/tasks' && request.filter === 'due before: first day'));
  await card.addTask('Buy filter tomorrow #Home p2');
  assert.ok(requests.some(request => request.type === 'todoist_kiosk/quick_add' && request.text === 'Buy filter tomorrow #Home p2'));

  // Manual refresh reloads metadata, source catalog, and the active source.
  requests.length = 0;
  await card.manualRefresh();
  assert.deepEqual(requests.slice(0, 2).map(request => request.type), ['todoist_kiosk/refresh_metadata', 'todoist_kiosk/sources']);
  assert.ok(requests.some(request => request.type === 'todoist_kiosk/tasks' && request.filter === 'due before: first day'));

  // Reconstructing the card resets the transient selection to its configured default.
  const reconstructed = newCard(config);
  assert.equal(reconstructed.activeSource.id, 'f1');

  // Older backends hide the dropdown and retain the configured legacy filter.
  const oldBackend = newCard({ filter: 'today', filter_label: 'Today Tasks' });
  const oldRequests = [];
  oldBackend._hass = { states: {}, callWS: async request => {
    oldRequests.push(request);
    if (request.type === 'todoist_kiosk/sources') throw new Error('Unknown command');
    return { tasks: [] };
  } };
  assert.equal(await oldBackend.loadKioskSources(), false);
  await oldBackend.fetchTasks();
  assert.deepEqual(oldRequests.at(-1), { type: 'todoist_kiosk/tasks', filter: 'today' });
  assert.equal(oldBackend.sourceCatalogSupported, false);
  assert.doesNotMatch(oldBackend.shadowRoot.innerHTML, /kiosk-source-selector/);

  // Editor CRUD keeps hidden IDs stable and validates names and query length.
  const Editor = registry.get('todoist-task-flow-editor');
  const editor = new Editor();
  editor._backendSources = [{ kind: 'project', id: 'p1', name: 'Home' }];
  editor._config = {
    type: 'custom:todoist-kiosk-card',
    raw_filters: [{ id: 'month', name: 'Month Ahead', query: 'today' }],
    default_source: { kind: 'raw_filter', id: 'month' }
  };
  editor.updateRawFilter(0, 'name', 'Next Month');
  assert.equal(editor.lastEvent.detail.config.raw_filters[0].id, 'month');
  assert.deepEqual(editor.lastEvent.detail.config.default_source, { kind: 'raw_filter', id: 'month' });
  assert.match(editor.validateRawFilters([
    { id: 'one', name: 'Same', query: 'today' },
    { id: 'two', name: 'same', query: 'tomorrow' }
  ]), /unique/);
  assert.match(editor.validateRawFilters([{ id: 'one', name: 'Long', query: 'x'.repeat(1025) }]), /1,024/);
  editor._config.raw_filters.push({ id: 'new_filter', name: 'New Filter', query: 'today' });
  editor.addRawFilter();
  assert.equal(editor.lastEvent.detail.config.raw_filters.at(-1).name, 'New Filter 2');
  editor._config.raw_filters.pop();
  editor.removeRawFilter(0);
  assert.deepEqual(editor.lastEvent.detail.config.default_source, { kind: 'project', id: 'p1' });

  console.log('Todoist Kiosk card tests passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });

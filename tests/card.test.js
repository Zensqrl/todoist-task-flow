const assert = require('node:assert/strict');

class ShadowRootStub {
  constructor() { this.innerHTML = ''; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getElementById() { return null; }
}

global.HTMLElement = class {
  attachShadow() {
    this.shadowRoot = new ShadowRootStub();
    return this.shadowRoot;
  }
};
global.CustomEvent = class {};
global.window = { customCards: [] };
global.document = { createElement: () => ({}) };
global.alert = () => {};

const registry = new Map();
global.customElements = {
  define: (name, value) => registry.set(name, value),
  get: (name) => registry.get(name)
};

require('../todoist-task-flow.js');

async function run() {
  const Card = registry.get('todoist-kiosk-card');
  assert.ok(Card, 'Todoist Kiosk custom element should be registered');
  assert.ok(window.customCards.some(card => card.type === 'todoist-kiosk-card'));
  assert.equal(
    Card.getStubConfig().filter,
    '(due before: first day | deadline before: first day) & (!#Daily Checklist | today)'
  );

  const card = new Card();
  Object.defineProperty(card, 'localName', { value: 'todoist-kiosk-card' });
  card.setConfig({
    ...Card.getStubConfig(),
    filter_name: 'Kiosk Upcoming',
    filter: ''
  });

  const requests = [];
  const task = {
    id: 'task-1',
    content: 'Change furnace filter',
    description: 'Use MERV 11',
    project_name: 'Home',
    labels: ['house'],
    priority: 1,
    due: { date: '2026-08-20', datetime: null, is_recurring: false },
    deadline: { date: '2026-08-31' },
    is_completed: false
  };
  card._hass = {
    states: {},
    callWS: async request => {
      requests.push(request);
      if (request.type === 'todoist_kiosk/tasks') return { tasks: [task] };
      return { success: true };
    }
  };

  await card.fetchTasks();
  assert.deepEqual(requests[0], {
    type: 'todoist_kiosk/tasks',
    filter_name: 'Kiosk Upcoming'
  });
  assert.equal(card.tasks[0].uid, 'task-1');
  assert.equal(card.tasks[0].summary, 'Change furnace filter');
  assert.match(card.shadowRoot.innerHTML, /Home/);
  assert.match(card.shadowRoot.innerHTML, /Deadline/);
  assert.match(card.shadowRoot.innerHTML, /P1/);

  await card.toggleTask('task-1', task.content, false, { style: {} });
  assert.ok(requests.some(request => request.type === 'todoist_kiosk/complete_task' && request.task_id === 'task-1'));

  await card.addTask('Buy filter tomorrow #Home p2');
  assert.ok(requests.some(request => request.type === 'todoist_kiosk/quick_add' && request.text === 'Buy filter tomorrow #Home p2'));

  console.log('Todoist Kiosk card tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

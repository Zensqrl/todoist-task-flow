const TODOIST_KIOSK_DEFAULT_FILTER = '(due before: first day | deadline before: first day) & (!#Daily Checklist | today)';
const TODOIST_KIOSK_LEGACY_RAW_ID = '__legacy_filter';

function kioskSourceKey(source) {
  return source?.kind && source?.id ? `${source.kind}:${source.id}` : '';
}

function normalizeRawFilters(config = {}) {
  if (!Array.isArray(config.raw_filters)) return [];
  return config.raw_filters
    .filter(item => item && item.id && item.name && item.query)
    .map(item => ({ kind: 'raw_filter', id: String(item.id), name: String(item.name), query: String(item.query) }));
}

function legacyKioskSource(config = {}) {
  if (config.project_id) return { kind: 'project', id: String(config.project_id), name: String(config.project_id), legacy: true };
  if (config.filter_id) return { kind: 'saved_filter', id: String(config.filter_id), name: config.filter_name || String(config.filter_id), legacy: true };
  if (config.filter_name) return { kind: 'saved_filter', id: '', name: String(config.filter_name), legacy: true };
  if (config.filter) return {
    kind: 'raw_filter',
    id: TODOIST_KIOSK_LEGACY_RAW_ID,
    name: String(config.filter_label || 'Custom Query'),
    query: String(config.filter),
    legacy: true
  };
  return null;
}

function mergeKioskSources(backendSources, config = {}) {
  const projects = (Array.isArray(backendSources) ? backendSources : [])
    .filter(source => source?.kind === 'project' && source.id && source.name)
    .map(source => ({ kind: 'project', id: String(source.id), name: String(source.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id));
  const saved = (Array.isArray(backendSources) ? backendSources : [])
    .filter(source => source?.kind === 'saved_filter' && source.id && source.name)
    .map(source => ({ kind: 'saved_filter', id: String(source.id), name: String(source.name) }));
  const raw = normalizeRawFilters(config);
  if (!raw.length && config.filter && !config.default_source) raw.push(legacyKioskSource(config));
  const filters = [...saved, ...raw]
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.kind === b.kind ? a.id.localeCompare(b.id) : (a.kind === 'saved_filter' ? -1 : 1)));
  const nameCounts = new Map();
  filters.forEach(source => nameCounts.set(source.name.toLocaleLowerCase(), (nameCounts.get(source.name.toLocaleLowerCase()) || 0) + 1));
  const kindCounts = new Map();
  filters.forEach(source => {
    const key = `${source.name.toLocaleLowerCase()}:${source.kind}`;
    kindCounts.set(key, (kindCounts.get(key) || 0) + 1);
  });
  return [...projects, ...filters].map(source => {
    const prefix = source.kind === 'project' ? 'Project' : 'Filter';
    let suffix = '';
    if (source.kind !== 'project' && nameCounts.get(source.name.toLocaleLowerCase()) > 1) {
      const type = source.kind === 'saved_filter' ? 'Saved' : 'Raw';
      const sameKindCount = kindCounts.get(`${source.name.toLocaleLowerCase()}:${source.kind}`) || 0;
      suffix = sameKindCount > 1 ? ` (${type} · ${source.id.slice(-6)})` : ` (${type})`;
    }
    return { ...source, label: `${prefix}: ${source.name}${suffix}` };
  });
}

class TodoistTaskFlow extends HTMLElement {
  // --- CONFIGURATION ---
  static getConfigElement() { return document.createElement("todoist-task-flow-editor"); }
  static getStubConfig() {
    return {
      data_source: "todo",
      entities: [],
      title: "Mine Opgaver",
      filter: "",
      filter_label: "Custom Query",
      filter_name: "",
      filter_id: "",
      project_id: "",
      raw_filters: [],
      default_filter: "all",
      show_completed: false,
      show_project_tag: false,
      show_project: true,
      show_due: true,
      show_deadline: true,
      show_priority: true,
      show_labels: false,
      allow_complete: true,
      allow_quick_add: true,
      compact_view: false,
      hide_header: false,
      hide_add_task: false,
      max_items: 0,
      font_scale: 100,
      sort_order: "date",
      theme: "standard",
      header_color: "",
      background_color: "",
      background_opacity: 100,
      bubble_color: "",
      bubble_opacity: 100,
      text_color: "",
      enabled_filters: ["all", "today", "overdue"],
      use_gamification: false,
      visual_effect: "confetti",
      sound_effect: "none"
    };
  }

  // --- INITIALIZATION ---
  setConfig(config) {
    this.config = { ...config };
    if (this.config.entities) {
        if (typeof this.config.entities === 'string') {
            this.config.entities = this.config.entities.split(',').map(e => e.trim());
        }
        if (!this.currentEntity || !this.config.entities.includes(this.currentEntity)) {
             this.currentEntity = this.config.entities[0];
        }
    }
    this.filter = this.config.default_filter || 'all';
    this.tasks = [];
    this.errorMessage = '';
    this.hasInitialized = false;
    this._backendSources = [];
    this.kioskSources = [];
    this.sourceCatalogSupported = null;
    this.activeSource = this.getConfiguredKioskSource();
    this._taskRequestSequence = 0;
    this._sourceLoading = false;
    this._collapsedGroups = new Set();
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
  }

  isKioskMode() {
    if (this.localName === 'todoist-kiosk-card') return true;
    if (this.config?.data_source) return this.config.data_source === 'todoist_kiosk';
    return Boolean(this.config?.filter || this.config?.filter_name || this.config?.filter_id);
  }

  hasConfiguredSource() {
    if (this.isKioskMode()) {
      return Boolean(this.config.default_source || this.config.project_id || this.config.filter || this.config.filter_name || this.config.filter_id || normalizeRawFilters(this.config).length);
    }
    return Boolean(this.currentEntity);
  }

  getConfiguredKioskSource() {
    const configured = this.config?.default_source;
    if (configured?.kind && configured?.id) {
      const raw = normalizeRawFilters(this.config).find(source => source.id === String(configured.id));
      return raw || { kind: String(configured.kind), id: String(configured.id), name: String(configured.id) };
    }
    return legacyKioskSource(this.config);
  }

  resolveConfiguredKioskSource() {
    const configured = this.config?.default_source;
    if (configured?.kind && configured?.id) {
      const match = this.kioskSources.find(source => source.kind === configured.kind && source.id === String(configured.id));
      if (match) return match;
      return this.kioskSources[0] || legacyKioskSource(this.config);
    }
    const legacy = legacyKioskSource(this.config);
    if (legacy?.kind === 'saved_filter' && !legacy.id) {
      const matches = this.kioskSources.filter(source => source.kind === 'saved_filter' && source.name.toLocaleLowerCase() === legacy.name.toLocaleLowerCase());
      if (matches.length === 1) return matches[0];
    }
    if (legacy) {
      return this.kioskSources.find(source => kioskSourceKey(source) === kioskSourceKey(legacy)) || legacy;
    }
    return this.kioskSources[0] || null;
  }

  getKioskTaskRequest(source = this.activeSource || this.getConfiguredKioskSource()) {
    const request = { type: 'todoist_kiosk/tasks' };
    if (source?.kind === 'project') request.project_id = source.id;
    else if (source?.kind === 'saved_filter' && source.id) request.filter_id = source.id;
    else if (source?.kind === 'saved_filter') request.filter_name = source.name;
    else if (source?.kind === 'raw_filter') request.filter = source.query;
    else if (this.config.filter_id) request.filter_id = this.config.filter_id;
    else if (this.config.filter_name) request.filter_name = this.config.filter_name;
    else request.filter = this.config.filter;
    return request;
  }

  async loadKioskSources() {
    if (!this._hass || !this.isKioskMode()) return false;
    try {
      const response = await this._hass.callWS({ type: 'todoist_kiosk/sources' });
      if (!response || !Array.isArray(response.sources)) throw new Error('Invalid source catalog response');
      this._backendSources = response.sources;
      this.kioskSources = mergeKioskSources(this._backendSources, this.config);
      this.sourceCatalogSupported = true;
      const activeKey = kioskSourceKey(this.activeSource);
      this.activeSource = this.kioskSources.find(source => kioskSourceKey(source) === activeKey) || this.resolveConfiguredKioskSource();
      return true;
    } catch (e) {
      this.sourceCatalogSupported = false;
      this._backendSources = [];
      this.kioskSources = [];
      this.activeSource = legacyKioskSource(this.config);
      console.warn('Todoist Kiosk source catalog is unavailable; using the configured legacy source:', e?.message || e);
      return false;
    }
  }

  async initializeKiosk() {
    await this.loadKioskSources();
    await this.fetchTasks();
  }

  normalizeTaskForDisplay(task) {
    if (!this.isKioskMode()) return task;
    const due = task.due?.datetime || task.due?.date || null;
    return {
      ...task,
      uid: task.id,
      summary: task.content,
      status: task.is_completed ? 'completed' : 'needs_action',
      due,
      todoist_due: task.due
    };
  }

  connectedCallback() {
      this._interval = setInterval(() => this.fetchTasks(), 600000);
  }

  disconnectedCallback() {
      if (this._interval) clearInterval(this._interval);
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.hasConfiguredSource()) {
      if (!this.shadowRoot.innerHTML) this.render();
      return;
    }

    if (!this.hasInitialized) {
      this.hasInitialized = true;
      if (!this.tasks.length) {
        if (this.isKioskMode()) this.initializeKiosk();
        else this.fetchTasks();
      }
    }

    if (!this.shadowRoot.innerHTML) {
        this.render();
    }
  }

  async fetchTasks(options = {}) {
    if (!this._hass || !this.hasConfiguredSource()) return;

    const requestSequence = ++this._taskRequestSequence;
    const source = options.source || this.activeSource || this.getConfiguredKioskSource();

    const list = this.shadowRoot.querySelector('.task-list');
    const savedScrollTop = list ? list.scrollTop : 0;

    const refreshBtn = this.shadowRoot.querySelector('.refresh-btn');
    if (refreshBtn) refreshBtn.classList.add('spinning');

    try {
      const response = this.isKioskMode()
        ? await this._hass.callWS(this.getKioskTaskRequest(source))
        : await this._hass.callWS({ type: "todo/item/list", entity_id: this.currentEntity });

      if (requestSequence !== this._taskRequestSequence) return false;

      // SORTERING LOGIK
      let items = (this.isKioskMode() ? response.tasks : response.items) || [];
      items = items.map(task => this.normalizeTaskForDisplay(task));
      const sortOrder = this.config.sort_order || 'date';

      if (sortOrder === 'alpha') {
          items.sort((a, b) => a.summary.localeCompare(b.summary));
      } else if (sortOrder === 'newest') {
          items.reverse();
      } else {
          items.sort((a, b) => {
            if (a.priority && b.priority && a.priority !== b.priority) {
                 return this.isKioskMode() ? a.priority - b.priority : b.priority - a.priority;
            }
            const dateA = a.due ? a.due : '9999-99-99';
            const dateB = b.due ? b.due : '9999-99-99';
            if (dateA !== dateB) return dateA.localeCompare(dateB);
            return a.summary.localeCompare(b.summary);
          });
      }
      this.tasks = items;
      this.errorMessage = '';
      this._sourceLoading = false;

    } catch (e) {
      if (requestSequence !== this._taskRequestSequence) return false;
      console.warn("Unable to fetch Todoist tasks:", e.message);
      if (options.rollback) {
        this.activeSource = options.rollback.source;
        this.tasks = options.rollback.tasks;
        this.errorMessage = options.rollback.errorMessage;
      } else {
        this.errorMessage = e?.message || this.localize('loading_error');
      }
      this._sourceLoading = false;
      this.render();
      return false;
    }

    this.render();

    const newList = this.shadowRoot.querySelector('.task-list');
    if (newList) {
        newList.scrollTop = options.resetScroll ? 0 : savedScrollTop;
    }
    return true;
  }

  async selectKioskSource(value) {
    const nextSource = this.kioskSources.find(source => kioskSourceKey(source) === value);
    if (!nextSource || kioskSourceKey(nextSource) === kioskSourceKey(this.activeSource)) return true;
    const rollback = {
      source: this.activeSource,
      tasks: this.tasks,
      errorMessage: this.errorMessage
    };
    this.activeSource = nextSource;
    this._sourceLoading = true;
    this.errorMessage = '';
    this.render();
    return this.fetchTasks({ source: nextSource, resetScroll: true, rollback });
  }

  async manualRefresh() {
    if (this.isKioskMode()) {
      try {
        await this._hass.callWS({ type: 'todoist_kiosk/refresh_metadata' });
      } catch (e) {
        console.warn('Unable to refresh Todoist metadata:', e.message);
      }
      await this.loadKioskSources();
    }
    await this.fetchTasks();
  }

  // --- LOCALIZATION HELPER ---
  getLanguage() {
      const hassLang = this._hass?.language?.toLowerCase() || 'en';
      return (hassLang === 'da' || hassLang.startsWith('da-')) ? 'da' : 'en';
  }

  localize(key) {
    const lang = this.getLanguage();
    const translations = {
      'da': {
        'all': 'Alle', 'today': 'I dag', 'overdue': 'Forfaldne', 'today_overdue': 'Nu',
        'week': 'Denne uge', 'month': 'Denne måned',
        'tomorrow': 'I morgen', 'upcoming': 'Kommende', 'no_date': 'Uden dato',
        'completed': 'Afsluttet', 'delete': 'Slet', 'on': 'På ',
        'deadline': 'Frist', 'priority': 'Prioritet',
        'add_task': 'Tilføj ny opgave...', 'delete_confirm': 'Slet',
        'loading_error': 'Der skete en fejl. Prøv igen.',
        'no_tasks': 'Ingen opgaver.',
        'configure': 'Konfigurer venligst kortet og vælg en liste.',
        'and_more': 'Og {count} andre opgaver...',
        'hide_header': 'Skjul Header', 'hide_add_task': 'Skjul tilføjelse af opgaver',
        'font_scale': 'Skriftstørrelse (%)', 'max_items': 'Max antal opgaver (0 = alle)',
        'sort_order': 'Sortering', 'sort_date': 'Dato (Standard)', 'sort_alpha': 'Alfabetisk', 'sort_newest': 'Senest tilføjet'
      },
      'en': {
        'all': 'All', 'today': 'Today', 'overdue': 'Overdue', 'today_overdue': 'Now',
        'week': 'This Week', 'month': 'This Month',
        'tomorrow': 'Tomorrow', 'upcoming': 'Upcoming', 'no_date': 'No date',
        'completed': 'Completed', 'delete': 'Delete', 'on': 'On ',
        'deadline': 'Deadline', 'priority': 'Priority',
        'add_task': 'Add new task...', 'delete_confirm': 'Delete',
        'loading_error': 'An error occurred. Please try again.',
        'no_tasks': 'No tasks.',
        'configure': 'Please configure the card and select a list.',
        'and_more': 'And {count} more tasks...',
        'hide_header': 'Hide Header', 'hide_add_task': 'Hide Add Task Input',
        'font_scale': 'Font Scale (%)', 'max_items': 'Max Items (0 = all)',
        'sort_order': 'Sort Order', 'sort_date': 'Date (Default)', 'sort_alpha': 'Alphabetical', 'sort_newest': 'Newest First'
      }
    };
    return translations[lang][key] || key;
  }

  // --- LOGIC ---

  toggleGroup(groupKey) {
      if (this._collapsedGroups.has(groupKey)) {
          this._collapsedGroups.delete(groupKey);
      } else {
          this._collapsedGroups.add(groupKey);
      }
      this.render();
  }

  // --- GAMIFICATION ---

  playSound(type) {
      if (!type || type === 'none') return;
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'ding') {
          osc.type = 'sine'; osc.frequency.setValueAtTime(523.25, ctx.currentTime);
          osc.frequency.exponentialRampToValueAtTime(1046.5, ctx.currentTime + 0.1);
          gain.gain.setValueAtTime(0.3, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
          osc.start(); osc.stop(ctx.currentTime + 0.5);
      } else if (type === 'pop') {
          osc.type = 'triangle'; osc.frequency.setValueAtTime(300, ctx.currentTime);
          osc.frequency.exponentialRampToValueAtTime(50, ctx.currentTime + 0.1);
          gain.gain.setValueAtTime(0.3, ctx.currentTime); gain.gain.linearRampToValueAtTime(0.01, ctx.currentTime + 0.1);
          osc.start(); osc.stop(ctx.currentTime + 0.1);
      } else if (type === 'coin') {
          osc.type = 'square'; osc.frequency.setValueAtTime(987.77, ctx.currentTime);
          osc.frequency.setValueAtTime(1318.51, ctx.currentTime + 0.1);
          gain.gain.setValueAtTime(0.1, ctx.currentTime); gain.gain.setValueAtTime(0.1, ctx.currentTime + 0.1);
          gain.gain.linearRampToValueAtTime(0.01, ctx.currentTime + 0.4);
          osc.start(); osc.stop(ctx.currentTime + 0.4);
      }
  }

  showVisualEffect(type, rect) {
      if (!type || type === 'none') return;
      const card = this.shadowRoot.querySelector('ha-card');
      const container = document.createElement('div');
      container.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:100;';
      card.appendChild(container);

      const startX = rect ? (rect.left + rect.width / 2) - card.getBoundingClientRect().left : card.clientWidth / 2;
      const startY = rect ? (rect.top + rect.height / 2) - card.getBoundingClientRect().top : card.clientHeight / 2;

      if (type === 'confetti') {
          for (let i = 0; i < 30; i++) {
              const p = document.createElement('div');
              p.style.cssText = `position:absolute;width:6px;height:6px;border-radius:50%;left:${startX}px;top:${startY}px;background-color:${['#f00','#0f0','#00f','#ff0','#f0f'][Math.floor(Math.random()*5)]}`;
              container.appendChild(p);
              const angle = Math.random() * Math.PI * 2;
              const velocity = 2 + Math.random() * 4;
              let x = 0, y = 0, vx = Math.cos(angle) * velocity, vy = Math.sin(angle) * velocity;
              const anim = setInterval(() => {
                  x += vx; y += vy; vy += 0.2;
                  p.style.transform = `translate(${x}px, ${y}px)`;
                  p.style.opacity = p.style.opacity ? parseFloat(p.style.opacity) - 0.02 : 1;
                  if (p.style.opacity <= 0) { clearInterval(anim); p.remove(); }
              }, 16);
          }
      } else if (type === 'emoji') {
          const emoji = document.createElement('div');
          emoji.textContent = ['🎉', '👍', '🔥', '✅'][Math.floor(Math.random() * 4)];
          emoji.style.cssText = `position:absolute;font-size:2rem;left:${startX-15}px;top:${startY}px;animation:floatUp 1s ease-out forwards;`;
          container.appendChild(emoji);
          if (!this.shadowRoot.querySelector('#anim-style')) {
              const s = document.createElement('style');
              s.id = 'anim-style';
              s.innerHTML = `@keyframes floatUp { 0% { transform: translateY(0) scale(0.5); opacity: 1; } 100% { transform: translateY(-50px) scale(1.5); opacity: 0; } }`;
              this.shadowRoot.appendChild(s);
          }
      }
      setTimeout(() => container.remove(), 2000);
  }

  // --- ACTIONS ---

  setLoadingState(element, isLoading) {
      if (!element) return;
      element.style.opacity = isLoading ? '0.4' : '1';
      element.style.pointerEvents = isLoading ? 'none' : 'all';
  }

  async toggleTask(itemUid, itemSummary, isCompleted, element) {
    if (this.isKioskMode() && (isCompleted || this.config.allow_complete === false)) return;
    if (!isCompleted && this.config.use_gamification) {
        const rect = element.getBoundingClientRect();
        this.playSound(this.config.sound_effect);
        this.showVisualEffect(this.config.visual_effect, rect);
    }
    this.setLoadingState(element, true);
    try {
      if (this.isKioskMode()) {
        await this._hass.callWS({ type: 'todoist_kiosk/complete_task', task_id: itemUid });
        this.tasks = this.tasks.filter(task => task.id !== itemUid);
        this.render();
        await this.fetchTasks();
      } else {
        const payload = { entity_id: this.currentEntity, item: itemSummary, status: isCompleted ? "needs_action" : "completed" };
        await this._hass.callService("todo", "update_item", payload);
        setTimeout(() => this.fetchTasks(), 200);
      }
    } catch (e) {
      console.error("Fejl:", e);
      alert(this.localize('loading_error'));
      if (this.isKioskMode()) this.render();
      else this.setLoadingState(element, false);
    }
  }

  async deleteTask(itemUid, itemSummary, element) {
    if (!confirm(`${this.localize('delete_confirm')} "${itemSummary}"?`)) return;
    this.setLoadingState(element, true);
    try {
      const payload = { entity_id: this.currentEntity, item: itemSummary };
      await this._hass.callService("todo", "remove_item", payload);
      setTimeout(() => this.fetchTasks(), 200);
    } catch (e) {
      console.error("Fejl:", e);
      alert(this.localize('loading_error'));
      this.setLoadingState(element, false);
    }
  }

  async addTask(value) {
    const text = value?.trim();
    if (!text || (this.isKioskMode() && this.config.allow_quick_add === false)) return;
    const input = this.shadowRoot.getElementById('new-task-input');
    const button = this.shadowRoot.getElementById('add-task-btn');
    if (input) input.disabled = true;
    if (button) button.disabled = true;
    try {
      if (this.isKioskMode()) {
        await this._hass.callWS({ type: 'todoist_kiosk/quick_add', text });
      } else {
        await this._hass.callService("todo", "add_item", { entity_id: this.currentEntity, item: text });
      }
      if (input) input.value = "";
      await this.fetchTasks();
    } catch (e) {
      console.error("Fejl:", e);
      alert(this.localize('loading_error'));
    } finally {
      if (input) input.disabled = false;
      if (button) button.disabled = false;
    }
  }

  // --- HELPERS ---

  formatDateSmart(isoDate) {
      if (!isoDate) return "";
      const lang = this.getLanguage() === 'da' ? 'da-DK' : 'en-US';
      const isDateOnly = isoDate.length === 10;
      const taskDate = isDateOnly
        ? new Date(...isoDate.split('-').map((value, index) => Number(value) - (index === 1 ? 1 : 0)))
        : new Date(isoDate);
      if (Number.isNaN(taskDate.getTime())) return this.escapeHtml(isoDate);
      const today = new Date(); today.setHours(0,0,0,0);
      const taskDateOnly = new Date(taskDate); taskDateOnly.setHours(0,0,0,0);
      const diffTime = taskDateOnly - today;
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      let timeStr = "";
      if (!isDateOnly) {
          const hours = taskDate.getHours().toString().padStart(2, '0');
          const minutes = taskDate.getMinutes().toString().padStart(2, '0');
          timeStr = ` ${hours}:${minutes}`;
      }

      let dateStr = "";
      if (diffDays < 0) dateStr = taskDate.toLocaleDateString(lang, { day: 'numeric', month: 'short' });
      else if (diffDays === 0) dateStr = this.localize('today');
      else if (diffDays === 1) dateStr = this.localize('tomorrow');
      else if (diffDays > 1 && diffDays < 7) {
          const options = { weekday: 'long' };
          let day = new Intl.DateTimeFormat(lang, options).format(taskDate);
          dateStr = this.localize('on') + day.charAt(0).toUpperCase() + day.slice(1);
      } else {
          dateStr = taskDate.toLocaleDateString(lang, { day: 'numeric', month: 'short' });
      }
      const timePrefix = this.getLanguage() === 'da' ? 'kl.' : 'at';
      return dateStr + (timeStr ? ` <span style="opacity:0.7">${timePrefix} ${timeStr.trim()}</span>` : "");
  }

  escapeHtml(text) {
      if (text === null || text === undefined) return "";
      return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  escapeAttribute(text) {
      return this.escapeHtml(text);
  }

  parseMarkdown(text) {
      if (!text) return "";
      let html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
      html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/(\*|_)(.*?)\1/g, '<em>$2</em>');
      html = html.replace(/\n/g, '<br>');
      return html;
  }

  getFilteredTasks() {
    const today = new Date().toISOString().split('T')[0];
    return this.tasks.filter(task => {
      if (!this.config.show_completed && task.status === 'completed') return false;
      if (this.filter === 'all') return true;
      if (!task.due) return false;
      const taskDate = task.due.split('T')[0];
      if (this.filter === 'today') return taskDate === today;
      if (this.filter === 'overdue') return taskDate < today;
      if (this.filter === 'today_overdue') return taskDate <= today;
      if (this.filter === 'month') return taskDate.substring(0, 7) === today.substring(0, 7);
      if (this.filter === 'week') {
          const d = new Date(); const day = d.getDay() || 7;
          if (day !== 1) d.setHours(-24 * (day - 1));
          const startOfWeek = d.toISOString().split('T')[0];
          const endD = new Date(d); endD.setDate(endD.getDate() + 6);
          const endOfWeek = endD.toISOString().split('T')[0];
          return taskDate >= startOfWeek && taskDate <= endOfWeek;
      }
      return true;
    });
  }

  getColorStyle(color, opacity) {
      if (!color) return '';
      const op = opacity !== undefined ? opacity : 100;
      let c;
      if(/^#([A-Fa-f0-9]{3}){1,2}$/.test(color)){
          c = color.substring(1).split('');
          if(c.length== 3){ c= [c[0], c[0], c[1], c[1], c[2], c[2]]; }
          c= '0x'+c.join('');
          return `background: rgba(${[(c>>16)&255, (c>>8)&255, c&255].join(',')}, ${op/100}) !important;`;
      }
      return '';
  }

  // --- RENDERING ---

  render() {
    if (!this.hasConfiguredSource()) {
        this.shadowRoot.innerHTML = `<ha-card style="padding:16px;">${this.localize('configure')}</ha-card>`;
        return;
    }

    const fullTasks = this.getFilteredTasks();
    const maxItems = this.config.max_items || 0;
    const totalCount = fullTasks.length;

    // Anvend Max Items begrænsning
    const tasksToShow = (maxItems > 0) ? fullTasks.slice(0, maxItems) : fullTasks;
    const hiddenCount = (maxItems > 0 && totalCount > maxItems) ? totalCount - maxItems : 0;

    const headerColor = this.config.header_color || 'var(--primary-color)';
    const textColor = this.config.text_color || 'var(--primary-text-color)';
    const isCompact = this.config.compact_view;
    const theme = this.config.theme || 'standard';
    const isKiosk = this.isKioskMode();
    const showProjectTag = isKiosk ? this.config.show_project !== false : this.config.show_project_tag;
    const projectName = !isKiosk ? (this._hass?.states[this.currentEntity]?.attributes.friendly_name || "") : "";
    const bgStyle = this.getColorStyle(this.config.background_color, this.config.background_opacity);
    const bubbleStyleRaw = this.getColorStyle(this.config.bubble_color, this.config.bubble_opacity);
    const hideHeader = this.config.hide_header;
    const hideAddTask = this.config.hide_add_task;
    const fontScale = (this.config.font_scale || 100) / 100;

    let themeClass = `theme-${theme}`;

    const groups = {
        overdue: { id: 'overdue', label: this.localize("overdue"), tasks: [], color: "var(--error-color)" },
        today: { id: 'today', label: this.localize("today"), tasks: [], color: "var(--success-color)" },
        tomorrow: { id: 'tomorrow', label: this.localize("tomorrow"), tasks: [], color: "#ff9800" },
        upcoming: { id: 'upcoming', label: this.localize("upcoming"), tasks: [], color: textColor },
        no_date: { id: 'no_date', label: this.localize("no_date"), tasks: [], color: "var(--secondary-text-color)" }
    };

    const todayStr = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    tasksToShow.forEach(task => {
        if (!task.due) groups.no_date.tasks.push(task);
        else {
            const d = task.due.split('T')[0];
            if (d < todayStr) groups.overdue.tasks.push(task);
            else if (d === todayStr) groups.today.tasks.push(task);
            else if (d === tomorrowStr) groups.tomorrow.tasks.push(task);
            else groups.upcoming.tasks.push(task);
        }
    });

    let taskListHtml = '';
    let hasTasks = false;
    const groupOrder = ['overdue', 'today', 'tomorrow', 'upcoming', 'no_date'];

    groupOrder.forEach(key => {
        const group = groups[key];
        if (group.tasks.length > 0) {
            hasTasks = true;
            const isCollapsed = this._collapsedGroups.has(key);
            const arrow = isCollapsed ? '›' : '⌄';

            taskListHtml += `
                <div class="group-header" data-group="${key}" style="color: ${group.color}; cursor: pointer; user-select: none;">
                    <span style="display:inline-block; width:12px;">${arrow}</span> ${group.label} <span style="opacity:0.6; font-size:0.8em;">(${group.tasks.length})</span>
                </div>
            `;

            if (!isCollapsed) {
                group.tasks.forEach(task => {
                    let dateClass = '', dateText = '';
                    const isCompleted = task.status === 'completed';

                    if (task.due && !isCompleted) {
                        dateText = this.formatDateSmart(task.due);
                        const d = task.due.split('T')[0];
                        if (d < todayStr) dateClass = 'overdue';
                        else if (d === todayStr) dateClass = 'today';
                    } else if (isCompleted) dateText = this.localize("completed");

                    const parsedDesc = this.parseMarkdown(task.description);
                    const descHtml = task.description
                        ? `<div class="task-description ${isCompact ? 'compact-desc' : ''}">${parsedDesc}</div>`
                        : '';

                    const safeSummary = this.escapeAttribute(task.summary);
                    const taskProjectName = isKiosk ? task.project_name : projectName;
                    const projectTagHtml = (showProjectTag && taskProjectName) ? `<span class="project-badge">${this.escapeHtml(taskProjectName)}</span>` : '';
                    const deadlineDate = task.deadline?.date;
                    const deadlineHtml = isKiosk && this.config.show_deadline !== false && deadlineDate
                      ? `<span class="deadline-badge">${this.localize('deadline')}: ${this.formatDateSmart(deadlineDate)}</span>` : '';
                    const priorityHtml = isKiosk && this.config.show_priority !== false && task.priority
                      ? `<span class="priority-badge p${task.priority}">P${task.priority}</span>` : '';
                    const labelsHtml = isKiosk && this.config.show_labels && task.labels?.length
                      ? `<div class="labels">${task.labels.map(label => `<span class="label-badge">@${this.escapeHtml(label)}</span>`).join('')}</div>` : '';

                    let priorityClass = '';
                    if (task.priority) priorityClass = isKiosk ? `todoist-priority-${task.priority}` : `priority-${task.priority}`;
                    const canComplete = !isKiosk || this.config.allow_complete !== false;

                    taskListHtml += `
                    <li class="task-item ${isCompact ? 'compact' : ''} ${priorityClass}">
                      <input type="checkbox" class="task-check"
                             data-uid="${this.escapeAttribute(task.uid||'')}" data-summary="${safeSummary}"
                             data-completed="${isCompleted}" ${isCompleted ? 'checked' : ''} ${canComplete ? '' : 'disabled'}>
                      <div class="task-content">
                        <span class="task-title ${isCompleted ? 'is-completed' : ''}">${this.escapeHtml(task.summary)}</span>
                        ${descHtml}
                        ${labelsHtml}
                      </div>
                      <div class="task-actions">
                        ${projectTagHtml}
                        ${this.config.show_due !== false && dateText ? `<span class="date-badge ${dateClass}">${dateText}</span>` : ''}
                        ${deadlineHtml}
                        ${priorityHtml}
                        ${!isKiosk ? `<button class="delete-btn" title="${this.localize('delete')}" data-uid="${this.escapeAttribute(task.uid||'')}" data-summary="${safeSummary}">🗑</button>` : ''}
                      </div>
                    </li>`;
                });
            }
        }
    });

    if (hiddenCount > 0) {
        taskListHtml += `<div style="padding:10px; text-align:center; opacity:0.6; font-size:0.9em; font-style:italic;">
            ${this.localize('and_more').replace('{count}', hiddenCount)}
        </div>`;
    }

    if (!hasTasks && totalCount === 0) {
        const lang = this.getLanguage();
        const quotesDa = ["Du er en maskine! 💪", "Alt er klaret. Tid til kaffe? ☕", "Tom liste = Ro i sindet 🧘", "Godt arbejde! 🎉"];
        const quotesEn = ["You are a machine! 💪", "All done. Coffee time? ☕", "Empty list = Peace of mind 🧘", "Great job! 🎉"];
        const quotes = (lang === 'da') ? quotesDa : quotesEn;
        const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
        taskListHtml = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24"><path fill="currentColor" d="M19,19H5V8H19M19,3H18V1H16V3H8V1H6V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5A2,2 0 0,0 19,3M16.53,11.06L15.47,10L10.59,14.88L8.53,12.81L7.47,13.88L10.59,17L16.53,11.06Z" /></svg>
                <div class="quote">${randomQuote}</div>
            </div>`;
    }

    const availableFilters = { 'all': this.localize('all'), 'today': this.localize('today'), 'overdue': this.localize('overdue'), 'today_overdue': this.localize('today_overdue'), 'week': this.localize('week'), 'month': this.localize('month') };
    const activeFiltersList = this.config.enabled_filters || ['all', 'today', 'overdue'];
    const filterButtonsHtml = isKiosk ? '' : activeFiltersList.map(filterKey => {
        const label = availableFilters[filterKey] || filterKey;
        const isActive = this.filter === filterKey ? 'active' : '';
        return `<button class="filter-btn ${isActive}" data-filter="${filterKey}">${label}</button>`;
    }).join('');

    let projectSelectorHtml = '';
    const entities = this.config.entities || [];
    if (!isKiosk && entities.length > 1 && this._hass && !hideHeader) {
        const options = entities.map(entity => `<option value="${entity}" ${entity === this.currentEntity ? 'selected' : ''}>${this._hass.states[entity]?.attributes.friendly_name || entity}</option>`).join('');
        projectSelectorHtml = `<div class="controls"><select id="project-selector">${options}</select></div>`;
    } else if (isKiosk && this.sourceCatalogSupported === true && this.kioskSources.length && !hideHeader) {
        const activeKey = kioskSourceKey(this.activeSource);
        const options = this.kioskSources.map(source => {
            const key = kioskSourceKey(source);
            return `<option value="${this.escapeAttribute(key)}" ${key === activeKey ? 'selected' : ''}>${this.escapeHtml(source.label)}</option>`;
        }).join('');
        projectSelectorHtml = `<div class="controls"><select id="kiosk-source-selector" ${this._sourceLoading ? 'disabled' : ''}>${options}</select></div>`;
    }

    const style = `
      <style>
        :host { --card-padding: 16px; }
        ha-card { border-radius: 12px; background: var(--ha-card-background, var(--card-background-color, white)); color: ${textColor}; overflow: hidden; display: flex; flex-direction: column; transition: all 0.3s ease; ${bgStyle} font-size: ${fontScale}em; }
        .card-header { padding: var(--card-padding); background: ${headerColor}; color: white; transition: background 0.3s; display: flex; flex-direction: column; gap: 10px; }
        .priority-4 { border-left: 3px solid #d1453b !important; padding-left: 9px !important; }
        .priority-3 { border-left: 3px solid #eb8909 !important; padding-left: 9px !important; }
        .priority-2 { border-left: 3px solid #246fe0 !important; padding-left: 9px !important; }
        .priority-1 { border-left: 3px solid #808080 !important; padding-left: 9px !important; }
        .todoist-priority-1 { border-left: 3px solid #d1453b !important; padding-left: 9px !important; }
        .todoist-priority-2 { border-left: 3px solid #eb8909 !important; padding-left: 9px !important; }
        .todoist-priority-3 { border-left: 3px solid #246fe0 !important; padding-left: 9px !important; }
        .todoist-priority-4 { border-left: 3px solid #808080 !important; padding-left: 9px !important; }
        .header-top { display: flex; justify-content: space-between; align-items: center; }
        .header-title { font-weight: bold; font-size: 1.2rem; margin: 0; }
        .refresh-btn { background: none; border: none; color: inherit; cursor: pointer; opacity: 0.8; transition: transform 0.5s; padding: 0; }
        .refresh-btn:hover { opacity: 1; }
        .refresh-btn.spinning { transform: rotate(360deg); }
        .controls { display: flex; gap: 8px; flex-wrap: wrap;}
        select { flex-grow: 1; padding: 8px; border-radius: 6px; border: none; background: rgba(255,255,255,0.9); color: #333; font-family: inherit; cursor: pointer; }
        select:disabled { cursor: wait; opacity: 0.65; }
        .filter-btn { flex: 1; min-width: 50px; padding: 6px 4px; border: none; border-radius: 15px; background: rgba(255,255,255,0.2); color: white; cursor: pointer; font-size: 0.8rem; transition: all 0.2s; white-space: nowrap; }
        .filter-btn.active { background: white; color: #333; font-weight: 700; box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
        .task-list { padding: 0; margin: 0; list-style: none; min-height: 50px; overflow-y: auto; max-height: 400px; }
        .task-list.source-loading { opacity: 0.45; pointer-events: none; transition: opacity 0.2s; }
        .group-header { padding: 12px 16px 4px 16px; font-weight: bold; font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid transparent; margin-top: 5px; }
        .task-item { padding: 12px var(--card-padding); border-bottom: 1px solid var(--divider-color); display: flex; align-items: flex-start; gap: 12px; transition: opacity 0.2s; }
        .theme-minimalist ha-card { border: none; box-shadow: none; background: transparent !important; color: ${textColor} !important; }
        .theme-minimalist .card-header { background: transparent !important; color: ${textColor} !important; padding-bottom: 0; }
        .theme-minimalist .task-item { border-bottom: none; padding-left: 0; padding-right: 0; }
        .theme-minimalist .refresh-btn { color: ${textColor}; }
        .theme-minimalist .header-title { font-size: 1.5rem; }
        .theme-minimalist .filter-btn { background: rgba(127,127,127, 0.1); color: ${textColor}; }
        .theme-minimalist .filter-btn.active { background: ${textColor}; color: var(--primary-background-color); }
        .theme-frosted ha-card { ${bgStyle ? bgStyle : 'background: rgba(255, 255, 255, 0.1);'} backdrop-filter: blur(15px); -webkit-backdrop-filter: blur(15px); border: 1px solid rgba(255,255,255,0.2); box-shadow: 0 4px 30px rgba(0, 0, 0, 0.1); color: ${textColor}; }
        .theme-frosted .card-header { background: ${headerColor ? headerColor : 'rgba(var(--rgb-primary-color), 0.7)'}; }
        .theme-frosted .task-item { border-bottom: 1px solid rgba(255,255,255,0.1); }
        .theme-bubble ha-card { box-shadow: none; border: none; ${bgStyle ? bgStyle : 'background: transparent;'} color: ${textColor}; }
        .theme-bubble .card-header { background: var(--card-background-color); border-radius: 20px; margin-bottom: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.05); color: var(--primary-text-color); }
        .theme-bubble .refresh-btn { color: var(--primary-text-color); }
        .theme-bubble .task-item { ${bubbleStyleRaw ? bubbleStyleRaw : 'background: var(--secondary-background-color);'} border-radius: 16px; margin-bottom: 8px; border: none; box-shadow: 0 4px 6px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.1); color: var(--primary-text-color); }
        .theme-bubble .filter-btn { background: var(--secondary-background-color); color: var(--primary-text-color); }
        .theme-bubble .filter-btn.active { background: var(--primary-color); color: white; }
        .task-item.compact { padding: 6px var(--card-padding); gap: 8px; }
        .task-item.compact .task-title { font-size: 0.9rem; }
        .task-item:last-child { border-bottom: none; }
        .task-item:hover { background: rgba(127,127,127, 0.05); }
        .task-actions { margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; max-width: 42%; }
        .delete-btn { background: none; border: none; cursor: pointer; color: var(--secondary-text-color); opacity: 0.3; padding: 5px; font-size: 1.4rem; transition: all 0.2s; }
        .task-item:hover .delete-btn { opacity: 1; }
        .delete-btn:hover { color: var(--error-color, red); transform: scale(1.1); }
        input[type=checkbox] { margin-top: 2px; appearance: none; -webkit-appearance: none; width: 28px; height: 28px; border: 2px solid ${headerColor || 'var(--primary-color)'}; border-radius: 50%; outline: none; cursor: pointer; position: relative; flex-shrink: 0; }
        input[type=checkbox]:disabled { cursor: default; opacity: 0.45; }
        input[type=checkbox]:checked { background-color: ${headerColor || 'var(--primary-color)'}; }
        input[type=checkbox]:checked::after { content: ''; position: absolute; left: 8px; top: 3px; width: 6px; height: 13px; border: solid white; border-width: 0 2px 2px 0; transform: rotate(45deg); }
        .task-content { display: flex; flex-direction: column; flex-grow: 1; overflow: hidden; justify-content: center; min-height: 30px; cursor: pointer; }
        .task-title { font-size: 1rem; white-space: normal; word-break: break-word; line-height: 1.4; }
        .task-description { font-size: 0.85rem; color: var(--secondary-text-color); margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; transition: all 0.2s; position: relative; }
        .task-description:hover { color: inherit; opacity: 0.8; }
        .task-description.expanded { -webkit-line-clamp: unset; }
        .task-description.compact-desc { display: none; margin-top: 0; }
        .task-description.compact-desc.expanded { display: block; -webkit-line-clamp: unset; margin-top: 4px; }
        .date-badge { font-size: 0.75rem; padding: 2px 6px; border-radius: 4px; background: var(--secondary-background-color, #eee); color: var(--primary-text-color); white-space: nowrap; margin-bottom: 2px; }
        .date-badge.overdue { background: var(--error-color, #db4437); color: white; }
        .date-badge.today { background: var(--success-color, #0f9d58); color: white; }
        .project-badge { font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; background: rgba(127,127,127, 0.1); color: var(--secondary-text-color); white-space: nowrap; margin-bottom: 2px; margin-right: 4px; }
        .deadline-badge { font-size: 0.72rem; padding: 2px 6px; border-radius: 4px; background: rgba(209,69,59,0.12); color: var(--primary-text-color); white-space: nowrap; }
        .priority-badge { font-size: 0.7rem; font-weight: 700; padding: 2px 6px; border-radius: 10px; background: rgba(127,127,127,0.12); }
        .priority-badge.p1 { color: #d1453b; } .priority-badge.p2 { color: #eb8909; } .priority-badge.p3 { color: #246fe0; }
        .labels { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
        .label-badge { font-size: 0.72rem; color: var(--secondary-text-color); }
        .error-state { padding: 10px 16px; background: rgba(219,68,55,0.12); color: var(--error-color, #db4437); font-size: 0.85rem; }
        .completed-anim { text-decoration: line-through; opacity: 0.5; }
        .is-completed { text-decoration: line-through; color: gray; }
        .add-task-wrapper { padding: 12px var(--card-padding); border-top: 1px solid var(--divider-color); display: flex; gap: 10px; background: var(--card-background-color, white); margin-top: auto; }
        .add-task-input { flex-grow: 1; padding: 8px 12px; border-radius: 20px; border: 1px solid var(--divider-color, #ccc); background: rgba(127,127,127, 0.05); color: var(--primary-text-color); font-family: inherit; }
        .add-task-input:focus { outline: 2px solid ${headerColor || 'var(--primary-color)'}; border-color: transparent; }
        .add-btn { background: ${headerColor || 'var(--primary-color)'}; color: white; border: none; border-radius: 50%; width: 36px; height: 36px; cursor: pointer; font-size: 1.2rem; display: flex; align-items: center; justify-content: center; }
        .empty-state { padding: 40px 20px; text-align: center; color: var(--secondary-text-color); opacity: 0.7; }
        .empty-state svg { width: 64px; height: 64px; margin-bottom: 16px; color: ${headerColor || 'gray'}; opacity: 0.5; }
        .empty-state .quote { font-style: italic; font-size: 0.9rem; }
      </style>
      <ha-card class="${themeClass}">
        ${!hideHeader ? `
        <div class="card-header">
            <div class="header-top">
                <div class="header-title">${this.escapeHtml(this.config.title || 'Opgaver')}</div>
                <button class="refresh-btn" title="Refresh">
                    <svg style="width:24px;height:24px" viewBox="0 0 24 24">
                        <path fill="currentColor" d="M17.65,6.35C16.2,4.9 14.21,4 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20C15.73,20 18.84,17.45 19.73,14H17.65C16.83,16.33 14.61,18 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6C13.66,6 15.14,6.69 16.22,7.78L13,11H20V4L17.65,6.35Z" />
                    </svg>
                </button>
            </div>
            ${projectSelectorHtml}
            ${filterButtonsHtml ? `<div class="controls">${filterButtonsHtml}</div>` : ''}
        </div>
        ` : ''}
        ${this.errorMessage ? `<div class="error-state">${this.escapeHtml(this.errorMessage)}</div>` : ''}
        <ul class="task-list ${this._sourceLoading ? 'source-loading' : ''}">
          ${taskListHtml}
        </ul>
        ${!hideAddTask && (!isKiosk || this.config.allow_quick_add !== false) ? `
        <div class="add-task-wrapper"><input type="text" id="new-task-input" class="add-task-input" placeholder="${this.localize('add_task')}"><button id="add-task-btn" class="add-btn">+</button></div>
        ` : ''}
      </ha-card>
    `;

    this.shadowRoot.innerHTML = style;
    this.addEventListeners();
  }

  addEventListeners() {
    const select = this.shadowRoot.getElementById('project-selector'); if (select) select.addEventListener('change', (e) => { this.currentEntity = e.target.value; this.fetchTasks(); });
    const kioskSelect = this.shadowRoot.getElementById('kiosk-source-selector'); if (kioskSelect) kioskSelect.addEventListener('change', (e) => this.selectKioskSource(e.target.value));
    const refreshBtn = this.shadowRoot.querySelector('.refresh-btn'); if (refreshBtn) refreshBtn.addEventListener('click', () => this.manualRefresh());
    this.shadowRoot.querySelectorAll('.filter-btn').forEach(btn => { btn.addEventListener('click', (e) => { this.filter = e.target.dataset.filter; this.render(); }); });
    this.shadowRoot.querySelectorAll('.task-check').forEach(box => {
        box.addEventListener('change', (e) => {
            const isCompleted = e.target.dataset.completed === "true";
            const element = e.target.closest('.task-item');
            element.querySelector('.task-title').classList.toggle('completed-anim');
            this.toggleTask(e.target.dataset.uid, e.target.dataset.summary, isCompleted, element);
        });
    });
    this.shadowRoot.querySelectorAll('.task-content').forEach(content => {
        content.addEventListener('click', (e) => {
            const desc = e.currentTarget.querySelector('.task-description');
            if (desc) desc.classList.toggle('expanded');
        });
    });

    // Header click for collapsing
    this.shadowRoot.querySelectorAll('.group-header').forEach(header => {
        header.addEventListener('click', (e) => {
            const groupKey = e.currentTarget.dataset.group;
            this.toggleGroup(groupKey);
        });
    });

    this.shadowRoot.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const element = e.target.closest('.task-item');
            this.deleteTask(e.target.dataset.uid, e.target.dataset.summary, element);
        });
    });
    const addBtn = this.shadowRoot.getElementById('add-task-btn'); const addInput = this.shadowRoot.getElementById('new-task-input'); if (addBtn && addInput) { addBtn.addEventListener('click', () => this.addTask(addInput.value)); addInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') this.addTask(addInput.value); }); }
  }
}
if (!customElements.get('todoist-task-flow')) customElements.define('todoist-task-flow', TodoistTaskFlow);

// --- EDITOR KLASSE ---
class TodoistTaskFlowEditor extends HTMLElement {
  set hass(hass) {
    this._hass = hass;
    if (this._config) {
      this.render();
      this.loadKioskSources();
    }
  }
  setConfig(config) {
    this._config = config;
    this.render();
    this.loadKioskSources();
  }
  configChanged(newConfig) { const event = new CustomEvent("config-changed", { detail: { config: newConfig }, bubbles: true, composed: true, }); this.dispatchEvent(event); }
  escapeAttribute(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  isKioskConfig() {
    if (!this._config) return false;
    return this._config.type === 'custom:todoist-kiosk-card' || this._config.data_source === 'todoist_kiosk' || Boolean(this._config.default_source || this._config.project_id || this._config.filter || this._config.filter_name || this._config.filter_id);
  }

  async loadKioskSources() {
    if (!this._hass || !this.isKioskConfig() || this._sourcesLoading || this._sourcesLoaded) return;
    this._sourcesLoading = true;
    try {
      const response = await this._hass.callWS({ type: 'todoist_kiosk/sources' });
      this._backendSources = Array.isArray(response?.sources) ? response.sources : [];
    } catch (e) {
      this._backendSources = [];
    } finally {
      this._sourcesLoading = false;
      this._sourcesLoaded = true;
      if (this._config) this.render();
    }
  }

  editorSources(config = this._config) {
    const sources = mergeKioskSources(this._backendSources || [], config);
    const legacy = config.default_source ? null : legacyKioskSource(config);
    if (legacy?.kind === 'saved_filter' && !legacy.id) {
      const matches = sources.filter(source => source.kind === 'saved_filter' && source.name.toLocaleLowerCase() === legacy.name.toLocaleLowerCase());
      if (!matches.length) sources.push({ ...legacy, id: `name:${legacy.name}`, label: `Filter: ${legacy.name}` });
    } else if (legacy && !sources.some(source => kioskSourceKey(source) === kioskSourceKey(legacy))) {
      sources.push({ ...legacy, label: `${legacy.kind === 'project' ? 'Project' : 'Filter'}: ${legacy.name}` });
    }
    return sources;
  }

  editorDefaultKey(sources) {
    const configured = this._config.default_source;
    if (configured?.kind && configured?.id) return kioskSourceKey(configured);
    const legacy = legacyKioskSource(this._config);
    if (legacy?.kind === 'saved_filter' && !legacy.id) {
      const match = sources.find(source => source.kind === 'saved_filter' && source.name.toLocaleLowerCase() === legacy.name.toLocaleLowerCase());
      return kioskSourceKey(match);
    }
    return kioskSourceKey(legacy || sources[0]);
  }

  generateRawFilterId(name, filters = this._config.raw_filters || []) {
    const base = String(name || 'filter').toLocaleLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'filter';
    const used = new Set(filters.map(item => String(item?.id || '')));
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}_${suffix++}`;
    return id;
  }

  validateRawFilters(filters) {
    const ids = new Set();
    const names = new Set();
    for (const item of filters) {
      const id = String(item?.id || '').trim();
      const name = String(item?.name || '').trim();
      const query = String(item?.query || '').trim();
      if (!id || ids.has(id)) return 'Raw filter IDs must be unique.';
      if (!name) return 'Raw filter names are required.';
      const foldedName = name.toLocaleLowerCase();
      if (names.has(foldedName)) return 'Raw filter names must be unique.';
      if (!query) return 'Raw filter queries are required.';
      if (query.length > 1024) return 'Raw filter queries cannot exceed 1,024 characters.';
      ids.add(id);
      names.add(foldedName);
    }
    return '';
  }

  updateRawFilter(index, field, value, input) {
    const filters = (this._config.raw_filters || []).map(item => ({ ...item }));
    if (!filters[index]) return;
    filters[index][field] = value.trim();
    const error = this.validateRawFilters(filters);
    if (input?.setCustomValidity) {
      input.setCustomValidity(error);
      if (error && input.reportValidity) input.reportValidity();
    }
    if (error) return;
    this.configChanged({ ...this._config, raw_filters: filters });
  }

  addRawFilter() {
    const filters = [...(this._config.raw_filters || [])];
    const usedNames = new Set(filters.map(item => String(item?.name || '').trim().toLocaleLowerCase()));
    let name = 'New Filter';
    let suffix = 2;
    while (usedNames.has(name.toLocaleLowerCase())) name = `New Filter ${suffix++}`;
    filters.push({ id: this.generateRawFilterId(name, filters), name, query: 'today' });
    this.configChanged({ ...this._config, raw_filters: filters });
  }

  removeRawFilter(index) {
    const removed = (this._config.raw_filters || [])[index];
    const filters = (this._config.raw_filters || []).filter((_, itemIndex) => itemIndex !== index);
    const next = { ...this._config, raw_filters: filters };
    if (removed && next.default_source?.kind === 'raw_filter' && String(next.default_source.id) === String(removed.id)) {
      const replacement = this.editorSources(next)[0];
      if (replacement) next.default_source = { kind: replacement.kind, id: replacement.id };
      else delete next.default_source;
    }
    this.configChanged(next);
  }

  render() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const { title, data_source, filter, filter_name, filter_id, default_filter, show_completed, header_color, compact_view, enabled_filters, theme, background_color, background_opacity, text_color, bubble_color, bubble_opacity, use_gamification, visual_effect, sound_effect, show_project_tag, show_project, show_due, show_deadline, show_priority, show_labels, allow_complete, allow_quick_add, hide_header, hide_add_task, max_items, font_scale, sort_order } = this._config;
    const isDedicatedKiosk = this._config.type === 'custom:todoist-kiosk-card';
    const isKiosk = isDedicatedKiosk || (data_source ? data_source === 'todoist_kiosk' : Boolean(this._config.default_source || this._config.project_id || filter || filter_name || filter_id || this._config.raw_filters?.length));
    const allTodoEntities = this._hass ? Object.keys(this._hass.states).filter(eid => eid.startsWith('todo.')) : [];
    let currentEntities = this._config.entities || [];
    if (typeof currentEntities === 'string') currentEntities = currentEntities.split(',').map(e => e.trim());

    // Localization
    const hassLang = this._hass?.language?.toLowerCase() || 'en';
    const lang = (hassLang === 'da' || hassLang.startsWith('da-')) ? 'da' : 'en';
    const t = {
        da: {
            title: 'Titel', theme: 'Design Tema', header_color: 'Header Farve', reset: 'Nulstil', color_help: 'Vælg farve (kun for Standard og Frosted design).', select_lists: 'Vælg Todo Lister', no_lists: 'Ingen todo-lister fundet', lists_help: 'Vælg én eller flere lister.', active_filters: 'Aktive Filtre', start_filter: 'Start-Filter', show_completed: 'Vis afsluttede opgaver', compact_view: 'Kompakt Visning',
            background_color: 'Kort Baggrundsfarve', background_opacity: 'Kort Gennemsigtighed', background_help: 'Vælg baggrundsfarve og gennemsigtighed for kortet (Ikke Minimalist).',
            text_color: 'Tekstfarve', text_help: 'Vælg farve til teksten på kortet.',
            bubble_color: 'Boble Farve', bubble_opacity: 'Boble Gennemsigtighed', bubble_help: 'Vælg farve til boblerne.',
            gamification: 'Gamification 🎮', use_gamification: 'Aktiver Gamification', visual_effect: 'Visuel Effekt', sound_effect: 'Lydeffekt',
            show_project_tag: 'Vis projekt-tag', hide_header: 'Skjul Header', hide_add_task: 'Skjul tilføjelse af opgaver', max_items: 'Max antal opgaver (0 = alle)', font_scale: 'Skriftstørrelse (%)', sort_order: 'Sortering',
            data_source: 'Datakilde', generic_source: 'Home Assistant-opgavelister', kiosk_source: 'Todoist Kiosk-integration', kiosk_filtering: 'Todoist Kiosk-kilder', raw_filter: 'Rå Todoist-filterforespørgsel', filter_name: 'Gemt filternavn', filter_id: 'Gemt filter-ID', filter_help: 'Ældre konfiguration bevares som reserve.', default_source: 'Standardkilde', raw_filters: 'Navngivne rå filtre', raw_filter_name: 'Navn', raw_filter_query: 'Todoist-forespørgsel', add_raw_filter: 'Tilføj råt filter', remove: 'Fjern', no_sources: 'Ingen kilder tilgængelige endnu', raw_filter_help: 'Navne skal være unikke. Forespørgsler må højst være 1.024 tegn.', show_project: 'Vis projekt', show_due: 'Vis forfaldsdato', show_deadline: 'Vis deadline', show_priority: 'Vis prioritet', show_labels: 'Vis etiketter', allow_complete: 'Tillad fuldførelse', allow_quick_add: 'Tillad Quick Add',
            sort_options: { date: 'Dato (Standard)', alpha: 'Alfabetisk', newest: 'Senest tilføjet' },
            themes: { standard: 'Standard', minimalist: 'Minimalist', frosted: 'Frosted Glass', bubble: 'Bubble Card' },
            filters: { all: 'Alle', today: 'I dag', overdue: 'Forfaldne', today_overdue: 'Nu', week: 'Uge', month: 'Måned' },
            visuals: { none: 'Ingen', confetti: 'Konfetti', sparkles: 'Glimmer', emoji: 'Emoji Pop' },
            sounds: { none: 'Ingen', ding: 'Ding', pop: 'Pop', coin: 'Mønt' }
        },
        en: {
            title: 'Title', theme: 'Design Theme', header_color: 'Header Color', reset: 'Reset', color_help: 'Pick color (Standard & Frosted themes only).', select_lists: 'Select Todo Lists', no_lists: 'No todo lists found', lists_help: 'Select one or more lists.', active_filters: 'Active Filters', start_filter: 'Start Filter', show_completed: 'Show completed tasks', compact_view: 'Compact View',
            background_color: 'Card Background Color', background_opacity: 'Card Opacity', background_help: 'Pick card background color and opacity (Not Minimalist).',
            text_color: 'Text Color', text_help: 'Pick color for text on the card.',
            bubble_color: 'Bubble Color', bubble_opacity: 'Bubble Opacity', bubble_help: 'Pick color for the task bubbles.',
            gamification: 'Gamification 🎮', use_gamification: 'Enable Gamification', visual_effect: 'Visual Effect', sound_effect: 'Sound Effect',
            show_project_tag: 'Show Project Tag', hide_header: 'Hide Header', hide_add_task: 'Hide Add Task Input', max_items: 'Max Items (0 = all)', font_scale: 'Font Scale (%)', sort_order: 'Sort Order',
            data_source: 'Data Source', generic_source: 'Home Assistant to-do lists', kiosk_source: 'Todoist Kiosk integration', kiosk_filtering: 'Todoist Kiosk Sources', raw_filter: 'Raw Todoist filter query', filter_name: 'Saved filter name', filter_id: 'Saved filter ID', filter_help: 'Legacy selectors are preserved as a compatibility fallback.', default_source: 'Default source', raw_filters: 'Named raw filters', raw_filter_name: 'Name', raw_filter_query: 'Todoist query', add_raw_filter: 'Add raw filter', remove: 'Remove', no_sources: 'No sources available yet', raw_filter_help: 'Names must be unique. Queries are limited to 1,024 characters.', show_project: 'Show project', show_due: 'Show due date', show_deadline: 'Show deadline', show_priority: 'Show priority', show_labels: 'Show labels', allow_complete: 'Allow completion', allow_quick_add: 'Allow Quick Add',
            sort_options: { date: 'Date (Default)', alpha: 'Alphabetical', newest: 'Newest First' },
            themes: { standard: 'Standard', minimalist: 'Minimalist', frosted: 'Frosted Glass', bubble: 'Bubble Card' },
            filters: { all: 'All', today: 'Today', overdue: 'Overdue', today_overdue: 'Now', week: 'Week', month: 'Month' },
            visuals: { none: 'None', confetti: 'Confetti', sparkles: 'Sparkles', emoji: 'Emoji Pop' },
            sounds: { none: 'None', ding: 'Ding', pop: 'Pop', coin: 'Coin' }
        }
    };
    const s = t[lang];
    const availableFilters = [ { id: 'all', label: s.filters.all }, { id: 'today', label: s.filters.today }, { id: 'overdue', label: s.filters.overdue }, { id: 'today_overdue', label: s.filters.today_overdue }, { id: 'week', label: s.filters.week }, { id: 'month', label: s.filters.month } ];
    const availableThemes = [ {id: 'standard', label: s.themes.standard}, {id: 'minimalist', label: s.themes.minimalist}, {id: 'frosted', label: s.themes.frosted}, {id: 'bubble', label: s.themes.bubble} ];
    const sortOptions = [ {id: 'date', label: s.sort_options.date}, {id: 'alpha', label: s.sort_options.alpha}, {id: 'newest', label: s.sort_options.newest} ];
    const visualEffects = [ {id: 'none', label: s.visuals.none}, {id: 'confetti', label: s.visuals.confetti}, {id: 'sparkles', label: s.visuals.sparkles}, {id: 'emoji', label: s.visuals.emoji} ];
    const soundEffects = [ {id: 'none', label: s.sounds.none}, {id: 'ding', label: s.sounds.ding}, {id: 'pop', label: s.sounds.pop}, {id: 'coin', label: s.sounds.coin} ];

    const showHeaderColor = !theme || theme === 'standard' || theme === 'frosted';
    const showBackgroundSettings = !theme || theme !== 'minimalist';
    const showBubbleSettings = theme === 'bubble';
    const rawFilters = Array.isArray(this._config.raw_filters) ? this._config.raw_filters : [];
    const sourceOptions = isKiosk ? this.editorSources() : [];
    const defaultSourceKey = isKiosk ? this.editorDefaultKey(sourceOptions) : '';

    this.shadowRoot.innerHTML = `
      <style>
        .row { display: flex; flex-direction: column; margin-bottom: 15px; }
        .row-checkbox { display: flex; flex-direction: row; align-items: center; gap: 10px; margin-bottom: 5px; }
        .row-checkbox label { margin: 0; font-weight: normal; }
        label { font-weight: bold; margin-bottom: 5px; display: block; color: var(--primary-text-color); }
        input[type="text"], input[type="color"], input[type="number"], select, input[type="range"], textarea { padding: 8px; width: 95%; border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color, white); color: var(--primary-text-color); border-radius: 4px; }
        textarea { min-height: 80px; resize: vertical; font-family: inherit; }
        input[type="color"] { width: 100%; height: 40px; padding: 2px; }
        .help { font-size: 0.8em; color: var(--secondary-text-color); margin-top: 4px; }
        .filter-list { border: 1px solid var(--divider-color, #ccc); padding: 10px; border-radius: 4px; max-height: 200px; overflow-y: auto; background: rgba(0,0,0,0.03); }
        .raw-filter-row { border: 1px solid var(--divider-color, #ccc); border-radius: 6px; padding: 10px; margin-bottom: 10px; }
        .raw-filter-row textarea { width: 95%; min-height: 55px; }
        .raw-filter-actions { display: flex; justify-content: flex-end; margin-top: 6px; }
        button { padding: 7px 10px; border: 1px solid var(--divider-color, #ccc); border-radius: 4px; background: var(--secondary-background-color, #eee); color: var(--primary-text-color); cursor: pointer; }
        .section-header { font-weight: bold; font-size: 1.1em; margin-top: 20px; margin-bottom: 10px; border-bottom: 1px solid var(--divider-color, #ccc); padding-bottom: 5px; }
      </style>
      <div class="row"><label>${s.title}</label><input type="text" id="title-input" value="${this.escapeAttribute(title)}"></div>
      ${!isDedicatedKiosk ? `<div class="row"><label>${s.data_source}</label><select id="data-source-input"><option value="todo" ${!isKiosk?'selected':''}>${s.generic_source}</option><option value="todoist_kiosk" ${isKiosk?'selected':''}>${s.kiosk_source}</option></select></div>` : ''}

      ${isKiosk ? `
      <div class="section-header">${s.kiosk_filtering}</div>
      <div class="row"><label>${s.default_source}</label><select id="default-source-input" ${sourceOptions.length ? '' : 'disabled'}>${sourceOptions.length ? sourceOptions.map(source => `<option value="${this.escapeAttribute(kioskSourceKey(source))}" ${kioskSourceKey(source) === defaultSourceKey ? 'selected' : ''}>${this.escapeAttribute(source.label)}</option>`).join('') : `<option>${s.no_sources}</option>`}</select></div>
      <div class="row"><label>${s.raw_filters}</label>
        <div id="raw-filter-list">
          ${rawFilters.map((item, index) => `<div class="raw-filter-row" data-index="${index}">
            <label>${s.raw_filter_name}</label><input type="text" class="raw-filter-name" value="${this.escapeAttribute(item.name)}" required>
            <label style="margin-top:8px;">${s.raw_filter_query}</label><textarea class="raw-filter-query" maxlength="1024" required>${this.escapeAttribute(item.query)}</textarea>
            <div class="raw-filter-actions"><button type="button" class="remove-raw-filter">${s.remove}</button></div>
          </div>`).join('')}
        </div>
        <button type="button" id="add-raw-filter">${s.add_raw_filter}</button>
        <div class="help">${s.raw_filter_help}</div>
      </div>
      ` : ''}

      <div class="row"><label>${s.theme}</label><select id="theme-input">${availableThemes.map(th => `<option value="${th.id}" ${(theme||'standard')===th.id?'selected':''}>${th.label}</option>`).join('')}</select></div>

      ${showHeaderColor ? `
      <div class="row"><label>${s.header_color}</label><div style="display:flex; gap:10px;"><input type="color" id="color-input" value="${header_color || '#03a9f4'}"><button id="clear-color" style="padding:0 10px;">${s.reset}</button></div><div class="help">${s.color_help}</div></div>
      ` : ''}

      ${showBackgroundSettings ? `
      <div class="row"><label>${s.background_color}</label><div style="display:flex; gap:10px;"><input type="color" id="bg-color-input" value="${background_color || '#ffffff'}"><button id="clear-bg-color" style="padding:0 10px;">${s.reset}</button></div></div>
      <div class="row"><label>${s.background_opacity} (${background_opacity !== undefined ? background_opacity : 100}%)</label><input type="range" id="bg-opacity-input" min="0" max="100" value="${background_opacity !== undefined ? background_opacity : 100}"></div>
      <div class="help" style="margin-bottom:15px;">${s.background_help}</div>
      ` : ''}

      ${showBubbleSettings ? `
      <div class="row"><label>${s.bubble_color}</label><div style="display:flex; gap:10px;"><input type="color" id="bubble-color-input" value="${bubble_color || '#ffffff'}"><button id="clear-bubble-color" style="padding:0 10px;">${s.reset}</button></div></div>
      <div class="row"><label>${s.bubble_opacity} (${bubble_opacity !== undefined ? bubble_opacity : 100}%)</label><input type="range" id="bubble-opacity-input" min="0" max="100" value="${bubble_opacity !== undefined ? bubble_opacity : 100}"></div>
      <div class="help" style="margin-bottom:15px;">${s.bubble_help}</div>
      ` : ''}

      <div class="row"><label>${s.text_color}</label><div style="display:flex; gap:10px;"><input type="color" id="text-color-input" value="${text_color || '#000000'}"><button id="clear-text-color" style="padding:0 10px;">${s.reset}</button></div><div class="help">${s.text_help}</div></div>

      <div class="row"><label>${s.font_scale} (${font_scale || 100}%)</label><input type="range" id="font-scale-input" min="80" max="150" value="${font_scale || 100}"></div>

      <div class="section-header">${s.gamification}</div>
      <div class="row row-checkbox"><input type="checkbox" id="gamification-input" ${use_gamification?'checked':''}><label>${s.use_gamification}</label></div>
      ${use_gamification ? `
      <div class="row"><label>${s.visual_effect}</label><select id="visual-input">${visualEffects.map(v => `<option value="${v.id}" ${(visual_effect||'confetti')===v.id?'selected':''}>${v.label}</option>`).join('')}</select></div>
      <div class="row"><label>${s.sound_effect}</label><select id="sound-input">${soundEffects.map(snd => `<option value="${snd.id}" ${(sound_effect||'none')===snd.id?'selected':''}>${snd.label}</option>`).join('')}</select></div>
      ` : ''}

      <div class="section-header">Indhold & Visning</div>
      ${!isKiosk ? `<div class="row"><label>${s.select_lists}</label><div class="filter-list">${allTodoEntities.length === 0 ? `<div style="padding:5px;">${s.no_lists}</div>` : ''}${allTodoEntities.map(eid => `<div class="row-checkbox"><input type="checkbox" class="entity-checkbox" value="${eid}" ${currentEntities.includes(eid)?'checked':''}><label>${this._hass.states[eid].attributes.friendly_name || eid}</label></div>`).join('')}</div><div class="help">${s.lists_help}</div></div>` : ''}

      <div class="row"><label>${s.sort_order}</label><select id="sort-order-input">${sortOptions.map(o => `<option value="${o.id}" ${(sort_order||'date')===o.id?'selected':''}>${o.label}</option>`).join('')}</select></div>

      <div class="row"><label>${s.max_items}</label><input type="number" id="max-items-input" min="0" value="${max_items !== undefined ? max_items : 0}"></div>

      ${!isKiosk ? `<div class="row"><label>${s.active_filters}</label><div class="filter-list">${availableFilters.map(f => `<div class="row-checkbox"><input type="checkbox" class="filter-checkbox" value="${f.id}" ${(enabled_filters||['all','today','overdue']).includes(f.id)?'checked':''}><label>${f.label}</label></div>`).join('')}</div></div>
      <div class="row"><label>${s.start_filter}</label><select id="filter-input">${availableFilters.map(f => `<option value="${f.id}" ${(default_filter||'all')===f.id?'selected':''}>${f.label}</option>`).join('')}</select></div>` : ''}

      <div class="row row-checkbox"><input type="checkbox" id="hide-header-input" ${hide_header?'checked':''}><label>${s.hide_header}</label></div>
      <div class="row row-checkbox"><input type="checkbox" id="hide-add-task-input" ${hide_add_task?'checked':''}><label>${s.hide_add_task}</label></div>
      ${isKiosk ? `
      <div class="row row-checkbox"><input type="checkbox" id="show-project-input" ${show_project!==false?'checked':''}><label>${s.show_project}</label></div>
      <div class="row row-checkbox"><input type="checkbox" id="show-due-input" ${show_due!==false?'checked':''}><label>${s.show_due}</label></div>
      <div class="row row-checkbox"><input type="checkbox" id="show-deadline-input" ${show_deadline!==false?'checked':''}><label>${s.show_deadline}</label></div>
      <div class="row row-checkbox"><input type="checkbox" id="show-priority-input" ${show_priority!==false?'checked':''}><label>${s.show_priority}</label></div>
      <div class="row row-checkbox"><input type="checkbox" id="show-labels-input" ${show_labels?'checked':''}><label>${s.show_labels}</label></div>
      <div class="row row-checkbox"><input type="checkbox" id="allow-complete-input" ${allow_complete!==false?'checked':''}><label>${s.allow_complete}</label></div>
      <div class="row row-checkbox"><input type="checkbox" id="allow-quick-add-input" ${allow_quick_add!==false?'checked':''}><label>${s.allow_quick_add}</label></div>
      ` : `
      <div class="row row-checkbox"><input type="checkbox" id="show-project-tag-input" ${show_project_tag?'checked':''}><label>${s.show_project_tag}</label></div>
      <div class="row row-checkbox"><input type="checkbox" id="completed-input" ${show_completed?'checked':''}><label>${s.show_completed}</label></div>
      `}
      <div class="row row-checkbox"><input type="checkbox" id="compact-input" ${compact_view?'checked':''}><label>${s.compact_view}</label></div>
    `;

    const getChecked = (sel) => Array.from(this.shadowRoot.querySelectorAll(sel)).filter(b=>b.checked).map(b=>b.value);

    this.shadowRoot.getElementById("title-input").addEventListener("change", (e) => this.configChanged({ ...this._config, title: e.target.value }));
    if (!isDedicatedKiosk) {
        this.shadowRoot.getElementById("data-source-input").addEventListener("change", (e) => {
            const next = { ...this._config, data_source: e.target.value };
            if (e.target.value === 'todoist_kiosk' && !next.default_source && !next.project_id && !next.filter && !next.filter_name && !next.filter_id && !next.raw_filters?.length) next.filter = TODOIST_KIOSK_DEFAULT_FILTER;
            this.configChanged(next);
        });
    }
    this.shadowRoot.getElementById("theme-input").addEventListener("change", (e) => this.configChanged({ ...this._config, theme: e.target.value }));

    if (showHeaderColor) {
        this.shadowRoot.getElementById("color-input").addEventListener("change", (e) => this.configChanged({ ...this._config, header_color: e.target.value }));
        this.shadowRoot.getElementById("clear-color").onclick = () => { this.shadowRoot.getElementById("color-input").value='#03a9f4'; this.configChanged({ ...this._config, header_color: "" }); };
    }

    if (showBackgroundSettings) {
        this.shadowRoot.getElementById("bg-color-input").addEventListener("change", (e) => this.configChanged({ ...this._config, background_color: e.target.value }));
        this.shadowRoot.getElementById("clear-bg-color").onclick = () => { this.shadowRoot.getElementById("bg-color-input").value='#ffffff'; this.configChanged({ ...this._config, background_color: "" }); };
        this.shadowRoot.getElementById("bg-opacity-input").addEventListener("change", (e) => this.configChanged({ ...this._config, background_opacity: Number(e.target.value) }));
    }

    if (showBubbleSettings) {
        this.shadowRoot.getElementById("bubble-color-input").addEventListener("change", (e) => this.configChanged({ ...this._config, bubble_color: e.target.value }));
        this.shadowRoot.getElementById("clear-bubble-color").onclick = () => { this.shadowRoot.getElementById("bubble-color-input").value='#ffffff'; this.configChanged({ ...this._config, bubble_color: "" }); };
        this.shadowRoot.getElementById("bubble-opacity-input").addEventListener("change", (e) => this.configChanged({ ...this._config, bubble_opacity: Number(e.target.value) }));
    }

    this.shadowRoot.getElementById("text-color-input").addEventListener("change", (e) => this.configChanged({ ...this._config, text_color: e.target.value }));
    this.shadowRoot.getElementById("clear-text-color").onclick = () => {
        this.shadowRoot.getElementById("text-color-input").value='#000000';
        this.configChanged({ ...this._config, text_color: "" });
    };

    this.shadowRoot.getElementById("font-scale-input").addEventListener("change", (e) => this.configChanged({ ...this._config, font_scale: Number(e.target.value) }));
    this.shadowRoot.getElementById("max-items-input").addEventListener("change", (e) => this.configChanged({ ...this._config, max_items: Number(e.target.value) }));
    this.shadowRoot.getElementById("sort-order-input").addEventListener("change", (e) => this.configChanged({ ...this._config, sort_order: e.target.value }));

    // Gamification listeners
    this.shadowRoot.getElementById("gamification-input").addEventListener("change", (e) => this.configChanged({ ...this._config, use_gamification: e.target.checked }));
    if (use_gamification) {
        this.shadowRoot.getElementById("visual-input").addEventListener("change", (e) => this.configChanged({ ...this._config, visual_effect: e.target.value }));
        this.shadowRoot.getElementById("sound-input").addEventListener("change", (e) => this.configChanged({ ...this._config, sound_effect: e.target.value }));
    }

    if (isKiosk) {
        const defaultSourceInput = this.shadowRoot.getElementById("default-source-input");
        if (defaultSourceInput && sourceOptions.length) defaultSourceInput.onchange = (e) => {
            const selected = sourceOptions.find(source => kioskSourceKey(source) === e.target.value);
            if (!selected) return;
            if (selected.legacy && selected.kind === 'saved_filter' && selected.id.startsWith('name:')) {
                const next = { ...this._config };
                delete next.default_source;
                this.configChanged(next);
                return;
            }
            this.configChanged({ ...this._config, default_source: { kind: selected.kind, id: selected.id } });
        };
        const addRawFilterButton = this.shadowRoot.getElementById("add-raw-filter");
        if (addRawFilterButton) addRawFilterButton.onclick = () => this.addRawFilter();
        this.shadowRoot.querySelectorAll('.raw-filter-row').forEach(row => {
            const index = Number(row.dataset.index);
            const nameInput = row.querySelector('.raw-filter-name');
            const queryInput = row.querySelector('.raw-filter-query');
            const removeButton = row.querySelector('.remove-raw-filter');
            if (nameInput) nameInput.onchange = (e) => this.updateRawFilter(index, 'name', e.target.value, e.target);
            if (queryInput) queryInput.onchange = (e) => this.updateRawFilter(index, 'query', e.target.value, e.target);
            if (removeButton) removeButton.onclick = () => this.removeRawFilter(index);
        });
        const filterIdInput = this.shadowRoot.getElementById("filter-id-input");
        const filterNameInput = this.shadowRoot.getElementById("filter-name-input");
        const rawFilterInput = this.shadowRoot.getElementById("raw-filter-input");
        if (filterIdInput) filterIdInput.onchange = (e) => this.configChanged({ ...this._config, filter_id: e.target.value.trim() });
        if (filterNameInput) filterNameInput.onchange = (e) => this.configChanged({ ...this._config, filter_name: e.target.value.trim() });
        if (rawFilterInput) rawFilterInput.onchange = (e) => this.configChanged({ ...this._config, filter: e.target.value.trim() });
        this.shadowRoot.getElementById("show-project-input").onchange = (e) => this.configChanged({ ...this._config, show_project: e.target.checked });
        this.shadowRoot.getElementById("show-due-input").onchange = (e) => this.configChanged({ ...this._config, show_due: e.target.checked });
        this.shadowRoot.getElementById("show-deadline-input").onchange = (e) => this.configChanged({ ...this._config, show_deadline: e.target.checked });
        this.shadowRoot.getElementById("show-priority-input").onchange = (e) => this.configChanged({ ...this._config, show_priority: e.target.checked });
        this.shadowRoot.getElementById("show-labels-input").onchange = (e) => this.configChanged({ ...this._config, show_labels: e.target.checked });
        this.shadowRoot.getElementById("allow-complete-input").onchange = (e) => this.configChanged({ ...this._config, allow_complete: e.target.checked });
        this.shadowRoot.getElementById("allow-quick-add-input").onchange = (e) => this.configChanged({ ...this._config, allow_quick_add: e.target.checked });
    } else {
        this.shadowRoot.querySelectorAll(".entity-checkbox").forEach(b => b.onchange = () => this.configChanged({ ...this._config, entities: getChecked(".entity-checkbox") }));
        this.shadowRoot.querySelectorAll(".filter-checkbox").forEach(b => b.onchange = () => this.configChanged({ ...this._config, enabled_filters: getChecked(".filter-checkbox") }));
        this.shadowRoot.getElementById("filter-input").onchange = (e) => this.configChanged({ ...this._config, default_filter: e.target.value });
        this.shadowRoot.getElementById("show-project-tag-input").onchange = (e) => this.configChanged({ ...this._config, show_project_tag: e.target.checked });
        this.shadowRoot.getElementById("completed-input").onchange = (e) => this.configChanged({ ...this._config, show_completed: e.target.checked });
    }
    this.shadowRoot.getElementById("hide-header-input").onchange = (e) => this.configChanged({ ...this._config, hide_header: e.target.checked });
    this.shadowRoot.getElementById("hide-add-task-input").onchange = (e) => this.configChanged({ ...this._config, hide_add_task: e.target.checked });
    this.shadowRoot.getElementById("compact-input").onchange = (e) => this.configChanged({ ...this._config, compact_view: e.target.checked });
  }
}
if (!customElements.get("todoist-task-flow-editor")) customElements.define("todoist-task-flow-editor", TodoistTaskFlowEditor);

class TodoistKioskCard extends TodoistTaskFlow {
  static getStubConfig() {
    return {
      ...TodoistTaskFlow.getStubConfig(),
      data_source: 'todoist_kiosk',
      title: 'Tasks',
      filter: TODOIST_KIOSK_DEFAULT_FILTER,
      raw_filters: [{ id: 'default_query', name: 'Custom Query', query: TODOIST_KIOSK_DEFAULT_FILTER }],
      default_source: { kind: 'raw_filter', id: 'default_query' },
      show_project: true,
      show_due: true,
      show_deadline: true,
      show_priority: true,
      show_labels: false,
      allow_complete: true,
      allow_quick_add: true
    };
  }
}

if (!customElements.get('todoist-kiosk-card')) customElements.define('todoist-kiosk-card', TodoistKioskCard);
// Registrer custom card for Home Assistant picker
window.customCards = window.customCards || [];
window.customCards.push({
  type: "todoist-task-flow",
  name: "Todoist Task Flow",
  description: "A custom card for Todoist tasks with themes, gamification and full customization.",
});
window.customCards.push({
  type: "todoist-kiosk-card",
  name: "Todoist Kiosk Card",
  description: "A touch-friendly Todoist card backed by the Todoist Kiosk Home Assistant integration.",
});

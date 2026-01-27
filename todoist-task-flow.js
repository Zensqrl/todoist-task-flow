class TodoistTaskFlow extends HTMLElement {
  // --- CONFIGURATION ---
  static getConfigElement() { return document.createElement("todoist-task-flow-editor"); }
  static getStubConfig() {
    return {
      entities: [],
      title: "Mine Opgaver",
      default_filter: "all",
      show_completed: false,
      show_project_tag: false, 
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
    this.config = config;
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
    this._collapsedGroups = new Set();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
      this._interval = setInterval(() => this.fetchTasks(), 600000);
  }

  disconnectedCallback() {
      if (this._interval) clearInterval(this._interval);
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.currentEntity) return;

    if (!this.hasInitialized) {
      this.hasInitialized = true;
      if (!this.tasks.length) this.fetchTasks();
    }
    
    if (!this.shadowRoot.innerHTML) {
        this.render();
    }
  }

  async fetchTasks() {
    if (!this._hass || !this.currentEntity) return;
    
    const list = this.shadowRoot.querySelector('.task-list');
    this._savedScrollTop = list ? list.scrollTop : 0;

    const refreshBtn = this.shadowRoot.querySelector('.refresh-btn');
    if (refreshBtn) refreshBtn.classList.add('spinning');

    try {
      const response = await this._hass.callWS({ type: "todo/item/list", entity_id: this.currentEntity });
      
      // SORTERING LOGIK
      let items = response.items || [];
      const sortOrder = this.config.sort_order || 'date';

      if (sortOrder === 'alpha') {
          items.sort((a, b) => a.summary.localeCompare(b.summary));
      } else if (sortOrder === 'newest') {
          items.reverse(); 
      } else {
          items.sort((a, b) => {
            if (a.priority && b.priority && a.priority !== b.priority) {
                 return b.priority - a.priority;
            }
            const dateA = a.due ? a.due : '9999-99-99';
            const dateB = b.due ? b.due : '9999-99-99';
            if (dateA !== dateB) return dateA.localeCompare(dateB);
            return a.summary.localeCompare(b.summary);
          });
      }
      this.tasks = items;

    } catch (e) {
      console.warn("Kunne ikke hente opgaver:", e.message);
      this.tasks = [];
    }
    
    this.render();
    
    const newList = this.shadowRoot.querySelector('.task-list');
    if (newList && this._savedScrollTop) {
        newList.scrollTop = this._savedScrollTop;
    }
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
    if (!isCompleted && this.config.use_gamification) {
        const rect = element.getBoundingClientRect();
        this.playSound(this.config.sound_effect);
        this.showVisualEffect(this.config.visual_effect, rect);
    }
    this.setLoadingState(element, true);
    try {
      const payload = { entity_id: this.currentEntity, item: itemSummary, status: isCompleted ? "needs_action" : "completed" };
      await this._hass.callService("todo", "update_item", payload);
      setTimeout(() => this.fetchTasks(), 200);
    } catch (e) {
      console.error("Fejl:", e);
      alert(this.localize('loading_error'));
      this.setLoadingState(element, false);
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
    if (!value) return;
    try {
      await this._hass.callService("todo", "add_item", { entity_id: this.currentEntity, item: value });
      const input = this.shadowRoot.getElementById('new-task-input');
      if (input) input.value = "";
      setTimeout(() => this.fetchTasks(), 200);
    } catch (e) {
      console.error("Fejl:", e);
      alert(this.localize('loading_error'));
    }
  }

  // --- HELPERS ---

  formatDateSmart(isoDate) {
      if (!isoDate) return "";
      const lang = this.getLanguage() === 'da' ? 'da-DK' : 'en-US';
      const isDateOnly = isoDate.length === 10;
      const taskDate = new Date(isoDate);
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
      return dateStr + (timeStr ? ` <span style="opacity:0.7">kl.${timeStr}</span>` : "");
  }

  escapeAttribute(text) {
      if (!text) return "";
      return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
    if (!this.currentEntity) {
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
    const showProjectTag = this.config.show_project_tag;
    const projectName = this._hass.states[this.currentEntity]?.attributes.friendly_name || "";
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
                    const projectTagHtml = (showProjectTag && projectName) ? `<span class="project-badge">${projectName}</span>` : '';
                    
                    let priorityClass = '';
                    if (task.priority) priorityClass = `priority-${task.priority}`;

                    taskListHtml += `
                    <li class="task-item ${isCompact ? 'compact' : ''} ${priorityClass}">
                      <input type="checkbox" class="task-check" 
                             data-uid="${task.uid||''}" data-summary="${safeSummary}"
                             data-completed="${isCompleted}" ${isCompleted ? 'checked' : ''}>
                      <div class="task-content">
                        <span class="task-title ${isCompleted ? 'is-completed' : ''}">${task.summary}</span>
                        ${descHtml}
                      </div>
                      <div class="task-actions">
                        ${projectTagHtml}
                        ${dateText ? `<span class="date-badge ${dateClass}">${dateText}</span>` : ''}
                        <button class="delete-btn" title="${this.localize('delete')}" data-uid="${task.uid||''}" data-summary="${safeSummary}">🗑</button>
                      </div>
                    </li>`;
                });
            }
        }
    });

    // Hidden count footer
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
    const filterButtonsHtml = activeFiltersList.map(filterKey => {
        const label = availableFilters[filterKey] || filterKey;
        const isActive = this.filter === filterKey ? 'active' : '';
        return `<button class="filter-btn ${isActive}" data-filter="${filterKey}">${label}</button>`;
    }).join('');

    let projectSelectorHtml = '';
    const entities = this.config.entities || [];
    if (entities.length > 1 && this._hass && !hideHeader) {
        const options = entities.map(entity => `<option value="${entity}" ${entity === this.currentEntity ? 'selected' : ''}>${this._hass.states[entity]?.attributes.friendly_name || entity}</option>`).join('');
        projectSelectorHtml = `<div class="controls"><select id="project-selector">${options}</select></div>`;
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
        .header-top { display: flex; justify-content: space-between; align-items: center; }
        .header-title { font-weight: bold; font-size: 1.2rem; margin: 0; }
        .refresh-btn { background: none; border: none; color: inherit; cursor: pointer; opacity: 0.8; transition: transform 0.5s; padding: 0; }
        .refresh-btn:hover { opacity: 1; }
        .refresh-btn.spinning { transform: rotate(360deg); }
        .controls { display: flex; gap: 8px; flex-wrap: wrap;}
        select { flex-grow: 1; padding: 8px; border-radius: 6px; border: none; background: rgba(255,255,255,0.9); color: #333; font-family: inherit; cursor: pointer; }
        .filter-btn { flex: 1; min-width: 50px; padding: 6px 4px; border: none; border-radius: 15px; background: rgba(255,255,255,0.2); color: white; cursor: pointer; font-size: 0.8rem; transition: all 0.2s; white-space: nowrap; }
        .filter-btn.active { background: white; color: #333; font-weight: 700; box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
        .task-list { padding: 0; margin: 0; list-style: none; min-height: 50px; overflow-y: auto; max-height: 400px; }
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
        .task-actions { margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
        .delete-btn { background: none; border: none; cursor: pointer; color: var(--secondary-text-color); opacity: 0.3; padding: 5px; font-size: 1.4rem; transition: all 0.2s; }
        .task-item:hover .delete-btn { opacity: 1; }
        .delete-btn:hover { color: var(--error-color, red); transform: scale(1.1); }
        input[type=checkbox] { margin-top: 4px; appearance: none; -webkit-appearance: none; width: 22px; height: 22px; border: 2px solid ${headerColor || 'var(--primary-color)'}; border-radius: 50%; outline: none; cursor: pointer; position: relative; flex-shrink: 0; }
        input[type=checkbox]:checked { background-color: ${headerColor || 'var(--primary-color)'}; }
        input[type=checkbox]:checked::after { content: ''; position: absolute; left: 6px; top: 2px; width: 5px; height: 10px; border: solid white; border-width: 0 2px 2px 0; transform: rotate(45deg); }
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
                <div class="header-title">${this.config.title || 'Opgaver'}</div>
                <button class="refresh-btn" title="Refresh">
                    <svg style="width:24px;height:24px" viewBox="0 0 24 24">
                        <path fill="currentColor" d="M17.65,6.35C16.2,4.9 14.21,4 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20C15.73,20 18.84,17.45 19.73,14H17.65C16.83,16.33 14.61,18 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6C13.66,6 15.14,6.69 16.22,7.78L13,11H20V4L17.65,6.35Z" />
                    </svg>
                </button>
            </div>
            ${projectSelectorHtml}
            <div class="controls">${filterButtonsHtml}</div>
        </div>
        ` : ''}
        <ul class="task-list">
          ${taskListHtml}
        </ul>
        ${!hideAddTask ? `
        <div class="add-task-wrapper"><input type="text" id="new-task-input" class="add-task-input" placeholder="${this.localize('add_task')}"><button id="add-task-btn" class="add-btn">+</button></div>
        ` : ''}
      </ha-card>
    `;

    this.shadowRoot.innerHTML = style;
    this.addEventListeners();
  }

  addEventListeners() {
    const select = this.shadowRoot.getElementById('project-selector'); if (select) select.addEventListener('change', (e) => { this.currentEntity = e.target.value; this.fetchTasks(); });
    const refreshBtn = this.shadowRoot.querySelector('.refresh-btn'); if (refreshBtn) refreshBtn.addEventListener('click', () => this.fetchTasks());
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
customElements.define('todoist-task-flow', TodoistTaskFlow);

// --- EDITOR KLASSE ---
class TodoistTaskFlowEditor extends HTMLElement {
  set hass(hass) { this._hass = hass; if (this._config) this.render(); }
  setConfig(config) { this._config = config; this.render(); }
  configChanged(newConfig) { const event = new CustomEvent("config-changed", { detail: { config: newConfig }, bubbles: true, composed: true, }); this.dispatchEvent(event); }

  render() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const { title, default_filter, show_completed, header_color, compact_view, enabled_filters, theme, background_color, background_opacity, text_color, bubble_color, bubble_opacity, use_gamification, visual_effect, sound_effect, show_project_tag, hide_header, hide_add_task, max_items, font_scale, sort_order } = this._config;
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

    this.shadowRoot.innerHTML = `
      <style>
        .row { display: flex; flex-direction: column; margin-bottom: 15px; }
        .row-checkbox { display: flex; flex-direction: row; align-items: center; gap: 10px; margin-bottom: 5px; }
        .row-checkbox label { margin: 0; font-weight: normal; } 
        label { font-weight: bold; margin-bottom: 5px; display: block; color: var(--primary-text-color); }
        input[type="text"], input[type="color"], input[type="number"], select, input[type="range"] { padding: 8px; width: 95%; border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color, white); color: var(--primary-text-color); border-radius: 4px; }
        input[type="color"] { width: 100%; height: 40px; padding: 2px; }
        .help { font-size: 0.8em; color: var(--secondary-text-color); margin-top: 4px; }
        .filter-list { border: 1px solid var(--divider-color, #ccc); padding: 10px; border-radius: 4px; max-height: 200px; overflow-y: auto; background: rgba(0,0,0,0.03); }
        .section-header { font-weight: bold; font-size: 1.1em; margin-top: 20px; margin-bottom: 10px; border-bottom: 1px solid var(--divider-color, #ccc); padding-bottom: 5px; }
      </style>
      <div class="row"><label>${s.title}</label><input type="text" id="title-input" value="${title}"></div>
      
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
      <div class="row"><label>${s.select_lists}</label><div class="filter-list">${allTodoEntities.length === 0 ? `<div style="padding:5px;">${s.no_lists}</div>` : ''}${allTodoEntities.map(eid => `<div class="row-checkbox"><input type="checkbox" class="entity-checkbox" value="${eid}" ${currentEntities.includes(eid)?'checked':''}><label>${this._hass.states[eid].attributes.friendly_name || eid}</label></div>`).join('')}</div><div class="help">${s.lists_help}</div></div>
      
      <div class="row"><label>${s.sort_order}</label><select id="sort-order-input">${sortOptions.map(o => `<option value="${o.id}" ${(sort_order||'date')===o.id?'selected':''}>${o.label}</option>`).join('')}</select></div>
      
      <div class="row"><label>${s.max_items}</label><input type="number" id="max-items-input" min="0" value="${max_items !== undefined ? max_items : 0}"></div>

      <div class="row"><label>${s.active_filters}</label><div class="filter-list">${availableFilters.map(f => `<div class="row-checkbox"><input type="checkbox" class="filter-checkbox" value="${f.id}" ${(enabled_filters||['all','today','overdue']).includes(f.id)?'checked':''}><label>${f.label}</label></div>`).join('')}</div></div>
      <div class="row"><label>${s.start_filter}</label><select id="filter-input">${availableFilters.map(f => `<option value="${f.id}" ${(default_filter||'all')===f.id?'selected':''}>${f.label}</option>`).join('')}</select></div>
      
      <div class="row row-checkbox"><input type="checkbox" id="hide-header-input" ${hide_header?'checked':''}><label>${s.hide_header}</label></div>
      <div class="row row-checkbox"><input type="checkbox" id="hide-add-task-input" ${hide_add_task?'checked':''}><label>${s.hide_add_task}</label></div>
      <div class="row row-checkbox"><input type="checkbox" id="show-project-tag-input" ${show_project_tag?'checked':''}><label>${s.show_project_tag}</label></div>
      <div class="row row-checkbox"><input type="checkbox" id="completed-input" ${show_completed?'checked':''}><label>${s.show_completed}</label></div>
      <div class="row row-checkbox"><input type="checkbox" id="compact-input" ${compact_view?'checked':''}><label>${s.compact_view}</label></div>
    `;

    const getChecked = (sel) => Array.from(this.shadowRoot.querySelectorAll(sel)).filter(b=>b.checked).map(b=>b.value);
    
    this.shadowRoot.getElementById("title-input").addEventListener("change", (e) => this.configChanged({ ...this._config, title: e.target.value }));
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

    this.shadowRoot.querySelectorAll(".entity-checkbox").forEach(b => b.onchange = () => this.configChanged({ ...this._config, entities: getChecked(".entity-checkbox") }));
    this.shadowRoot.querySelectorAll(".filter-checkbox").forEach(b => b.onchange = () => this.configChanged({ ...this._config, enabled_filters: getChecked(".filter-checkbox") }));
    this.shadowRoot.getElementById("filter-input").onchange = (e) => this.configChanged({ ...this._config, default_filter: e.target.value });
    this.shadowRoot.getElementById("show-project-tag-input").onchange = (e) => this.configChanged({ ...this._config, show_project_tag: e.target.checked });
    this.shadowRoot.getElementById("hide-header-input").onchange = (e) => this.configChanged({ ...this._config, hide_header: e.target.checked });
    this.shadowRoot.getElementById("hide-add-task-input").onchange = (e) => this.configChanged({ ...this._config, hide_add_task: e.target.checked });
    this.shadowRoot.getElementById("completed-input").onchange = (e) => this.configChanged({ ...this._config, show_completed: e.target.checked });
    this.shadowRoot.getElementById("compact-input").onchange = (e) => this.configChanged({ ...this._config, compact_view: e.target.checked });
  }
}
customElements.define("todoist-task-flow-editor", TodoistTaskFlowEditor);

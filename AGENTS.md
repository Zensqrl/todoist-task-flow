# Agents

## Project Overview

Home Assistant custom Lovelace card for displaying Todoist tasks. Single-file vanilla JavaScript Web Component distributed via [HACS](https://hacs.xyz/).

## Architecture

- **Single file:** All logic lives in `todoist-task-flow.js` (~830 lines)
- **Two custom elements:** `TodoistTaskFlow` (card) and `TodoistTaskFlowEditor` (visual config editor)
- **Shadow DOM** for style isolation
- **No build system** — the JS file is served directly to Home Assistant

## Home Assistant Integration

- Tasks fetched via WebSocket: `this._hass.callWS({ type: "todo/item/list", entity_id })`
- Task mutations via services: `this._hass.callService("todo", "update_item"|"remove_item"|"add_item", payload)`
- Card lifecycle: `setConfig(config)` → `set hass(hass)` → `render()`
- Editor communicates config changes via `CustomEvent("config-changed")`

## Conventions

- Localization: `localize(key)` method with inline `da`/`en` translation objects
- All rendering is string-based HTML assigned to `shadowRoot.innerHTML`, then event listeners re-attached via `addEventListeners()`
- Config options are defined in `getStubConfig()` — keep this in sync when adding new options
- No external dependencies or imports

## Key Patterns

- When adding a new config option: update `getStubConfig()`, handle it in `render()`, add editor UI in `TodoistTaskFlowEditor.render()`, and add translations for both `da` and `en`
- Themes are CSS class-based (`.theme-standard`, `.theme-minimalist`, `.theme-frosted`, `.theme-bubble`)
- Gamification effects (confetti, emoji, sounds) use Web Audio API and DOM animation

## Distribution

- `hacs.json` defines HACS metadata
- Card is registered via `window.customCards.push(...)` at the end of the file

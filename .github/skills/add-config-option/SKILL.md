---
name: add-config-option
description: "Add a new configuration option to the Todoist Task Flow card. Use when adding a setting, toggle, selector, or any user-configurable property to the card."
argument-hint: "option name and type (e.g. 'show_due_time boolean')"
---

# Add Config Option

Add a new user-configurable option to the card. All touchpoints live in `todoist-task-flow.js`.

## Argument

Expect: option name (snake_case) and type (boolean, string, number, select). If not provided, ask the user.

## Procedure

### 1. Add default to `getStubConfig()`

Insert the new property with its default value in the static config object (~line 5–30).

### 2. Add translations

Two separate translation objects must be updated:

- **Card translations** — inside `localize()` method. Add a key/value for both `da` and `en` if the option produces user-visible text in the card UI.
- **Editor translations** — inside `TodoistTaskFlowEditor.render()`, in the `const t = { da: {...}, en: {...} }` block. Add a label (and help text if needed) for the editor UI.

### 3. Use the option in `TodoistTaskFlow.render()`

Read the value from `this.config.<option_name>` near the top of `render()` alongside existing config reads, then apply it in the HTML/CSS output.

### 4. Add editor UI in `TodoistTaskFlowEditor.render()`

Add an appropriate input control based on type:

| Type | HTML element | Pattern |
|------|-------------|---------|
| boolean | `<input type="checkbox">` | Wrap in `.row-checkbox` div |
| string (color) | `<input type="color">` + reset button | Follow `header_color` pattern |
| number | `<input type="number">` or `<input type="range">` | Follow `max_items` / `font_scale` pattern |
| select | `<select>` with mapped options | Follow `theme` / `sort_order` pattern |

### 5. Wire up editor event listener

At the bottom of `TodoistTaskFlowEditor.render()`, add an event listener that calls `this.configChanged({ ...this._config, <option_name>: <value> })`.

### 6. Conditional visibility (if applicable)

If the option only makes sense under certain conditions (e.g., bubble color only for bubble theme), wrap the editor HTML in a conditional check, following the `showHeaderColor` / `showBubbleSettings` pattern.

## Checklist

- [ ] Default in `getStubConfig()`
- [ ] Editor label translations (`da` + `en`) in editor's `t` object
- [ ] Card translations in `localize()` (only if option produces card-visible text)
- [ ] Config read in `TodoistTaskFlow.render()`
- [ ] Config applied in HTML/CSS output
- [ ] Editor input element rendered
- [ ] Editor event listener wired to `configChanged()`
- [ ] Conditional visibility if option depends on another setting

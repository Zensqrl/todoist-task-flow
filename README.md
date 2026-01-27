![Todoist Task Flow Screenshot](screenshot.png)

# Todoist Task Flow for Home Assistant

An advanced, yet easy-to-use card for Home Assistant that displays your Todoist tasks. It is designed to look and feel like a "native" app directly in your dashboard.

## 🚀 Why this card? (The New Architecture)

This card is built specifically for Home Assistant's modern **`todoist` integration**.

Many older Todoist cards rely on:

* **Deprecated methods:** Reading task lists from sensor attributes (which bloats your database).

* **Calendar integration:** Which isn't designed for task management.

* **Iframes:** Embedding the entire Todoist website, which is heavy and slow on mobile.

**Todoist Task Flow** communicates directly with the official integration via efficient WebSocket calls. This means:

* **⚡️ Fast & Lightweight:** No attributes cluttering your state machine.

* **🔒 Secure:** Uses standard Home Assistant services (`todo.add_item`, `todo.update_item`).

* **🔮 Future-proof (hopefully):** Aligned with Home Assistant's long-term architecture for task lists.

## ✨ Features

* **🎨 Multiple Themes:** Choose between *Standard*, *Minimalist*, *Frosted Glass*, and *Bubble Card* designs.

* **🛠️ Customization:** Hide header, hide "add task", change colors, adjust font size, and much more directly in the visual editor.

* **🎮 Gamification:** Make chores fun with optional sound effects and confetti animations upon completion.

* **📅 Smart Dates:** Displays dates naturally like "Today", "Tomorrow", or "On Monday" instead of raw dates.

* **⚡️ Live Updates:** The card updates automatically and remembers your scroll position.

* **📱 Mobile Friendly:** Special "Compact View" and collapsible sections for small screens.

* **🗒️ Project tags:** Allows for multiple lists in the same overview, without needing vertical stacks.

## 📥 Installation

### Option 1: HACS (Recommended)

1. Go to HACS -> Frontend.

2. Click the menu in the top right corner -> **Custom repositories**.

3. Paste the URL of this GitHub repository.

4. Select category: **Lovelace**.

5. Click **Add** and then **Download**.

### Option 2: Manual

1. Download the `todoist-task-flow.js` file.

2. Upload it to your `/config/www/` folder in Home Assistant.

3. Go to Settings -> Dashboards -> Resources.

4. Add the resource: `/local/todoist-task-flow.js` as **JavaScript Module**.

## ⚙️ Configuration

The card is 100% configurable via the **visual editor** in Home Assistant. No YAML required!

If you prefer YAML, a typical configuration looks like this:

| Customizations  |
| :---: | :---: |
| ![Editor Config 1](screenshot1.png) ![Editor Config 2](screenshot2.png) | ![Editor Config 2](screenshot2.png) |

```yaml
type: custom:todoist-task-flow
title: My Tasks
entities:
  - todo.groceries
  - todo.work
theme: bubble
header_color: "#4caf50"
show_completed: false
default_filter: today
use_gamification: true
visual_effect: confetti
sound_effect: ding
```
## 🧩 Filtering & Sorting
You can choose which filter buttons to show:

* **All:** Shows everything in the lists.

* **Today:** Tasks due today.

* **Overdue:** Tasks you missed.

* **Now:** A combination of "Today" and "Overdue".

* **Week/Month:** Overview of the future.

## ♥️ Credit
Credits to my wife for pushing me to come up with a solution for our HA dashboard, that shows our todoist tasks correctly, and for helping me with features.
The card is made with a huge focus on WAF (Wife Acceptance Focus) and my ADHD brain (Possibility for gamification, limited tasks etc.)







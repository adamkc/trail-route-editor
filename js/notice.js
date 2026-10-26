/**
 * notice.js — Dismissible message bars over the top of the map.
 *
 * Notice.show(id, message, { level, actions, timeout })
 *   level:   'info' | 'warn' | 'error'
 *   actions: [{ label, onClick }] — clicking an action also dismisses the notice
 *   timeout: ms before auto-dismiss (0 = stays until dismissed)
 * Showing an id that is already visible replaces it.
 */
const Notice = (() => {
  const timers = new Map();

  function area() { return document.getElementById('notice-area'); }

  function show(id, message, opts = {}) {
    const { level = 'info', actions = [], timeout = 0 } = opts;
    clear(id);
    const el = document.createElement('div');
    el.className = 'notice notice-' + level;
    el.dataset.noticeId = id;

    const text = document.createElement('div');
    text.className = 'notice-text';
    for (const [i, line] of String(message).split('\n').entries()) {
      if (i > 0) text.appendChild(document.createElement('br'));
      text.appendChild(document.createTextNode(line));
    }
    el.appendChild(text);

    const btns = document.createElement('div');
    btns.className = 'notice-actions';
    for (const a of actions) {
      const b = document.createElement('button');
      b.textContent = a.label;
      b.addEventListener('click', () => { clear(id); a.onClick(); });
      btns.appendChild(b);
    }
    const close = document.createElement('button');
    close.className = 'notice-close';
    close.title = 'Dismiss';
    close.textContent = '×';
    close.addEventListener('click', () => clear(id));
    btns.appendChild(close);
    el.appendChild(btns);

    area().appendChild(el);
    if (timeout > 0) timers.set(id, setTimeout(() => clear(id), timeout));
    return el;
  }

  function clear(id) {
    const a = area();
    if (!a) return;
    const el = a.querySelector(`[data-notice-id="${CSS.escape(id)}"]`);
    if (el) el.remove();
    if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
  }

  return { show, clear };
})();

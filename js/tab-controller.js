/**
 * tab-controller.js — Manages the tabbed bottom panel
 */
const TabController = (() => {
  let activeTab = 'elevation';
  const resizeCallbacks = {};

  function init() {
    const buttons = document.querySelectorAll('.tab-btn');
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('disabled')) return;
        switchTo(btn.dataset.tab);
      });
    });
  }

  function switchTo(tabName) {
    if (!tabName) return;
    activeTab = tabName;

    // Update button states
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Show/hide panes
    document.querySelectorAll('.tab-pane').forEach(pane => {
      pane.classList.toggle('hidden', pane.id !== 'tab-' + tabName);
    });

    // Resize charts when they become visible
    if (resizeCallbacks[tabName]) {
      // Small delay to let the DOM update before resizing
      setTimeout(() => resizeCallbacks[tabName](), 50);
    }
  }

  function registerResize(tabName, callback) {
    resizeCallbacks[tabName] = callback;
  }

  function setTabEnabled(tabName, enabled) {
    const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    if (btn) {
      btn.classList.toggle('disabled', !enabled);
    }
  }

  function getActiveTab() {
    return activeTab;
  }

  return { init, switchTo, registerResize, setTabEnabled, getActiveTab };
})();

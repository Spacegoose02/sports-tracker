// Accessibility helpers and the Display settings panel. Loaded with `defer`
// on every page, after i18n.js. Like i18n.js it works on the rendered page,
// so the page scripts don't each need changes:
//
//   - a "Skip to main content" link as the first tab stop
//   - a Display button in the header (language, motion, contrast)
//   - clickable cards (game cards, upcoming games, betting lines, video
//     thumbnails) get a tab stop and open with Enter or Space
//   - toggle buttons that show their state with an "active" class also
//     get aria-pressed, so screen readers hear which tab is on
//   - icon-only live markers get a text label
//   - on a game page, score changes are announced once in a polite live
//     region instead of the whole scorebug being re-read every refresh
(function () {
  var I18n = window.I18n || { t: function (s) { return s; }, lang: 'en', prefs: null, setLang: function () {} };
  var t = I18n.t;
  var root = document.documentElement;

  // ---- Skip link ------------------------------------------------------------
  function addSkipLink() {
    var main = document.querySelector('main');
    if (!main || document.querySelector('.skip-link')) return;
    if (!main.id) main.id = 'main';
    if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
    var a = document.createElement('a');
    a.className = 'skip-link';
    a.href = '#' + main.id;
    a.textContent = t('Skip to main content');
    a.addEventListener('click', function (e) {
      e.preventDefault();
      main.focus();
      main.scrollIntoView();
    });
    document.body.insertBefore(a, document.body.firstChild);
  }

  // ---- Live announcer -------------------------------------------------------
  var announcer = null;
  function announce(text) {
    if (!announcer) {
      announcer = document.createElement('div');
      announcer.className = 'sr-only';
      announcer.setAttribute('role', 'status');
      announcer.setAttribute('aria-live', 'polite');
      announcer.setAttribute('aria-atomic', 'true');
      document.body.appendChild(announcer);
    }
    announcer.textContent = '';
    // A fresh node after a tick makes screen readers read repeats too.
    setTimeout(function () { announcer.textContent = text; }, 50);
  }

  // ---- Clickable cards ------------------------------------------------------
  var CARD_SELECTOR = '.game-card[data-id], .upcoming-game, .line-card, .video-thumb-wrap';
  var TOGGLE_SELECTOR = '.tab-btn, .box-tab, .division-toggle button, .sport-tab, .filter-btn, .chip-btn, .poll-btn';

  function enhanceCard(card) {
    if (card.dataset.a11y) return;
    card.dataset.a11y = '1';
    if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '0');
    var nested = card.querySelector('a[href], button, input, select');
    if (card.classList.contains('video-thumb-wrap')) {
      card.setAttribute('role', 'button');
      if (!card.hasAttribute('aria-label')) {
        var title = card.closest('.video-card') && card.closest('.video-card').querySelector('.video-title, h3, h4');
        card.setAttribute('aria-label', t('Play video') + (title ? ': ' + title.textContent.trim() : ''));
      }
    } else if (!nested) {
      card.setAttribute('role', 'link');
    }
  }

  function onCardKey(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var card = e.target;
    if (!card.matches || !card.matches(CARD_SELECTOR)) return;
    e.preventDefault();
    card.click();
  }

  function syncToggle(btn) {
    if (btn.tagName !== 'BUTTON' || btn.hasAttribute('aria-selected') || btn.getAttribute('role') === 'radio') return;
    var on = btn.classList.contains('active');
    if (btn.getAttribute('aria-pressed') !== String(on)) btn.setAttribute('aria-pressed', String(on));
  }

  function labelIcons(scope) {
    scope.querySelectorAll('.live-dot').forEach(function (dot) {
      if (/^\s*●\s*$/.test(dot.textContent) && !dot.hasAttribute('aria-label')) {
        dot.setAttribute('role', 'img');
        dot.setAttribute('aria-label', t(dot.getAttribute('title') || 'Live'));
      }
    });
    scope.querySelectorAll('.possession-icon[title], .card-tv[title] , .tv-badge[title]').forEach(function (icon) {
      if (icon.classList.contains('possession-icon') && !icon.hasAttribute('aria-label')) {
        icon.setAttribute('role', 'img');
        icon.setAttribute('aria-label', icon.getAttribute('title'));
      }
    });
    scope.querySelectorAll('img:not([alt])').forEach(function (img) { img.setAttribute('alt', ''); });
  }

  function enhance(scope) {
    if (!scope || scope.nodeType !== 1) return;
    if (scope.matches(CARD_SELECTOR)) enhanceCard(scope);
    scope.querySelectorAll(CARD_SELECTOR).forEach(enhanceCard);
    if (scope.matches(TOGGLE_SELECTOR)) syncToggle(scope);
    scope.querySelectorAll(TOGGLE_SELECTOR).forEach(syncToggle);
    labelIcons(scope);
  }

  // ---- Game page score announcements ----------------------------------------
  var lastScore = null;
  function checkScore() {
    var bug = document.getElementById('gameScorebug');
    if (!bug) return;
    var sides = bug.querySelectorAll('.game-side');
    if (sides.length < 2) return;
    var parts = [];
    sides.forEach(function (side) {
      var name = side.querySelector('.team-name');
      var score = side.querySelector('.game-side-score');
      if (name && score && score.textContent.trim()) parts.push(name.textContent.trim() + ' ' + score.textContent.trim());
    });
    if (!parts.length) return;
    var text = parts.join(', ');
    if (lastScore !== null && text !== lastScore) announce(t('Score update') + ': ' + text);
    lastScore = text;
  }

  function watch() {
    var bug = document.getElementById('gameScorebug');
    if (bug) {
      // The scorebug is re-rendered every refresh; the announcer above says
      // what changed, so keep screen readers from re-reading the whole block.
      bug.setAttribute('aria-live', 'off');
      checkScore();
    }
    if (!window.MutationObserver) return;
    var pending = false;
    new MutationObserver(function (records) {
      records.forEach(function (r) {
        if (r.type === 'attributes') syncToggle(r.target);
        else r.addedNodes.forEach(function (n) { if (n.nodeType === 1) enhance(n); });
      });
      if (bug && !pending) {
        pending = true;
        setTimeout(function () { pending = false; checkScore(); }, 100);
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  // ---- Display settings panel -------------------------------------------------
  var button = null;
  var panel = null;

  function segHtml(name, label, options, current) {
    return '<fieldset class="display-group"><legend>' + label + '</legend><div class="mode-switch">' +
      options.map(function (o) {
        return '<button type="button" data-pref="' + name + '" data-value="' + o[0] + '" aria-pressed="' + (current === o[0]) + '"' +
          (o[2] ? ' lang="' + o[2] + '"' : '') + '>' + o[1] + '</button>';
      }).join('') + '</div></fieldset>';
  }

  function render() {
    var p = I18n.prefs ? I18n.prefs.get() : { lang: I18n.lang, motion: 'auto', contrast: 'auto' };
    panel.innerHTML =
      '<div class="panel-head"><strong id="displayPanelTitle">' + t('Language and accessibility') + '</strong>' +
      '<button type="button" class="panel-close" aria-label="' + t('Close') + '">&times;</button></div>' +
      // Language names stay in their own language so either reader can find theirs.
      segHtml('lang', t('Language') + (I18n.lang === 'en' ? ' / Idioma' : ' / Language'), [['en', 'English', 'en'], ['es', 'Español', 'es']], p.lang) +
      segHtml('motion', t('Motion'), [['auto', t('Follow my device')], ['reduce', t('Reduce')], ['full', t('Full')]], p.motion) +
      '<p class="display-note">' + t('Reduce motion turns off confetti, pulsing live dots and other animations.') + '</p>' +
      segHtml('contrast', t('Contrast'), [['auto', t('Follow my device')], ['standard', t('Standard')], ['more', t('High')]], p.contrast) +
      '<p class="display-note">' + t('High contrast makes muted text and borders stronger.') + '</p>';
    panel.querySelector('.panel-close').addEventListener('click', function () { close(true); });
    panel.querySelectorAll('[data-pref]').forEach(function (b) {
      b.addEventListener('click', function () {
        var name = b.dataset.pref;
        var value = b.dataset.value;
        if (name === 'lang') { I18n.setLang(value); return; }
        if (I18n.prefs) I18n.prefs.set(name, value);
        render();
        var again = panel.querySelector('[data-pref="' + name + '"][data-value="' + value + '"]');
        if (again) again.focus();
      });
    });
  }

  function onKey(e) {
    if (e.key === 'Escape') { close(true); return; }
    if (e.key !== 'Tab' || !panel) return;
    // Keep Tab inside the panel while it's open.
    var items = panel.querySelectorAll('button');
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function onOutside(e) {
    if (!e.target.isConnected) return;
    if (panel && !panel.contains(e.target) && !button.contains(e.target)) close(false);
  }

  function open() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'displayPanel';
    panel.className = 'theme-panel display-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'displayPanelTitle');
    render();
    document.body.appendChild(panel);
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', onKey);
    setTimeout(function () { document.addEventListener('click', onOutside); }, 0);
    var current = panel.querySelector('[aria-pressed="true"]') || panel.querySelector('button');
    if (current) current.focus();
  }

  function close(returnFocus) {
    if (!panel) return;
    panel.remove();
    panel = null;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('click', onOutside);
    if (returnFocus) button.focus();
  }

  function addButton() {
    var header = document.querySelector('header.top');
    if (!header || document.querySelector('.display-toggle')) return;
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-toggle display-toggle';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'displayPanel');
    button.setAttribute('aria-label', t('Language and accessibility'));
    button.title = t('Language and accessibility');
    button.innerHTML = '<span aria-hidden="true" class="display-icon">Aa</span><span class="toggle-label">' +
      (I18n.lang === 'es' ? 'ES' : 'EN') + '</span>';
    button.addEventListener('click', function () { panel ? close(true) : open(); });
    var nav = header.querySelector('nav.top-nav');
    (nav || header).appendChild(button);
  }

  function init() {
    addSkipLink();
    addButton();
    enhance(document.body);
    document.addEventListener('keydown', onCardKey);
    watch();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

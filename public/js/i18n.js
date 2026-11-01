// Language and display preferences. Loaded as a plain (non-deferred) script
// in every page's <head>, right after theme-boot.js, so <html lang> and the
// motion / contrast attributes are set before the first paint.
//
// Translation works on the rendered page rather than in every script: the
// English UI strings are the keys of a dictionary (js/i18n-es.js), and a
// MutationObserver swaps any text node or label attribute that exactly
// matches a key, including ones other scripts render later. Text that isn't
// in the dictionary (team names, headlines, Scrappy's replies) is left alone.
// So new UI text needs no code change to stay working; it just shows in
// English until it's added to the dictionary.
//
// <html> attributes set here:
//   lang           "en" or "es"
//   data-motion    "reduce" or "full" when the visitor overrides the OS
//                  setting (absent = follow prefers-reduced-motion)
//   data-contrast  "more" or "standard" when the visitor overrides the OS
//                  setting (absent = follow prefers-contrast)
//
// window.I18n:
//   I18n.lang                     -> "en" | "es"
//   I18n.t(text)                  -> translated text (or text unchanged)
//   I18n.setLang('en' | 'es')     -> saves and reloads the page
//   I18n.register(lang, dict, patterns)
//   I18n.prefs.get() / .set(name, value)   name: 'motion' | 'contrast'
//   I18n.reducedMotion()          -> true when animations should be skipped
(function () {
  var LANG_KEY = 'tracker-lang';
  var MOTION_KEY = 'tracker-motion';
  var CONTRAST_KEY = 'tracker-contrast';
  var SUPPORTED = ['en', 'es'];
  var root = document.documentElement;

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function write(key, value) {
    try {
      if (value === null || value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* private mode */ }
  }

  function detectLang() {
    var fromUrl = null;
    try { fromUrl = new URLSearchParams(location.search).get('lang'); } catch (e) { /* old browser */ }
    if (fromUrl && SUPPORTED.indexOf(fromUrl) !== -1) { write(LANG_KEY, fromUrl); return fromUrl; }
    var saved = read(LANG_KEY);
    if (saved && SUPPORTED.indexOf(saved) !== -1) return saved;
    var nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'en';
    return /^es\b/i.test(nav) ? 'es' : 'en';
  }

  var lang = detectLang();
  root.lang = lang;

  function applyPrefs() {
    var motion = read(MOTION_KEY);
    var contrast = read(CONTRAST_KEY);
    if (motion === 'reduce' || motion === 'full') root.setAttribute('data-motion', motion);
    else root.removeAttribute('data-motion');
    if (contrast === 'more' || contrast === 'standard') root.setAttribute('data-contrast', contrast);
    else root.removeAttribute('data-contrast');
  }
  applyPrefs();

  var prefListeners = [];
  var prefs = {
    get: function () {
      return { lang: lang, motion: read(MOTION_KEY) || 'auto', contrast: read(CONTRAST_KEY) || 'auto' };
    },
    set: function (name, value) {
      var key = name === 'motion' ? MOTION_KEY : name === 'contrast' ? CONTRAST_KEY : null;
      if (!key) return;
      write(key, value === 'auto' ? null : value);
      applyPrefs();
      prefListeners.forEach(function (fn) { try { fn(prefs.get()); } catch (e) { /* ignore */ } });
    },
    onChange: function (fn) { prefListeners.push(fn); },
  };

  function reducedMotion() {
    var m = root.getAttribute('data-motion');
    if (m === 'reduce') return true;
    if (m === 'full') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // ---- Dictionary --------------------------------------------------------
  var dicts = {};     // lang -> { english: translated }
  var patterns = {};  // lang -> [[RegExp, replacement | fn(match, t)]]

  function register(code, dict, pats) {
    dicts[code] = Object.assign(dicts[code] || {}, dict || {});
    patterns[code] = (patterns[code] || []).concat(pats || []);
    if (code === lang && started) translateTree(document.documentElement);
  }

  // Translate one string. Whitespace around it is kept; " · " separated
  // parts ("NFL · 2026 · Week 9") are translated one by one.
  function t(text) {
    if (lang === 'en' || text === null || text === undefined) return text;
    var str = String(text);
    var trimmed = str.trim();
    if (!trimmed) return str;
    var out = lookup(trimmed);
    if (out === null && trimmed.indexOf(' · ') !== -1) {
      var parts = trimmed.split(' · ');
      var changed = false;
      parts = parts.map(function (p) { var r = lookup(p); if (r !== null) { changed = true; return r; } return p; });
      if (changed) out = parts.join(' · ');
    }
    if (out === null) return str;
    var lead = str.match(/^\s*/)[0];
    var trail = str.match(/\s*$/)[0];
    return lead + out + trail;
  }

  function lookup(s) {
    var dict = dicts[lang];
    if (!dict) return null;
    if (Object.prototype.hasOwnProperty.call(dict, s)) return dict[s];
    var pats = patterns[lang] || [];
    for (var i = 0; i < pats.length; i++) {
      var m = s.match(pats[i][0]);
      if (m) {
        var rep = pats[i][1];
        return typeof rep === 'function' ? rep(m, function (x) { return lookup(x) || x; }) : s.replace(pats[i][0], rep);
      }
    }
    // An icon in front ("🎯 Pick'em", "📺 TV channel") or a colon after
    // ("Biggest rise:") shouldn't stop a known label from translating.
    var deco = s.match(/^([^A-Za-z0-9¿¡"'(]+)(.+)$/) || s.match(/^(.+?)(:)$/);
    if (deco) {
      var iconFirst = !/[A-Za-z]/.test(deco[1]);
      var inner = lookup(iconFirst ? deco[2] : deco[1]);
      if (inner !== null) return iconFirst ? deco[1] + inner : inner + deco[2];
    }
    return null;
  }

  // ---- DOM translation ---------------------------------------------------
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'aria-description', 'data-tooltip'];
  var SKIP = { SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, TEXTAREA: 1, NOSCRIPT: 1 };
  var started = false;

  function skipped(node) {
    for (var el = node.nodeType === 1 ? node : node.parentNode; el && el.nodeType === 1; el = el.parentNode) {
      if (SKIP[el.tagName] || el.getAttribute('translate') === 'no' || el.isContentEditable) return true;
    }
    return false;
  }

  function translateText(node) {
    var v = node.nodeValue;
    if (!v || !/[A-Za-z]/.test(v)) return;
    var out = t(v);
    if (out !== v && !skipped(node)) node.nodeValue = out;
  }

  function translateAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute(ATTRS[i]);
      if (v) {
        var out = t(v);
        if (out !== v) el.setAttribute(ATTRS[i], out);
      }
    }
    if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit') && el.value) {
      var val = t(el.value);
      if (val !== el.value) el.value = val;
    }
  }

  function translateTree(start) {
    if (lang === 'en' || !dicts[lang]) return;
    if (start.nodeType === 3) { translateText(start); return; }
    if (start.nodeType !== 1 || skipped(start)) return;
    translateAttrs(start);
    var walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.nodeType === 1 && (SKIP[n.tagName] || n.getAttribute('translate') === 'no')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) translateText(n);
      else translateAttrs(n);
    }
  }

  function start() {
    if (started || lang === 'en') return;
    started = true;
    translateTree(document.documentElement);
    if (!window.MutationObserver) return;
    var obs = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'characterData') translateText(r.target);
        else if (r.type === 'attributes') { if (!skipped(r.target)) translateAttrs(r.target); }
        else for (var j = 0; j < r.addedNodes.length; j++) translateTree(r.addedNodes[j]);
      }
    });
    obs.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS,
    });
  }

  function setLang(code) {
    if (SUPPORTED.indexOf(code) === -1 || code === lang) return;
    write(LANG_KEY, code);
    // Drop ?lang= so the saved choice wins on reload.
    try {
      var url = new URL(location.href);
      url.searchParams.delete('lang');
      location.replace(url.toString());
    } catch (e) { location.reload(); }
  }

  window.I18n = {
    lang: lang,
    supported: SUPPORTED.slice(),
    t: t,
    setLang: setLang,
    register: register,
    prefs: prefs,
    reducedMotion: reducedMotion,
    // Locale for toLocaleString() calls that want to follow the app language.
    locale: lang === 'es' ? 'es' : undefined,
  };

  // The Spanish dictionary script loads right after this one; it calls
  // register(), which translates what's on the page so far. Start observing
  // now so nothing parsed after this point slips through.
  if (lang !== 'en') start();
})();

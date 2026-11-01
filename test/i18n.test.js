// Spanish language layer (public/js/i18n.js + i18n-es.js) and the
// accessibility files every page should load.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC = path.join(__dirname, '..', 'public');

// Runs i18n.js and the Spanish dictionary in a bare sandbox with just
// enough of a browser for them to start, and returns window.I18n.
function loadI18n({ saved = null, navLang = 'en-US', search = '' } = {}) {
  const store = new Map(saved ? [['tracker-lang', saved]] : []);
  const attrs = {};
  const documentElement = {
    lang: '',
    setAttribute: (k, v) => { attrs[k] = v; },
    removeAttribute: (k) => { delete attrs[k]; },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
  };
  const window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    navigator: { language: navLang, languages: [navLang] },
    location: { search, href: `http://localhost/${search}` },
    document: { documentElement },
    URLSearchParams,
    // No MutationObserver/TreeWalker: only the string API is exercised here.
    matchMedia: () => ({ matches: false }),
  };
  window.window = window;
  const ctx = vm.createContext(window);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'js/i18n.js'), 'utf8'), ctx);
  // translateTree() would need a DOM; the dictionary registers fine without
  // one as long as nothing has started observing.
  window.I18n.register = ((orig) => (code, dict, pats) => {
    window.__dict = dict;
    try { orig(code, dict, pats); } catch (e) { /* no DOM in the sandbox */ }
  })(window.I18n.register);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'js/i18n-es.js'), 'utf8'), ctx);
  return { I18n: window.I18n, root: documentElement, dict: window.__dict };
}

test('language follows ?lang=, then the saved choice, then the browser', () => {
  assert.strictEqual(loadI18n({ navLang: 'es-MX' }).I18n.lang, 'es');
  assert.strictEqual(loadI18n({ navLang: 'en-US' }).I18n.lang, 'en');
  assert.strictEqual(loadI18n({ navLang: 'es-MX', saved: 'en' }).I18n.lang, 'en');
  assert.strictEqual(loadI18n({ saved: 'en', search: '?lang=es' }).I18n.lang, 'es');
  assert.strictEqual(loadI18n({ saved: 'fr' }).I18n.lang, 'en');
  assert.strictEqual(loadI18n({ saved: 'es' }).root.lang, 'es');
});

test('English pages are left alone', () => {
  const { I18n } = loadI18n({ saved: 'en' });
  assert.strictEqual(I18n.t('Standings'), 'Standings');
  assert.strictEqual(I18n.t('Week 4'), 'Week 4');
});

test('Spanish translates labels, patterns, icons and dotted parts', () => {
  const { I18n } = loadI18n({ saved: 'es' });
  const t = I18n.t;
  assert.strictEqual(t('Standings'), 'Posiciones');
  assert.strictEqual(t('  Standings\n'), '  Posiciones\n');
  assert.strictEqual(t('Week 4'), 'Semana 4');
  assert.strictEqual(t('College Football · 2026 · Week 9'), 'Fútbol americano universitario · 2026 · Semana 9');
  assert.strictEqual(t('Rankings · Stat Scraps'), 'Rankings · Stat Scraps');
  assert.strictEqual(t('Leaders · Stat Scraps'), 'Líderes · Stat Scraps');
  assert.strictEqual(t('Final (OT)'), 'Final (OT)');
  assert.strictEqual(t('Playing now! Halftime'), '¡Jugando ahora! Medio tiempo');
  assert.strictEqual(t('⭐ Kids'), '⭐ Niños');
  assert.strictEqual(t('Biggest rise:'), 'Mayor subida:');
  assert.strictEqual(t('5m ago'), 'hace 5 min');
  // Names and headlines aren't in the dictionary and pass through.
  assert.strictEqual(t('Alabama Crimson Tide'), 'Alabama Crimson Tide');
  assert.strictEqual(t('#5 Georgia'), '#5 Georgia');
});

test('every Spanish entry is a non-empty string', () => {
  const { dict } = loadI18n({ saved: 'es' });
  const keys = Object.keys(dict);
  assert.ok(keys.length > 400, `only ${keys.length} entries`);
  for (const k of keys) assert.ok(typeof dict[k] === 'string' && dict[k].trim(), `empty translation for "${k}"`);
});

test('motion and contrast preferences set <html> attributes', () => {
  const { I18n, root } = loadI18n({});
  assert.strictEqual(I18n.reducedMotion(), false);
  I18n.prefs.set('motion', 'reduce');
  assert.strictEqual(root.getAttribute('data-motion'), 'reduce');
  assert.strictEqual(I18n.reducedMotion(), true);
  I18n.prefs.set('motion', 'auto');
  assert.strictEqual(root.getAttribute('data-motion'), null);
  I18n.prefs.set('contrast', 'more');
  assert.strictEqual(root.getAttribute('data-contrast'), 'more');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(I18n.prefs.get())), { lang: 'en', motion: 'auto', contrast: 'more' });
});

test('every page loads the language and accessibility files in order', () => {
  const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length >= 10);
  for (const page of pages) {
    const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
    const boot = html.indexOf('/js/theme-boot.js');
    const i18n = html.indexOf('<script src="/js/i18n.js"></script>');
    const es = html.indexOf('<script src="/js/i18n-es.js"></script>');
    assert.ok(boot !== -1 && i18n > boot && es > i18n, `${page}: i18n.js and i18n-es.js must follow theme-boot.js, not deferred`);
    assert.ok(html.includes('<script src="/js/a11y.js" defer></script>'), `${page}: missing a11y.js`);
    assert.ok(html.indexOf('/css/a11y.css') > html.indexOf('/css/themes.css'), `${page}: a11y.css must load after themes.css`);
  }
});

test('the service worker precaches the new files', () => {
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  for (const f of ['/js/i18n.js', '/js/i18n-es.js', '/js/a11y.js', '/css/a11y.css']) {
    assert.ok(sw.includes(`'${f}'`), `${f} not precached`);
  }
});

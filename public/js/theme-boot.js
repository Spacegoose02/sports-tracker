// Theme bootstrap. Loaded as a plain (non-deferred) script in every page's
// <head>, right after the stylesheets, so the saved theme is on <html>
// before the first paint and there's no flash of the default colors.
//
// Sets three attributes on <html> (see the token notes at the top of
// css/styles.css):
//   data-theme  saved sports theme, default "classic"
//   data-mode   "light" or "dark": the saved choice, or the OS setting
//               when the visitor picked "auto" (the default)
//   data-sport  sport being viewed, from ?sport= or the last one picked
//
// Also exposes window.TrackerTheme for the theme picker and other scripts:
//   TrackerTheme.get()            -> { theme, mode, resolvedMode, sport, team }
//   TrackerTheme.setTheme(name)
//   TrackerTheme.setMode('auto' | 'light' | 'dark')
//   TrackerTheme.setTeam({ name, color, alternateColor, logo } | null)
//   TrackerTheme.onChange(fn)     -> called with get() after any change
(function () {
  var THEME_KEY = 'tracker-theme';
  var MODE_KEY = 'tracker-mode';
  var TEAM_KEY = 'tracker-theme-team';
  var SPORT_KEY = 'tracker-sport';
  var root = document.documentElement;
  var listeners = [];

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function write(key, value) {
    try {
      if (value === null || value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* private mode etc. */ }
  }

  var HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
  var NAME = /^[a-z0-9-]{1,40}$/;

  function readTeam() {
    try {
      var t = JSON.parse(read(TEAM_KEY) || 'null');
      return t && HEX.test(t.color) ? t : null;
    } catch (e) { return null; }
  }

  var dark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  var state = {
    theme: NAME.test(read(THEME_KEY) || '') ? read(THEME_KEY) : 'classic',
    mode: /^(auto|light|dark)$/.test(read(MODE_KEY) || '') ? read(MODE_KEY) : 'auto',
    sport: null,
    team: readTeam(),
  };

  try {
    var fromUrl = new URLSearchParams(location.search).get('sport');
    state.sport = fromUrl || read(SPORT_KEY) || 'cfb';
  } catch (e) {
    state.sport = 'cfb';
  }
  if (!NAME.test(state.sport)) state.sport = 'cfb';

  function resolvedMode() {
    if (state.mode === 'light' || state.mode === 'dark') return state.mode;
    return dark && !dark.matches ? 'light' : 'dark';
  }

  function syncThemeColorMeta() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    var bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    if (bg) meta.setAttribute('content', bg);
  }

  function apply() {
    root.setAttribute('data-theme', state.theme);
    root.setAttribute('data-mode', resolvedMode());
    root.setAttribute('data-sport', state.sport);
    if (state.team) {
      root.style.setProperty('--team-primary', state.team.color);
      root.style.setProperty('--team-secondary', HEX.test(state.team.alternateColor || '') ? state.team.alternateColor : state.team.color);
    } else {
      root.style.removeProperty('--team-primary');
      root.style.removeProperty('--team-secondary');
    }
    syncThemeColorMeta();
  }

  function get() {
    return { theme: state.theme, mode: state.mode, resolvedMode: resolvedMode(), sport: state.sport, team: state.team };
  }

  function changed() {
    apply();
    var snapshot = get();
    listeners.forEach(function (fn) { try { fn(snapshot); } catch (e) { /* keep going */ } });
  }

  apply();
  document.addEventListener('DOMContentLoaded', syncThemeColorMeta);
  if (dark) {
    var onOsChange = function () { if (state.mode === 'auto') changed(); };
    if (dark.addEventListener) dark.addEventListener('change', onOsChange);
    else if (dark.addListener) dark.addListener(onOsChange);
  }

  window.TrackerTheme = {
    get: get,
    setTheme: function (name) {
      if (!NAME.test(name || '')) return;
      state.theme = name;
      write(THEME_KEY, name);
      changed();
    },
    setMode: function (mode) {
      if (!/^(auto|light|dark)$/.test(mode || '')) return;
      state.mode = mode;
      write(MODE_KEY, mode);
      changed();
    },
    setTeam: function (team) {
      state.team = team && HEX.test(team.color) ? {
        id: team.id ? String(team.id) : null,
        sport: team.sport || null,
        name: team.name || null,
        color: team.color,
        alternateColor: team.alternateColor || null,
        logo: team.logo || null,
      } : null;
      write(TEAM_KEY, state.team ? JSON.stringify(state.team) : null);
      changed();
    },
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
  };
})();

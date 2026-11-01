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


  // ---- Team colors -------------------------------------------------------
  // Team colors straight from ESPN are often too dark (navy, maroon) to read
  // as text on a dark page, or too light (gold, white) on a light page. Nudge
  // each one toward white or black until it reaches a readable contrast,
  // and pick black or white text for buttons filled with it.
  var TEAM_PROPS = ['--team-primary', '--team-secondary', '--team-accent-dark', '--team-accent-light',
    '--team-secondary-dark', '--team-secondary-light', '--team-on-accent-dark', '--team-on-accent-light'];

  function toRgb(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function toHex(rgb) {
    return '#' + rgb.map(function (c) { return ('0' + Math.round(c).toString(16)).slice(-2); }).join('');
  }
  function luminance(rgb) {
    var c = rgb.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    var la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function toHsl(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }
  function fromHsl(hsl) {
    var h = hsl[0], s = hsl[1], l = hsl[2];
    if (!s) return [l * 255, l * 255, l * 255];
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    function f(t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
  }
  // Moves lightness (keeping hue and saturation, so crimson stays crimson
  // rather than turning pink-grey) until the color reaches minRatio
  // contrast against bgHex.
  function readableOn(hex, bgHex, minRatio) {
    var bg = toRgb(bgHex), hsl = toHsl(toRgb(hex)), up = luminance(bg) < 0.5;
    for (var i = 0; i < 40 && contrast(fromHsl(hsl), bg) < minRatio; i++) {
      hsl[2] = Math.max(0, Math.min(1, hsl[2] + (up ? 0.02 : -0.02)));
    }
    return toHex(fromHsl(hsl));
  }
  function onColor(hex) {
    var rgb = toRgb(hex);
    return contrast(rgb, [255, 255, 255]) >= contrast(rgb, [10, 10, 12]) ? '#ffffff' : '#0a0a0c';
  }
  function teamVars(primary, alternate) {
    var p = primary;
    var a = HEX.test(alternate || '') ? alternate : primary;
    // A near-white primary (some teams list white first) makes a poor
    // accent; use the alternate instead when it has more color.
    if (luminance(toRgb(p)) > 0.8 && luminance(toRgb(a)) < 0.8) { var t = p; p = a; a = t; }
    var dark = readableOn(p, '#0d0f14', 4.5);
    var light = readableOn(p, '#ffffff', 4.5);
    return {
      '--team-primary': p,
      '--team-secondary': a,
      '--team-accent-dark': dark,
      '--team-accent-light': light,
      '--team-secondary-dark': readableOn(a, '#0d0f14', 3),
      '--team-secondary-light': readableOn(a, '#ffffff', 3),
      '--team-on-accent-dark': onColor(dark),
      '--team-on-accent-light': onColor(light),
    };
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
    TEAM_PROPS.forEach(function (p) { root.style.removeProperty(p); });
    if (state.team) {
      var vars = teamVars(state.team.color, state.team.alternateColor);
      Object.keys(vars).forEach(function (p) { root.style.setProperty(p, vars[p]); });
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

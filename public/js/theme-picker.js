// Theme picker: a "Theme" button in the page header that opens a panel
// with Light / Dark / Auto and the sports themes. Works on every page and
// relies only on window.TrackerTheme from theme-boot.js, so it can load
// with `defer` and doesn't depend on shared.js.
(function () {
  if (!window.TrackerTheme) return;
  var T = window.TrackerTheme;

  // Preview colors are fixed (not tokens) so each card shows what the
  // theme looks like, whichever theme is active right now.
  var THEMES = [
    { key: 'classic', label: 'Classic', blurb: 'Scrappy\'s maroon and orange on a clean board.', score: '24-21',
      pv: { bg: 'linear-gradient(135deg,#22141c,#0b0d12)', card: '#1c202c', text: '#eef0f4', accent: '#f08a4b', accent2: '#b8406a' } },
    { key: 'auto', label: 'Match the Sport', blurb: 'Turf for football, hardwood for hoops, ice for hockey.', score: 'AUTO',
      pv: { bg: 'linear-gradient(90deg,#0e1f14 0 25%,#1d140c 25% 50%,#0c1b2b 50% 75%,#141416 75%)', card: '#ffffff', text: '#111', accent: '#8ee26b', accent2: '#ff7a1a' } },
    { key: 'team', label: 'Team Colors', blurb: 'Paint the whole app in your team\'s colors.', score: 'MY TEAM',
      pv: { bg: 'radial-gradient(ellipse at 50% 0,var(--team-primary,#9e1b32),#120608 80%)', card: '#ffffff', text: '#111', accent: 'var(--team-primary,#9e1b32)', accent2: 'var(--team-secondary,#ffffff)' } },
    { key: 'stadium', label: 'Stadium Lights', blurb: 'Floodlit night game, or a sunny day game in light mode.', score: '7-3',
      pv: { bg: 'radial-gradient(ellipse 50% 60% at 15% 0,rgba(255,252,220,.45),transparent 70%),radial-gradient(ellipse 50% 60% at 85% 0,rgba(255,252,220,.45),transparent 70%),#060a17', card: '#131c3d', text: '#f1f5ff', accent: '#38c6ff', accent2: '#a6f0ff' } },
    { key: 'retro', label: 'Retro Scoreboard', blurb: 'Amber bulbs on a black board. Vintage scorecard in light.', score: 'HOME 14', font: 'ui-monospace,"Courier New",monospace',
      pv: { bg: 'radial-gradient(rgba(255,176,0,.2) 1px,transparent 1.6px) 0 0/6px 6px,#080706', card: '#000', text: '#ffb000', accent: '#ffb000', accent2: '#ff6a00' } },
    { key: 'gridiron', label: 'Gridiron', blurb: 'Mowed turf stripes and chalk yard lines.', score: '1ST & 10',
      pv: { bg: 'repeating-linear-gradient(90deg,#14532d 0 18px,#166534 18px 36px)', card: '#0e1f14', text: '#effaf1', accent: '#8ee26b', accent2: '#f5f5f0' } },
    { key: 'hardwood', label: 'Hardwood', blurb: 'Maple court boards and a basketball-orange accent.', score: '88-84',
      pv: { bg: 'repeating-linear-gradient(90deg,#c98d4f 0 14px,#b97c40 14px 15px,#d39a5c 15px 28px)', card: '#1d140c', text: '#fcf2e4', accent: '#ff7a1a', accent2: '#ffc061' } },
    { key: 'ice', label: 'Ice Rink', blurb: 'Frosted ice with red and blue lines.', score: '3-2 OT',
      pv: { bg: 'linear-gradient(90deg,transparent 22%,#2563eb 22% 25%,transparent 25% 48%,#e8414f 48% 52%,transparent 52% 75%,#2563eb 75% 78%,transparent 78%),#e9f4fb', card: '#0c1b2b', text: '#ecf7ff', accent: '#5ad4ff', accent2: '#e8414f' } },
    { key: 'diamond', label: 'Diamond', blurb: 'Infield clay and checkerboard-mowed grass.', score: 'B9 2-1', font: 'Rockwell,Georgia,serif',
      pv: { bg: 'conic-gradient(#1c5d34 25%,#22703f 0 50%,#1c5d34 0 75%,#22703f 0) 0 0/24px 24px', card: '#f6f3ea', text: '#1b2219', accent: '#ef8a55', accent2: '#f6f3ea' } },
    { key: 'octagon', label: 'Octagon', blurb: 'Chain-link cage, fight-night red and gold.', score: 'R3 4:12', font: 'Impact,"Arial Narrow Bold",sans-serif',
      pv: { bg: 'repeating-linear-gradient(45deg,rgba(255,255,255,.12) 0 1px,transparent 1px 9px),repeating-linear-gradient(-45deg,rgba(255,255,255,.12) 0 1px,transparent 1px 9px),#0b0b0c', card: '#1c1c1f', text: '#f6f6f6', accent: '#ff2e2e', accent2: '#f5c518' } },
    { key: 'speedway', label: 'Speedway', blurb: 'Asphalt, caution yellow and the checkered flag.', score: 'LAP 200',
      pv: { bg: 'conic-gradient(#f4f4f2 25%,#111 0 50%,#f4f4f2 0 75%,#111 0) 0 0/12px 12px', card: '#17191d', text: '#f4f4f2', accent: '#ffd60a', accent2: '#ff3b1f' } },
  ];

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function readFollows() {
    try {
      var list = JSON.parse(localStorage.getItem('tracker-follows') || '[]');
      return Array.isArray(list) ? list.filter(function (t) { return t && t.sport && t.id; }) : [];
    } catch (e) { return []; }
  }

  // Teams that can drive the Team Colors theme: the team page being viewed
  // (if any) plus every followed team, across all sports.
  function teamChoices() {
    var choices = [];
    var params = new URLSearchParams(location.search);
    var current = T.get();
    if (/\/team\.html$/.test(location.pathname) && params.get('id')) {
      var nameEl = document.querySelector('.team-hero .name');
      choices.push({ sport: current.sport, id: params.get('id'), name: (nameEl && nameEl.textContent.trim()) || 'This team', here: true });
    }
    readFollows().forEach(function (t) {
      if (!choices.some(function (c) { return c.sport === t.sport && String(c.id) === String(t.id); })) choices.push(t);
    });
    return choices;
  }

  async function useTeam(choice) {
    var res = await fetch('/api/team/' + encodeURIComponent(choice.id) + '?lite=1&sport=' + encodeURIComponent(choice.sport));
    if (!res.ok) throw new Error('team lookup failed');
    var data = await res.json();
    var team = data.team || {};
    if (!team.color) throw new Error('no color');
    T.setTeam({ id: choice.id, sport: choice.sport, name: team.name || choice.name, color: team.color, alternateColor: team.alternateColor, logo: team.logo });
  }

  var panel = null;
  var button = null;

  function previewStyle(t) {
    return '--pv-bg:' + t.pv.bg + ';--pv-card:' + t.pv.card + ';--pv-text:' + t.pv.text +
      ';--pv-accent:' + t.pv.accent + ';--pv-accent-2:' + t.pv.accent2 + (t.font ? ';--pv-font:' + t.font : '');
  }

  function render() {
    var s = T.get();
    var choices = teamChoices();
    var teamPicked = s.team ? choices.find(function (c) { return String(c.id) === String(s.team.id) && c.sport === s.team.sport; }) : null;
    panel.innerHTML =
      '<div class="panel-head"><strong>Theme</strong><button type="button" class="panel-close" aria-label="Close">&times;</button></div>' +
      '<h3>Brightness</h3>' +
      '<div class="mode-switch" role="group" aria-label="Brightness">' +
        ['auto', 'light', 'dark'].map(function (m) {
          return '<button type="button" data-mode="' + m + '" aria-pressed="' + (s.mode === m) + '">' + { auto: 'Auto', light: 'Light', dark: 'Dark' }[m] + '</button>';
        }).join('') +
      '</div>' +
      '<h3>Sports theme</h3>' +
      '<div class="theme-grid" role="radiogroup" aria-label="Sports theme">' +
        THEMES.map(function (t) {
          return '<button type="button" class="theme-option" role="radio" data-theme="' + t.key + '" aria-checked="' + (s.theme === t.key) + '">' +
            '<span class="preview" data-score="' + esc(t.score) + '" style="' + esc(previewStyle(t)) + '"></span>' +
            '<span class="label">' + esc(t.label) + '</span>' +
            '<span class="blurb">' + esc(t.blurb) + '</span>' +
          '</button>';
        }).join('') +
      '</div>' +
      (s.theme === 'team'
        ? '<div class="team-theme-pick">' +
            '<label for="themeTeamSelect">Team</label>' +
            (choices.length
              ? '<select id="themeTeamSelect"><option value="">Choose a team&hellip;</option>' +
                  choices.map(function (c, i) {
                    var sel = teamPicked && c === teamPicked ? ' selected' : '';
                    return '<option value="' + i + '"' + sel + '>' + esc(c.name || c.abbreviation || 'Team') + (c.here ? ' (this page)' : '') + ' &middot; ' + esc(String(c.sport).toUpperCase()) + '</option>';
                  }).join('') +
                '</select>'
              : '') +
            '<span class="hint" id="themeTeamHint">' +
              (choices.length ? (s.team ? 'Using ' + esc(s.team.name) + '.' : 'Pick a team to paint the app in its colors.')
                : 'Follow a team (open any team and tap Follow) to use its colors here.') +
            '</span>' +
          '</div>'
        : '');

    panel.querySelector('.panel-close').addEventListener('click', close);
    panel.querySelectorAll('.mode-switch button').forEach(function (b) {
      b.addEventListener('click', function () { T.setMode(b.dataset.mode); });
    });
    panel.querySelectorAll('.theme-option').forEach(function (b) {
      b.addEventListener('click', function () {
        T.setTheme(b.dataset.theme);
        // First time choosing Team Colors: use the first followed team.
        if (b.dataset.theme === 'team' && !T.get().team && choices.length) pickTeam(choices[0]);
      });
    });
    var select = panel.querySelector('#themeTeamSelect');
    if (select) {
      select.addEventListener('change', function () {
        if (select.value !== '') pickTeam(choices[Number(select.value)]);
      });
    }
  }

  function pickTeam(choice) {
    var hint = panel && panel.querySelector('#themeTeamHint');
    if (hint) hint.textContent = 'Loading ' + (choice.name || 'team') + ' colors…';
    useTeam(choice).catch(function () {
      var h = panel && panel.querySelector('#themeTeamHint');
      if (h) h.textContent = 'Couldn’t load that team’s colors. Try again in a moment.';
    });
  }

  function onKey(e) { if (e.key === 'Escape') { close(); button.focus(); } }
  function onOutside(e) {
    // Clicks inside the panel re-render it, detaching the clicked element;
    // those aren't outside clicks.
    if (!e.target.isConnected) return;
    if (panel && !panel.contains(e.target) && !button.contains(e.target)) close();
  }

  function open() {
    if (panel) return;
    panel = document.createElement('div');
    panel.className = 'theme-panel';
    panel.id = 'themePanel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Theme');
    document.body.appendChild(panel);
    render();
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', onKey);
    setTimeout(function () { document.addEventListener('click', onOutside); }, 0);
    var checked = panel.querySelector('[aria-checked="true"]');
    if (checked) checked.focus();
  }

  function close() {
    if (!panel) return;
    panel.remove();
    panel = null;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('click', onOutside);
  }

  function init() {
    var header = document.querySelector('header.top');
    if (!header) return;
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-toggle';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'themePanel');
    button.title = 'Change theme';
    button.innerHTML = '<span class="swatch-dot" aria-hidden="true"></span><span class="toggle-label">Theme</span>';
    button.addEventListener('click', function () { panel ? close() : open(); });
    var nav = header.querySelector('nav.top-nav');
    if (nav) nav.appendChild(button); else header.appendChild(button);

    T.onChange(function () {
      if (!panel) return;
      var focusedTheme = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.theme;
      render();
      if (focusedTheme) {
        var again = panel.querySelector('.theme-option[data-theme="' + focusedTheme + '"]');
        if (again) again.focus();
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

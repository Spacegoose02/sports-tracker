// Big countdown to the next game of every team this visitor follows, in
// every sport. The soonest one fills the screen; tap another to swap.
// ?team=<sport>:<id> picks the big one, ?kiosk=1 hides the header for a
// TV or tablet on the wall.
(function () {
  const el = CFB.el;
  const params = new URLSearchParams(location.search);
  let chosen = params.get('team');
  let entries = [];

  if (params.get('kiosk') === '1') document.body.classList.add('kiosk');
  el('kioskLink').addEventListener('click', (e) => {
    e.preventDefault();
    const url = new URL(location.href);
    url.searchParams.set('kiosk', '1');
    location.href = url.toString();
    if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  });

  function allFollows(sportList) {
    const withTeams = new Set(sportList.filter((s) => s.teams !== false).map((s) => s.key));
    const out = [];
    sportList.forEach((s) => {
      if (!withTeams.has(s.key)) return;
      CFB.follows.list(s.key).forEach((t) => out.push(Object.assign({}, t, { sport: s.key, sportLabel: s.shortLabel })));
    });
    return out;
  }

  let lastLoad = 0;
  async function load() {
    lastLoad = Date.now();
    const data = await CFB.getJson('/api/sports').catch(() => ({ sports: [] }));
    const follows = allFollows(data.sports || []);
    if (!follows.length) {
      el('countdownHero').innerHTML = '<div class="empty-note">Follow a team first! Open any team and tap <strong>&#9734; Follow</strong>, then come back here.</div>';
      return;
    }
    entries = await Promise.all(follows.map(async (t) => {
      try {
        const res = await CFB.getJson(`/api/team/${encodeURIComponent(t.id)}?lite=1&sport=${encodeURIComponent(t.sport)}`);
        const team = Object.assign({}, t, res.team || {});
        const game = KidsCore.nextGame(res.schedule || []);
        return { key: `${t.sport}:${t.id}`, team, game };
      } catch (e) {
        return { key: `${t.sport}:${t.id}`, team: t, game: null };
      }
    }));
    entries.sort((a, b) => sortTime(a) - sortTime(b));
    render();
  }

  function sortTime(entry) {
    if (!entry.game) return Infinity;
    if (entry.game.status && entry.game.status.state === 'in') return -Infinity;
    return new Date(entry.game.date).getTime();
  }

  function opponentOf(entry) {
    const g = entry.game;
    if (!g) return null;
    const isHome = g.home && String(g.home.id) === String(entry.team.id);
    return { team: isHome ? g.away : g.home, word: isHome ? 'vs' : 'at' };
  }

  function mascotName(team) {
    return team.nickname || team.shortName || team.name || 'team';
  }

  // A team's logo, falling back to its name if there's no logo or it
  // fails to load.
  function logoOrName(team, cls) {
    const name = `<span class="countdown-opp" ${team.logo ? 'hidden' : ''}>${CFB.esc(team.name || 'TBD')}</span>`;
    if (!team.logo) return name;
    return `<img class="${cls}" src="${CFB.safeUrl(team.logo)}" alt="${CFB.esc(team.name || '')}" onerror="this.style.display='none';this.nextElementSibling.hidden=false">${name}`;
  }

  function heroHtml(entry) {
    const team = entry.team;
    const opp = opponentOf(entry);
    const live = entry.game && entry.game.status.state === 'in';
    const clock = !entry.game
      ? '<div class="countdown-none">No game on the schedule yet. Check back soon!</div>'
      : live
        ? `<a class="countdown-live" href="/game.html?id=${encodeURIComponent(entry.game.id)}&source=${encodeURIComponent(entry.game.source || 'espn')}&sport=${encodeURIComponent(team.sport)}">IT'S GAME TIME! &#127881; Watch now</a>`
        : `<div class="countdown-clock" data-date="${CFB.esc(entry.game.date)}">${clockHtml(entry.game.date)}</div>
           <div class="countdown-when">${CFB.esc(CFB.fmtTime(entry.game.date, entry.game.timeValid))}${entry.game.broadcast ? ` &middot; ${CFB.esc(entry.game.broadcast)}` : ''}</div>`;
    return `
      <div class="countdown-teams">
        ${logoOrName(team, 'countdown-logo')}
        ${opp && opp.team ? `<span class="countdown-vs">${opp.word}</span>
          ${logoOrName(opp.team, 'countdown-logo small')}` : ''}
      </div>
      <div class="countdown-go">Go ${CFB.esc(mascotName(team))}!</div>
      ${opp && opp.team ? `<div class="countdown-matchup">${CFB.esc(team.name || '')} ${opp.word} ${CFB.esc(opp.team.name || 'TBD')}</div>` : ''}
      ${clock}`;
  }

  function clockHtml(iso) {
    const p = KidsCore.countdownParts(new Date(iso).getTime() - Date.now());
    if (p.done) return '<div class="countdown-unit wide"><span class="num">Any minute now!</span></div>';
    const unit = (n, label) => `<div class="countdown-unit"><span class="num">${n}</span><span class="lbl">${label}</span></div>`;
    return [
      p.days ? unit(p.days, p.days === 1 ? 'day' : 'days') : '',
      unit(p.hours, p.hours === 1 ? 'hour' : 'hours'),
      unit(String(p.minutes).padStart(2, '0'), 'min'),
      unit(String(p.seconds).padStart(2, '0'), 'sec'),
    ].join('');
  }

  function render() {
    const hero = entries.find((e) => e.key === chosen) || entries[0];
    const heroEl = el('countdownHero');
    heroEl.innerHTML = heroHtml(hero);
    CFB.applyTeamColor(heroEl, hero.team.color);
    const others = entries.filter((e) => e !== hero);
    el('countdownOthers').innerHTML = others.map((e) => `
      <button type="button" class="countdown-mini" data-key="${CFB.esc(e.key)}">
        ${e.team.logo ? `<img src="${CFB.safeUrl(e.team.logo)}" alt="" onerror="this.style.display='none'">` : ''}
        <span class="countdown-mini-name">${CFB.esc(e.team.name || 'Team')} <span class="countdown-mini-sport">${CFB.esc(e.team.sportLabel || '')}</span></span>
        <span class="countdown-mini-when">${!e.game ? 'No game scheduled' : e.game.status.state === 'in' ? 'Playing now!' : CFB.esc(shortCountdown(e.game.date))}</span>
      </button>`).join('');
    el('countdownOthers').querySelectorAll('.countdown-mini').forEach((btn, i) => {
      CFB.applyTeamColor(btn, others[i].team.color);
      btn.addEventListener('click', () => {
        chosen = btn.dataset.key;
        const url = new URL(location.href);
        url.searchParams.set('team', chosen);
        history.replaceState(null, '', url.toString());
        render();
      });
    });
  }

  function shortCountdown(iso) {
    const p = KidsCore.countdownParts(new Date(iso).getTime() - Date.now());
    if (p.done) return 'Any minute now!';
    if (p.days) return `${p.days}d ${p.hours}h`;
    return `${p.hours}h ${p.minutes}m`;
  }

  // Tick the big clock every second; reload schedules every 10 minutes
  // (and right when a countdown hits zero) so live games show up.
  setInterval(() => {
    const clock = document.querySelector('.countdown-clock');
    if (!clock) return;
    const date = clock.dataset.date;
    clock.innerHTML = clockHtml(date);
    if (new Date(date).getTime() - Date.now() < -60000 && Date.now() - lastLoad > 60000) load();
  }, 1000);
  setInterval(load, 10 * 60 * 1000);

  load();
})();

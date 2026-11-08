// Family leagues in the browser: start or join a league, share its invite
// code, and show league standings. Used by the Kids Zone (weekly pick'em
// leaderboard) and the playoff hub (bracket challenge standings).
//
// Needs shared.js (CFB) and kids.js (Kids). Leagues need an account; pages
// stay public and this just shows a sign-in nudge when signed out.

const Leagues = (function () {
  const esc = CFB.esc;
  const SELECTED_KEY = 'tracker-league';
  let cache = null;

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }

  function signedIn() {
    return !!CFB.account.user();
  }

  async function list(force) {
    if (!signedIn()) return [];
    if (cache && !force) return cache;
    try {
      cache = (await CFB.getJson('/api/family/leagues')).leagues || [];
    } catch (e) {
      cache = [];
    }
    return cache;
  }

  function selected(leagues) {
    const id = Number(storageGet(SELECTED_KEY));
    return (leagues || []).find((l) => l.id === id) || (leagues || [])[0] || null;
  }

  function select(id) {
    storageSet(SELECTED_KEY, id ? String(id) : null);
  }

  function inviteLink(league) {
    return `${location.origin}/kids.html?join=${encodeURIComponent(league.code)}`;
  }

  async function call(url, body, method) {
    const res = await fetch(url, {
      method: method || 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
    return data;
  }

  function signInNudge(next) {
    const href = `/account.html?next=${encodeURIComponent(next || `${location.pathname}${location.search}`)}`;
    return `
      <div class="league-nudge">
        <strong>&#128190; Save your picks and play with family</strong>
        <p>Picks, stickers and brackets save on this device for now. <a href="${esc(href)}">Sign in</a> to keep them on your account, use them on any phone or tablet, and play in a family league with a weekly leaderboard.</p>
      </div>`;
  }

  function picker(leagues, current) {
    if (leagues.length < 2) return '';
    return `
      <label class="league-picker">League
        <select data-role="league-picker">
          ${leagues.map((l) => `<option value="${esc(l.id)}" ${current && l.id === current.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
        </select>
      </label>`;
  }

  // The create / join / manage panel. `onChange()` runs after anything
  // changes (joined, left, switched league) so the page can redraw.
  async function renderManager(container, { onChange, joinCode } = {}) {
    if (!container) return;
    if (!signedIn()) {
      container.innerHTML = signInNudge(joinCode ? `/kids.html?join=${encodeURIComponent(joinCode)}` : null)
        + (joinCode ? `<p class="league-note">Sign in first, then you'll join league code <strong>${esc(joinCode)}</strong>.</p>` : '');
      return;
    }
    const leagues = await list();
    const current = selected(leagues);
    const me = CFB.account.user();
    container.innerHTML = `
      ${current ? `
        <div class="league-head">
          <h2 class="section-title">&#127942; ${esc(current.name)}</h2>
          ${picker(leagues, current)}
        </div>
        <div class="league-invite">
          <span>Invite code <strong class="league-code">${esc(current.code)}</strong></span>
          <button type="button" data-role="copy">Copy invite link</button>
          ${current.isOwner ? '<button type="button" data-role="new-code" title="The old code stops working">New code</button>' : ''}
        </div>
        <details class="league-members">
          <summary>${current.members.length} member${current.members.length === 1 ? '' : 's'}</summary>
          <ul>
            ${current.members.map((m) => `
              <li>${esc(m.name)}${m.isOwner ? ' <span class="league-tag">owner</span>' : ''}${m.id === me.id ? ' <span class="league-tag">you</span>' : ''}
                ${current.isOwner && m.id !== me.id ? `<button type="button" class="link-btn" data-remove="${esc(m.id)}">Remove</button>` : ''}
              </li>`).join('')}
          </ul>
          <button type="button" class="link-btn" data-role="leave">Leave this league</button>
        </details>` : `
        <h2 class="section-title">&#127942; Family league</h2>
        <p class="league-note">Start a league and share the code with family. Everyone signs in on their own phone or tablet, and every player on each account shows up on the leaderboard.</p>`}
      <div class="league-forms">
        <form data-role="create">
          <label class="visually-hidden" for="leagueName">League name</label>
          <input id="leagueName" maxlength="40" placeholder="New league name" autocomplete="off" />
          <button type="submit">Start a league</button>
        </form>
        <form data-role="join">
          <label class="visually-hidden" for="leagueCode">Invite code</label>
          <input id="leagueCode" maxlength="12" placeholder="Invite code" autocomplete="off" value="${esc(joinCode || '')}" />
          <button type="submit">Join</button>
        </form>
      </div>
      <div class="league-error" role="alert"></div>`;

    const errorBox = container.querySelector('.league-error');
    const run = async (fn) => {
      errorBox.textContent = '';
      try {
        await fn();
        cache = null;
        await renderManager(container, { onChange });
        if (onChange) onChange();
      } catch (err) {
        errorBox.textContent = err.message;
      }
    };
    const q = (sel) => container.querySelector(sel);
    if (q('[data-role="league-picker"]')) {
      q('[data-role="league-picker"]').addEventListener('change', (e) => run(async () => select(Number(e.target.value))));
    }
    if (q('[data-role="copy"]')) {
      q('[data-role="copy"]').addEventListener('click', async (e) => {
        const link = inviteLink(current);
        try {
          await navigator.clipboard.writeText(link);
          e.target.textContent = 'Copied!';
        } catch (err) {
          window.prompt('Copy this link and send it to your family:', link);
        }
      });
    }
    if (q('[data-role="new-code"]')) {
      q('[data-role="new-code"]').addEventListener('click', () => {
        if (confirm('Make a new invite code? The old code stops working, but nobody already in the league is removed.')) {
          run(() => call(`/api/family/leagues/${current.id}/code`));
        }
      });
    }
    if (q('[data-role="leave"]')) {
      q('[data-role="leave"]').addEventListener('click', () => {
        if (confirm(`Leave ${current.name}? You can join again with the invite code.`)) {
          run(async () => { await call(`/api/family/leagues/${current.id}/members/me`, undefined, 'DELETE'); select(null); });
        }
      });
    }
    container.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = current.members.find((x) => String(x.id) === btn.dataset.remove);
        if (m && confirm(`Remove ${m.name} from ${current.name}?`)) {
          run(() => call(`/api/family/leagues/${current.id}/members/${m.id}`, undefined, 'DELETE'));
        }
      });
    });
    q('[data-role="create"]').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = q('#leagueName').value.trim();
      if (!name) return;
      run(async () => { const r = await call('/api/family/leagues', { name }); select(r.league.id); });
    });
    q('[data-role="join"]').addEventListener('submit', (e) => {
      e.preventDefault();
      const code = q('#leagueCode').value.trim();
      if (!code) return;
      run(async () => {
        const r = await call('/api/family/leagues/join', { code });
        select(r.league.id);
        if (new URLSearchParams(location.search).has('join')) history.replaceState(null, '', location.pathname);
      });
    });
  }

  // League standings rows -> an <ol> in the Kids Zone leaderboard style.
  // kind 'week': right/wrong/pending; kind 'bracket': points.
  function standingsList(rows, kind) {
    if (!rows || !rows.length) {
      return '<div class="empty-note">Nobody in this league has added a player yet. Add names in the Kids Zone.</div>';
    }
    const me = CFB.account.user();
    const scored = (r) => (kind === 'bracket' ? r.points > 0 : r.right > 0);
    return `<ol class="leaderboard league-board">
      ${rows.map((r, i) => `
        <li class="${me && r.userId === me.id ? 'me' : ''}">
          <span class="lb-place">${i === 0 && scored(r) ? '&#128081;' : i + 1}</span>
          <span class="lb-name">${esc(r.emoji)} ${esc(r.name)} <span class="lb-member">${esc(r.member)}</span></span>
          <span class="lb-score">${kind === 'bracket'
            ? `${r.points} pt${r.points === 1 ? '' : 's'}${r.pending ? ` &middot; ${r.possible} pts possible` : ''}`
            : `${r.right} right${r.wrong ? ` &middot; ${r.wrong} wrong` : ''}${r.pending ? ` &middot; ${r.pending} waiting` : ''}${r.closest ? ` &middot; &#127919; ${r.closest} closest guess${r.closest === 1 ? '' : 'es'}` : ''}`}</span>
        </li>`).join('')}
    </ol>`;
  }

  return { list, selected, select, signedIn, renderManager, standingsList, signInNudge, picker };
})();

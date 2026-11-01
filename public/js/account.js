(function () {
  const el = CFB.el;
  const esc = CFB.esc;
  let mode = 'signin';
  let me = null;

  function showError(id, message) {
    el(id).textContent = message || '';
  }

  // ---- Signed out -------------------------------------------------------

  function renderSignedOut(info) {
    el('signedIn').hidden = true;
    el('signedOut').hidden = false;
    const options = info.options || {};
    if (options.sso) {
      const btn = el('ssoBtn');
      btn.hidden = false;
      btn.textContent = `Sign in with ${options.sso.label}`;
      const next = new URLSearchParams(location.search).get('next');
      btn.href = `/auth/sso/login${next ? `?next=${encodeURIComponent(next)}` : ''}`;
      el('orLine').hidden = false;
    }
    if (new URLSearchParams(location.search).get('error') === 'sso') {
      showError('authError', 'Single sign-on didn\'t finish. Try again.');
    }
    setMode('signin', options);

    // Calendar for teams followed in this browser, no account needed.
    const local = CFB.follows.all().filter((t) => t.sport && t.id);
    if (local.length) {
      const url = `${location.origin}/calendar.ics?teams=${encodeURIComponent(local.map((t) => `${t.sport}:${t.id}`).join(','))}`;
      el('guestCalendar').hidden = false;
      el('guestWebcal').href = url.replace(/^https?:/, 'webcal:');
      el('guestIcs').href = url;
    }
  }

  function setMode(next, options) {
    mode = next;
    const signup = mode === 'signup';
    el('authTitle').textContent = signup ? 'Create an account' : 'Sign in';
    el('authSubmit').textContent = signup ? 'Create account' : 'Sign in';
    el('nameInput').hidden = !signup;
    el('passwordInput').autocomplete = signup ? 'new-password' : 'current-password';
    el('passwordInput').placeholder = signup ? 'Password (8+ characters)' : 'Password';
    const sw = el('authSwitch');
    sw.innerHTML = '';
    if (!options.signup && !signup) return;
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = signup ? 'Have an account? Sign in' : 'New here? Create an account';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      showError('authError', '');
      setMode(signup ? 'signin' : 'signup', options);
    });
    sw.appendChild(link);
  }

  el('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('authError', '');
    const body = { email: el('emailInput').value, password: el('passwordInput').value };
    if (mode === 'signup') body.displayName = el('nameInput').value;
    el('authSubmit').disabled = true;
    try {
      await CFB.account.postJson(`/api/account/${mode === 'signup' ? 'signup' : 'login'}`, body);
      const next = new URLSearchParams(location.search).get('next');
      if (next && /^\/(?![/\\])/.test(next)) { location.href = next; return; }
      // Reload so the account (and teams followed here) are picked up.
      location.href = '/account.html';
    } catch (err) {
      showError('authError', err.message);
    } finally {
      el('authSubmit').disabled = false;
    }
  });

  // ---- Signed in --------------------------------------------------------

  function renderSignedIn(info) {
    me = info;
    el('signedOut').hidden = true;
    el('signedIn').hidden = false;
    el('accountName').textContent = info.user.displayName;
    el('accountEmail').textContent = [info.user.email, info.user.sso ? 'signed in with single sign-on' : null].filter(Boolean).join(' · ');
    renderFollows();
    el('alertStart').checked = info.user.alertStart;
    el('alertEnd').checked = info.user.alertEnd;
    renderFeed(info.feed);
    renderRecapSettings(info.user);
    loadRecap();
    refreshPushState();
  }

  // ---- Scrappy's morning recap --------------------------------------------

  const browserZone = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; }
  })();

  function renderRecapSettings(user) {
    el('recapEnabled').checked = user.recapEnabled;
    el('recapTime').value = user.recapTime || '07:30';
    el('recapTime').disabled = !user.recapEnabled;
    el('recapZone').textContent = (user.recapTimeZone || '').replace(/_/g, ' ');
  }

  function renderRecap(recap) {
    el('recapCard').hidden = !recap;
    if (!recap) return;
    el('recapHeadline').textContent = recap.headline;
    el('recapText').textContent = recap.text;
    const when = new Date(recap.createdAt);
    el('recapMeta').textContent = `${recap.source === 'scrappy' ? 'Written by Scrappy' : 'Your recap'} · ${Number.isNaN(when.getTime()) ? recap.date : when.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
  }

  async function loadRecap() {
    try {
      renderRecap((await CFB.getJson('/api/account/recap')).recap);
    } catch (e) { /* the settings still work */ }
  }

  async function saveRecapSettings(changes) {
    showError('recapError', '');
    try {
      const data = await CFB.account.postJson('/api/account/me', changes, 'PATCH');
      renderRecapSettings(data.user);
    } catch (err) {
      showError('recapError', err.message);
    }
  }

  el('recapEnabled').addEventListener('change', () => {
    const changes = { recapEnabled: el('recapEnabled').checked, recapTime: el('recapTime').value || '07:30' };
    // Recaps go out on this browser's clock.
    if (changes.recapEnabled && browserZone) changes.recapTimeZone = browserZone;
    saveRecapSettings(changes);
  });
  el('recapTime').addEventListener('change', () => {
    if (!el('recapTime').value) return;
    const changes = { recapTime: el('recapTime').value };
    if (browserZone) changes.recapTimeZone = browserZone;
    saveRecapSettings(changes);
  });
  el('recapNowBtn').addEventListener('click', async () => {
    const btn = el('recapNowBtn');
    showError('recapError', '');
    btn.disabled = true;
    btn.textContent = 'Scrappy is writing…';
    try {
      const data = await CFB.account.postJson('/api/account/recap/now');
      renderRecap(data.recap);
    } catch (err) {
      showError('recapError', err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send me one now';
    }
  });

  function renderFollows() {
    const list = el('followList');
    const teams = CFB.follows.all();
    if (!teams.length) {
      list.innerHTML = '<div class="empty-note">You aren\'t following any teams yet.</div>';
      return;
    }
    const sports = new Map(((CFB.account.info() && CFB.account.info().sports) || []).map((s) => [s.key, s]));
    list.innerHTML = teams.map((t) => `
      <div class="follow-row" data-sport="${esc(t.sport)}" data-id="${esc(t.id)}">
        ${t.logo ? `<img src="${CFB.safeUrl(t.logo)}" alt="" onerror="this.style.display='none'">` : '<span class="follow-logo-gap"></span>'}
        <a href="/team.html?id=${encodeURIComponent(t.id)}&source=espn&sport=${encodeURIComponent(t.sport)}">${esc(t.name || t.abbreviation || `Team ${t.id}`)}</a>
        <span class="follow-sport">${esc((sports.get(t.sport) || {}).shortLabel || t.sport.toUpperCase())}</span>
        <button type="button" class="unfollow-inline" aria-label="Unfollow ${esc(t.name || 'team')}">Unfollow</button>
      </div>`).join('');
    list.querySelectorAll('.follow-row').forEach((row) => {
      row.querySelector('button').addEventListener('click', () => {
        CFB.follows.remove(row.dataset.id, row.dataset.sport);
        renderFollows();
      });
    });
  }

  function renderFeed(feed) {
    el('webcalLink').href = feed.webcalUrl;
    el('calendarUrl').value = feed.calendarUrl;
    el('feedKey').value = feed.feedKey;
  }

  async function copy(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      const label = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = label; }, 1500);
    } catch (e) { /* the field stays selectable */ }
  }

  el('copyCalBtn').addEventListener('click', (e) => copy(el('calendarUrl').value, e.currentTarget));
  el('copyKeyBtn').addEventListener('click', (e) => copy(el('feedKey').value, e.currentTarget));
  el('resetKeyBtn').addEventListener('click', async () => {
    if (!confirm('Make a new key? Your current calendar link and any connected apps will stop working until you update them.')) return;
    const data = await CFB.account.postJson('/api/account/feed/reset');
    renderFeed(data.feed);
  });

  el('logoutBtn').addEventListener('click', async () => {
    await disablePushHere().catch(() => {});
    await CFB.account.logout();
    location.href = '/';
  });

  ['alertStart', 'alertEnd'].forEach((id) => {
    el(id).addEventListener('change', async () => {
      try {
        await CFB.account.postJson('/api/account/me', { [id]: el(id).checked }, 'PATCH');
      } catch (err) {
        showError('pushError', err.message);
      }
    });
  });

  // ---- Push alerts on this device ---------------------------------------

  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  function urlBase64ToUint8Array(base64) {
    const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(padded);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function currentSubscription() {
    if (!pushSupported) return null;
    const reg = await navigator.serviceWorker.getRegistration('/');
    return reg ? reg.pushManager.getSubscription() : null;
  }

  async function refreshPushState() {
    const status = el('pushStatus');
    const btn = el('pushBtn');
    if (!pushSupported) {
      status.textContent = 'This browser can\'t show alerts. On iPhone, add this site to your Home Screen first, then open it from there.';
      btn.hidden = true;
      return;
    }
    if (Notification.permission === 'denied') {
      status.textContent = 'Notifications are blocked for this site. Allow them in your browser settings to get alerts.';
      btn.hidden = true;
      return;
    }
    const sub = await currentSubscription().catch(() => null);
    btn.hidden = false;
    btn.textContent = sub ? 'Turn off alerts on this device' : 'Turn on alerts on this device';
    btn.dataset.on = sub ? '1' : '';
    el('pushTestBtn').hidden = !sub;
    const others = me ? me.pushDevices - (sub ? 1 : 0) : 0;
    status.textContent = sub
      ? `Alerts are on for this device${others > 0 ? ` and ${others} other${others === 1 ? '' : 's'}` : ''}.`
      : `Get a notification when a team you follow starts or finishes a game.${others > 0 ? ` Alerts are on for ${others} other device${others === 1 ? '' : 's'}.` : ''}`;
  }

  async function enablePushHere() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notifications weren\'t allowed.');
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    const { publicKey } = await CFB.getJson('/api/account/push/key');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    const data = await CFB.account.postJson('/api/account/push/subscribe', { subscription: sub.toJSON() });
    me.pushDevices = data.pushDevices;
  }

  async function disablePushHere() {
    const sub = await currentSubscription();
    if (!sub) return;
    const data = await CFB.account.postJson('/api/account/push/unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe();
    if (me) me.pushDevices = data.pushDevices;
  }

  el('pushBtn').addEventListener('click', async () => {
    showError('pushError', '');
    el('pushBtn').disabled = true;
    try {
      if (el('pushBtn').dataset.on) await disablePushHere();
      else await enablePushHere();
    } catch (err) {
      showError('pushError', err.message || 'Could not change alerts.');
    } finally {
      el('pushBtn').disabled = false;
      refreshPushState();
    }
  });

  el('pushTestBtn').addEventListener('click', async () => {
    showError('pushError', '');
    try {
      await CFB.account.postJson('/api/account/push/test');
    } catch (err) {
      showError('pushError', err.message);
    }
  });

  CFB.loadSports().then(async () => {
    const info = await CFB.account.load();
    info.sports = await CFB.getJson('/api/sports').then((d) => d.sports).catch(() => []);
    if (info.user) renderSignedIn(info);
    else renderSignedOut(info);
  });
})();

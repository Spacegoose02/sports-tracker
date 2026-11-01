// Scrappy, the AI sports chat bubble. Loaded with `defer` on every page.
// Asks /api/scrappy whether chat is on (Claude or Ollama configured) and adds
// nothing to the page when it isn't. The conversation lives in
// sessionStorage, so it follows the visitor from page to page in a tab.
//
// Replies are rendered with DOM nodes and textContent only (no innerHTML),
// so nothing in a reply can inject markup. Supported formatting: **bold**,
// "- " bullet lines and paragraphs.
(function () {
  var STORE_KEY = 'scrappy:chat';
  var TIP_KEY = 'scrappy:tip-seen';
  var AVATAR = '/img/scrappy-avatar.png';
  var GREETING = "Hey there, I'm Scrappy! I dig through the stat pile so you don't have to. Ask me about scores, schedules, what channel a game's on, rankings, standings, players or the latest news.";
  var SUGGESTIONS = [
    'What college football games are on today?',
    "Who's in the AP Top 10?",
    'Who leads the SEC right now?',
    'Any NFL scores right now?',
  ];
  var MAX_SEND = 12;

  function read(key, fallback) {
    try {
      var v = sessionStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function write(key, value) {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // "**bold** words" -> text nodes and <strong>, never HTML parsing.
  function appendInline(parent, text) {
    var parts = String(text).split('**');
    parts.forEach(function (part, i) {
      if (!part) return;
      if (i % 2 === 1) parent.appendChild(el('strong', null, part));
      else parent.appendChild(document.createTextNode(part));
    });
  }

  function renderBody(node, text) {
    var list = null;
    String(text).split(/\n/).forEach(function (line) {
      var trimmed = line.trim();
      var bullet = /^([-*•]|\d+\.)\s+/.exec(trimmed);
      if (bullet) {
        if (!list) { list = el('ul'); node.appendChild(list); }
        var li = el('li');
        appendInline(li, trimmed.slice(bullet[0].length));
        list.appendChild(li);
        return;
      }
      list = null;
      if (!trimmed) return;
      var p = el('p');
      appendInline(p, trimmed.replace(/^#+\s*/, ''));
      node.appendChild(p);
    });
  }

  function build() {
    var history = read(STORE_KEY, []);
    if (!Array.isArray(history)) history = [];
    var busy = false;

    var root = el('div', 'scrappy');
    if (read(TIP_KEY, false)) root.classList.add('tip-seen');

    var launch = el('button', 'scrappy-launch');
    launch.type = 'button';
    launch.setAttribute('aria-label', 'Chat with Scrappy, the Stat Scraps sports guru');
    launch.setAttribute('aria-expanded', 'false');
    var launchImg = el('img');
    launchImg.src = AVATAR;
    launchImg.alt = '';
    launch.appendChild(launchImg);
    launch.appendChild(el('span', 'scrappy-launch-tip', 'Ask Scrappy!'));

    var panel = el('section', 'scrappy-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Chat with Scrappy');

    var head = el('div', 'scrappy-head');
    var headImg = el('img');
    headImg.src = AVATAR;
    headImg.alt = '';
    var headText = el('div', 'scrappy-head-text');
    headText.appendChild(el('strong', null, 'Scrappy'));
    headText.appendChild(el('span', null, 'Stat Scraps sports guru'));
    var resetBtn = el('button', 'scrappy-reset', 'New chat');
    resetBtn.type = 'button';
    resetBtn.title = 'Start a new chat';
    var closeBtn = el('button', null, '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close chat');
    head.appendChild(headImg);
    head.appendChild(headText);
    head.appendChild(resetBtn);
    head.appendChild(closeBtn);

    var log = el('div', 'scrappy-log');
    log.setAttribute('aria-live', 'polite');
    var chips = el('div', 'scrappy-chips');
    var form = el('form', 'scrappy-form');
    var input = el('input');
    input.type = 'text';
    input.maxLength = 500;
    input.placeholder = 'Ask Scrappy about any team or game…';
    input.setAttribute('aria-label', 'Message Scrappy');
    input.autocomplete = 'off';
    var send = el('button', null, 'Send');
    send.type = 'submit';
    form.appendChild(input);
    form.appendChild(send);
    var note = el('p', 'scrappy-note', 'Scrappy is an AI and can make mistakes. Double-check kickoff times before you head out.');

    panel.appendChild(head);
    panel.appendChild(log);
    panel.appendChild(chips);
    panel.appendChild(form);
    panel.appendChild(note);
    root.appendChild(panel);
    root.appendChild(launch);
    document.body.appendChild(root);

    function addBubble(role, text, isError) {
      var b = el('div', 'scrappy-msg ' + (role === 'user' ? 'from-user' : 'from-scrappy') + (isError ? ' is-error' : ''));
      if (role === 'user') b.textContent = text;
      else renderBody(b, text);
      log.appendChild(b);
      log.scrollTop = log.scrollHeight;
      return b;
    }

    function renderChips() {
      chips.textContent = '';
      if (history.length) return;
      SUGGESTIONS.forEach(function (q) {
        var c = el('button', null, q);
        c.type = 'button';
        c.addEventListener('click', function () { ask(q); });
        chips.appendChild(c);
      });
    }

    function renderAll() {
      log.textContent = '';
      addBubble('assistant', GREETING);
      history.forEach(function (m) { addBubble(m.role, m.content); });
      renderChips();
    }

    function setBusy(on) {
      busy = on;
      send.disabled = on;
      input.disabled = on;
    }

    function ask(text) {
      text = String(text || '').trim();
      if (!text || busy) return;
      history.push({ role: 'user', content: text });
      write(STORE_KEY, history);
      addBubble('user', text);
      renderChips();
      input.value = '';
      setBusy(true);

      var typing = el('div', 'scrappy-msg from-scrappy');
      var dots = el('span', 'scrappy-typing');
      dots.setAttribute('aria-label', 'Scrappy is typing');
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      typing.appendChild(dots);
      log.appendChild(typing);
      log.scrollTop = log.scrollHeight;

      fetch('/api/scrappy/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history.slice(-MAX_SEND) }),
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            if (res.status === 429) throw new Error("Whoa, you're quick! Give me a minute to catch my breath, then ask again.");
            if (!res.ok || !body.reply) throw new Error(body.error || 'Scrappy tripped over a trash can. Try again in a minute.');
            return body.reply;
          });
        })
        .then(function (reply) {
          typing.remove();
          history.push({ role: 'assistant', content: reply });
          write(STORE_KEY, history);
          addBubble('assistant', reply);
        })
        .catch(function (err) {
          typing.remove();
          // Drop the unanswered question so the next send stays well formed.
          history.pop();
          write(STORE_KEY, history);
          addBubble('assistant', (err && err.message) || 'Something went wrong. Try again?', true);
        })
        .then(function () {
          setBusy(false);
          input.focus();
        });
    }

    function open(on) {
      root.classList.toggle('is-open', on);
      launch.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on) {
        root.classList.add('tip-seen');
        write(TIP_KEY, true);
        log.scrollTop = log.scrollHeight;
        input.focus();
      }
    }

    launch.addEventListener('click', function () { open(!root.classList.contains('is-open')); });
    closeBtn.addEventListener('click', function () { open(false); launch.focus(); });
    resetBtn.addEventListener('click', function () {
      if (busy) return;
      history = [];
      write(STORE_KEY, history);
      renderAll();
      input.focus();
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      ask(input.value);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && root.classList.contains('is-open')) open(false);
    });

    renderAll();
  }

  function start() {
    fetch('/api/scrappy', { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.json() : { enabled: false }; })
      .then(function (body) { if (body && body.enabled) build(); })
      .catch(function () { /* offline or off: no bubble */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

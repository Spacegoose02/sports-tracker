# CFB Tracker

A single self-hosted Docker container that shows college football schedules,
live scores/stats, and a "Notable Games" section you curate week-by-week
from an admin page. Virginia Tech (or whichever team you configure) is
always pinned at the top.

- **Data**: ESPN's public college football API by default, with automatic
  fallback to your own [ncaa-api](https://github.com/henrygd/ncaa-api)
  instance (`https://ncaawidget.sgiu.net`) if ESPN is unreachable.
- **Storage**: a small SQLite file (just the notable-games picks) persisted
  to a mounted volume — everything else is fetched live.
- **Admin**: a single shared password (set via env var) protects `/admin`,
  where you pick which games are "notable" for the current week.
- **Pages**: Schedule & Scores, Notable Games, and News live as tabs on the
  home page (Schedule/Notable share the same card style, so notable games
  show channel/time/ranking just like the full schedule). Separate pages
  cover Rankings (poll picker covering every poll ESPN returns — AP, AFCA
  Coaches, FCS Coaches, Division II/III, etc. — plus others receiving
  votes) and Conference Standings. Clicking any team name anywhere opens
  that team's own page (season schedule + season stats). Clicking a game
  card opens that game's own dedicated page — live/final score, leaders,
  box score, and latest drive — never season-long stats for either team.

> **Note on Rankings/Standings**: these two came from ESPN's less-documented
> endpoints. The parsing is written from the well-known shape of that data,
> but ESPN doesn't publish an official schema, so if a field looks off once
> you're on live data, it's usually a one-line fix in `src/espn.js`
> (`getRankings` / `getStandings`) to point at the right field name.

### Also in this version

- The `/admin` page is no longer linked from the site nav — it's still live
  at `/admin`, just not advertised, so bookmark it.
- Finished games now always show an explicit **W** / **L** chip next to
  each team, not just a bolded name, so a final score is unambiguous at a
  glance (this also fixed a bug where the team-schedule page showed
  "Final" with no score at all for some games — ESPN's per-team schedule
  feed shapes scores differently than the main scoreboard feed does).
- An **FBS / FCS** toggle now appears on Schedule & Scores, Rankings, and
  Standings. FCS rankings in particular are best-effort — ESPN's public
  API has thin FCS poll coverage, so that page may say "not available"
  depending on the week; schedules/scores/standings work for FCS either way.
- The color scheme is no longer maroon-and-orange everywhere. Site chrome
  (header, tabs, buttons) now uses a neutral blue accent; the "this is my
  team" cues (favorite card border, favorite badge, is-favorite highlight)
  use a distinct neutral gold so they read as "your team," not as a
  specific team's colors. Individual team pages now pull that team's own
  real color from ESPN for their header stripe, so Miami's page looks like
  Miami and Virginia Tech's still looks like Virginia Tech.
- The header got a small wordmark treatment (icon + gradient title). Now
  using your own logo — see "Latest round of changes" below.
- New: **`GET /api/notable/feed`** — your notable-game picks, grouped by
  week and pre-joined with live score/status/broadcast/venue, meant for
  pulling into an external dashboard (see below).

### Latest round of changes (new logo)

- **New logo**: the penguin mascot is replaced by the "Uprights" mark (a
  football between goalposts) in Turf Green `#17703C`, used for the header
  icon on every page, the favicon (SVG + 32px PNG) and the touch icon. A
  white horizontal lockup is in `public/img/cfbtracker-horizontal-white.svg`
  if you want it elsewhere. Same filenames as before, so nothing else changed.

### Latest round of changes (live field position diagram)

- **The individual game page now shows where the ball actually is.** When
  a game is live, a yard-line field diagram appears under the scorebug
  with the ball drawn at the current spot, a dashed yellow first-down
  marker, each team's color/logo in their own end zone, a small arrow
  showing which direction the offense is driving, a "RED ZONE" badge when
  applicable, and each team's remaining timeouts. It's built from ESPN's
  live `situation` data (down/distance/yardLine/possession), which isn't
  officially documented — **this is the one piece of this feature that's
  unverified against a real live game**: it assumes `yardLine` is 0-100
  measured from the possessing team's own goal line (so 35 = their own
  35-yard line, 65 = midfield-and-35-yards-further). If you ever watch a
  live game and the ball shows up on the wrong side of the field from
  where the broadcast has it, that assumption is the first thing to check
  — see the comments next to `parseSituation` in `src/espn.js` and
  `computeFieldData` in `public/js/game.js`. The diagram only appears for
  live games with usable situation data; it's hidden for games that
  haven't started or have finished.

### Previous round of changes (fixed news images for real, YouTube video feed)

- **News images, properly fixed this time.** The previous fix (checking
  `content:encoded` as well as `description`) was correct but wasn't
  enough on its own — it can only find an image if the RSS feed embeds
  one somewhere, and apparently your ESPN feed (via the rss.sgiu.net
  bridge) just doesn't carry one at all, while Fox Sports' only carries a
  small icon-sized thumbnail that then got stretched into a blurry 16:9
  card. The real fix: for every article, the app now fetches the article
  page itself (just enough of it to read `<head>`, not the whole page)
  and pulls its `og:image` meta tag — the same "featured image" every
  article publishes for link previews on social media. That's almost
  always present and full-resolution, so it now replaces the feed's own
  image (or fills in when there wasn't one) for every source. Results are
  cached per-article for 24 hours, so this cost is paid once per story,
  not on every page load. If you'd rather skip this (fewer outbound
  requests, faster refresh, back to feed-only images) set
  `NEWS_FETCH_OG_IMAGES=0`.
- **New Videos tab**, next to News, pulling recent uploads from the 7
  YouTube channels in your Dynacat config (Hokie Sports, Joel Klatt Show,
  247Sports, Josh Pate's CFB Show, ACC Digital Network, ESPN College
  Football, On3) via YouTube's public per-channel feed — no API key or
  quota needed. Click a thumbnail to play the video right there in the
  card (an embedded player swaps in) instead of leaving the site. Change
  the channel list anytime with `YOUTUBE_CHANNELS_JSON` (see the env
  table below) without touching code.

### Previous round of changes (Upcoming as its own page, news image fix)

- **"Upcoming This Week" moved off the home page** into its own page
  (`/upcoming.html`, linked in the nav next to Rankings/Standings) with
  its own season/week/type/FBS-FCS controls — it was cramped as a home
  page widget. Each game there now also shows its broadcast channel next
  to the kickoff time, so a full week's slate is easy to scan by network.
- **Fixed ESPN images not showing in the News tab.** Two bugs: the image
  lookup checked the `description` field OR `content:encoded`, but with
  `||` — so if `description` existed at all (even with no image in it),
  `content:encoded` never got checked, which is exactly the shape ESPN's
  feed apparently comes through this bridge in. Now both are checked
  independently, plus a last-resort scan for any bare image URL in the
  item, in case a namespaced tag (`media:thumbnail`, etc.) got stripped
  somewhere along the way. Fox Sports/CBS Sports were unaffected since
  their images apparently came through a tag this already handled.

### Previous round of changes (logo, play-by-play, odds, possession, calendar, richer news)

- **Logo & branding**: the site now uses your `cfbtracker.png` mascot as
  its icon/wordmark everywhere (browser tab favicon, every page header,
  Dynacat left as-is since that's a separate config). The app is now
  branded "CFB Tracker" consistently instead of the old full "College
  Football Tracker" name.
- **Play-by-play**: a game's page now has a full Play-by-Play feed (not
  just the last few plays of the current drive) — every play from every
  drive so far, newest first, with scoring plays highlighted. This only
  shows once a game has actually started; ESPN's `drives` data is empty
  pregame.
- **Over/Under & spread**: every game card (schedule, notable games) shows
  a compact odds line when ESPN has a line for that game, and the game
  page has a dedicated Odds section. This is best-effort — ESPN doesn't
  publish odds for every game (mostly just current-week FBS matchups with
  a real sportsbook line), so plenty of games simply won't show one.
- **Possession indicator**: a small football icon now appears next to
  whichever team currently has the ball on live game cards and the game
  page's scorebug, using ESPN's live "situation" data.
- **Upcoming This Week**: a new calendar-style strip on the home page,
  grouped by day, showing every not-yet-played game for the week you're
  viewing — click one to jump straight to its game page.
- **News tab redesign**: cards now show a thumbnail image when the RSS
  feed provides one (tries `media:content`, `enclosure`, and an `<img>`
  inside the article description, in that order), laid out like an
  actual news section instead of a plain link list. Feeds without an
  image get a plain placeholder card instead of a broken image.
- **Removed "data via ESPN / ncaa-api" text** from the footer and page
  subtitles across the site, per your request — the app still falls back
  to ncaa-api the same as before, it just doesn't advertise which source
  answered a given request anymore.

### Previous round of changes

- **Games now open their own page** (`/game.html?id=...`) instead of a
  popup modal — clicking a game card always takes you to that game's
  score/leaders/box score/latest drive, and clicking a team name inside a
  card (or on the game page itself) always takes you to that team's own
  schedule + season stats page. The link is shareable/bookmarkable now,
  and it fixed a rough edge where the two click targets (game vs. team)
  could feel like they were fighting each other in the old popup.
- **Rankings page**: removed the separate FBS/FCS toggle. It turned out
  redundant — ESPN's rankings endpoint already returns every poll it has
  (AP Top 25, AFCA Coaches, FCS Coaches Poll, AFCA Division II/III
  Coaches) in one response, and the existing Poll dropdown already lets
  you pick among them. Schedule & Scores and Standings still have their
  FBS/FCS toggle since those really are separate ESPN queries.
- **New News tab** on the home page, pulling headlines from your
  configured RSS feeds (ESPN, Fox Sports, and CBS Sports college football
  feeds by default) and merging them newest-first. See
  `NEWS_FEEDS_JSON` below if you ever need to change which feeds it pulls
  from.

## Pulling Notable Games into a Dynacat / Glance dashboard

If you run a [Glance](https://github.com/glanceapp/glance)-based dashboard
(what you're calling Dynacat), `dynacat-notable-games-widget.yaml` in this
repo is a ready-to-paste `custom-api` widget that replaces a hand-maintained
per-week matchup list with one call to cfb-tracker's `/api/notable/feed`.
Picking notable games then happens in `/admin` here instead of editing your
dashboard's YAML every week. Open that file for the full widget block and
setup notes — you just need to point it at this container's host:port.

## Running on Unraid

You have two straightforward options. Either way, the app needs one
persistent folder for its SQLite database — create
`/mnt/user/appdata/cfb-tracker` first (Unraid's appdata share is the usual
place for this).

### Option A — Docker Compose Manager plugin (recommended)

1. Install the **Docker Compose Manager** plugin from the Community
   Applications store if you don't already have it.
2. Copy this whole project folder onto your Unraid box, e.g. to
   `/mnt/user/appdata/cfb-tracker-src` (via the Unraid terminal, `scp`, or
   your network share).
3. Edit `docker-compose.yml` and change `ADMIN_PASSWORD` and
   `SESSION_SECRET` to values of your own. Adjust `FAVORITE_TEAM_ID` if you
   want a different pinned team (ESPN team IDs — Virginia Tech is `259`).
4. In the Docker Compose Manager UI, add a new stack pointing at that
   folder, then hit **Compose Up**. It will build the image the first time
   (takes a minute or two) and start the container.
5. Visit `http://<your-unraid-ip>:3000`.

### Option B — Plain `docker build` + `docker run` from the Unraid terminal

```bash
mkdir -p /mnt/user/appdata/cfb-tracker
cd /mnt/user/appdata/cfb-tracker-src   # wherever you copied this project

docker build -t cfb-tracker .

docker run -d \
  --name cfb-tracker \
  --restart unless-stopped \
  -p 3000:3000 \
  -e ADMIN_PASSWORD="something-private" \
  -e SESSION_SECRET="a-long-random-string" \
  -e FAVORITE_TEAM_ID="259" \
  -e FAVORITE_TEAM_NAME="Virginia Tech Hokies" \
  -e NCAA_API_BASE="https://ncaawidget.sgiu.net" \
  -e NCAA_API_DIVISION="fbs" \
  -v /mnt/user/appdata/cfb-tracker:/app/data \
  cfb-tracker
```

Then add it to Unraid's Docker tab as an existing container if you'd like
it managed in the UI (Docker tab &rarr; the container will already show up
since it was started with `docker run`).

### Updating later

Pull/copy the latest source, then either `docker compose up -d --build`
(Option A) or re-run `docker build` + recreate the container (Option B).
Your notable-games picks live in `/mnt/user/appdata/cfb-tracker` and
survive rebuilds.

## Sharing ESPN data with BingeBandit (the ESPN relay)

Other apps on your network can read ESPN through this tracker, so ESPN is
asked once and everyone shares the cached answer. BingeBandit's Sports
section uses this.

1. Set `RELAY_API_KEY` to a long random string (for example the output of
   `openssl rand -hex 24`) and restart the container. The relay stays off
   while it's unset.
2. In BingeBandit, open **Server → Settings → Sports data**, enter this
   tracker's address (e.g. `http://192.168.1.10:3000`) and the same key.

`GET /espn/site/v2/sports/{sport}/{league}/{endpoint}` with header
`X-Api-Key: <key>` answers what ESPN's
`https://site.api.espn.com/apis/site/v2/sports/...` would, for any league.
Only the read endpoints apps need are relayed: `scoreboard`, `teams`,
`teams/{id}`, `teams/{id}/schedule`, `summary`, `rankings` and `news`.
Answers are kept 15 seconds while a game in them is live or about to
start, 5 to 10 minutes otherwise, and 12 hours for team lists. If ESPN
fails, the last copy (up to a day old) is served with `X-Cache: STALE`.
If the tracker is down, BingeBandit reads ESPN directly until it's back.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port the app listens on inside the container |
| `ADMIN_PASSWORD` | `changeme` | Password for `/admin` — **change this** |
| `SESSION_SECRET` | *(placeholder)* | Cookie signing secret — **change this** |
| `FAVORITE_TEAM_ID` | `259` | ESPN team ID pinned at the top (259 = Virginia Tech) |
| `FAVORITE_TEAM_NAME` | `Virginia Tech Hokies` | Display name for the pinned team |
| `NCAA_API_BASE` | `https://ncaawidget.sgiu.net` | Your ncaa-api instance, used as fallback |
| `NCAA_API_DIVISION` | `fbs` | Division for ncaa-api fallback scoreboard calls |
| `CACHE_TTL_SECONDS` | `20` | How long scoreboard responses are cached in memory |
| `NEWS_FEEDS_JSON` | *(public ESPN / CBS Sports / Yahoo Sports CFB feeds)* | Optional JSON array of `{"name":"...","url":"..."}` to override the News tab's RSS feeds entirely |
| `NEWS_FETCH_OG_IMAGES` | `1` (on) | Set to `0` to stop fetching each article's `og:image` for the News tab — faster/fewer outbound requests, but back to whatever (if anything) the RSS feed itself embedded |
| `YOUTUBE_CHANNELS_JSON` | *(your 7 Dynacat channels)* | Optional JSON array of `{"id":"UC...","name":"..."}` to override the Videos tab's channel list entirely |
| `RELAY_API_KEY` | *(unset: relay off)* | Turns on the ESPN relay at `/espn/...` for BingeBandit and other apps; they send it as `X-Api-Key` |
| `TRUST_PROXY` | *(unset)* | Set to `1` when the app sits behind a reverse proxy so the admin login rate limit sees each visitor's real IP |

To find a different team's ESPN ID, visit
`https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams`
and search for the team, or check the URL on ESPN's team page
(`espn.com/college-football/team/_/id/<ID>/...`).

## How it works

- **Home page (`/`)** — pick a season/week/season-type, see the full
  scoreboard with your favorite team pinned first, a "Notable Games"
  section pulled from the admin picks for that week, and click any game
  card for live box score / leaders / latest drive.
- **Admin page (`/admin`)** — log in with `ADMIN_PASSWORD`, pick a week,
  and toggle which games are "notable." Notes/labels are optional (e.g.
  "ACC opener", "Top 10 matchup").
- Live games auto-refresh every 20 seconds while any game in the current
  view is in progress.
- If ESPN's API errors out, the app automatically retries the same request
  against your ncaa-api instance and tags the response so you know which
  source served it (shown in the small text under the page title).

## Security

- **Set real secrets.** When `NODE_ENV=production` (the Docker image sets
  it), `/admin` stays locked until `ADMIN_PASSWORD` is something other than
  the placeholder. A missing or placeholder `SESSION_SECRET` is replaced
  with a random one at startup, which works but logs everyone out of
  `/admin` on every restart. The server log says exactly what to change.
- **Admin login is rate limited** to 10 attempts per 15 minutes per IP.
- **Outside content is escaped.** News headlines, video titles, ESPN data
  and admin notes are all escaped before they reach the page, and only
  `http(s)` links and images are allowed through.
- **Keep private feed URLs out of the code.** Put RSS-bridge URLs with
  tokens in `NEWS_FEEDS_JSON` in your `.env` or container settings.

## Tests

```bash
npm test
```

Runs on every pull request through GitHub Actions.

## Local development (without Docker)

```bash
npm install
cp .env.example .env   # edit ADMIN_PASSWORD / SESSION_SECRET
npm start
```

Then open `http://localhost:3000`.

# Dashboards: Dynacat, Glance and anything that reads JSON

Stat Scraps exposes your account's data as read-only JSON so a dashboard
can show it. [Glance](https://github.com/glanceapp/glance) and its fork
Dynacat read it with a `custom-api` widget; Home Assistant, Homepage or a
script can read the same URLs.

## Your key

Sign in, open **Account**, and copy the key under **Connect other apps**.
It can only read your teams, notable games and recap; it can't change
anything. **Make a new key** on the same page revokes the old one (and
changes your calendar link).

Send it as a header:

```
Authorization: Bearer <your key>
```

If a widget can't send headers, `?key=<your key>` on the URL works for the
read-only routes below. Prefer the header: URLs end up in proxy and server
logs.

In Glance/Dynacat, keep the key out of the YAML with an environment
variable:

```yaml
- type: custom-api
  url: http://stat-scraps:3000/api/account/dashboard
  headers:
    Authorization: "Bearer ${STAT_SCRAPS_KEY}"
```

and set `STAT_SCRAPS_KEY` in Dynacat's container environment.

## Endpoints

All are `GET`, return JSON, and take the key (or a signed-in browser
session). Live data is cached for about 30 seconds, so a widget
`cache: 1m` or `2m` is plenty.

| Path | What it returns |
| --- | --- |
| `/api/account/dashboard` | Everything below in one call |
| `/api/account/notable/feed` | Your notable games with live scores, by week |
| `/api/account/notable?season=&week=` | Your notable picks for one week (rows only, no scores) |
| `/api/account/teams` | Followed teams with live, next and last game |
| `/api/account/recap` | Scrappy's latest daily recap and recap settings |
| `/api/notable/feed` | The admin's site-wide picks (no key needed) |

### `/api/account/notable/feed`

Query: `weeks` (how many weeks from `startWeek`, default 1, max 8),
`season` and `startWeek` (default to the current college football week),
`seasontype` (2 regular season, 3 postseason).

```json
{
  "user": { "displayName": "Sam" },
  "season": 2026,
  "startWeek": 11,
  "counts": { "games": 4, "live": 1, "final": 2, "upcoming": 1 },
  "weeks": [
    {
      "week": 11,
      "games": [
        {
          "id": "401752...",
          "label": "Game of the week",
          "date": "2026-11-14T20:00:00Z",
          "name": "Florida State Seminoles at Virginia Tech Hokies",
          "shortName": "FSU @ VT",
          "venue": "Lane Stadium",
          "broadcast": "ACC Network",
          "status": { "state": "in", "shortDetail": "Q2 4:12", "completed": false },
          "home": { "id": "259", "name": "Virginia Tech Hokies", "abbreviation": "VT", "logo": "https://...", "score": 14, "winner": false, "curatedRank": 18 },
          "away": { "id": "52", "name": "Florida State Seminoles", "abbreviation": "FSU", "logo": "https://...", "score": 10, "winner": false, "curatedRank": null },
          "odds": { "details": "VT -3.5", "overUnder": 51.5 }
        }
      ]
    }
  ]
}
```

`status.state` is `pre`, `in` or `post`. Games are in the order you picked
them. A week with no picks has `"games": []`.

### `/api/account/dashboard`

```json
{
  "user": { "displayName": "Sam" },
  "generatedAt": "2026-11-14T20:41:07.000Z",
  "counts": { "teams": 3, "teamsLive": 1, "notable": 4, "notableLive": 1 },
  "teams": [ "...same as /api/account/teams" ],
  "notable": { "...same as /api/account/notable/feed" },
  "recap": { "date": "2026-11-14", "headline": "...", "text": "...", "teams": [], "createdAt": "..." },
  "errors": []
}
```

If ESPN can't be reached for one part, that part is `null` and its name
is listed in `errors`, so the rest of the widget still renders.

### `/api/account/teams`

Each team has `sport`, `name`, `abbreviation`, `logo`, `color`, `record`,
`rank`, `url` (its Stat Scraps page), and `liveGame`, `nextGame`,
`lastGame` (each a game like the one above, or `null`) plus `upcoming`
(the next three games).

## Ready-made widgets

- [`dynacat-notable-games-widget.yaml`](../dynacat-notable-games-widget.yaml):
  scorebug cards for your notable games, grouped by week.
- [`dynacat-my-teams-widget.yaml`](../dynacat-my-teams-widget.yaml): one row
  per followed team with its live or next game and last result.

Paste either into a page's `widgets:` list, set the host, and set
`STAT_SCRAPS_KEY`.

## Picking notable games

Signed in on the site, every game card under **Schedule & Scores** has a
star. Tap it to add the game to your notable games (tap again to remove).
The **Notable Games** tab shows your list. If the admin has picked games
for the week and you haven't, that tab offers to copy them in.

The admin's picks in `/admin` are now the site default: what signed-out
visitors see, and what `/api/notable/feed` returns.

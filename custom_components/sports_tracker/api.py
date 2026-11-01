"""Small client for the Sports Tracker web app's JSON API."""

from __future__ import annotations

from typing import Any

import aiohttp

TIMEOUT = aiohttp.ClientTimeout(total=20)


class TrackerError(Exception):
    """The tracker could not be reached or returned an error."""


class TrackerClient:
    """Talks to a self-hosted Sports Tracker (the Express app in this repo)."""

    def __init__(self, session: aiohttp.ClientSession, url: str) -> None:
        self._session = session
        self.url = normalize_url(url)

    async def _get(self, path: str, params: dict[str, str] | None = None) -> Any:
        try:
            async with self._session.get(
                f"{self.url}{path}", params=params, timeout=TIMEOUT
            ) as resp:
                if resp.status != 200:
                    raise TrackerError(f"{path} returned HTTP {resp.status}")
                return await resp.json(content_type=None)
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise TrackerError(str(err) or err.__class__.__name__) from err

    async def sports(self) -> list[dict[str, Any]]:
        """The sports the tracker knows: [{key, label, format, teams, ...}]."""
        data = await self._get("/api/sports")
        if not isinstance(data, dict) or not isinstance(data.get("sports"), list):
            raise TrackerError("This doesn't look like a Sports Tracker")
        return data["sports"]

    async def teams(self, sport: str) -> list[dict[str, Any]]:
        """Every team in a league, for the team picker."""
        data = await self._get("/api/teams", {"sport": sport})
        return data.get("teams", []) if isinstance(data, dict) else []

    async def scorecards(self, items: list[str]) -> dict[str, dict[str, Any]]:
        """Scorecards keyed by item ("cfb:259", "nascar", ...)."""
        if not items:
            return {}
        data = await self._get("/api/ha/scorecards", {"items": ",".join(items)})
        cards = data.get("scorecards") if isinstance(data, dict) else None
        if not isinstance(cards, dict):
            raise TrackerError("Unexpected scorecards response")
        return cards


def normalize_url(url: str) -> str:
    """http://host:3000/ -> http://host:3000 (adds http:// when missing)."""
    url = url.strip().rstrip("/")
    if not url.startswith(("http://", "https://")):
        url = f"http://{url}"
    return url

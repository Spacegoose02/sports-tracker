"""Polls the tracker for every followed team and event in one request."""

from __future__ import annotations

from datetime import datetime, timedelta
import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util

from .api import TrackerClient, TrackerError
from .const import (
    CONF_FOLLOWS,
    DOMAIN,
    EVENT_SCORE,
    EVENT_STATE,
    INTERVAL_IDLE,
    INTERVAL_LIVE,
    INTERVAL_SOON,
    INTERVAL_TODAY,
    STATE_IN,
    STATE_POST,
    STATE_PRE,
)

_LOGGER = logging.getLogger(__name__)


def follow_items(entry: ConfigEntry) -> list[str]:
    """The item strings ("cfb:259", "nascar") this entry follows."""
    return [f["item"] for f in entry.options.get(CONF_FOLLOWS, []) if f.get("item")]


def _start_time(card: dict[str, Any]) -> datetime | None:
    event = card.get("event") or {}
    return dt_util.parse_datetime(event["date"]) if event.get("date") else None


def pick_interval(cards: dict[str, dict[str, Any]], now: datetime) -> timedelta:
    """Fast while something is live, slow when nothing is happening today."""
    interval = INTERVAL_IDLE
    for card in cards.values():
        state = card.get("state")
        if state == STATE_IN:
            return INTERVAL_LIVE
        start = _start_time(card)
        if start is None:
            continue
        if state == STATE_PRE:
            until = start - now
            if until <= timedelta(hours=1):
                # Kickoff time passed but ESPN hasn't flipped to live yet:
                # keep checking quickly so the first score isn't missed.
                interval = min(interval, INTERVAL_LIVE if until <= timedelta(0) else INTERVAL_SOON)
            elif until <= timedelta(hours=12):
                interval = min(interval, INTERVAL_TODAY)
        elif state == STATE_POST and now - start <= timedelta(hours=6):
            interval = min(interval, INTERVAL_TODAY)
    return interval


class SportsTrackerCoordinator(DataUpdateCoordinator[dict[str, dict[str, Any]]]):
    """Fetches all scorecards and fires score / game-state events."""

    config_entry: ConfigEntry

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, client: TrackerClient) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            config_entry=entry,
            update_interval=INTERVAL_TODAY,
        )
        self.client = client

    async def _async_update_data(self) -> dict[str, dict[str, Any]]:
        items = follow_items(self.config_entry)
        try:
            cards = await self.client.scorecards(items)
        except TrackerError as err:
            raise UpdateFailed(f"Could not reach the Sports Tracker: {err}") from err
        previous = self.data or {}
        for item, card in cards.items():
            if isinstance(card, dict) and not card.get("error"):
                self._fire_events(item, previous.get(item) or {}, card)
        self.update_interval = pick_interval(
            {k: v for k, v in cards.items() if isinstance(v, dict)}, dt_util.utcnow()
        )
        return cards

    def _fire_events(self, item: str, old: dict[str, Any], new: dict[str, Any]) -> None:
        if not old or old.get("error"):
            return  # first poll after startup: nothing to compare against
        old_event = (old.get("event") or {}).get("id")
        new_event = (new.get("event") or {}).get("id")
        if old_event != new_event:
            return  # moved on to a different game
        base = {
            "item": item,
            "sport": new.get("sport"),
            "event_id": new_event,
            "event_name": (new.get("event") or {}).get("name"),
        }
        if old.get("state") != new.get("state"):
            self.hass.bus.async_fire(
                EVENT_STATE,
                {**base, "from_state": old.get("state"), "to_state": new.get("state"),
                 "team": (new.get("team") or {}).get("name"),
                 "team_score": (new.get("team") or {}).get("score"),
                 "opponent": (new.get("opponent") or {}).get("name"),
                 "opponent_score": (new.get("opponent") or {}).get("score")},
            )
        if new.get("kind") != "game":
            return
        for who, other in (("team", "opponent"), ("opponent", "team")):
            before = (old.get(who) or {}).get("score")
            after = (new.get(who) or {}).get("score")
            if isinstance(before, (int, float)) and isinstance(after, (int, float)) and after > before:
                scorer = new.get(who) or {}
                self.hass.bus.async_fire(
                    EVENT_SCORE,
                    {
                        **base,
                        "scored_by": who,
                        "points": after - before,
                        "scoring_team": scorer.get("name"),
                        "scoring_team_color": scorer.get("color"),
                        "team": (new.get("team") or {}).get("name"),
                        "team_score": (new.get("team") or {}).get("score"),
                        "opponent": (new.get("opponent") or {}).get("name"),
                        "opponent_score": (new.get("opponent") or {}).get("score"),
                    },
                )

"""One sensor per followed team, UFC card or NASCAR race, plus Scrappy's
daily recap when the account's feed key is set.

State is PRE, IN, POST or NOT_FOUND (the same states the popular Team
Tracker card uses). The attributes are the full scorecard, which is what
the bundled sports-tracker-card draws, plus a few flat ones that are easy
to use in automations and templates.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import SportsTrackerConfigEntry
from .const import CONF_FOLLOWS, CONF_URL, DOMAIN, SPORT_ICONS
from .coordinator import RecapCoordinator, SportsTrackerCoordinator

# Nested scorecard parts change every few seconds during a game; keep them
# out of the recorder database. The flat attributes are still recorded.
NESTED = ("team", "opponent", "event", "field", "bases", "stat", "race", "card", "odds", "next_game")


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SportsTrackerConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add a sensor for each follow."""
    coordinator = entry.runtime_data
    entities: list[SensorEntity] = [
        ScorecardSensor(coordinator, follow) for follow in entry.options.get(CONF_FOLLOWS, [])
    ]
    if coordinator.recap is not None:
        entities.append(RecapSensor(coordinator.recap))
    async_add_entities(entities)


def _device_info(entry) -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, entry.entry_id)},
        name="Sports Tracker",
        manufacturer="Sports Tracker",
        entry_type=DeviceEntryType.SERVICE,
        configuration_url=entry.data[CONF_URL],
    )


class ScorecardSensor(CoordinatorEntity[SportsTrackerCoordinator], SensorEntity):
    """A team's (or event's) live scorecard."""

    _attr_has_entity_name = True
    _unrecorded_attributes = frozenset(NESTED + ("last_play", "updated"))

    def __init__(self, coordinator: SportsTrackerCoordinator, follow: dict[str, str]) -> None:
        super().__init__(coordinator)
        entry = coordinator.config_entry
        self._item = follow["item"]
        self._sport = follow.get("sport") or self._item.split(":")[0]
        self._attr_name = follow.get("name") or self._item
        self._attr_unique_id = f"{entry.entry_id}_{self._item}"
        self._attr_icon = SPORT_ICONS.get(self._sport, "mdi:scoreboard")
        self._attr_device_info = _device_info(entry)

    @property
    def _card(self) -> dict[str, Any] | None:
        card = (self.coordinator.data or {}).get(self._item)
        return card if isinstance(card, dict) and not card.get("error") else None

    @property
    def available(self) -> bool:
        return super().available and self._card is not None

    @property
    def native_value(self) -> str | None:
        card = self._card
        return card.get("state") if card else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        card = self._card
        if not card:
            return {}
        team = card.get("team") or {}
        opponent = card.get("opponent") or {}
        event = card.get("event") or {}
        attrs: dict[str, Any] = {
            "kind": card.get("kind"),
            "sport": card.get("sport"),
            "league": card.get("league"),
            "sport_label": card.get("sportLabel"),
            # Flat, automation-friendly values.
            "team_name": team.get("name"),
            "team_abbr": team.get("abbreviation"),
            "team_score": team.get("score"),
            "team_record": team.get("record"),
            "team_rank": team.get("rank"),
            "opponent_name": opponent.get("name"),
            "opponent_abbr": opponent.get("abbreviation"),
            "opponent_score": opponent.get("score"),
            "date": event.get("date"),
            "venue": event.get("venue"),
            "tv": event.get("broadcast"),
            "status": event.get("shortDetail") or event.get("detail"),
            "clock": event.get("clock"),
            "period": event.get("period"),
            "last_play": card.get("lastPlay"),
            "updated": card.get("updated"),
            # The whole scorecard, for the card.
            "team": card.get("team"),
            "opponent": card.get("opponent"),
            "event": card.get("event"),
            "field": card.get("field"),
            "bases": card.get("bases"),
            "stat": card.get("stat"),
            "odds": card.get("odds"),
            "next_game": card.get("nextGame"),
            "race": card.get("race"),
            "card": card.get("card"),
        }
        return {k: v for k, v in attrs.items() if v is not None}


class RecapSensor(CoordinatorEntity[RecapCoordinator], SensorEntity):
    """Scrappy's daily recap. State is the headline; the full text is in `text`."""

    _attr_has_entity_name = True
    _attr_name = "Scrappy recap"
    _attr_icon = "mdi:newspaper-variant-outline"
    _unrecorded_attributes = frozenset({"text", "teams"})

    def __init__(self, coordinator: RecapCoordinator) -> None:
        super().__init__(coordinator)
        entry = coordinator.config_entry
        self._attr_unique_id = f"{entry.entry_id}_recap"
        self._attr_device_info = _device_info(entry)

    @property
    def _recap(self) -> dict[str, Any]:
        return (self.coordinator.data or {}).get("recap") or {}

    @property
    def native_value(self) -> str | None:
        headline = self._recap.get("headline")
        return headline[:255] if headline else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        data = self.coordinator.data or {}
        recap = self._recap
        attrs: dict[str, Any] = {
            "text": recap.get("text"),
            "date": recap.get("date"),
            "created_at": recap.get("createdAt"),
            "written_by": "Scrappy" if recap.get("source") == "scrappy" else "Stat Scraps",
            "enabled": data.get("enabled"),
            "time": data.get("time"),
            "time_zone": data.get("timeZone"),
            "teams": recap.get("teams"),
        }
        return {k: v for k, v in attrs.items() if v is not None}

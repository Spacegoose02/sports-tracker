"""Sports Tracker: live scorecards from a self-hosted Sports Tracker."""

from __future__ import annotations

import json
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.typing import ConfigType

from .api import TrackerClient
from .const import CARD_FILENAME, CARD_URL, CONF_URL, DOMAIN
from .coordinator import SportsTrackerCoordinator

PLATFORMS = [Platform.SENSOR]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

type SportsTrackerConfigEntry = ConfigEntry[SportsTrackerCoordinator]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Serve the scorecard card and load it on every dashboard."""
    card = Path(__file__).parent / "www" / CARD_FILENAME
    await hass.http.async_register_static_paths(
        [StaticPathConfig(CARD_URL, str(card), cache_headers=False)]
    )
    manifest = await hass.async_add_executor_job(
        (Path(__file__).parent / "manifest.json").read_text
    )
    # The version busts browser caches after an update.
    add_extra_js_url(hass, f"{CARD_URL}?v={json.loads(manifest)['version']}")
    return True


async def async_setup_entry(hass: HomeAssistant, entry: SportsTrackerConfigEntry) -> bool:
    """Start polling the tracker."""
    client = TrackerClient(async_get_clientsession(hass), entry.data[CONF_URL])
    coordinator = SportsTrackerCoordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_reload))
    return True


async def _async_reload(hass: HomeAssistant, entry: SportsTrackerConfigEntry) -> None:
    """Following a new team changes the sensor list, so reload."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: SportsTrackerConfigEntry) -> bool:
    """Stop polling."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)

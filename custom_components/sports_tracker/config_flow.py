"""Set up the tracker URL, then follow teams, UFC and NASCAR from Configure."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .api import TrackerAuthError, TrackerClient, TrackerError, normalize_url
from .const import CONF_FEED_KEY, CONF_FOLLOWS, CONF_URL, DOMAIN

MAX_FOLLOWS = 20  # the tracker's /api/ha/scorecards limit


class SportsTrackerConfigFlow(ConfigFlow, domain=DOMAIN):
    """Ask for the tracker's address and check it answers."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            url = normalize_url(user_input[CONF_URL])
            await self.async_set_unique_id(url)
            self._abort_if_unique_id_configured()
            client = TrackerClient(async_get_clientsession(self.hass), url)
            try:
                await client.sports()
            except TrackerError:
                errors["base"] = "cannot_connect"
            else:
                return self.async_create_entry(
                    title="Sports Tracker",
                    data={CONF_URL: url},
                    options={CONF_FOLLOWS: []},
                )
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_URL, default=(user_input or {}).get(CONF_URL, "http://")): TextSelector(
                        TextSelectorConfig(type=TextSelectorType.URL)
                    )
                }
            ),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return SportsTrackerOptionsFlow()


class SportsTrackerOptionsFlow(OptionsFlow):
    """Add or remove the teams and events that get a sensor."""

    def __init__(self) -> None:
        self._sports: list[dict[str, Any]] = []
        self._sport: str | None = None

    @property
    def _follows(self) -> list[dict[str, str]]:
        return list(self.config_entry.options.get(CONF_FOLLOWS, []))

    def _client(self) -> TrackerClient:
        return TrackerClient(async_get_clientsession(self.hass), self.config_entry.data[CONF_URL])

    def _save(self, follows: list[dict[str, str]]) -> ConfigFlowResult:
        return self.async_create_entry(data={**self.config_entry.options, CONF_FOLLOWS: follows})

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        menu = ["add_team", "add_event"]
        if self._follows:
            menu.append("remove")
        menu.append("recap")
        return self.async_show_menu(step_id="init", menu_options=menu)

    async def _load_sports(self) -> bool:
        try:
            self._sports = await self._client().sports()
        except TrackerError:
            return False
        return True

    async def async_step_add_team(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Pick a team sport."""
        if user_input is not None:
            self._sport = user_input["sport"]
            return await self.async_step_team()
        if not await self._load_sports():
            return self.async_abort(reason="cannot_connect")
        options = [
            SelectOptionDict(value=s["key"], label=s["label"])
            for s in self._sports
            if s.get("format", "game") == "game"
        ]
        return self.async_show_form(
            step_id="add_team",
            data_schema=vol.Schema({vol.Required("sport", default="cfb"): SelectSelector(
                SelectSelectorConfig(options=options, mode=SelectSelectorMode.DROPDOWN)
            )}),
        )

    async def async_step_team(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Pick the team (type to search; an ESPN team id also works)."""
        assert self._sport
        try:
            teams = await self._client().teams(self._sport)
        except TrackerError:
            teams = []
        names = {str(t["id"]): t.get("name") or str(t["id"]) for t in teams if t.get("id")}
        errors: dict[str, str] = {}
        if user_input is not None:
            team_id = str(user_input["team"]).strip()
            item = f"{self._sport}:{team_id}"
            if not team_id.replace("-", "").replace("_", "").isalnum():
                errors["team"] = "invalid_team"
            elif any(f["item"] == item for f in self._follows):
                return self.async_abort(reason="already_following")
            elif len(self._follows) >= MAX_FOLLOWS:
                return self.async_abort(reason="too_many")
            else:
                sport_label = next((s.get("shortLabel") for s in self._sports if s["key"] == self._sport), self._sport.upper())
                name = names.get(team_id) or f"{sport_label} team {team_id}"
                return self._save([*self._follows, {"item": item, "sport": self._sport, "name": name}])
        options = [SelectOptionDict(value=tid, label=name) for tid, name in names.items()]
        return self.async_show_form(
            step_id="team",
            data_schema=vol.Schema({vol.Required("team"): SelectSelector(
                SelectSelectorConfig(options=options, mode=SelectSelectorMode.DROPDOWN, custom_value=True)
            )}),
            errors=errors,
        )

    async def async_step_add_event(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Follow UFC fight nights or NASCAR races."""
        if not self._sports and not await self._load_sports():
            return self.async_abort(reason="cannot_connect")
        events = {s["key"]: s["label"] for s in self._sports if s.get("format") in ("card", "race")}
        if user_input is not None:
            key = user_input["sport"]
            if any(f["item"] == key for f in self._follows):
                return self.async_abort(reason="already_following")
            if len(self._follows) >= MAX_FOLLOWS:
                return self.async_abort(reason="too_many")
            return self._save([*self._follows, {"item": key, "sport": key, "name": events.get(key, key)}])
        return self.async_show_form(
            step_id="add_event",
            data_schema=vol.Schema({vol.Required("sport"): SelectSelector(
                SelectSelectorConfig(
                    options=[SelectOptionDict(value=k, label=v) for k, v in events.items()],
                    mode=SelectSelectorMode.LIST,
                )
            )}),
        )

    async def async_step_remove(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Stop following some teams or events."""
        if user_input is not None:
            drop = set(user_input.get("items", []))
            return self._save([f for f in self._follows if f["item"] not in drop])
        return self.async_show_form(
            step_id="remove",
            data_schema=vol.Schema({vol.Optional("items", default=[]): SelectSelector(
                SelectSelectorConfig(
                    options=[SelectOptionDict(value=f["item"], label=f["name"]) for f in self._follows],
                    multiple=True,
                    mode=SelectSelectorMode.LIST,
                )
            )}),
        )

    async def async_step_recap(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Add (or remove) the Scrappy recap sensor with the account's feed key."""
        errors: dict[str, str] = {}
        current = self.config_entry.options.get(CONF_FEED_KEY, "")
        if user_input is not None:
            key = str(user_input.get(CONF_FEED_KEY) or "").strip()
            if not key:
                options = {k: v for k, v in self.config_entry.options.items() if k != CONF_FEED_KEY}
                return self.async_create_entry(data=options)
            try:
                await self._client().recap(key)
            except TrackerAuthError:
                errors["base"] = "invalid_key"
            except TrackerError:
                errors["base"] = "cannot_connect"
            else:
                return self.async_create_entry(data={**self.config_entry.options, CONF_FEED_KEY: key})
        return self.async_show_form(
            step_id="recap",
            data_schema=vol.Schema(
                {
                    vol.Optional(CONF_FEED_KEY, default=(user_input or {}).get(CONF_FEED_KEY, current)): TextSelector(
                        TextSelectorConfig(type=TextSelectorType.PASSWORD)
                    )
                }
            ),
            errors=errors,
        )

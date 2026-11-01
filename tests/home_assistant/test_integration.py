"""Config flow, sensors, events and the bundled card."""

from datetime import timedelta

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_capture_events

from custom_components.sports_tracker.const import (
    CONF_FEED_KEY,
    CONF_FOLLOWS,
    DOMAIN,
    EVENT_RECAP,
    EVENT_SCORE,
    EVENT_STATE,
    INTERVAL_IDLE,
    INTERVAL_LIVE,
    INTERVAL_SOON,
)
from custom_components.sports_tracker.coordinator import pick_interval

URL = "http://tracker:3000"
SPORTS = {
    "defaultSport": "cfb",
    "sports": [
        {"key": "cfb", "label": "College Football", "shortLabel": "CFB", "format": "game"},
        {"key": "nhl", "label": "NHL", "shortLabel": "NHL", "format": "game"},
        {"key": "nascar", "label": "NASCAR Cup Series", "shortLabel": "NASCAR", "format": "race"},
        {"key": "ufc", "label": "UFC", "shortLabel": "UFC", "format": "card"},
    ],
}


def game_card(state="IN", team_score=7, opp_score=3):
    return {
        "kind": "game",
        "sport": "cfb",
        "league": "CFB",
        "sportLabel": "College Football",
        "state": state,
        "team": {"id": "259", "name": "Virginia Tech Hokies", "abbreviation": "VT", "score": team_score, "color": "#861f41"},
        "opponent": {"id": "2567", "name": "SMU Mustangs", "abbreviation": "SMU", "score": opp_score},
        "event": {"id": "401", "name": "Virginia Tech at SMU", "date": "2026-11-01T19:00:00Z", "venue": "Gerald J. Ford Stadium", "broadcast": "ESPN", "shortDetail": "8:21 - 2nd", "clock": "8:21", "period": 2},
        "field": {"possession": "team", "ball": 65, "firstDown": 72, "downDistance": "2nd & 7"},
        "updated": "2026-11-01T20:00:00Z",
    }


RACE = {
    "kind": "race", "sport": "nascar", "league": "NASCAR", "state": "PRE",
    "event": {"id": "9", "name": "Xfinity 500", "date": "2026-11-02T19:00:00Z", "venue": "Martinsville Speedway"},
    "race": {"lap": None, "totalLaps": 500, "fieldSize": 0, "leaders": []},
}


def mock_tracker(aioclient_mock, cards):
    aioclient_mock.clear_requests()
    aioclient_mock.get(f"{URL}/api/sports", json=SPORTS)
    aioclient_mock.get(f"{URL}/api/teams", json={"sport": "cfb", "teams": [{"id": "259", "name": "Virginia Tech Hokies"}]})
    aioclient_mock.get(f"{URL}/api/ha/scorecards", json={"scorecards": cards})


async def test_config_flow_connects(hass: HomeAssistant, aioclient_mock) -> None:
    mock_tracker(aioclient_mock, {})
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"url": "tracker:3000/"})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == {"url": URL}
    assert result["options"] == {CONF_FOLLOWS: []}


async def test_config_flow_cannot_connect(hass: HomeAssistant, aioclient_mock) -> None:
    aioclient_mock.get(f"{URL}/api/sports", status=404)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"url": URL})
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "cannot_connect"}


async def test_options_follow_team_event_and_remove(hass: HomeAssistant, aioclient_mock) -> None:
    mock_tracker(aioclient_mock, {})
    entry = MockConfigEntry(domain=DOMAIN, data={"url": URL}, options={CONF_FOLLOWS: []})
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["type"] is FlowResultType.MENU
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"next_step_id": "add_team"})
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"sport": "cfb"})
    assert result["step_id"] == "team"
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"team": "259"})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    assert entry.options[CONF_FOLLOWS] == [{"item": "cfb:259", "sport": "cfb", "name": "Virginia Tech Hokies"}]

    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"next_step_id": "add_event"})
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"sport": "nascar"})
    await hass.async_block_till_done()
    assert [f["item"] for f in entry.options[CONF_FOLLOWS]] == ["cfb:259", "nascar"]

    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"next_step_id": "remove"})
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"items": ["cfb:259"]})
    await hass.async_block_till_done()
    assert [f["item"] for f in entry.options[CONF_FOLLOWS]] == ["nascar"]


async def test_sensors_events_and_card(hass: HomeAssistant, aioclient_mock, hass_client) -> None:
    mock_tracker(aioclient_mock, {"cfb:259": game_card(), "nascar": RACE})
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={"url": URL},
        options={CONF_FOLLOWS: [
            {"item": "cfb:259", "sport": "cfb", "name": "Virginia Tech Hokies"},
            {"item": "nascar", "sport": "nascar", "name": "NASCAR Cup Series"},
        ]},
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    vt = hass.states.get("sensor.sports_tracker_virginia_tech_hokies")
    assert vt.state == "IN"
    assert vt.attributes["team_score"] == 7
    assert vt.attributes["opponent_name"] == "SMU Mustangs"
    assert vt.attributes["field"]["ball"] == 65
    assert vt.attributes["icon"] == "mdi:football"
    race = hass.states.get("sensor.sports_tracker_nascar_cup_series")
    assert race.state == "PRE"
    assert race.attributes["race"]["totalLaps"] == 500

    coordinator = entry.runtime_data
    assert coordinator.update_interval == INTERVAL_LIVE

    scores = async_capture_events(hass, EVENT_SCORE)
    states = async_capture_events(hass, EVENT_STATE)
    mock_tracker(aioclient_mock, {"cfb:259": game_card(team_score=14), "nascar": RACE})
    await coordinator.async_refresh()
    await hass.async_block_till_done()
    assert len(scores) == 1
    assert scores[0].data["scored_by"] == "team"
    assert scores[0].data["points"] == 7
    assert scores[0].data["scoring_team"] == "Virginia Tech Hokies"
    assert hass.states.get("sensor.sports_tracker_virginia_tech_hokies").attributes["team_score"] == 14

    mock_tracker(aioclient_mock, {"cfb:259": game_card(state="POST", team_score=14), "nascar": RACE})
    await coordinator.async_refresh()
    await hass.async_block_till_done()
    assert [(e.data["from_state"], e.data["to_state"]) for e in states] == [("IN", "POST")]

    # One item failing leaves the other sensors working.
    mock_tracker(aioclient_mock, {"cfb:259": {"error": "boom"}, "nascar": RACE})
    await coordinator.async_refresh()
    await hass.async_block_till_done()
    assert hass.states.get("sensor.sports_tracker_virginia_tech_hokies").state == "unavailable"
    assert hass.states.get("sensor.sports_tracker_nascar_cup_series").state == "PRE"

    client = await hass_client()
    resp = await client.get("/sports_tracker/sports-tracker-card.js")
    assert resp.status == 200
    assert "customElements.define('sports-tracker-card'" in await resp.text()


KEY = "k" * 32


def recap_body(headline="Hokies hold off FSU 31-24", created="2026-11-02T13:30:00Z"):
    return {
        "user": {"displayName": "Sam"},
        "enabled": True,
        "time": "07:30",
        "timeZone": "America/New_York",
        "recap": {
            "date": "2026-11-02",
            "headline": headline,
            "text": "Virginia Tech beat Florida State 31-24. Next up: at #9 Miami Saturday on ACC Network.",
            "teams": [{"sport": "cfb", "id": "259", "name": "Virginia Tech Hokies"}],
            "source": "scrappy",
            "createdAt": created,
        },
    }


async def test_recap_option_sensor_and_event(hass: HomeAssistant, aioclient_mock) -> None:
    mock_tracker(aioclient_mock, {})
    aioclient_mock.get(f"{URL}/api/account/recap", status=401)
    entry = MockConfigEntry(domain=DOMAIN, data={"url": URL}, options={CONF_FOLLOWS: []})
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    # A wrong key is turned down.
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert "recap" in result["menu_options"]
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"next_step_id": "recap"})
    result = await hass.config_entries.options.async_configure(result["flow_id"], {CONF_FEED_KEY: "wrong"})
    assert result["errors"] == {"base": "invalid_key"}

    mock_tracker(aioclient_mock, {})
    aioclient_mock.get(f"{URL}/api/account/recap", json=recap_body())
    result = await hass.config_entries.options.async_configure(result["flow_id"], {CONF_FEED_KEY: KEY})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    assert entry.options[CONF_FEED_KEY] == KEY
    assert aioclient_mock.mock_calls[-1][3]["Authorization"] == f"Bearer {KEY}"

    state = hass.states.get("sensor.sports_tracker_scrappy_recap")
    assert state.state == "Hokies hold off FSU 31-24"
    assert state.attributes["text"].startswith("Virginia Tech beat Florida State")
    assert state.attributes["written_by"] == "Scrappy"
    assert state.attributes["time"] == "07:30"

    # A new recap fires an event for automations.
    recaps = async_capture_events(hass, EVENT_RECAP)
    mock_tracker(aioclient_mock, {})
    aioclient_mock.get(f"{URL}/api/account/recap", json=recap_body("Big game Saturday", "2026-11-03T13:30:00Z"))
    await entry.runtime_data.recap.async_refresh()
    await hass.async_block_till_done()
    assert hass.states.get("sensor.sports_tracker_scrappy_recap").state == "Big game Saturday"
    assert [e.data["headline"] for e in recaps] == ["Big game Saturday"]

    # Clearing the key removes the sensor.
    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"next_step_id": "recap"})
    result = await hass.config_entries.options.async_configure(result["flow_id"], {CONF_FEED_KEY: ""})
    await hass.async_block_till_done()
    assert CONF_FEED_KEY not in entry.options
    assert entry.runtime_data.recap is None


def test_poll_interval() -> None:
    now = dt_util.utcnow()

    def at(delta, state):
        return {"x": {"state": state, "event": {"date": (now + delta).isoformat()}}}

    assert pick_interval(at(timedelta(days=3), "PRE"), now) == INTERVAL_IDLE
    assert pick_interval(at(timedelta(minutes=30), "PRE"), now) == INTERVAL_SOON
    assert pick_interval(at(timedelta(minutes=-5), "PRE"), now) == INTERVAL_LIVE
    assert pick_interval(at(timedelta(hours=-1), "IN"), now) == INTERVAL_LIVE
    assert pick_interval({}, now) == INTERVAL_IDLE

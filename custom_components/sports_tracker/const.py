"""Constants for the Sports Tracker integration."""

from datetime import timedelta

DOMAIN = "sports_tracker"

CONF_URL = "url"
# Options: the list of things to follow. Each is {"item": "cfb:259",
# "name": "Virginia Tech Hokies", "sport": "cfb"}; UFC and NASCAR items
# have no team ("nascar", "ufc").
CONF_FOLLOWS = "follows"

# The custom card ships inside the integration and is served from here.
CARD_URL = "/sports_tracker/sports-tracker-card.js"
CARD_FILENAME = "sports-tracker-card.js"

# How often Home Assistant asks the tracker for new scorecards. The
# tracker caches ESPN for ~20 seconds, so polling faster gains nothing.
INTERVAL_LIVE = timedelta(seconds=15)
INTERVAL_SOON = timedelta(minutes=1)  # a game starts within the hour
INTERVAL_TODAY = timedelta(minutes=5)  # a game today, or one just ended
INTERVAL_IDLE = timedelta(minutes=30)

# Fired on Home Assistant's event bus for automations: flash the lights in
# team colors on a score, play a fight song at kickoff...
EVENT_SCORE = "sports_tracker_score"
EVENT_STATE = "sports_tracker_game_state"

STATE_PRE = "PRE"
STATE_IN = "IN"
STATE_POST = "POST"
STATE_NOT_FOUND = "NOT_FOUND"

SPORT_ICONS = {
    "cfb": "mdi:football",
    "nfl": "mdi:football",
    "nba": "mdi:basketball",
    "mcbb": "mdi:basketball",
    "mlb": "mdi:baseball",
    "nhl": "mdi:hockey-puck",
    "ufc": "mdi:boxing-glove",
    "nascar": "mdi:flag-checkered",
}

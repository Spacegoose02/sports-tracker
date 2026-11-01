require('dotenv').config();

const { createApp } = require('./src/app');
const alerts = require('./src/alerts');

const PORT = process.env.PORT || 3000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`CFB tracker listening on port ${PORT}`);
  // Push alerts when followed teams' games start and end.
  if (process.env.GAME_ALERTS !== 'false') alerts.start();
  // Scrappy's daily recap, for accounts that turned it on.
  if (process.env.DAILY_RECAP !== 'false') app.locals.recapper.start();
});

// Web push (the browser's own notifications, no app or third-party service
// needed). Browsers require VAPID keys: set VAPID_PUBLIC_KEY and
// VAPID_PRIVATE_KEY, or leave them out and a pair is generated once and
// saved next to the database, so subscriptions keep working across
// restarts.

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const db = require('./db');

let keys = null;

function vapidKeys(env = process.env) {
  if (keys) return keys;
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  } else {
    const dataDir = env.DATA_DIR || path.join(__dirname, '..', 'data');
    const file = path.join(dataDir, 'vapid.json');
    try {
      keys = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      keys = webpush.generateVAPIDKeys();
      fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
    }
  }
  webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@localhost', keys.publicKey, keys.privateKey);
  return keys;
}

// Sends one notification to each subscription. Subscriptions the browser
// has dropped (404/410) are deleted. Returns how many were delivered.
async function sendToSubscriptions(subscriptions, payload, { send = webpush.sendNotification } = {}) {
  vapidKeys();
  const body = JSON.stringify(payload);
  let delivered = 0;
  await Promise.all(subscriptions.map(async (sub) => {
    try {
      await send({ endpoint: sub.endpoint, keys: sub.keys }, body, { TTL: 60 * 60 });
      delivered += 1;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) db.removePushSubscription(sub.endpoint);
      else console.warn('[push] send failed:', err.statusCode || err.message);
    }
  }));
  return delivered;
}

module.exports = { vapidKeys, sendToSubscriptions };

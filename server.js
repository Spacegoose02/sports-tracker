require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');

const apiRoutes = require('./src/routes/api');
const adminRoutes = require('./src/routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.use(express.json());
app.use(
  cookieSession({
    name: 'cfb_session',
    secret: process.env.SESSION_SECRET || 'please-change-this-to-a-random-string',
    maxAge: 12 * 60 * 60 * 1000, // 12 hours
    httpOnly: true,
    sameSite: 'lax',
  })
);

app.use('/api/admin', adminRoutes);
app.use('/api', apiRoutes);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`CFB tracker listening on port ${PORT}`);
});

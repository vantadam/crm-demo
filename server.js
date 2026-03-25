require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path    = require('path');

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/clients',   require('./routes/clients'));
app.use('/api/sms',       require('./routes/sms'));
app.use('/api/campaigns', require('./routes/campaigns'));

const auth = require('./middleware/auth');
app.get('/clients.html',         auth, (req, res) => res.sendFile(path.join(__dirname, 'public/clients.html')));
app.get('/sms.html',             auth, (req, res) => res.sendFile(path.join(__dirname, 'public/sms.html')));
app.get('/campaigns.html',       auth, (req, res) => res.sendFile(path.join(__dirname, 'public/campaigns.html')));
app.get('/campaign-status.html', auth, (req, res) => res.sendFile(path.join(__dirname, 'public/campaign-status.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`CRM running on http://localhost:${PORT}`);
  console.log(`Network access: http://192.168.1.32:${PORT}`);
  
  const { startWorker }       = require('./worker/emailWorker');
  const { startBouncePoller } = require('./worker/bouncePoller');
  startWorker();
  startBouncePoller();
});
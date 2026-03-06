const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../db');

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: 'Invalid credentials' });
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

router.get('/me', (req, res) => {
  if (req.session.userId) res.json({ username: req.session.username });
  else res.status(401).json({ error: 'Not authenticated' });
});

module.exports = router;
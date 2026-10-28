const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@crepo.local').toLowerCase();

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add your Postgres connection string as an environment variable.');
  process.exit(1);
}

const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      reg_no TEXT DEFAULT '',
      email TEXT UNIQUE NOT NULL,
      department TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      title TEXT NOT NULL,
      level TEXT NOT NULL,
      description TEXT DEFAULT '',
      file_name TEXT NOT NULL,
      file_data BYTEA NOT NULL,
      added_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Seed the two sample courses on first run only.
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM courses');
  if (rows[0].n === 0) {
    try {
      const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'courses.json'), 'utf8'));
      for (const c of list) {
        const p = path.join(__dirname, 'courses', path.basename(c.file));
        if (!fs.existsSync(p)) continue;
        await pool.query(
          'INSERT INTO courses (id, code, title, level, description, file_name, file_data) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
          [c.id, c.code, c.title, String(c.level), c.description || '', c.file, fs.readFileSync(p)]
        );
      }
    } catch (e) { console.log('Sample seed skipped:', e.message); }
  }
}

app.use(express.json());
app.use(session({
  store: new pgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-your-host-settings',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 1000 * 60 * 60 * 8 }
}));

const requireAuth = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: 'Please log in first.' });
const requireAdmin = (req, res, next) => req.session.user && req.session.user.isAdmin ? next() : res.status(403).json({ error: 'Admins only.' });
const wrap = fn => (req, res, next) => fn(req, res, next).catch(err => {
  console.error(err);
  res.status(500).json({ error: 'Server error. Try again.' });
});
const sessionUser = u => ({ id: u.id, fullName: u.full_name, email: u.email, department: u.department, isAdmin: u.is_admin });

/* ---------- Auth ---------- */
app.post('/api/signup', wrap(async (req, res) => {
  const { fullName, regNo, email, department, password } = req.body || {};
  if (![fullName, email, department, password].every(v => v && String(v).trim()))
    return res.status(400).json({ error: 'Fill in your name, email, department and password.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const cleanEmail = email.toLowerCase().trim();
  const exists = await pool.query('SELECT 1 FROM users WHERE email = $1', [cleanEmail]);
  if (exists.rowCount) return res.status(409).json({ error: 'An account with this email already exists.' });

  const { rows } = await pool.query(
    `INSERT INTO users (id, full_name, reg_no, email, department, password_hash, is_admin)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [crypto.randomUUID(), fullName.trim(), (regNo || '').trim(), cleanEmail, department.trim(),
     await bcrypt.hash(password, 10), cleanEmail === ADMIN_EMAIL]
  );
  req.session.user = sessionUser(rows[0]);
  res.json({ ok: true });
}));

app.post('/api/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [String(email || '').toLowerCase().trim()]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(String(password || ''), user.password_hash)))
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  req.session.user = sessionUser(user);
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => req.session.user ? res.json(req.session.user) : res.status(401).json({ error: 'Not logged in.' }));

/* ---------- Courses ---------- */
app.get('/api/courses', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id, code, title, level, description, added_at AS "addedAt" FROM courses');
  res.json(rows);
}));

const sendCourse = disposition => wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT file_name, file_data FROM courses WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).send('Course material not found.');
  const { file_name, file_data } = rows[0];
  res.type(path.extname(file_name) || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(file_name)}"`);
  res.send(file_data);
});
app.get('/read/:id', requireAuth, sendCourse('inline'));
app.get('/download/:id', requireAuth, sendCourse('attachment'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.post('/api/admin/courses', requireAuth, requireAdmin, upload.single('file'), wrap(async (req, res) => {
  const { code, title, level, description } = req.body || {};
  if (!req.file || !code || !title || !level) return res.status(400).json({ error: 'Add a file, course code, title and level.' });
  await pool.query(
    'INSERT INTO courses (id, code, title, level, description, file_name, file_data) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [crypto.randomUUID(), code.trim().toUpperCase(), title.trim(), String(level), (description || '').trim(),
     req.file.originalname.replace(/[^\w.\-]+/g, '_'), req.file.buffer]
  );
  res.json({ ok: true });
}));

app.delete('/api/admin/courses/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
  const r = await pool.query('DELETE FROM courses WHERE id = $1', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Course not found.' });
  res.json({ ok: true });
}));

/* ---------- Pages ---------- */
app.get('/library', (req, res) => req.session.user ? res.sendFile(path.join(__dirname, 'public', 'library.html')) : res.redirect('/'));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

initDb()
  .then(() => app.listen(PORT, () => console.log(`CREPO Library running on port ${PORT}. Admin email: ${ADMIN_EMAIL}`)))
  .catch(err => { console.error('Database setup failed:', err.message); process.exit(1); });

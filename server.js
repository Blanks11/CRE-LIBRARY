const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
// The account that signs up with this email becomes the admin (can upload/delete courses).
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@crepo.local').toLowerCase();

const DATA_DIR = path.join(__dirname, 'data');
const COURSE_DIR = path.join(__dirname, 'courses');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const COURSES_FILE = path.join(DATA_DIR, 'courses.json');

const read = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const write = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(24).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 }
}));

const requireAuth = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: 'Please log in first.' });
const requireAdmin = (req, res, next) => req.session.user && req.session.user.isAdmin ? next() : res.status(403).json({ error: 'Admins only.' });

/* ---------- Auth ---------- */
app.post('/api/signup', async (req, res) => {
  const { fullName, regNo, email, department, password } = req.body || {};
  if (![fullName, email, department, password].every(v => v && String(v).trim()))
    return res.status(400).json({ error: 'Fill in your name, email, department and password.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const users = read(USERS_FILE, []);
  if (users.some(u => u.email === email.toLowerCase().trim()))
    return res.status(409).json({ error: 'An account with this email already exists.' });

  const user = {
    id: crypto.randomUUID(),
    fullName: fullName.trim(),
    regNo: (regNo || '').trim(),
    email: email.toLowerCase().trim(),
    department: department.trim(),
    passwordHash: await bcrypt.hash(password, 10),
    isAdmin: email.toLowerCase().trim() === ADMIN_EMAIL,
    createdAt: new Date().toISOString()
  };
  users.push(user);
  write(USERS_FILE, users);
  req.session.user = { id: user.id, fullName: user.fullName, email: user.email, department: user.department, isAdmin: user.isAdmin };
  res.json({ ok: true });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = read(USERS_FILE, []).find(u => u.email === String(email || '').toLowerCase().trim());
  if (!user || !(await bcrypt.compare(String(password || ''), user.passwordHash)))
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  req.session.user = { id: user.id, fullName: user.fullName, email: user.email, department: user.department, isAdmin: user.isAdmin };
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => req.session.user ? res.json(req.session.user) : res.status(401).json({ error: 'Not logged in.' }));

/* ---------- Courses ---------- */
app.get('/api/courses', requireAuth, (req, res) => {
  const courses = read(COURSES_FILE, []).map(({ file, ...c }) => c);
  res.json(courses);
});

const findCourse = id => read(COURSES_FILE, []).find(c => c.id === id);
const sendCourse = (disposition) => (req, res) => {
  const c = findCourse(req.params.id);
  if (!c) return res.status(404).send('Course material not found.');
  const full = path.join(COURSE_DIR, path.basename(c.file));
  if (!fs.existsSync(full)) return res.status(404).send('File is missing on the server.');
  if (disposition === 'attachment') return res.download(full, c.file);
  res.sendFile(full);
};
app.get('/read/:id', requireAuth, sendCourse('inline'));
app.get('/download/:id', requireAuth, sendCourse('attachment'));

const upload = multer({
  storage: multer.diskStorage({
    destination: COURSE_DIR,
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^\w.\-]+/g, '_'))
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.post('/api/admin/courses', requireAuth, requireAdmin, upload.single('file'), (req, res) => {
  const { code, title, level, description } = req.body || {};
  if (!req.file || !code || !title || !level) return res.status(400).json({ error: 'Add a file, course code, title and level.' });
  const courses = read(COURSES_FILE, []);
  courses.push({
    id: crypto.randomUUID(), code: code.trim().toUpperCase(), title: title.trim(),
    level: String(level), description: (description || '').trim(), file: req.file.filename,
    addedAt: new Date().toISOString()
  });
  write(COURSES_FILE, courses);
  res.json({ ok: true });
});

app.delete('/api/admin/courses/:id', requireAuth, requireAdmin, (req, res) => {
  const courses = read(COURSES_FILE, []);
  const c = courses.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Course not found.' });
  try { fs.unlinkSync(path.join(COURSE_DIR, path.basename(c.file))); } catch {}
  write(COURSES_FILE, courses.filter(x => x.id !== c.id));
  res.json({ ok: true });
});

/* ---------- Pages ---------- */
app.get('/library', (req, res) => req.session.user ? res.sendFile(path.join(__dirname, 'public', 'library.html')) : res.redirect('/'));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

app.listen(PORT, () => {
  console.log(`\n  CREPO Library is running.\n  Open: http://localhost:${PORT}\n  Admin email: ${ADMIN_EMAIL}\n`);
});

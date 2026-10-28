const $ = id => document.getElementById(id);
let me = null, courses = [];

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function init() {
  const r = await fetch('/api/me');
  if (!r.ok) return (location.href = '/');
  me = await r.json();
  $('who').innerHTML = `Signed in as <b>${esc(me.fullName)}</b>`;
  $('dept-line').textContent = `${me.department}. Read online or download for offline study.`;
  if (me.isAdmin) $('admin-box').classList.remove('hidden');
  await load();
}

async function load() {
  const r = await fetch('/api/courses');
  if (r.status === 401) return (location.href = '/');
  courses = await r.json();
  const levels = [...new Set(courses.map(c => c.level))].sort();
  $('lvl').innerHTML = '<option value="">All levels</option>' + levels.map(l => `<option value="${l}">${l} level</option>`).join('');
  render();
}

function render() {
  const q = $('q').value.toLowerCase().trim(), lvl = $('lvl').value;
  const rows = courses
    .filter(c => (!lvl || c.level === lvl) && (!q || (c.code + ' ' + c.title).toLowerCase().includes(q)))
    .sort((a, b) => a.level.localeCompare(b.level) || a.code.localeCompare(b.code));

  if (!rows.length) {
    $('list').innerHTML = `<div class="empty">${courses.length ? 'No course matches your search. Try a different code or title.' : 'No course materials yet. Check back soon.'}</div>`;
    return;
  }
  $('list').innerHTML = rows.map(c => `
    <article class="course">
      <div class="code">${esc(c.code)}</div>
      <div>
        <div class="meta">${esc(c.level)} level</div>
        <h3>${esc(c.title)}</h3>
        ${c.description ? `<p>${esc(c.description)}</p>` : ''}
      </div>
      <div class="actions">
        <a class="btn ghost small" href="/read/${c.id}" target="_blank" rel="noopener">Read</a>
        <a class="btn alt small" href="/download/${c.id}">Download</a>
        ${me.isAdmin ? `<button class="btn danger small" data-del="${c.id}">Delete</button>` : ''}
      </div>
    </article>`).join('');
}

$('q').oninput = render;
$('lvl').onchange = render;

$('list').onclick = async e => {
  const id = e.target.dataset.del;
  if (!id || !confirm('Delete this course material permanently?')) return;
  await fetch('/api/admin/courses/' + id, { method: 'DELETE' });
  load();
};

$('logout').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/'; };

$('upload-form').onsubmit = async e => {
  e.preventDefault();
  const err = $('upload-error'); err.classList.remove('show');
  const fd = new FormData();
  fd.append('code', $('u-code').value); fd.append('title', $('u-title').value);
  fd.append('level', $('u-level').value); fd.append('description', $('u-desc').value);
  fd.append('file', $('u-file').files[0]);
  const r = await fetch('/api/admin/courses', { method: 'POST', body: fd });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { err.textContent = d.error || 'Upload failed.'; err.classList.add('show'); return; }
  e.target.reset(); load();
};

init();

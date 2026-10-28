const $ = id => document.getElementById(id);
const tabs = { login: $('tab-login'), signup: $('tab-signup') };
const forms = { login: $('login-form'), signup: $('signup-form') };

function show(which) {
  for (const k of ['login', 'signup']) {
    tabs[k].setAttribute('aria-selected', k === which);
    forms[k].classList.toggle('hidden', k !== which);
  }
}
tabs.login.onclick = () => show('login');
tabs.signup.onclick = () => show('signup');

$('s-dept').onchange = e => $('other-wrap').classList.toggle('hidden', e.target.value !== 'Other');

function fail(id, msg) { const el = $(id); el.textContent = msg; el.classList.add('show'); }

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

forms.login.onsubmit = async e => {
  e.preventDefault();
  $('login-error').classList.remove('show');
  try {
    await post('/api/login', { email: $('l-email').value, password: $('l-pass').value });
    location.href = '/library';
  } catch (err) { fail('login-error', err.message); }
};

forms.signup.onsubmit = async e => {
  e.preventDefault();
  $('signup-error').classList.remove('show');
  let department = $('s-dept').value;
  if (department === 'Other') department = $('s-other').value;
  try {
    await post('/api/signup', {
      fullName: $('s-name').value, regNo: $('s-reg').value, email: $('s-email').value,
      department, password: $('s-pass').value
    });
    location.href = '/library';
  } catch (err) { fail('signup-error', err.message); }
};

(function () {
  "use strict";

  var state = { user: null, equipment: [] };

  // ---------------- helpers ----------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { return '₹' + Number(n || 0).toFixed(0); }
  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function todayISO() { return new Date().toISOString().slice(0, 10); }
  function addDaysISO(iso, days) { var d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }

  async function api(method, url, body) {
    var res = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: body ? JSON.stringify(body) : undefined
    });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  function openModal(html) {
    document.getElementById('modalBody').innerHTML = html;
    document.getElementById('modalBackdrop').classList.add('open');
  }
  function closeModal() {
    document.getElementById('modalBackdrop').classList.remove('open');
    document.getElementById('modalBody').innerHTML = '';
  }

  // ---------------- auth ----------------
  async function refreshMe() {
    var data = await api('GET', '/api/auth/me');
    state.user = data.user;
    renderAuthArea();
  }

  function renderAuthArea() {
    var el = document.getElementById('authArea');
    if (state.user) {
      el.innerHTML =
        '<div class="who">Signed in as <b>' + esc(state.user.name) + '</b></div>' +
        '<button class="btn small" id="logoutBtn">Log out</button>';
      document.getElementById('logoutBtn').addEventListener('click', async function () {
        await api('POST', '/api/auth/logout');
        state.user = null;
        renderAuthArea();
        renderMyLoansGate();
      });
    } else {
      el.innerHTML = '<button class="btn primary small" id="loginOpenBtn">Log in / Register</button>';
      document.getElementById('loginOpenBtn').addEventListener('click', function () { openAuthModal(); });
    }
  }

  function openAuthModal(afterMessage) {
    var body =
      '<h3>Student account</h3>' +
      '<p class="modal-sub">' + (afterMessage || 'Log in or create an account to request gear.') + '</p>' +
      '<div class="modal-tabs">' +
        '<button class="active" id="tabLogin">Log in</button>' +
        '<button id="tabRegister">Register</button>' +
      '</div>' +
      '<div id="authFormArea"></div>' +
      '<div id="authError"></div>';
    openModal(body);
    document.getElementById('tabLogin').addEventListener('click', function () { setAuthTab('login'); });
    document.getElementById('tabRegister').addEventListener('click', function () { setAuthTab('register'); });
    setAuthTab('login');
  }

  function setAuthTab(tab) {
    document.getElementById('tabLogin').classList.toggle('active', tab === 'login');
    document.getElementById('tabRegister').classList.toggle('active', tab === 'register');
    var area = document.getElementById('authFormArea');
    document.getElementById('authError').innerHTML = '';
    if (tab === 'login') {
      area.innerHTML =
        '<label class="field"><span class="field-label">Email</span><input type="email" id="loginEmail"></label>' +
        '<label class="field"><span class="field-label">Password</span><input type="password" id="loginPassword"></label>' +
        '<div class="modal-actions">' +
          '<button class="btn" onclick="AVAPP.closeModal()">Cancel</button>' +
          '<button class="btn primary" id="loginSubmit">Log in</button>' +
        '</div>';
      document.getElementById('loginSubmit').addEventListener('click', doLogin);
    } else {
      area.innerHTML =
        '<label class="field"><span class="field-label">Full name</span><input type="text" id="regName"></label>' +
        '<label class="field"><span class="field-label">Email</span><input type="email" id="regEmail"></label>' +
        '<label class="field"><span class="field-label">Password</span><input type="password" id="regPassword" placeholder="At least 6 characters"></label>' +
        '<div class="modal-actions">' +
          '<button class="btn" onclick="AVAPP.closeModal()">Cancel</button>' +
          '<button class="btn primary" id="regSubmit">Create account</button>' +
        '</div>';
      document.getElementById('regSubmit').addEventListener('click', doRegister);
    }
  }

  function showAuthError(msg) {
    document.getElementById('authError').innerHTML = '<div class="banner error">' + esc(msg) + '</div>';
  }

  async function doLogin() {
    var email = document.getElementById('loginEmail').value.trim();
    var password = document.getElementById('loginPassword').value;
    try {
      var data = await api('POST', '/api/auth/login', { email: email, password: password });
      state.user = data.user;
      closeModal();
      renderAuthArea();
      renderMyLoansGate();
    } catch (e) { showAuthError(e.message); }
  }

  async function doRegister() {
    var name = document.getElementById('regName').value.trim();
    var email = document.getElementById('regEmail').value.trim();
    var password = document.getElementById('regPassword').value;
    try {
      var data = await api('POST', '/api/auth/register', { name: name, email: email, password: password });
      state.user = data.user;
      closeModal();
      renderAuthArea();
      renderMyLoansGate();
    } catch (e) { showAuthError(e.message); }
  }

  // ---------------- catalog ----------------
  async function loadEquipment() {
    var data = await api('GET', '/api/equipment');
    state.equipment = data.equipment;
    renderCatalog();
    renderHeaderStat();
  }

  function renderHeaderStat() {
    var total = state.equipment.reduce(function (sum, e) { return sum + e.availableUnits; }, 0);
    document.getElementById('hdrAvailable').textContent = total;
  }

  function renderCatalog() {
    var grid = document.getElementById('eqGrid');
    if (state.equipment.length === 0) {
      grid.innerHTML = '<div class="empty-state">Nothing logged yet. Staff can add equipment from the staff desk.</div>';
      return;
    }
    var sorted = state.equipment.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    grid.innerHTML = sorted.map(function (eq) {
      var canRequest = eq.availableUnits > 0;
      var dots = '';
      for (var i = 0; i < Math.min(eq.totalUnits, 10); i++) {
        dots += '<span class="unit-dot ' + (i < eq.availableUnits ? 'avail' : 'out') + '"></span>';
      }
      return '' +
        '<div class="eq-card">' +
          '<span class="hole"></span>' +
          '<div class="eq-cat">' + esc((eq.category || '').toUpperCase()) + '</div>' +
          '<h3 class="eq-name">' + esc(eq.name) + '</h3>' +
          '<p class="eq-desc">' + esc(eq.description || '') + '</p>' +
          '<div class="unit-row">' + dots + '<span class="avail-text">' + eq.availableUnits + ' of ' + eq.totalUnits + ' free</span></div>' +
          '<div class="eq-meta">' +
            '<span>Deposit <b>' + money(eq.depositAmount) + '</b></span>' +
            '<span>Late fee <b>' + money(eq.lateFeePerDay) + '/day</b></span>' +
          '</div>' +
          '<button class="btn primary" style="width:100%;" ' + (canRequest ? '' : 'disabled') + ' onclick="AVAPP.borrowClicked(\'' + eq.id + '\')">' +
            (canRequest ? 'Request to borrow' : 'None free right now') +
          '</button>' +
        '</div>';
    }).join('');
  }

  function borrowClicked(eqId) {
    if (!state.user) { openAuthModal('Log in or create a free account to request this item.'); return; }
    openRequestModal(eqId);
  }

  function openRequestModal(eqId) {
    var eq = state.equipment.find(function (e) { return e.id === eqId; });
    if (!eq) return;
    var defaultDue = addDaysISO(todayISO(), eq.maxLoanDays);
    var body =
      '<h3>Request: ' + esc(eq.name) + '</h3>' +
      '<p class="modal-sub">' + eq.availableUnits + ' free right now · deposit ' + money(eq.depositAmount) + ' · late fee ' + money(eq.lateFeePerDay) + '/day</p>' +
      '<label class="field"><span class="field-label">Needed until</span><input type="date" id="reqDue" value="' + defaultDue + '" min="' + todayISO() + '"></label>' +
      '<label class="field"><span class="field-label">Note for staff (optional)</span><textarea id="reqNote" placeholder="e.g. for the film club shoot Saturday"></textarea></label>' +
      '<div id="reqError"></div>' +
      '<div class="modal-actions">' +
        '<button class="btn" onclick="AVAPP.closeModal()">Cancel</button>' +
        '<button class="btn primary" id="reqSubmit">Send request</button>' +
      '</div>';
    openModal(body);
    document.getElementById('reqSubmit').addEventListener('click', function () { submitRequest(eqId); });
  }

  async function submitRequest(eqId) {
    var due = document.getElementById('reqDue').value;
    var note = document.getElementById('reqNote').value.trim();
    try {
      await api('POST', '/api/loans', { equipmentId: eqId, dueDate: due, note: note });
      closeModal();
      await loadEquipment();
      switchTab('myloans');
      loadMyLoans();
    } catch (e) {
      document.getElementById('reqError').innerHTML = '<div class="banner error">' + esc(e.message) + '</div>';
    }
  }

  // ---------------- my loans ----------------
  function renderMyLoansGate() {
    var gate = document.getElementById('myLoansGate');
    var results = document.getElementById('myLoansResults');
    if (!state.user) {
      gate.innerHTML = '<div class="empty-state">Log in to see your loans.<br><br><button class="btn primary" id="myLoansLoginBtn">Log in / Register</button></div>';
      document.getElementById('myLoansLoginBtn').addEventListener('click', function () { openAuthModal(); });
      results.innerHTML = '';
    } else {
      gate.innerHTML = '';
      loadMyLoans();
    }
  }

  async function loadMyLoans() {
    var results = document.getElementById('myLoansResults');
    if (!state.user) return;
    try {
      var data = await api('GET', '/api/loans/mine');
      if (data.loans.length === 0) {
        results.innerHTML = '<div class="empty-state">No loans yet — go grab something from the catalog.</div>';
        return;
      }
      results.innerHTML = data.loans.map(renderLoanRow).join('');
    } catch (e) {
      results.innerHTML = '<div class="banner error">' + esc(e.message) + '</div>';
    }
  }

  function statusPillFor(loan) {
    var status = loan.status, cls = status, label = status;
    if (status === 'approved' && loan.dueDate < todayISO()) { label = 'overdue'; cls = 'overdue'; }
    return '<span class="pill ' + cls + '">' + esc(label) + '</span>';
  }

  function renderLoanRow(loan) {
    var sub = '';
    if (loan.status === 'pending') sub = 'Requested ' + fmtDate(loan.requestedAt.slice(0, 10)) + ' · waiting on staff approval';
    else if (loan.status === 'approved') sub = (loan.unitLabel ? loan.unitLabel + ' · ' : '') + 'due back ' + fmtDate(loan.dueDate);
    else if (loan.status === 'returned') sub = 'Returned ' + fmtDate(loan.returnedAt.slice(0, 10)) + (loan.lateFeeCharged ? ' · late fee ' + money(loan.lateFeeCharged) : '') + ' · deposit refunded ' + money(loan.depositRefunded);
    else if (loan.status === 'rejected') sub = 'Request declined by staff';
    return '' +
      '<div class="row-card">' +
        '<div class="rc-main"><div class="rc-title">' + esc(loan.equipmentName) + '</div><div class="rc-sub">' + esc(sub) + '</div></div>' +
        statusPillFor(loan) +
      '</div>';
  }

  // ---------------- tabs ----------------
  function switchTab(tab) {
    document.querySelectorAll('nav.tabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === tab); });
    document.querySelectorAll('section.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + tab); });
  }

  // ---------------- init ----------------
  document.addEventListener('DOMContentLoaded', async function () {
    document.querySelectorAll('nav.tabs button').forEach(function (b) {
      b.addEventListener('click', function () {
        switchTab(b.dataset.tab);
        if (b.dataset.tab === 'myloans') renderMyLoansGate();
      });
    });
    document.getElementById('modalBackdrop').addEventListener('click', function (e) {
      if (e.target === document.getElementById('modalBackdrop')) closeModal();
    });
    await refreshMe();
    await loadEquipment();
  });

  window.AVAPP = { closeModal: closeModal, borrowClicked: borrowClicked };
})();

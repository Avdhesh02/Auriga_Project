(function () {
  "use strict";

  var state = { user: null, subtab: 'requests', equipment: [], loans: [], settings: {} };

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
  function daysBetween(a, b) {
    var da = new Date(a + 'T00:00:00'), db = new Date(b + 'T00:00:00');
    return Math.round((db - da) / 86400000);
  }

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
  async function checkSession() {
    var data = await api('GET', '/api/auth/me');
    if (data.user && data.user.role === 'staff') {
      state.user = data.user;
      showPanel();
    } else {
      state.user = null;
    }
  }

  async function staffLogin() {
    var email = document.getElementById('staffEmail').value.trim();
    var password = document.getElementById('staffPassword').value;
    try {
      var data = await api('POST', '/api/staff/login', { email: email, password: password });
      state.user = data.user;
      showPanel();
    } catch (e) {
      document.getElementById('staffLoginError').innerHTML = '<div class="banner error">' + esc(e.message) + '</div>';
    }
  }

  function showPanel() {
    document.getElementById('staffLockScreen').style.display = 'none';
    document.getElementById('staffPanel').style.display = 'block';
    document.getElementById('staffTabs').style.display = 'flex';
    renderAuthArea();
    switchSub('requests');
    loadAll();
  }

  function renderAuthArea() {
    document.getElementById('authArea').innerHTML =
      '<div class="who">Signed in as <b>' + esc(state.user.name) + '</b></div>' +
      '<button class="btn small" id="logoutBtn">Log out</button>';
    document.getElementById('logoutBtn').addEventListener('click', async function () {
      await api('POST', '/api/auth/logout');
      window.location.reload();
    });
  }

  // ---------------- data loading ----------------
  async function loadAll() {
    var [eq, loans, settings] = await Promise.all([
      api('GET', '/api/equipment'),
      api('GET', '/api/loans'),
      api('GET', '/api/settings')
    ]);
    state.equipment = eq.equipment;
    state.loans = loans.loans;
    state.settings = settings.settings;
    renderCurrent();
  }

  function availableCountFor(eqId) {
    var eq = state.equipment.find(function (e) { return e.id === eqId; });
    return eq ? eq.availableUnits : 0;
  }
  function activeLoansForBorrower(borrowerId, excludeLoanId) {
    return state.loans.filter(function (l) {
      return l.borrowerId === borrowerId && l.id !== excludeLoanId && (l.status === 'pending' || l.status === 'approved');
    });
  }

  // ---------------- subtabs ----------------
  function switchSub(tab) {
    state.subtab = tab;
    document.querySelectorAll('#staffTabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.staff === tab); });
    document.querySelectorAll('.staff-view').forEach(function (v) { v.style.display = (v.id === 'staff-' + tab) ? 'block' : 'none'; });
    renderCurrent();
  }
  function renderCurrent() {
    if (!state.user) return;
    if (state.subtab === 'requests') renderRequests();
    if (state.subtab === 'active') renderActive();
    if (state.subtab === 'equipment') renderEquipment();
    if (state.subtab === 'team') renderTeam();
    if (state.subtab === 'settings') renderSettings();
  }

  // ---------------- requests ----------------
  function renderRequests() {
    var el = document.getElementById('staff-requests');
    var pending = state.loans.filter(function (l) { return l.status === 'pending'; });
    if (pending.length === 0) { el.innerHTML = '<div class="empty-state">No pending requests. Nice and caught up.</div>'; return; }
    el.innerHTML = pending.map(function (l) {
      var avail = availableCountFor(l.equipmentId);
      var activeCount = activeLoansForBorrower(l.borrowerId, l.id).length;
      var limit = state.settings.maxActiveLoansPerBorrower;
      var warn = '';
      if (avail === 0) warn = '<div class="banner warn" style="margin:8px 0 0;">No units free — approving isn\'t possible until one is returned.</div>';
      else if (limit && activeCount >= limit) warn = '<div class="banner warn" style="margin:8px 0 0;">This borrower already has ' + activeCount + ' active loan(s), at or over the limit of ' + limit + '.</div>';
      return '' +
        '<div class="row-card" style="align-items:flex-start;">' +
          '<div class="rc-main">' +
            '<div class="rc-title">' + esc(l.equipmentName) + ' — ' + esc(l.borrowerName) + '</div>' +
            '<div class="rc-sub">' + esc(l.borrowerEmail) + ' · wants it until ' + fmtDate(l.dueDate) + (l.note ? ' · "' + esc(l.note) + '"' : '') + '</div>' +
            warn +
          '</div>' +
          '<div class="rc-actions">' +
            '<button class="btn small danger" onclick="AVSTAFF.rejectLoan(\'' + l.id + '\')">Reject</button>' +
            '<button class="btn small primary" onclick="AVSTAFF.approveLoan(\'' + l.id + '\')">Approve</button>' +
          '</div>' +
        '</div>';
    }).join('');
  }

  async function approveLoan(id) {
    try { await api('PATCH', '/api/loans/' + id + '/approve'); await loadAll(); }
    catch (e) { alert(e.message); }
  }
  async function rejectLoan(id) {
    try { await api('PATCH', '/api/loans/' + id + '/reject'); await loadAll(); }
    catch (e) { alert(e.message); }
  }

  // ---------------- active & overdue ----------------
  function renderActive() {
    var el = document.getElementById('staff-active');
    var active = state.loans.filter(function (l) { return l.status === 'approved'; })
      .sort(function (a, b) { return a.dueDate.localeCompare(b.dueDate); });
    if (active.length === 0) { el.innerHTML = '<div class="empty-state">Nothing checked out right now.</div>'; return; }
    el.innerHTML = active.map(function (l) {
      var overdue = l.dueDate < todayISO();
      var daysLate = overdue ? daysBetween(l.dueDate, todayISO()) : 0;
      return '' +
        '<div class="row-card">' +
          '<div class="rc-main">' +
            '<div class="rc-title">' + esc(l.equipmentName) + (l.unitLabel ? ' (' + esc(l.unitLabel) + ')' : '') + ' — ' + esc(l.borrowerName) + '</div>' +
            '<div class="rc-sub">' + esc(l.borrowerEmail) + ' · due ' + fmtDate(l.dueDate) + (overdue ? ' · ' + daysLate + ' day(s) late' : '') + '</div>' +
          '</div>' +
          (overdue ? '<span class="pill overdue">overdue</span>' : '<span class="pill approved">on loan</span>') +
          '<div class="rc-actions"><button class="btn small primary" onclick="AVSTAFF.openReturnModal(\'' + l.id + '\')">Record return</button></div>' +
        '</div>';
    }).join('');
  }

  function openReturnModal(loanId) {
    var loan = state.loans.find(function (l) { return l.id === loanId; });
    if (!loan) return;
    var overdue = loan.dueDate < todayISO();
    var daysLate = overdue ? daysBetween(loan.dueDate, todayISO()) : 0;
    var lateFee = daysLate * loan.lateFeePerDay;
    var refund = Math.max(0, loan.depositAmount - lateFee);
    var body =
      '<h3>Return: ' + esc(loan.equipmentName) + '</h3>' +
      '<p class="modal-sub">Borrower: ' + esc(loan.borrowerName) + ' · due ' + fmtDate(loan.dueDate) + '</p>' +
      (overdue ? '<div class="banner warn">' + daysLate + ' day(s) late × ' + money(loan.lateFeePerDay) + '/day = ' + money(lateFee) + ' late fee</div>' : '<div class="banner info">Returned on time — no late fee.</div>') +
      '<div class="eq-meta" style="border:none; padding:0; margin: 12px 0;">' +
        '<span>Deposit held <b>' + money(loan.depositAmount) + '</b></span>' +
        '<span>Refund due <b>' + money(refund) + '</b></span>' +
      '</div>' +
      '<div class="modal-actions">' +
        '<button class="btn" onclick="AVSTAFF.closeModal()">Cancel</button>' +
        '<button class="btn primary" id="confirmReturnBtn">Confirm return</button>' +
      '</div>';
    openModal(body);
    document.getElementById('confirmReturnBtn').addEventListener('click', function () { confirmReturn(loanId); });
  }

  async function confirmReturn(loanId) {
    try { await api('PATCH', '/api/loans/' + loanId + '/return'); closeModal(); await loadAll(); }
    catch (e) { alert(e.message); }
  }

  // ---------------- equipment ----------------
  function renderEquipment() {
    var el = document.getElementById('staff-equipment');
    var html = '<button class="btn primary" style="margin-bottom:16px;" onclick="AVSTAFF.openAddEquipmentModal()">+ Add equipment</button>';
    if (state.equipment.length === 0) {
      html += '<div class="empty-state">Nothing added yet.</div>';
    } else {
      html += state.equipment.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (eq) {
        return '' +
          '<div class="settings-box" id="eqbox-' + eq.id + '">' +
            '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">' +
              '<div><div class="rc-title">' + esc(eq.name) + '</div><div class="rc-sub">' + esc(eq.category) + ' · deposit ' + money(eq.depositAmount) + ' · late fee ' + money(eq.lateFeePerDay) + '/day · max ' + eq.maxLoanDays + ' day(s) · ' + eq.availableUnits + '/' + eq.totalUnits + ' free</div></div>' +
              '<button class="btn small" onclick="AVSTAFF.openAddUnitModal(\'' + eq.id + '\')">+ Add unit</button>' +
            '</div>' +
            '<div class="unit-list" style="margin-top:12px;">Loading units…</div>' +
          '</div>';
      }).join('');
    }
    el.innerHTML = html;
    // fetch unit detail per equipment (staff-only endpoint)
    state.equipment.forEach(function (eq) { loadUnitsFor(eq.id); });
  }

  async function loadUnitsFor(eqId) {
    try {
      var data = await api('GET', '/api/equipment/' + eqId + '/units');
      var box = document.getElementById('eqbox-' + eqId);
      if (!box) return;
      var list = box.querySelector('.unit-list');
      var loans = state.loans.filter(function (l) { return l.status === 'approved' && l.equipmentId === eqId; });
      list.innerHTML = data.units.map(function (u) {
        var loan = loans.find(function (l) { return l.unitId === u.id; });
        var toggleDisabled = u.status === 'borrowed';
        return '<div class="row-card" style="padding:8px 12px; margin-bottom:6px;">' +
          '<div class="rc-main"><div class="rc-title" style="font-size:13px;">' + esc(u.label) + '</div>' +
          '<div class="rc-sub">' + (loan ? 'with ' + esc(loan.borrowerName) + ' until ' + fmtDate(loan.dueDate) : esc(u.status)) + '</div></div>' +
          '<div class="rc-actions"><button class="btn small" ' + (toggleDisabled ? 'disabled' : '') + ' onclick="AVSTAFF.toggleUnit(\'' + u.id + '\')">' +
            (u.status === 'maintenance' ? 'Mark available' : 'Mark maintenance') +
          '</button></div></div>';
      }).join('') || '<div class="rc-sub">No units yet.</div>';
    } catch (e) { /* ignore */ }
  }

  async function toggleUnit(unitId) {
    try { await api('PATCH', '/api/units/' + unitId); await loadAll(); }
    catch (e) { alert(e.message); }
  }

  function openAddEquipmentModal() {
    var body =
      '<h3>Add equipment</h3>' +
      '<label class="field"><span class="field-label">Name</span><input type="text" id="newEqName" placeholder="e.g. Sony A7 III"></label>' +
      '<label class="field"><span class="field-label">Category</span><input type="text" id="newEqCat" placeholder="Camera / Projector / Audio / Support"></label>' +
      '<label class="field"><span class="field-label">Description</span><textarea id="newEqDesc"></textarea></label>' +
      '<div class="field-row">' +
        '<label class="field"><span class="field-label">Units to add</span><input type="number" id="newEqUnits" value="1" min="1" max="30"></label>' +
        '<label class="field"><span class="field-label">Max loan length (days)</span><input type="number" id="newEqMaxDays" value="' + (state.settings.defaultLoanDays || 7) + '" min="1"></label>' +
      '</div>' +
      '<div class="field-row">' +
        '<label class="field"><span class="field-label">Deposit</span><input type="number" id="newEqDeposit" value="0" min="0"></label>' +
        '<label class="field"><span class="field-label">Late fee per day</span><input type="number" id="newEqLateFee" value="0" min="0"></label>' +
      '</div>' +
      '<div class="modal-actions">' +
        '<button class="btn" onclick="AVSTAFF.closeModal()">Cancel</button>' +
        '<button class="btn primary" id="addEqSubmit">Add to catalog</button>' +
      '</div>';
    openModal(body);
    document.getElementById('addEqSubmit').addEventListener('click', submitNewEquipment);
  }

  async function submitNewEquipment() {
    var payload = {
      name: document.getElementById('newEqName').value.trim(),
      category: document.getElementById('newEqCat').value.trim(),
      description: document.getElementById('newEqDesc').value.trim(),
      unitCount: document.getElementById('newEqUnits').value,
      maxLoanDays: document.getElementById('newEqMaxDays').value,
      depositAmount: document.getElementById('newEqDeposit').value,
      lateFeePerDay: document.getElementById('newEqLateFee').value
    };
    try { await api('POST', '/api/equipment', payload); closeModal(); await loadAll(); }
    catch (e) { alert(e.message); }
  }

  function openAddUnitModal(eqId) {
    var eq = state.equipment.find(function (e) { return e.id === eqId; });
    var body =
      '<h3>Add a unit to ' + esc(eq.name) + '</h3>' +
      '<label class="field"><span class="field-label">Label</span><input type="text" id="newUnitLabel" value="' + esc(eq.name) + ' #' + (eq.totalUnits + 1) + '"></label>' +
      '<div class="modal-actions">' +
        '<button class="btn" onclick="AVSTAFF.closeModal()">Cancel</button>' +
        '<button class="btn primary" id="addUnitSubmit">Add unit</button>' +
      '</div>';
    openModal(body);
    document.getElementById('addUnitSubmit').addEventListener('click', function () { submitNewUnit(eqId); });
  }

  async function submitNewUnit(eqId) {
    var label = document.getElementById('newUnitLabel').value.trim();
    try { await api('POST', '/api/equipment/' + eqId + '/units', { label: label }); closeModal(); await loadAll(); }
    catch (e) { alert(e.message); }
  }

  // ---------------- staff accounts ----------------
  function renderTeam() {
    var el = document.getElementById('staff-team');
    el.innerHTML =
      '<div class="settings-box">' +
        '<div class="rc-title" style="margin-bottom:12px;">Add a staff account</div>' +
        '<p class="lede">Staff accounts are completely separate from student accounts — this is what keeps approvals and inventory changes restricted to the desk.</p>' +
        '<label class="field"><span class="field-label">Name</span><input type="text" id="newStaffName"></label>' +
        '<label class="field"><span class="field-label">Email</span><input type="email" id="newStaffEmail"></label>' +
        '<label class="field"><span class="field-label">Password</span><input type="password" id="newStaffPassword" placeholder="At least 6 characters"></label>' +
        '<div id="newStaffMsg"></div>' +
        '<button class="btn primary" id="addStaffBtn">Create staff account</button>' +
      '</div>';
    document.getElementById('addStaffBtn').addEventListener('click', addStaffAccount);
  }

  async function addStaffAccount() {
    var payload = {
      name: document.getElementById('newStaffName').value.trim(),
      email: document.getElementById('newStaffEmail').value.trim(),
      password: document.getElementById('newStaffPassword').value
    };
    var msg = document.getElementById('newStaffMsg');
    try {
      await api('POST', '/api/staff/register', payload);
      msg.innerHTML = '<div class="banner info">Staff account created.</div>';
      document.getElementById('newStaffName').value = '';
      document.getElementById('newStaffEmail').value = '';
      document.getElementById('newStaffPassword').value = '';
    } catch (e) {
      msg.innerHTML = '<div class="banner error">' + esc(e.message) + '</div>';
    }
  }

  // ---------------- settings ----------------
  function renderSettings() {
    var el = document.getElementById('staff-settings');
    el.innerHTML =
      '<div class="settings-box">' +
        '<div class="rc-title" style="margin-bottom:12px;">Room rules</div>' +
        '<div class="field-row">' +
          '<label class="field"><span class="field-label">Max active loans per borrower</span><input type="number" id="setLimit" value="' + state.settings.maxActiveLoansPerBorrower + '" min="1"></label>' +
          '<label class="field"><span class="field-label">Default loan length (days)</span><input type="number" id="setDefaultDays" value="' + state.settings.defaultLoanDays + '" min="1"></label>' +
        '</div>' +
        '<div id="setMsg"></div>' +
        '<button class="btn primary" id="saveSettingsBtn">Save settings</button>' +
      '</div>';
    document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
  }

  async function saveSettings() {
    var payload = {
      maxActiveLoansPerBorrower: document.getElementById('setLimit').value,
      defaultLoanDays: document.getElementById('setDefaultDays').value
    };
    try {
      var data = await api('PATCH', '/api/settings', payload);
      state.settings = data.settings;
      document.getElementById('setMsg').innerHTML = '<div class="banner info">Saved.</div>';
    } catch (e) {
      document.getElementById('setMsg').innerHTML = '<div class="banner error">' + esc(e.message) + '</div>';
    }
  }

  // ---------------- init ----------------
  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('staffLoginBtn').addEventListener('click', staffLogin);
    document.getElementById('staffPassword').addEventListener('keydown', function (e) { if (e.key === 'Enter') staffLogin(); });
    document.querySelectorAll('#staffTabs button').forEach(function (b) {
      b.addEventListener('click', function () { switchSub(b.dataset.staff); });
    });
    document.getElementById('modalBackdrop').addEventListener('click', function (e) {
      if (e.target === document.getElementById('modalBackdrop')) closeModal();
    });
    checkSession();
  });

  window.AVSTAFF = {
    closeModal: closeModal,
    approveLoan: approveLoan,
    rejectLoan: rejectLoan,
    openReturnModal: openReturnModal,
    toggleUnit: toggleUnit,
    openAddEquipmentModal: openAddEquipmentModal,
    openAddUnitModal: openAddUnitModal
  };
})();

(function () {
  "use strict";

  var A = window.AV;
  var state = {
    user: null,
    equipment: [],
    loans: [],
    handovers: { incoming: [], outgoing: [] },
    filter: { q: '', category: 'all', freeBy: '' }
  };

  // ---------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------
  async function loadEquipment() {
    var data = await A.api('GET', '/api/equipment');
    state.equipment = data.equipment;
    renderCatalogChips();
    renderCatalog();
    document.getElementById('hdrAvailable').textContent =
      state.equipment.reduce(function (s, e) { return s + e.availableUnits; }, 0);
  }

  async function loadMine() {
    if (!state.user) {
      state.loans = [];
      state.handovers = { incoming: [], outgoing: [] };
      renderCounts();
      return;
    }
    var results = await Promise.all([A.api('GET', '/api/loans/mine'), A.api('GET', '/api/transfers/mine')]);
    state.loans = results[0].loans;
    state.handovers = { incoming: results[1].incoming, outgoing: results[1].outgoing };
    renderCounts();
  }

  async function refreshAll() {
    await Promise.all([loadEquipment(), loadMine()]);
    renderMyLoans();
    renderHandovers();
  }

  function renderCounts() {
    var openLoans = state.loans.filter(function (l) { return l.status === 'pending' || l.status === 'approved'; }).length;
    var waiting = state.handovers.incoming.filter(function (t) { return t.status === 'pending'; }).length;
    var lo = document.getElementById('cntLoans');
    var ho = document.getElementById('cntHandovers');
    lo.textContent = openLoans;
    lo.className = 'tab-count' + (openLoans ? '' : ' quiet');
    ho.textContent = waiting;
    ho.className = 'tab-count' + (waiting ? '' : ' quiet');
  }

  // ---------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------
  async function refreshMe() {
    var data = await A.api('GET', '/api/auth/me');
    state.user = data.user && data.user.role === 'student' ? data.user : null;
    renderAuthArea();
  }

  function renderAuthArea() {
    var el = document.getElementById('authArea');
    if (state.user) {
      el.innerHTML =
        '<div class="who">Signed in as <b>' + A.esc(state.user.name) + '</b></div>' +
        '<button class="btn small" data-action="logout">Log out</button>';
    } else {
      el.innerHTML = '<button class="btn primary small" data-action="open-auth">Log in or register</button>';
    }
  }

  function openAuthModal(message) {
    A.openModal(
      '<h3>Student account</h3>' +
      '<p class="modal-sub">' + A.esc(message || 'Sign in to request gear and track what you have out.') + '</p>' +
      '<div class="modal-tabs">' +
        '<button class="active" data-action="auth-tab" data-tab="login">Log in</button>' +
        '<button data-action="auth-tab" data-tab="register">Register</button>' +
      '</div>' +
      '<div id="authFormArea"></div>' +
      '<div id="authError"></div>'
    );
    setAuthTab('login');
  }

  function setAuthTab(tab) {
    document.querySelectorAll('[data-action="auth-tab"]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    document.getElementById('authError').innerHTML = '';
    document.getElementById('authFormArea').innerHTML = tab === 'login'
      ? '<label class="field"><span class="field-label">Email</span><input type="email" id="loginEmail" autocomplete="email"></label>' +
        '<label class="field"><span class="field-label">Password</span><input type="password" id="loginPassword" autocomplete="current-password"></label>' +
        '<div class="modal-actions"><button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn primary" data-action="do-login">Log in</button></div>'
      : '<label class="field"><span class="field-label">Full name</span><input type="text" id="regName"></label>' +
        '<label class="field"><span class="field-label">Email</span><input type="email" id="regEmail" autocomplete="email"></label>' +
        '<label class="field"><span class="field-label">Password</span><input type="password" id="regPassword" placeholder="At least 6 characters" autocomplete="new-password"></label>' +
        '<div class="modal-actions"><button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn primary" data-action="do-register">Create account</button></div>';
    var input = document.querySelector('#authFormArea input');
    if (input) input.focus();
  }

  async function doLogin() {
    try {
      var data = await A.api('POST', '/api/auth/login', { email: A.val('loginEmail'), password: A.val('loginPassword') });
      state.user = data.user;
      A.closeModal();
      renderAuthArea();
      await refreshAll();
      A.toast('Signed in as ' + state.user.name);
    } catch (e) { A.showError('authError', e.message); }
  }

  async function doRegister() {
    try {
      var data = await A.api('POST', '/api/auth/register', {
        name: A.val('regName'), email: A.val('regEmail'), password: A.val('regPassword')
      });
      state.user = data.user;
      A.closeModal();
      renderAuthArea();
      await refreshAll();
      A.toast('Account created. You can request gear now.');
    } catch (e) { A.showError('authError', e.message); }
  }

  // ---------------------------------------------------------------
  // Catalog
  // ---------------------------------------------------------------
  function categories() {
    var seen = [];
    state.equipment.forEach(function (e) { if (seen.indexOf(e.category) < 0) seen.push(e.category); });
    return seen.sort();
  }

  function renderCatalogChips() {
    document.getElementById('catChips').innerHTML =
      ['all'].concat(categories()).map(function (c) {
        return '<button class="chip' + (state.filter.category === c ? ' active' : '') +
          '" data-action="filter-cat" data-cat="' + A.esc(c) + '">' +
          A.esc(c === 'all' ? 'Everything' : c) + '</button>';
      }).join('');
  }

  // "Is a DSLR free this weekend?" — free now, or a unit due back by then.
  function freeBy(eq, dateISO) {
    if (eq.availableUnits > 0) return true;
    return eq.dueDates.some(function (d) { return d <= dateISO; });
  }

  function visibleEquipment() {
    var q = state.filter.q.toLowerCase();
    return state.equipment.filter(function (e) {
      if (state.filter.category !== 'all' && e.category !== state.filter.category) return false;
      if (q && (e.name + ' ' + e.category + ' ' + e.description).toLowerCase().indexOf(q) < 0) return false;
      if (state.filter.freeBy && !freeBy(e, state.filter.freeBy)) return false;
      return true;
    });
  }

  function renderCatalog() {
    var grid = document.getElementById('eqGrid');
    var list = visibleEquipment();
    if (!state.equipment.length) {
      grid.innerHTML = '<div class="empty-state">The catalog is empty. Staff can add gear from the staff desk.</div>';
      return;
    }
    if (!list.length) {
      grid.innerHTML = '<div class="empty-state">Nothing matches that. Try a different date or clear the filters.</div>';
      return;
    }
    grid.innerHTML = list.map(function (eq) {
      var dots = '';
      for (var i = 0; i < Math.min(eq.totalUnits, 12); i++) {
        var cls = i < eq.availableUnits ? 'avail'
          : (i < eq.availableUnits + eq.borrowedUnits ? 'out' : 'maint');
        dots += '<span class="unit-dot ' + cls + '"></span>';
      }
      var note;
      if (eq.availableUnits > 0) {
        note = '<p class="free-note yes">Ready to collect today.</p>';
      } else if (eq.nextFreeDate) {
        note = '<p class="free-note no">All out. Next one due back ' + A.fmtDay(eq.nextFreeDate) + '.</p>';
      } else {
        note = '<p class="free-note no">No unit on the shelf right now.</p>';
      }
      return '' +
        '<div class="eq-card' + (eq.availableUnits ? '' : ' dim') + '">' +
          '<span class="hole"></span>' +
          '<div class="eq-cat">' + A.esc(eq.category) + '</div>' +
          '<h3 class="eq-name">' + A.esc(eq.name) + '</h3>' +
          '<p class="eq-desc">' + A.esc(eq.description) + '</p>' +
          '<div class="unit-row">' + dots +
            '<span class="avail-text">' + eq.availableUnits + ' of ' + eq.totalUnits + ' free' +
            (eq.maintenanceUnits ? ' · ' + eq.maintenanceUnits + ' in repair' : '') + '</span>' +
          '</div>' +
          note +
          '<div class="spacer"></div>' +
          '<div class="eq-meta">' +
            '<span>Deposit <b>' + A.money(eq.depositAmount) + '</b></span>' +
            '<span>Late <b>' + A.money(eq.lateFeePerDay) + '/day</b></span>' +
            '<span>Up to <b>' + eq.maxLoanDays + 'd</b></span>' +
          '</div>' +
          '<button class="btn primary" style="width:100%;" data-action="borrow" data-id="' + eq.id + '"' +
            (eq.availableUnits ? '' : ' disabled') + '>' +
            (eq.availableUnits ? 'Request to borrow' : 'None free right now') +
          '</button>' +
        '</div>';
    }).join('');
  }

  function openRequestModal(eqId) {
    var eq = state.equipment.find(function (e) { return e.id === eqId; });
    if (!eq) return;
    var latest = A.addDaysISO(A.todayISO(), eq.maxLoanDays);
    var suggested = state.filter.freeBy && state.filter.freeBy <= latest && state.filter.freeBy > A.todayISO()
      ? state.filter.freeBy : latest;
    A.openModal(
      '<h3>Request ' + A.esc(eq.name) + '</h3>' +
      '<p class="modal-sub">' + eq.availableUnits + ' free now · deposit ' + A.money(eq.depositAmount) +
        ' · late fee ' + A.money(eq.lateFeePerDay) + ' per day · keep it up to ' + eq.maxLoanDays + ' day(s)</p>' +
      '<label class="field"><span class="field-label">Bringing it back on</span>' +
        '<input type="date" id="reqDue" value="' + suggested + '" min="' + A.addDaysISO(A.todayISO(), 1) + '" max="' + latest + '"></label>' +
      '<label class="field"><span class="field-label">Note for the desk (optional)</span>' +
        '<textarea id="reqNote" placeholder="e.g. film club shoot on Saturday"></textarea></label>' +
      '<div id="reqError"></div>' +
      '<div class="modal-actions">' +
        '<button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn primary" data-action="submit-request" data-id="' + eq.id + '">Send request</button>' +
      '</div>'
    );
  }

  async function submitRequest(eqId) {
    try {
      await A.api('POST', '/api/loans', {
        equipmentId: eqId, dueDate: A.val('reqDue'), note: A.val('reqNote')
      });
      A.closeModal();
      await refreshAll();
      switchTab('myloans');
      A.toast('Request sent. The desk will approve it and set a unit aside.');
    } catch (e) { A.showError('reqError', e.message); }
  }

  // ---------------------------------------------------------------
  // My loans
  // ---------------------------------------------------------------
  function loanRow(loan) {
    var cls = 'row-card';
    if (loan.status === 'approved') cls += loan.isOverdue ? ' is-overdue' : (loan.daysLeft <= 1 ? ' is-due-soon' : '');
    if (loan.status === 'pending') cls += ' is-pending';

    var sub;
    if (loan.status === 'pending') {
      sub = 'Requested ' + A.fmtDate(loan.requestedAt) + ' · waiting for the desk to approve';
    } else if (loan.status === 'approved') {
      sub = (loan.unitLabel ? A.esc(loan.unitLabel) + ' · ' : '') +
        '<span class="hl">' + A.dueLabel(loan.dueDate) + '</span> (' + A.fmtDate(loan.dueDate) + ')' +
        (loan.isOverdue ? ' · late fee so far ' + A.money(loan.runningLateFee) : '');
    } else if (loan.status === 'returned') {
      sub = 'Returned ' + A.fmtDate(loan.returnedAt) +
        (loan.lateFeeCharged ? ' · late fee ' + A.money(loan.lateFeeCharged) : ' · on time') +
        ' · deposit back ' + A.money(loan.depositRefunded);
    } else if (loan.status === 'rejected') {
      sub = 'The desk declined this request';
    } else {
      sub = 'You withdrew this request';
    }
    if (loan.transferCount) {
      sub += ' · handed over ' + loan.transferCount + ' time' + (loan.transferCount === 1 ? '' : 's') +
        ' (started by ' + A.esc(loan.originalBorrowerName) + ')';
    }

    var actions = '';
    if (loan.status === 'approved') {
      actions += '<button class="btn small" data-action="open-handover" data-id="' + loan.id + '">Hand over</button>';
    }
    if (loan.status === 'pending') {
      actions += '<button class="btn small danger" data-action="cancel-loan" data-id="' + loan.id + '">Withdraw</button>';
    }

    return '<div class="' + cls + '">' +
      '<div class="rc-main"><div class="rc-title">' + A.esc(loan.equipmentName) + '</div>' +
      '<div class="rc-sub">' + sub + '</div></div>' +
      '<div class="rc-actions">' + A.statusPill(loan) + actions + '</div></div>';
  }

  function renderMyLoans() {
    var box = document.getElementById('myLoansBody');
    if (!state.user) {
      box.innerHTML = '<div class="empty-state">Log in to see what you have out.<br><br>' +
        '<button class="btn primary" data-action="open-auth">Log in or register</button></div>';
      return;
    }
    if (!state.loans.length) {
      box.innerHTML = '<div class="empty-state">Nothing borrowed yet. Pick something from the catalog.</div>';
      return;
    }
    var out = state.loans.filter(function (l) { return l.status === 'approved'; });
    var waiting = state.loans.filter(function (l) { return l.status === 'pending'; });
    var done = state.loans.filter(function (l) { return ['returned', 'rejected', 'cancelled'].indexOf(l.status) >= 0; });

    var html = '';
    var overdue = out.filter(function (l) { return l.isOverdue; });
    if (overdue.length) {
      html += '<div class="banner error">' + overdue.length + ' item' + (overdue.length === 1 ? ' is' : 's are') +
        ' past the return date. The late fee grows every day until it is back at the desk.</div>';
    }
    if (out.length) html += '<h3 class="sub-title">With you now</h3>' + out.map(loanRow).join('');
    if (waiting.length) html += '<h3 class="sub-title">Waiting at the desk</h3>' + waiting.map(loanRow).join('');
    if (done.length) html += '<h3 class="sub-title">Earlier</h3>' + done.map(loanRow).join('');
    box.innerHTML = html;
  }

  async function cancelLoan(id) {
    try {
      await A.api('PATCH', '/api/loans/' + id + '/cancel');
      await refreshAll();
      A.toast('Request withdrawn.');
    } catch (e) { A.toast(e.message, true); }
  }

  // ---------------------------------------------------------------
  // Handovers
  // ---------------------------------------------------------------
  function openHandoverModal(loanId) {
    var loan = state.loans.find(function (l) { return l.id === loanId; });
    if (!loan) return;
    A.openModal(
      '<h3>Hand over ' + A.esc(loan.equipmentName) + '</h3>' +
      '<p class="modal-sub">' + (loan.unitLabel ? A.esc(loan.unitLabel) + ' · ' : '') +
        'due back ' + A.fmtDate(loan.dueDate) + '. That date does not move, so whoever takes it on has ' +
        A.dueLabel(loan.dueDate).replace('due back ', '') + '.</p>' +
      '<label class="field"><span class="field-label">Their college email</span>' +
        '<input type="email" id="hoEmail" list="studentList" placeholder="name@clg.edu" autocomplete="off"></label>' +
      '<datalist id="studentList"></datalist>' +
      '<label class="field"><span class="field-label">Note (optional)</span>' +
        '<textarea id="hoNote" placeholder="e.g. you shoot Sunday, I am done with it"></textarea></label>' +
      '<div class="banner warn">They have to accept before it moves. The deposit and any late fee follow the gear, ' +
        'so from the moment they accept it is on them.</div>' +
      '<div id="hoError"></div>' +
      '<div class="modal-actions">' +
        '<button class="btn" data-action="close-modal">Cancel</button>' +
        '<button class="btn primary" data-action="submit-handover" data-id="' + loan.id + '">Send handover</button>' +
      '</div>'
    );
    var input = document.getElementById('hoEmail');
    var timer = null;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(async function () {
        if (input.value.trim().length < 2) return;
        try {
          var data = await A.api('GET', '/api/students/search?q=' + encodeURIComponent(input.value.trim()));
          document.getElementById('studentList').innerHTML = data.students.map(function (s) {
            return '<option value="' + A.esc(s.email) + '">' + A.esc(s.name) + '</option>';
          }).join('');
        } catch (e) { /* suggestions are optional */ }
      }, 220);
    });
  }

  async function submitHandover(loanId) {
    try {
      await A.api('POST', '/api/loans/' + loanId + '/transfers', {
        toEmail: A.val('hoEmail'), note: A.val('hoNote')
      });
      A.closeModal();
      await refreshAll();
      switchTab('handovers');
      A.toast('Handover sent. It moves once they accept.');
    } catch (e) { A.showError('hoError', e.message); }
  }

  function transferRow(t, direction) {
    var who = direction === 'in'
      ? A.esc(t.fromName) + ' <span class="handover-arrow">→</span> you'
      : 'you <span class="handover-arrow">→</span> ' + A.esc(t.toName);
    var sub = who + ' · due back ' + A.fmtDate(t.dueDate) + ' (unchanged)' +
      (t.note ? ' · “' + A.esc(t.note) + '”' : '');
    var actions = '';
    if (t.status === 'pending' && direction === 'in') {
      actions = '<button class="btn small danger" data-action="reject-handover" data-id="' + t.id + '">Decline</button>' +
        '<button class="btn small primary" data-action="accept-handover" data-id="' + t.id + '">Accept</button>';
    } else if (t.status === 'pending') {
      actions = '<button class="btn small" data-action="cancel-handover" data-id="' + t.id + '">Withdraw</button>';
    }
    var pillClass = { pending: 'pending', completed: 'transferred', rejected: 'rejected', cancelled: 'cancelled' }[t.status];
    var pillText = { pending: 'waiting', completed: 'done', rejected: 'declined', cancelled: 'withdrawn' }[t.status];
    return '<div class="row-card' + (t.status === 'pending' ? ' is-handover' : '') + '">' +
      '<div class="rc-main"><div class="rc-title">' + A.esc(t.equipmentName) +
      (t.unitLabel ? ' <span class="rc-sub">(' + A.esc(t.unitLabel) + ')</span>' : '') + '</div>' +
      '<div class="rc-sub">' + sub + '</div></div>' +
      '<div class="rc-actions"><span class="pill ' + pillClass + '">' + pillText + '</span>' + actions + '</div></div>';
  }

  function renderHandovers() {
    var box = document.getElementById('handoverBody');
    if (!state.user) {
      box.innerHTML = '<div class="empty-state">Log in to pass a loan on or pick one up.<br><br>' +
        '<button class="btn primary" data-action="open-auth">Log in or register</button></div>';
      return;
    }
    var inc = state.handovers.incoming;
    var outg = state.handovers.outgoing;
    if (!inc.length && !outg.length) {
      box.innerHTML = '<div class="empty-state">No handovers yet. Open <b>My loans</b> and use <b>Hand over</b> on anything you have out.</div>';
      return;
    }
    var incPending = inc.filter(function (t) { return t.status === 'pending'; });
    var html = '';
    if (incPending.length) {
      html += '<h3 class="sub-title">Waiting for you</h3>' +
        '<p class="lede">Accepting makes it yours: same return date, same deposit, and the late fee is on you if it is late.</p>' +
        incPending.map(function (t) { return transferRow(t, 'in'); }).join('');
    }
    var outPending = outg.filter(function (t) { return t.status === 'pending'; });
    if (outPending.length) {
      html += '<h3 class="sub-title">Sent by you</h3>' + outPending.map(function (t) { return transferRow(t, 'out'); }).join('');
    }
    var past = inc.filter(function (t) { return t.status !== 'pending'; }).map(function (t) { return transferRow(t, 'in'); })
      .concat(outg.filter(function (t) { return t.status !== 'pending'; }).map(function (t) { return transferRow(t, 'out'); }));
    if (past.length) html += '<h3 class="sub-title">Earlier handovers</h3>' + past.join('');
    box.innerHTML = html;
  }

  async function decideHandover(id, what) {
    try {
      await A.api('PATCH', '/api/transfers/' + id + '/' + what);
      await refreshAll();
      A.toast(what === 'accept' ? 'Done — it is on your loans now, same return date.'
        : (what === 'reject' ? 'Handover declined.' : 'Handover withdrawn.'));
    } catch (e) { A.toast(e.message, true); }
  }

  // ---------------------------------------------------------------
  // Tabs and events
  // ---------------------------------------------------------------
  function switchTab(tab) {
    document.querySelectorAll('#mainTabs button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    document.querySelectorAll('section.view').forEach(function (v) {
      v.classList.toggle('active', v.id === 'view-' + tab);
    });
    if (tab === 'myloans') renderMyLoans();
    if (tab === 'handovers') renderHandovers();
  }

  var actions = {
    'open-auth': function () { openAuthModal(); },
    'close-modal': function () { A.closeModal(); },
    'auth-tab': function (el) { setAuthTab(el.dataset.tab); },
    'do-login': doLogin,
    'do-register': doRegister,
    'logout': async function () {
      await A.api('POST', '/api/auth/logout');
      state.user = null;
      renderAuthArea();
      await refreshAll();
      A.toast('Signed out.');
    },
    'filter-cat': function (el) {
      state.filter.category = el.dataset.cat;
      renderCatalogChips();
      renderCatalog();
    },
    'borrow': function (el) {
      if (!state.user) { openAuthModal('Make a free student account to request this.'); return; }
      openRequestModal(el.dataset.id);
    },
    'submit-request': function (el) { submitRequest(el.dataset.id); },
    'cancel-loan': function (el) { cancelLoan(el.dataset.id); },
    'open-handover': function (el) { openHandoverModal(el.dataset.id); },
    'submit-handover': function (el) { submitHandover(el.dataset.id); },
    'accept-handover': function (el) { decideHandover(el.dataset.id, 'accept'); },
    'reject-handover': function (el) { decideHandover(el.dataset.id, 'reject'); },
    'cancel-handover': function (el) { decideHandover(el.dataset.id, 'cancel'); }
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var fn = actions[el.dataset.action];
    if (fn) { e.preventDefault(); fn(el); }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var id = e.target && e.target.id;
    if (id === 'loginEmail' || id === 'loginPassword') doLogin();
    if (id === 'regName' || id === 'regEmail' || id === 'regPassword') doRegister();
  });

  document.addEventListener('DOMContentLoaded', async function () {
    A.bindModalDismiss();
    document.querySelectorAll('#mainTabs button').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.dataset.tab); });
    });
    document.getElementById('fltSearch').addEventListener('input', function (e) {
      state.filter.q = e.target.value.trim();
      renderCatalog();
    });
    document.getElementById('fltDate').setAttribute('min', A.todayISO());
    document.getElementById('fltDate').addEventListener('change', function (e) {
      state.filter.freeBy = e.target.value;
      renderCatalog();
    });
    document.getElementById('fltClear').addEventListener('click', function () {
      state.filter = { q: '', category: 'all', freeBy: '' };
      document.getElementById('fltSearch').value = '';
      document.getElementById('fltDate').value = '';
      renderCatalogChips();
      renderCatalog();
    });

    try {
      await refreshMe();
      await refreshAll();
    } catch (e) {
      document.getElementById('eqGrid').innerHTML =
        '<div class="banner error">Could not reach the server. Is it running? (' + A.esc(e.message) + ')</div>';
    }
  });
})();

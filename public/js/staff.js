(function () {
  "use strict";

  var A = window.AV;
  var state = {
    user: null,
    tab: 'requests',
    loans: [],
    equipment: [],
    transfers: [],
    staff: [],
    settings: {},
    stats: {},
    units: {},        // equipmentId -> units, loaded on demand
    openEquipment: null,
    activeFilter: { q: '', overdueOnly: false }
  };

  // ---------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------
  async function checkSession() {
    var data = await A.api('GET', '/api/auth/me');
    if (data.user && data.user.role === 'staff') {
      state.user = data.user;
      await showDesk();
    }
  }

  async function staffLogin() {
    try {
      var data = await A.api('POST', '/api/staff/login', {
        email: A.val('staffEmail'), password: A.val('staffPassword')
      });
      state.user = data.user;
      await showDesk();
    } catch (e) { A.showError('staffLoginError', e.message); }
  }

  async function showDesk() {
    document.getElementById('staffLockScreen').style.display = 'none';
    document.getElementById('staffPanel').style.display = 'block';
    document.getElementById('staffTabs').style.display = 'flex';
    document.getElementById('authArea').innerHTML =
      '<div class="who">At the desk: <b>' + A.esc(state.user.name) + '</b></div>' +
      '<button class="btn small" data-action="logout">Log out</button>';
    await loadAll();
    switchTab('requests');
  }

  // ---------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------
  async function loadAll() {
    var r = await Promise.all([
      A.api('GET', '/api/loans'),
      A.api('GET', '/api/equipment?all=1'),
      A.api('GET', '/api/transfers'),
      A.api('GET', '/api/settings'),
      A.api('GET', '/api/stats'),
      A.api('GET', '/api/staff')
    ]);
    state.loans = r[0].loans;
    state.equipment = r[1].equipment;
    state.transfers = r[2].transfers;
    state.settings = r[3].settings;
    state.stats = r[4].stats;
    state.staff = r[5].staff;
    renderStats();
    renderCounts();
  }

  async function reload() {
    await loadAll();
    if (state.openEquipment) await loadUnits(state.openEquipment);
    renderCurrent();
  }

  async function loadUnits(eqId) {
    var data = await A.api('GET', '/api/equipment/' + eqId + '/units');
    state.units[eqId] = data.units;
  }

  function renderStats() {
    var s = state.stats;
    document.getElementById('statStrip').innerHTML =
      statBox(s.pendingRequests, 'requests waiting', 'gold') +
      statBox(s.outNow, 'items out now', '') +
      statBox(s.overdue, 'overdue', s.overdue ? 'warn' : '') +
      statBox(s.dueToday, 'due back today', '') +
      statBox(s.pendingTransfers, 'handovers waiting', 'teal') +
      statBox(s.unitsFree + '/' + s.unitsTotal, 'units on the shelf', '') +
      statBox(A.money(s.feesCollected), 'late fees charged', '');
  }
  function statBox(n, label, cls) {
    return '<div class="stat-box ' + cls + '"><div class="n">' + A.esc(n) + '</div><div class="l">' + A.esc(label) + '</div></div>';
  }

  function renderCounts() {
    var pairs = [
      ['cntRequests', state.loans.filter(function (l) { return l.status === 'pending'; }).length],
      ['cntOverdue', state.loans.filter(function (l) { return l.status === 'approved' && l.isOverdue; }).length],
      ['cntTransfers', state.transfers.filter(function (t) { return t.status === 'pending'; }).length]
    ];
    pairs.forEach(function (p) {
      var el = document.getElementById(p[0]);
      el.textContent = p[1];
      el.className = 'tab-count' + (p[1] ? '' : ' quiet');
    });
  }

  // ---------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------
  function renderRequests() {
    var pending = state.loans.filter(function (l) { return l.status === 'pending'; });
    var html = '<h2 class="section-title">Requests waiting</h2>' +
      '<p class="lede">Approving sets aside a specific unit and marks it out. If nothing is free, the request stays here until something comes back.</p>';

    if (!pending.length) {
      html += '<div class="empty-state">Nothing waiting. The desk is clear.</div>';
    } else {
      html += pending.map(function (l) {
        var eq = state.equipment.find(function (e) { return e.id === l.equipmentId; });
        var free = eq ? eq.availableUnits : 0;
        var openForBorrower = state.loans.filter(function (o) {
          return o.borrowerId === l.borrowerId && (o.status === 'approved' || o.status === 'pending');
        }).length;
        return '<div class="row-card is-pending">' +
          '<div class="rc-main">' +
            '<div class="rc-title">' + A.esc(l.equipmentName) + ' \u2192 ' + A.esc(l.borrowerName) + '</div>' +
            '<div class="rc-sub">' + A.esc(l.borrowerEmail) + ' · wants it until <span class="hl">' + A.fmtDate(l.dueDate) + '</span>' +
              ' · asked ' + A.fmtDate(l.requestedAt) +
              ' · ' + openForBorrower + ' of ' + state.settings.maxActiveLoansPerBorrower + ' slots used' +
              (l.note ? '<br>Note: \u201c' + A.esc(l.note) + '\u201d' : '') +
              '<br>' + (free > 0 ? free + ' unit(s) on the shelf' : 'Nothing free right now') + '</div>' +
          '</div>' +
          '<div class="rc-actions">' +
            '<button class="btn small danger" data-action="reject" data-id="' + l.id + '">Decline</button>' +
            '<button class="btn small primary" data-action="approve" data-id="' + l.id + '"' + (free > 0 ? '' : ' disabled') + '>Approve</button>' +
          '</div></div>';
      }).join('');
    }

    var pendingT = state.transfers.filter(function (t) { return t.status === 'pending'; });
    if (pendingT.length) {
      html += '<h3 class="sub-title">Handovers students have started</h3>' +
        '<p class="lede">These move on their own once the other student accepts. Nothing here changes what is on the shelf.</p>' +
        pendingT.map(transferRow).join('');
    }
    document.getElementById('staff-requests').innerHTML = html;
  }

  async function approve(id) {
    try { await A.api('PATCH', '/api/loans/' + id + '/approve'); await reload(); A.toast('Approved and a unit set aside.'); }
    catch (e) { A.toast(e.message, true); }
  }

  function openRejectModal(id) {
    var loan = state.loans.find(function (l) { return l.id === id; });
    A.openModal(
      '<h3>Decline this request</h3>' +
      '<p class="modal-sub">' + A.esc(loan.equipmentName) + ' for ' + A.esc(loan.borrowerName) + '</p>' +
      '<label class="field"><span class="field-label">Reason (shows on their loan)</span>' +
      '<input type="text" id="rejReason" placeholder="e.g. booked for the department shoot"></label>' +
      '<div id="rejError"></div>' +
      '<div class="modal-actions"><button class="btn" data-action="close-modal">Cancel</button>' +
      '<button class="btn danger" data-action="do-reject" data-id="' + id + '">Decline request</button></div>'
    );
  }

  async function doReject(id) {
    try {
      await A.api('PATCH', '/api/loans/' + id + '/reject', { reason: A.val('rejReason') });
      A.closeModal(); await reload(); A.toast('Request declined.');
    } catch (e) { A.showError('rejError', e.message); }
  }

  // ---------------------------------------------------------------
  // Out & overdue
  // ---------------------------------------------------------------
  function renderActive() {
    var list = state.loans.filter(function (l) { return l.status === 'approved'; });
    if (state.activeFilter.overdueOnly) list = list.filter(function (l) { return l.isOverdue; });
    if (state.activeFilter.q) {
      var q = state.activeFilter.q.toLowerCase();
      list = list.filter(function (l) {
        return (l.borrowerName + ' ' + l.borrowerEmail + ' ' + l.equipmentName + ' ' + (l.unitLabel || '')).toLowerCase().indexOf(q) >= 0;
      });
    }
    list.sort(function (a, b) { return a.dueDate.localeCompare(b.dueDate); });

    var html = '<h2 class="section-title">Out &amp; overdue</h2>' +
      '<p class="lede">Sorted by return date, so the oldest problem is on top. Recording a return works out the late fee and the deposit to give back.</p>' +
      '<div class="filter-bar">' +
        '<label class="field grow"><span class="field-label">Find a borrower or item</span>' +
          '<input type="search" id="actSearch" value="' + A.esc(state.activeFilter.q) + '" placeholder="name, email, tripod…"></label>' +
        '<label class="checkline" style="margin-bottom:0;"><input type="checkbox" id="actOverdue"' +
          (state.activeFilter.overdueOnly ? ' checked' : '') + '> Overdue only</label>' +
      '</div>';

    if (!list.length) {
      html += '<div class="empty-state">' + (state.activeFilter.overdueOnly ? 'Nothing is overdue.' : 'Nothing is out at the moment.') + '</div>';
    } else {
      html += list.map(function (l) {
        var sub = A.esc(l.borrowerName) + ' · ' + A.esc(l.borrowerEmail) +
          (l.unitLabel ? ' · ' + A.esc(l.unitLabel) : '') +
          '<br><span class="hl">' + A.dueLabel(l.dueDate) + '</span> (' + A.fmtDate(l.dueDate) + ')' +
          (l.isOverdue ? ' · late fee so far <span class="hl">' + A.money(l.runningLateFee) + '</span> of a ' +
            A.money(l.depositAmount) + ' deposit' : ' · deposit held ' + A.money(l.depositAmount)) +
          (l.transferCount ? '<br>Handed over ' + l.transferCount + ' time(s) — started by ' + A.esc(l.originalBorrowerName) : '') +
          (l.lastNudgedAt ? '<br>Last reminder ' + A.fmtDate(l.lastNudgedAt) : '');
        return '<div class="row-card' + (l.isOverdue ? ' is-overdue' : (l.daysLeft <= 1 ? ' is-due-soon' : '')) + '">' +
          '<div class="rc-main"><div class="rc-title">' + A.esc(l.equipmentName) + '</div>' +
          '<div class="rc-sub">' + sub + '</div></div>' +
          '<div class="rc-actions">' +
            '<button class="btn small" data-action="nudge" data-id="' + l.id + '">Remind</button>' +
            '<button class="btn small" data-action="desk-handover" data-id="' + l.id + '">Hand over</button>' +
            '<button class="btn small primary" data-action="return" data-id="' + l.id + '">Record return</button>' +
          '</div></div>';
      }).join('');
    }
    document.getElementById('staff-active').innerHTML = html;

    A.on('actSearch', 'input', function (e) {
      state.activeFilter.q = e.target.value.trim();
      renderActive();
      var box = document.getElementById('actSearch');
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
    A.on('actOverdue', 'change', function (e) {
      state.activeFilter.overdueOnly = e.target.checked;
      renderActive();
    });
  }

  function openReturnModal(id) {
    var l = state.loans.find(function (x) { return x.id === id; });
    var fee = l.isOverdue ? l.runningLateFee : 0;
    var refund = Math.max(0, l.depositAmount - fee);
    A.openModal(
      '<h3>Record a return</h3>' +
      '<p class="modal-sub">' + A.esc(l.unitLabel || l.equipmentName) + ' from ' + A.esc(l.borrowerName) + '</p>' +
      '<div class="settings-box" style="margin-bottom:16px;">' +
        '<div class="rc-sub">Due back ' + A.fmtDate(l.dueDate) + '</div>' +
        '<div class="rc-sub">' + (l.isOverdue
          ? l.daysLate + ' day(s) late × ' + A.money(l.lateFeePerDay) + ' = <b>' + A.money(fee) + '</b> late fee'
          : 'On time, no late fee') + '</div>' +
        '<div class="rc-sub">Deposit held ' + A.money(l.depositAmount) + ' → <b>give back ' + A.money(refund) + '</b></div>' +
      '</div>' +
      (l.transferCount ? '<div class="banner warn">This loan changed hands ' + l.transferCount +
        ' time(s). ' + A.esc(l.borrowerName) + ' is holding it now, so the refund goes to them.</div>' : '') +
      '<div id="retError"></div>' +
      '<div class="modal-actions"><button class="btn" data-action="close-modal">Cancel</button>' +
      '<button class="btn primary" data-action="do-return" data-id="' + id + '">Item is back, refund ' + A.money(refund) + '</button></div>'
    );
  }

  async function doReturn(id) {
    try {
      var data = await A.api('PATCH', '/api/loans/' + id + '/return');
      A.closeModal(); await reload();
      A.toast('Back on the shelf. Late fee ' + A.money(data.loan.lateFeeCharged) + ', refund ' + A.money(data.loan.depositRefunded) + '.');
    } catch (e) { A.showError('retError', e.message); }
  }

  async function nudge(id) {
    try {
      var data = await A.api('POST', '/api/loans/' + id + '/nudge');
      var r = data.reminder;
      var mailto = 'mailto:' + encodeURIComponent(r.to) + '?subject=' + encodeURIComponent(r.subject) + '&body=' + encodeURIComponent(r.body);
      A.openModal(
        '<h3>Reminder for ' + A.esc(data.loan.borrowerName) + '</h3>' +
        '<p class="modal-sub">' + A.esc(r.to) + '</p>' +
        '<pre class="reminder">' + A.esc(r.subject) + '\n\n' + A.esc(r.body) + '</pre>' +
        '<div class="modal-actions">' +
          '<button class="btn" data-action="close-modal">Close</button>' +
          '<button class="btn" data-action="copy-reminder" data-text="' + A.esc(r.body) + '">Copy text</button>' +
          '<a class="btn primary" style="text-decoration:none;" href="' + A.esc(mailto) + '">Open in mail</a>' +
        '</div>'
      );
      await reload();
    } catch (e) { A.toast(e.message, true); }
  }

  // ---------------------------------------------------------------
  // Handovers
  // ---------------------------------------------------------------
  function transferRow(t) {
    var pillClass = { pending: 'pending', completed: 'transferred', rejected: 'rejected', cancelled: 'cancelled' }[t.status];
    var pillText = { pending: 'waiting', completed: 'done', rejected: 'declined', cancelled: 'withdrawn' }[t.status];
    var actions = t.status === 'pending'
      ? '<button class="btn small danger" data-action="cancel-transfer" data-id="' + t.id + '">Cancel</button>' : '';
    return '<div class="row-card' + (t.status === 'pending' ? ' is-handover' : '') + '">' +
      '<div class="rc-main"><div class="rc-title">' + A.esc(t.equipmentName) +
        (t.unitLabel ? ' · ' + A.esc(t.unitLabel) : '') + '</div>' +
      '<div class="rc-sub">' + A.esc(t.fromName) + ' <span class="handover-arrow">\u2192</span> ' + A.esc(t.toName) +
        ' · due back ' + A.fmtDate(t.dueDate) + ' (carried over unchanged)' +
        ' · started by ' + A.esc(t.initiatedRole === 'staff' ? 'the desk' : t.fromName) +
        ' ' + A.fmtDate(t.createdAt) +
        (t.note ? '<br>\u201c' + A.esc(t.note) + '\u201d' : '') + '</div></div>' +
      '<div class="rc-actions"><span class="pill ' + pillClass + '">' + pillText + '</span>' + actions + '</div></div>';
  }

  function renderHandovers() {
    var pending = state.transfers.filter(function (t) { return t.status === 'pending'; });
    var done = state.transfers.filter(function (t) { return t.status !== 'pending'; });
    var html = '<h2 class="section-title">Handovers</h2>' +
      '<p class="lede">A loan can change hands without coming back to the room. The return date carries over untouched and the unit stays marked out the whole time, so the catalog count never moves. Use <b>Hand over</b> on the Out &amp; overdue tab when two students swap at the desk.</p>';
    html += pending.length
      ? '<h3 class="sub-title">Waiting for the other student to accept</h3>' + pending.map(transferRow).join('')
      : '<div class="empty-state">No handover is waiting.</div>';
    if (done.length) html += '<h3 class="sub-title">History</h3>' + done.map(transferRow).join('');
    document.getElementById('staff-handovers').innerHTML = html;
  }

  function openDeskHandover(loanId) {
    var l = state.loans.find(function (x) { return x.id === loanId; });
    A.openModal(
      '<h3>Hand over at the desk</h3>' +
      '<p class="modal-sub">' + A.esc(l.unitLabel || l.equipmentName) + ', currently with ' + A.esc(l.borrowerName) + '</p>' +
      '<label class="field"><span class="field-label">Taking it on (student email)</span>' +
        '<input type="email" id="dhEmail" list="studentList" placeholder="name@clg.edu" autocomplete="off"></label>' +
      '<datalist id="studentList"></datalist>' +
      '<label class="field"><span class="field-label">Note</span>' +
        '<input type="text" id="dhNote" placeholder="e.g. swapped at the desk, same shoot"></label>' +
      '<div class="banner info">Return date stays ' + A.fmtDate(l.dueDate) + '. The unit stays marked out, so nothing changes on the catalog. ' +
        'The deposit and any late fee move to the new borrower.</div>' +
      '<div id="dhError"></div>' +
      '<div class="modal-actions"><button class="btn" data-action="close-modal">Cancel</button>' +
      '<button class="btn primary" data-action="do-desk-handover" data-id="' + loanId + '">Hand it over</button></div>'
    );
    var input = document.getElementById('dhEmail');
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

  async function doDeskHandover(loanId) {
    try {
      var data = await A.api('POST', '/api/loans/' + loanId + '/transfers', {
        toEmail: A.val('dhEmail'), note: A.val('dhNote')
      });
      A.closeModal(); await reload();
      A.toast('Now with ' + data.loan.borrowerName + ', still due ' + A.fmtDate(data.loan.dueDate) + '.');
    } catch (e) { A.showError('dhError', e.message); }
  }

  async function cancelTransfer(id) {
    try { await A.api('PATCH', '/api/transfers/' + id + '/cancel'); await reload(); A.toast('Handover cancelled.'); }
    catch (e) { A.toast(e.message, true); }
  }

  // ---------------------------------------------------------------
  // Equipment
  // ---------------------------------------------------------------
  function renderEquipment() {
    var html = '<h2 class="section-title">Equipment</h2>' +
      '<p class="lede">Every item has its own units. A unit in repair drops out of the free count without anyone having to fake a loan.</p>' +
      '<button class="btn primary" data-action="add-equipment" style="margin-bottom:16px;">Add an item</button>';

    html += state.equipment.map(function (eq) {
      var open = state.openEquipment === eq.id;
      var units = state.units[eq.id] || [];
      var body = '<div class="row-card" style="flex-direction:column; align-items:stretch;">' +
        '<div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; align-items:center;">' +
          '<div class="rc-main"><div class="rc-title">' + A.esc(eq.name) +
            (eq.retired ? ' <span class="pill">retired</span>' : '') + '</div>' +
            '<div class="rc-sub">' + A.esc(eq.category) + ' · ' + eq.availableUnits + ' free of ' + eq.totalUnits +
            (eq.maintenanceUnits ? ' · ' + eq.maintenanceUnits + ' in repair' : '') +
            ' · deposit ' + A.money(eq.depositAmount) + ' · late ' + A.money(eq.lateFeePerDay) + '/day · up to ' + eq.maxLoanDays + ' day(s)</div>' +
          '</div>' +
          '<div class="rc-actions">' +
            '<button class="btn small" data-action="edit-equipment" data-id="' + eq.id + '">Edit</button>' +
            '<button class="btn small" data-action="toggle-units" data-id="' + eq.id + '">' + (open ? 'Hide units' : 'Units') + '</button>' +
          '</div>' +
        '</div>';

      if (open) {
        body += '<div class="unit-list">' + (units.length ? units.map(function (u) {
          var meta = u.status === 'borrowed'
            ? 'with ' + A.esc(u.borrowerName) + ', due ' + A.fmtDate(u.dueDate) + (u.overdue ? ' (overdue)' : '')
            : (u.status === 'maintenance' ? 'in repair' : 'on the shelf');
          return '<div class="unit-line">' +
            '<span class="u-label">' + A.esc(u.label) + ' <span class="u-meta">— ' + meta + '</span></span>' +
            '<span class="rc-actions">' +
              (u.status === 'borrowed' ? '' :
                '<button class="btn small" data-action="toggle-maintenance" data-id="' + u.id + '">' +
                (u.status === 'maintenance' ? 'Back in service' : 'Mark in repair') + '</button>' +
                '<button class="btn small danger" data-action="delete-unit" data-id="' + u.id + '">Remove</button>') +
            '</span></div>';
        }).join('') : '<div class="rc-sub">No units yet.</div>') +
        '<button class="btn small" style="margin-top:10px;" data-action="add-unit" data-id="' + eq.id + '">Add a unit</button>' +
        '</div>';
      }
      return body + '</div>';
    }).join('');

    document.getElementById('staff-equipment').innerHTML = html;
  }

  function equipmentForm(eq) {
    return '<label class="field"><span class="field-label">Name</span><input type="text" id="eqName" value="' + A.esc(eq ? eq.name : '') + '"></label>' +
      '<div class="field-row">' +
        '<label class="field"><span class="field-label">Category</span><input type="text" id="eqCat" value="' + A.esc(eq ? eq.category : '') + '" placeholder="Camera, Audio…"></label>' +
        '<label class="field"><span class="field-label">Days it can go out for</span><input type="number" id="eqDays" min="1" value="' + (eq ? eq.maxLoanDays : 3) + '"></label>' +
      '</div>' +
      '<label class="field"><span class="field-label">What is in the kit</span><textarea id="eqDesc">' + A.esc(eq ? eq.description : '') + '</textarea></label>' +
      '<div class="field-row">' +
        '<label class="field"><span class="field-label">Deposit (\u20b9)</span><input type="number" id="eqDep" min="0" value="' + (eq ? eq.depositAmount : 0) + '"></label>' +
        '<label class="field"><span class="field-label">Late fee per day (\u20b9)</span><input type="number" id="eqLate" min="0" value="' + (eq ? eq.lateFeePerDay : 0) + '"></label>' +
      '</div>';
  }

  function openAddEquipment() {
    A.openModal('<h3>Add an item</h3><p class="modal-sub">Units are created for you and numbered.</p>' +
      equipmentForm(null) +
      '<label class="field"><span class="field-label">How many units</span><input type="number" id="eqUnits" min="1" value="1"></label>' +
      '<div id="eqError"></div>' +
      '<div class="modal-actions"><button class="btn" data-action="close-modal">Cancel</button>' +
      '<button class="btn primary" data-action="do-add-equipment">Add to the catalog</button></div>');
  }

  async function doAddEquipment() {
    try {
      await A.api('POST', '/api/equipment', {
        name: A.val('eqName'), category: A.val('eqCat'), description: A.val('eqDesc'),
        depositAmount: A.val('eqDep'), lateFeePerDay: A.val('eqLate'),
        maxLoanDays: A.val('eqDays'), unitCount: A.val('eqUnits')
      });
      A.closeModal(); await reload(); A.toast('Added to the catalog.');
    } catch (e) { A.showError('eqError', e.message); }
  }

  function openEditEquipment(id) {
    var eq = state.equipment.find(function (e) { return e.id === id; });
    A.openModal('<h3>Edit ' + A.esc(eq.name) + '</h3>' +
      '<p class="modal-sub">Changes apply to new loans. Loans already out keep the deposit and rate they were made with.</p>' +
      equipmentForm(eq) +
      '<label class="checkline"><input type="checkbox" id="eqRetired"' + (eq.retired ? ' checked' : '') + '> Retire this item (hide it from the catalog)</label>' +
      '<div id="eqError"></div>' +
      '<div class="modal-actions"><button class="btn" data-action="close-modal">Cancel</button>' +
      '<button class="btn primary" data-action="do-edit-equipment" data-id="' + id + '">Save</button></div>');
  }

  async function doEditEquipment(id) {
    try {
      await A.api('PATCH', '/api/equipment/' + id, {
        name: A.val('eqName'), category: A.val('eqCat'), description: A.val('eqDesc'),
        depositAmount: A.val('eqDep'), lateFeePerDay: A.val('eqLate'), maxLoanDays: A.val('eqDays'),
        retired: document.getElementById('eqRetired').checked
      });
      A.closeModal(); await reload(); A.toast('Saved.');
    } catch (e) { A.showError('eqError', e.message); }
  }

  async function toggleUnits(id) {
    state.openEquipment = state.openEquipment === id ? null : id;
    if (state.openEquipment) await loadUnits(state.openEquipment);
    renderEquipment();
  }

  async function addUnit(eqId) {
    try {
      await A.api('POST', '/api/equipment/' + eqId + '/units', {});
      state.openEquipment = eqId;
      await reload(); A.toast('Unit added.');
    } catch (e) { A.toast(e.message, true); }
  }

  async function toggleMaintenance(unitId) {
    try { await A.api('PATCH', '/api/units/' + unitId + '/maintenance'); await reload(); }
    catch (e) { A.toast(e.message, true); }
  }

  async function deleteUnit(unitId) {
    try {
      var data = await A.api('DELETE', '/api/units/' + unitId);
      await reload();
      A.toast(data.removed ? 'Unit removed.' : 'Unit has loan history, so it was retired instead.');
    } catch (e) { A.toast(e.message, true); }
  }

  // ---------------------------------------------------------------
  // Staff accounts
  // ---------------------------------------------------------------
  function renderTeam() {
    var html = '<h2 class="section-title">Staff accounts</h2>' +
      '<p class="lede">Anyone here can approve requests and record returns. Retire the default account once you have made a real one.</p>' +
      '<button class="btn primary" data-action="add-staff" style="margin-bottom:16px;">Add a staff account</button>' +
      state.staff.map(function (s) {
        return '<div class="row-card">' +
          '<div class="rc-main"><div class="rc-title">' + A.esc(s.name) + (s.id === state.user.id ? ' (you)' : '') + '</div>' +
          '<div class="rc-sub">' + A.esc(s.email) + ' · added ' + A.fmtDate(s.createdAt) + '</div></div>' +
          '<div class="rc-actions">' +
            '<span class="pill ' + (s.active ? 'approved' : 'cancelled') + '">' + (s.active ? 'active' : 'switched off') + '</span>' +
            '<button class="btn small" data-action="reset-staff-password" data-id="' + s.id + '" data-name="' + A.esc(s.name) + '">New password</button>' +
            '<button class="btn small ' + (s.active ? 'danger' : '') + '" data-action="toggle-staff" data-id="' + s.id + '" data-active="' + (s.active ? '0' : '1') + '">' +
              (s.active ? 'Switch off' : 'Switch on') + '</button>' +
          '</div></div>';
      }).join('');
    document.getElementById('staff-team').innerHTML = html;
  }

  function openAddStaff() {
    A.openModal('<h3>Add a staff account</h3><p class="modal-sub">They log in here, not on the student page.</p>' +
      '<label class="field"><span class="field-label">Name</span><input type="text" id="stName"></label>' +
      '<label class="field"><span class="field-label">Email</span><input type="email" id="stEmail"></label>' +
      '<label class="field"><span class="field-label">Password</span><input type="password" id="stPass" placeholder="At least 6 characters"></label>' +
      '<div id="stError"></div>' +
      '<div class="modal-actions"><button class="btn" data-action="close-modal">Cancel</button>' +
      '<button class="btn primary" data-action="do-add-staff">Create account</button></div>');
  }

  async function doAddStaff() {
    try {
      await A.api('POST', '/api/staff/register', { name: A.val('stName'), email: A.val('stEmail'), password: A.val('stPass') });
      A.closeModal(); await reload(); A.toast('Staff account created.');
    } catch (e) { A.showError('stError', e.message); }
  }

  function openResetPassword(id, name) {
    A.openModal('<h3>New password for ' + A.esc(name) + '</h3>' +
      '<label class="field"><span class="field-label">Password</span><input type="password" id="pwNew" placeholder="At least 6 characters"></label>' +
      '<div id="pwError"></div>' +
      '<div class="modal-actions"><button class="btn" data-action="close-modal">Cancel</button>' +
      '<button class="btn primary" data-action="do-reset-password" data-id="' + id + '">Set password</button></div>');
  }

  async function doResetPassword(id) {
    try {
      await A.api('PATCH', '/api/staff/' + id + '/password', { newPassword: A.val('pwNew') });
      A.closeModal(); A.toast('Password updated.');
    } catch (e) { A.showError('pwError', e.message); }
  }

  async function toggleStaff(id, active) {
    try { await A.api('PATCH', '/api/staff/' + id + '/active', { active: active }); await reload(); }
    catch (e) { A.toast(e.message, true); }
  }

  // ---------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------
  function renderSettings() {
    var s = state.settings;
    document.getElementById('staff-settings').innerHTML =
      '<h2 class="section-title">Room rules</h2>' +
      '<p class="lede">These apply to everyone borrowing from this room.</p>' +
      '<div class="settings-box">' +
        '<div class="field-row">' +
          '<label class="field"><span class="field-label">Most loans one student can have open</span>' +
            '<input type="number" id="setMax" min="1" max="20" value="' + s.maxActiveLoansPerBorrower + '"></label>' +
          '<label class="field"><span class="field-label">Default loan length (days)</span>' +
            '<input type="number" id="setDays" min="1" max="90" value="' + s.defaultLoanDays + '"></label>' +
        '</div>' +
        '<label class="checkline"><input type="checkbox" id="setTransfers"' + (s.allowStudentTransfers ? ' checked' : '') + '>' +
          ' Let students start a handover themselves (the other student still has to accept)</label>' +
        '<div id="setError"></div>' +
        '<button class="btn primary" data-action="save-settings">Save rules</button>' +
      '</div>' +
      '<div class="settings-box">' +
        '<h3 class="sub-title" style="margin-top:0;">Your own login</h3>' +
        '<label class="field"><span class="field-label">Current password</span><input type="password" id="ownOld"></label>' +
        '<label class="field"><span class="field-label">New password</span><input type="password" id="ownNew"></label>' +
        '<div id="ownError"></div>' +
        '<button class="btn" data-action="change-own-password">Change my password</button>' +
      '</div>';
  }

  async function saveSettings() {
    try {
      await A.api('PATCH', '/api/settings', {
        maxActiveLoansPerBorrower: A.val('setMax'),
        defaultLoanDays: A.val('setDays'),
        allowStudentTransfers: document.getElementById('setTransfers').checked
      });
      await reload(); A.toast('Rules saved.');
    } catch (e) { A.showError('setError', e.message); }
  }

  async function changeOwnPassword() {
    try {
      await A.api('PATCH', '/api/auth/password', { currentPassword: A.val('ownOld'), newPassword: A.val('ownNew') });
      document.getElementById('ownOld').value = '';
      document.getElementById('ownNew').value = '';
      A.toast('Password changed.');
    } catch (e) { A.showError('ownError', e.message); }
  }

  // ---------------------------------------------------------------
  // Tabs and events
  // ---------------------------------------------------------------
  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('#staffTabs button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.staff === tab);
    });
    document.querySelectorAll('.staff-view').forEach(function (v) {
      v.style.display = v.id === 'staff-' + tab ? 'block' : 'none';
    });
    renderCurrent();
  }

  function renderCurrent() {
    if (!state.user) return;
    renderStats();
    renderCounts();
    ({
      requests: renderRequests, active: renderActive, handovers: renderHandovers,
      equipment: renderEquipment, team: renderTeam, settings: renderSettings
    })[state.tab]();
  }

  var actions = {
    'close-modal': function () { A.closeModal(); },
    'logout': async function () { await A.api('POST', '/api/auth/logout'); window.location.reload(); },
    'approve': function (el) { approve(el.dataset.id); },
    'reject': function (el) { openRejectModal(el.dataset.id); },
    'do-reject': function (el) { doReject(el.dataset.id); },
    'return': function (el) { openReturnModal(el.dataset.id); },
    'do-return': function (el) { doReturn(el.dataset.id); },
    'nudge': function (el) { nudge(el.dataset.id); },
    'copy-reminder': function (el) {
      navigator.clipboard.writeText(el.dataset.text).then(function () { A.toast('Copied.'); },
        function () { A.toast('Could not copy — select the text instead.', true); });
    },
    'desk-handover': function (el) { openDeskHandover(el.dataset.id); },
    'do-desk-handover': function (el) { doDeskHandover(el.dataset.id); },
    'cancel-transfer': function (el) { cancelTransfer(el.dataset.id); },
    'add-equipment': openAddEquipment,
    'do-add-equipment': doAddEquipment,
    'edit-equipment': function (el) { openEditEquipment(el.dataset.id); },
    'do-edit-equipment': function (el) { doEditEquipment(el.dataset.id); },
    'toggle-units': function (el) { toggleUnits(el.dataset.id); },
    'add-unit': function (el) { addUnit(el.dataset.id); },
    'toggle-maintenance': function (el) { toggleMaintenance(el.dataset.id); },
    'delete-unit': function (el) { deleteUnit(el.dataset.id); },
    'add-staff': openAddStaff,
    'do-add-staff': doAddStaff,
    'reset-staff-password': function (el) { openResetPassword(el.dataset.id, el.dataset.name); },
    'do-reset-password': function (el) { doResetPassword(el.dataset.id); },
    'toggle-staff': function (el) { toggleStaff(el.dataset.id, el.dataset.active === '1'); },
    'save-settings': saveSettings,
    'change-own-password': changeOwnPassword
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el || el.tagName === 'A') return;
    var fn = actions[el.dataset.action];
    if (fn) { e.preventDefault(); fn(el); }
  });

  document.addEventListener('DOMContentLoaded', async function () {
    A.bindModalDismiss();
    A.on('staffLoginBtn', 'click', staffLogin);
    ['staffEmail', 'staffPassword'].forEach(function (id) {
      A.on(id, 'keydown', function (e) { if (e.key === 'Enter') staffLogin(); });
    });
    document.querySelectorAll('#staffTabs button').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.dataset.staff); });
    });
    try { await checkSession(); }
    catch (e) { A.showError('staffLoginError', 'Could not reach the server. Is it running?'); }
  });
})();

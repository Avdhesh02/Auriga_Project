/* Shared helpers for both the student page and the staff desk. */
window.AV = (function () {
  "use strict";

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { return '\u20b9' + Number(n || 0).toFixed(0); }
  function fmtDate(iso) {
    if (!iso) return '\u2014';
    var d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
    if (isNaN(d)) return '\u2014';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fmtDay(iso) {
    if (!iso) return '\u2014';
    var d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
    if (isNaN(d)) return '\u2014';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function todayISO() {
    var d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  function addDaysISO(iso, days) {
    var d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + Number(days));
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
  }
  function dueLabel(iso) {
    var n = daysBetween(todayISO(), String(iso).slice(0, 10));
    if (n < 0) return Math.abs(n) + ' day' + (Math.abs(n) === 1 ? '' : 's') + ' overdue';
    if (n === 0) return 'due back today';
    if (n === 1) return 'due back tomorrow';
    return 'due back in ' + n + ' days';
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
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
    return data;
  }

  function openModal(html) {
    document.getElementById('modalBody').innerHTML = html;
    document.getElementById('modalBackdrop').classList.add('open');
    var first = document.querySelector('#modalBody input, #modalBody textarea, #modalBody button');
    if (first) first.focus();
  }
  function closeModal() {
    document.getElementById('modalBackdrop').classList.remove('open');
    document.getElementById('modalBody').innerHTML = '';
  }
  function bindModalDismiss() {
    var backdrop = document.getElementById('modalBackdrop');
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
  }

  var toastTimer = null;
  function toast(message, isError) {
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.className = 'toast' + (isError ? ' err' : '');
    el.textContent = message;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.display = 'none'; }, 3600);
  }

  function on(id, event, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(event, fn);
  }
  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }
  function showError(containerId, message) {
    var el = document.getElementById(containerId);
    if (el) el.innerHTML = '<div class="banner error">' + esc(message) + '</div>';
  }

  function statusPill(loan) {
    if (loan.status === 'approved' && loan.isOverdue) return '<span class="pill overdue">overdue</span>';
    var label = { pending: 'waiting', approved: 'out now', returned: 'returned', rejected: 'declined', cancelled: 'withdrawn' }[loan.status] || loan.status;
    return '<span class="pill ' + loan.status + '">' + esc(label) + '</span>';
  }

  return {
    esc: esc, money: money, fmtDate: fmtDate, fmtDay: fmtDay, todayISO: todayISO, addDaysISO: addDaysISO,
    daysBetween: daysBetween, dueLabel: dueLabel, api: api, openModal: openModal, closeModal: closeModal,
    bindModalDismiss: bindModalDismiss, toast: toast, on: on, val: val, showError: showError, statusPill: statusPill
  };
})();

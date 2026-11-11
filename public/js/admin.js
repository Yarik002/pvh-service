'use strict';

/**
 * Сценарий страницы администратора.
 *
 * Загружает данные через API и заполняет таблицы:
 *   • сводку по состоянию пункта выдачи;
 *   • список пользователей;
 *   • справочник ячеек хранения.
 *
 * Если сессия истекла или недостаточно прав, пользователь перенаправляется
 * на страницу входа: сервер всё равно не отдаст данные, но так понятнее.
 */

document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  var API = window.PVH_API;
  if (!API) return;

  /** Экранирует текст перед вставкой в разметку. */
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Записывает значение в элемент по идентификатору. */
  function setText(id, value) {
    var node = document.getElementById(id);
    if (node) node.textContent = value == null ? '—' : String(value);
  }

  /** Показывает сообщение об ошибке загрузки. */
  function showLoadError(error) {
    var parsed = API.parseError(error);

    // Если общий перехватчик ошибок (api.js) уже показал уведомление,
    // второй раз то же сообщение не выводится
    if (window.PVH && !(error && error.notified)) {
      window.PVH.showAlert('danger',
        parsed.message + ' Обновите страницу или войдите заново.',
        'Не удалось загрузить данные');
    }

    // Нет прав или сессия истекла — возвращаемся на вход
    if (parsed.status === 401 || parsed.status === 403) {
      window.setTimeout(function () {
        window.location.href = '/login?next=%2Fadmin';
      }, 2500);
    }
  }

  // --- Сводка ------------------------------------------------------------

  function loadOverview() {
    return API.adminOverview()
      .then(function (data) {
        var o = data.overview || {};
        var users = o.users || {};
        var cells = o.cells || {};
        var orders = o.orders || {};
        var sessions = o.sessions || {};

        setText('stat-users', users.total);
        setText('stat-cells', cells.total);
        setText('stat-free', cells.free);
        setText('stat-orders', orders.total);

        setText('users-total', users.total);
        setText('users-confirmed', users.confirmed);
        setText('users-unconfirmed', users.unconfirmed);
        setText('users-admins', users.admins);
        setText('users-clients', users.clients);

        setText('orders-transit', orders.inTransit);
        setText('orders-ready', orders.readyForPickup);
        setText('orders-issued', orders.issued);
        setText('sessions-active', sessions.active);

        var summary = document.getElementById('users-summary');
        if (summary) {
          summary.textContent = cells.busy > 0
            ? 'Занято ячеек: ' + cells.busy + ' из ' + cells.total + '.'
            : 'Все ячейки свободны.';
        }
      });
  }

  // --- Пользователи ------------------------------------------------------

  function loadUsers() {
    return API.adminUsers()
      .then(function (data) {
        var tbody = document.querySelector('#users-table tbody');
        if (!tbody) return;

        var users = data.users || [];
        if (users.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" class="text-muted">'
            + 'Пользователей пока нет.</td></tr>';
          return;
        }

        tbody.innerHTML = users.map(function (user) {
          var roleBadge = user.role === 'admin'
            ? '<span class="badge badge--info">администратор</span>'
            : '<span class="badge badge--muted">клиент</span>';

          var confirmedBadge = user.isConfirmed
            ? '<span class="badge badge--success">подтверждён</span>'
            : '<span class="badge badge--warning">не подтверждён</span>';
          // 20-й день: клиента можно удалить (администратора — нет)
          var remove = user.role === 'client'
            ? '<button class="btn btn--ghost btn--sm" type="button" data-delete-user="' + user.id + '">Удалить</button>'
            : '';

          return '<tr>'
            + '<td>' + escapeHtml(user.id) + '</td>'
            + '<td>' + escapeHtml(user.name) + '</td>'
            + '<td>' + escapeHtml(user.email) + '</td>'
            + '<td>' + roleBadge + '</td>'
            + '<td>' + confirmedBadge + '</td>'
            + '<td class="table__actions">' + remove + '</td>'
            + '</tr>';
        }).join('');
      });
  }

  // Удаление клиента: подтверждение в окне, затем DELETE /api/admin/users/:id
  var usersTable = document.getElementById('users-table');
  if (usersTable) {
    usersTable.addEventListener('click', function (event) {
      var button = event.target.closest('[data-delete-user]');
      if (!button || !window.PVH || !window.PVH.confirm) return;
      var row = button.closest('tr');
      var email = row.children[2].textContent;

      window.PVH.confirm({
        title: 'Удалить клиента?',
        text: 'Учётная запись ' + email + ' и история её заказов будут удалены. '
          + 'Если в ячейках лежат заказы клиента, сервер откажет в удалении.',
        confirmText: 'Удалить',
        danger: true,
      }).then(function (confirmed) {
        if (!confirmed) return;
        API.deleteUser(button.getAttribute('data-delete-user'))
          .then(function (data) {
            var notify = window.PVH.toast || window.PVH.showAlert;
            notify('success', data.message, 'Клиент удалён');
            loadUsers();
            if (typeof loadOverview === 'function') loadOverview();
          })
          .catch(function (error) {
            var notify = window.PVH.toast || window.PVH.showAlert;
            notify('danger', API.parseError(error).message, 'Клиент не удалён');
          });
      });
    });
  }

  // --- Ячейки хранения ---------------------------------------------------

  function loadCells() {
    return API.cells('withOrders=true')
      .then(function (data) {
        var tbody = document.querySelector('#cells-table tbody');
        var summary = document.getElementById('cells-summary');
        if (!tbody) return;

        var cells = data.cells || [];
        var stats = data.summary || {};

        if (summary) {
          summary.textContent = 'Всего ячеек: ' + stats.total
            + '. Свободно: ' + stats.free
            + '. Занято: ' + stats.busy
            + ' (заполненность ' + stats.occupancyPercent + ' %).';
        }

        if (cells.length === 0) {
          tbody.innerHTML = '<tr><td colspan="2" class="text-muted">'
            + 'Справочник пуст.</td></tr>';
          return;
        }

        tbody.innerHTML = cells.map(function (cell) {
          var badge = cell.status === 'Свободна'
            ? '<span class="badge badge--success">Свободна</span>'
            : '<span class="badge badge--warning">Занята</span>';

          var note = cell.trackNumber
            ? ' <span class="text-muted">(' + escapeHtml(cell.trackNumber) + ')</span>'
            : '';

          return '<tr>'
            + '<td>' + escapeHtml(cell.cellNumber) + '</td>'
            + '<td>' + badge + note + '</td>'
            + '</tr>';
        }).join('');
      });
  }

  // --- Загрузка всех разделов -------------------------------------------

  Promise.all([loadOverview(), loadUsers(), loadCells()])
    .catch(showLoadError);
});

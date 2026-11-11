'use strict';

/**
 * Действия администратора на странице «Все заказы».
 *
 *   19-й день — выдача заказа с окном подтверждения.
 *
 * Сценарий объявляет функцию window.PVH_ORDER_ACTIONS(order): страница
 * списка (orders.js) вызывает её для каждой строки и получает ячейку
 * таблицы с кнопками. Окна построены на элементе <dialog>: браузер сам
 * блокирует страницу под окном, удерживает фокус и закрывает окно по Esc.
 */

(function () {
  'use strict';

  /** Ячейка «Действия» для строки заказа. */
  function actionsCell(order) {
    var td = document.createElement('td');
    td.className = 'table__actions';
    td.setAttribute('data-label', '');

    if (order.status === 'Готов к выдаче') {
      var issue = document.createElement('button');
      issue.type = 'button';
      issue.className = 'btn btn--accent btn--sm';
      issue.textContent = 'Выдать';
      issue.setAttribute('data-action', 'issue');
      issue.setAttribute('aria-label', 'Выдать заказ ' + order.trackNumber);
      td.appendChild(issue);
    }

    if (td.childNodes.length === 0) {
      var none = document.createElement('span');
      none.className = 'text-muted text-small';
      none.textContent = order.status === 'Выдан' ? 'выдан' : 'ожидается';
      td.appendChild(none);
    }

    return td;
  }

  window.PVH_ORDER_ACTIONS = actionsCell;

  // --- Окно выдачи ------------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', function () {
    var dialog = document.getElementById('issue-dialog');
    var table = document.getElementById('orders-table');
    if (!dialog || !table || !window.PVH_API) return;

    var confirmButton = document.getElementById('issue-confirm');
    var errorBox = document.getElementById('issue-error');
    var current = null;

    function setText(id, text) {
      var node = document.getElementById(id);
      if (node) node.textContent = text;
    }

    function openIssue(order) {
      current = order;
      setText('issue-cell', order.cell ? String(order.cell.cellNumber) : '—');
      setText('issue-track', order.trackNumber);
      setText('issue-client', order.client.name + ' (' + order.client.email + ')');
      setText('issue-description', order.description || '—');
      errorBox.hidden = true;
      confirmButton.disabled = false;
      confirmButton.textContent = 'Выдать заказ';
      dialog.returnValue = '';
      dialog.showModal();
    }

    // Кнопки в строках таблицы: один обработчик на всю таблицу
    table.addEventListener('click', function (event) {
      var button = event.target.closest('[data-action]');
      if (!button) return;
      var row = button.closest('tr');
      var order = window.PVH_ORDERS && window.PVH_ORDERS.findOrder(Number(row.getAttribute('data-order-id')));
      if (!order) return;
      if (button.getAttribute('data-action') === 'issue') openIssue(order);
    });

    confirmButton.addEventListener('click', function () {
      if (!current) return;
      var order = current;
      confirmButton.disabled = true;
      confirmButton.textContent = 'Выдача…';

      window.PVH_API.issueOrder(order.id)
        .then(function (data) {
          dialog.close('issued');
          if (window.PVH) {
            window.PVH.clearAlerts();
            window.PVH.showAlert('success', data.message, 'Заказ выдан');
          }
          if (window.PVH_ORDERS) window.PVH_ORDERS.load({ silent: true });
        })
        .catch(function (error) {
          // Окно не закрывается: администратор видит причину отказа
          setText('issue-error-text', window.PVH_API.parseError(error).message);
          errorBox.hidden = false;
          confirmButton.disabled = false;
          confirmButton.textContent = 'Повторить';
          // Список мог устареть (например, заказ выдали в другой вкладке)
          if (window.PVH_ORDERS) window.PVH_ORDERS.load({ silent: true }).catch(function () {});
        });
    });

    dialog.addEventListener('close', function () {
      current = null;
      dialog.returnValue = '';
    });
  });
}());

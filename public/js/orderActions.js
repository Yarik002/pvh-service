'use strict';

/**
 * Действия администратора на странице «Все заказы».
 *
 *   19-й день — выдача заказа с окном подтверждения;
 *   20-й день — ожидаемый заказ «В пути», изменение и удаление заказа.
 *
 * Сценарий объявляет функцию window.PVH_ORDER_ACTIONS(order): страница
 * списка (orders.js) вызывает её для каждой строки и получает ячейку
 * таблицы с кнопками. Окна построены на элементе <dialog>: браузер сам
 * блокирует страницу под окном, удерживает фокус и закрывает окно по Esc.
 */

(function () {
  'use strict';

  /** Небольшая кнопка действия в строке таблицы. */
  function actionButton(action, text, label, className) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--sm ' + className;
    button.textContent = text;
    button.setAttribute('data-action', action);
    button.setAttribute('aria-label', label);
    return button;
  }

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

    // Выданный заказ — история: изменить его нельзя, только удалить
    if (order.status !== 'Выдан') {
      td.appendChild(actionButton('edit', 'Изменить', 'Изменить заказ ' + order.trackNumber, 'btn--secondary'));
    }
    td.appendChild(actionButton('delete', 'Удалить', 'Удалить заказ ' + order.trackNumber, 'btn--ghost'));

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

    /** Сообщение о результате действия. */
    function notify(type, message, title) {
      if (!window.PVH) return;
      if (window.PVH.toast) {
        window.PVH.toast(type, message, title);
      } else {
        window.PVH.clearAlerts();
        window.PVH.showAlert(type, message, title);
      }
    }

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
      var action = button.getAttribute('data-action');
      if (action === 'issue') openIssue(order);
      if (action === 'edit') openOrderForm(order);
      if (action === 'delete') deleteOrder(order);
    });

    // --- Создание и изменение заказа (20-й день) ------------------------------------

    var formDialog = document.getElementById('order-dialog');
    var form = document.getElementById('order-form');
    var submitButton = document.getElementById('order-submit');
    var editing = null;
    var clientsLoaded = false;

    /** Подсказки получателя: список клиентов загружается один раз. */
    function loadClients() {
      if (clientsLoaded) return;
      clientsLoaded = true;
      window.PVH_API.adminUsers('role=client')
        .then(function (data) {
          var list = document.getElementById('order-clients');
          (data.users || []).forEach(function (user) {
            var option = document.createElement('option');
            option.value = user.email;
            option.label = user.name;
            list.appendChild(option);
          });
        })
        .catch(function () { clientsLoaded = false; });
    }

    function openOrderForm(order) {
      editing = order || null;
      if (window.PVH_FORM) window.PVH_FORM.clearErrors(form);
      form.elements.trackNumber.value = order ? order.trackNumber : '';
      form.elements.clientEmail.value = order ? order.client.email : '';
      form.elements.description.value = order ? (order.description || '') : '';
      setText('order-dialog-title', order ? 'Изменить заказ ' + order.trackNumber : 'Ожидаемый заказ');
      setText('order-dialog-text', order
        ? 'Исправьте трек-номер, получателя или описание. Статус и ячейка не меняются.'
        : 'Посылка ещё в пути: заказ получит статус «В пути», ячейка будет назначена при приёмке.');
      submitButton.textContent = order ? 'Сохранить' : 'Зарегистрировать';
      loadClients();
      formDialog.showModal();
      form.elements.trackNumber.focus();
    }

    var createButton = document.getElementById('order-create');
    if (createButton) createButton.addEventListener('click', function () { openOrderForm(null); });
    document.getElementById('order-cancel').addEventListener('click', function () { formDialog.close(); });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var checked = window.PVH_FORM.validateForm(form);
      if (!checked.valid) return;

      var payload = {
        trackNumber: checked.values.trackNumber.trim(),
        clientEmail: checked.values.clientEmail.trim(),
        description: checked.values.description.trim(),
      };
      var request = editing
        ? window.PVH_API.updateOrder(editing.id, payload)
        : window.PVH_API.createExpectedOrder(payload);

      window.PVH_FORM.setBusy(submitButton, true, 'Сохранение…');
      request
        .then(function (data) {
          window.PVH_FORM.setBusy(submitButton, false);
          formDialog.close();
          notify('success', data.message, editing ? 'Заказ изменён' : 'Заказ зарегистрирован');
          if (window.PVH_ORDERS) window.PVH_ORDERS.load({ silent: true });
        })
        .catch(function (error) {
          window.PVH_FORM.setBusy(submitButton, false);
          var parsed = window.PVH_API.parseError(error);
          // Ошибки сервера выводятся у полей формы; «client» — это поле получателя
          var fields = parsed.fields || {};
          if (fields.client) fields.clientEmail = fields.client;
          window.PVH_FORM.showServerErrors(fields);
          if (!Object.keys(fields).length) window.PVH_FORM.setFieldError('trackNumber', parsed.message);
        });
    });

    // --- Удаление заказа (20-й день) ---------------------------------------------------

    function deleteOrder(order) {
      var inCell = order.status === 'Готов к выдаче' && order.cell;
      window.PVH.confirm({
        title: 'Удалить заказ ' + order.trackNumber + '?',
        text: 'Заказ клиента ' + order.client.name + ' будет удалён без возможности восстановления.'
          + (inCell ? ' Ячейка № ' + order.cell.cellNumber + ' станет свободной — заберите из неё посылку.' : ''),
        confirmText: 'Удалить заказ',
        danger: true,
      }).then(function (confirmed) {
        if (!confirmed) return;
        window.PVH_API.deleteOrder(order.id)
          .then(function (data) {
            notify('success', data.message, 'Заказ удалён');
            if (window.PVH_ORDERS) window.PVH_ORDERS.load({ silent: true });
          })
          .catch(function (error) {
            notify('danger', window.PVH_API.parseError(error).message, 'Заказ не удалён');
          });
      });
    }

    confirmButton.addEventListener('click', function () {
      if (!current) return;
      var order = current;
      confirmButton.disabled = true;
      confirmButton.textContent = 'Выдача…';

      window.PVH_API.issueOrder(order.id)
        .then(function (data) {
          dialog.close('issued');
          notify('success', data.message, 'Заказ выдан');
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

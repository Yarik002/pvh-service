'use strict';

/**
 * Сценарий страницы «Приёмка товара» (15-й день практики).
 *
 * Порядок работы администратора:
 *   1) ввести трек-номер и выбрать получателя (подсказки из списка клиентов);
 *   2) при необходимости указать описание посылки;
 *   3) выбрать ячейку: автоматически (первая свободная) или вручную;
 *      ячейка, которая будет назначена, показывается заранее;
 *   4) нажать «Принять посылку» — заказ сохраняется (POST /api/orders),
 *      на экране крупно показывается номер ячейки, клиенту уходит письмо.
 *
 * Все тексты из базы данных выводятся через textContent, поэтому трек-номер
 * или имя клиента не могут внедрить код на страницу.
 */

document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  var API = window.PVH_API;
  var FORM = window.PVH_FORM;
  var form = document.getElementById('receive-form');
  if (!API || !FORM || !form) return;

  var submitButton = document.getElementById('receive-submit');
  var cellSelect = document.getElementById('field-cellId');
  var manualBlock = document.getElementById('manual-cell');
  var preview = document.getElementById('cell-preview');
  var clientInput = form.querySelector('[name="clientEmail"]');
  var trackInput = form.querySelector('[name="trackNumber"]');
  var descriptionInput = form.querySelector('[name="description"]');
  var history = [];

  /**
   * Поля ответа сервера и поля формы называются почти одинаково;
   * отличаются только получатель и ячейка.
   */
  var SERVER_FIELDS = { client: 'clientEmail', cell: 'cellId', mode: 'cellMode' };

  FORM.watchFields(form);
  if (clientInput) clientInput.setAttribute('list', 'clients-list');

  /** Выбранный способ назначения ячейки. */
  function currentMode() {
    var checked = form.querySelector('[name="cellMode"]:checked');
    return checked ? checked.value : 'auto';
  }

  /** Записывает текст в элемент по идентификатору. */
  function setText(id, value) {
    var node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  /** Показывает сообщение под переключателем ячейки. */
  function showPreview(text, kind) {
    preview.textContent = text;
    preview.className = 'receive-preview' + (kind ? ' receive-preview--' + kind : '');
  }

  // --- Справочники: клиенты и свободные ячейки -----------------------------

  /** Загружает клиентов для подсказок в поле получателя. */
  function loadClients() {
    return API.adminUsers('role=client').then(function (data) {
      var list = document.getElementById('clients-list');
      if (!list) return;

      list.textContent = '';
      (data.users || []).forEach(function (user) {
        var option = document.createElement('option');
        option.value = user.email;
        option.label = user.name + (user.isConfirmed ? '' : ' (адрес не подтверждён)');
        list.appendChild(option);
      });
    }).catch(function () {
      // Подсказки — вспомогательная функция: без них адрес вводится вручную
    });
  }

  /** Загружает свободные ячейки в список ручного выбора. */
  function loadFreeCells() {
    return API.freeCells().then(function (data) {
      var selected = cellSelect.value;
      cellSelect.textContent = '';

      var placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = data.count > 0 ? 'Выберите ячейку' : 'Свободных ячеек нет';
      cellSelect.appendChild(placeholder);

      (data.cells || []).forEach(function (cell) {
        var option = document.createElement('option');
        option.value = String(cell.id);
        option.textContent = 'Ячейка № ' + cell.cellNumber;
        cellSelect.appendChild(option);
      });

      // Если выбранная ранее ячейка всё ещё свободна, выбор сохраняется
      if (selected && cellSelect.querySelector('option[value="' + selected + '"]')) {
        cellSelect.value = selected;
      }

      setText('receive-stock', data.count > 0
        ? 'Свободных ячеек: ' + data.count + '. Первая свободная — № ' + data.firstFreeNumber + '.'
        : 'Свободных ячеек нет — принять посылку нельзя, пока не будет выдан один из заказов.');
      submitButton.disabled = data.count === 0;
    });
  }

  /** Показывает, какая ячейка будет назначена (ячейка не занимается). */
  function updatePreview() {
    var mode = currentMode();
    manualBlock.hidden = mode !== 'manual';

    if (mode === 'manual' && !cellSelect.value) {
      showPreview('Выберите ячейку из списка свободных.', 'info');
      return Promise.resolve();
    }

    return API.suggestCell({ mode: mode, cellId: mode === 'manual' ? cellSelect.value : '' })
      .then(function (data) {
        showPreview(data.message, 'ok');
      })
      .catch(function (error) {
        var parsed = API.parseError(error);
        showPreview(parsed.message, 'error');
        if (parsed.code === 'NO_FREE_CELLS') submitButton.disabled = true;
      });
  }

  /** Обновляет справочник ячеек и подсказку о назначаемой ячейке. */
  function refreshCells() {
    return loadFreeCells().then(updatePreview).catch(function (error) {
      showPreview(API.parseError(error).message, 'error');
    });
  }

  // --- Результат приёмки ----------------------------------------------------

  /** Добавляет заказ в список «Принято за сеанс». */
  function addToHistory(order) {
    history.unshift(order);
    history = history.slice(0, 5);

    var list = document.getElementById('receive-history');
    list.textContent = '';
    history.forEach(function (item) {
      var row = document.createElement('li');
      var track = document.createElement('span');
      track.className = 'text-mono';
      track.textContent = item.trackNumber;
      row.appendChild(track);
      row.appendChild(document.createTextNode(
        ' → ячейка № ' + item.cell.cellNumber + ', ' + item.client.name,
      ));
      list.appendChild(row);
    });
  }

  /** Показывает результат приёмки. */
  function showResult(data) {
    var order = data.order;
    var mail = data.notification || {};

    setText('result-cell', '№ ' + order.cell.cellNumber);
    setText('result-text', 'Заказ ' + order.trackNumber + ' для клиента ' + order.client.name
      + (data.fromTransit ? ' (заказ ожидался в пункте выдачи)' : '') + '.');
    setText('result-mail', mail.sent
      ? 'Клиенту отправлено письмо о поступлении заказа.'
      : mail.logged
        ? 'Отправка писем не настроена: письмо выведено в журнал сервера.'
        : 'Письмо клиенту отправить не удалось' + (mail.error ? ': ' + mail.error : '') + '.');

    document.getElementById('receive-result').hidden = false;
    addToHistory(order);

    if (window.PVH) {
      window.PVH.showAlert('success', data.message, 'Посылка принята');
    }
  }

  /** Очищает форму для следующей посылки. */
  function resetForm() {
    trackInput.value = '';
    clientInput.value = '';
    descriptionInput.value = '';
    setText('description-counter', '0 из 500 символов');
    FORM.clearErrors(form);
    trackInput.focus();
  }

  // --- Обработчики ----------------------------------------------------------

  Array.prototype.forEach.call(form.querySelectorAll('[name="cellMode"]'), function (radio) {
    radio.addEventListener('change', updatePreview);
  });
  cellSelect.addEventListener('change', updatePreview);

  descriptionInput.addEventListener('input', function () {
    setText('description-counter', descriptionInput.value.length + ' из 500 символов');
  });

  document.getElementById('receive-next').addEventListener('click', function () {
    document.getElementById('receive-result').hidden = true;
    if (window.PVH) window.PVH.clearAlerts();
    trackInput.focus();
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (window.PVH) window.PVH.clearAlerts();

    var checked = FORM.validateForm(form);
    if (!checked.valid) {
      window.PVH.showAlert('danger', 'Проверьте правильность заполнения полей формы.',
        'Посылка не принята');
      return;
    }

    var payload = {
      trackNumber: String(checked.values.trackNumber).trim().toUpperCase(),
      clientEmail: String(checked.values.clientEmail).trim(),
      description: String(checked.values.description || '').trim(),
      cellMode: currentMode(),
    };
    if (payload.cellMode === 'manual') payload.cellId = checked.values.cellId;

    FORM.setBusy(submitButton, true, 'Сохранение…');

    API.receiveOrder(payload)
      .then(function (data) {
        FORM.setBusy(submitButton, false);
        showResult(data);
        resetForm();
        return refreshCells();
      })
      .catch(function (error) {
        FORM.setBusy(submitButton, false);

        // Ошибки по полям выводятся у соответствующих полей формы
        var parsed = API.parseError(error);
        var fields = null;
        if (parsed.fields) {
          fields = {};
          Object.keys(parsed.fields).forEach(function (name) {
            fields[SERVER_FIELDS[name] || name] = parsed.fields[name];
          });
        }

        FORM.reportError({ message: parsed.message, code: parsed.code, status: parsed.status, fields: fields });

        // Ячейка могла быть занята другим администратором — обновляем список
        if (parsed.code === 'CELL_BUSY' || parsed.code === 'NO_FREE_CELLS') refreshCells();
      });
  });

  // --- Загрузка страницы ----------------------------------------------------
  loadClients();
  refreshCells();
});

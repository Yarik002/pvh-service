'use strict';

/**
 * Сценарий страницы «Ячейки хранения».
 *
 * Загружает состояние ячеек через API и показывает их сеткой:
 * зелёная плитка — свободная ячейка, оранжевая — занятая.
 * Фильтр «Все / Свободные / Занятые» работает без повторного запроса.
 * Администратор может нажать на ячейку и увидеть заказ, который в ней лежит.
 *
 * Разметка плиток создаётся через document.createElement и textContent,
 * а не через innerHTML: так данные из базы не могут внедрить код на страницу.
 */

document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  var API = window.PVH_API;
  var grid = document.getElementById('cells-grid');
  if (!API || !grid) return;

  var isAdmin = document.body && document.body.getAttribute('data-role') === 'admin';
  var cells = [];
  var filter = 'all';

  /** Записывает текст в элемент по идентификатору. */
  function setText(id, value) {
    var node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  /** Выводит сводку по складу. */
  function showSummary(summary) {
    setText('cells-total', String(summary.total));
    setText('cells-free', String(summary.free));
    setText('cells-busy', String(summary.busy));
    setText('cells-occupancy', summary.occupancyPercent + ' %');

    var time = new Date(summary.generatedAt || Date.now()).toLocaleTimeString('ru-RU');
    setText('cells-updated', 'Данные обновлены в ' + time
      + (summary.free > 0
        ? '. Первая свободная ячейка — № ' + summary.firstFreeNumber + '.'
        : '. Свободных ячеек нет.'));
  }

  /** Создаёт плитку одной ячейки. */
  function createTile(cell) {
    var item = document.createElement('li');
    var tile = document.createElement(isAdmin ? 'button' : 'div');
    var free = cell.status === 'Свободна';

    tile.className = 'cell-tile ' + (free ? 'cell-tile--free' : 'cell-tile--busy');
    if (isAdmin) {
      tile.type = 'button';
      tile.setAttribute('data-cell-id', String(cell.id));
    }

    var number = document.createElement('span');
    number.className = 'cell-tile__number';
    number.textContent = '№ ' + cell.cellNumber;

    var status = document.createElement('span');
    status.className = 'cell-tile__status';
    status.textContent = cell.status;

    tile.appendChild(number);
    tile.appendChild(status);

    if (cell.trackNumber) {
      var track = document.createElement('span');
      track.className = 'cell-tile__track text-mono';
      track.textContent = cell.trackNumber;
      tile.appendChild(track);
    }

    tile.setAttribute('aria-label', 'Ячейка ' + cell.cellNumber + ': ' + cell.status.toLowerCase()
      + (cell.trackNumber ? ', заказ ' + cell.trackNumber : ''));

    item.appendChild(tile);
    return item;
  }

  /** Перерисовывает сетку с учётом фильтра. */
  function render() {
    var visible = cells.filter(function (cell) {
      if (filter === 'free') return cell.status === 'Свободна';
      if (filter === 'busy') return cell.status === 'Занята';
      return true;
    });

    grid.textContent = '';

    if (visible.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'text-muted';
      empty.textContent = filter === 'free' ? 'Свободных ячеек нет.'
        : filter === 'busy' ? 'Занятых ячеек нет.' : 'Справочник ячеек пуст.';
      grid.appendChild(empty);
      return;
    }

    visible.forEach(function (cell) {
      grid.appendChild(createTile(cell));
    });
  }

  /** Загружает состояние ячеек с сервера. */
  function load() {
    setText('cells-updated', 'Загрузка сведений…');

    return API.cells(isAdmin ? 'withOrders=true' : '')
      .then(function (data) {
        cells = data.cells || [];
        showSummary(data.summary || {});
        render();
      })
      .catch(function (error) {
        var parsed = API.parseError(error);
        setText('cells-updated', 'Не удалось загрузить сведения о ячейках.');
        if (window.PVH) window.PVH.showAlert('danger', parsed.message, 'Ошибка загрузки');
      });
  }

  /** Показывает сведения о ячейке и заказе в ней (администратор). */
  function showDetails(id) {
    var card = document.getElementById('cell-details');
    var body = document.getElementById('cell-details-body');
    if (!card || !body) return;

    API.cell(id)
      .then(function (data) {
        var cell = data.cell;
        setText('cell-details-title', 'Ячейка № ' + cell.cellNumber + ' — ' + cell.status);
        body.textContent = '';

        var lines = cell.order
          ? [
            ['Трек-номер', cell.order.trackNumber],
            ['Получатель', cell.order.client.name + ' (' + cell.order.client.email + ')'],
            ['Описание', cell.order.description || '—'],
            ['Поступил', cell.order.receivedAt
              ? new Date(cell.order.receivedAt).toLocaleString('ru-RU') : '—'],
          ]
          : [['Заказ', 'в ячейке нет заказа']];

        lines.forEach(function (line) {
          var row = document.createElement('p');
          var label = document.createElement('strong');
          label.textContent = line[0] + ': ';
          row.appendChild(label);
          row.appendChild(document.createTextNode(line[1]));
          body.appendChild(row);
        });

        card.hidden = false;
      })
      .catch(function (error) {
        if (window.PVH) window.PVH.showAlert('danger', API.parseError(error).message, 'Ошибка');
      });
  }

  // --- Фильтр -------------------------------------------------------------
  var filterButtons = document.querySelectorAll('[data-cells-filter]');
  Array.prototype.forEach.call(filterButtons, function (button) {
    button.addEventListener('click', function () {
      filter = button.getAttribute('data-cells-filter');

      Array.prototype.forEach.call(filterButtons, function (other) {
        var active = other === button;
        other.setAttribute('aria-pressed', String(active));
        other.classList.toggle('btn--secondary', !active);
      });

      render();
    });
  });

  // --- Обновление и сведения о ячейке ---------------------------------------
  var refresh = document.getElementById('cells-refresh');
  if (refresh) refresh.addEventListener('click', load);

  if (isAdmin) {
    grid.addEventListener('click', function (event) {
      var tile = event.target.closest('[data-cell-id]');
      if (tile) showDetails(tile.getAttribute('data-cell-id'));
    });
  }

  load();
});

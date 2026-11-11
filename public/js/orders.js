'use strict';

/**
 * Страница «Мои заказы» / «Все заказы» (17-й день практики).
 *
 * Сценарий загружает список заказов через API 16-го дня и строит таблицу.
 * Фильтр по статусу, поиск и сортировка выполняются на сервере: страница
 * только передаёт параметры status, search, sort и order.
 *
 * Выбранные фильтры записываются в адрес страницы (?status=ready&sort=cell),
 * поэтому после перезагрузки или по ссылке открывается тот же вид списка.
 */

document.addEventListener('DOMContentLoaded', function () {
  var table = document.getElementById('orders-table');
  if (!table || !window.PVH_API) return;

  var API = window.PVH_API;
  var isAdmin = table.getAttribute('data-admin') === 'true';
  var body = document.getElementById('orders-body');
  var empty = document.getElementById('orders-empty');
  var searchInput = document.getElementById('orders-search');
  var sortSelect = document.getElementById('orders-sort');
  var statusButtons = document.querySelectorAll('[data-status]');
  var headers = table.querySelectorAll('th[data-sort]');

  /** Названия статусов и оформление значков. */
  var STATUS = {
    'В пути': { key: 'transit', badge: 'badge--info' },
    'Готов к выдаче': { key: 'ready', badge: 'badge--success' },
    'Выдан': { key: 'issued', badge: 'badge--muted' },
  };

  /** Направление сортировки по умолчанию: даты — новые сверху, остальное — по возрастанию. */
  var DEFAULT_ORDER = { receivedAt: 'desc', issuedAt: 'desc' };

  /** Текущие параметры списка. */
  var state = readStateFromUrl();

  /** Последний загруженный список — нужен автообновлению и действиям. */
  var orders = [];

  // --- Параметры в адресе страницы ------------------------------------------

  function readStateFromUrl() {
    var params = new URLSearchParams(window.location.search);
    var status = params.get('status');
    return {
      status: ['transit', 'ready', 'issued'].indexOf(status) !== -1 ? status : 'all',
      search: (params.get('search') || '').slice(0, 100),
      sort: params.get('sort') || 'receivedAt',
      order: params.get('order') === 'asc' ? 'asc' : (params.get('order') === 'desc' ? 'desc' : (DEFAULT_ORDER[params.get('sort') || 'receivedAt'] || 'asc')),
    };
  }

  function writeStateToUrl() {
    var params = new URLSearchParams();
    if (state.status !== 'all') params.set('status', state.status);
    if (state.search) params.set('search', state.search);
    if (state.sort !== 'receivedAt' || state.order !== 'desc') {
      params.set('sort', state.sort);
      params.set('order', state.order);
    }
    var query = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (query ? '?' + query : ''));
  }

  /** Строка запроса к API из текущих параметров. */
  function apiQuery() {
    var params = new URLSearchParams();
    params.set('status', state.status);
    if (state.search) params.set('search', state.search);
    params.set('sort', state.sort);
    params.set('order', state.order);
    return params.toString();
  }

  // --- Оформление значений ----------------------------------------------------

  /** Дата в виде «11.11.2026, 09:12». */
  function formatDate(iso) {
    if (!iso) return '—';
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  /** Создаёт элемент с классом и текстом. */
  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Ячейка таблицы с подписью для мобильного вида (data-label). */
  function cell(label, content, className) {
    var td = document.createElement('td');
    td.setAttribute('data-label', label);
    if (className) td.className = className;
    if (content instanceof Node) td.appendChild(content);
    else td.textContent = content;
    return td;
  }

  function statusBadge(status) {
    var info = STATUS[status] || { badge: 'badge--muted' };
    return element('span', 'badge badge--status ' + info.badge, status);
  }

  function cellChip(order) {
    if (!order.cell) return element('span', 'cell-chip cell-chip--empty', '—');
    var chip = element('span', 'cell-chip', '№ ' + order.cell.cellNumber);
    // Выданный заказ уже не лежит в ячейке: номер показывается приглушённо
    if (order.status === 'Выдан') chip.className = 'cell-chip cell-chip--empty';
    return chip;
  }

  // --- Таблица ------------------------------------------------------------------

  /**
   * Строка таблицы для заказа. Действия администратора (выдача,
   * изменение, удаление) добавляются функцией extraCells.
   */
  function createRow(order) {
    var tr = document.createElement('tr');
    tr.setAttribute('data-order-id', String(order.id));

    tr.appendChild(cell('Трек-номер', element('span', 'track', order.trackNumber)));

    var desc = element('span', 'order-desc', order.description || '—');
    if (order.description) desc.title = order.description;
    tr.appendChild(cell('Описание', desc, 'table__wide'));

    if (isAdmin) {
      var client = element('span', 'order-client');
      client.appendChild(element('span', '', order.client.name));
      client.appendChild(element('small', '', order.client.email));
      tr.appendChild(cell('Клиент', client, 'table__wide'));
    }

    tr.appendChild(cell('Ячейка', cellChip(order)));
    tr.appendChild(cell('Статус', statusBadge(order.status)));
    tr.appendChild(cell('Поступил', element('span', 'order-date', formatDate(order.receivedAt))));
    tr.appendChild(cell('Выдан', element('span', 'order-date', formatDate(order.issuedAt))));

    if (isAdmin && typeof window.PVH_ORDER_ACTIONS === 'function') {
      tr.appendChild(window.PVH_ORDER_ACTIONS(order));
    }

    return tr;
  }

  /** Текст пустого списка зависит от того, применены ли фильтры. */
  function showEmpty(counts) {
    var title = document.getElementById('orders-empty-title');
    var text = document.getElementById('orders-empty-text');
    var filtered = state.status !== 'all' || state.search;

    if (filtered && counts && counts.all > 0) {
      title.textContent = 'Ничего не найдено';
      text.textContent = 'Под выбранные условия заказы не подходят. Сбросьте фильтр или измените строку поиска.';
    } else {
      title.textContent = 'Заказов пока нет';
      text.textContent = isAdmin
        ? 'Примите первую посылку на странице «Приёмка товара».'
        : 'Когда пункт выдачи примет посылку на ваше имя, она появится здесь.';
    }
    empty.hidden = false;
  }

  function render(data) {
    orders = data.orders || [];
    body.textContent = '';
    empty.hidden = true;
    table.querySelector('thead').hidden = orders.length === 0;

    if (orders.length === 0) {
      showEmpty(data.counts);
    } else {
      var fragment = document.createDocumentFragment();
      orders.forEach(function (order) { fragment.appendChild(createRow(order)); });
      body.appendChild(fragment);
    }

    updateCounts(data.counts || {});
    updateSortIndicators();

    var summary = document.getElementById('orders-summary');
    if (summary) {
      summary.textContent = orders.length
        ? 'Показано заказов: ' + orders.length + ' из ' + ((data.counts && data.counts.all) || orders.length) + '.'
        : '';
    }
  }

  function updateCounts(counts) {
    var map = { all: counts.all, transit: counts.inTransit, ready: counts.ready, issued: counts.issued };
    Object.keys(map).forEach(function (key) {
      var node = document.getElementById('count-' + key);
      if (node) node.textContent = String(map[key] || 0);
    });
  }

  function updateSortIndicators() {
    Array.prototype.forEach.call(headers, function (th) {
      var active = th.getAttribute('data-sort') === state.sort;
      th.setAttribute('aria-sort', active ? (state.order === 'asc' ? 'ascending' : 'descending') : 'none');
    });

    Array.prototype.forEach.call(statusButtons, function (button) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-status') === state.status));
    });

    var value = state.sort + ':' + state.order;
    var hasOption = Array.prototype.some.call(sortSelect.options, function (option) {
      return option.value === value;
    });
    if (!hasOption) {
      var option = document.createElement('option');
      option.value = value;
      option.textContent = 'Выбрано в таблице';
      sortSelect.appendChild(option);
    }
    sortSelect.value = value;
  }

  // --- Плашка «заказы ждут выдачи» (клиент) ------------------------------------

  function updatePickupBanner() {
    var banner = document.getElementById('pickup-banner');
    if (!banner || isAdmin) return Promise.resolve();

    return API.myOrders('status=ready&sort=cell&order=asc')
      .then(function (data) {
        var ready = data.orders || [];
        banner.hidden = ready.length === 0;
        if (ready.length === 0) return;

        document.getElementById('pickup-title').textContent = ready.length === 1
          ? 'Заказ ждёт вас в пункте выдачи'
          : 'В пункте выдачи вас ждут заказы: ' + ready.length;

        var cells = document.getElementById('pickup-cells');
        cells.textContent = '';
        ready.forEach(function (order) {
          var chip = element('span', 'cell-chip', '№ ' + order.cell.cellNumber);
          chip.title = order.trackNumber;
          cells.appendChild(chip);
        });
      })
      .catch(function () { banner.hidden = true; });
  }

  // --- Загрузка -----------------------------------------------------------------

  var requestId = 0;

  /**
   * Загружает список с текущими параметрами.
   * @param {{silent?: boolean}} [options] silent — не показывать «Загрузка…»
   *        (используется автообновлением, 21-й день)
   * @returns {Promise<object|null>} ответ сервера
   */
  function load(options) {
    var silent = options && options.silent;
    var current = ++requestId;
    var updated = document.getElementById('orders-updated');
    if (!silent && updated) updated.textContent = 'Загрузка…';

    var request = isAdmin ? API.allOrders(apiQuery()) : API.myOrders(apiQuery());

    return request
      .then(function (data) {
        // Ответ на устаревший запрос (пользователь уже сменил фильтр) не показывается
        if (current !== requestId) return null;
        render(data);
        if (updated) {
          updated.textContent = 'Обновлено в ' + new Date().toLocaleTimeString('ru-RU',
            { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        }
        updatePickupBanner();
        return data;
      })
      .catch(function (error) {
        if (current !== requestId) return null;
        var parsed = API.parseError(error);
        if (updated) updated.textContent = 'Не удалось обновить список';
        if (!silent && window.PVH) window.PVH.showAlert('danger', parsed.message, 'Ошибка загрузки заказов');
        throw error;
      });
  }

  function reload() {
    writeStateToUrl();
    return load().catch(function () { return null; });
  }

  // --- Обработчики панели фильтров ----------------------------------------------

  Array.prototype.forEach.call(statusButtons, function (button) {
    button.addEventListener('click', function () {
      state.status = button.getAttribute('data-status');
      reload();
    });
  });

  var searchTimer = null;
  searchInput.value = state.search;
  searchInput.addEventListener('input', function () {
    // Запрос отправляется, когда пользователь перестал печатать
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(function () {
      state.search = searchInput.value.trim();
      reload();
    }, 300);
  });

  sortSelect.addEventListener('change', function () {
    var parts = sortSelect.value.split(':');
    state.sort = parts[0];
    state.order = parts[1] || 'asc';
    reload();
  });

  Array.prototype.forEach.call(headers, function (th) {
    th.querySelector('button').addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      if (state.sort === key) {
        state.order = state.order === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort = key;
        state.order = DEFAULT_ORDER[key] || 'asc';
      }
      reload();
    });
  });

  // Публичный интерфейс страницы: автообновление и действия администратора
  window.PVH_ORDERS = {
    load: load,
    reload: reload,
    getOrders: function () { return orders; },
    getState: function () { return state; },
    findOrder: function (id) {
      return orders.filter(function (order) { return order.id === id; })[0] || null;
    },
  };

  reload();
});

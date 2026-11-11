'use strict';

/**
 * Автообновление списка заказов (21-й день практики).
 *
 * Страница «Мои заказы» / «Все заказы» сама опрашивает сервер (polling)
 * каждые 15 секунд и перерисовывает таблицу. Если у заказа сменился статус
 * (например, посылку приняли в пункт выдачи), строка подсвечивается
 * и показывается сообщение «Заказ … — Готов к выдаче, ячейка № 7».
 *
 * Правила опроса:
 *   • пока вкладка браузера скрыта, запросы не отправляются — сервер
 *     не нагружается впустую; при возврате на вкладку список обновляется сразу;
 *   • при ошибке сети интервал увеличивается (30, 60 … до 120 секунд),
 *     после успешного ответа возвращается к 15 секундам;
 *   • одновременно выполняется не больше одного запроса.
 */

(function () {
  'use strict';

  /** Обычный интервал опроса, мс. */
  var INTERVAL_MS = 15000;

  /** Наибольший интервал при повторяющихся ошибках, мс. */
  var MAX_INTERVAL_MS = 120000;

  /**
   * Сравнивает два списка и возвращает заказы, у которых сменился статус,
   * и новые заказы, которых раньше не было.
   *
   * @param {object[]} before прежний список
   * @param {object[]} after  новый список
   * @returns {{changed: object[], added: object[]}}
   */
  function diffOrders(before, after) {
    var previous = {};
    (before || []).forEach(function (order) { previous[order.id] = order.status; });

    var changed = [];
    var added = [];
    (after || []).forEach(function (order) {
      if (!(order.id in previous)) added.push(order);
      else if (previous[order.id] !== order.status) changed.push(order);
    });
    return { changed: changed, added: added };
  }

  /** Текст сообщения о смене статуса. */
  function describe(order) {
    var text = 'Заказ ' + order.trackNumber + ' — «' + order.status + '»';
    if (order.status === 'Готов к выдаче' && order.cell) text += ', ячейка № ' + order.cell.cellNumber;
    return text + '.';
  }

  /** Следующий интервал после ошибки: удваивается до предела. */
  function nextDelay(current, failed) {
    if (!failed) return INTERVAL_MS;
    return Math.min(current * 2, MAX_INTERVAL_MS);
  }

  window.PVH_LIVE = {
    diffOrders: diffOrders,
    describe: describe,
    nextDelay: nextDelay,
    INTERVAL_MS: INTERVAL_MS,
    MAX_INTERVAL_MS: MAX_INTERVAL_MS,
  };

  if (typeof document === 'undefined' || !document.addEventListener) return;

  document.addEventListener('DOMContentLoaded', function () {
    var live = document.getElementById('orders-live');
    var label = document.getElementById('orders-updated');
    if (!live || !window.PVH_ORDERS) return;

    var delay = INTERVAL_MS;
    var timer = null;
    var busy = false;

    function setState(state, text) {
      live.className = 'live' + (state ? ' live--' + state : '');
      if (text && label) label.textContent = text;
    }

    function highlight(orders) {
      orders.forEach(function (order) {
        var row = document.querySelector('tr[data-order-id="' + order.id + '"]');
        if (row) row.classList.add('row--changed');
      });
    }

    function notify(changes) {
      var list = changes.changed;
      if (list.length === 0 && changes.added.length === 0) return;

      var message = list.length
        ? list.map(describe).join(' ')
        : 'Новых заказов: ' + changes.added.length + '.';
      var title = list.length ? 'Статус заказа обновился' : 'Появились новые заказы';

      if (window.PVH && window.PVH.toast) window.PVH.toast('info', message, title);
      else if (window.PVH) window.PVH.showAlert('info', message, title);
    }

    function schedule() {
      window.clearTimeout(timer);
      timer = window.setTimeout(tick, delay);
    }

    function tick() {
      if (document.visibilityState === 'hidden') {
        setState('paused', 'Обновление на паузе');
        return;                       // продолжится при возврате на вкладку
      }
      if (busy) { schedule(); return; }

      busy = true;
      var before = window.PVH_ORDERS.getOrders().slice();

      window.PVH_ORDERS.load({ silent: true })
        .then(function (data) {
          busy = false;
          delay = nextDelay(delay, false);
          if (data) {
            var changes = diffOrders(before, data.orders);
            highlight(changes.changed.concat(changes.added));
            notify(changes);
          }
          setState('', null);
          schedule();
        })
        .catch(function () {
          busy = false;
          delay = nextDelay(delay, true);
          setState('error', 'Нет связи, повтор через ' + Math.round(delay / 1000) + ' с');
          schedule();
        });
    }

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        delay = INTERVAL_MS;
        tick();                       // вернулись на вкладку — обновляем сразу
      }
    });

    live.title = 'Список обновляется автоматически каждые ' + (INTERVAL_MS / 1000) + ' секунд';
    schedule();
  });
}());

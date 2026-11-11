'use strict';

/**
 * Разметка страниц «Мои заказы» и «Все заказы» (17-й день практики).
 *
 * Одна разметка на обе роли: клиент видит свои заказы, администратор —
 * заказы всех клиентов с дополнительным столбцом «Клиент». Данные загружает
 * сценарий public/js/orders.js через API 16-го дня:
 *   GET /api/orders/my — «Мои заказы»;
 *   GET /api/orders    — «Все заказы» (администратор).
 *
 * Панель фильтров: вкладки статусов со счётчиками, поиск и выбор сортировки
 * (на телефоне, где заголовков столбцов не видно). Нажатие на заголовок
 * столбца меняет сортировку.
 */

/** Значок лупы в поле поиска. */
const SEARCH_ICON = `<svg class="field__affix-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;

/**
 * Заголовок столбца с сортировкой.
 * @param {string} key  поле сортировки API (receivedAt, trackNumber, …)
 * @param {string} title подпись столбца
 */
function sortableHeader(key, title) {
  return `<th scope="col" data-sort="${key}" aria-sort="none"><button class="sort-button" type="button">${title}</button></th>`;
}

/**
 * Окно подтверждения выдачи заказа (19-й день).
 *
 * Используется элемент <dialog>: браузер сам блокирует страницу под окном,
 * удерживает фокус внутри и закрывает окно клавишей Esc. Фокус при открытии
 * ставится на «Отмена» — безопасное действие (атрибут autofocus).
 */
function renderIssueDialog() {
  return `      <dialog class="modal" id="issue-dialog" aria-labelledby="issue-title" aria-describedby="issue-text">
        <div class="modal__tape" aria-hidden="true"></div>
        <form method="dialog">
          <div class="modal__body">
            <h2 class="modal__title" id="issue-title">Выдать заказ клиенту?</h2>
            <p class="modal__text" id="issue-text">Сверьте трек-номер и имя получателя. После выдачи
              заказ получит статус «Выдан», а ячейка освободится.</p>
            <div class="issue-card">
              <div class="issue-card__cell">
                <span class="issue-card__cell-label">ячейка</span>
                <span class="issue-card__cell-number" id="issue-cell">—</span>
              </div>
              <dl>
                <dt>Трек-номер</dt><dd class="track" id="issue-track">—</dd>
                <dt>Получатель</dt><dd id="issue-client">—</dd>
                <dt>Описание</dt><dd id="issue-description">—</dd>
              </dl>
            </div>
            <div class="alert alert--danger" id="issue-error" role="alert" hidden style="margin-top: 16px;">
              <span class="alert__icon" aria-hidden="true">✕</span>
              <div class="alert__body" id="issue-error-text"></div>
            </div>
          </div>
          <div class="modal__footer">
            <button class="btn btn--secondary btn--inline" type="submit" value="cancel" autofocus>Отмена</button>
            <button class="btn btn--accent btn--inline" type="button" id="issue-confirm">Выдать заказ</button>
          </div>
        </form>
      </dialog>`;
}

/**
 * Окно создания и изменения заказа (20-й день). Одна форма на оба действия:
 * при создании регистрируется ожидаемый заказ «В пути», при изменении
 * меняются трек-номер, получатель и описание.
 */
function renderOrderFormDialog() {
  return `      <dialog class="modal" id="order-dialog" aria-labelledby="order-dialog-title">
        <div class="modal__tape" aria-hidden="true"></div>
        <form class="form" id="order-form" novalidate>
          <div class="modal__body">
            <h2 class="modal__title" id="order-dialog-title">Ожидаемый заказ</h2>
            <p class="modal__text" id="order-dialog-text">Посылка ещё в пути: заказ получит статус «В пути»,
              ячейка будет назначена при приёмке.</p>
            <div class="form">
              <div class="field" data-field="trackNumber">
                <label class="field__label" for="order-track">Трек-номер <span class="field__required" aria-hidden="true">*</span></label>
                <input class="field__input" id="order-track" name="trackNumber" maxlength="40" autocomplete="off" placeholder="RA123456789BY" required>
                <span class="field__error" id="error-order-track"></span>
              </div>
              <div class="field" data-field="clientEmail">
                <label class="field__label" for="order-client">Получатель (адрес почты клиента) <span class="field__required" aria-hidden="true">*</span></label>
                <input class="field__input" id="order-client" name="clientEmail" type="email" maxlength="254"
                       autocomplete="off" list="order-clients" placeholder="ivanov@mail.ru" required>
                <datalist id="order-clients"></datalist>
                <span class="field__error" id="error-order-client"></span>
              </div>
              <div class="field" data-field="description">
                <label class="field__label" for="order-description">Описание посылки</label>
                <textarea class="field__textarea" id="order-description" name="description" maxlength="500"
                          placeholder="Например: книга, 0,5 кг"></textarea>
                <span class="field__error" id="error-order-description"></span>
              </div>
            </div>
          </div>
          <div class="modal__footer">
            <button class="btn btn--secondary btn--inline" type="button" id="order-cancel">Отмена</button>
            <button class="btn btn--inline" type="submit" id="order-submit">Сохранить</button>
          </div>
        </form>
      </dialog>`;
}

/**
 * Содержимое страницы заказов.
 * @param {{isAdmin?: boolean}} [options]
 * @returns {string}
 */
function renderOrdersContent({ isAdmin = false } = {}) {
  const title = isAdmin ? 'Все заказы' : 'Мои заказы';
  const subtitle = isAdmin
    ? 'Заказы всех клиентов пункта выдачи: поиск по трек-номеру, клиенту и описанию, '
      + 'фильтр по статусу и сортировка по любому столбцу.'
    : 'Ваши посылки в пункте выдачи. Когда заказ поступит, здесь появится номер ячейки, '
      + 'а статус обновится сам — перезагружать страницу не нужно.';

  const actions = isAdmin
    ? `<div class="page-header__actions">
          <button class="btn btn--secondary btn--inline" type="button" id="order-create">Ожидаемый заказ</button>
          <a class="btn btn--accent btn--inline" href="/receive">Принять посылку</a>
        </div>`
    : '';

  // Столбцы таблицы: у администратора дополнительно «Клиент» и «Действия»
  const headers = [
    sortableHeader('trackNumber', 'Трек-номер'),
    '<th scope="col">Описание</th>',
    isAdmin ? sortableHeader('client', 'Клиент') : '',
    sortableHeader('cell', 'Ячейка'),
    sortableHeader('status', 'Статус'),
    sortableHeader('receivedAt', 'Поступил'),
    sortableHeader('issuedAt', 'Выдан'),
    isAdmin ? '<th scope="col" class="table__actions">Действия</th>' : '',
  ].filter(Boolean).map((cell) => `              ${cell}`).join('\n');

  const columns = isAdmin ? 8 : 6;

  const sortOptions = [
    ['receivedAt:desc', 'Сначала новые'],
    ['receivedAt:asc', 'Сначала старые'],
    ['status:asc', 'По статусу'],
    ['cell:asc', 'По номеру ячейки'],
    ['trackNumber:asc', 'По трек-номеру'],
    ['issuedAt:desc', 'По дате выдачи'],
    ...(isAdmin ? [['client:asc', 'По клиенту']] : []),
  ].map(([value, label]) => `              <option value="${value}">${label}</option>`).join('\n');

  return `      <div class="page-header">
        <div class="page-header__text">
          <p class="eyebrow">${isAdmin ? 'Администратор · заказы' : 'Личный кабинет'}</p>
          <h1>${title}</h1>
          <p class="page-header__subtitle">${subtitle}</p>
        </div>
        ${actions}
      </div>

${isAdmin ? '' : `      <div class="pickup-banner" id="pickup-banner" hidden>
        <p class="pickup-banner__text"><strong id="pickup-title">Заказы ждут вас</strong><br>
          <span id="pickup-text">Назовите трек-номер администратору пункта выдачи.</span></p>
        <div class="pickup-banner__cells" id="pickup-cells" aria-label="Ячейки с вашими заказами"></div>
      </div>
`}
      <div class="toolbar" id="orders-toolbar">
        <div class="segmented" role="group" aria-label="Фильтр по статусу">
          <button class="segmented__item" type="button" data-status="all" aria-pressed="true">Все <span class="segmented__count" id="count-all">0</span></button>
          <button class="segmented__item" type="button" data-status="transit" aria-pressed="false">В пути <span class="segmented__count" id="count-transit">0</span></button>
          <button class="segmented__item" type="button" data-status="ready" aria-pressed="false">Готов к выдаче <span class="segmented__count" id="count-ready">0</span></button>
          <button class="segmented__item" type="button" data-status="issued" aria-pressed="false">Выдан <span class="segmented__count" id="count-issued">0</span></button>
        </div>

        <div class="field field__affix toolbar__search" data-field="search">
          <label class="visually-hidden" for="orders-search">Поиск заказов</label>
          ${SEARCH_ICON}
          <input class="field__input" id="orders-search" name="search" type="search" maxlength="100"
                 placeholder="${isAdmin ? 'Трек-номер, клиент или описание' : 'Трек-номер или описание'}" autocomplete="off">
        </div>

        <div class="field" data-field="sort">
          <label class="visually-hidden" for="orders-sort">Сортировка</label>
          <select class="field__select" id="orders-sort" name="sort">
${sortOptions}
          </select>
        </div>

        <span class="toolbar__spacer"></span>
        <span class="live" id="orders-live" aria-live="polite"><span class="live__dot" aria-hidden="true"></span><span id="orders-updated">Загрузка…</span></span>
      </div>

      <div class="table-wrap">
        <table class="table table--cards" id="orders-table" data-admin="${isAdmin}">
          <caption class="visually-hidden">${title}</caption>
          <thead>
            <tr>
${headers}
            </tr>
          </thead>
          <tbody id="orders-body">
            <tr><td colspan="${columns}" class="text-muted">Загрузка заказов…</td></tr>
          </tbody>
        </table>

        <div class="empty" id="orders-empty" hidden>
          <div class="empty__box" aria-hidden="true"></div>
          <p class="empty__title" id="orders-empty-title">Заказов пока нет</p>
          <p id="orders-empty-text">${isAdmin
    ? 'Примите первую посылку на странице «Приёмка товара».'
    : 'Когда пункт выдачи примет посылку на ваше имя, она появится здесь.'}</p>
        </div>
      </div>

      <p class="text-muted text-small" id="orders-summary" aria-live="polite"></p>
${isAdmin ? `${renderIssueDialog()}
${renderOrderFormDialog()}` : ''}`;
}

module.exports = { renderOrdersContent };

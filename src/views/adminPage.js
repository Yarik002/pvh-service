'use strict';

/**
 * Разметка страницы администратора.
 *
 * Данные загружаются сценарием (public/js/admin.js) через API:
 *   GET /api/admin/overview — сводка по состоянию пункта выдачи;
 *   GET /api/admin/users    — список пользователей;
 *   GET /api/cells          — справочник ячеек хранения.
 *
 * Разметка формируется на сервере, поэтому страница читается даже
 * при отключённых сценариях: на ней видны заголовки и разделы.
 */

/**
 * Содержимое страницы администратора.
 * @returns {string}
 */
function renderAdminContent() {
  return `      <div class="page-header">
        <h1>Администрирование</h1>
        <p class="page-header__subtitle">
          Сводка по состоянию пункта выдачи, учётные записи и справочник ячеек.
        </p>
      </div>

      <h2>Состояние пункта выдачи</h2>
      <div class="grid grid--4" id="overview-stats">
        <div class="stat">
          <div class="stat__value" id="stat-users">—</div>
          <div class="stat__label">пользователей</div>
        </div>
        <div class="stat">
          <div class="stat__value" id="stat-cells">—</div>
          <div class="stat__label">ячеек хранения</div>
        </div>
        <div class="stat">
          <div class="stat__value" id="stat-free">—</div>
          <div class="stat__label">свободно ячеек</div>
        </div>
        <div class="stat">
          <div class="stat__value" id="stat-orders">—</div>
          <div class="stat__label">заказов</div>
        </div>
      </div>

      <div class="grid grid--2" style="margin-top: var(--space-5);">
        <div class="card">
          <h3 class="card__title">Учётные записи</h3>
          <div id="users-summary" class="text-muted">
            <p>Загрузка сведений…</p>
          </div>
          <ul class="text-muted" style="margin: var(--space-3) 0 0; padding-left: 20px;">
            <li>всего: <strong id="users-total">—</strong></li>
            <li>подтверждено адресов: <strong id="users-confirmed">—</strong></li>
            <li>ожидают подтверждения: <strong id="users-unconfirmed">—</strong></li>
            <li>администраторов: <strong id="users-admins">—</strong></li>
            <li>клиентов: <strong id="users-clients">—</strong></li>
          </ul>
        </div>

        <div class="card">
          <h3 class="card__title">Заказы по статусам</h3>
          <ul class="text-muted" style="margin: 0; padding-left: 20px;">
            <li>в пути: <strong id="orders-transit">—</strong></li>
            <li>готовы к выдаче: <strong id="orders-ready">—</strong></li>
            <li>выдано: <strong id="orders-issued">—</strong></li>
            <li>активных сессий: <strong id="sessions-active">—</strong></li>
          </ul>
        </div>
      </div>

      <h2 style="margin-top: var(--space-6);">Пользователи системы</h2>
      <div class="table-wrap">
        <table class="table" id="users-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Имя</th>
              <th>Адрес электронной почты</th>
              <th>Роль</th>
              <th>Адрес подтверждён</th>
            </tr>
          </thead>
          <tbody>
            <tr><td colspan="5" class="text-muted">Загрузка сведений…</td></tr>
          </tbody>
        </table>
      </div>

      <h2 style="margin-top: var(--space-6);">Ячейки хранения</h2>
      <p class="text-muted" id="cells-summary">Загрузка сведений…</p>
      <div class="table-wrap">
        <table class="table" id="cells-table">
          <thead>
            <tr>
              <th>Номер ячейки</th>
              <th>Состояние</th>
            </tr>
          </thead>
          <tbody>
            <tr><td colspan="2" class="text-muted">Загрузка сведений…</td></tr>
          </tbody>
        </table>
      </div>`;
}

module.exports = { renderAdminContent };

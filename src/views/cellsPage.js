'use strict';

/**
 * Разметка страницы «Ячейки хранения».
 *
 * Данные загружаются сценарием public/js/cells.js через API:
 *   GET /api/cells        — все ячейки со сводкой;
 *   GET /api/cells/free   — только свободные ячейки.
 *
 * Разметка формируется на сервере, поэтому заголовки и разделы видны
 * даже при отключённых сценариях. Администратор дополнительно видит
 * трек-номера заказов в занятых ячейках.
 */

/**
 * Содержимое страницы ячеек.
 * @param {{isAdmin?: boolean}} [options]
 * @returns {string}
 */
function renderCellsContent({ isAdmin = false } = {}) {
  const adminHint = isAdmin
    ? `<p class="text-muted">В занятых ячейках показан трек-номер заказа.
          Нажмите на ячейку, чтобы увидеть сведения о заказе и получателе.</p>`
    : `<p class="text-muted">Ячейки показаны без сведений о заказах:
          данные других клиентов не раскрываются.</p>`;

  return `      <div class="page-header">
        <h1>Ячейки хранения</h1>
        <p class="page-header__subtitle">
          Актуальное состояние ячеек на складе пункта выдачи.
        </p>
      </div>

      <div class="grid grid--4" id="cells-stats">
        <div class="stat"><div class="stat__value" id="cells-total">—</div><div class="stat__label">всего ячеек</div></div>
        <div class="stat"><div class="stat__value" id="cells-free">—</div><div class="stat__label">свободно</div></div>
        <div class="stat"><div class="stat__value" id="cells-busy">—</div><div class="stat__label">занято</div></div>
        <div class="stat"><div class="stat__value" id="cells-occupancy">—</div><div class="stat__label">заполненность</div></div>
      </div>

      <div class="row cells-toolbar" role="group" aria-label="Фильтр ячеек">
        <button class="btn btn--sm btn--inline" type="button" data-cells-filter="all" aria-pressed="true">Все</button>
        <button class="btn btn--secondary btn--sm btn--inline" type="button" data-cells-filter="free" aria-pressed="false">Свободные</button>
        <button class="btn btn--secondary btn--sm btn--inline" type="button" data-cells-filter="busy" aria-pressed="false">Занятые</button>
        <button class="btn btn--secondary btn--sm btn--inline" type="button" id="cells-refresh">Обновить</button>
      </div>

      ${adminHint}
      <p class="text-muted" id="cells-updated" aria-live="polite">Загрузка сведений…</p>

      <ul class="cell-grid" id="cells-grid" aria-label="Ячейки хранения">
        <li class="text-muted">Загрузка сведений…</li>
      </ul>

      <div class="card" id="cell-details" hidden>
        <h3 class="card__title" id="cell-details-title">Ячейка</h3>
        <div id="cell-details-body"></div>
      </div>`;
}

module.exports = { renderCellsContent };

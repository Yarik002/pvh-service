'use strict';

/**
 * Разметка страницы «Приёмка товара» (15-й день практики).
 *
 * Страница доступна только администратору. Сценарий public/js/receive.js
 * загружает список клиентов и свободных ячеек, показывает, какая ячейка
 * будет назначена, и отправляет форму запросом POST /api/orders.
 *
 * Поля формы названы так же, как поля запроса API (trackNumber, clientEmail,
 * description, cellMode, cellId), поэтому ошибки, которые вернул сервер,
 * выводятся у нужных полей без дополнительных преобразований.
 */

const { renderField } = require('./authPages');

/**
 * Содержимое страницы приёмки.
 * @returns {string}
 */
function renderReceiveContent() {
  return `      <div class="page-header">
        <h1>Приёмка товара</h1>
        <p class="page-header__subtitle">
          Оформление поступившей посылки: заказ сохраняется, ячейка хранения
          назначается автоматически или вручную, клиент получает письмо.
        </p>
      </div>

      <div class="grid grid--2 receive-layout">
        <div class="card">
          <h2 class="card__title">Новая посылка</h2>

          <form class="form" id="receive-form" novalidate>
${renderField({
    name: 'trackNumber',
    label: 'Трек-номер',
    placeholder: 'RA123456789BY',
    required: true,
    autofocus: true,
    autocomplete: 'off',
    hint: 'Латинские буквы, цифры и дефис, от 6 до 40 символов.',
    maxlength: 40,
  })}
${renderField({
    name: 'clientEmail',
    label: 'Получатель (адрес электронной почты клиента)',
    type: 'email',
    placeholder: 'ivanov@mail.ru',
    required: true,
    autocomplete: 'off',
    hint: 'Начните вводить имя или адрес — появится список клиентов.',
    maxlength: 254,
  })}
            <datalist id="clients-list"></datalist>

            <div class="field" data-field="description">
              <label class="field__label" for="field-description">Описание посылки</label>
              <textarea class="field__textarea" id="field-description" name="description"
                        maxlength="500" placeholder="Например: книга, 0,5 кг"></textarea>
              <span class="field__error" id="error-field-description"></span>
              <span class="field__hint" id="description-counter">0 из 500 символов</span>
            </div>

            <fieldset class="field receive-mode" data-field="cellMode">
              <legend class="field__label">Ячейка хранения</legend>
              <label class="checkbox">
                <input type="radio" name="cellMode" value="auto" checked>
                <span>Автоматически — первая свободная</span>
              </label>
              <label class="checkbox">
                <input type="radio" name="cellMode" value="manual">
                <span>Выбрать вручную</span>
              </label>
            </fieldset>

            <div class="field" data-field="cellId" id="manual-cell" hidden>
              <label class="field__label" for="field-cellId">Свободная ячейка</label>
              <select class="field__select" id="field-cellId" name="cellId">
                <option value="">Загрузка списка…</option>
              </select>
              <span class="field__error" id="error-field-cellId"></span>
            </div>

            <p class="receive-preview" id="cell-preview" aria-live="polite">
              Определяется ячейка…
            </p>

            <button class="btn btn--block" type="submit" id="receive-submit">
              Принять посылку
            </button>
          </form>
        </div>

        <div>
          <div class="card receive-result" id="receive-result" hidden>
            <h2 class="card__title">Посылка принята</h2>
            <p>Положите посылку в ячейку:</p>
            <p class="receive-result__cell" id="result-cell">—</p>
            <p id="result-text"></p>
            <p class="text-muted" id="result-mail"></p>
            <button class="btn btn--secondary btn--inline" type="button" id="receive-next">
              Принять следующую посылку
            </button>
          </div>

          <div class="card">
            <h2 class="card__title">Склад</h2>
            <p class="text-muted" id="receive-stock">Загрузка сведений…</p>
            <h3>Принято за сеанс</h3>
            <ul class="receive-history" id="receive-history">
              <li class="text-muted">Пока ничего не принято.</li>
            </ul>
          </div>
        </div>
      </div>`;
}

module.exports = { renderReceiveContent };

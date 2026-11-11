'use strict';

/**
 * Разметка страницы «Профиль» (20-й день практики).
 *
 * Разделы страницы:
 *   • сведения об учётной записи и изменение имени (PATCH /api/auth/me);
 *   • смена пароля (POST /api/password/change, 4-й день);
 *   • удаление учётной записи с подтверждением паролем (DELETE /api/auth/me).
 *
 * Сценарий страницы — public/js/profile.js.
 */

const { escapeHtml } = require('./layout');
const { renderField } = require('./authPages');

/**
 * @param {{user: {name: string, email: string, role: string, isConfirmed?: boolean}}} options
 * @returns {string}
 */
function renderProfileContent({ user }) {
  const isAdmin = user.role === 'admin';
  const initial = String(user.name || user.email || '?').trim().charAt(0).toUpperCase();

  return `      <div class="page-header">
        <div class="page-header__text">
          <p class="eyebrow">Учётная запись</p>
          <h1>Профиль</h1>
          <p class="page-header__subtitle">Имя, пароль и удаление учётной записи.</p>
        </div>
      </div>

      <div class="grid grid--2" style="align-items: start;">
        <div class="stack">
          <section class="card">
            <div class="profile-head">
              <span class="profile-head__avatar" aria-hidden="true" id="profile-avatar">${escapeHtml(initial)}</span>
              <div>
                <h2 id="profile-name">${escapeHtml(user.name)}</h2>
                <span class="text-muted">${escapeHtml(user.email)}</span>
              </div>
            </div>
            <dl class="kv" style="margin-top: 20px;">
              <dt>Роль</dt>
              <dd><span class="badge ${isAdmin ? 'badge--info' : 'badge--muted'}">${isAdmin ? 'администратор' : 'клиент'}</span></dd>
              <dt>Адрес почты</dt>
              <dd>${user.isConfirmed === false ? 'не подтверждён' : 'подтверждён'}</dd>
              <dt>Заказы</dt>
              <dd><a href="/orders">${isAdmin ? 'все заказы пункта выдачи' : 'мои заказы'}</a></dd>
            </dl>
          </section>

          <section class="card">
            <h2 class="card__title">Имя</h2>
            <form class="form" id="profile-form" novalidate>
${renderField({
    name: 'name',
    label: 'Имя и фамилия',
    required: true,
    autocomplete: 'name',
    minlength: 2,
    maxlength: 100,
  }).replace('<input ', `<input value="${escapeHtml(user.name)}" `)}
              <button class="btn btn--inline" type="submit" id="profile-submit">Сохранить имя</button>
            </form>
          </section>
        </div>

        <div class="stack">
          <section class="card">
            <h2 class="card__title">Смена пароля</h2>
            <p class="card__subtitle">После смены пароля остальные сеансы входа завершатся.</p>
            <form class="form" id="password-form" novalidate>
${renderField({
    name: 'currentPassword',
    label: 'Текущий пароль',
    type: 'password',
    required: true,
    autocomplete: 'current-password',
    togglePassword: true,
    maxlength: 128,
  })}
${renderField({
    name: 'newPassword',
    label: 'Новый пароль',
    type: 'password',
    required: true,
    hint: 'Не менее 8 символов, обязательно буква и цифра.',
    autocomplete: 'new-password',
    togglePassword: true,
    maxlength: 128,
  })}
${renderField({
    name: 'newPasswordConfirm',
    label: 'Повторите новый пароль',
    type: 'password',
    required: true,
    autocomplete: 'new-password',
    togglePassword: true,
    maxlength: 128,
  })}
              <button class="btn btn--inline" type="submit" id="password-submit">Сменить пароль</button>
            </form>
          </section>

          <section class="card danger-zone">
            <h2 class="card__title">Удаление учётной записи</h2>
            <p class="text-muted">Учётная запись и история заказов будут удалены без возможности
              восстановления. Пока в ячейках лежат ваши заказы, удалить запись нельзя.</p>
            <form class="form" id="delete-form" novalidate>
${renderField({
    name: 'deletePassword',
    label: 'Пароль для подтверждения',
    type: 'password',
    required: true,
    autocomplete: 'current-password',
    togglePassword: true,
    maxlength: 128,
  })}
              <button class="btn btn--danger btn--inline" type="submit" id="delete-submit">Удалить учётную запись</button>
            </form>
          </section>
        </div>
      </div>`;
}

module.exports = { renderProfileContent };

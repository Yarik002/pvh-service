'use strict';

/**
 * Разметка страниц, связанных с учётной записью:
 * регистрация, вход, подтверждение адреса, страница «не найдено».
 *
 * Разметка вынесена в отдельный модуль, чтобы общий шаблон
 * (src/views/layout.js) отвечал только за шапку, подвал и каркас документа.
 */

const { escapeHtml } = require('./layout');

/**
 * Поле ввода формы.
 *
 * @param {{
 *   name: string, label: string, type?: string, placeholder?: string,
 *   required?: boolean, hint?: string, autocomplete?: string,
 *   togglePassword?: boolean, autofocus?: boolean, minlength?: number,
 *   maxlength?: number
 * }} options
 * @returns {string}
 */
function renderField(options) {
  const {
    name,
    label,
    type = 'text',
    placeholder = '',
    required = false,
    hint = '',
    autocomplete = '',
    togglePassword = false,
    autofocus = false,
    minlength,
    maxlength,
  } = options;

  const inputId = `field-${name}`;
  const attributes = [
    `class="field__input"`,
    `id="${inputId}"`,
    `name="${escapeHtml(name)}"`,
    `type="${escapeHtml(type)}"`,
  ];

  if (placeholder) attributes.push(`placeholder="${escapeHtml(placeholder)}"`);
  if (autocomplete) attributes.push(`autocomplete="${escapeHtml(autocomplete)}"`);
  if (required) attributes.push('required');
  if (autofocus) attributes.push('autofocus');
  if (minlength !== undefined) attributes.push(`minlength="${minlength}"`);
  if (maxlength !== undefined) attributes.push(`maxlength="${maxlength}"`);

  const input = `<input ${attributes.join(' ')}>`;

  const withToggle = togglePassword
    ? `            <div class="field__password">
              ${input}
              <button class="field__password-toggle" type="button"
                      data-password-toggle="${inputId}" aria-label="Показать пароль">Показать</button>
            </div>`
    : `            ${input}`;

  return `          <div class="field" data-field="${escapeHtml(name)}">
            <label class="field__label" for="${inputId}">
              ${escapeHtml(label)}${required ? ' <span class="field__required" aria-hidden="true">*</span>' : ''}
            </label>
${withToggle}
            <span class="field__error" id="error-${inputId}"></span>
            ${hint ? `<span class="field__hint">${escapeHtml(hint)}</span>` : ''}
          </div>`;
}

/**
 * Содержимое страницы регистрации.
 * @returns {string}
 */
function renderRegisterContent() {
  return `      <div class="card card--narrow">
        <h1 class="card__title">Регистрация</h1>
        <p class="card__subtitle">
          Создайте учётную запись, чтобы отслеживать свои посылки.
        </p>

        <form class="form" id="register-form" novalidate>
${renderField({
    name: 'name',
    label: 'Имя и фамилия',
    placeholder: 'Иванов Иван',
    required: true,
    hint: 'От 2 до 100 символов.',
    autocomplete: 'name',
    autofocus: true,
    minlength: 2,
    maxlength: 100,
  })}
${renderField({
    name: 'email',
    label: 'Адрес электронной почты',
    type: 'email',
    placeholder: 'ivanov@mail.ru',
    required: true,
    hint: 'На этот адрес придёт письмо со ссылкой для подтверждения.',
    autocomplete: 'email',
    maxlength: 254,
  })}
${renderField({
    name: 'password',
    label: 'Пароль',
    type: 'password',
    required: true,
    hint: 'Не менее 8 символов, обязательно буква и цифра.',
    autocomplete: 'new-password',
    togglePassword: true,
    minlength: 8,
    maxlength: 128,
  })}

          <div class="strength" id="password-strength" hidden>
            <div class="strength__track">
              <div class="strength__bar" id="strength-bar"></div>
            </div>
            <span class="strength__label" id="strength-label"></span>
          </div>

${renderField({
    name: 'passwordConfirm',
    label: 'Подтверждение пароля',
    type: 'password',
    required: true,
    autocomplete: 'new-password',
    togglePassword: true,
    minlength: 8,
    maxlength: 128,
  })}

          <div class="field" data-field="agree">
            <label class="checkbox">
              <input type="checkbox" name="agree" id="field-agree">
              <span>Согласен с правилами обработки персональных данных</span>
            </label>
            <span class="field__error" id="error-field-agree"></span>
          </div>

          <button class="btn btn--block" type="submit" id="register-submit">
            Зарегистрироваться
          </button>
        </form>

        <div class="card__footer">
          Уже есть учётная запись? <a href="/login">Войдите</a>.
        </div>
      </div>`;
}

/**
 * Содержимое страницы входа.
 * @param {{next?: string}} [options] адрес возврата после входа
 * @returns {string}
 */
function renderLoginContent({ next = '/' } = {}) {
  return `      <div class="card card--narrow">
        <h1 class="card__title">Вход в систему</h1>
        <p class="card__subtitle">
          Введите адрес электронной почты и пароль, указанные при регистрации.
        </p>

        <form class="form" id="login-form" novalidate>
          <input type="hidden" name="next" value="${escapeHtml(next)}">

${renderField({
    name: 'email',
    label: 'Адрес электронной почты',
    type: 'email',
    placeholder: 'ivanov@mail.ru',
    required: true,
    autocomplete: 'email',
    autofocus: true,
    maxlength: 254,
  })}
${renderField({
    name: 'password',
    label: 'Пароль',
    type: 'password',
    required: true,
    autocomplete: 'current-password',
    togglePassword: true,
    maxlength: 128,
  })}

          <button class="btn btn--block" type="submit" id="login-submit">
            Войти
          </button>
        </form>

        <div class="card__footer">
          Нет учётной записи? <a href="/register">Зарегистрируйтесь</a>.<br>
          Забыли пароль? Обратитесь к администратору пункта выдачи.
        </div>
      </div>`;
}

/**
 * Содержимое страницы результата подтверждения адреса электронной почты.
 *
 * @param {{status: string, email: string}} options
 * @returns {string}
 */
function renderConfirmContent({ status, email }) {
  const emailLine = email
    ? `<p>Адрес электронной почты: <strong>${escapeHtml(email)}</strong></p>`
    : '';

  const variants = {
    success: {
      type: 'success',
      icon: '✓',
      title: 'Адрес электронной почты подтверждён',
      text: 'Учётная запись активирована. Теперь вы можете войти в систему '
        + 'и отслеживать свои заказы.',
      action: '<a class="btn btn--inline" href="/login">Перейти ко входу</a>',
      resend: false,
    },
    expired: {
      type: 'warning',
      icon: '!',
      title: 'Срок действия ссылки истёк',
      text: 'Ссылка подтверждения действительна ограниченное время. '
        + 'Запросите новое письмо и перейдите по ссылке из него.',
      action: '<a class="btn btn--secondary btn--inline" href="/login">Перейти ко входу</a>',
      resend: true,
    },
    invalid: {
      type: 'danger',
      icon: '✕',
      title: 'Ссылка недействительна',
      text: 'Ссылка подтверждения не найдена: возможно, адрес уже подтверждён '
        + 'или ссылка была использована ранее.',
      action: '<a class="btn btn--secondary btn--inline" href="/login">Перейти ко входу</a>',
      resend: true,
    },
    tooManyAttempts: {
      type: 'danger',
      icon: '✕',
      title: 'Превышено число попыток',
      text: 'Слишком много неудачных попыток подтверждения. '
        + 'Запросите новое письмо и перейдите по ссылке из него.',
      action: '<a class="btn btn--secondary btn--inline" href="/login">Перейти ко входу</a>',
      resend: true,
    },
  };

  const variant = variants[status] || {
    type: 'info',
    icon: 'i',
    title: 'Подтверждение адреса',
    text: 'Сведения о результате подтверждения отсутствуют. '
      + 'Войдите в систему: если адрес подтверждён, вход будет выполнен.',
    action: '<a class="btn btn--secondary btn--inline" href="/login">Перейти ко входу</a>',
    resend: true,
  };

  // Если подтвердить адрес не удалось, пользователю предлагается
  // запросить новое письмо, не возвращаясь на страницу входа
  const resendForm = variant.resend
    ? `
        <h2>Запросить новое письмо</h2>
        <p class="text-muted">
          Укажите адрес электронной почты, использованный при регистрации.
        </p>
        <form class="form" id="resend-form" novalidate>
          <div class="field" data-field="email">
            <label class="field__label" for="field-resend-email">
              Адрес электронной почты <span class="field__required" aria-hidden="true">*</span>
            </label>
            <input class="field__input" id="field-resend-email" name="email" type="email"
                   placeholder="ivanov@mail.ru" autocomplete="email" required
                   value="${escapeHtml(email)}">
            <span class="field__error" id="error-field-resend-email"></span>
          </div>
          <button class="btn btn--secondary" type="submit">Отправить письмо повторно</button>
        </form>`
    : '';

  return `      <div class="card card--narrow">
        <h1 class="card__title">Подтверждение адреса</h1>

        <div class="alert alert--${variant.type}" role="${variant.type === 'danger' ? 'alert' : 'status'}">
          <span class="alert__icon" aria-hidden="true">${variant.icon}</span>
          <div class="alert__body">
            <strong class="alert__title">${escapeHtml(variant.title)}</strong>
            ${escapeHtml(variant.text)}
          </div>
        </div>

        ${emailLine}

        <p>${variant.action}</p>
${resendForm}
      </div>`;
}

/**
 * Содержимое страницы «не найдено».
 * @param {{path: string}} options
 * @returns {string}
 */
function renderNotFoundContent({ path }) {
  return `      <div class="card card--narrow">
        <h1 class="card__title">Страница не найдена</h1>
        <div class="alert alert--warning" role="alert">
          <span class="alert__icon" aria-hidden="true">!</span>
          <div class="alert__body">
            Страница <span class="text-mono">${escapeHtml(path)}</span> не существует
            или была перемещена.
          </div>
        </div>
        <p>Проверьте адрес либо вернитесь на главную страницу.</p>
        <p>
          <a class="btn btn--inline" href="/">На главную</a>
          <a class="btn btn--secondary btn--inline" href="/login">Войти</a>
        </p>
      </div>`;
}

module.exports = {
  renderField,
  renderRegisterContent,
  renderLoginContent,
  renderConfirmContent,
  renderNotFoundContent,
};

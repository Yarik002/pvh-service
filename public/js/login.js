'use strict';

/**
 * Страница входа: проверка полей и отправка данных на сервер.
 *
 * Порядок работы:
 *   1) значения проверяются в браузере (модуль form.js);
 *   2) данные отправляются запросом POST /api/auth/login;
 *   3) при успехе пользователь направляется на страницу, с которой его
 *      перенаправили на вход (параметр next), либо на главную;
 *   4) отдельно обрабатывается случай неподтверждённого адреса электронной
 *      почты: пользователю предлагается запросить новое письмо.
 */

document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  var form = document.getElementById('login-form');
  if (!form) return;

  var submitButton = document.getElementById('login-submit');

  if (window.PVH_FORM) window.PVH_FORM.watchFields(form);

  /**
   * Показывает предложение подтвердить адрес электронной почты.
   * @param {HTMLInputElement} emailInput
   */
  function offerResendConfirmation(emailInput) {
    var alerts = document.getElementById('alerts');
    if (!alerts) return;

    var container = document.createElement('div');
    container.className = 'alert alert--warning';
    container.setAttribute('role', 'alert');

    var icon = document.createElement('span');
    icon.className = 'alert__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '!';

    var body = document.createElement('div');
    body.className = 'alert__body';

    var title = document.createElement('strong');
    title.className = 'alert__title';
    title.textContent = 'Адрес электронной почты не подтверждён';

    var text = document.createElement('p');
    text.style.margin = '4px 0 8px';
    text.textContent = 'Проверьте почту и перейдите по ссылке из письма. '
      + 'Если письмо не пришло, запросите новое.';

    var button = document.createElement('button');
    button.className = 'btn btn--secondary btn--sm btn--inline';
    button.type = 'button';
    button.textContent = 'Отправить письмо повторно';

    button.addEventListener('click', function () {
      button.disabled = true;
      button.textContent = 'Отправка…';

      window.PVH_API.resendConfirmation({ email: emailInput.value.trim() })
        .then(function (data) {
          button.textContent = 'Письмо отправлено';
          if (data && data.message) window.PVH.showAlert('success', data.message, 'Готово');
        })
        .catch(function (error) {
          button.disabled = false;
          button.textContent = 'Отправить письмо повторно';
          window.PVH_FORM.reportError(error);
        });
    });

    body.appendChild(title);
    body.appendChild(text);
    body.appendChild(button);
    container.appendChild(icon);
    container.appendChild(body);
    alerts.appendChild(container);
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (window.PVH) window.PVH.clearAlerts();

    var checked = window.PVH_FORM.validateForm(form);
    if (!checked.valid) {
      window.PVH.showAlert('danger', 'Проверьте правильность заполнения полей формы.',
        'Форма заполнена не полностью');
      return;
    }

    var payload = {
      email: checked.values.email,
      password: checked.values.password,
    };

    window.PVH_FORM.setBusy(submitButton, true, 'Проверка…');

    window.PVH_API.login(payload)
      .then(function (data) {
        window.PVH_FORM.setBusy(submitButton, false);

        var target = checked.values.next || '/';
        var name = data.user && data.user.name ? data.user.name : '';

        window.PVH.setPendingAlert('success',
          (name ? name + ', вы вошли в систему.' : 'Вы вошли в систему.'),
          'Вход выполнен');

        window.location.href = target;
      })
      .catch(function (error) {
        window.PVH_FORM.setBusy(submitButton, false);

        var parsed = window.PVH_API.parseError(error);

        // Адрес электронной почты не подтверждён: предлагаем запросить письмо
        if (parsed.code === 'EMAIL_NOT_CONFIRMED') {
          window.PVH.clearAlerts();
          window.PVH.showAlert('warning', parsed.message, 'Требуется подтверждение адреса');
          offerResendConfirmation(form.querySelector('[name="email"]'));
          return;
        }

        // При неверных учётных данных ошибка выводится под полями формы,
        // а не только общим сообщением
        if (parsed.code === 'INVALID_CREDENTIALS') {
          window.PVH_FORM.setFieldError('password', 'Проверьте адрес электронной почты и пароль');
        }

        window.PVH_FORM.reportError(error);
      });
  });
});

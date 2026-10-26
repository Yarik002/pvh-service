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
   * Показывает одно уведомление с предложением подтвердить адрес
   * электронной почты и кнопкой повторной отправки письма.
   *
   * Уведомление одно: при нажатии кнопки оно не добавляет новые сообщения,
   * а меняет собственный текст. Иначе при нескольких попытках экран
   * заполняется одинаковыми предупреждениями.
   *
   * @param {HTMLInputElement} emailInput поле с адресом электронной почты
   * @param {string} [message] текст сообщения от сервера
   */
  function offerResendConfirmation(emailInput, message) {
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
    text.textContent = message
      || 'Проверьте почту и перейдите по ссылке из письма. '
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
          var mail = (data && data.confirmationEmail) || {};

          if (mail.sent) {
            container.className = 'alert alert--success';
            icon.textContent = '✓';
            title.textContent = 'Письмо отправлено';
            text.textContent = 'Проверьте почту и перейдите по ссылке '
              + 'из письма, чтобы подтвердить адрес.';
            button.remove();
            return;
          }

          // Отправка не настроена либо не удалась: сообщаем об этом прямо,
          // иначе пользователь будет ждать письмо, которого нет
          title.textContent = 'Не удалось отправить письмо';
          text.textContent = mail.logged
            ? 'Отправка писем не настроена. Ссылка для подтверждения '
              + 'выведена в журнал сервера.'
            : 'Причина: ' + (mail.error || 'неизвестная ошибка')
              + '. Попробуйте ещё раз позже.';
          button.disabled = false;
          button.textContent = 'Попробовать снова';
        })
        .catch(function (error) {
          var parsed = window.PVH_API.parseError(error);

          title.textContent = 'Не удалось отправить письмо';
          text.textContent = 'Причина: ' + parsed.message;
          button.disabled = false;
          button.textContent = 'Попробовать снова';
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

        // Адрес электронной почты не подтверждён: показываем одно
        // уведомление с кнопкой повторной отправки письма
        if (parsed.code === 'EMAIL_NOT_CONFIRMED') {
          window.PVH.clearAlerts();
          offerResendConfirmation(form.querySelector('[name="email"]'), parsed.message);
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

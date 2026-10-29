'use strict';

/**
 * Страница регистрации: проверка полей и отправка данных на сервер.
 *
 * Порядок работы:
 *   1) значения проверяются в браузере (модуль form.js) — пользователь
 *      видит ошибку сразу, не дожидаясь ответа сервера;
 *   2) данные отправляются запросом POST /api/auth/register;
 *   3) при успехе показывается сообщение о необходимости подтвердить
 *      адрес электронной почты, затем выполняется переход на страницу входа;
 *   4) при ошибке сообщение сервера выводится рядом с соответствующим полем.
 */

document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  var form = document.getElementById('register-form');
  if (!form) return;

  var submitButton = document.getElementById('register-submit');
  var strengthBlock = document.getElementById('password-strength');
  var strengthBar = document.getElementById('strength-bar');
  var strengthLabel = document.getElementById('strength-label');

  if (window.PVH_FORM) window.PVH_FORM.watchFields(form);

  // --- Индикатор надёжности пароля -----------------------------------------

  var strengthTimer = null;

  /**
   * Показывает оценку надёжности пароля.
   *
   * @param {object|null} data ответ сервера вида
   *   { success: true, strength: { score, level, label } } либо null,
   *   если поле пароля пустое
   */
  function showStrength(data) {
    if (!strengthBlock || !strengthBar || !strengthLabel) return;

    // Оценка лежит в поле strength ответа сервера
    var result = data && data.strength;
    strengthBlock.hidden = !result;
    if (!result) return;

    var levels = {
      veryWeak: { color: 'var(--color-danger)', text: 'очень низкая' },
      weak: { color: 'var(--color-danger)', text: 'низкая' },
      medium: { color: 'var(--color-warning)', text: 'средняя' },
      strong: { color: 'var(--color-success)', text: 'высокая' },
      veryStrong: { color: 'var(--color-success)', text: 'очень высокая' },
    };

    var level = levels[result.level] || levels.weak;
    strengthBar.style.width = Math.max(4, result.score) + '%';
    strengthBar.style.background = level.color;
    strengthLabel.textContent = 'Надёжность пароля: ' + level.text
      + ' (' + result.score + ' из 100)';
  }

  var passwordInput = form.querySelector('[name="password"]');
  if (passwordInput) {
    passwordInput.addEventListener('input', function () {
      // Запрос отправляется с небольшой задержкой, чтобы не обращаться
      // к серверу на каждое нажатие клавиши
      if (strengthTimer) window.clearTimeout(strengthTimer);

      strengthTimer = window.setTimeout(function () {
        var values = window.PVH_FORM.collectValues(form);
        if (!values.password) {
          showStrength(null);
          return;
        }

        window.PVH_API.checkPasswordStrength(values.password, {
          name: values.name,
          email: values.email,
        })
          .then(showStrength)
          .catch(function () {
            // Оценка надёжности — вспомогательная функция: при сбое
            // отправки формы она не должна мешать регистрации
            showStrength(null);
          });
      }, 350);
    });
  }

  // --- Отправка формы -------------------------------------------------------

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (window.PVH) window.PVH.clearAlerts();

    // Проверка в браузере
    var checked = window.PVH_FORM.validateForm(form);
    if (!checked.valid) {
      window.PVH.showAlert('danger', 'Проверьте правильность заполнения полей формы.',
        'Форма заполнена не полностью');
      return;
    }

    var payload = {
      name: checked.values.name,
      email: checked.values.email,
      password: checked.values.password,
      passwordConfirm: checked.values.passwordConfirm,
    };

    window.PVH_FORM.setBusy(submitButton, true, 'Отправка…');

    window.PVH_API.register(payload)
      .then(function (data) {
        window.PVH_FORM.setBusy(submitButton, false);

        var mail = data.confirmationEmail || {};

        // Различаются три случая: письмо доставлено почтовому серверу,
        // отправка не настроена (режим log) и отправка не удалась.
        // Во втором случае ссылку следует взять из журнала сервера,
        // поэтому нельзя писать «письмо отправлено»: пользователь
        // станет ждать письмо, которого не будет.
        var message;
        var alertType;

        if (mail.sent) {
          alertType = 'success';

          // Если письмо осталось в локальном веб-ящике, сообщаем,
          // что искать его в обычной почте бесполезно
          message = mail.mailboxUrl
            ? 'Учётная запись создана. Письмо со ссылкой для подтверждения '
              + 'находится в локальном почтовом ящике. Откроется после входа: '
              + mail.mailboxUrl
            : 'Учётная запись создана. На адрес ' + payload.email
              + ' отправлено письмо со ссылкой для подтверждения.';
        } else if (mail.logged) {
          alertType = 'warning';
          message = 'Учётная запись создана, но отправка писем не настроена. '
            + 'Ссылка для подтверждения выведена в журнал сервера — '
            + 'её можно взять оттуда.';
        } else {
          alertType = 'warning';
          message = 'Учётная запись создана, но письмо отправить не удалось'
            + (mail.error ? ': ' + mail.error : '')
            + '. Запросите письмо повторно на странице входа.';
        }

        // Адрес локального ящика запоминается: страница входа покажет
        // на него кнопку, чтобы не искать письмо в обычной почте
        if (mail.mailboxUrl) {
          try {
            window.sessionStorage.setItem('pvh.mailboxUrl', mail.mailboxUrl);
          } catch (error) {
            // Хранилище может быть недоступно — тогда ссылка не покажется
          }
        }

        // Сообщение сохраняется и показывается уже на странице входа:
        // так пользователь видит его после перехода
        window.PVH.setPendingAlert(alertType, message, 'Регистрация завершена');
        window.location.href = '/login';
      })
      .catch(function (error) {
        window.PVH_FORM.setBusy(submitButton, false);
        window.PVH_FORM.reportError(error);
      });
  });
});

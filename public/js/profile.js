'use strict';

/**
 * Страница «Профиль» (20-й день практики): изменение имени, смена пароля
 * и удаление учётной записи.
 */

document.addEventListener('DOMContentLoaded', function () {
  var API = window.PVH_API;
  var FORM = window.PVH_FORM;
  if (!API || !FORM) return;

  /** Сообщение о результате: всплывающее (22-й день) или уведомление на странице. */
  function notify(type, message, title) {
    if (!window.PVH) return;
    if (window.PVH.toast) {
      window.PVH.toast(type, message, title);
    } else {
      window.PVH.clearAlerts();
      window.PVH.showAlert(type, message, title);
    }
  }

  /** Ошибка запроса: у полей формы и общим сообщением. */
  function fail(error, title) {
    var parsed = API.parseError(error);
    if (parsed.fields) FORM.showServerErrors(parsed.fields);
    notify('danger', parsed.message, title);
    return parsed;
  }

  // --- Имя --------------------------------------------------------------------------
  var profileForm = document.getElementById('profile-form');
  var profileSubmit = document.getElementById('profile-submit');

  profileForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var checked = FORM.validateForm(profileForm);
    if (!checked.valid) return;

    FORM.setBusy(profileSubmit, true, 'Сохранение…');
    API.updateProfile({ name: checked.values.name.trim() })
      .then(function (data) {
        FORM.setBusy(profileSubmit, false);
        // Новое имя сразу видно в карточке профиля и в шапке
        document.getElementById('profile-name').textContent = data.user.name;
        document.getElementById('profile-avatar').textContent = data.user.name.charAt(0).toUpperCase();
        var headerName = document.querySelector('.header__user-name');
        if (headerName) headerName.textContent = data.user.name;
        var headerAvatar = document.querySelector('.header__avatar');
        if (headerAvatar) headerAvatar.textContent = data.user.name.charAt(0).toUpperCase();
        notify('success', data.message, 'Имя изменено');
      })
      .catch(function (error) {
        FORM.setBusy(profileSubmit, false);
        fail(error, 'Имя не сохранено');
      });
  });

  // --- Пароль -------------------------------------------------------------------------
  var passwordForm = document.getElementById('password-form');
  var passwordSubmit = document.getElementById('password-submit');

  passwordForm.addEventListener('submit', function (event) {
    event.preventDefault();
    FORM.clearErrors(passwordForm);
    var values = FORM.collectValues(passwordForm);

    var missing = false;
    ['currentPassword', 'newPassword', 'newPasswordConfirm'].forEach(function (name) {
      if (!values[name]) { FORM.setFieldError(name, 'Заполните поле'); missing = true; }
    });
    if (missing) return;
    if (values.newPassword !== values.newPasswordConfirm) {
      FORM.setFieldError('newPasswordConfirm', 'Пароли не совпадают');
      return;
    }

    FORM.setBusy(passwordSubmit, true, 'Смена пароля…');
    API.changePassword(values)
      .then(function (data) {
        FORM.setBusy(passwordSubmit, false);
        passwordForm.reset();
        notify('success', data.message, 'Пароль изменён');
      })
      .catch(function (error) {
        FORM.setBusy(passwordSubmit, false);
        var parsed = fail(error, 'Пароль не изменён');
        if (parsed.code === 'INVALID_CURRENT_PASSWORD') {
          FORM.setFieldError('currentPassword', 'Текущий пароль указан неверно');
        }
      });
  });

  // --- Удаление учётной записи --------------------------------------------------------
  var deleteForm = document.getElementById('delete-form');
  var deleteSubmit = document.getElementById('delete-submit');

  deleteForm.addEventListener('submit', function (event) {
    event.preventDefault();
    FORM.clearErrors(deleteForm);
    var password = deleteForm.elements.deletePassword.value;
    if (!password) {
      FORM.setFieldError('deletePassword', 'Введите пароль, чтобы подтвердить удаление');
      return;
    }

    window.PVH.confirm({
      title: 'Удалить учётную запись?',
      text: 'Учётная запись, история заказов и все сеансы входа будут удалены. Это действие нельзя отменить.',
      confirmText: 'Удалить навсегда',
      danger: true,
    }).then(function (confirmed) {
      if (!confirmed) return;

      FORM.setBusy(deleteSubmit, true, 'Удаление…');
      API.deleteAccount(password)
        .then(function () {
          window.PVH.setPendingAlert('success', 'Учётная запись удалена. Спасибо, что пользовались сервисом.',
            'Готово');
          window.location.href = '/';
        })
        .catch(function (error) {
          FORM.setBusy(deleteSubmit, false);
          var parsed = API.parseError(error);
          if (parsed.fields && parsed.fields.password) {
            FORM.setFieldError('deletePassword', parsed.fields.password.message);
          }
          notify('danger', parsed.message, 'Учётная запись не удалена');
        });
    });
  });
});

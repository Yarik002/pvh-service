'use strict';

/**
 * Проверка полей формы на стороне браузера.
 *
 * Правила повторяют серверные (src/validators/rules.js), поэтому пользователь
 * видит ошибку сразу при заполнении формы, не дожидаясь ответа сервера.
 *
 * ВАЖНО: клиентская проверка предназначена только для удобства работы.
 * Она не является защитой: запрос можно отправить в обход браузера, поэтому
 * все те же правила повторно проверяются на сервере.
 *
 * Модуль работает с разметкой полей следующего вида:
 *
 *   <div class="field" data-field="email">
 *     <label class="field__label" for="email">Адрес электронной почты</label>
 *     <input class="field__input" id="email" name="email">
 *     <span class="field__error"></span>
 *   </div>
 */

(function () {
  'use strict';

  /** Локальная часть адреса электронной почты. */
  var EMAIL_LOCAL = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*";
  /** Доменная часть адреса электронной почты. */
  var EMAIL_DOMAIN = '(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}';
  /** Полный шаблон адреса электронной почты. */
  var EMAIL_PATTERN = new RegExp('^' + EMAIL_LOCAL + '@' + EMAIL_DOMAIN + '$');

  /** Шаблон трек-номера — совпадает с серверным (src/validators/schemas.js). */
  var TRACK_PATTERN = /^[A-Z0-9][A-Z0-9-]{4,38}[A-Z0-9]$/;

  /** Правила проверки полей. Каждое правило возвращает сообщение об ошибке либо null. */
  var RULES = {
    /** Имя пользователя: обязательно, от 2 до 100 символов. */
    name: function (value) {
      var text = String(value || '').trim();
      if (text === '') return 'Имя обязательно для заполнения';
      if (text.length < 2) return 'Имя должно содержать не менее 2 символов';
      if (text.length > 100) return 'Имя должно содержать не более 100 символов';
      return null;
    },

    /** Адрес электронной почты: обязателен, проверяется формат. */
    email: function (value) {
      var text = String(value || '').trim();
      if (text === '') return 'Адрес электронной почты обязателен для заполнения';
      if (text.length > 254) return 'Адрес электронной почты слишком длинный (не более 254 символов)';
      if (!EMAIL_PATTERN.test(text)) {
        return 'Укажите корректный адрес электронной почты, например ivanov@mail.ru';
      }
      return null;
    },

    /** Пароль: не менее 8 символов, обязательно буква и цифра. */
    password: function (value) {
      var text = String(value || '');
      if (text === '') return 'Пароль обязателен для заполнения';
      if (text.length < 8) return 'Пароль должен содержать не менее 8 символов';
      if (text.length > 128) return 'Пароль слишком длинный (не более 128 символов)';
      if (!/[A-Za-zА-Яа-яЁё]/.test(text)) return 'Пароль должен содержать хотя бы одну букву';
      if (!/\d/.test(text)) return 'Пароль должен содержать хотя бы одну цифру';
      return null;
    },

    /** Повтор пароля: должен совпадать с паролем. */
    passwordConfirm: function (value, form) {
      var text = String(value || '');
      if (text === '') return 'Подтверждение пароля обязательно для заполнения';
      if (text !== String((form && form.password) || '')) return 'Пароль и подтверждение пароля не совпадают';
      return null;
    },

    /** Текущий пароль при смене: только обязательность. */
    currentPassword: function (value) {
      if (String(value || '') === '') return 'Введите текущий пароль';
      return null;
    },

    /** Согласие с правилами обработки данных. */
    agree: function (value, form) {
      if (!form || !form.agree) return 'Необходимо согласиться с правилами обработки данных';
      return null;
    },

    // --- Приёмка заказа (15-й день) --------------------------------------

    /**
     * Трек-номер: 6–40 символов, латинские буквы, цифры и дефис.
     * Регистр не важен — сервер приводит трек-номер к верхнему регистру.
     */
    trackNumber: function (value) {
      var text = String(value || '').trim().toUpperCase();
      if (text === '') return 'Укажите трек-номер';
      if (!TRACK_PATTERN.test(text)) {
        return 'Трек-номер: от 6 до 40 символов — латинские буквы, цифры и дефис, '
          + 'например RA123456789BY';
      }
      return null;
    },

    /** Получатель заказа: адрес электронной почты зарегистрированного клиента. */
    clientEmail: function (value) {
      var text = String(value || '').trim();
      if (text === '') return 'Укажите получателя заказа';
      if (!EMAIL_PATTERN.test(text)) {
        return 'Укажите корректный адрес электронной почты, например ivanov@mail.ru';
      }
      return null;
    },

    /** Описание посылки: необязательно, до 500 символов. */
    description: function (value) {
      if (String(value || '').trim().length > 500) {
        return 'Описание посылки должно содержать не более 500 символов';
      }
      return null;
    },

    /** Ячейка при ручном выборе обязательна. */
    cellId: function (value, form) {
      if (form && form.cellMode === 'manual' && String(value || '') === '') {
        return 'Выберите ячейку хранения из списка свободных';
      }
      return null;
    },
  };

  /**
   * Находит контейнер поля по имени.
   * @param {string} name
   * @returns {HTMLElement|null}
   */
  function fieldContainer(name) {
    return document.querySelector('[data-field="' + name + '"]');
  }

  /**
   * Показывает сообщение об ошибке у поля.
   * @param {string} name имя поля
   * @param {string|null} message текст ошибки либо null для снятия ошибки
   */
  function setFieldError(name, message) {
    var container = fieldContainer(name);
    if (!container) return;

    var errorNode = container.querySelector('.field__error');
    var input = container.querySelector('.field__input, .field__select, .field__textarea');

    if (message) {
      container.classList.add('field--invalid');
      container.classList.remove('field--valid');
      if (errorNode) errorNode.textContent = message;
      if (input) {
        input.setAttribute('aria-invalid', 'true');
        if (errorNode && errorNode.id) input.setAttribute('aria-describedby', errorNode.id);
      }
    } else {
      container.classList.remove('field--invalid');
      if (errorNode) errorNode.textContent = '';
      if (input) input.removeAttribute('aria-invalid');
    }
  }

  /** Снимает все сообщения об ошибках формы. */
  function clearErrors(form) {
    var containers = form.querySelectorAll('.field');

    Array.prototype.forEach.call(containers, function (container) {
      container.classList.remove('field--invalid', 'field--valid');
      var errorNode = container.querySelector('.field__error');
      if (errorNode) errorNode.textContent = '';
      var input = container.querySelector('.field__input, .field__select, .field__textarea');
      if (input) input.removeAttribute('aria-invalid');
    });
  }

  /**
   * Собирает значения формы.
   * @param {HTMLFormElement} form
   * @returns {object}
   */
  function collectValues(form) {
    var values = {};
    var elements = form.querySelectorAll('input, select, textarea');

    Array.prototype.forEach.call(elements, function (element) {
      if (!element.name) return;

      // В группе переключателей учитывается только выбранный:
      // иначе значение группы бралось бы у последнего переключателя
      if (element.type === 'radio') {
        if (element.checked) values[element.name] = element.value;
        return;
      }

      values[element.name] = element.type === 'checkbox' ? element.checked : element.value;
    });

    return values;
  }

  /**
   * Проверяет одно поле.
   * @param {string} name
   * @param {object} values
   * @returns {string|null} сообщение об ошибке либо null
   */
  function validateField(name, values) {
    var rule = RULES[name];
    if (!rule) return null;
    return rule(values[name], values);
  }

  /**
   * Проверяет всю форму.
   *
   * @param {HTMLFormElement} form
   * @returns {{valid: boolean, values: object, errors: object}}
   */
  function validateForm(form) {
    var values = collectValues(form);
    var errors = {};
    var valid = true;

    Object.keys(values).forEach(function (name) {
      if (!RULES[name]) return;

      var message = validateField(name, values);
      if (message) {
        errors[name] = message;
        valid = false;
        setFieldError(name, message);
      } else {
        setFieldError(name, null);
        var container = fieldContainer(name);
        if (container) container.classList.add('field--valid');
      }
    });

    // Фокус переводится к первому полю с ошибкой: так пользователю
    // не приходится искать её самостоятельно
    var firstError = Object.keys(errors)[0];
    if (firstError) {
      var container = fieldContainer(firstError);
      var input = container && container.querySelector('.field__input, .field__select, .field__textarea');
      if (input) input.focus();
    }

    return { valid: valid, values: values, errors: errors };
  }

  /**
   * Показывает ошибки, полученные от сервера.
   * @param {object} fields объект вида { поле: { message: '…' } }
   */
  function showServerErrors(fields) {
    if (!fields) return;

    Object.keys(fields).forEach(function (name) {
      var message = fields[name] && fields[name].message;
      if (message) setFieldError(name, message);
    });
  }

  /**
   * Подключает проверку полей «на лету»: ошибка снимается, как только
   * пользователь исправил значение.
   *
   * @param {HTMLFormElement} form
   */
  function watchFields(form) {
    var elements = form.querySelectorAll('input, select, textarea');

    Array.prototype.forEach.call(elements, function (element) {
      if (!element.name || !RULES[element.name]) return;

      var handler = function () {
        var container = fieldContainer(element.name);
        if (container && container.classList.contains('field--invalid')) {
          var values = collectValues(form);
          setFieldError(element.name, validateField(element.name, values));
        }
      };

      element.addEventListener('blur', handler);
      element.addEventListener('input', handler);
      element.addEventListener('change', handler);
    });
  }

  /**
   * Переключает состояние кнопки отправки формы.
   * @param {HTMLButtonElement} button
   * @param {boolean} busy
   * @param {string} [busyText]
   */
  function setBusy(button, busy, busyText) {
    if (!button) return;

    if (busy) {
      button.dataset.label = button.textContent;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      if (busyText) button.textContent = busyText;
    } else {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      if (button.dataset.label) button.textContent = button.dataset.label;
    }
  }

  /**
   * Выводит уведомление об ошибке из ответа сервера.
   * @param {object} error
   * @returns {string} текст сообщения
   */
  function reportError(error) {
    var parsed = window.PVH_API
      ? window.PVH_API.parseError(error)
      : { message: String(error && error.message), fields: null };

    if (window.PVH) {
      window.PVH.clearAlerts();
      window.PVH.showAlert('danger', parsed.message, 'Не удалось выполнить действие');
    }

    if (parsed.fields) showServerErrors(parsed.fields);

    return parsed.message;
  }

  window.PVH_FORM = {
    validateForm: validateForm,
    validateField: validateField,
    collectValues: collectValues,
    setFieldError: setFieldError,
    clearErrors: clearErrors,
    showServerErrors: showServerErrors,
    watchFields: watchFields,
    setBusy: setBusy,
    reportError: reportError,
    RULES: RULES,
  };
}());

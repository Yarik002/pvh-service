'use strict';

/**
 * Тесты проверки полей формы в браузере (10-й день практики).
 *
 * Модуль public/js/form.js рассчитан на работу в браузере, поэтому для его
 * проверки создаётся минимальная модель документа: разметка формы читается
 * из файла страницы регистрации, а обращения к document и window заменяются
 * простыми подставными объектами. Библиотеки для работы с DOM не требуются.
 *
 * Проверяется главное: правила проверки полей совпадают с серверными,
 * а сообщения об ошибках выводятся рядом с нужным полем.
 *
 * Запуск:  node tests/formValidation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const FORM_JS = path.join(__dirname, '..', 'public', 'js', 'form.js');

// ---------------------------------------------------------------------------
//  Минимальная модель документа
// ---------------------------------------------------------------------------

/** Класс-список классов элемента. */
class ClassList {
  constructor() { this.items = new Set(); }
  add(...names) { names.forEach((name) => this.items.add(name)); }
  remove(...names) { names.forEach((name) => this.items.delete(name)); }
  contains(name) { return this.items.has(name); }
  toString() { return [...this.items].join(' '); }
}

/** Элемент документа. */
class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.classList = new ClassList();
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.type = 'text';
    this.disabled = false;
    this.dataset = {};
    this.listeners = {};
    this.parent = null;
  }

  set className(value) {
    this.classList = new ClassList();
    String(value).split(/\s+/).filter(Boolean).forEach((name) => this.classList.add(name));
  }

  get className() { return this.classList.toString(); }

  appendChild(child) { child.parent = this; this.children.push(child); return child; }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    // В браузере стандартные атрибуты доступны и как свойства элемента
    if (['name', 'type', 'value', 'id', 'placeholder'].includes(name)) {
      this[name] = String(value);
    }
  }

  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }

  addEventListener(type, handler) {
    (this.listeners[type] = this.listeners[type] || []).push(handler);
  }

  /** Вызывает обработчики события (для проверки). */
  trigger(type) {
    (this.listeners[type] || []).forEach((handler) => handler({ target: this }));
  }

  /** Все потомки элемента. */
  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  /**
   * Ищет потомков по простому селектору: имени класса, имени тега
   * либо перечню селекторов через запятую.
   *
   * @param {string|Function} selector
   * @returns {Element[]}
   */
  querySelectorAll(selector) {
    return this.descendants().filter((element) => Element.matches(element, selector));
  }

  /**
   * Первый потомок, удовлетворяющий селектору.
   * @param {string|Function} selector
   * @returns {Element|null}
   */
  querySelector(selector) {
    if (typeof selector === 'function') return this.descendants().find(selector) || null;
    return this.querySelectorAll(selector)[0] || null;
  }

  /** Проверяет соответствие элемента селектору. */
  static matches(element, selector) {
    if (typeof selector === 'function') return Boolean(selector(element));

    return String(selector).split(',').some((part) => {
      const simple = part.trim();

      // Селектор по имени класса: .имя
      if (simple.startsWith('.')) return element.matches(simple.slice(1));

      // Селектор по имени тега: input, select, textarea
      if (/^[a-z]+$/i.test(simple)) return element.tagName === simple.toUpperCase();

      return false;
    });
  }

  focus() { this.focused = true; }

  matches(className) {
    return this.classList.contains(className);
  }
}

/** Ищет элемент по имени поля среди контейнеров формы. */
function findByName(root, name) {
  return root.descendants().find((element) => element.attributes.name === name) || null;
}

/** Ищет контейнер поля по значению атрибута data-field. */
function findFieldContainer(root, name) {
  return root.descendants().find((element) => element.attributes['data-field'] === name) || null;
}

/**
 * Создаёт модель формы с указанными полями.
 * @param {string[]} fieldNames
 */
function createForm(fieldNames) {
  const form = new Element('form');

  fieldNames.forEach((name) => {
    const container = form.appendChild(new Element('div'));
    container.className = 'field';
    container.setAttribute('data-field', name);

    const input = new Element('input');
    input.className = 'field__input';
    input.setAttribute('name', name);
    if (name === 'agree') input.type = 'checkbox';
    container.appendChild(input);

    const error = new Element('span');
    error.className = 'field__error';
    container.appendChild(error);
  });

  return form;
}

/**
 * Загружает модуль form.js в подготовленное окружение.
 * @returns {{window: object, document: object}}
 */
function loadModule() {
  const context = {
    window: {},
    document: {},
    console,
    RegExp,
    String,
    Number,
    Object,
    Array,
  };

  context.window.document = context.document;

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(FORM_JS, 'utf8'), context, { filename: 'form.js' });

  return context;
}

/**
 * Подготавливает окружение с формой.
 * @param {string[]} fieldNames
 */
function setup(fieldNames) {
  const context = loadModule();
  const form = createForm(fieldNames);

  // Заглушка document.querySelector ищет контейнер поля по имени
  context.document.querySelector = (selector) => {
    const match = /^\[data-field="(.+)"\]$/.exec(selector);
    return match ? findFieldContainer(form, match[1]) : null;
  };

  return { context, form, api: context.window.PVH_FORM };
}

// Методы поиска по селектору берутся из класса Element: они добавлены
// в прототип, поэтому доступны каждому созданному элементу

/** Заполняет поля формы значениями. */
function fill(form, values) {
  Object.entries(values).forEach(([name, value]) => {
    const input = findByName(form, name);
    if (!input) throw new Error(`Поле ${name} отсутствует в форме`);
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = String(value);
  });
}

const ALL_FIELDS = ['name', 'email', 'password', 'passwordConfirm', 'agree'];

// ---------------------------------------------------------------------------
//  Проверка отдельного поля: имя
// ---------------------------------------------------------------------------

test('имя обязательно для заполнения', () => {
  const { api } = setup(ALL_FIELDS);
  assert.match(api.validateField('name', { name: '' }), /обязательно/);
  assert.match(api.validateField('name', { name: '   ' }), /обязательно/);
});

test('имя короче двух символов отклоняется', () => {
  const { api } = setup(ALL_FIELDS);
  assert.match(api.validateField('name', { name: 'И' }), /не менее 2 символов/);
});

test('имя длиннее 100 символов отклоняется', () => {
  const { api } = setup(ALL_FIELDS);
  assert.match(api.validateField('name', { name: 'И'.repeat(101) }), /не более 100 символов/);
});

test('корректное имя принимается', () => {
  const { api } = setup(ALL_FIELDS);
  assert.equal(api.validateField('name', { name: 'Иванов Иван' }), null);
});

// ---------------------------------------------------------------------------
//  Проверка адреса электронной почты
// ---------------------------------------------------------------------------

test('адрес электронной почты обязателен', () => {
  const { api } = setup(ALL_FIELDS);
  assert.match(api.validateField('email', { email: '' }), /обязателен/);
});

test('адреса без символа @ отклоняются', () => {
  const { api } = setup(ALL_FIELDS);
  for (const email of ['ivanov', 'ivanov.mail.ru', 'ivanov@', '@mail.ru']) {
    assert.match(api.validateField('email', { email }), /корректный адрес/,
      `адрес «${email}» должен быть отклонён`);
  }
});

test('адреса с неверной доменной зоной отклоняются', () => {
  const { api } = setup(ALL_FIELDS);
  for (const email of ['ivanov@mail', 'ivanov@mail.r', 'ivanov@mail.1ru']) {
    assert.match(api.validateField('email', { email }), /корректный адрес/,
      `адрес «${email}» должен быть отклонён`);
  }
});

test('корректные адреса принимаются', () => {
  const { api } = setup(ALL_FIELDS);
  const valid = [
    'ivanov@mail.ru',
    'i.ivanov@mail.ru',
    'ivanov+tag@mail.ru',
    'ivanov_1@sub.mail.com',
    'ivanov-petrov@mail.by',
  ];

  for (const email of valid) {
    assert.equal(api.validateField('email', { email }), null,
      `адрес «${email}» должен приниматься`);
  }
});

test('слишком длинный адрес отклоняется', () => {
  const { api } = setup(ALL_FIELDS);
  const email = `${'a'.repeat(250)}@mail.ru`;
  assert.match(api.validateField('email', { email }), /слишком длинный/);
});

// ---------------------------------------------------------------------------
//  Проверка пароля
// ---------------------------------------------------------------------------

test('пароль короче восьми символов отклоняется', () => {
  const { api } = setup(ALL_FIELDS);
  assert.match(api.validateField('password', { password: 'parol1' }), /не менее 8 символов/);
});

test('пароль без букв отклоняется', () => {
  const { api } = setup(ALL_FIELDS);
  assert.match(api.validateField('password', { password: '12345678' }), /хотя бы одну букву/);
});

test('пароль без цифр отклоняется', () => {
  const { api } = setup(ALL_FIELDS);
  assert.match(api.validateField('password', { password: 'parolparol' }), /хотя бы одну цифру/);
});

test('надёжный пароль принимается', () => {
  const { api } = setup(ALL_FIELDS);
  assert.equal(api.validateField('password', { password: 'Xk9#mQ2$vL7p' }), null);
});

test('пароль длиннее 128 символов отклоняется', () => {
  const { api } = setup(ALL_FIELDS);
  assert.match(api.validateField('password', { password: `a1${'x'.repeat(130)}` }), /слишком длинный/);
});

// ---------------------------------------------------------------------------
//  Проверка совпадения паролей
// ---------------------------------------------------------------------------

test('несовпадающие пароли отклоняются', () => {
  const { api } = setup(ALL_FIELDS);

  const message = api.validateField('passwordConfirm', {
    password: 'Xk9#mQ2$vL7p',
    passwordConfirm: 'Xk9#mQ2$vL7',
  });

  assert.match(message, /не совпадают/);
});

test('совпадающие пароли принимаются', () => {
  const { api } = setup(ALL_FIELDS);

  assert.equal(api.validateField('passwordConfirm', {
    password: 'Xk9#mQ2$vL7p',
    passwordConfirm: 'Xk9#mQ2$vL7p',
  }), null);
});

// ---------------------------------------------------------------------------
//  Согласие на обработку данных
// ---------------------------------------------------------------------------

test('без согласия на обработку данных форма не проходит проверку', () => {
  const { api } = setup(ALL_FIELDS);
  assert.match(api.validateField('agree', { agree: false }), /согласиться/);
  assert.equal(api.validateField('agree', { agree: true }), null);
});

// ---------------------------------------------------------------------------
//  Проверка формы целиком
// ---------------------------------------------------------------------------

test('правильно заполненная форма проходит проверку', () => {
  const { form, api } = setup(ALL_FIELDS);

  fill(form, {
    name: 'Иванов Иван',
    email: 'ivanov@mail.ru',
    password: 'Xk9#mQ2$vL7p',
    passwordConfirm: 'Xk9#mQ2$vL7p',
    agree: true,
  });

  const result = api.validateForm(form);

  assert.equal(result.valid, true);
  // Объект создан в отдельном контексте, поэтому сравнивается по составу полей
  assert.equal(Object.keys(result.errors).length, 0, 'ошибок быть не должно');
  assert.equal(result.values.email, 'ivanov@mail.ru');
});

test('форма с ошибками возвращает перечень ошибок по полям', () => {
  const { form, api } = setup(ALL_FIELDS);

  fill(form, {
    name: 'И',
    email: 'nekorrektnyj',
    password: 'korotkij',
    passwordConfirm: 'drugaya',
    agree: false,
  });

  const result = api.validateForm(form);

  assert.equal(result.valid, false);
  assert.ok(result.errors.name, 'ошибка имени');
  assert.ok(result.errors.email, 'ошибка адреса');
  assert.ok(result.errors.password, 'ошибка пароля');
  assert.ok(result.errors.passwordConfirm, 'ошибка подтверждения пароля');
  assert.ok(result.errors.agree, 'ошибка согласия');
});

test('сообщение об ошибке выводится рядом с полем', () => {
  const { form, api } = setup(ALL_FIELDS);

  fill(form, { email: 'nekorrektnyj' });
  api.validateForm(form);

  const container = findFieldContainer(form, 'email');
  const errorNode = container.querySelector((element) => element.matches('field__error'));

  assert.ok(container.classList.contains('field--invalid'), 'контейнер помечен как ошибочный');
  assert.match(errorNode.textContent, /корректный адрес/);
});

test('у корректного поля сообщение об ошибке снимается', () => {
  const { form, api } = setup(ALL_FIELDS);

  fill(form, { email: 'nekorrektnyj' });
  api.validateForm(form);

  fill(form, { email: 'ivanov@mail.ru' });
  api.validateForm(form);

  const container = findFieldContainer(form, 'email');
  const errorNode = container.querySelector((element) => element.matches('field__error'));

  assert.ok(!container.classList.contains('field--invalid'));
  assert.equal(errorNode.textContent, '');
});

test('ошибки, полученные от сервера, выводятся у нужных полей', () => {
  const { form, api } = setup(ALL_FIELDS);

  api.showServerErrors({
    email: { message: 'Такой адрес электронной почты уже зарегистрирован' },
    name: { message: 'Недопустимое имя' },
  });

  const emailContainer = findFieldContainer(form, 'email');
  const emailError = emailContainer.querySelector((element) => element.matches('field__error'));

  assert.match(emailError.textContent, /уже зарегистрирован/);
  assert.ok(findFieldContainer(form, 'name').classList.contains('field--invalid'));
});

test('снятие ошибок очищает все поля', () => {
  const { form, api } = setup(ALL_FIELDS);

  fill(form, { email: 'nekorrektnyj', name: 'И' });
  api.validateForm(form);
  api.clearErrors(form);

  ALL_FIELDS.forEach((name) => {
    const container = findFieldContainer(form, name);
    const errorNode = container.querySelector((element) => element.matches('field__error'));
    assert.ok(!container.classList.contains('field--invalid'), `${name}: признак ошибки снят`);
    assert.equal(errorNode.textContent, '', `${name}: сообщение очищено`);
  });
});

test('значения формы собираются вместе с переключателями', () => {
  const { form, api } = setup(ALL_FIELDS);

  fill(form, {
    name: 'Иванов Иван',
    email: 'ivanov@mail.ru',
    password: 'Xk9#mQ2$vL7p',
    passwordConfirm: 'Xk9#mQ2$vL7p',
    agree: true,
  });

  const values = api.collectValues(form);

  assert.equal(values.name, 'Иванов Иван');
  assert.equal(values.agree, true);
});

test('кнопка отправки блокируется во время запроса', () => {
  const { api } = setup(ALL_FIELDS);
  const button = new Element('button');
  button.textContent = 'Зарегистрироваться';

  api.setBusy(button, true, 'Отправка…');
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Отправка…');
  assert.equal(button.getAttribute('aria-busy'), 'true');

  api.setBusy(button, false);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Зарегистрироваться');
});

// ---------------------------------------------------------------------------
//  Соответствие серверным правилам
// ---------------------------------------------------------------------------

test('правила проверки пароля совпадают с серверными', () => {
  // Те же значения проверяются серверными правилами: результаты должны совпадать
  const { validate, passwordStrength } = require('../src/validators/rules');
  const { api } = setup(ALL_FIELDS);

  const passwords = ['parol1', '12345678', 'parolparol', 'Xk9#mQ2$vL7p', 'a1'.repeat(70)];

  passwords.forEach((password) => {
    let serverOk = true;
    try {
      validate({ password }, { password: { label: 'Пароль', rules: [passwordStrength()] } });
    } catch (error) {
      serverOk = false;
    }

    const clientOk = api.validateField('password', { password }) === null;

    assert.equal(clientOk, serverOk,
      `пароль «${password}»: браузер — ${clientOk}, сервер — ${serverOk}`);
  });
});

test('правила проверки адреса совпадают с серверными', () => {
  const { validate, required, emailPattern } = require('../src/validators/rules');
  const { api } = setup(ALL_FIELDS);

  const emails = [
    'ivanov@mail.ru', 'i.ivanov@mail.ru', 'ivanov+tag@mail.ru',
    'ivanov', 'ivanov@', '@mail.ru', 'ivanov@mail', 'ivanov@mail.1ru',
  ];

  emails.forEach((email) => {
    let serverOk = true;
    try {
      validate({ email }, {
        email: { label: 'Адрес', rules: [required('Адрес'), emailPattern()] },
      });
    } catch (error) {
      serverOk = false;
    }

    const clientOk = api.validateField('email', { email }) === null;

    assert.equal(clientOk, serverOk,
      `адрес «${email}»: браузер — ${clientOk}, сервер — ${serverOk}`);
  });
});

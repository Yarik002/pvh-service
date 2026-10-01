'use strict';

/**
 * Модульные тесты хеширования паролей (3-й день практики).
 *
 * Запуск:  npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const {
  hashPassword,
  verifyPassword,
  isPasswordHash,
} = require('../src/utils/password');

test('хеш пароля имеет ожидаемый формат', async () => {
  const hash = await hashPassword('parol12345');

  assert.equal(isPasswordHash(hash), true);
  const parts = hash.split('$');
  assert.equal(parts.length, 6);
  assert.equal(parts[0], 'scrypt');
  assert.equal(parts[4].length, 32, 'соль — 16 байт (32 шестнадцатеричных символа)');
  assert.equal(parts[5].length, 128, 'хеш — 64 байта (128 шестнадцатеричных символов)');
});

test('пароль не сохраняется в открытом виде', async () => {
  const password = 'SekretnoeSlovo123';
  const hash = await hashPassword(password);
  assert.equal(hash.includes(password), false, 'исходный пароль не должен присутствовать в хеше');
  assert.equal(hash.includes('Sekretnoe'), false);
});

test('одинаковые пароли дают разные хеши (случайная соль)', async () => {
  const [first, second] = await Promise.all([
    hashPassword('parol12345'),
    hashPassword('parol12345'),
  ]);
  assert.notEqual(first, second, 'соль должна быть уникальной для каждого пароля');
});

test('верный пароль подтверждается, неверный — отклоняется', async () => {
  const hash = await hashPassword('parol12345');

  assert.equal(await verifyPassword('parol12345', hash), true);
  assert.equal(await verifyPassword('parol12346', hash), false);
  assert.equal(await verifyPassword('Parol12345', hash), false, 'регистр учитывается');
  assert.equal(await verifyPassword('', hash), false);
});

test('проверка устойчива к повреждённым данным', async () => {
  assert.equal(await verifyPassword('parol12345', 'мусор'), false);
  assert.equal(await verifyPassword('parol12345', ''), false);
  assert.equal(await verifyPassword('parol12345', 'scrypt$16384$8$1$abc'), false);
  assert.equal(await verifyPassword('parol12345', 'md5$16384$8$1$aa$bb'), false);
  assert.equal(await verifyPassword(null, 'scrypt$16384$8$1$aa$bb'), false);
});

test('хеширование отклоняет пустой пароль', async () => {
  await assert.rejects(() => hashPassword(''), TypeError);
  await assert.rejects(() => hashPassword(null), TypeError);
});

test('разные пароли дают разные хеши', async () => {
  const a = await hashPassword('parol12345');
  const b = await hashPassword('parol123456');
  assert.notEqual(a.split('$')[5], b.split('$')[5]);
});

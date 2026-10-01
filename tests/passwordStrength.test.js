'use strict';

/**
 * Модульные тесты оценки надёжности пароля (4-й день практики).
 *
 * Запуск:  npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const {
  analyzePassword,
  findWeaknessReason,
  isCommonPassword,
  containsPersonalData,
  containsCommonWord,
  hasKeyboardSequence,
  isRepeatedPattern,
  countCharacterClasses,
  normalize,
  decodeLeet,
} = require('../src/utils/passwordStrength');

const USER = { name: 'Иванов Иван', email: 'ivanov@mail.ru' };

test('функция normalize приводит пароль к сравнимому виду', () => {
  assert.equal(normalize('Qwerty_123'), 'qwerty123');
  assert.equal(normalize('Пароль-2026!'), 'пароль2026');
  assert.equal(normalize(''), '');
  assert.equal(normalize(null), '');
});

test('функция decodeLeet восстанавливает буквы, заменённые символами', () => {
  assert.equal(decodeLeet('p@ssw0rd'), 'password');
  assert.equal(decodeLeet('h3llo'), 'hello');
  assert.equal(decodeLeet('1love'), 'ilove');
});

test('словарь распознаёт часто используемые пароли', () => {
  const common = [
    '123456', 'qwerty', 'password', 'qwerty123', 'password1',
    'admin123', 'йцукен', 'пароль123', 'iloveyou', 'letmein',
  ];
  for (const password of common) {
    assert.equal(isCommonPassword(password), true, `пароль «${password}» должен распознаваться`);
  }
});

test('словарь распознаёт пароли с заменой символов и дописанными цифрами', () => {
  const disguised = ['P@ssw0rd', 'QWERTY_123', 'Passw0rd1', 'qwerty2026', 'Пароль123'];
  for (const password of disguised) {
    assert.equal(isCommonPassword(password), true, `пароль «${password}» должен распознаваться`);
  }
});

test('словарь не отклоняет стойкие пароли', () => {
  const strong = ['Xk9#mQ2$vL7p', 'Tr9$kLm2#nQ', 'Ivan2026x!', '7vR#pL2mQ9'];
  for (const password of strong) {
    assert.equal(isCommonPassword(password), false, `пароль «${password}» не должен отклоняться`);
  }
});

test('пароль распознаётся как содержащий распространённое слово', () => {
  assert.equal(containsCommonWord('Str0ng!Passw0rd'), true);
  assert.equal(containsCommonWord('MyQwerty!1'), true);
  assert.equal(containsCommonWord('Xk9#mQ2$vL7p'), false);
});

test('обнаруживается использование личных данных в пароле', () => {
  assert.equal(containsPersonalData('ivanov123', USER), true, 'фамилия из адреса почты');
  assert.equal(containsPersonalData('Иванов123', USER), true, 'фамилия из имени');
  assert.equal(containsPersonalData('ivanovXk9#mQ2', USER), true, 'фамилия внутри стойкого пароля');
  assert.equal(containsPersonalData('Xk9#mQ2$vL7p', USER), false);

  // Фрагменты короче 3 символов не учитываются, чтобы не отклонять
  // добросовестные пароли из-за коротких сочетаний
  assert.equal(containsPersonalData('ab12cd34', { name: 'Аб', email: 'ab@mail.ru' }), false);
  // Пароль не содержит данных другого пользователя
  assert.equal(containsPersonalData('petrov123', USER), false);
});

test('обнаруживаются последовательности клавиш', () => {
  const sequences = ['qwerty123', 'asdfgh1', '123456a', 'йцукен123', '654321x'];
  for (const password of sequences) {
    assert.equal(hasKeyboardSequence(password), true, `«${password}» содержит последовательность`);
  }
  assert.equal(hasKeyboardSequence('Xk9#mQ2$vL7p'), false);
});

test('обнаруживаются повторяющиеся символы и блоки', () => {
  const repeated = ['aaaaaaaa', '11111111', 'abcabcabc', 'Abcabcabc1', 'xyxyxyxy', 'aaaabbbb'];
  for (const password of repeated) {
    assert.equal(isRepeatedPattern(password), true, `«${password}» содержит повтор`);
  }
  assert.equal(isRepeatedPattern('Xk9#mQ2$vL7p'), false);
  assert.equal(isRepeatedPattern('Tr9$kLm2#nQ'), false);
});

test('подсчёт классов символов работает корректно', () => {
  assert.equal(countCharacterClasses('aaaaaaaa'), 1, 'только строчные буквы');
  assert.equal(countCharacterClasses('Aaaaaaaa'), 2, 'строчные и прописные');
  assert.equal(countCharacterClasses('Aaaaaaa1'), 3, 'плюс цифры');
  assert.equal(countCharacterClasses('Aaaaaa1!'), 4, 'плюс специальные символы');
  assert.equal(countCharacterClasses('12345678'), 1, 'только цифры');
});

test('стойкий пароль получает высокую оценку', () => {
  const result = analyzePassword('Xk9#mQ2$vL7p', USER);
  assert.ok(result.score >= 70, `ожидалась высокая оценка, получено ${result.score}`);
  assert.ok(['strong', 'veryStrong'].includes(result.level), `уровень: ${result.level}`);
  assert.equal(result.warnings.length, 0, 'замечаний быть не должно');
  assert.ok(result.checks.every((check) => check.passed));
});

test('ненадёжный пароль получает низкую оценку и замечания', () => {
  const result = analyzePassword('qwerty123', USER);
  assert.ok(result.score < 55, `ожидалась низкая оценка, получено ${result.score}`);
  assert.ok(result.warnings.length > 0, 'должны быть замечания');
  assert.ok(result.checks.some((check) => check.id === 'notCommon' && !check.passed));
});

test('пароль с распространённым словом не может считаться очень надёжным', () => {
  const result = analyzePassword('Str0ng!Passw0rd', USER);
  // Пароль длинный и содержит разные символы, но из-за словарного слова
  // его оценка ограничивается уровнем не выше «средняя»
  assert.ok(result.score < 70, `оценка должна быть ограничена, получено ${result.score}`);
  assert.notEqual(result.level, 'veryStrong');
  assert.ok(result.checks.some((check) => check.id === 'noCommonWord' && !check.passed));
});

test('оценка всегда находится в пределах от 0 до 100', () => {
  const samples = ['', 'a', '123456', 'qwerty123', 'Xk9#mQ2$vL7p', 'a'.repeat(100), 'Пароль2026!'];
  for (const password of samples) {
    const { score } = analyzePassword(password, USER);
    assert.ok(score >= 0 && score <= 100, `оценка ${score} вне допустимого диапазона`);
  }
});

test('длинный пароль получает дополнительные баллы', () => {
  const short = analyzePassword('Xk9#mQ2$vL7', USER);
  const long = analyzePassword('Xk9#mQ2$vL7pQ3w', USER);
  assert.ok(long.score >= short.score, 'более длинный пароль не должен оцениваться ниже');
});

test('каждая проверка содержит понятную рекомендацию при неудаче', () => {
  const result = analyzePassword('qwerty123', USER);
  for (const check of result.checks) {
    assert.ok(typeof check.title === 'string' && check.title.length > 0, 'заголовок проверки');
    if (!check.passed) {
      assert.ok(check.advice.length > 0, `нет рекомендации для проверки ${check.id}`);
    }
  }
});

test('функция findWeaknessReason называет причину отказа', () => {
  assert.equal(findWeaknessReason('qwerty123', USER).code, 'COMMON_PASSWORD');
  assert.equal(findWeaknessReason('Str0ng!Passw0rd', USER).code, 'CONTAINS_COMMON_WORD');
  // Пароль содержит фамилию пользователя — сообщение должно быть об этом,
  // даже если он также присутствует в словаре часто используемых паролей
  assert.equal(findWeaknessReason('ivanov12345', USER).code, 'CONTAINS_PERSONAL_DATA');
  assert.equal(findWeaknessReason('ivanovXk9#mQ2', USER).code, 'CONTAINS_PERSONAL_DATA');
  assert.equal(findWeaknessReason('abcabcabc1', USER).code, 'REPEATED_PATTERN');
  assert.equal(findWeaknessReason('Xk9#mQ2$vL7p', USER), null, 'стойкий пароль принимается');
});

test('результат анализа не содержит самого пароля', () => {
  const password = 'Xk9#mQ2$vL7p';
  const result = analyzePassword(password, USER);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(password), false, 'пароль не должен попадать в результат');
});

const CATEGORIES = ['디지털', '패션', '생활', '도서', '취미', '기타'];
const SORTS = {
  newest: { createdAt: 'desc' },
  oldest: { createdAt: 'asc' },
  price_asc: { price: 'asc' },
  price_desc: { price: 'desc' },
};

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function validPassword(password) {
  return typeof password === 'string'
    && password.length >= 11
    && password.length <= 128
    && /[A-Za-z]/.test(password)
    && /\d/.test(password)
    && /[^A-Za-z0-9]/.test(password);
}

function validUsername(username) {
  return typeof username === 'string' && /^[A-Za-z0-9_]{4,24}$/.test(username);
}

function validCategory(category) {
  return CATEGORIES.includes(category);
}

function getSort(sort) {
  return SORTS[sort] || SORTS.newest;
}

function positiveInt(value, min, max) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}

module.exports = {
  CATEGORIES, SORTS, cleanText, validPassword, validUsername, validCategory, getSort, positiveInt,
};

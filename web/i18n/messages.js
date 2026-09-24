import english from './en.js';
import japanese from './ja.js';

const catalogues = { en: english, ja: japanese };
export const hasMessage = key => typeof key === 'string' && Object.hasOwn(english, key);

// Stateless formatting lets concurrent exports keep the language selected when
// each request started, independently of the browser's current UI language.
export function formatMessage(language, key, ...values) {
  const catalogue = Object.hasOwn(catalogues, language) ? catalogues[language] : null;
  const translated = catalogue && Object.hasOwn(catalogue, key) ? catalogue[key] : key;
  return String(translated).replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match);
}

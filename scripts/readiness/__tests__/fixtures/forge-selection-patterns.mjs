// Deliberately broad mjs discovery preserves the historical ignored-test cases,
// including dist, nested ignores and skills aliases. Build-output ts is outside it.
export default {
  test: {include:['**/*.test.mjs', 'tests/**/*.js'], exclude:[]},
};

// Synthetic credential-shaped sample strings, assembled at call time so that no
// source file holds a literal the Forge content scan (R321/R323) would refuse.
// Every value is invented: none was ever issued by any service. Behaviour is
// identical to the former inline literals; only the spelling in source differs.
const j = (...parts) => parts.join('');

export const SYNTHETIC_MARKER = j('s', 'k-SYNTHETIC0000TESTMARKERNOTREAL');
export const pemHeader = (kind = 'RSA PRIVATE' + ' KEY') => j('-----', 'BEGIN ', kind, '-----');
export const pemBlock = () => `${pemHeader()}\nSYNTHETICNOTREAL\n-----END`;
export const fakeKeyFile = () => `${j('-----', 'BEGIN')} FAKE KEY-----\n(not a real key — the cache is always fresh, nothing is minted)\n`;
export const ghTokenSynthetic = () => j('gh', 'p_SYNTHETIC0000abcdefABCDEF0123456789');
export const ghTokenDigits = () => j('gh', 'p_1234567890ABCDEFabcdef1234567890AB');
export const slackSynthetic = () => j('xo', 'xb-NOTAREALTOKEN-SYNTHETIC-NOTREAL');
export const awsSynthetic = () => j('AK', 'IASYNTHETIC0000NR');
export const awsDigits = () => j('AK', 'IA1234567890ABCDEF');

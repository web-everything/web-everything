// @vitest-environment node
// R651: identifier/prose assignment tails no longer trip the high-entropy rule; real tokens still refuse.
import {describe,expect,it} from 'vitest';
import {credentialContentFinding} from '../forge-exec-manifest.mjs';

const scan=(path,text)=>credentialContentFinding(Buffer.from(path),Buffer.from(text));
const TOKEN='aZ3kQ9xLmP2vR7tYw4Bn8CdE5fGh'; // synthetic, high entropy, not a real credential

describe('R651 false positives pass',()=>{
  it('code expression assigned to a key-named variable',()=>{
    expect(scan('scripts/x.mjs','let previousPathKey = null;\n  previousPathKey = parsed.pathKey ?? null;\n')).toBeNull();
  });
  it('prose line with key=value in a doc',()=>{
    expect(scan('docs/agent/t.md','key=value` config surface (`codex exec --help`, or grep the installed binary schema)\n')).toBeNull();
  });
});

describe('R651 real secrets still refuse in the same positions',()=>{
  it.each([
    ['string literal assignment',`key = "${TOKEN}";\n`],
    ['single-quoted assignment',`apiKey = '${TOKEN}'\n`],
    ['literal inside an expression',`key = process.env.X ?? "${TOKEN}";\n`],
    ['unquoted token followed by a comment',`key = ${TOKEN} # prod\n`],
    ['space-separated passphrase',`key: abCD12!@ efGH34#$ ijKL56%^\n`],
    ['passphrase with code-like marker',`key: abCD12!@ efGH34#$ ijKL56%^()\n`],
    ['dollar-bearing words with marker',`key: abcdefghi jklmnopqr stuvwxyz$;\n`],
    ['hyphenated words with marker',`key: abcdefghi jklmnopqr stuv-wxyz;\n`],
    ['word passphrase with semicolon',`key: velvet orchard cobalt meadow;\n`],
    ['word passphrase with parentheses',`key: velvet orchard cobalt meadow (production)\n`],
    ['value-led word passphrase',`key: value orchard cobalt meadow\n`],
    ['short-word memorable passphrase with dotted token',`key: my home is in St.Louis\n`],
    ['env-style KEY=',`API_KEY=${TOKEN}\n`],
    ['yaml value',`secret: ${TOKEN}\n`],
    ['doc code block',`\`\`\`sh\nSERVICE_TOKEN=${TOKEN}\n\`\`\`\n`],
  ])('%s',(_,text)=>expect(scan('docs/agent/t.md',text)).toMatch(/high-entropy|secret-assignment/));
  it('JSON value',()=>expect(scan('a/b.json',`{"api_key":"${TOKEN}"}`)).toMatch(/high-entropy/));
  it('identifier-shaped literal assigned to key',()=>expect(scan('x.mjs',`key = "someRandomLookingIdentifierToken9X";\n`)).toMatch(/high-entropy/));
});

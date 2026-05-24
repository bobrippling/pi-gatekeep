import { splitCmdline } from './sh.ts';

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let failures = 0;

function check(label: string, result: string[], expected: string[]) {
  const ok = JSON.stringify(result) === JSON.stringify(expected);
  console.log(`${ok ? PASS : FAIL}  ${label}`);
  if (!ok) {
    console.log('  got:      ', JSON.stringify(result));
    console.log('  expected: ', JSON.stringify(expected));
    failures++;
  }
}

// ── The original failing case ─────────────────────────────────────────────────
const pythonHeredoc = [
  "python3 << 'EOF'",
  'import struct',
  '',
  "data = open('/tmp/eg','rb').read()",
  "print(f'hello {data}')",
  'EOF',
  'echo done',
].join('\n');

check("<< 'EOF'  (space before quote, blank line in body)", splitCmdline(pythonHeredoc), ["python3 << 'EOF'", 'echo done']);

// ── Variants that must still work ─────────────────────────────────────────────
check("<<'EOF'  (no space, quoted)",
  splitCmdline("python3 <<'EOF'\nimport struct\nEOF\necho done"),
  ["python3 <<'EOF'", 'echo done']);

check("<< EOF   (space, unquoted)",
  splitCmdline("python3 << EOF\nimport struct\nEOF\necho done"),
  ['python3 << EOF', 'echo done']);

check("<<EOF    (no space, unquoted)",
  splitCmdline("python3 <<EOF\nimport struct\nEOF\necho done"),
  ['python3 <<EOF', 'echo done']);

check("<< 'EOF' with multiple blank lines inside body",
  splitCmdline("python3 << 'EOF'\nimport struct\n\ndata = 1\n\nprint(data)\nEOF\necho done"),
  ["python3 << 'EOF'", 'echo done']);

check("<<- 'EOF' (space after <<-, strip-tabs flag)",
  splitCmdline("cat <<- 'EOF'\n\thello\nEOF\necho done"),
  ["cat <<- 'EOF'", 'echo done']);

check('<< "EOF" (double-quoted, space before)',
  splitCmdline('python3 << "EOF"\nimport struct\nEOF\necho done'),
  ['python3 << "EOF"', 'echo done']);

check('multiple spaces before delimiter',
  splitCmdline("python3 <<   'EOF'\nimport struct\nEOF\necho done"),
  ["python3 <<   'EOF'", 'echo done']);

// ── Edge: tab between << and delimiter ───────────────────────────────────────
check('<< \\t EOF (tab before unquoted)',
  splitCmdline("python3 <<\tEOF\nimport struct\nEOF\necho done"),
  ['python3 <<\tEOF', 'echo done']);

// ── Ensure piped commands still split correctly ───────────────────────────────
check('simple pipe unaffected',
  splitCmdline('echo hello | cat'),
  ['echo hello', 'cat']);

console.log();
if (failures === 0) {
  console.log('All tests passed.');
} else {
  console.log(`${failures} test(s) failed.`);
  process.exit(1);
}

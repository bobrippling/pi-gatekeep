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

check('backslash-newline line continuation',
  splitCmdline('cat | \\\n echo yo'),
  ['cat', 'echo yo']);

// ── Assignment parsing ───────────────────────────────────────────────────────
check('assignment + &&',
  splitCmdline('x=$(command) && y'),
  ['command', 'y']);

check('two assignments',
  splitCmdline('x=$(cmd1) y=$(cmd2)'),
  ['cmd1', 'cmd2']);

check('two assignments + trailing cmd',
  splitCmdline('x=$(cmd1) y=$(cmd2) cmd3'),
  ['cmd1', 'cmd2', 'cmd3']);

check('plain value assignment (no subst)',
  splitCmdline('x=foo && y'),
  ['y']);

check('assignment as env prefix',
  splitCmdline('x=foo cmd arg'),
  ['cmd arg']);

check('plain command unchanged by assignment logic',
  splitCmdline('echo hello'),
  ['echo hello']);

check('piped substitution + &&',
  splitCmdline('a=$(foo | bar) && b'),
  ['foo', 'bar', 'b']);

check('nested substitution',
  splitCmdline('x=$(outer $(inner)) && z'),
  ['outer $(inner)', 'z']);

check('&& inside substitution',
  splitCmdline('x=$(a && b) && c'),
  ['a', 'b', 'c']);

// ── Comment stripping ────────────────────────────────────────────────────────
check('hash in single quotes unchanged',
  splitCmdline("echo '#'"),
  ["echo '#'"]);

check('hash in double quotes unchanged',
  splitCmdline('echo "#not a comment"'),
  ['echo "#not a comment"']);

check('inline comment stripped',
  splitCmdline('echo hello # comment'),
  ['echo hello']);

check('comment ends at newline, next command kept',
  splitCmdline('cmd1 # comment\nother'),
  ['cmd1', 'other']);

console.log();
if (failures === 0) {
  console.log('All tests passed.');
} else {
  console.log(`${failures} test(s) failed.`);
  process.exit(1);
}

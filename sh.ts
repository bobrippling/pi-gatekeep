export function splitCmdline(command: string): string[] {
    const results: string[] = [];
    let current = '';
    let quote: string | null = null;
    let depth = 0;        // nesting depth for ( ) and { }
    let inBacktick = false;

    for (let i = 0; i < command.length; i++) {
        const ch = command[i];

        // --- Inside a quoted string ---
        if (quote) {
            // Backslash escapes the next character inside double quotes.
            if (ch === '\\' && quote === '"' && i + 1 < command.length) {
                current += ch;
                current += command[++i];
                continue;
            }
            current += ch;
            if (ch === quote) quote = null;
            continue;
        }

        // --- Backslash outside quotes: always escapes the next character ---
        if (ch === '\\' && i + 1 < command.length) {
            current += ch;
            current += command[++i];
            continue;
        }

        // --- Start of a quoted string ---
        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }

        // --- Backtick command substitution (toggle) ---
        // Checked before the depth guard so the closing backtick is always recognised.
        if (ch === '`') {
            inBacktick = !inBacktick;
            current += ch;
            continue;
        }

        // --- Inside backtick or nested parens/braces: suppress splitting ---
        if (inBacktick || depth > 0) {
            if (ch === '(' || ch === '{') depth++;
            else if ((ch === ')' || ch === '}') && depth > 0) depth--;
            current += ch;
            continue;
        }

        // --- Nesting openers at depth 0 ---
        if (ch === '(' || ch === '{') {
            depth++;
            current += ch;
            continue;
        }
        // Stray closers (malformed input) - just absorb.
        if (ch === ')' || ch === '}') {
            current += ch;
            continue;
        }

        // --- Two-character operators (checked before single-char) ---
        const two = command.slice(i, i + 2);
        if (two === '||' || two === '&&' || two === '|&') {
            results.push(current.trim());
            current = '';
            i++; // skip second char
            continue;
        }

        // --- '&' background operator ---
        // Not '&&' (caught above), not '&>' or '>&' (redirects).
        if (ch === '&' && command[i + 1] !== '>' && command[i - 1] !== '>') {
            results.push(current.trim());
            current = '';
            continue;
        }

        // --- '|' pipe, but not '>|' (noclobber redirect) ---
        if (ch === '|' && command[i - 1] !== '>') {
            results.push(current.trim());
            current = '';
            continue;
        }

        // --- ';' statement separator and newline ---
        if (ch === ';' || ch === '\n') {
            results.push(current.trim());
            current = '';
            continue;
        }

        current += ch;
    }

    let cmd;
    if (cmd = current.trim()) results.push(cmd);
    return results.filter(Boolean);
}

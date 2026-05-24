export function splitCmdline(command: string): string[] {
    const results: string[] = [];
    let current = '';
    let quote: string | null = null;
    let depth = 0;        // nesting depth for ( ) and { }
    let inBacktick = false;
    // When a heredoc marker (<<) is seen, records the delimiter to match.
    // The body lines are skipped when the trailing \n is processed.
    let pendingHeredoc: { delimiter: string; stripTabs: boolean } | null = null;

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

        // --- Heredoc: <<[-]['"']DELIMITER['"'] (not <<< here-string) ---
        if (ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
            i++;          // skip second '<'
            current += '<<';

            // <<- strips leading tabs from body lines when matching the delimiter
            let stripTabs = false;
            if (command[i + 1] === '-') {
                stripTabs = true;
                i++;
                current += '-';
            }

            // Delimiter may be quoted: <<'EOF'  <<"EOF"
            // Quotes are stripped for matching but kept in current for display.
            let delimQuote: string | null = null;
            if (command[i + 1] === '"' || command[i + 1] === "'") {
                delimQuote = command[i + 1];
                i++;
                current += delimQuote;
            }

            // Read delimiter characters until newline or (unquoted) shell metacharacter
            let delimiter = '';
            while (i + 1 < command.length && command[i + 1] !== '\n') {
                const dc = command[i + 1];
                if (delimQuote && dc === delimQuote) {
                    i++; current += dc;   // consume closing quote
                    break;
                }
                if (!delimQuote && (dc === ' ' || dc === '\t' || dc === ';'
                        || dc === '|' || dc === '&' || dc === '>')) {
                    break;               // end of unquoted delimiter name
                }
                delimiter += dc;
                current += dc;
                i++;
            }

            pendingHeredoc = { delimiter, stripTabs };
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

        // --- ';' statement separator ---
        if (ch === ';') {
            results.push(current.trim());
            current = '';
            continue;
        }

        // --- Newline: split, then skip any pending heredoc body ---
        if (ch === '\n') {
            results.push(current.trim());
            current = '';

            if (pendingHeredoc !== null) {
                const { delimiter, stripTabs } = pendingHeredoc;
                pendingHeredoc = null;

                // Scan forward line-by-line until we find the delimiter alone on a line.
                let j = i + 1;
                while (j <= command.length) {
                    const lineEnd  = command.indexOf('\n', j);
                    const lineEndPos = lineEnd === -1 ? command.length : lineEnd;
                    const line = command.slice(j, lineEndPos);
                    const matchLine = stripTabs ? line.replace(/^\t+/, '') : line;

                    if (matchLine === delimiter) {
                        // Position i at the \n ending the delimiter line (or last char);
                        // the for-loop's i++ will step past it.
                        i = lineEnd === -1 ? command.length - 1 : lineEnd;
                        break;
                    }

                    if (lineEnd === -1) {
                        // Reached end of string without finding delimiter
                        i = command.length - 1;
                        break;
                    }

                    j = lineEnd + 1;
                }
            }
            continue;
        }

        current += ch;
    }

    let cmd;
    if (cmd = current.trim()) results.push(cmd);
    return results.filter(Boolean);
}

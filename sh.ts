/**
 * Parse a segment into leading shell assignments and an optional trailing command.
 * e.g. `FOO=bar BAZ=$(cmd) qux` → { assignmentValues: ['bar', '$(cmd)'], command: 'qux' }
 * Returns null for assignmentValues when the segment has no leading assignments.
 */
function parseSegmentAssignments(
    seg: string,
): { assignmentValues: string[]; command: string | null } | null {
    const assignmentValues: string[] = [];
    let i = 0;

    while (i < seg.length) {
        // Skip spaces between tokens.
        while (i < seg.length && seg[i] === ' ') i++;
        if (i >= seg.length) break;

        // A token is an assignment if it starts with identifier=
        const rest = seg.slice(i);
        const m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=/);
        if (!m) {
            // No more assignments — the rest is a command.
            const command = seg.slice(i);
            if (assignmentValues.length === 0) return null; // nothing to do
            return { assignmentValues, command };
        }

        i += m[0].length; // skip past "NAME="

        // Collect the value string up to the next unquoted, depth-0 space (or end of segment).
        const valueStart = i;
        let quote: string | null = null;
        let depth = 0;
        while (i < seg.length) {
            const ch = seg[i];
            if (quote) {
                if (ch === '\\' && quote === '"') { i += 2; continue; }
                if (ch === quote) { quote = null; }
                i++;
            } else {
                if (ch === '\\') { i += 2; continue; }
                if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
                if (ch === '(' || ch === '{') { depth++; i++; continue; }
                if ((ch === ')' || ch === '}') && depth > 0) { depth--; i++; continue; }
                if (ch === ' ' && depth === 0) break; // end of value token
                i++;
            }
        }
        assignmentValues.push(seg.slice(valueStart, i));
    }

    if (assignmentValues.length === 0) return null;
    return { assignmentValues, command: null };
}

/**
 * Find every `$(...)` command substitution in a value string and
 * recursively return the commands inside it.
 */
function extractSubstitutionCommands(value: string): string[] {
    const results: string[] = [];
    let i = 0;
    let quote: string | null = null;

    while (i < value.length) {
        const ch = value[i];

        if (quote) {
            if (ch === '\\' && quote === '"') { i += 2; continue; }
            if (ch === quote) quote = null;
            i++;
            continue;
        }

        if (ch === '\\') { i += 2; continue; }
        if (ch === '"' || ch === "'") { quote = ch; i++; continue; }

        // Look for $(
        if (ch === '$' && value[i + 1] === '(') {
            let depth = 1;
            let j = i + 2;
            let innerQuote: string | null = null;

            while (j < value.length && depth > 0) {
                const c = value[j];
                if (innerQuote) {
                    if (c === '\\' && innerQuote === '"') { j += 2; continue; }
                    if (c === innerQuote) innerQuote = null;
                } else {
                    if (c === '\\') { j += 2; continue; }
                    if (c === '"' || c === "'") { innerQuote = c; }
                    else if (c === '(') depth++;
                    else if (c === ')') { if (--depth === 0) break; }
                }
                j++;
            }

            const inner = value.slice(i + 2, j);
            results.push(...splitCmdline(inner));
            i = j + 1;
            continue;
        }

        i++;
    }

    return results;
}

/**
 * If the segment is a shell assignment (or chain of assignments), extract any
 * commands embedded in the values via $(...) and preserve any trailing plain
 * command. Otherwise return the segment unchanged.
 */
function processSegment(seg: string): string[] {
    const parsed = parseSegmentAssignments(seg);
    if (!parsed) return [seg]; // no leading assignments — nothing to change

    const { assignmentValues, command } = parsed;
    const results: string[] = [];

    for (const val of assignmentValues) {
        results.push(...extractSubstitutionCommands(val));
    }
    if (command) results.push(command);
    return results;
}

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

            // Skip optional whitespace between << / <<- and the delimiter token.
            // Real bash allows:  << 'EOF'  or  <<'EOF'  interchangeably.
            while (command[i + 1] === ' ' || command[i + 1] === '\t') {
                current += command[i + 1];
                i++;
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

        // --- '#' comment: skip to end of line ---
        if (ch === '#') {
            // Advance past all characters until newline or end of string.
            while (i + 1 < command.length && command[i + 1] !== '\n') i++;
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
    return results.filter(Boolean).flatMap(processSegment);
}

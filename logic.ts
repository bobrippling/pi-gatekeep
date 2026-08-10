const VERBOSE = false;

/// returns [true, ...] if allowed,
/// [false, ...] if disallowed,
/// [null, ...] if unknown
export const commandAllowed = (
    command: string,
    cwd: string,
    patterns: string[],
    allowedCommands: Set<string>
): [true | null, string[]] | [false, string] => {
    const msgs = [];

    if (/^sed -n '?\d+,\d+p'?( [^-]\S+)?$/.test(command)) {
        msgs.push(`\`${command}\` allowed (sed special case)`);

        return [true, msgs];
    }

    if (command.startsWith("find ")) {
        const args = command.split(/[\t ]+/);
        const badPaths = [];
        let seenPath = false;

        for (const arg of args.slice(1)){
            if (arg.startsWith("-")){
                if (seenPath) {
                    // done, onto arguments
                    break;
                }
                // -L, etc - skip over
            } else {
                seenPath = true;
                if (!arg.startsWith(cwd)) {
                    badPaths.push(arg);
                }
            }
        }

        if (command.indexOf("-exec") !== -1 || command.indexOf("-ok") !== -1) {
            msgs.push(`\`${command}\` disallowed, find-special-case found \`-exec/-ok\``);
        } else if (badPaths.length === 0) {
            msgs.push(`\`${command}\` allowed (find special case)`);

            return [true, msgs];
        } else {
            msgs.push(`\`${command}\` disallowed, find-special-case found bad paths:`);
            for (const path of badPaths) {
                msgs.push(`  "${path}"`);
            }
            msgs.push(`(cwd is "${cwd}")`);
        }
    }

    // Negative patterns (! prefix) override all positive matches
    const negPat = patterns
        .filter(p => p.startsWith('!'))
        .find(p => patternMatches(p.slice(1), command));

    if (negPat) {
        return [false, `Blocked by negative pattern: ${negPat}`];
    }

    if (allowedCommands.has(command)) {
        msgs.push(`\`${command}\` allowed`);
        return [true, msgs];
    }

    if (patterns.filter(p => !p.startsWith('!')).some(pat => patternMatches(pat, command))) {
        msgs.push(`\`${command}\` allowed (pattern)`);
        return [true, msgs];
    }

    return [null, msgs];
};

function patternMatches(pat: string, cmd: string): boolean {
    cmd = cmd.replace(/\\\n/g, "").trim();

    if (VERBOSE)
        console.log(`patternMatches(/${pat}/, cmd="${cmd}")`);

    const regex = pat
        .split("*")
        .map((RegExp as any).escape)
        .join(".*");

    if(new RegExp(`^${regex}$`).test(cmd))
        return true;

    // `sort *` matches `sort`
    if(/^[a-zA-Z0-9_]+ \*$/.test(pat)) {
        pat = pat.slice(0, -2);
        return patternMatches(pat, cmd);
    }

    return false;
}

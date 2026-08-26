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

    if (command.startsWith("xargs ") || command === "xargs") {
        const args = command.split(/[\t ]+/).slice(1);
        // skip xargs' own flags (and their arguments for flags that take a value)
        const xargsValueFlags = new Set(["-a", "-d", "-E", "-i", "-I", "-L", "-l", "-n", "-P", "-s", "--arg-file", "--delimiter", "--eof", "--max-args", "--max-lines", "--max-procs", "--max-chars", "--replace"]);
        let i = 0;
        while (i < args.length) {
            if (!args[i].startsWith("-")) break;
            if (xargsValueFlags.has(args[i])) i++; // skip flag's value too
            i++;
        }
        const innerCommand = args.slice(i).join(" ");
        if (innerCommand) {
            msgs.push(`\`${command}\` — delegating to inner command \`${innerCommand}\``);
            const [result, innerMsgs] = commandAllowed(innerCommand, cwd, patterns, allowedCommands);
            if (result !== false)
                return [result, [...msgs, ...innerMsgs]];
            return [result, innerMsgs];
        }
        // else bare xargs, ignore
    }

    if (/^sed -n '?\d+,\d+p'?( [^-]\S+)+$/.test(command)) {
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
                if (arg.includes("../")) {
                    badPaths.push(arg);
                } else if (arg.startsWith(cwd)) {
                    // fine
                } else if (arg.startsWith("./")) {
                    // fine
                } else if (/^[a-zA-Z0-9_]/.test(arg)) {
                    // fine
                } else {
                    badPaths.push(arg);
                }
            }
        }

        if (command.indexOf("-exec") !== -1 || command.indexOf("-ok") !== -1) {
            msgs.push(`\`${command}\` not auto-approved, find-special-case found \`-exec/-ok\``);
        } else if (badPaths.length === 0) {
            msgs.push(`\`${command}\` allowed (find special case)`);

            return [true, msgs];
        } else {
            msgs.push(`\`${command}\` not auto-approved, find-special-case found bad paths:`);
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

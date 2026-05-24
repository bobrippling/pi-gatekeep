import {
    type ExtensionAPI,
    isToolCallEventType,
    type ExtensionContext,
    type EditToolCallEvent,
    type WriteToolCallEvent,
    type BashToolCallEvent,
} from "@earendil-works/pi-coding-agent";

import fs from 'node:fs';
import path from 'node:path';

const STATE_FILE = path.join(import.meta.dirname, 'gatekeep-state.json');
const HOME = process.env.HOME ?? '';
const STATE_FILE_DISPLAY = HOME && STATE_FILE.startsWith(HOME)
    ? '~' + STATE_FILE.slice(HOME.length)
    : STATE_FILE;

interface GatekeepState {
    editsOn: boolean;
    allowedCommands: string[];
    allowedPatterns: string[];
}

export default function (pi: ExtensionAPI) {
    let editsOn = false;
    let allowedCommands = new Set<string>();
    let allowedPatterns = new Set<string>();

    function loadState() {
        try {
            const state: GatekeepState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
            editsOn = state.editsOn ?? false;
            allowedCommands = new Set(state.allowedCommands ?? []);
            allowedPatterns = new Set(state.allowedPatterns ?? []);
        } catch {
            // No state file yet
        }
    }

    function saveState() {
        const state: GatekeepState = {
            editsOn,
            allowedCommands: [...allowedCommands],
            allowedPatterns: [...allowedPatterns],
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    }

    loadState();

    const subcmds = [
        { name: "load",  desc: "Load gatekeep state" },
        { name: "save",  desc: "Save gatekeep state" },
        { name: "reset", desc: "Disable write-all and clear all allowed commands and patterns" },
        { name: "show",  desc: "Show gatekeep state" },
    ];
    pi.registerCommand("gatekeep", {
        description: `/gatekeep ${subcmds.map(c => c.name).join(", ")}`,
        async handler(cmd, ctx) {
            const args = cmd.trim().split(/\s+/);

            if (args.length !== 1) return usage(ctx);

            switch (args[0]) {
                case "load":
                    loadState();
                    ctx.hasUI && ctx.ui.notify(`Gatekeep state loaded <- ${STATE_FILE_DISPLAY}`, "info");
                    break;

                case "save":
                    saveState();
                    ctx.hasUI && ctx.ui.notify(`Gatekeep state saved -> ${STATE_FILE_DISPLAY}`, "info");
                    break;

                case "reset":
                    editsOn = false;
                    allowedCommands.clear();
                    allowedPatterns.clear();
                    ctx.hasUI && ctx.ui.notify("Permissions reset", "info");
                    break;

                case "show": {
                    if (!ctx.hasUI) return;

                    const msg =
                        `Edits on: ${editsOn}\n` +
                        [...allowedCommands].map(c => `Command: ${c}`).join("\n") +
                        [...allowedPatterns].map(p => `Pattern: ${p}`).join("\n");

                    ctx.ui.notify(msg, "info");
                    break;
                }

                default:
                    usage(ctx);
            }
        },
        getArgumentCompletions(prefix) {
            return subcmds
                .filter(c => c.name.startsWith(prefix))
                .map(c => ({
                    value: c.name,
                    label: c.name,
                    description: c.desc,
                }));
        },
    });

    function usage(ctx: ExtensionContext) {
        ctx.hasUI && ctx.ui.notify(`Gatekeep usage: ${subcmds.map(c => c.name).join("/")}`, "error");
    }

    // No automatic saving
    //pi.on("session_shutdown", saveState);
    //pi.on("session_start", loadState);

    pi.on("tool_call", async (event, ctx) => {
        if (isToolCallEventType("bash", event))
            return handleBash(event, ctx);

        if (isToolCallEventType("write", event) || isToolCallEventType("edit", event))
            return handleModify(event, ctx);

        return undefined;
    });

    async function handleModify(event: WriteToolCallEvent | EditToolCallEvent, ctx: ExtensionContext) {
        if (!ctx.hasUI) {
            return undefined; // allow
        }

        if(editsOn) return undefined;

        const { path } = event.input;
        const choice = await ctx.ui.select(`⚠️ Writing ${path}\n\nAllow?`, ["Yes", "No", "All paths"]);

        switch (choice) {
            case "No":
                default:
                return blocked();

            case "All paths":
                editsOn = true;
                // fallthrough
            case "Yes":
                break;
        }
    }

    async function handleBash(event: BashToolCallEvent, ctx: ExtensionContext) {
        if (!ctx.hasUI)
            return { block: true, reason: "Command blocked (no UI for confirmation)" };

        const { command } = event.input;
        const subcommands = splitSubcommands(command);

        const msgs = [];

        for (const subcommand of subcommands) {
            let ok = false;

            while (1) {
                if (allowedCommands.has(subcommand)) {
                    ok = true;
                    msgs.push(`\`${subcommand}\` allowed`);
                    break;
                }
                if ([...allowedPatterns].some(pat => patternMatches(pat, subcommand))) {
                    ok = true;
                    msgs.push(`\`${subcommand}\` allowed (pattern)`);
                    break;
                }

                const Custom = "Customise...";
                const choice = await ctx.ui.select(`⚠️ Command:\n\n${subcommand}\n\nAllow?`, ["Yes", "No", Custom]);
                if (choice === Custom) {
                    const pat = await ctx.ui.input("Command pattern", subcommand);

                    if (pat) {
                        allowedPatterns.add(pat);
                        continue; // retry
                    }

                } else if (choice === "Yes") {
                    ok = true;
                }

                break;
            }

            if (!ok) return blocked();
        }

        ctx.ui.notify(msgs.join("\n"), "info");
    }

    function splitSubcommands(command: string): string[] {
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

    function patternMatches(pat: string, cmd: string): boolean {
        const regex = pat
            .split("*")
            .map((RegExp as any).escape)
            .join(".*");

        return new RegExp(`^${regex}$`).test(cmd);
    }

    function blocked() {
        return { block: true, reason: "Blocked by user" };
    }
}

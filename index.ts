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
import { splitCmdline } from './sh.ts';

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
    const sessionCommands = new Set<string>();
    const sessionPatterns = new Set<string>();

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
        { name: "reset-session", desc: "Clear session-only commands and patterns" },
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

                case "reset-session":
                    sessionCommands.clear();
                    sessionPatterns.clear();
                    ctx.hasUI && ctx.ui.notify("Session permissions reset", "info");
                    break;

                case "reset":
                    editsOn = false;
                    allowedCommands.clear();
                    allowedPatterns.clear();
                    sessionCommands.clear();
                    sessionPatterns.clear();
                    ctx.hasUI && ctx.ui.notify("Permissions reset (not saving until shutdown or explicit command)", "info");
                    break;

                case "show": {
                    if (!ctx.hasUI) return;

                    const lines = [`Edits on: ${editsOn}`];
                    for (const c of allowedCommands) lines.push(`Command: ${c}`);
                    for (const p of allowedPatterns) lines.push(`Pattern: ${p}`);

                    if(sessionCommands || sessionPatterns) lines.push("Session:");
                    for (const c of sessionCommands) lines.push(`  Command: ${c}`);
                    for (const p of sessionPatterns) lines.push(`  Pattern: ${p}`);

                    const msg = lines.join("\n");
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

    pi.on("session_shutdown", saveState);
    pi.on("session_start", loadState);

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
        bel();
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
        const subcommands = splitCmdline(command);

        const msgs = [];

        for (const subcommand of subcommands) {
            let ok = false;

            while (1) {
                const allPatterns = [...allowedPatterns, ...sessionPatterns];

                // Negative patterns (! prefix) override all positive matches
                const negPat = allPatterns
                    .filter(p => p.startsWith('!'))
                    .find(p => patternMatches(p.slice(1), subcommand));
                if (negPat)
                    return { block: true, reason: `Blocked by negative pattern: ${negPat}` };

                if (allowedCommands.has(subcommand) || sessionCommands.has(subcommand)) {
                    ok = true;
                    msgs.push(`\`${subcommand}\` allowed`);
                    break;
                }
                if (allPatterns.filter(p => !p.startsWith('!')).some(pat => patternMatches(pat, subcommand))) {
                    ok = true;
                    msgs.push(`\`${subcommand}\` allowed (pattern)`);
                    break;
                }

                const YesSession  = "Yes (session)";
                const YesAlways   = "Yes (always)";
                const CustSession = "Customise (session)...";
                const CustAlways  = "Customise (always)...";

                bel();
                const choice = await ctx.ui.select(
                    `⚠️ Command:\n\n${subcommand}\n\nAllow?`,
                    [YesSession, YesAlways, "No", CustSession, CustAlways],
                );

                switch (choice) {
                    case CustSession:
                    case CustAlways: {
                        bel();
                        const pat = await ctx.ui.input("Pattern (prefix ! to deny)", subcommand);
                        if (pat) {
                            if (choice === CustSession) {
                                sessionPatterns.add(pat);
                            } else {
                                allowedPatterns.add(pat);
                                saveState();
                            }
                            continue; // retry
                        }
                    }
                    case YesSession:
                        sessionCommands.add(subcommand);
                        ok = true;
                        break;
                    case YesAlways:
                        allowedCommands.add(subcommand);
                        saveState();
                        ok = true;
                        break;
                }

                break;
            }

            if (!ok) return blocked();
        }

        ctx.ui.notify(msgs.join("\n"), "info");
    }

    function patternMatches(pat: string, cmd: string): boolean {
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

    function bel() {
        process.stdout.write("\x07");
    }

    function blocked() {
        return { block: true, reason: "Blocked by user" };
    }
}

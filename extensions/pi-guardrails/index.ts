/**
 * Guardrails extension
 *
 * Session-local Mode switcher for tool-layer guardrails.
 *
 * Primary editable config lives next to this package:
 *   ~/.pi/agent/extensions/pi-guardrails/guardrails.config.json
 *
 * Optional overrides can also be placed in global/project settings.json under
 * the same top-level `guardrails` key.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolCallEvent } from "@earendil-works/pi-coding-agent";

type Mode = "PLAN" | "HITL" | "AFK";

type GuardrailsConfig = {
  defaultMode: Mode;
  shortcut: string;
  allowUnsafeProjectOverrides: boolean;
  plan: { allowedBashPatterns: string[] };
  hitl: { dangerousBashPatterns: string[] };
  afk: { blockedBashPatterns: string[] };
};

const EXTENSION_DIR = __dirname;
const MODES: Mode[] = ["PLAN", "HITL", "AFK"];
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "pi_scout", "subagent"]);
const PROCESS_STATE_KEY = "__piGuardrailsModeState";

type ProcessState = { mode?: Mode };

function processState(): ProcessState {
  const root = globalThis as typeof globalThis & Record<string, ProcessState | undefined>;
  return (root[PROCESS_STATE_KEY] ??= {});
}

const DEFAULT_PLAN_ALLOWED = [
  String.raw`^\s*pwd\s*$`,
  String.raw`^\s*ls(\s|$)`,
  String.raw`^\s*find\s+`,
  String.raw`^\s*rg(\s|$)`,
  String.raw`^\s*grep(\s|$)`,
  String.raw`^\s*git\s+(status|diff|log|show|branch|remote|rev-parse|ls-files)(\s|$)`,
  String.raw`^\s*(wc|head|tail|file|du|df|which)(\s|$)`,
  String.raw`^\s*([\w.-]+\s+)?(node|npm|pnpm|yarn|bun|deno|python3?|pip3?|ruby|go|rustc|cargo|java|javac|mvn|gradle|gcc|g\+\+|clang|make|cmake)\s+(--?v(ersion)?|-V)\s*$`,
];
const DEFAULT_HITL_DANGEROUS = [
  String.raw`\brm\s+(-[\w-]*[rf][\w-]*|--recursive|--force)`,
  String.raw`\bsudo\b`,
  String.raw`\b(chmod|chown)\s+(-R\s+)?`,
  String.raw`\b(curl|wget)\b.*\|\s*(sh|bash|zsh|fish)\b`,
  String.raw`\b(dd|mkfs|diskutil|mount|umount)\b`,
  String.raw`\b(npm|pnpm|yarn|bun)\s+(publish|add|install|remove|update)\b`,
  String.raw`\b(git\s+push|git\s+reset\s+--hard|git\s+clean\s+-)\b`,
];
const SAFETY_FLOOR = [
  String.raw`\brm\s+-[\w-]*rf[\w-]*\s+(/|~|\$HOME)(\s|$)`,
  String.raw`\bdd\s+.*\bof=/dev/(disk|rdisk|sd|hd)`,
  String.raw`\bmkfs(\.|\s)`,
  String.raw`\b(:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:)`,
  String.raw`\b(shutdown|reboot|halt)\b`,
  String.raw`\bchmod\s+-R\s+777\s+(/|~|\$HOME)(\s|$)`,
  String.raw`\bchown\s+-R\s+[^\s]+\s+(/|~|\$HOME)(\s|$)`,
];

function warn(message: string) {
  console.warn(`[guardrails] ${message}`);
}

function parseMode(value: unknown): Mode | undefined {
  if (typeof value !== "string") return undefined;
  const upper = value.toUpperCase();
  return MODES.includes(upper as Mode) ? (upper as Mode) : undefined;
}

function readJson(path: string): any {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error: any) {
    warn(`Invalid JSON in ${path}: ${error?.message ?? error}`);
    return undefined;
  }
}

function pickStrings(value: unknown, fallback: string[], label: string): string[] {
  if (value === undefined) return fallback;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
  warn(`Invalid ${label}; using fallback`);
  return fallback;
}

function mergeConfig(base: GuardrailsConfig, raw: any, source: string): GuardrailsConfig {
  const g = raw?.guardrails;
  if (g === undefined) return base;
  if (!g || typeof g !== "object" || Array.isArray(g)) {
    warn(`Invalid guardrails config in ${source}; ignoring`);
    return base;
  }
  return {
    defaultMode: parseMode(g.defaultMode) ?? base.defaultMode,
    shortcut: typeof g.shortcut === "string" && g.shortcut ? g.shortcut : base.shortcut,
    allowUnsafeProjectOverrides: typeof g.allowUnsafeProjectOverrides === "boolean" ? g.allowUnsafeProjectOverrides : base.allowUnsafeProjectOverrides,
    plan: {
      allowedBashPatterns: pickStrings(g.plan?.allowedBashPatterns, base.plan.allowedBashPatterns, `${source}: guardrails.plan.allowedBashPatterns`),
    },
    hitl: {
      dangerousBashPatterns: pickStrings(g.hitl?.dangerousBashPatterns, base.hitl.dangerousBashPatterns, `${source}: guardrails.hitl.dangerousBashPatterns`),
    },
    afk: {
      blockedBashPatterns: pickStrings(g.afk?.blockedBashPatterns, base.afk.blockedBashPatterns, `${source}: guardrails.afk.blockedBashPatterns`),
    },
  };
}

function loadConfig(cwd: string): GuardrailsConfig {
  let cfg: GuardrailsConfig = {
    defaultMode: "PLAN",
    shortcut: "ctrl+shift+m",
    allowUnsafeProjectOverrides: false,
    plan: { allowedBashPatterns: DEFAULT_PLAN_ALLOWED },
    hitl: { dangerousBashPatterns: DEFAULT_HITL_DANGEROUS },
    afk: { blockedBashPatterns: SAFETY_FLOOR },
  };
  const sidecarPath = join(EXTENSION_DIR, "guardrails.config.json");
  cfg = mergeConfig(cfg, readJson(sidecarPath), sidecarPath);
  const legacySidecarPath = join(getAgentDir(), "extensions", "guardrails.config.json");
  cfg = mergeConfig(cfg, readJson(legacySidecarPath), legacySidecarPath);
  const globalPath = join(getAgentDir(), "settings.json");
  cfg = mergeConfig(cfg, readJson(globalPath), globalPath);
  const globalAllowsUnsafe = cfg.allowUnsafeProjectOverrides;
  const projectPath = join(cwd, ".pi", "settings.json");
  cfg = mergeConfig(cfg, readJson(projectPath), projectPath);
  if (!globalAllowsUnsafe) {
    cfg.allowUnsafeProjectOverrides = false;
    cfg.hitl.dangerousBashPatterns = [...cfg.hitl.dangerousBashPatterns, ...SAFETY_FLOOR];
    cfg.afk.blockedBashPatterns = [...cfg.afk.blockedBashPatterns, ...SAFETY_FLOOR];
  }
  return cfg;
}

function compilePatterns(patterns: string[], label: string): RegExp[] {
  const out: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      out.push(new RegExp(pattern, "i"));
    } catch (error: any) {
      warn(`Invalid regex in ${label} skipped: ${pattern} (${error?.message ?? error})`);
    }
  }
  return out;
}

function commandFrom(event: ToolCallEvent): string {
  const input = event.input as Record<string, unknown>;
  return typeof input.command === "string" ? input.command : "";
}

function normalizeShortcut(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => {
      const normalized = part.trim().toLowerCase();
      if (normalized === "option") return "alt";
      if (normalized === "cmd" || normalized === "command" || normalized === "meta") return "super";
      return normalized;
    })
    .filter(Boolean)
    .join("+");
}

async function confirm(ctx: ExtensionContext, title: string, message: string): Promise<boolean> {
  if (!ctx.hasUI) return false;
  try {
    return (await ctx.ui.confirm(title, message)) === true;
  } catch {
    return false;
  }
}

export default function(pi: ExtensionAPI) {
  pi.registerFlag("guardrails", { type: "string", description: "Initial guardrails Mode: PLAN, HITL, or AFK" });

  let config: GuardrailsConfig | undefined = loadConfig(process.cwd());
  let mode: Mode = parseMode(process.env.PI_GUARDRAILS) ?? parseMode(pi.getFlag("guardrails")) ?? config.defaultMode ?? "PLAN";
  let planAllowed: RegExp[] = [];
  let hitlDangerous: RegExp[] = [];
  let afkBlocked: RegExp[] = [];

  function refreshCompiled() {
    if (!config) return;
    planAllowed = compilePatterns(config.plan.allowedBashPatterns, "guardrails.plan.allowedBashPatterns");
    hitlDangerous = compilePatterns(config.hitl.dangerousBashPatterns, "guardrails.hitl.dangerousBashPatterns");
    afkBlocked = compilePatterns(config.afk.blockedBashPatterns, "guardrails.afk.blockedBashPatterns");
  }

  function setStatus(ctx?: ExtensionContext) {
    if (!ctx) return;
    // Use explicit ANSI colors instead of theme success/warning/error because
    // some themes render success too close to yellow.
    const color = mode === "PLAN" ? "\x1b[92m" : mode === "HITL" ? "\x1b[93m" : "\x1b[91m";
    ctx.ui.setStatus("guardrails", `${color}Mode: ${mode}\x1b[0m`);
  }

  async function setMode(next: Mode, ctx?: ExtensionContext, notify = true) {
    if (next === mode) {
      processState().mode = mode;
      setStatus(ctx);
      return;
    }
    mode = next;
    processState().mode = mode;
    setStatus(ctx);
    if (notify) ctx?.ui.notify(`Mode: ${mode}`, "info");
  }

  pi.on("session_start", (event, ctx) => {
    config = loadConfig(ctx.cwd);
    refreshCompiled();
    const rawEnvMode = process.env.PI_GUARDRAILS;
    const envMode = parseMode(rawEnvMode);
    if (typeof rawEnvMode === "string" && rawEnvMode && !envMode) {
      warn(`Invalid PI_GUARDRAILS value: ${rawEnvMode}; using configured/default Mode`);
      ctx.ui.notify(`Invalid PI_GUARDRAILS value: ${rawEnvMode}; using Mode: ${config.defaultMode}`, "warning");
    }
    const rawFlagMode = pi.getFlag("guardrails");
    const flagMode = parseMode(rawFlagMode);
    if (typeof rawFlagMode === "string" && rawFlagMode && !flagMode) {
      warn(`Invalid --guardrails value: ${rawFlagMode}; using configured/default Mode`);
      ctx.ui.notify(`Invalid --guardrails value: ${rawFlagMode}; using Mode: ${config.defaultMode}`, "warning");
    }
    if (event.reason === "startup") {
      mode = envMode ?? flagMode ?? config.defaultMode ?? "PLAN";
    } else {
      // /new, /resume, /fork, and /reload rebuild the extension runtime inside
      // the same Pi process. Preserve the user's current Mode across those
      // session replacements; only a fresh Pi startup resets to the default.
      mode = processState().mode ?? envMode ?? flagMode ?? config.defaultMode ?? "PLAN";
    }
    processState().mode = mode;
    setStatus(ctx);
    if (event.reason === "startup") ctx.ui.notify(`Mode: ${mode}`, "info");
  });

  pi.on("session_shutdown", () => {
    processState().mode = mode;
  });

  const shortcut = normalizeShortcut(config.shortcut);
  if (shortcut !== config.shortcut.toLowerCase()) warn(`Normalized shortcut '${config.shortcut}' to '${shortcut}'`);

  pi.registerShortcut(shortcut as any, {
    description: "Cycle Mode (PLAN → HITL → AFK)",
    handler: async (ctx) => {
      if (!config) {
        config = loadConfig(ctx.cwd);
        refreshCompiled();
      }
      const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      await setMode(next, ctx);
    },
  });


  pi.registerCommand("mode", {
    description: "Show or set Mode (PLAN, HITL, AFK)",
    getArgumentCompletions: (prefix) => {
      const normalizedPrefix = typeof prefix === "string" ? prefix.toUpperCase() : "";
      return MODES.filter((m) => m.startsWith(normalizedPrefix)).map((m) => ({ value: m.toLowerCase(), label: m }));
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(`Mode: ${mode}\nAvailable: ${MODES.join(", ")}`, "info");
        setStatus(ctx);
        return;
      }
      const next = parseMode(trimmed.split(/\s+/)[0]);
      if (!next) {
        ctx.ui.notify(`Invalid Mode: ${trimmed}\nAvailable: ${MODES.join(", ")}`, "warning");
        return;
      }
      await setMode(next, ctx);
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    const tool = event.toolName;
    const command = tool === "bash" ? commandFrom(event) : "";
    const matches = (patterns: RegExp[]) => patterns.some((re) => re.test(command));

    if (mode === "PLAN") {
      if (READ_ONLY_TOOLS.has(tool)) return;
      if (tool === "bash" && matches(planAllowed)) return;
      const ok = await confirm(ctx, "Mode: PLAN", `Allow one ${tool} call?${command ? `\n\n${command}` : ""}`);
      return ok ? undefined : { block: true, reason: "Blocked by PLAN Mode" };
    }

    if (tool === "bash" && mode === "HITL" && matches(hitlDangerous)) {
      const ok = await confirm(ctx, "Mode: HITL", `Potentially dangerous bash command. Allow?\n\n${command}`);
      return ok ? undefined : { block: true, reason: "Blocked by HITL Mode" };
    }

    if (tool === "bash" && mode === "AFK" && matches(afkBlocked)) {
      return { block: true, reason: "Blocked by AFK catastrophic safety floor" };
    }
  });
}

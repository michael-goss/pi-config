import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface PiSubagentSettings {
  defaultModel?: string;
  models?: Record<string, string>;
  defaultThinking?: ThinkingLevel;
  thinking?: Record<string, ThinkingLevel>;
  includeContextFiles?: boolean;
  maxToolCalls?: number;
  saveArtifacts?: boolean;
  outputDir?: string;
  outputFilePrefix?: string;
}

const BASE_SYSTEM_PROMPT = `You are a fresh-context subagent launched by a parent Pi coding agent.

Complete only the delegated task. Do not answer the original user directly.
You do not have access to the parent conversation unless it is explicitly included in the prompt.
Use only the provided task/context and your own tool observations.
Return your result to the parent agent in the requested format.

The parent agent remains responsible for synthesis, decisions, code changes, and the final answer.`;

const TOGGLE_HINT = "Ctrl+O toggles details.";

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function loadSettings(cwd: string): PiSubagentSettings {
  const global = readJson(path.join(getAgentDir(), "settings.json"))?.piSubagent ?? {};
  const project = readJson(path.join(cwd, ".pi", "settings.json"))?.piSubagent ?? {};
  return { ...global, ...project, models: { ...(global.models ?? {}), ...(project.models ?? {}) }, thinking: { ...(global.thinking ?? {}), ...(project.thinking ?? {}) } };
}

function resolvePath(cwd: string, p?: string): string {
  const value = p || path.join(os.tmpdir(), "pi-subagent-runs");
  if (value.startsWith("~")) return path.join(os.homedir(), value.slice(1));
  return path.isAbsolute(value) ? value : path.join(cwd, value);
}

function safeSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "subagent";
}

function shortSummary(text: string, max = 80): string {
  const summary = text.replace(/\s+/g, " ").trim();
  return summary.length > max ? `${summary.slice(0, max - 3)}...` : summary;
}

function formatTokens(input: number, output: number): string {
  return `tokens in/out: ${input.toLocaleString()}/${output.toLocaleString()}`;
}

function messageUsage(message: any): { input: number; output: number } | undefined {
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  return {
    input: Number(usage.input || 0) + Number(usage.cacheRead || 0) + Number(usage.cacheWrite || 0),
    output: Number(usage.output || 0),
  };
}

function summarizeToolArgs(toolName: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  const pick = (...keys: string[]) => keys.map((key) => args[key]).find((value) => typeof value === "string" && value.trim().length > 0);
  let summary = "";
  if (toolName === "read") summary = pick("path", "file") || "";
  else if (toolName === "bash") summary = pick("command") || "";
  else if (toolName === "grep") summary = [pick("pattern") && `pattern=${JSON.stringify(pick("pattern"))}`, pick("path", "glob")].filter(Boolean).join(" ");
  else if (toolName === "find") summary = [pick("pattern") && `pattern=${JSON.stringify(pick("pattern"))}`, pick("path")].filter(Boolean).join(" ");
  else if (toolName === "ls") summary = pick("path") || ".";
  else summary = Object.entries(args).slice(0, 3).map(([key, value]) => `${key}=${typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value)}`).join(" ");
  summary = summary.replace(/\s+/g, " ").trim();
  return summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
}

function compilePrompt(params: any): string {
  if (typeof params.prompt === "string" && params.prompt.trim()) return params.prompt;
  const parts: string[] = [];
  if (params.role) parts.push(`Role:\n${params.role}`);
  parts.push(`Task:\n${params.task}`);
  if (params.context) parts.push(`Context:\n${params.context}`);
  if (Array.isArray(params.constraints) && params.constraints.length) parts.push(`Constraints:\n${params.constraints.map((c: string) => `- ${c}`).join("\n")}`);
  if (params.outputFormat) parts.push(`Output format:\n${params.outputFormat}`);
  return parts.join("\n\n");
}

function systemPrompt(suffix?: string): string {
  const trimmed = suffix?.trim();
  return trimmed ? `${BASE_SYSTEM_PROMPT}\n\nAdditional system instructions:\n${trimmed}` : BASE_SYSTEM_PROMPT;
}

function resolveModelName(settings: PiSubagentSettings, requested?: string): { name?: string; alias?: string } {
  const key = requested || settings.defaultModel;
  if (!key) return {};
  const aliased = settings.models?.[key];
  return aliased ? { name: aliased, alias: key } : { name: key };
}

function findModel(modelRegistry: any, modelName?: string): any | undefined {
  if (!modelName) return undefined;
  const [provider, ...rest] = modelName.split("/");
  if (!provider || rest.length === 0) return undefined;
  return modelRegistry.find(provider, rest.join("/"));
}

function resolveThinking(settings: PiSubagentSettings, params: any, modelAlias?: string, parent?: ThinkingLevel): ThinkingLevel | undefined {
  if (params.thinking) return params.thinking;
  if (modelAlias && settings.thinking?.[modelAlias]) return settings.thinking[modelAlias];
  if (settings.defaultThinking) return settings.defaultThinking;
  return parent;
}

export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Spawn a fresh-context subagent for a delegated task. The parent remains responsible for synthesis and final answer.",
    promptSnippet: "Spawn a fresh-context subagent for an explicitly delegated task when context isolation helps.",
    promptGuidelines: [
      "Pass all relevant context explicitly; subagents do not inherit the parent conversation.",
      "Keep delegated tasks bounded with a clear expected output.",
      "The parent remains responsible for synthesis and final answer.",
    ],
    executionMode: "parallel",
    parameters: Type.Object({
      name: Type.String({ description: "Short subagent name or role label, e.g. security-reviewer." }),
      task: Type.String({ description: "Required task summary for the subagent and UI." }),
      prompt: Type.Optional(Type.String({ description: "Optional full delegated prompt. If provided, overrides structured prompt fields except task metadata." })),
      role: Type.Optional(Type.String({ description: "Optional role/persona instructions compiled into the delegated prompt." })),
      context: Type.Optional(Type.String({ description: "Explicit context to provide to the fresh-context subagent." })),
      constraints: Type.Optional(Type.Array(Type.String(), { description: "Optional constraints compiled into the delegated prompt." })),
      outputFormat: Type.Optional(Type.String({ description: "Optional requested output format." })),
      systemPromptSuffix: Type.Optional(Type.String({ description: "Optional additional system-level instructions appended after the fixed base subagent contract." })),
      model: Type.Optional(Type.String({ description: "Model alias from piSubagent.models or provider/model string." })),
      thinking: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh")], { description: "Optional per-call thinking level override." })),
      saveArtifact: Type.Optional(Type.Boolean({ description: "Override whether to save the subagent output to disk." })),
      outputDir: Type.Optional(Type.String({ description: "Override artifact directory. Relative paths resolve against cwd." })),
    }),
    renderCall(_args, _theme, _context) {
      return new Text("", 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, _context) {
      const details = result.details as any;
      const name = details?.name ? ` ${details.name}` : "";
      const status = isPartial ? "running" : details?.status === "failed" ? "failed" : "completed";
      const tokens = details?.tokens ? formatTokens(Number(details.tokens.input || 0), Number(details.tokens.output || 0)) : "";
      const toolCount = typeof details?.toolCount === "number" ? `${details.toolCount} tool use${details.toolCount === 1 ? "" : "s"}` : "";
      const summary = [toolCount, tokens].filter(Boolean).join(", ");
      const title = `${theme.fg("toolTitle", theme.bold(`Subagent${name} ${status}`))}${details?.taskSummary ? theme.fg("muted", ` — ${details.taskSummary}`) : ""}${summary ? theme.fg("dim", ` (${summary})`) : ""}`;
      const content = result.content?.[0];
      const body = content?.type === "text" ? content.text : "";
      const timeline = Array.isArray(details?.toolTimeline) ? details.toolTimeline.join("\n") : "";
      const shortcutHint = theme.fg("dim", TOGGLE_HINT);
      if (!expanded) {
        if (isPartial && timeline) return new Text(`${title}\n${theme.fg("muted", timeline)}\n${shortcutHint}`, 0, 0);
        return new Text(`${title}\n${shortcutHint}`, 0, 0);
      }
      const expandedBody = isPartial ? (timeline || body) : body;
      return new Text(expandedBody ? `${title}\n${theme.fg(isPartial ? "muted" : "dim", expandedBody)}\n${shortcutHint}` : `${title}\n${shortcutHint}`, 0, 0);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const settings = loadSettings(ctx.cwd);
      const maxToolCalls = settings.maxToolCalls ?? 100;
      const saveArtifact = params.saveArtifact ?? settings.saveArtifacts ?? false;
      const outputDir = resolvePath(ctx.cwd, params.outputDir || settings.outputDir || ".pi/subagent-runs");
      const outputPath = path.join(outputDir, `${settings.outputFilePrefix || "subagent"}-${Date.now()}-${safeSlug(params.name)}-${safeSlug(params.task)}.md`);

      const authStorage = AuthStorage.create();
      const modelRegistry = ModelRegistry.create(authStorage);
      const modelRef = resolveModelName(settings, params.model);
      const selectedModel = findModel(modelRegistry, modelRef.name) || ctx.model;
      const thinking = resolveThinking(settings, params, modelRef.alias, (ctx as any).getThinkingLevel?.());

      const loader = new DefaultResourceLoader({
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        noExtensions: false,
        noSkills: true,
        noPromptTemplates: true,
        noContextFiles: !(settings.includeContextFiles ?? false),
        systemPromptOverride: () => systemPrompt(params.systemPromptSuffix),
        appendSystemPromptOverride: () => [],
        extensionsOverride(base) {
          for (const ext of base.extensions) ext.tools.delete("subagent");
          return base;
        },
      });
      await loader.reload();

      const { session } = await createAgentSession({
        cwd: ctx.cwd,
        model: selectedModel,
        thinkingLevel: thinking,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(ctx.cwd),
        authStorage,
        modelRegistry,
      });

      let assistantText = "";
      const taskSummary = shortSummary(params.task);
      const toolTimeline: string[] = [];
      let tokenInput = 0;
      let tokenOutput = 0;
      let budgetAbort = false;
      let failed: string | undefined;

      const emitUpdate = () => {
        if (!onUpdate) return;
        const activity = toolTimeline.length > 0 ? toolTimeline.join("\n") : "Starting subagent...";
        onUpdate({
          content: [{ type: "text", text: `# Subagent: ${params.name}\n\n${activity}` }],
          details: { name: params.name, taskSummary, toolTimeline, toolCount: toolTimeline.length, tokens: { input: tokenInput, output: tokenOutput }, status: "running" },
        });
      };
      emitUpdate();

      const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") assistantText += event.assistantMessageEvent.delta;
        if (event.type === "message_end") {
          const usage = messageUsage(event.message);
          if (usage) {
            tokenInput += usage.input;
            tokenOutput += usage.output;
            emitUpdate();
          }
        }
        if (event.type === "tool_execution_start") {
          const n = toolTimeline.length + 1;
          const summary = summarizeToolArgs(event.toolName, event.args);
          toolTimeline.push(`${n}. ${event.toolName}${summary ? ` — ${summary}` : ""}`);
          emitUpdate();
          if (n >= maxToolCalls && !budgetAbort) {
            budgetAbort = true;
            session.abort();
          }
        }
      });

      try {
        if (signal?.aborted) throw new Error("subagent aborted before start");
        const abort = () => void session.abort();
        signal?.addEventListener("abort", abort, { once: true });
        try {
          await session.prompt(compilePrompt(params), { source: "extension" });
        } catch (error: any) {
          if (!budgetAbort) {
            failed = error?.message ?? String(error);
          }
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      } finally {
        unsubscribe();
        session.dispose();
      }

      if (budgetAbort) failed = `Stopped after reaching configured maxToolCalls budget (${maxToolCalls}).`;
      const status = failed ? "failed" : "completed";
      const body = assistantText.trim() || (failed ? "" : "Subagent completed without text output.");
      const text = failed
        ? `# Subagent: ${params.name}\n\nSUBAGENT_FAILED: ${params.name}\nReason: ${failed}${body ? `\n\nPartial output:\n\n${body}` : ""}`
        : `# Subagent: ${params.name}\n\n${body}`;

      if (saveArtifact) {
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(outputPath, text + "\n", "utf8");
      }

      return {
        content: [{ type: "text", text }],
        details: {
          name: params.name,
          taskSummary,
          status,
          error: failed,
          model: selectedModel ? `${(selectedModel as any).provider ?? ""}/${(selectedModel as any).id ?? (selectedModel as any).name ?? ""}`.replace(/^\//, "") : undefined,
          requestedModel: params.model,
          thinking,
          artifactPath: saveArtifact ? outputPath : undefined,
          toolTimeline,
          toolCount: toolTimeline.length,
          tokens: { input: tokenInput, output: tokenOutput },
        },
      };
    },
  });
}

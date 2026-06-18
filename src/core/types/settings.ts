export type HiddenProviderCommands = Record<string, string[]>;

export interface ApprovalSelectionDecision {
  type: 'select-option';
  value: string;
}

/** User decision from the approval modal. */
export type ApprovalDecision =
  | 'allow'
  | 'allow-always'
  | 'deny'
  | 'cancel'
  | ApprovalSelectionDecision;

/** Saved environment variable configuration. */
export interface EnvSnippet {
  id: string;
  name: string;
  description: string;
  envVars: string;
  scope?: EnvironmentScope;
  contextLimits?: Record<string, number>;  // Optional: context limits for custom models
  modelAliases?: Record<string, string>;   // Optional: display aliases for custom models
}

/** Source of a slash command. */
export type SlashCommandSource = 'builtin' | 'user' | 'plugin' | 'sdk';

/** Slash command configuration shared by the UI, storage, and runtime boundary. */
export interface SlashCommand {
  id: string;
  name: string;                // Command name used after / (e.g., "review-code")
  description?: string;        // Optional description shown in dropdown
  argumentHint?: string;       // Placeholder text for arguments (e.g., "[file] [focus]")
  allowedTools?: string[];     // Restrict tools when command is used
  model?: string;              // Optional provider-specific model override
  content: string;             // Prompt template with placeholders
  source?: SlashCommandSource; // Origin of the command (builtin, user, plugin, sdk)
  kind?: 'command' | 'skill';  // Explicit type — replaces id-prefix heuristic
  // Provider-owned command metadata that the UI preserves and round-trips.
  disableModelInvocation?: boolean;  // Disable model invocation for this skill
  userInvocable?: boolean;           // Whether user can invoke this skill directly
  context?: 'fork';                  // Subagent execution mode
  agent?: string;                    // Subagent type when context='fork'
  hooks?: Record<string, unknown>;   // Pass-through to SDK
}

/** Keyboard navigation settings for vim-style scrolling. */
export interface KeyboardNavigationSettings {
  scrollUpKey: string;         // Key to scroll up when focused on messages (default: 'w')
  scrollDownKey: string;       // Key to scroll down when focused on messages (default: 's')
  focusInputKey: string;       // Key to focus input (default: 'i', like vim insert mode)
}

/** Tab bar position setting. */
export type TabBarPosition = 'input' | 'header';

export const CHAT_VIEW_PLACEMENTS = [
  'right-sidebar',
  'left-sidebar',
  'main-tab',
] as const;

/** Workspace location used when opening the Claudian chat view. */
export type ChatViewPlacement = typeof CHAT_VIEW_PLACEMENTS[number];

/** Result from instruction refinement agent query. */
export interface InstructionRefineResult {
  success: boolean;
  refinedInstruction?: string;  // The refined instruction text
  clarification?: string;       // Agent's clarifying question (if any)
  error?: string;               // Error message (if failed)
}

/** Permission mode for tool execution. */
export type PermissionMode = 'yolo' | 'plan' | 'normal';

/** Scope for environment variable storage and snippets. */
export type EnvironmentScope = 'shared' | `provider:${string}`;

/** Opaque device-keyed CLI paths for per-device configuration. */
export type HostnameCliPaths = Record<string, string>;

/** Opaque provider-owned settings bags keyed by provider id. */
export type ProviderConfigMap = Partial<Record<string, Record<string, unknown>>>;

/**
 * Application settings stored in .claudian/claudian-settings.json.
 *
 * Provider-specific fields (model, thinkingBudget, effortLevel, serviceTier, etc.) use
 * `string` here.  The active provider casts internally when it needs
 * narrower types.
 */
export interface ClaudianSettings {
  // User preferences
  userName: string;

  // Security
  permissionMode: PermissionMode;

  // Model & thinking (provider interprets values)
  model: string;
  thinkingBudget: string;
  effortLevel: string;
  serviceTier: string;
  enableAutoTitleGeneration: boolean;
  titleGenerationModel: string;

  // Content settings
  excludedTags: string[];
  mediaFolder: string;
  systemPrompt: string;
  persistentExternalContextPaths: string[];

  // Multi-selection fork: external Claude Code CLI session discovery (optional —
  // defaults provided in DEFAULT_CLAUDIAN_SETTINGS, code reads via `?? ...`).
  /** When true, auto-include sessions from ~/.claude/projects/<vault-hash>/ in the resume list. */
  includeVaultCliSessions?: boolean;
  /**
   * When true, scan EVERY subfolder of ~/.claude/projects/ — picks up sessions
   * started from any cwd, not just the vault. Useful when you have chats from
   * multiple projects (Bakugan, other repos, worktrees, etc.).
   */
  scanAllProjectFolders?: boolean;
  /** Additional absolute paths pointing to ~/.claude/projects/<some-cwd-hash>/ folders to scan. */
  externalSessionPaths?: string[];
  /** When true, re-scan external session paths whenever the Obsidian window regains focus. */
  refreshExternalSessionsOnFocus?: boolean;

  // Group settings (multi-selection fork). Groups come from Desktop's sidebar
  // (claude_desktop_config.json → customGroupAssignments), keyed by `cg-<uuid>`.
  // Names live on Claude's backend, so the user renames manually here.
  /** Group ids that should appear at the top of the list, in this order. */
  pinnedGroupIds?: string[];
  /** Display order for non-pinned groups. Groups not listed fall back to Desktop's customGroupOrder. */
  groupOrder?: string[];
  /** User-set group names. Key is the cg-uuid. Falls back to "Group abcd" when missing. */
  groupNames?: Record<string, string>;
  /** Group uuids whose section is currently collapsed. */
  collapsedGroupIds?: string[];

  // Voice dictation (multi-selection fork). Mic button in the composer records
  // audio and transcribes it via Groq's Whisper API (free tier, no credit card).
  /** When true, show the mic button in the composer. */
  voiceEnabled?: boolean;
  /** Groq API key for Whisper transcription. Stored locally; never logged. */
  groqApiKey?: string;
  /** Transcription language: 'auto' to let Whisper detect, or an ISO code like 'ru'/'en'. */
  voiceLanguage?: string;

  // Environment
  sharedEnvironmentVariables: string;
  envSnippets: EnvSnippet[];
  customContextLimits: Record<string, number>;
  customModelAliases: Record<string, string>;

  // UI settings
  keyboardNavigation: KeyboardNavigationSettings;
  requireCommandOrControlEnterToSend: boolean;

  // Internationalization
  locale: string;

  // Provider-owned settings
  providerConfigs: ProviderConfigMap;

  // Provider selection
  settingsProvider: string;  // ProviderId — which provider's model/effort/budget is projected to top-level fields
  savedProviderModel: Partial<Record<string, string>>;
  savedProviderEffort: Partial<Record<string, string>>;
  savedProviderServiceTier: Partial<Record<string, string>>;
  savedProviderThinkingBudget: Partial<Record<string, string>>;
  savedProviderPermissionMode: Partial<Record<string, string>>;

  // State (provider-specific, round-tripped opaquely)
  lastCustomModel?: string;

  // UI preferences
  maxTabs: number;
  tabBarPosition: TabBarPosition;
  enableAutoScroll: boolean;
  deferMathRenderingDuringStreaming: boolean;
  chatViewPlacement: ChatViewPlacement;

  // Provider command visibility
  hiddenProviderCommands: HiddenProviderCommands;

  // Allow provider-specific extension fields
  [key: string]: unknown;
}

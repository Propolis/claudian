// Must run before any SDK imports to patch Electron/Node.js realm incompatibility
import { patchSetMaxListenersForElectron } from './utils/electronCompat';
patchSetMaxListenersForElectron();

// Multi-selection fork: tag Claudian SDK sessions as "claude-desktop" so they
// show up in Claude Desktop's chat list alongside CLI sessions. The SDK reads
// process.env.CLAUDE_CODE_ENTRYPOINT when writing JSONL entries — must be set
// before any SDK module initializes.
if (!process.env.CLAUDE_CODE_ENTRYPOINT) {
  process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop';
}

import './providers';

import type { Editor, WorkspaceLeaf } from 'obsidian';
import { MarkdownView, Notice, Plugin } from 'obsidian';

import {
  discoverAllJsonlSessions,
  type ExternalConversationMeta,
} from './app/services/ExternalSessionsDiscovery';
import { DEFAULT_CLAUDIAN_SETTINGS } from './app/settings/defaultSettings';
import { SharedStorageService } from './app/storage/SharedStorageService';
import type { SharedAppStorage } from './core/bootstrap/storage';
import {
  getEnvironmentVariablesForScope as getScopedEnvironmentVariables,
  getRuntimeEnvironmentText,
  setEnvironmentVariablesForScope,
} from './core/providers/providerEnvironment';
import { ProviderRegistry } from './core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from './core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from './core/providers/ProviderWorkspaceRegistry';
import type { ProviderId } from './core/providers/types';
import type { AppTabManagerState } from './core/providers/types';
import { DEFAULT_CHAT_PROVIDER_ID } from './core/providers/types';
import type {
  ClaudianSettings,
  Conversation,
  ConversationMeta,
} from './core/types';
import {
  VIEW_TYPE_CLAUDIAN,
} from './core/types';
import type { ChatViewPlacement, EnvironmentScope } from './core/types/settings';
import { ClaudianView } from './features/chat/ClaudianView';
import { type InlineEditContext, InlineEditModal } from './features/inline-edit/ui/InlineEditModal';
import { ClaudianSettingTab } from './features/settings/ClaudianSettings';
import { setLocale } from './i18n/i18n';
import type { Locale } from './i18n/types';
import { OPENCODE_PLAN_MODE_ID, OPENCODE_SAFE_MODE_ID } from './providers/opencode/modes';
import { buildCursorContext } from './utils/editor';
import { revealWorkspaceLeaf } from './utils/obsidianCompat';
import { getVaultPath } from './utils/path';

function isClaudianView(value: unknown): value is ClaudianView {
  return !!value
    && typeof value === 'object'
    && typeof (value as { getTabManager?: unknown }).getTabManager === 'function';
}

export default class ClaudianPlugin extends Plugin {
  settings!: ClaudianSettings;
  storage!: SharedAppStorage;
  private conversations: Conversation[] = [];
  private lastKnownTabManagerState: AppTabManagerState | null = null;
  /** Multi-selection fork: in-memory external CLI sessions, refreshed via refreshExternalSessions(). */
  private externalConversations: ExternalConversationMeta[] = [];
  /** Multi-selection fork: subscribers notified after refreshExternalSessions(). */
  private externalSessionListeners: Set<() => void> = new Set();

  async onload() {
    await this.loadSettings();
    await ProviderWorkspaceRegistry.initializeAll(this);

    this.registerView(
      VIEW_TYPE_CLAUDIAN,
      (leaf) => new ClaudianView(leaf, this)
    );

    this.addRibbonIcon('bot', 'Open Claudian', () => {
      void this.activateView();
    });

    this.addCommand({
      id: 'open-view',
      name: 'Open chat view',
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: 'inline-edit',
      name: 'Inline edit',
      editorCallback: async (editor: Editor, ctx) => {
        const view = ctx instanceof MarkdownView
          ? ctx
          : this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) {
          new Notice('Inline edit unavailable: could not access the active Markdown view.');
          return;
        }

        const selectedText = editor.getSelection();
        const notePath = view.file?.path || 'unknown';

        let editContext: InlineEditContext;
        if (selectedText.trim()) {
          editContext = { mode: 'selection', selectedText };
        } else {
          const cursor = editor.getCursor();
          const cursorContext = buildCursorContext(
            (line) => editor.getLine(line),
            editor.lineCount(),
            cursor.line,
            cursor.ch
          );
          editContext = { mode: 'cursor', cursorContext };
        }

        const modal = new InlineEditModal(
          this.app,
          this,
          editor,
          view,
          editContext,
          notePath,
          () => this.getView()?.getActiveTab()?.ui.externalContextSelector?.getExternalContexts() ?? []
        );
        const result = await modal.openAndWait();

        if (result.decision === 'accept' && result.editedText !== undefined) {
          new Notice(editContext.mode === 'cursor' ? 'Inserted' : 'Edit applied');
        }
      },
    });

    this.addCommand({
      id: 'new-tab',
      name: 'New tab',
      checkCallback: (checking: boolean) => {
        if (!this.canCreateNewTab()) return false;

        if (!checking) {
          void this.openNewTab();
        }
        return true;
      },
    });

    this.addCommand({
      id: 'new-session',
      name: 'New session (in current tab)',
      checkCallback: (checking: boolean) => {
        const view = this.getView();
        if (!view) return false;

        const tabManager = view.getTabManager();
        if (!tabManager) return false;

        const activeTab = tabManager.getActiveTab();
        if (!activeTab) return false;

        if (activeTab.state.isStreaming) return false;

        if (!checking) {
          void tabManager.createNewConversation();
        }
        return true;
      },
    });

    this.addCommand({
      id: 'close-current-tab',
      name: 'Close current tab',
      checkCallback: (checking: boolean) => {
        const view = this.getView();
        if (!view) return false;

        const tabManager = view.getTabManager();
        if (!tabManager) return false;

        if (!checking) {
          const activeTabId = tabManager.getActiveTabId();
          if (activeTabId) {
            void tabManager.closeTab(activeTabId);
          }
        }
        return true;
      },
    });

    this.addSettingTab(new ClaudianSettingTab(this.app, this));

    // Multi-selection fork: initial scan of external CLI sessions + manual command.
    this.refreshExternalSessions();

    this.addCommand({
      id: 'refresh-external-sessions',
      name: 'Refresh external sessions',
      callback: () => {
        this.refreshExternalSessions();
        new Notice(`Found ${this.externalConversations.length} external session(s)`);
      },
    });

    // Multi-selection fork: auto-rescan on window focus so new CLI sessions
    // appear without a manual click. Debounced inside the handler.
    let focusDebounce: number | null = null;
    const focusHandler = () => {
      if (!this.settings.refreshExternalSessionsOnFocus) return;
      if (focusDebounce !== null) window.clearTimeout(focusDebounce);
      focusDebounce = window.setTimeout(() => {
        focusDebounce = null;
        this.refreshExternalSessions();
      }, 500);
    };
    window.addEventListener('focus', focusHandler);
    this.register(() => {
      window.removeEventListener('focus', focusHandler);
      if (focusDebounce !== null) window.clearTimeout(focusDebounce);
    });
  }

  onunload(): void {
    void this.persistOpenTabStates();
  }

  private async persistOpenTabStates(): Promise<void> {
    // Ensures state is saved even if Obsidian quits without calling onClose()
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (tabManager) {
        const state = tabManager.getPersistedState();
        await this.persistTabManagerState(state);
      }
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];

    if (!leaf) {
      const newLeaf = this.getLeafForPlacement(this.settings.chatViewPlacement);
      if (newLeaf) {
        await newLeaf.setViewState({
          type: VIEW_TYPE_CLAUDIAN,
          active: true,
        });
        leaf = newLeaf;
      }
    }

    if (leaf) {
      await revealWorkspaceLeaf(workspace, leaf);
    }
  }

  private getLeafForPlacement(placement: ChatViewPlacement): WorkspaceLeaf | null {
    const { workspace } = this.app;
    switch (placement) {
      case 'main-tab':
        return workspace.getLeaf('tab');
      case 'left-sidebar':
        return workspace.getLeftLeaf(false);
      case 'right-sidebar':
        return workspace.getRightLeaf(false);
    }
  }

  private canCreateNewTab(): boolean {
    const hasClaudianLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN).length > 0;
    const view = this.getView();
    const tabManager = view?.getTabManager();

    if (tabManager) {
      return tabManager.canCreateTab();
    }

    if (hasClaudianLeaf) {
      return false;
    }

    return this.getLastKnownOpenTabCount() < this.getMaxTabsLimit();
  }

  private async ensureViewOpen(): Promise<ClaudianView | null> {
    const existingView = this.getView();
    if (existingView) {
      return existingView;
    }

    await this.activateView();
    return this.getView();
  }

  private async openNewTab(): Promise<void> {
    const existingView = this.getView();
    if (existingView) {
      await existingView.createNewTab();
      return;
    }

    const restoredTabCount = this.getLastKnownOpenTabCount();
    const view = await this.ensureViewOpen();
    if (!view) {
      return;
    }

    // A cold-open view creates its initial tab during restore. Avoid stacking
    // an extra blank tab on top when there was no prior layout to restore.
    if (restoredTabCount === 0) {
      return;
    }

    await view.createNewTab();
  }

  async loadSettings() {
    this.storage = new SharedStorageService(this);
    const { claudian } = await this.storage.initialize();
    this.lastKnownTabManagerState = await this.storage.getTabManagerState();

    this.settings = {
      ...DEFAULT_CLAUDIAN_SETTINGS,
      ...claudian,
    };

    // Plan mode is ephemeral — normalize back to normal on load so the app
    // doesn't start stuck in plan mode after a restart (prePlanPermissionMode is lost)
    if (this.settings.permissionMode === 'plan') {
      this.settings.permissionMode = 'normal';
    }
    if (
      this.settings.savedProviderPermissionMode
      && typeof this.settings.savedProviderPermissionMode === 'object'
      && !Array.isArray(this.settings.savedProviderPermissionMode)
    ) {
      for (const [providerId, mode] of Object.entries(this.settings.savedProviderPermissionMode)) {
        if (mode === 'plan') {
          this.settings.savedProviderPermissionMode[providerId] = 'normal';
        }
      }
    }
    const opencodeConfig = this.settings.providerConfigs?.opencode;
    if (
      opencodeConfig
      && typeof opencodeConfig === 'object'
      && !Array.isArray(opencodeConfig)
      && opencodeConfig.selectedMode === OPENCODE_PLAN_MODE_ID
    ) {
      opencodeConfig.selectedMode = OPENCODE_SAFE_MODE_ID;
    }

    const didNormalizeProviderSelection = ProviderSettingsCoordinator.normalizeProviderSelection(
      this.settings,
    );
    const didNormalizeModelVariants = this.normalizeModelVariantSettings();

    const allMetadata = await this.storage.sessions.listMetadata();
    this.conversations = allMetadata.map(meta => {
      const resumeSessionId = meta.sessionId !== undefined ? meta.sessionId : meta.id;

      return {
        id: meta.id,
        providerId: meta.providerId ?? DEFAULT_CHAT_PROVIDER_ID,
        title: meta.title,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        lastResponseAt: meta.lastResponseAt,
        sessionId: resumeSessionId,
        providerState: meta.providerState,
        messages: [],
        currentNote: meta.currentNote,
        externalContextPaths: meta.externalContextPaths,
        enabledMcpServers: meta.enabledMcpServers,
        usage: meta.usage,
        titleGenerationStatus: meta.titleGenerationStatus,
        resumeAtMessageId: meta.resumeAtMessageId,
      };
    }).sort(
      (a, b) => (b.lastResponseAt ?? b.updatedAt) - (a.lastResponseAt ?? a.updatedAt)
    );
    setLocale(this.settings.locale as Locale);

    const backfilledConversations = this.backfillConversationResponseTimestamps();

    const { changed, invalidatedConversations } = this.reconcileModelWithEnvironment();

    ProviderSettingsCoordinator.projectActiveProviderState(
      this.settings,
    );

    if (changed || didNormalizeModelVariants || didNormalizeProviderSelection) {
      await this.saveSettings();
    }

    const conversationsToSave = new Set([...backfilledConversations, ...invalidatedConversations]);
    for (const conv of conversationsToSave) {
      await this.storage.sessions.saveMetadata(
        this.storage.sessions.toSessionMetadata(conv)
      );
    }
  }

  private backfillConversationResponseTimestamps(): Conversation[] {
    const updated: Conversation[] = [];
    for (const conv of this.conversations) {
      if (conv.lastResponseAt != null) continue;
      if (!conv.messages || conv.messages.length === 0) continue;

      for (let i = conv.messages.length - 1; i >= 0; i--) {
        const msg = conv.messages[i];
        if (msg.role === 'assistant') {
          conv.lastResponseAt = msg.timestamp;
          updated.push(conv);
          break;
        }
      }
    }
    return updated;
  }

  normalizeModelVariantSettings(): boolean {
    return ProviderSettingsCoordinator.normalizeAllModelVariants(
      this.settings,
    );
  }

  async saveSettings() {
    ProviderSettingsCoordinator.normalizeProviderSelection(
      this.settings,
    );
    ProviderSettingsCoordinator.persistProjectedProviderState(
      this.settings,
    );

    await this.storage.saveClaudianSettings(this.settings);
  }

  /** Updates and persists environment variables, restarting processes to apply changes. */
  async applyEnvironmentVariables(scope: EnvironmentScope, envText: string): Promise<void> {
    await this.applyEnvironmentVariablesBatch([{ scope, envText }]);
  }

  async applyEnvironmentVariablesBatch(
    updates: Array<{ scope: EnvironmentScope; envText: string }>,
  ): Promise<void> {
    const settingsBag = this.settings as unknown as Record<string, unknown>;
    const nextEnvironmentByScope = new Map<EnvironmentScope, string>();
    for (const update of updates) {
      nextEnvironmentByScope.set(update.scope, update.envText);
    }

    const changedScopes: EnvironmentScope[] = [];
    for (const [scope, envText] of nextEnvironmentByScope) {
      const currentValue = getScopedEnvironmentVariables(settingsBag, scope);
      if (currentValue !== envText) {
        changedScopes.push(scope);
      }
      setEnvironmentVariablesForScope(settingsBag, scope, envText);
    }

    if (changedScopes.length === 0) {
      await this.saveSettings();
      return;
    }

    const affectedProviderIds = this.getAffectedEnvironmentProviders(changedScopes);
    ProviderSettingsCoordinator.handleEnvironmentChange(settingsBag, affectedProviderIds);
    const { changed, invalidatedConversations } = this.reconcileModelWithEnvironment(affectedProviderIds);
    await this.saveSettings();

    if (invalidatedConversations.length > 0) {
      for (const conv of invalidatedConversations) {
        await this.storage.sessions.saveMetadata(
          this.storage.sessions.toSessionMetadata(conv)
        );
      }
    }

    const view = this.getView();
    const tabManager = view?.getTabManager();

    if (tabManager) {
      const affectedTabs = tabManager.getAllTabs().filter((tab) => (
        affectedProviderIds.includes(tab.providerId ?? DEFAULT_CHAT_PROVIDER_ID)
      ));
      const syncTabRuntimeState = (tab: (typeof affectedTabs)[number]): void => {
        if (!tab.service || !tab.serviceInitialized) {
          return;
        }

        const conversation = tab.conversationId
          ? this.getConversationSync(tab.conversationId)
          : null;
        const hasConversationContext = (conversation?.messages.length ?? 0) > 0;
        const externalContextPaths = tab.ui.externalContextSelector?.getExternalContexts()
          ?? (hasConversationContext
            ? conversation?.externalContextPaths ?? []
            : this.settings.persistentExternalContextPaths ?? []);

        tab.service.syncConversationState(conversation, externalContextPaths);
      };

      for (const tab of affectedTabs) {
        if (tab.state.isStreaming) {
          tab.controllers.inputController?.cancelStreaming();
        }
      }

      let failedTabs = 0;
      if (changed) {
        for (const tab of affectedTabs) {
          if (!tab.service || !tab.serviceInitialized) {
            continue;
          }
          try {
            syncTabRuntimeState(tab);
            tab.service.resetSession();
            await tab.service.ensureReady();
          } catch {
            failedTabs++;
          }
        }
      } else {
        for (const tab of affectedTabs) {
          if (!tab.service || !tab.serviceInitialized) {
            continue;
          }
          try {
            syncTabRuntimeState(tab);
            await tab.service.ensureReady({ force: true });
          } catch {
            failedTabs++;
          }
        }
      }
      if (failedTabs > 0) {
        new Notice(`Environment changes applied, but ${failedTabs} affected tab(s) failed to restart.`);
      }
    }

    for (const openView of this.getAllViews()) {
      openView.invalidateProviderCommandCaches(affectedProviderIds);
      openView.refreshModelSelector();
    }

    const noticeText = changed
      ? 'Environment variables applied. Sessions will be rebuilt on next message.'
      : 'Environment variables applied.';
    new Notice(noticeText);
  }

  /** Returns the runtime environment variables (fixed at plugin load). */
  getActiveEnvironmentVariables(
    providerId: ProviderId = ProviderRegistry.resolveSettingsProviderId(
      this.settings,
    ),
  ): string {
    return getRuntimeEnvironmentText(
      this.settings,
      providerId,
    );
  }

  getEnvironmentVariablesForScope(scope: EnvironmentScope): string {
    return getScopedEnvironmentVariables(
      this.settings,
      scope,
    );
  }

  getResolvedProviderCliPath(providerId: ProviderId): string | null {
    const cliResolver = ProviderWorkspaceRegistry.getCliResolver(providerId);
    if (!cliResolver) {
      return null;
    }

    return cliResolver.resolveFromSettings(this.settings);
  }

  private reconcileModelWithEnvironment(providerIds: ProviderId[] = ProviderRegistry.getRegisteredProviderIds()): {
    changed: boolean;
    invalidatedConversations: Conversation[];
  } {
    return ProviderSettingsCoordinator.reconcileProviders(
      this.settings,
      this.conversations,
      providerIds,
    );
  }

  private getAffectedEnvironmentProviders(scopes: EnvironmentScope[]): ProviderId[] {
    const registeredProviderIds = new Set(ProviderRegistry.getRegisteredProviderIds());
    const affectedProviderIds = new Set<ProviderId>();

    for (const scope of scopes) {
      if (scope === 'shared') {
        for (const providerId of registeredProviderIds) {
          affectedProviderIds.add(providerId);
        }
        continue;
      }

      const providerId = scope.slice('provider:'.length);
      if (registeredProviderIds.has(providerId)) {
        affectedProviderIds.add(providerId);
      }
    }

    return Array.from(affectedProviderIds);
  }

  private generateConversationId(): string {
    return `conv-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  private generateDefaultTitle(): string {
    const now = new Date();
    return now.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private getConversationPreview(conv: Conversation): string {
    const firstUserMsg = conv.messages.find(m => m.role === 'user');
    if (!firstUserMsg) {
      return 'New conversation';
    }
    return firstUserMsg.content.substring(0, 50) + (firstUserMsg.content.length > 50 ? '...' : '');
  }

  private async loadSdkMessagesForConversation(conversation: Conversation): Promise<void> {
    await ProviderRegistry
      .getConversationHistoryService(conversation.providerId)
      .hydrateConversationHistory(conversation, getVaultPath(this.app));
  }

  async createConversation(options?: {
    providerId?: ProviderId;
    sessionId?: string;
  }): Promise<Conversation> {
    const providerId = options?.providerId ?? DEFAULT_CHAT_PROVIDER_ID;
    const sessionId = options?.sessionId;
    const conversationId = sessionId ?? this.generateConversationId();
    const conversation: Conversation = {
      id: conversationId,
      providerId,
      title: this.generateDefaultTitle(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: sessionId ?? null,
      messages: [],
    };

    this.conversations.unshift(conversation);
    await this.storage.sessions.saveMetadata(
      this.storage.sessions.toSessionMetadata(conversation)
    );

    return conversation;
  }

  async switchConversation(id: string): Promise<Conversation | null> {
    let conversation = this.conversations.find(c => c.id === id);

    // Multi-selection fork: id may point to an external CLI session that's
    // not yet promoted to a native conversation. Materialize it now so it
    // shows up natively from here on (with its real title carried over).
    if (!conversation) {
      const external = this.getExternalConversation(id);
      if (external) {
        conversation = await this.createConversation({
          sessionId: id,
          providerId: external.providerId,
        });
        conversation.title = external.title;
        conversation.createdAt = external.createdAt;
        conversation.updatedAt = external.updatedAt;
        await this.storage.sessions.saveMetadata(
          this.storage.sessions.toSessionMetadata(conversation),
        );
        // Drop from the external in-memory list; future reads come from native.
        this.externalConversations = this.externalConversations.filter((e) => e.id !== id);
      }
    }

    if (!conversation) return null;

    await this.loadSdkMessagesForConversation(conversation);
    return conversation;
  }

  async deleteConversation(id: string): Promise<void> {
    const index = this.conversations.findIndex(c => c.id === id);
    if (index === -1) return;

    const conversation = this.conversations[index];
    this.conversations.splice(index, 1);

    await ProviderRegistry
      .getConversationHistoryService(conversation.providerId)
      .deleteConversationSession(conversation, getVaultPath(this.app));

    await this.storage.sessions.deleteMetadata(id);

    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;

      for (const tab of tabManager.getAllTabs()) {
        if (tab.conversationId === id) {
          tab.controllers.inputController?.cancelStreaming();
          await tab.controllers.conversationController?.createNew({ force: true });
        }
      }
    }
  }

  async renameConversation(id: string, title: string): Promise<void> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return;

    conversation.title = title.trim() || this.generateDefaultTitle();
    conversation.updatedAt = Date.now();

    await this.storage.sessions.saveMetadata(
      this.storage.sessions.toSessionMetadata(conversation)
    );
  }

  async updateConversation(id: string, updates: Partial<Conversation>): Promise<void> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return;

    // providerId is immutable — strip it from updates to prevent accidental mutation
    const safeUpdates = { ...updates };
    delete safeUpdates.providerId;
    Object.assign(conversation, safeUpdates, { updatedAt: Date.now() });

    await this.storage.sessions.saveMetadata(
      this.storage.sessions.toSessionMetadata(conversation)
    );

    // Clear image data from memory after save (data is persisted by SDK).
    // Skip for pending forks: their deep-cloned images aren't in SDK storage yet.
    if (!ProviderRegistry.getConversationHistoryService(conversation.providerId).isPendingForkConversation(conversation)) {
      for (const msg of conversation.messages) {
        if (msg.images) {
          for (const img of msg.images) {
            img.data = '';
          }
        }
      }
    }
  }

  async getConversationById(id: string): Promise<Conversation | null> {
    const conversation = this.conversations.find(c => c.id === id) || null;

    if (conversation) {
      await this.loadSdkMessagesForConversation(conversation);
    }

    return conversation;
  }

  getConversationSync(id: string): Conversation | null {
    return this.conversations.find(c => c.id === id) || null;
  }

  findEmptyConversation(): Conversation | null {
    return this.conversations.find(c => c.messages.length === 0) || null;
  }

  getConversationList(): ConversationMeta[] {
    const native: ConversationMeta[] = this.conversations.map(c => ({
      id: c.id,
      providerId: c.providerId,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      lastResponseAt: c.lastResponseAt,
      messageCount: c.messages.length,
      preview: this.getConversationPreview(c),
      titleGenerationStatus: c.titleGenerationStatus,
    }));

    // Multi-selection fork: merge external CLI sessions, deduped by sessionId.
    // A session may exist in both native and external — prefer native (it has
    // a curated title, message count, etc.).
    const seenIds = new Set<string>();
    const seenSessionIds = new Set<string>();
    for (const c of this.conversations) {
      seenIds.add(c.id);
      if (c.sessionId) seenSessionIds.add(c.sessionId);
    }

    const externalToShow = this.externalConversations.filter(
      (e) => !seenIds.has(e.id) && !seenSessionIds.has(e.id),
    );

    return [...native, ...externalToShow].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Multi-selection fork: returns the external entry for an id, if any.
   * Used by ConversationController to set up resume from a CLI session.
   */
  getExternalConversation(id: string): ExternalConversationMeta | null {
    return this.externalConversations.find((e) => e.id === id) ?? null;
  }

  /**
   * Multi-selection fork: rescan all configured external session paths.
   * Two effects:
   *   1. Sync native conversation titles from JSONL when a custom-title or
   *      ai-title is present and differs from the cached native title.
   *   2. Rebuild the in-memory list of external (JSONL-only) sessions for
   *      the resume dropdown.
   * Fires registered listeners on completion.
   */
  refreshExternalSessions(): void {
    const settings = this.settings;
    const allFound = discoverAllJsonlSessions({
      app: this.app,
      includeVaultCliSessions: settings.includeVaultCliSessions ?? true,
      scanAllProjectFolders: settings.scanAllProjectFolders ?? false,
      externalSessionPaths: settings.externalSessionPaths ?? [],
    });

    // Index by sessionId for fast lookup.
    const bySessionId = new Map<string, typeof allFound[number]>();
    for (const info of allFound) {
      // Last write wins (allFound is sorted desc by updatedAt; we want the most recent).
      if (!bySessionId.has(info.sessionId)) bySessionId.set(info.sessionId, info);
    }

    // Sync native titles: Desktop metadata is authoritative, then JSONL custom
    // / ai. Skip `first-user` to avoid clobbering Claudian's own title-gen,
    // manual renames, or `New conversation` placeholders.
    const conversationsToSave: Conversation[] = [];
    for (const conv of this.conversations) {
      const lookupId = conv.sessionId ?? conv.id;
      const info = bySessionId.get(lookupId);
      if (!info) continue;
      const isAuthoritative = info.titleSource === 'desktop'
        || info.titleSource === 'custom'
        || info.titleSource === 'ai';
      if (!isAuthoritative) continue;
      if (!info.title) continue;
      if (conv.title === info.title) continue;
      conv.title = info.title;
      conv.updatedAt = Date.now();
      conversationsToSave.push(conv);
    }

    // Persist updated titles asynchronously — don't block the refresh callback.
    if (conversationsToSave.length > 0) {
      void Promise.all(conversationsToSave.map((conv) =>
        this.storage.sessions.saveMetadata(this.storage.sessions.toSessionMetadata(conv))
      )).catch(() => { /* persistence failure is non-fatal */ });
    }

    // Rebuild external list: anything in JSONL that isn't already native.
    const nativeIds = new Set<string>();
    const nativeSessionIds = new Set<string>();
    for (const c of this.conversations) {
      nativeIds.add(c.id);
      if (c.sessionId) nativeSessionIds.add(c.sessionId);
    }

    this.externalConversations = allFound
      .filter((info) => !nativeIds.has(info.sessionId) && !nativeSessionIds.has(info.sessionId))
      .map((info) => ({
        id: info.sessionId,
        providerId: DEFAULT_CHAT_PROVIDER_ID,
        title: info.title || `External session ${info.sessionId.slice(0, 8)}`,
        createdAt: info.createdAt,
        updatedAt: info.updatedAt,
        messageCount: 0,
        preview: '',
        external: true,
        sourcePath: info.sourcePath,
        chromeTabGroupId: info.chromeTabGroupId,
        isArchived: info.isArchived,
      }));

    for (const listener of this.externalSessionListeners) {
      try { listener(); } catch { /* swallow */ }
    }
  }

  onExternalSessionsChanged(listener: () => void): () => void {
    this.externalSessionListeners.add(listener);
    return () => this.externalSessionListeners.delete(listener);
  }

  async persistTabManagerState(state: AppTabManagerState): Promise<void> {
    this.lastKnownTabManagerState = state;
    await this.storage.setTabManagerState(state);
  }

  getView(): ClaudianView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    return leaves.map(leaf => leaf.view).find(isClaudianView) ?? null;
  }

  getAllViews(): ClaudianView[] {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    return leaves.map(leaf => leaf.view).filter(isClaudianView);
  }

  findConversationAcrossViews(conversationId: string): { view: ClaudianView; tabId: string } | null {
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;

      const tabs = tabManager.getAllTabs();
      for (const tab of tabs) {
        if (tab.conversationId === conversationId) {
          return { view, tabId: tab.id };
        }
      }
    }
    return null;
  }

  private getLastKnownOpenTabCount(): number {
    return this.lastKnownTabManagerState?.openTabs.length ?? 0;
  }

  private getMaxTabsLimit(): number {
    const maxTabs = this.settings.maxTabs ?? 3;
    return Math.max(3, Math.min(10, maxTabs));
  }

}

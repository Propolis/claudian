import type { App } from 'obsidian';
import { Notice, Platform, PluginSettingTab, Setting } from 'obsidian';

import {
  getHiddenProviderCommands,
  normalizeHiddenCommandList,
} from '../../core/providers/commands/hiddenCommands';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '../../core/providers/ProviderWorkspaceRegistry';
import type { ProviderId } from '../../core/providers/types';
import type { ChatViewPlacement } from '../../core/types/settings';
import { getAvailableLocales, getLocaleDisplayName, setLocale, t } from '../../i18n/i18n';
import type { Locale, TranslationKey } from '../../i18n/types';
import type ClaudianPlugin from '../../main';
import { formatContextLimit, parseContextLimit, parseEnvironmentVariables } from '../../utils/env';
import { buildNavMappingText, parseNavMappings } from './keyboardNavigation';
import { renderEnvironmentSettingsSection } from './ui/EnvironmentSettingsSection';

type SettingsTabId = string;
type ObsidianHotkey = { modifiers: string[]; key: string };
type ObsidianHotkeyManager = {
  customKeys?: Record<string, ObsidianHotkey[] | undefined>;
  defaultKeys?: Record<string, ObsidianHotkey[] | undefined>;
};
type ObsidianHotkeyTab = {
  searchInputEl?: HTMLInputElement;
  searchComponent?: { inputEl?: HTMLInputElement };
  updateHotkeyVisibility?: () => void;
};
type ObsidianSettingsController = {
  activeTab?: ObsidianHotkeyTab;
  open: () => void;
  openTabById: (id: string) => void;
};
type AppWithHotkeyInternals = App & {
  hotkeyManager?: ObsidianHotkeyManager;
  setting?: ObsidianSettingsController;
};

function formatHotkey(hotkey: ObsidianHotkey): string {
  const isMac = Platform.isMacOS;
  const modMap: Record<string, string> = isMac
    ? { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }
    : { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' };

  const mods = hotkey.modifiers.map((modifier) => modMap[modifier] || modifier);
  const key = hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key;

  return isMac ? [...mods, key].join('') : [...mods, key].join('+');
}

function openHotkeySettings(app: App): void {
  const setting = (app as AppWithHotkeyInternals).setting;
  if (!setting) {
    return;
  }

  setting.open();
  setting.openTabById('hotkeys');
  window.setTimeout(() => {
    const tab = setting.activeTab;
    if (!tab) {
      return;
    }

    const searchEl = tab.searchInputEl ?? tab.searchComponent?.inputEl;
    if (!searchEl) {
      return;
    }

    searchEl.value = 'Claudian';
    tab.updateHotkeyVisibility?.();
  }, 100);
}

function getHotkeyForCommand(app: App, commandId: string): string | null {
  const hotkeyManager = (app as AppWithHotkeyInternals).hotkeyManager;
  if (!hotkeyManager) return null;

  const customHotkeys = hotkeyManager.customKeys?.[commandId];
  const defaultHotkeys = hotkeyManager.defaultKeys?.[commandId];
  const hotkeys = customHotkeys && customHotkeys.length > 0 ? customHotkeys : defaultHotkeys;

  if (!hotkeys || hotkeys.length === 0) return null;

  return hotkeys.map(formatHotkey).join(', ');
}

function addHotkeySettingRow(
  containerEl: HTMLElement,
  app: App,
  commandId: string,
  translationPrefix: string,
): void {
  const hotkey = getHotkeyForCommand(app, commandId);
  const item = containerEl.createDiv({ cls: 'claudian-hotkey-item' });
  item.createSpan({
    cls: 'claudian-hotkey-name',
    text: t(`${translationPrefix}.name` as TranslationKey),
  });
  if (hotkey) {
    item.createSpan({ cls: 'claudian-hotkey-badge', text: hotkey });
  }
  item.addEventListener('click', () => openHotkeySettings(app));
}

export class ClaudianSettingTab extends PluginSettingTab {
  plugin: ClaudianPlugin;
  private activeTab: SettingsTabId = 'general';

  constructor(app: App, plugin: ClaudianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('claudian-settings');

    setLocale(this.plugin.settings.locale as Locale);

    const providerTabs = ProviderRegistry.getRegisteredProviderIds();
    const tabIds: SettingsTabId[] = ['general', ...providerTabs];
    if (!tabIds.includes(this.activeTab)) {
      this.activeTab = 'general';
    }

    const tabBar = containerEl.createDiv({ cls: 'claudian-settings-tabs' });
    const tabButtons = new Map<SettingsTabId, HTMLButtonElement>();
    const tabContents = new Map<SettingsTabId, HTMLDivElement>();

    for (const id of tabIds) {
      const label = id === 'general'
        ? t('settings.tabs.general' as TranslationKey)
        : ProviderRegistry.getProviderDisplayName(id);
      const button = tabBar.createEl('button', {
        cls: `claudian-settings-tab${id === this.activeTab ? ' claudian-settings-tab--active' : ''}`,
        text: label,
      });
      button.addEventListener('click', () => {
        this.activeTab = id;
        for (const tabId of tabIds) {
          tabButtons.get(tabId)?.toggleClass('claudian-settings-tab--active', tabId === id);
          tabContents.get(tabId)?.toggleClass('claudian-settings-tab-content--active', tabId === id);
        }
      });
      tabButtons.set(id, button);
    }

    for (const id of tabIds) {
      const content = containerEl.createDiv({
        cls: `claudian-settings-tab-content${id === this.activeTab ? ' claudian-settings-tab-content--active' : ''}`,
      });
      tabContents.set(id, content);
    }

    this.renderGeneralTab(tabContents.get('general')!);

    for (const providerId of providerTabs) {
      const content = tabContents.get(providerId);
      if (!content) {
        continue;
      }

      ProviderWorkspaceRegistry.getSettingsTabRenderer(providerId)?.render(content, {
        plugin: this.plugin,
        renderHiddenProviderCommandSetting: (
          target,
          targetProviderId,
          copy,
        ) => this.renderHiddenProviderCommandSetting(target, targetProviderId, copy),
        refreshModelSelectors: () => {
          for (const view of this.plugin.getAllViews()) {
            view.refreshModelSelector();
          }
        },
        renderCustomContextLimits: (target, providerId) => this.renderCustomContextLimits(target, providerId),
      });
    }
  }

  private renderGeneralTab(container: HTMLElement): void {
    new Setting(container)
      .setName(t('settings.language.name'))
      .setDesc(t('settings.language.desc'))
      .addDropdown((dropdown) => {
        const locales = getAvailableLocales();
        for (const locale of locales) {
          dropdown.addOption(locale, getLocaleDisplayName(locale));
        }
        dropdown
          .setValue(this.plugin.settings.locale)
          .onChange(async (value) => {
            const locale = value as Locale;
            if (!setLocale(locale)) {
              dropdown.setValue(this.plugin.settings.locale);
              return;
            }
            this.plugin.settings.locale = locale;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    // --- Display ---

    new Setting(container).setName(t('settings.display')).setHeading();

    new Setting(container)
      .setName(t('settings.tabBarPosition.name'))
      .setDesc(t('settings.tabBarPosition.desc'))
      .addDropdown((dropdown) => {
        dropdown
          .addOption('input', t('settings.tabBarPosition.input'))
          .addOption('header', t('settings.tabBarPosition.header'))
          .setValue(this.plugin.settings.tabBarPosition ?? 'input')
          .onChange(async (value) => {
            this.plugin.settings.tabBarPosition = value as 'input' | 'header';
            await this.plugin.saveSettings();

            for (const view of this.plugin.getAllViews()) {
              view.updateLayoutForPosition();
            }
          });
      });

    const maxTabsSetting = new Setting(container)
      .setName(t('settings.maxTabs.name'))
      .setDesc(t('settings.maxTabs.desc'));

    const maxTabsWarningEl = container.createDiv({
      cls: 'claudian-max-tabs-warning claudian-setting-validation claudian-setting-validation-warning claudian-hidden',
    });
    maxTabsWarningEl.setText(t('settings.maxTabs.warning'));

    const updateMaxTabsWarning = (value: number): void => {
      maxTabsWarningEl.toggleClass('claudian-hidden', value <= 5);
    };

    maxTabsSetting.addSlider((slider) => {
      slider
        .setLimits(3, 10, 1)
        .setValue(this.plugin.settings.maxTabs ?? 3)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.maxTabs = value;
          await this.plugin.saveSettings();
          updateMaxTabsWarning(value);
          for (const view of this.plugin.getAllViews()) {
            view.refreshTabControls();
          }
        });
      updateMaxTabsWarning(this.plugin.settings.maxTabs ?? 3);
    });

    new Setting(container)
      .setName(t('settings.chatViewPlacement.name'))
      .setDesc(t('settings.chatViewPlacement.desc'))
      .addDropdown((dropdown) => {
        dropdown
          .addOption('right-sidebar', t('settings.chatViewPlacement.rightSidebar'))
          .addOption('left-sidebar', t('settings.chatViewPlacement.leftSidebar'))
          .addOption('main-tab', t('settings.chatViewPlacement.mainTab'))
          .setValue(this.plugin.settings.chatViewPlacement)
          .onChange(async (value) => {
            this.plugin.settings.chatViewPlacement = value as ChatViewPlacement;
            await this.plugin.saveSettings();
          });
      });

    new Setting(container)
      .setName(t('settings.enableAutoScroll.name'))
      .setDesc(t('settings.enableAutoScroll.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoScroll ?? true)
          .onChange(async (value) => {
            this.plugin.settings.enableAutoScroll = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(container)
      .setName(t('settings.deferMathRenderingDuringStreaming.name'))
      .setDesc(t('settings.deferMathRenderingDuringStreaming.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.deferMathRenderingDuringStreaming ?? true)
          .onChange(async (value) => {
            this.plugin.settings.deferMathRenderingDuringStreaming = value;
            await this.plugin.saveSettings();
          })
      );

    // --- Conversations ---

    new Setting(container).setName(t('settings.conversations')).setHeading();

    new Setting(container)
      .setName(t('settings.autoTitle.name'))
      .setDesc(t('settings.autoTitle.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoTitleGeneration)
          .onChange(async (value) => {
            this.plugin.settings.enableAutoTitleGeneration = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.enableAutoTitleGeneration) {
      new Setting(container)
        .setName(t('settings.titleModel.name'))
        .setDesc(t('settings.titleModel.desc'))
        .addDropdown((dropdown) => {
          dropdown.addOption('', t('settings.titleModel.auto'));

          const settingsBag = this.plugin.settings as unknown as Record<string, unknown>;
          const seenValues = new Set<string>();
          for (const providerId of ProviderRegistry.getRegisteredProviderIds()) {
            const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
            for (const model of uiConfig.getModelOptions(settingsBag)) {
              if (!seenValues.has(model.value)) {
                seenValues.add(model.value);
                dropdown.addOption(model.value, model.label);
              }
            }
          }

          dropdown
            .setValue(this.plugin.settings.titleGenerationModel || '')
            .onChange(async (value) => {
              this.plugin.settings.titleGenerationModel = value;
              await this.plugin.saveSettings();
            });
        });
    }

    // --- Voice dictation (multi-selection fork) ---

    this.renderVoiceSettings(container);

    // --- External sessions (multi-selection fork) ---

    new Setting(container).setName('External Claude code sessions').setHeading();

    new Setting(container)
      .setName('Include vault CLI sessions')
      .setDesc('Auto-include sessions from ~/.claude/projects/<vault-hash>/ in the resume list. Picks up conversations started in this vault from the terminal Claude Code app.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeVaultCliSessions ?? true)
          .onChange(async (value) => {
            this.plugin.settings.includeVaultCliSessions = value;
            await this.plugin.saveSettings();
            this.plugin.refreshExternalSessions();
          })
      );

    new Setting(container)
      .setName('Scan all Claude code projects')
      .setDesc('Include sessions from EVERY subfolder of ~/.claude/projects/, not just the vault. Pulls in chats from any cwd you have worked from (other repos, worktrees, etc.). May add many entries.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.scanAllProjectFolders ?? false)
          .onChange(async (value) => {
            this.plugin.settings.scanAllProjectFolders = value;
            await this.plugin.saveSettings();
            this.plugin.refreshExternalSessions();
          })
      );

    new Setting(container)
      .setName('Refresh on Obsidian focus')
      .setDesc('Re-scan external session paths whenever the Obsidian window regains focus. Use the refresh button in the resume dropdown for manual control.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.refreshExternalSessionsOnFocus ?? true)
          .onChange(async (value) => {
            this.plugin.settings.refreshExternalSessionsOnFocus = value;
            await this.plugin.saveSettings();
          })
      );

    this.renderExternalSessionPaths(container);
    this.renderGroupNames(container);

    // --- Content ---

    new Setting(container).setName(t('settings.content')).setHeading();

    new Setting(container)
      .setName(t('settings.userName.name'))
      .setDesc(t('settings.userName.desc'))
      .addText((text) => {
        text
          .setPlaceholder(t('settings.userName.name'))
          .setValue(this.plugin.settings.userName)
          .onChange(async (value) => {
            this.plugin.settings.userName = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.addEventListener('blur', () => {
          void this.restartServiceForPromptChange();
        });
      });

    new Setting(container)
      .setName(t('settings.systemPrompt.name'))
      .setDesc(t('settings.systemPrompt.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder(t('settings.systemPrompt.name'))
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 50;
        text.inputEl.addEventListener('blur', () => {
          void this.restartServiceForPromptChange();
        });
      });

    new Setting(container)
      .setName(t('settings.excludedTags.name'))
      .setDesc(t('settings.excludedTags.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder('System\nprivate\ndraft')
          .setValue(this.plugin.settings.excludedTags.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.excludedTags = value
              .split(/\r?\n/)
              .map((entry) => entry.trim().replace(/^#/, ''))
              .filter((entry) => entry.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });

    new Setting(container)
      .setName(t('settings.mediaFolder.name'))
      .setDesc(t('settings.mediaFolder.desc'))
      .addText((text) => {
        text
          .setPlaceholder('Attachments')
          .setValue(this.plugin.settings.mediaFolder)
          .onChange(async (value) => {
            this.plugin.settings.mediaFolder = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.addClass('claudian-settings-media-input');
        text.inputEl.addEventListener('blur', () => {
          void this.restartServiceForPromptChange();
        });
      });

    // --- Input ---

    new Setting(container).setName(t('settings.input')).setHeading();

    new Setting(container)
      .setName(t('settings.requireCommandOrControlEnterToSend.name'))
      .setDesc(t('settings.requireCommandOrControlEnterToSend.desc'))
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.requireCommandOrControlEnterToSend ?? false)
          .onChange(async (value) => {
            this.plugin.settings.requireCommandOrControlEnterToSend = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(container)
      .setName(t('settings.navMappings.name'))
      .setDesc(t('settings.navMappings.desc'))
      .addTextArea((text) => {
        let pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
        let saveTimeout: number | null = null;

        const commitValue = async (showError: boolean): Promise<void> => {
          if (saveTimeout !== null) {
            window.clearTimeout(saveTimeout);
            saveTimeout = null;
          }

          const result = parseNavMappings(pendingValue);
          if (!result.settings) {
            if (showError) {
              new Notice(`${t('common.error')}: ${result.error}`);
              pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
              text.setValue(pendingValue);
            }
            return;
          }

          this.plugin.settings.keyboardNavigation.scrollUpKey = result.settings.scrollUp;
          this.plugin.settings.keyboardNavigation.scrollDownKey = result.settings.scrollDown;
          this.plugin.settings.keyboardNavigation.focusInputKey = result.settings.focusInput;
          await this.plugin.saveSettings();
          pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
          text.setValue(pendingValue);
        };

        const scheduleSave = (): void => {
          if (saveTimeout !== null) {
            window.clearTimeout(saveTimeout);
          }
          saveTimeout = window.setTimeout(() => {
            void commitValue(false);
          }, 500);
        };

        text
          .setPlaceholder('Map w scrollup\nmap s scrolldown\nmap i focusinput')
          .setValue(pendingValue)
          .onChange((value) => {
            pendingValue = value;
            scheduleSave();
          });

        text.inputEl.rows = 3;
        text.inputEl.addEventListener('blur', () => {
          void commitValue(true);
        });
      });

    // --- Hotkeys ---

    new Setting(container).setName(t('settings.hotkeys')).setHeading();

    const hotkeyGrid = container.createDiv({ cls: 'claudian-hotkey-grid' });
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:inline-edit', 'settings.inlineEditHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:open-view', 'settings.openChatHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:new-session', 'settings.newSessionHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:new-tab', 'settings.newTabHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'claudian:close-current-tab', 'settings.closeTabHotkey');

    // --- Environment ---

    renderEnvironmentSettingsSection({
      container,
      plugin: this.plugin,
      scope: 'shared',
      heading: t('settings.environment'),
      name: 'Shared environment',
      desc: 'Provider-neutral runtime variables shared across all providers. Use this for PATH, proxy, cert, and temp variables.',
      placeholder: 'PATH=/opt/homebrew/bin:/usr/local/bin\nHTTPS_PROXY=http://proxy.example.com:8080\nSSL_CERT_FILE=/path/to/cert.pem',
      renderCustomContextLimits: (target) => this.renderCustomContextLimits(target),
    });
  }

  /**
   * Multi-selection fork: voice dictation section. Toggle, Groq API key
   * (password field), and transcription language. Free Groq key (no credit
   * card) is what powers the mic button in the composer.
   */
  private renderVoiceSettings(container: HTMLElement): void {
    new Setting(container).setName('Голосовой ввод').setHeading();

    new Setting(container)
      .setName('Кнопка микрофона в поле ввода')
      .setDesc('Показывать 🎤 в композере: нажми — говоришь, нажми ещё — текст распознаётся и вставляется к курсору.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.voiceEnabled !== false)
          .onChange(async (value) => {
            this.plugin.settings.voiceEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    const keySetting = new Setting(container)
      .setName('Groq API-ключ')
      .setDesc(createFragment((frag) => {
        frag.appendText('Бесплатный ключ для распознавания речи (Whisper large-v3-turbo). Хранится локально, никуда кроме Groq не уходит. Получить за 2 минуты без карты: ');
        const a = frag.createEl('a', { text: 'console.groq.com/keys', href: 'https://console.groq.com/keys' });
        a.setAttr('target', '_blank');
      }))
      .addText((text) => {
        text
          .setPlaceholder('gsk_…')
          .setValue(this.plugin.settings.groqApiKey ?? '')
          .onChange(async (value) => {
            this.plugin.settings.groqApiKey = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
        text.inputEl.addClass('claudian-groq-key-input');
      });
    keySetting.addExtraButton((btn) =>
      btn
        .setIcon('eye')
        .setTooltip('Показать/скрыть ключ')
        .onClick(() => {
          const input = keySetting.controlEl.querySelector('input.claudian-groq-key-input') as HTMLInputElement | null;
          if (!input) return;
          input.type = input.type === 'password' ? 'text' : 'password';
        })
    );

    new Setting(container)
      .setName('Язык распознавания')
      .setDesc('«Авто» — Whisper сам определит язык. Зафиксируй язык, если стабильно диктуешь на одном.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('auto', 'Авто')
          .addOption('ru', 'Русский (ru)')
          .addOption('en', 'English (en)')
          .setValue(this.plugin.settings.voiceLanguage ?? 'auto')
          .onChange(async (value) => {
            this.plugin.settings.voiceLanguage = value;
            await this.plugin.saveSettings();
          });
      });
  }

  /**
   * Multi-selection fork: array-of-paths editor for externalSessionPaths.
   * Each row: text input + remove button. "Add path" button appends a blank row.
   */
  private renderExternalSessionPaths(container: HTMLElement): void {
    const setting = new Setting(container)
      .setName('Additional session paths')
      .setDesc('Absolute paths to ~/.claude/projects/<cwd-hash>/ folders. Sessions from any of these appear in the resume dropdown.');

    setting.addButton((btn) =>
      btn
        .setButtonText('+ add path')
        .setCta()
        .onClick(async () => {
          const list = this.plugin.settings.externalSessionPaths ?? [];
          this.plugin.settings.externalSessionPaths = [...list, ''];
          await this.plugin.saveSettings();
          this.display();
        })
    );

    const list = this.plugin.settings.externalSessionPaths ?? [];
    if (list.length === 0) return;

    const rowsWrap = container.createDiv({ cls: 'claudian-external-session-paths' });
    list.forEach((value, index) => {
      const row = new Setting(rowsWrap)
        .addText((text) => {
          text
            .setPlaceholder('~/.claude/projects/-Users-…')
            .setValue(value)
            .onChange(async (next) => {
              const current = this.plugin.settings.externalSessionPaths ?? [];
              const updated = [...current];
              updated[index] = next.trim();
              this.plugin.settings.externalSessionPaths = updated;
              await this.plugin.saveSettings();
              this.plugin.refreshExternalSessions();
            });
          text.inputEl.addClass('claudian-external-session-path-input');
        })
        .addExtraButton((btn) =>
          btn
            .setIcon('trash-2')
            .setTooltip('Remove')
            .onClick(async () => {
              const current = this.plugin.settings.externalSessionPaths ?? [];
              this.plugin.settings.externalSessionPaths = current.filter((_, i) => i !== index);
              await this.plugin.saveSettings();
              this.plugin.refreshExternalSessions();
              this.display();
            })
        );
      row.controlEl.addClass('claudian-external-session-path-row');
    });
  }

  /**
   * Multi-selection fork: lists all detected Desktop groups (cg-uuids) with
   * a text input next to each so the user can assign friendly names in one
   * pass. Names aren't recoverable from disk (cloud-only in Claude Desktop),
   * so this is the practical way to migrate them.
   */
  private renderGroupNames(container: HTMLElement): void {
    new Setting(container)
      .setName('Group names')
      .setDesc('Claude Desktop stores group names on its server, not on disk. Assign friendly names here — they persist across reloads. Click ⟳ to refresh detected groups.')
      .addButton((btn) => {
        btn.setIcon('refresh-cw').setTooltip('Re-scan for groups').onClick(() => {
          this.plugin.refreshExternalSessions();
          this.display();
        });
      });

    // Gather distinct cg-uuids from the current external sessions + Desktop config.
    const desktopOrder = this.plugin.getDesktopGroupOrder();
    const fromSessions = new Set<string>();
    for (const conv of this.plugin.getConversationList()) {
      const gid = (conv as { groupId?: string | null }).groupId;
      if (gid) fromSessions.add(gid);
    }
    // Desktop order is canonical when available; sessions cover any extras.
    const groupIds = [
      ...desktopOrder,
      ...[...fromSessions].filter((id) => !desktopOrder.includes(id)),
    ];

    if (groupIds.length === 0) {
      container.createDiv({
        cls: 'claudian-group-names-empty',
        text: 'No groups detected yet. Open the resume dropdown or click sync to load Desktop sessions, then return here.',
      });
      return;
    }

    // Pre-build a per-group title preview (first 2 chats by title) for context.
    const previewByGroup = new Map<string, string[]>();
    for (const conv of this.plugin.getConversationList()) {
      const gid = (conv as { groupId?: string | null }).groupId;
      if (!gid) continue;
      if (!previewByGroup.has(gid)) previewByGroup.set(gid, []);
      const list = previewByGroup.get(gid)!;
      if (list.length < 2) list.push(conv.title);
    }

    const wrap = container.createDiv({ cls: 'claudian-group-names-list' });
    for (const gid of groupIds) {
      const row = wrap.createDiv({ cls: 'claudian-group-names-row' });

      const idEl = row.createDiv({ cls: 'claudian-group-names-id' });
      const suffix = gid.startsWith('cg-') ? gid.slice(3, 11) : gid.slice(0, 8);
      idEl.createSpan({ cls: 'claudian-group-names-suffix', text: suffix });
      const previews = previewByGroup.get(gid) ?? [];
      if (previews.length > 0) {
        const preview = previews.join(' · ');
        const previewEl = idEl.createSpan({ cls: 'claudian-group-names-preview', text: preview });
        previewEl.title = preview;
      }

      const currentName = this.plugin.settings.groupNames?.[gid] ?? '';
      const input = row.createEl('input', {
        cls: 'claudian-group-names-input',
        attr: { type: 'text', placeholder: 'Set group name…', value: currentName },
      });

      let saveTimer: number | null = null;
      const save = async () => {
        const map = { ...(this.plugin.settings.groupNames ?? {}) };
        const trimmed = input.value.trim();
        if (trimmed) {
          map[gid] = trimmed;
        } else {
          delete map[gid];
        }
        this.plugin.settings.groupNames = map;
        await this.plugin.saveSettings();
        // Notify any open history dropdown so it re-renders with the new name.
        this.plugin.refreshExternalSessions();
      };

      // Debounced save on every keystroke so the user doesn't lose changes
      // when they close settings without blurring the input.
      input.addEventListener('input', () => {
        if (saveTimer !== null) window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => {
          saveTimer = null;
          void save();
        }, 300);
      });
      // Save immediately on blur / Enter so user knows it stuck.
      input.addEventListener('blur', () => {
        if (saveTimer !== null) { window.clearTimeout(saveTimer); saveTimer = null; }
        void save();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          input.blur();
        }
      });
    }
  }

  private renderHiddenProviderCommandSetting(
    container: HTMLElement,
    providerId: ProviderId,
    copy: { name: string; desc: string; placeholder: string },
  ): void {
    new Setting(container)
      .setName(copy.name)
      .setDesc(copy.desc)
      .addTextArea((text) => {
        text
          .setPlaceholder(copy.placeholder)
          .setValue(getHiddenProviderCommands(this.plugin.settings, providerId).join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.hiddenProviderCommands = {
              ...this.plugin.settings.hiddenProviderCommands,
              [providerId]: normalizeHiddenCommandList(value.split(/\r?\n/)),
            };
            await this.plugin.saveSettings();
            this.plugin.getView()?.updateHiddenProviderCommands();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });
  }

  private renderCustomContextLimits(container: HTMLElement, providerId?: ProviderId): void {
    container.empty();

    const uniqueModelIds = new Set<string>();
    const providerIds = providerId
      ? [providerId]
      : ProviderRegistry.getRegisteredProviderIds();

    for (const targetProviderId of providerIds) {
      const envVars = parseEnvironmentVariables(
        this.plugin.getActiveEnvironmentVariables(targetProviderId),
      );
      for (const modelId of ProviderRegistry.getChatUIConfig(targetProviderId).getCustomModelIds(envVars)) {
        uniqueModelIds.add(modelId);
      }
    }

    if (uniqueModelIds.size === 0) {
      return;
    }

    const headerEl = container.createDiv({ cls: 'claudian-context-limits-header' });
    headerEl.createSpan({
      text: t('settings.customModelOverrides.name'),
      cls: 'claudian-context-limits-label',
    });

    const descEl = container.createDiv({ cls: 'claudian-context-limits-desc' });
    descEl.setText(t('settings.customModelOverrides.desc'));

    const listEl = container.createDiv({ cls: 'claudian-context-limits-list' });

    for (const modelId of uniqueModelIds) {
      const currentValue = this.plugin.settings.customContextLimits?.[modelId];
      const currentAlias = this.plugin.settings.customModelAliases?.[modelId] ?? '';

      const itemEl = listEl.createDiv({ cls: 'claudian-context-limits-item' });
      const nameEl = itemEl.createDiv({ cls: 'claudian-context-limits-model' });
      nameEl.setText(modelId);

      const inputWrapper = itemEl.createDiv({ cls: 'claudian-context-limits-input-wrapper' });
      const aliasInputEl = inputWrapper.createEl('input', {
        type: 'text',
        placeholder: t('settings.customModelAliases.placeholder'),
        cls: 'claudian-context-alias-input',
        value: currentAlias,
      });
      aliasInputEl.setAttribute('aria-label', `Alias for ${modelId}`);
      aliasInputEl.title = 'Custom label shown in the model selector. Leave empty to use the default.';

      const inputEl = inputWrapper.createEl('input', {
        type: 'text',
        placeholder: '200k',
        cls: 'claudian-context-limits-input',
        value: currentValue ? formatContextLimit(currentValue) : '',
      });
      inputEl.setAttribute('aria-label', `Context window for ${modelId}`);

      const validationEl = inputWrapper.createDiv({ cls: 'claudian-context-limit-validation claudian-hidden' });

      const saveAlias = async (): Promise<void> => {
        if (!this.plugin.settings.customModelAliases) {
          this.plugin.settings.customModelAliases = {};
        }

        const existing = this.plugin.settings.customModelAliases[modelId] ?? '';
        const trimmed = aliasInputEl.value.trim();
        if (trimmed === existing) {
          aliasInputEl.value = existing;
          return;
        }

        if (trimmed) {
          this.plugin.settings.customModelAliases[modelId] = trimmed;
        } else {
          delete this.plugin.settings.customModelAliases[modelId];
        }

        await this.plugin.saveSettings();
        for (const view of this.plugin.getAllViews()) {
          view.refreshModelSelector();
        }
      };

      const saveContextLimit = async (): Promise<void> => {
        const trimmed = inputEl.value.trim();

        if (!this.plugin.settings.customContextLimits) {
          this.plugin.settings.customContextLimits = {};
        }

        if (!trimmed) {
          delete this.plugin.settings.customContextLimits[modelId];
          validationEl.toggleClass('claudian-hidden', true);
          inputEl.classList.remove('claudian-input-error');
        } else {
          const parsed = parseContextLimit(trimmed);
          if (parsed === null) {
            validationEl.setText(t('settings.customContextLimits.invalid'));
            validationEl.toggleClass('claudian-hidden', false);
            inputEl.classList.add('claudian-input-error');
            return;
          }

          this.plugin.settings.customContextLimits[modelId] = parsed;
          validationEl.toggleClass('claudian-hidden', true);
          inputEl.classList.remove('claudian-input-error');
        }

        await this.plugin.saveSettings();
      };

      inputEl.addEventListener('input', () => {
        void saveContextLimit();
      });
      aliasInputEl.addEventListener('blur', () => {
        void saveAlias();
      });
      aliasInputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          aliasInputEl.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          aliasInputEl.value = this.plugin.settings.customModelAliases?.[modelId] ?? '';
          aliasInputEl.blur();
        }
      });
    }
  }

  private async restartServiceForPromptChange(): Promise<void> {
    const view = this.plugin.getView();
    const tabManager = view?.getTabManager();
    if (!tabManager) return;

    try {
      await tabManager.broadcastToAllTabs(
        async (service) => { await service.ensureReady({ force: true }); }
      );
    } catch {
      // Changes will apply on the next conversation if the restart fails.
    }
  }
}

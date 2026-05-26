# Claudian Multi-Selection Fork

Форк [YishenTu/claudian](https://github.com/YishenTu/claudian), добавляющий
multi-selection-with-comments workflow по образцу Antigravity.

## Что добавлено

1. **Плавающая кнопка «Прикрепить к чату».** Появляется около конца выделения
   в любой open-заметке (edit или reading mode).
2. **Чипы прикреплённых фрагментов.** Над инпутом чата собирается список
   сниппетов: первые ~80 символов текста, `filename.md:start-end`, имя ближайшего
   Markdown-heading. Клик по сниппету открывает заметку и скроллит к диапазону.
3. **Per-chip комментарий.** У каждого чипа есть кнопка раскрытия с textarea
   под коммент именно к этому фрагменту.
4. **Структурированный промпт.** Все прикреплённые фрагменты уходят к Claude
   как нумерованные XML-блоки с привязанными комментами — Claude не путается,
   какой коммент к какому сниппету.

## Формат, который видит Claude

```xml
<editor_selection id="1" path="DevOps/Networking/Сети.md" lines="42-48" heading="VLAN — как это работает">
  <user_comment>переписать проще, без жаргона</user_comment>
  <content>
verbatim selected text
  </content>
</editor_selection>

<editor_selection id="2" path="DevOps/Networking/Сети.md" lines="80-82" heading="NAT">
  <content>
another snippet
  </content>
</editor_selection>
```

Зачем именно так:

- `path` + `lines` — точный диапазон, Claude может достать окрестный контекст
  через `Read(file_path=path, offset=startLine-1, limit=endLine-startLine+1)`.
- `heading` — взято из `app.metadataCache.getFileCache().headings`. Даёт
  человеко-читаемую ориентировку, но не заменяет `path` + `lines`.
- `<user_comment>` как child вместо attribute — позволяет содержать любые
  символы без эскейпинга и структурно привязан к снiпету.
- `<content>` тоже child — поддерживает многострочный текст, код, спецсимволы.
- `id="N"` — стабильный лейбл; основной user message может ссылаться по нему
  («перепиши [1], сравни с [2]»).

## Установка

Этот форк публикуется как **отдельный** плагин с id `claudian-multisel`, чтобы
не конфликтовать с оригиналом из community store. Можно держать оба
установленными и переключаться в настройках Obsidian.

### Локальная сборка

```bash
git clone https://github.com/Propolis/claudian.git claudian-fork
cd claudian-fork
git checkout feature/multi-selection
cp .env.local.example .env.local
# Отредактировать .env.local: OBSIDIAN_VAULT=/path/to/vault
npm install
npm run build
```

Build автоматически копирует `main.js`, `manifest.json`, `styles.css` в
`<vault>/.obsidian/plugins/claudian-multisel/`.

### Включение в Obsidian

1. Перезагрузить Obsidian (`Cmd+R` или через Settings).
2. Settings → Community plugins.
3. Найти «Claudian (Multi-Selection)» и включить.
4. Если оригинальный «Claudian» включён — рекомендуется его выключить,
   чтобы CSS-классы не конфликтовали.

## Удаление

Settings → Community plugins → отключить «Claudian (Multi-Selection)»,
затем удалить папку `<vault>/.obsidian/plugins/claudian-multisel/`.
Оригинальный Claudian при этом остаётся работать.

## Изменённые файлы

Новые:
- `src/utils/pinnedSelection.ts` — типы и XML-форматтер.
- `src/shared/components/FloatingAttachButton.ts` — плавающая кнопка.
- `src/features/chat/ui/PinnedSelectionsRow.ts` — chip-row в сайдбаре.
- `src/style/components/pinned-selections.css` — стили.

Изменённые (точечно, без переписывания):
- `src/features/chat/state/{ChatState,types}.ts` — `pinnedSelections: PinnedSelection[]` в state.
- `src/features/chat/controllers/SelectionController.ts` — методы `pinActiveSelection`, lookup heading через metadataCache.
- `src/features/chat/controllers/InputController.ts` — snapshot pinned в turnRequest, очистка после билда.
- `src/features/chat/tabs/{Tab,types}.ts` — wire-up FloatingAttachButton + PinnedSelectionsRow.
- `src/core/runtime/{types,QueuedTurn}.ts` — `pinnedSelections?` на `ChatTurnRequest` + клон/мердж.
- `src/providers/claude/prompt/ClaudeTurnEncoder.ts` — emit multiple `<editor_selection>` blocks.
- `src/providers/codex/prompt/encodeCodexTurn.ts` — то же для Codex (плоский текст).
- `src/providers/opencode/runtime/buildOpencodePrompt.ts` — то же для Opencode.
- `src/core/prompt/mainAgent.ts` — обновлены инструкции для агента про новый формат.

## Backward-compatibility

- Single-selection auto-attach сохранён: если пользователь ничего не прикрепил
  через кнопку, активное выделение в редакторе уходит в промпт как прежний
  `<editor_selection path lines>` блок (без `id`).
- Pinned-выделения имеют приоритет — когда они есть, single auto-attach
  не добавляется, чтобы не дублировать.

---

## External Claude Code CLI sessions

Форк может показывать в `/resume` дропдауне сессии, начатые в терминальном
Claude Code, без копирования данных. Транскрипты JSONL читаются прямо из
`~/.claude/projects/<cwd-hash>/`.

### Зачем

- В терминале и в Claudian — один и тот же SDK, оба пишут JSONL в одно место.
- Claudian-сессии **уже** видны в терминальном `claude --resume` (потому что JSONL в стандартном месте).
- Терминальные сессии **раньше не были** видны в Claudian — теперь видны.

### Включение

Settings → Claudian (Multi-Selection) → секция «External Claude code sessions»:

- **Include vault CLI sessions** (включено по умолчанию) — автоматически добавляет в дропдаун сессии из `~/.claude/projects/<vault-hash>/`. Хэш папки соответствует cwd vault'а.
- **Refresh on Obsidian focus** (включено по умолчанию) — пересканировать пути при возврате фокуса в Obsidian (debounce 500 мс). Чтобы новые сессии из терминала появлялись без ручного клика.
- **Additional session paths** — список произвольных путей к `~/.claude/projects/<some-cwd-hash>/`, если сессии разбросаны по разным проектам.

### Refresh

В дропдауне `/resume` появилась иконка обновления (вращающаяся стрелка) — клик пересканирует все настроенные пути. Также добавлена команда «Refresh external sessions» в Command Palette.

### Что под капотом

- `src/app/services/ExternalSessionsDiscovery.ts` — скан `*.jsonl`, чтение первых ~16KB для title из первого user-сообщения, `fs.stat` для timestamps. Дедуп по sessionId.
- `main.ts` — `refreshExternalSessions()` API, `onExternalSessionsChanged` подписки, focus-listener с debounce.
- `switchConversation(id)` — если id из external, материализует native conversation (создаёт meta.json), сохраняя реальный title/timestamps. Дальше работает как обычная Claudian-сессия.
- `ResumeSessionDropdown` — refresh-иконка в header, `CLI` badge на external-записях.

### Что НЕ работает

- Конкурентная запись в один JSONL из CLI и Claudian одновременно. Не открывайте одну и ту же сессию в обоих инструментах параллельно.
- Сессия из cwd, отличного от vault'а, после resume будет получать tool-вызовы с cwd vault'а — Read/Bash будут разрешать пути не относительно оригинального проекта. Работает, но переходит в «новую» рабочую папку.

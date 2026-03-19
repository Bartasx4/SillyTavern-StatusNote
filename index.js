/**
 * Status Note - SillyTavern extension
 *
 * Stores prompt + settings in chat metadata (chat file), under:
 *   chat_metadata.status_note = {
 *     prompt, include_worldInfo, depth, role, enabled
 *   }
 *
 * This makes the settings branch-aware (each branch is a separate chat file)
 * and allows exporting/importing chats together with Status Note configuration.
 *
 * IMPORTANT:
 * - Do not keep a long-lived reference to `chatMetadata` (it changes on chat switch).
 * - Always use `SillyTavern.getContext().chatMetadata`.
 */

import {
    MAX_INJECTION_DEPTH,
    animation_duration,
    extension_prompt_roles,
    extension_prompt_types,
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../../script.js';

import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { debounce, delay, getCharaFilename } from '../../../utils.js';
import { getTokenCountAsync } from '../../../tokenizers.js';

export const MODULE_NAME = 'status_note';
const TEMPLATE_PATH = 'third-party/SillyTavern-StatusNote';

const CHAT_METADATA_KEY = 'status_note';
const UI_SETTINGS_KEY = 'status_note_ui';

const DEFAULT_NOTE = Object.freeze({
    prompt: '',
    include_worldInfo: false,
    depth: 4,
    role: extension_prompt_roles.SYSTEM,
    enabled: false,
});

const DEFAULT_UI = Object.freeze({
    windowOpen: false,
});

const saveMetadataDebounced = debounce(async () => {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.saveMetadata !== 'function') return;

    try {
        await ctx.saveMetadata();
    } catch (err) {
        console.warn('[Status Note] Failed to save chat metadata:', err);
    }
}, 400);

/**
 * @returns {boolean} True if a character or group chat is currently active.
 */
function isChatActive() {
    const ctx = SillyTavern.getContext();
    return !!(ctx.groupId || ctx.characterId !== undefined);
}

/**
 * Returns the extension's UI settings (global, not chat-specific).
 */
function getUiSettings() {
    const ctx = SillyTavern.getContext();
    const { extensionSettings } = ctx;

    if (!extensionSettings[UI_SETTINGS_KEY]) {
        extensionSettings[UI_SETTINGS_KEY] = structuredClone(DEFAULT_UI);
    }
    for (const key of Object.keys(DEFAULT_UI)) {
        if (!Object.hasOwn(extensionSettings[UI_SETTINGS_KEY], key)) {
            extensionSettings[UI_SETTINGS_KEY][key] = structuredClone(DEFAULT_UI[key]);
        }
    }

    return extensionSettings[UI_SETTINGS_KEY];
}

/**
 * Gets the current chat's Status Note object (merged with defaults).
 * Does not persist changes automatically.
 */
function getChatNote() {
    const ctx = SillyTavern.getContext();
    const raw = ctx.chatMetadata?.[CHAT_METADATA_KEY];
    const base = structuredClone(DEFAULT_NOTE);

    if (raw && typeof raw === 'object') {
        return Object.assign(base, raw);
    }

    return base;
}

/**
 * Writes a fully merged note object into chat metadata and schedules persistence.
 */
function setChatNote(note) {
    const ctx = SillyTavern.getContext();
    if (!ctx.chatMetadata) return;

    ctx.chatMetadata[CHAT_METADATA_KEY] = Object.assign(structuredClone(DEFAULT_NOTE), note);
    saveMetadataDebounced();
}

/**
 * Applies a partial update to the chat note and schedules persistence.
 */
function patchChatNote(patch) {
    setChatNote(Object.assign(getChatNote(), patch));
}

/**
 * Best-effort migration from earlier versions that used extensionSettings.
 * Runs only when chat metadata doesn't have `status_note` yet.
 */
function tryMigrateLegacySettings() {
    const ctx = SillyTavern.getContext();
    const legacy = ctx.extensionSettings?.[MODULE_NAME];
    if (!legacy || typeof legacy !== 'object') return null;

    // v1.0.x branch-aware profiles
    const chatId = ctx.chatId || 'nochat';
    const baseKey = ctx.groupId ? `group:${ctx.groupId}` : (getCharaFilename?.() ?? null);
    if (baseKey && legacy.profiles && typeof legacy.profiles === 'object') {
        const scopeKey = (ctx.groupId)
            ? `group:${ctx.groupId}::chat:${chatId}`
            : `char:${baseKey}::chat:${chatId}`;

        const profile = legacy.profiles?.[scopeKey];
        if (profile && typeof profile === 'object') {
            return {
                prompt: String(profile.prompt ?? ''),
                include_worldInfo: !!profile.allowWIScan,
                depth: Number(profile.depth ?? DEFAULT_NOTE.depth),
                role: Number(profile.role ?? DEFAULT_NOTE.role),
                enabled: !!profile.enabled,
            };
        }
    }

    // v1.0.x simple per-character prompt + global options
    if (legacy.prompts && typeof legacy.prompts === 'object') {
        const key = ctx.groupId ? `group:${ctx.groupId}` : (getCharaFilename?.() ?? null);
        const prompt = key ? String(legacy.prompts[key] ?? '') : '';
        return {
            prompt,
            include_worldInfo: !!legacy.allowWIScan,
            depth: Number(legacy.depth ?? DEFAULT_NOTE.depth),
            role: Number(legacy.role ?? DEFAULT_NOTE.role),
            enabled: !!legacy.enabled,
        };
    }

    return null;
}

/**
 * Ensures chat metadata has a valid `status_note` object (with defaults applied).
 */
function ensureChatMetadataInitialized() {
    const ctx = SillyTavern.getContext();
    if (!ctx.chatMetadata) return;

    if (!ctx.chatMetadata[CHAT_METADATA_KEY]) {
        const migrated = tryMigrateLegacySettings();
        setChatNote(migrated ?? DEFAULT_NOTE);
        return;
    }

    // Normalize missing keys after updates
    setChatNote(getChatNote());
}

/**
 * Clears injection completely.
 */
function clearInjection() {
    const ctx = SillyTavern.getContext();
    ctx.setExtensionPrompt(MODULE_NAME, '', extension_prompt_types.NONE, MAX_INJECTION_DEPTH);
}

/**
 * Applies Status Note injection based on current chat metadata.
 */
function applyInjection() {
    const ctx = SillyTavern.getContext();

    if (!isChatActive()) {
        clearInjection();
        return;
    }

    const note = getChatNote();

    if (!note.enabled || !String(note.prompt ?? '').trim()) {
        clearInjection();
        return;
    }

    const positionInChat = 1;

    ctx.setExtensionPrompt(
        MODULE_NAME,
        String(note.prompt),
        positionInChat,
        Number(note.depth ?? DEFAULT_NOTE.depth),
        !!note.include_worldInfo,
        Number(note.role ?? DEFAULT_NOTE.role),
    );
}

function showWindow() {
    const ui = getUiSettings();
    const $w = $('#statusNoteFloating');
    if ($w.length === 0) return;

    if ($w.css('display') !== 'flex') {
        $w.addClass('resizing');
        $w.css('display', 'flex');
        $w.css('opacity', 0.0);

        $w.transition({ opacity: 1.0, duration: animation_duration }, async function () {
            await delay(50);
            $w.removeClass('resizing');
        });
    }

    ui.windowOpen = true;
    saveSettingsDebounced();
}

function hideWindow() {
    const ui = getUiSettings();
    const $w = $('#statusNoteFloating');
    if ($w.length === 0) return;

    if ($w.css('display') === 'flex') {
        $w.addClass('resizing');
        $w.transition({ opacity: 0.0, duration: animation_duration }, async function () {
            await delay(50);
            $w.css('display', 'none');
            $w.removeClass('resizing');
        });
    }

    ui.windowOpen = false;
    saveSettingsDebounced();
}

const setTokenCounterDebounced = debounce(async (value) => {
    const count = await getTokenCountAsync(String(value ?? ''));
    $('#statusNoteTokenCounter').text(count);
}, 250);

/**
 * Syncs the UI from current chat metadata and reapplies prompt injection.
 */
function syncUiFromChat() {
    const ui = getUiSettings();

    if (!isChatActive()) {
        $('#statusNoteEnabled').prop('checked', false);
        $('#statusNoteAllowWIScan').prop('checked', false);
        $('#statusNoteDepth').val(DEFAULT_NOTE.depth);
        $('#statusNoteRole').val(String(DEFAULT_NOTE.role));
        $('#statusNoteText').val('');
        setTokenCounterDebounced('');
        clearInjection();
        hideWindow();
        return;
    }

    ensureChatMetadataInitialized();
    const note = getChatNote();

    $('#statusNoteEnabled').prop('checked', !!note.enabled);
    $('#statusNoteAllowWIScan').prop('checked', !!note.include_worldInfo);
    $('#statusNoteDepth').val(Number(note.depth ?? DEFAULT_NOTE.depth));
    $('#statusNoteRole').val(String(Number(note.role ?? DEFAULT_NOTE.role)));
    $('#statusNoteText').val(String(note.prompt ?? ''));
    setTokenCounterDebounced(note.prompt ?? '');

    if (ui.windowOpen) showWindow();
    else hideWindow();

    applyInjection();
}

function bindUiHandlers() {
    $('#status_note_menu_item').on('click', () => {
        if (!isChatActive()) {
            if (window.toastr?.warning) toastr.warning('Select a character or a group chat first.');
            return;
        }

        const $w = $('#statusNoteFloating');
        if ($w.css('display') === 'flex') hideWindow();
        else showWindow();
    });

    $('#statusNoteClose').on('click', () => hideWindow());

    $('#statusNoteText').on('input', function () {
        const v = String($(this).val() ?? '');
        patchChatNote({ prompt: v });
        setTokenCounterDebounced(v);
        applyInjection();
    });

    $('#statusNoteEnabled').on('input', function () {
        patchChatNote({ enabled: !!$(this).prop('checked') });
        applyInjection();
    });

    $('#statusNoteAllowWIScan').on('input', function () {
        patchChatNote({ include_worldInfo: !!$(this).prop('checked') });
        applyInjection();
    });

    $('#statusNoteDepth').on('input', function () {
        let depth = Number($(this).val());
        if (!Number.isFinite(depth)) depth = DEFAULT_NOTE.depth;
        if (depth < 0) depth = Math.abs(depth);
        $(this).val(depth);

        patchChatNote({ depth });
        applyInjection();
    });

    $('#statusNoteRole').on('change input', function () {
        const role = Number($(this).val());
        patchChatNote({ role });
        applyInjection();
    });
}

async function renderUi() {
    const buttonHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'button');
    $('#extensionsMenu').append(buttonHtml);

    const windowHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'window');
    $('#movingDivs').append(windowHtml);

    bindUiHandlers();
    syncUiFromChat();
}

function bindEvents() {
    eventSource.on(event_types.CHAT_CHANGED, () => {
        syncUiFromChat();
    });

    // Keep injection fresh after prompt recombination (if event exists in the current ST build)
    if ('GENERATE_AFTER_COMBINE_PROMPTS' in event_types) {
        eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, () => {
            applyInjection();
        });
    }
}

(async function init() {
    await renderUi();
    bindEvents();
    applyInjection();
})();

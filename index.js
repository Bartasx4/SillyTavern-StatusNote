import {
    MAX_INJECTION_DEPTH,
    animation_duration,
    extension_prompt_roles,
    extension_prompt_types,
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../../script.js';

import { renderExtensionTemplateAsync, getContext } from '../../../extensions.js';
import { debounce, delay, getCharaFilename } from '../../../utils.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { debounce_timeout } from '../../../constants.js';

export const MODULE_NAME = 'status_note';
const TEMPLATE_PATH = 'third-party/SillyTavern-StatusNote';

const defaultProfile = Object.freeze({
    enabled: false,
    allowWIScan: false,
    depth: 4,
    role: extension_prompt_roles.SYSTEM,
    prompt: '',
});

const defaultSettings = Object.freeze({
    windowOpen: false,
    profiles: {},
    lastProfileByBase: {},

    // legacy fields from previous version (kept for migration)
    enabled: false,
    allowWIScan: false,
    depth: 4,
    role: extension_prompt_roles.SYSTEM,
    prompts: {},
});

// ------------------------------
// Settings helpers
// ------------------------------

function getSettings() {
    const ctx = SillyTavern.getContext();
    const { extensionSettings } = ctx;

    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }

    for (const k of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], k)) {
            extensionSettings[MODULE_NAME][k] = structuredClone(defaultSettings[k]);
        }
    }

    if (typeof extensionSettings[MODULE_NAME].profiles !== 'object' || extensionSettings[MODULE_NAME].profiles === null) {
        extensionSettings[MODULE_NAME].profiles = {};
    }

    if (typeof extensionSettings[MODULE_NAME].lastProfileByBase !== 'object' || extensionSettings[MODULE_NAME].lastProfileByBase === null) {
        extensionSettings[MODULE_NAME].lastProfileByBase = {};
    }

    if (typeof extensionSettings[MODULE_NAME].prompts !== 'object' || extensionSettings[MODULE_NAME].prompts === null) {
        extensionSettings[MODULE_NAME].prompts = {};
    }

    return extensionSettings[MODULE_NAME];
}

function cloneProfile(profile = {}) {
    return {
        enabled: !!profile.enabled,
        allowWIScan: !!profile.allowWIScan,
        depth: Number.isFinite(Number(profile.depth)) ? Number(profile.depth) : 4,
        role: Number.isFinite(Number(profile.role)) ? Number(profile.role) : extension_prompt_roles.SYSTEM,
        prompt: String(profile.prompt ?? ''),
    };
}

function getBaseKey() {
    const context = getContext();

    if (context.groupId) {
        return `group:${context.groupId}`;
    }

    if (context.characterId === undefined || context.characterId === null) {
        return null;
    }

    const fn = getCharaFilename?.();
    if (!fn) return null;

    return `char:${fn}`;
}

function getScopeKey() {
    const context = getContext();
    const baseKey = getBaseKey();
    if (!baseKey) return null;

    // chatId acts as branch identifier (different branches = different chat files/IDs)
    const chatId = context.chatId || 'nochat';
    return `${baseKey}::chat:${chatId}`;
}

/**
 * Creates the current branch profile if missing.
 * Priority:
 * 1) exact profile exists -> use it
 * 2) clone last used profile for same base (branch inheritance)
 * 3) migrate from legacy settings (old version)
 * 4) default profile
 */
function ensureCurrentProfile() {
    const settings = getSettings();
    const baseKey = getBaseKey();
    const scopeKey = getScopeKey();

    if (!baseKey || !scopeKey) return null;

    if (settings.profiles[scopeKey]) {
        settings.lastProfileByBase[baseKey] = scopeKey;
        return settings.profiles[scopeKey];
    }

    let seeded = null;

    // 1) Inherit from last used branch of same character/group (preferred)
    const previousScopeKey = settings.lastProfileByBase[baseKey];
    if (previousScopeKey && settings.profiles[previousScopeKey]) {
        seeded = cloneProfile(settings.profiles[previousScopeKey]);
    }

    // 2) Legacy migration (older version stored global options + per-char prompt)
    if (!seeded) {
        const legacyPromptKey = baseKey.startsWith('group:')
            ? baseKey.replace('group:', 'group:')
            : baseKey.replace('char:', '');

        const legacyPrompt = baseKey.startsWith('char:')
            ? String(settings.prompts?.[legacyPromptKey] ?? '')
            : String(settings.prompts?.[legacyPromptKey] ?? '');

        seeded = {
            enabled: !!settings.enabled,
            allowWIScan: !!settings.allowWIScan,
            depth: Number(settings.depth ?? 4),
            role: Number(settings.role ?? extension_prompt_roles.SYSTEM),
            prompt: legacyPrompt,
        };
    }

    settings.profiles[scopeKey] = cloneProfile(seeded || defaultProfile);
    settings.lastProfileByBase[baseKey] = scopeKey;
    saveSettingsDebounced();

    return settings.profiles[scopeKey];
}

function getCurrentProfile() {
    return ensureCurrentProfile();
}

function updateCurrentProfile(mutator) {
    const profile = ensureCurrentProfile();
    if (!profile) return;

    mutator(profile);

    const baseKey = getBaseKey();
    const scopeKey = getScopeKey();
    const settings = getSettings();

    if (baseKey && scopeKey) {
        settings.lastProfileByBase[baseKey] = scopeKey;
    }

    saveSettingsDebounced();
}

// ------------------------------
// Injection
// ------------------------------

function clearInjection() {
    const context = getContext();
    context.setExtensionPrompt(MODULE_NAME, '', extension_prompt_types.NONE, MAX_INJECTION_DEPTH);
}

function applyInjection() {
    const context = getContext();
    const profile = getCurrentProfile();

    if (!profile) {
        clearInjection();
        return;
    }

    if (!profile.enabled) {
        clearInjection();
        return;
    }

    if (!context.groupId && (context.characterId === undefined || context.characterId === null)) {
        clearInjection();
        return;
    }

    const prompt = String(profile.prompt ?? '');
    if (!prompt.trim()) {
        clearInjection();
        return;
    }

    // Always "In-chat"
    const positionInChat = 1;

    context.setExtensionPrompt(
        MODULE_NAME,
        prompt,
        positionInChat,
        Number(profile.depth ?? 4),
        !!profile.allowWIScan,
        Number(profile.role ?? extension_prompt_roles.SYSTEM),
    );
}

// ------------------------------
// UI
// ------------------------------

function showWindow() {
    const settings = getSettings();
    const $w = $('#statusNoteFloating');
    if ($w.length === 0) return;

    if ($w.css('display') !== 'flex') {
        $w.addClass('resizing');
        $w.css('display', 'flex');
        $w.css('opacity', 0.0);
        $w.transition(
            { opacity: 1.0, duration: animation_duration },
            async function () {
                await delay(50);
                $w.removeClass('resizing');
            },
        );
    }

    settings.windowOpen = true;
    saveSettingsDebounced();
}

function hideWindow() {
    const settings = getSettings();
    const $w = $('#statusNoteFloating');
    if ($w.length === 0) return;

    if ($w.css('display') === 'flex') {
        $w.addClass('resizing');
        $w.transition(
            { opacity: 0.0, duration: animation_duration },
            async function () {
                await delay(50);
                $w.css('display', 'none');
                $w.removeClass('resizing');
            },
        );
    }

    settings.windowOpen = false;
    saveSettingsDebounced();
}

const setTokenCounterDebounced = debounce(
    async (value) => {
        const count = await getTokenCountAsync(String(value ?? ''));
        $('#statusNoteTokenCounter').text(count);
    },
    debounce_timeout.relaxed,
);

function syncUIFromSettingsAndContext() {
    const settings = getSettings();
    const profile = getCurrentProfile();

    if (!profile) {
        $('#statusNoteEnabled').prop('checked', false);
        $('#statusNoteAllowWIScan').prop('checked', false);
        $('#statusNoteDepth').val(4);
        $('#statusNoteRole').val(String(extension_prompt_roles.SYSTEM));
        $('#statusNoteText').val('');
        setTokenCounterDebounced('');
        hideWindow();
        clearInjection();
        return;
    }

    $('#statusNoteEnabled').prop('checked', !!profile.enabled);
    $('#statusNoteAllowWIScan').prop('checked', !!profile.allowWIScan);
    $('#statusNoteDepth').val(Number(profile.depth ?? 4));
    $('#statusNoteRole').val(String(Number(profile.role ?? extension_prompt_roles.SYSTEM)));
    $('#statusNoteText').val(String(profile.prompt ?? ''));

    setTokenCounterDebounced(profile.prompt ?? '');

    if (settings.windowOpen) showWindow();
    else hideWindow();

    applyInjection();
}

function bindUI() {
    $('#status_note_menu_item').on('click', () => {
        const $w = $('#statusNoteFloating');
        if ($w.css('display') === 'flex') hideWindow();
        else showWindow();
    });

    $('#statusNoteClose').on('click', () => hideWindow());

    $('#statusNoteText').on('input', function () {
        const v = String($(this).val() ?? '');
        updateCurrentProfile((p) => {
            p.prompt = v;
        });
        setTokenCounterDebounced(v);
        applyInjection();
    });

    $('#statusNoteEnabled').on('input', function () {
        const checked = !!$(this).prop('checked');
        updateCurrentProfile((p) => {
            p.enabled = checked;
        });
        applyInjection();
    });

    $('#statusNoteAllowWIScan').on('input', function () {
        const checked = !!$(this).prop('checked');
        updateCurrentProfile((p) => {
            p.allowWIScan = checked;
        });
        applyInjection();
    });

    $('#statusNoteDepth').on('input', function () {
        let value = Number($(this).val());
        if (Number.isNaN(value)) value = 4;
        if (value < 0) value = Math.abs(value);
        $(this).val(value);

        updateCurrentProfile((p) => {
            p.depth = value;
        });

        applyInjection();
    });

    $('#statusNoteRole').on('change input', function () {
        const value = Number($(this).val());

        updateCurrentProfile((p) => {
            p.role = value;
        });

        applyInjection();
    });
}

async function renderUI() {
    const buttonHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'button');
    $('#extensionsMenu').append(buttonHtml);

    const windowHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'window');
    $('#movingDivs').append(windowHtml);

    bindUI();
    syncUIFromSettingsAndContext();
}

function bindEvents() {
    // Triggered when switching character/chat/branch
    eventSource.on(event_types.CHAT_CHANGED, () => {
        syncUIFromSettingsAndContext();
    });

    if ('GENERATE_AFTER_COMBINE_PROMPTS' in event_types) {
        eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, () => {
            applyInjection();
        });
    }
}

(async function init() {
    getSettings();
    await renderUI();
    bindEvents();
    applyInjection();
})();
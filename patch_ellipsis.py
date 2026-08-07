"""Patch EllipsisLM to use a local OpenAI-compatible TTS server (Higgs bridge).

Two things are fixed here:

1. EllipsisLM's NanoGPT TTS path is already a generic OpenAI /v1/audio/speech
   call that handles a raw binary audio response -- only the URL is hardcoded.
   This adds a "Custom API URL" setting.

2. UPSTREAM BUG: the "TTS Backend" buttons carry data-action="select-tts-backend"
   but no handler is ever registered for it, so clicking them does nothing and
   globalSettings.ttsBackend can never leave 'gemini'. This registers the
   missing handler.

Each edit is independently guarded, so re-running is safe and an already-patched
file can still receive newly added edits.

Usage:  python patch_ellipsis.py [path/to/index.html]
"""
import sys, shutil, datetime

path = sys.argv[1] if len(sys.argv) > 1 else r"D:\AI\ellipsislm\index.html"
src = open(path, encoding="utf-8").read()
orig = src
applied, skipped = [], []


def edit(name, marker, anchor, replacement):
    """Apply one edit unless `marker` shows it is already present."""
    global src
    if marker in src:
        skipped.append(name)
        return
    n = src.count(anchor)
    if n != 1:
        raise SystemExit(
            f"FAILED on '{name}': anchor matched {n} times, expected 1.\n"
            f"Upstream probably moved this code. Anchor was:\n{anchor[:200]}")
    src = src.replace(anchor, replacement)
    applied.append(name)


# 1. settings default -------------------------------------------------------
a = "                    nanoGPTTTSVoice: 'nova',\n"
edit("settings default", "nanoGPTTTSBaseUrl:", a,
     a + "                    nanoGPTTTSBaseUrl: '',\n")

# 2. persisted settings list ------------------------------------------------
a = "'nanoGPTTTSModel', 'nanoGPTTTSVoice', 'musicNanoGPTModel'"
edit("persist list", "'nanoGPTTTSBaseUrl'", a,
     "'nanoGPTTTSModel', 'nanoGPTTTSVoice', 'musicNanoGPTModel',\n"
     "                    'nanoGPTTTSBaseUrl'")

# 3. UI field ---------------------------------------------------------------
a = ('                                <option value="shimmer">Shimmer</option>\n'
     '                            </select>\n'
     '                        </div>\n')
edit("custom url field", 'id="nanogpt-tts-baseurl-input"', a, a + '''                        <div>
                            <label class="text-gray-400 text-sm block mb-1">Custom API URL (optional)</label>
                            <input type="text" id="nanogpt-tts-baseurl-input" data-setting-key="nanoGPTTTSBaseUrl"
                                placeholder="http://127.0.0.1:8123/v1/audio/speech"
                                class="w-full rounded-lg p-2 bg-gray-700 border border-gray-600 text-white focus:border-violet-500">
                            <p class="text-xs text-gray-500 mt-1">Point at any OpenAI-compatible TTS server. Leave blank to use NanoGPT. No API key needed for local servers.</p>
                        </div>
''')

# 4. key check becomes optional for custom URLs -----------------------------
a = """                const apiKey = global.nanoGPTKey;
                if (!apiKey) {
                    UIManager.showNotification("TTS Error: NanoGPT API Key missing in Settings.", "error");
                    return;
                }"""
edit("optional api key", "const ttsUrl =", a, """                const apiKey = global.nanoGPTKey;
                const ttsUrl = (global.nanoGPTTTSBaseUrl || '').trim()
                    || 'https://nano-gpt.com/api/v1/audio/speech';
                const isCustom = ttsUrl.indexOf('nano-gpt.com') === -1;
                if (!apiKey && !isCustom) {
                    UIManager.showNotification("TTS Error: NanoGPT API Key missing in Settings.", "error");
                    return;
                }""")

# 5. fetch the configured URL ----------------------------------------------
a = "                    const res = await fetch('https://nano-gpt.com/api/v1/audio/speech', {"
edit("fetch url", "await fetch(ttsUrl,", a,
     "                    const res = await fetch(ttsUrl, {")

# 6. persist the field on input --------------------------------------------
a = "                if (document.getElementById('nanogpt-api-key-input')) setListener('nanogpt-api-key-input', 'nanoGPTKey');"
edit("input listener", "'nanogpt-tts-baseurl-input', 'nanoGPTTTSBaseUrl'", a,
     a + "\n                if (document.getElementById('nanogpt-tts-baseurl-input')) setListener('nanogpt-tts-baseurl-input', 'nanoGPTTTSBaseUrl');")

# 7. register the missing select-tts-backend handler (upstream bug) ---------
a = "                ActionHandler.register('open-hub', () => HubController.openHub());"
edit("tts backend handler", "register('select-tts-backend'", a, a + """

                // Upstream ships the TTS Backend buttons with no handler, so
                // clicking them does nothing and ttsBackend is stuck on gemini.
                ActionHandler.register('select-tts-backend', (ds, val) => {
                    const gs = StateManager.data.globalSettings;
                    gs.ttsBackend = val || 'gemini';
                    AppController._syncTtsBackendUI();
                    StateManager.saveGlobalSettings();
                });
                AppController._syncTtsBackendUI = function () {
                    const gs = StateManager.data.globalSettings;
                    const active = gs.ttsBackend || 'gemini';
                    document.querySelectorAll('#tts-backend-selector .tts-backend-option')
                        .forEach(b => b.classList.toggle('active', b.dataset.actionVal === active));
                    const gem = document.getElementById('tts-gemini-panel');
                    const nano = document.getElementById('tts-nanogpt-panel');
                    if (gem) gem.classList.toggle('hidden', active !== 'gemini');
                    if (nano) nano.classList.toggle('hidden', active !== 'nanogpt');
                };
                // Reflect the persisted choice once settings have loaded.
                setTimeout(() => { try { AppController._syncTtsBackendUI(); } catch (e) {} }, 1200);""")

# 8. "Manual" TTS mode so auto-play can be turned off -----------------------
a = '''                            <option value="off">Off</option>
                            <option value="all">Read Everything</option>
                            <option value="dialogue">Dialogue Only</option>'''
edit("manual tts mode option", 'value="manual"', a, a + '''
                            <option value="manual">Manual (button only)</option>''')

# 9. gate the automatic trigger on the new mode -----------------------------
a = "                    if (ttsMode !== 'off' && typeof TTSService !== 'undefined') {"
edit("gate autoplay", "ttsMode !== 'manual'", a,
     "                    if (ttsMode !== 'off' && ttsMode !== 'manual' && typeof TTSService !== 'undefined') {")

# 10. per-message speak button ----------------------------------------------
a = '''                                <button data-action="chat-copy" data-index="${historyIndex}" class="hover:text-blue-400" title="Copy to Clipboard">'''
edit("speak button", 'data-action="tts-speak-message"', a,
     '''                                <button data-action="tts-speak-message" data-index="${historyIndex}" class="hover:text-violet-400" title="Speak / Stop">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072M17.95 6.05a8 8 0 010 11.9M11 5L6 9H2v6h4l5 4V5z"></path></svg>
                                </button>
''' + a)

# 10b. speak button in the STANDARD chat bubble ------------------------------
# Edit 10 covers the VN-mode HUD only; normal chat renders its own action row.
a = '''                        <button data-action="chat-edit" data-index="${index}" class="text-gray-400 hover:text-white" title="Edit">'''
edit("speak button (chat bubble)", 'data-action="tts-speak-message" data-index="${index}"', a,
     '''                        <button data-action="tts-speak-message" data-index="${index}" class="text-gray-400 hover:text-violet-400" title="Speak / Stop"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072M17.95 6.05a8 8 0 010 11.9M11 5L6 9H2v6h4l5 4V5z"></path></svg></button>
''' + a)

# 11. handler for the speak button ------------------------------------------
a = "                ActionHandler.register('open-hub', () => HubController.openHub());"
edit("speak handler", "register('tts-speak-message'", a, a + """

                // Play/stop a single message on demand. Mirrors the dialogue
                // extraction the automatic path uses so both sound the same.
                ActionHandler.register('tts-speak-message', (ds, val, ev) => {
                    if (typeof TTSService === 'undefined') return;
                    const btn = ev && ev.target && ev.target.closest
                        ? ev.target.closest('[data-action="tts-speak-message"]') : null;
                    const clearBusy = () => document
                        .querySelectorAll('[data-action="tts-speak-message"]')
                        .forEach(b => b.classList.remove('animate-pulse', 'text-amber-400', 'text-violet-400'));
                    if (TTSService.RUNTIME && TTSService.RUNTIME.isPlaying) {
                        TTSService.stop();
                        clearBusy();
                        return;
                    }
                    const st = StateManager.getState();
                    const msg = (st.chat_history || [])[parseInt(ds.index, 10)];
                    if (!msg || !msg.content) return;

                    const gs = StateManager.data.globalSettings;
                    const scope = gs.ttsManualScope || 'dialogue';
                    let text = msg.content;
                    if (scope === 'dialogue') {
                        const out = []; const rx = /"([^"]+)"|\\u201c([^\\u201d]+)\\u201d/g; let m;
                        while ((m = rx.exec(text)) !== null) { if (m[1]) out.push(m[1]); if (m[2]) out.push(m[2]); }
                        text = out.length ? out.join('. ... ') : text;
                    } else if (scope === 'narration') {
                        // Everything OUTSIDE quotes, with *action asterisks* stripped.
                        text = text.replace(/"[^"]*"|\\u201c[^\\u201d]*\\u201d/g, ' ')
                                   .replace(/\\*/g, ' ')
                                   .replace(/\\s{2,}/g, ' ')
                                   .trim();
                    }
                    let voice = 'Puck';
                    const ch = ReactiveStore.getCharacter(msg.character_id);
                    if (ch && ch.ttsVoice) voice = ch.ttsVoice;
                    else if (gs.ttsVoice) voice = gs.ttsVoice;
                    if (!text || !text.trim()) return;

                    // Visual feedback: amber pulse while the bridge renders,
                    // steady violet while it plays. Re-applied on a timer and
                    // looked up by data-index, because renderChat() replaces the
                    // button node and would otherwise drop the classes.
                    const idx = String(ds.index);
                    const findBtn = () => document.querySelector(
                        '[data-action="tts-speak-message"][data-index="' + idx + '"]');
                    let phase = 'rendering';
                    clearBusy();
                    const tick = setInterval(() => {
                        const b = findBtn();
                        if (!b) return;
                        b.classList.toggle('animate-pulse', phase === 'rendering');
                        b.classList.toggle('text-amber-400', phase === 'rendering');
                        b.classList.toggle('text-violet-400', phase === 'playing');
                    }, 200);
                    const finish = () => { clearInterval(tick); clearBusy(); };

                    Promise.resolve(TTSService.speak(text, voice))
                        .then(() => {
                            phase = 'playing';
                            const poll = setInterval(() => {
                                if (!TTSService.RUNTIME || !TTSService.RUNTIME.isPlaying) {
                                    clearInterval(poll);
                                    finish();
                                }
                            }, 400);
                            setTimeout(() => { clearInterval(poll); finish(); }, 15 * 60 * 1000);
                        })
                        .catch(finish);
                });""")

# 12. teach every character to write voice cues (applies to ALL cards) ------
# Editable in Settings -> TTS -> Voice Prompt, so it is not buried in the file.
a = '''                    prompt += "### FORMATTING GUIDELINE\\nWrite in roleplay style. Use asterisks for actions (*) and plain text for speech.\\n\\n";
                }'''
edit("voice cue instructions", "VOICE PERFORMANCE", a, a + '''

                // Injected globally so cue markup works on every character card
                // without per-card setup. Only added when TTS is actually on.
                try {
                    const _tts = StateManager.data.globalSettings || {};
                    if ((_tts.ttsMode || 'off') !== 'off') {
                        const _vp = (_tts.voiceCuePrompt || '').trim() || DEFAULT_VOICE_PROMPT;
                        prompt += "### VOICE PERFORMANCE\\n" + _vp + "\\n\\n";
                    }
                } catch (e) {}''')

# 12b. the default prompt text, exposed as a global so the UI can reset to it
a = "        const ActionHandler = {"
# marker must match the DEFINITION, not the references edit 12 already added
edit("default voice prompt const", "const DEFAULT_VOICE_PROMPT", a, '''        const DEFAULT_VOICE_PROMPT = [
            "Your dialogue is READ ALOUD, so write it the way people actually talk, not the way prose reads.",
            "- Short sentences. Fragments are good. Not every line needs a subject and a verb.",
            "- Use contractions always. Interrupt yourself, trail off, restart a thought.",
            "- Occasional filler is good: well, I mean, okay so, look, honestly.",
            "- React before you explain. Avoid literary or ornate phrasing in spoken lines.",
            "",
            "Inside your spoken lines add short stage directions in square brackets so the voice knows how to perform them. Use 3-5 per reply and change the mood as feelings shift.",
            "Pick cues that match how this character actually feels right now - their current mood, their private thoughts, and any character stats shown above. A character with low trust should not sound [affectionate]; a tired one should not sound [excited]. If a stat is high or low enough to change their mood, let the cues show it before the words do.",
            "Available: [giggles] [chuckles] [laughs] [laughs hard] [trying not to laugh] [sighs] [groans] [gasps] [whispers] [shouts] [pause] [long pause] [teasing] [amused] [affectionate] [breathless] [longing] [confused] [excited] [angry] [sad] [surprised] [nervous] [thoughtful] [proud] [embarrassed]",
            "Put the brackets INSIDE the quotation marks. Never use code blocks, backticks, or indentation for dialogue.",
            "Example: \\"[amused] Wait, seriously? [giggles] No, that's — okay that's actually kind of great. [pause] [teasing] You're never living it down, though.\\""
        ].join("\\n");

''' + a)

# 12c. SAME injection in buildDefaultPrompt -- this is the path normal replies
# actually take. buildSwarmCharacterResponsePrompt (edit 12) only runs in swarm
# mode, so patching it alone left ordinary generations with no cue instructions.
a = '''                p += " Do not repeat the character's name in the response itself.\\n### " + components.charToAct.name + ":";'''
edit("voice cues in default prompt", "VOICE PERFORMANCE (default)", a, '''                try {
                    const _tts = StateManager.data.globalSettings || {};
                    if ((_tts.ttsMode || 'off') !== 'off') {
                        const _vp = (_tts.voiceCuePrompt || '').trim() || DEFAULT_VOICE_PROMPT;
                        p += "\\n\\n### VOICE PERFORMANCE (default)\\n" + _vp + "\\n\\n";
                    }
                } catch (e) {}
''' + a)

# 12d. UPSTREAM BUG: buildPrompt returns {text, images} but the raw-prompt
# viewer stores the object and renders it, giving "[object Object]".
a = """                        prompt: prompt, // The actual string"""
edit("raw prompt viewer fix", "prompt.text : prompt,", a,
     """                        prompt: (prompt && typeof prompt === 'object' && 'text' in prompt) ? prompt.text : prompt,""")

# 13. Voice Prompt editor + manual-button scope, in the TTS panel -----------
a = '''                        <div>
                            <label class="text-gray-400 text-sm block mb-1">Custom API URL (optional)</label>'''
edit("voice prompt ui", 'id="tts-voice-prompt-input"', a, '''                        <div>
                            <label class="text-gray-400 text-sm block mb-1">Manual button reads</label>
                            <select id="tts-manual-scope-select"
                                class="w-full rounded-lg p-2 bg-gray-700 border border-gray-600 text-white focus:border-violet-500">
                                <option value="dialogue">Voice only (text in quotes)</option>
                                <option value="narration">Narration only (text outside quotes)</option>
                                <option value="all">Both</option>
                            </select>
                            <p class="text-xs text-gray-500 mt-1">What the per-message speaker button plays.</p>
                        </div>
                        <details class="rounded-lg border border-gray-600 bg-black/20 p-3">
                            <summary class="text-sm font-semibold text-gray-300 cursor-pointer">Edit Prompt Template &mdash; Voice Prompt</summary>
                            <p class="text-xs text-gray-500 mt-2 mb-1">Sent to the model on every character reply while TTS is on, so cue markup works on all character cards. Blank restores the default.</p>
                            <textarea id="tts-voice-prompt-input" rows="10"
                                class="w-full rounded-lg p-2 bg-gray-900 border border-gray-600 text-white text-xs font-mono focus:border-violet-500"
                                placeholder="(using built-in default)"></textarea>
                            <button data-action="tts-reset-voice-prompt" class="mt-2 text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200">Reset to default</button>
                        </details>
''' + a)

# 13b. defaults + persistence for the two new settings ---------------------
a = "                    nanoGPTTTSBaseUrl: '',\n"
edit("new setting defaults", "voiceCuePrompt:", a,
     a + "                    voiceCuePrompt: '',\n"
         "                    ttsManualScope: 'dialogue',\n")

a = "                    'nanoGPTTTSBaseUrl'"
edit("new setting persist", "'voiceCuePrompt'", a,
     "                    'nanoGPTTTSBaseUrl', 'voiceCuePrompt', 'ttsManualScope'")

# 13b2. populate the voice dropdown from the custom server ------------------
# Upstream hardcodes the OpenAI voice names, so a local server's own voices are
# unreachable from the UI. The bridge exposes them at /v1/models.
a = "                ActionHandler.register('open-hub', () => HubController.openHub());"
edit("voice list from server", "refreshCustomTtsVoices", a, a + """

                window.refreshCustomTtsVoices = async function () {
                    const gs = StateManager.data.globalSettings || {};
                    const base = (gs.nanoGPTTTSBaseUrl || '').trim();
                    const sel = document.getElementById('nanogpt-tts-voice-select');
                    if (!base || !sel) return;
                    try {
                        const url = base.replace(/\\/audio\\/speech\\/?$/, '/models');
                        const res = await fetch(url);
                        if (!res.ok) return;
                        const data = await res.json();
                        const voices = (data.data && data.data[0] && data.data[0].voices) || [];
                        if (!voices.length) return;
                        const current = gs.nanoGPTTTSVoice || sel.value;
                        sel.innerHTML = '';
                        voices.forEach(v => {
                            const o = document.createElement('option');
                            o.value = v; o.textContent = v;
                            sel.appendChild(o);
                        });
                        sel.value = voices.includes(current) ? current : voices[0];
                        gs.nanoGPTTTSVoice = sel.value;
                        StateManager.saveGlobalSettings();
                    } catch (e) { /* server not running yet; leave defaults */ }
                };
                ActionHandler.register('tts-refresh-voices', () => {
                    window.refreshCustomTtsVoices().then(() => {
                        if (typeof UIManager !== 'undefined' && UIManager.showNotification)
                            UIManager.showNotification('Voice list refreshed.', 'success');
                    });
                });""")

# 13b3. a refresh button next to the voice dropdown -------------------------
a = '''                        <div>
                            <label class="text-gray-400 text-sm block mb-1">Manual button reads</label>'''
edit("refresh voices button", 'data-action="tts-refresh-voices"', a,
     '''                        <button data-action="tts-refresh-voices" class="w-full text-xs px-2 py-1 rounded bg-violet-900/40 hover:bg-violet-800/60 text-violet-200">Load voices from custom server</button>
''' + a)

# 13c. wire the two controls ------------------------------------------------
a = "                if (document.getElementById('nanogpt-tts-baseurl-input')) setListener('nanogpt-tts-baseurl-input', 'nanoGPTTTSBaseUrl');"
edit("new setting listeners", "'tts-voice-prompt-input', 'voiceCuePrompt'", a, a + """
                if (document.getElementById('tts-voice-prompt-input')) setListener('tts-voice-prompt-input', 'voiceCuePrompt');
                if (document.getElementById('tts-manual-scope-select')) setListener('tts-manual-scope-select', 'ttsManualScope');
                // Show the current prompt when the section is expanded. Bound to
                // the toggle event rather than a timer so it cannot race the
                // settings load (which would blank the box again).
                (() => {
                    const _vp = document.getElementById('tts-voice-prompt-input');
                    const _ms = document.getElementById('tts-manual-scope-select');
                    const _gs = StateManager.data.globalSettings || {};
                    if (_ms) _ms.value = _gs.ttsManualScope || 'dialogue';
                    if (_vp && _vp.parentElement) {
                        const fill = () => {
                            if (!_vp.value.trim()) {
                                _vp.value = (StateManager.data.globalSettings.voiceCuePrompt || '').trim()
                                    || DEFAULT_VOICE_PROMPT;
                            }
                        };
                        _vp.parentElement.addEventListener('toggle', fill);
                        fill();
                    }
                    // Pull the local server's voice list once on boot.
                    setTimeout(() => {
                        if (window.refreshCustomTtsVoices) window.refreshCustomTtsVoices();
                    }, 1500);
                })();""")

a = "                ActionHandler.register('open-hub', () => HubController.openHub());"
edit("reset voice prompt action", "register('tts-reset-voice-prompt'", a, a + """

                ActionHandler.register('tts-reset-voice-prompt', () => {
                    StateManager.data.globalSettings.voiceCuePrompt = '';
                    const el = document.getElementById('tts-voice-prompt-input');
                    if (el) el.value = DEFAULT_VOICE_PROMPT;
                    StateManager.saveGlobalSettings();
                    if (typeof UIManager !== 'undefined' && UIManager.showNotification)
                        UIManager.showNotification('Voice prompt reset to default.', 'success');
                });""")

if src != orig:
    shutil.copy2(path, f"{path}.bak_{datetime.datetime.now():%Y%m%d_%H%M%S}")
    open(path, "w", encoding="utf-8").write(src)

print(f"applied: {applied or 'none'}")
print(f"already present: {skipped or 'none'}")
print(f"{path}  ({len(src)-len(orig):+d} chars)")

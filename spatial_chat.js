// spatial_chat.js

const SpatialChat = (function() {

    // --- Private State ---
    let _internalState = {
        player: { x: 0, y: 0, currentCity: null, currentArea: null },
        npcs: [], // Array of { id, name, x, y, personality, currentCity, currentArea }
        cities: {}, // { cityName: { areaName1: {}, areaName2: {} } }
        messages: {}, // { 'scope-key': ['<Author> msg', '<Author> msg2', ...] }
        isInitialized: false,
        isActive: false,
    };

    let _config = {
        proxyProviderId: 'BIGMODEL_PROXY', // Ensure this matches api_providers.js
        proxyModelId: 'glm-4-flash',       // Model for the proxy
        botIntervalMs: 15000,             // Default: 15 seconds
        generalChatRange: 50,
        maxMessagesPerScope: 100,
        maxContextTurns: 5,
        aiSpeakChance: 0.20,              // Increased chance for testing
    };

    let _botIntervalId = null;
    let _apiProviderFunction = null; // Reference to window.getApiResponse

    // --- Private Utility Functions ---

    function _log(message, level = 'log') {
        console[level](`[SpatialChat] ${message}`);
    }

    function _calculateDistance(x1, y1, x2, y2) {
        // Avoid sqrt for simple comparison if needed, but fine for now
        return Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2));
    }

    // --- Scope/Context Key Generation ---
    function _getScopeKey(scope, city = null, area = null) {
        city = city || _internalState.player.currentCity;
        area = area || _internalState.player.currentArea;

        switch (scope) {
            case 'General': return city && area ? `general-${city}-${area}` : null;
            case 'Area':    return city && area ? `area-${city}-${area}` : null;
            case 'City':    return city ? `city-${city}` : null;
            case 'World':   return 'world';
            default:
                _log(`Invalid scope requested for key generation: ${scope}`, 'warn');
                return null;
        }
    }

    // --- AI Selection Logic ---
    function _getNpcsInScope(scope) {
        const { player, npcs } = _internalState;
        if (!player.currentCity) {
            // _log(`Cannot get NPCs for scope '${scope}': No current city.`, 'debug');
            return [];
        }

        let results = [];
        switch (scope) {
            case 'General':
                if (!player.currentArea) return [];
                results = npcs.filter(npc =>
                    npc.currentCity === player.currentCity &&
                    npc.currentArea === player.currentArea &&
                    _calculateDistance(player.x, player.y, npc.x, npc.y) <= _config.generalChatRange
                );
                // _log(`NPCs in General scope (${player.currentCity}-${player.currentArea}, range ${_config.generalChatRange}): ${results.map(n=>n.name).join(', ')}`, 'debug');
                break;
            case 'Area':
                 if (!player.currentArea) return [];
                results = npcs.filter(npc =>
                    npc.currentCity === player.currentCity &&
                    npc.currentArea === player.currentArea
                );
                // _log(`NPCs in Area scope (${player.currentCity}-${player.currentArea}): ${results.map(n=>n.name).join(', ')}`, 'debug');
                break;
            case 'City':
                results = npcs.filter(npc => npc.currentCity === player.currentCity);
                // _log(`NPCs in City scope (${player.currentCity}): ${results.map(n=>n.name).join(', ')}`, 'debug');
                break;
            case 'World':
                results = [...npcs]; // All loaded NPCs
                // _log(`NPCs in World scope: ${results.map(n=>n.name).join(', ')}`, 'debug');
                break;
            default:
                 _log(`Unknown scope for NPC selection: ${scope}`, 'warn');
                 results = [];
        }
        return results;
    }

     // --- Message Storage ---
     function _addMessage(scopeKey, author, text) {
        if (!scopeKey || typeof text !== 'string') { // Check type of text
             _log(`Skipping addMessage: Invalid key or text. Key: ${scopeKey}, Text: ${text}`, 'warn');
             return;
        }
        if (!_internalState.messages[scopeKey]) {
            _internalState.messages[scopeKey] = [];
        }
        const message = `<${author}> ${text.trim()}`; // Trim whitespace
        _internalState.messages[scopeKey].push(message);

        if (_internalState.messages[scopeKey].length > _config.maxMessagesPerScope) {
            _internalState.messages[scopeKey].shift();
        }
        // _log(`Added message to ${scopeKey}: ${message.substring(0, 50)}...`, 'debug');
        // No DOM rendering here
    }

    // --- AI Call ---
    async function _callAIProxy(prompt, personality) {
        if (!_apiProviderFunction) {
            _log("API provider function (window.getApiResponse) not available.", 'error');
            return null;
        }
        if (!_config.proxyProviderId || !_config.proxyModelId) {
            _log("Proxy provider or model ID not configured.", 'error');
            return null;
        }

        const messages = [
            { role: "system", content: personality || "You are an AI in a simulated world." },
            { role: "user", content: prompt }
        ];

        try {
            _log(`Calling proxy: ${_config.proxyProviderId}/${_config.proxyModelId}. Prompt length: ${prompt.length}`, 'debug');
            const response = await _apiProviderFunction(
                _config.proxyProviderId,
                _config.proxyModelId,
                messages,
                null, // API Key is null for proxy
                { temperature: 0.8 }
            );

            if (response === null || response.trim() === '') {
                 _log(`Proxy returned null or empty response.`, 'warn');
                 return null; // Treat empty as failure for bot chat
            }

            _log(`Proxy response received: "${response.substring(0, 60)}..."`, 'debug');
            return response;
        } catch (error) {
            _log(`Error calling AI proxy: ${error.message}`, 'error');
            console.error(error); // Log full error
            return null;
        }
    }


    // --- Autonomous Bot Logic ---
    async function _botTick() {
        if (!_internalState.isActive || !_internalState.isInitialized || !_internalState.player.currentCity) {
            // _log("Bot tick skipped: Inactive, not initialized, or no player city.", 'debug');
            return;
        }

        // 1. Select a scope where interaction might happen
        const availableScopes = ['General', 'Area', 'City', 'World'];
        // Weighted selection: Higher chance for local scopes
        const scopeRoll = Math.random();
        let chosenScope;
        if (scopeRoll < 0.4) chosenScope = 'General';       // 40% chance
        else if (scopeRoll < 0.7) chosenScope = 'Area';    // 30% chance
        else if (scopeRoll < 0.9) chosenScope = 'City';    // 20% chance
        else chosenScope = 'World';                         // 10% chance

        const scopeKey = _getScopeKey(chosenScope);
        if (!scopeKey) {
            // _log(`Bot tick skipped: Could not determine valid scope key for ${chosenScope}.`, 'debug');
            return; // Can't chat in this scope if player isn't in a valid location for it
        }

        // 2. Find NPCs relevant to that scope
        const potentialSpeakers = _getNpcsInScope(chosenScope);
        if (potentialSpeakers.length === 0) {
            // _log(`Bot tick skipped: No potential speakers found for scope ${chosenScope}.`, 'debug');
            return;
        }

        // 3. Check speak chance for each potential speaker in scope
        const speakersThisTick = potentialSpeakers.filter(npc => Math.random() < _config.aiSpeakChance);
        if (speakersThisTick.length === 0) {
             // _log(`Bot tick skipped: No speakers passed chance check for scope ${chosenScope}.`, 'debug');
            return;
        }

        // 4. Process *one* speaker this tick (to avoid spam)
        const speaker = speakersThisTick[Math.floor(Math.random() * speakersThisTick.length)];
         if (!speaker || !speaker.name || !speaker.personality) {
            _log(`Invalid speaker selected: ${JSON.stringify(speaker)}`, 'warn');
            return;
        }

        _log(`Bot Tick: Attempting action for ${speaker.name} in scope ${chosenScope} (${scopeKey})`);

        // 5. Get context
        const history = _internalState.messages[scopeKey] || [];
        const context = history.slice(-_config.maxContextTurns).join('\n') || `The #${chosenScope} chat is quiet.`;

        // 6. Generate Prompt
        const prompt = `You are ${speaker.name}, an AI character currently in area "${speaker.currentArea}" of city "${speaker.currentCity}".
Your personality: "${speaker.personality}".
You are participating in the #${chosenScope} chat scope. Player "${_internalState.player.name || 'Player'}" is at (${_internalState.player.x.toFixed(0)}, ${_internalState.player.y.toFixed(0)}) in area "${_internalState.player.currentArea}", city "${_internalState.player.currentCity}".
Keep your message very concise (usually 1 sentence, max 2) and strictly in character.
Do NOT greet, announce yourself, or use pleasantries unless it fits your personality exactly.
React naturally to the recent conversation, or say something relevant to your location/personality/theme if it's quiet. Avoid repeating yourself or others.

Recent Context (${chosenScope} Scope):
---
${context}
---

Your concise, in-character message:`;

        // 7. Call AI Proxy
        const response = await _callAIProxy(prompt, speaker.personality);

        // 8. Add response
        if (response) {
            _addMessage(scopeKey, speaker.name, response);
            _log(`Bot Tick SUCCESS: ${speaker.name} spoke in ${chosenScope}: "${response.substring(0,50)}..."`);
            // The main script will need to poll getMessagesForScope and re-render its display
        } else {
             _log(`Bot Tick FAILED: ${speaker.name} did not generate response for ${chosenScope}.`);
        }
    }

    // --- Public API ---
    const publicApi = {
        init: function(config = {}, initialState = {}) {
            _log("Initializing...");
            _config = { ..._config, ...config };

            if (typeof window.getApiResponse === 'function') {
                _apiProviderFunction = window.getApiResponse;
                 _log("API provider function found.");
            } else {
                _log("CRITICAL: window.getApiResponse function not found. Spatial chat AI will not function.", 'error');
                // Allow init to continue but log critical error
            }

            // Initialize state (only player pos, npcs, cities for now)
             this.updateState(initialState.player, initialState.npcs, initialState.cities);

            _internalState.messages = {}; // Reset messages
            _internalState.isInitialized = true;
            _internalState.isActive = false; // Start inactive

            _log(`Initialized. Proxy: ${_config.proxyProviderId}/${_config.proxyModelId}. Bot Interval: ${_config.botIntervalMs}ms.`);
        },

        updateState: function(playerState = null, npcList = null, cityData = null) {
            if (!_internalState.isInitialized) {
                 _log("UpdateState called before init.", "warn");
                 return;
            }

            let playerUpdated = false;
            let npcsUpdated = false;
            let citiesUpdated = false;

            if (playerState) {
                 if (typeof playerState.x === 'number' && _internalState.player.x !== playerState.x) { _internalState.player.x = playerState.x; playerUpdated = true; }
                 if (typeof playerState.y === 'number' && _internalState.player.y !== playerState.y) { _internalState.player.y = playerState.y; playerUpdated = true; }
                 if (playerState.currentCity !== undefined && _internalState.player.currentCity !== playerState.currentCity) { _internalState.player.currentCity = playerState.currentCity; playerUpdated = true; }
                 if (playerState.currentArea !== undefined && _internalState.player.currentArea !== playerState.currentArea) { _internalState.player.currentArea = playerState.currentArea; playerUpdated = true; }
                 if(playerUpdated) _log(`Player state updated: Pos(${_internalState.player.x},${_internalState.player.y}) City:${_internalState.player.currentCity} Area:${_internalState.player.currentArea}`, 'debug');
            }
            if (npcList && Array.isArray(npcList)) {
                 // Quick check if lengths differ, or deep compare if needed (can be slow)
                 if (_internalState.npcs.length !== npcList.length) {
                      npcsUpdated = true;
                 } // Add more checks if NPC properties change often

                 _internalState.npcs = npcList.map(npc => ({
                    id: npc.id,
                    name: npc.name,
                    x: npc.x,
                    y: npc.y,
                    personality: npc.personaPrompt || `You are ${npc.name}.`,
                    currentCity: npc.currentCity || _internalState.player.currentCity, // Best guess if missing
                    currentArea: npc.currentArea // Need accurate area from main script
                 }));
                 if(npcsUpdated) _log(`NPC list updated: ${npcList.length} NPCs loaded.`, 'debug');
            }
             if (cityData && typeof cityData === 'object') {
                 // Simple update, assuming structure is correct from main script
                 _internalState.cities = cityData;
                 citiesUpdated = true;
                 _log(`City structure updated: ${Object.keys(cityData).length} cities.`, 'debug');
             }
        },

        getMessagesForScope: function(scope, cityKey = null, areaKey = null) {
            const scopeKey = _getScopeKey(scope, cityKey, areaKey);
            if (!scopeKey) {
                 _log(`getMessagesForScope: Invalid scope key for ${scope}, ${cityKey}, ${areaKey}`, 'warn');
                 return [];
            }
            // Return a copy to prevent external modification
            return [...(_internalState.messages[scopeKey] || [])];
        },

        start: function() {
            if (!_internalState.isInitialized) { _log("Cannot start: Not initialized.", "warn"); return; }
            if (_internalState.isActive) { /* _log("Already active.", "debug"); */ return; }
            if (!_apiProviderFunction) { _log("Cannot start: API function not available.", "error"); return; }

            _log("Starting autonomous chat bot...");
            _internalState.isActive = true;
            clearInterval(_botIntervalId); // Clear just in case
            _botIntervalId = setInterval(_botTick, _config.botIntervalMs);
            _botTick(); // Run once immediately if conditions allow
        },

        stop: function() {
            if (!_internalState.isActive) { /* _log("Already stopped.", "debug"); */ return; }
            _log("Stopping autonomous chat bot.");
            _internalState.isActive = false;
            clearInterval(_botIntervalId);
            _botIntervalId = null;
        },

        // Allow manually adding system message (e.g., player enters area)
        addSystemMessage: function(scope, cityKey, areaKey, text) {
             const scopeKey = _getScopeKey(scope, cityKey, areaKey);
             if (scopeKey) {
                 _addMessage(scopeKey, 'SYSTEM', text);
             } else {
                  _log(`Could not add system message: Invalid scope key for ${scope}, ${cityKey}, ${areaKey}`, 'warn');
             }
        }
    };

    return publicApi;

})();

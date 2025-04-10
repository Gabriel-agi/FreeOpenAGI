// spatial_chat.js

const SpatialChat = (function() {

    // --- Private State ---
    let _internalState = {
        player: { x: 0, y: 0, currentCity: null, currentArea: null, name: 'Player' }, // Added player name
        npcs: [], // Array of { id, name, x, y, personality, currentCity, currentArea }
        cities: {}, // { cityName: { areaName1: {}, areaName2: {} } }
        messages: {}, // { 'scope-key': ['<Author> msg1', '<Author> msg2', ...] }
        isInitialized: false,
        isActive: false,
    };

    let _config = {
        proxyProviderId: 'BIGMODEL_PROXY',
        proxyModelId: 'glm-4-flash',
        botIntervalMs: 15000,             // Reduced interval (15 seconds)
        generalChatRange: 50,
        maxMessagesPerScope: 100,
        maxContextTurns: 5,
        aiSpeakChance: 0.25,              // Increased chance slightly
        debugLogging: false,              // Toggle for verbose logs
    };

    let _botIntervalId = null;
    let _apiProviderFunction = null; // Reference to window.getApiResponse

    // --- Private Utility Functions ---

    function _log(message, level = 'log') {
        if (_config.debugLogging || level === 'error' || level === 'warn') {
            console[level](`[SpatialChat] ${message}`);
        }
    }

    function _calculateDistance(x1, y1, x2, y2) {
        // Handle undefined coordinates gracefully
        if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
            return Infinity;
        }
        return Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2));
    }

    // --- Scope/Context Key Generation ---
    function _getScopeKey(scope, city = null, area = null) {
        // Use internal state if specific keys aren't provided
        city = city || _internalState.player.currentCity;
        area = area || _internalState.player.currentArea;

        switch (scope) {
            case 'General':
                // General chat requires BOTH city and area to be defined
                return city && area ? `general-${city}-${area}` : null;
            case 'Area':
                 // Area chat requires BOTH city and area
                return city && area ? `area-${city}-${area}` : null;
            case 'City':
                return city ? `city-${city}` : null;
            case 'World':
                return 'world'; // World scope is global
            default:
                _log(`Invalid scope requested: ${scope}`, 'warn');
                return null;
        }
    }

    // --- AI Selection Logic ---
    function _getNpcsInScope(scope) {
        const { player, npcs } = _internalState;
        if (!player.currentCity) return []; // Cannot determine scope without player city

        const city = player.currentCity;
        const area = player.currentArea;

        switch (scope) {
            case 'General':
                if (!area) return []; // General needs area context
                return npcs.filter(npc =>
                    npc.currentCity === city &&
                    npc.currentArea === area && // Must be in the same area
                    _calculateDistance(player.x, player.y, npc.x, npc.y) <= _config.generalChatRange
                );
            case 'Area':
                 if (!area) return []; // Area needs area context
                return npcs.filter(npc =>
                    npc.currentCity === city &&
                    npc.currentArea === area
                );
            case 'City':
                return npcs.filter(npc => npc.currentCity === city);
            case 'World':
                return [...npcs]; // All loaded NPCs, regardless of location
            default:
                return [];
        }
    }

     // --- Message Storage ---
     function _addMessage(scopeKey, author, text) {
        if (!scopeKey || !text || !author) {
            _log(`Skipped adding message due to missing info: Key=${scopeKey}, Author=${author}`, 'warn');
            return false;
        }
        if (!_internalState.messages[scopeKey]) {
            _internalState.messages[scopeKey] = [];
        }
        // Basic sanitization/truncation if needed
        const cleanText = String(text).trim().substring(0, 500); // Limit length
        if (!cleanText) return false;

        const message = `<${author}> ${cleanText}`;
        _internalState.messages[scopeKey].push(message);

        if (_internalState.messages[scopeKey].length > _config.maxMessagesPerScope) {
            _internalState.messages[scopeKey].shift();
        }
        _log(`Added to [${scopeKey}]: ${message.substring(0, 60)}...`, 'info');
        return true;
        // NOTE: Does NOT trigger UI re-render. Main script polls via getMessagesForScope.
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
            { role: "system", content: personality || "You are an AI in a simulated world. Respond concisely." },
            { role: "user", content: prompt }
        ];

        try {
            _log(`Calling proxy: ${_config.proxyProviderId}/${_config.proxyModelId} for prompt: ${prompt.substring(0,100)}...`, 'info');
            const response = await _apiProviderFunction(
                _config.proxyProviderId,
                _config.proxyModelId,
                messages,
                null,
                { temperature: 0.8 }
            );
             if (response && typeof response === 'string') {
                _log(`Proxy response received: ${response.substring(0, 60)}...`, 'info');
                return response.trim(); // Return trimmed response
             } else {
                _log(`Proxy returned invalid response: ${response}`, 'warn');
                return null;
             }
        } catch (error) {
            _log(`Error calling AI proxy: ${error.message}`, 'error');
            console.error(error);
            return null;
        }
    }


    // --- Autonomous Bot Logic ---
    async function _botTick() {
        if (!_internalState.isActive || !_internalState.isInitialized || !_internalState.player.currentCity) {
            //_log("Bot tick skipped: Inactive, not initialized, or no player city.", 'debug');
            return;
        }

        // Consider all NPCs for potential action, not just city-based
        const potentialSpeakers = _internalState.npcs;
        if (potentialSpeakers.length === 0) return;

        // Increased chance check for *each* NPC to potentially speak
        const speakingNpcs = potentialSpeakers.filter(() => Math.random() < _config.aiSpeakChance / potentialSpeakers.length); // Adjust chance based on total NPCs
         if (speakingNpcs.length === 0) return;

        // Process each speaking NPC for this tick
        for (const speaker of speakingNpcs) {
             if (!speaker || !speaker.name || !speaker.personality || !speaker.currentCity || !speaker.currentArea) {
                _log(`Skipping invalid speaker data: ${JSON.stringify(speaker)}`, 'warn');
                continue; // Skip this NPC if data is incomplete
            }

            // Determine relevant scopes for this speaker based on player location
            const relevantScopes = ['World']; // Always relevant
            if (speaker.currentCity === _internalState.player.currentCity) {
                relevantScopes.push('City');
                if (speaker.currentArea === _internalState.player.currentArea) {
                    relevantScopes.push('Area');
                    if (_calculateDistance(_internalState.player.x, _internalState.player.y, speaker.x, speaker.y) <= _config.generalChatRange) {
                        relevantScopes.push('General');
                    }
                }
            }

            // Simple: Pick a random relevant scope. Could be weighted.
            const chosenScope = relevantScopes[Math.floor(Math.random() * relevantScopes.length)];
            const scopeKey = _getScopeKey(chosenScope, speaker.currentCity, speaker.currentArea);

            if (!scopeKey) {
                 _log(`Bot Tick: Could not determine scope key for ${speaker.name} in ${chosenScope}.`, 'warn');
                 continue; // Skip if scope key invalid
            }

            _log(`Bot Tick: ${speaker.name} (in ${speaker.currentArea}) considers speaking in scope ${chosenScope} (${scopeKey})`);

            const history = _internalState.messages[scopeKey] || [];
            const context = history.slice(-_config.maxContextTurns).join('\n') || `The #${chosenScope} chat is quiet.`;

            // Slightly more dynamic prompt
            const locationDesc = `${speaker.currentArea}, ${speaker.currentCity}`;
            const prompt = `You are ${speaker.name} in ${locationDesc}. Personality: "${speaker.personality}".
You are speaking in the #${chosenScope} scope. Keep messages concise (1-2 sentences) & in character.
React to recent chat or mention something relevant to your location/personality if quiet. Don't use greetings.

Recent Context:
---
${context}
---

Your short message:`;

            // Call AI (don't await here, let them run concurrently for the tick)
             _callAIProxy(prompt, speaker.personality).then(response => {
                if (response) {
                    const added = _addMessage(scopeKey, speaker.name, response);
                     if(added) _log(`Bot Tick SUCCESS: ${speaker.name} spoke in ${chosenScope}: "${response.substring(0, 50)}..."`);
                } else {
                    _log(`Bot Tick FAIL: ${speaker.name} failed response for ${chosenScope}.`);
                }
            }).catch(err => {
                 _log(`Bot Tick ERROR for ${speaker.name} in ${chosenScope}: ${err}`, 'error');
            });
        } // End loop through speakingNpcs
    }

    // --- Public API ---
    const publicApi = {
        init: function(config = {}, initialState = {}) {
            _log("Initializing...");
            _config = { ..._config, ...config };

            if (typeof window.getApiResponse === 'function') {
                _apiProviderFunction = window.getApiResponse;
            } else {
                _log("CRITICAL: window.getApiResponse function not found.", 'error');
                return;
            }

            // Initialize state - Ensure player name is included
            const initialPlayer = { ..._internalState.player, ...(initialState.player || {}) };
            this.updateState(initialPlayer, initialState.npcs, initialState.cities);

            _internalState.messages = {}; // Reset messages
            _internalState.isInitialized = true;
            _internalState.isActive = false;

            _log(`Initialized. Proxy: ${_config.proxyProviderId}/${_config.proxyModelId}. Interval: ${_config.botIntervalMs}ms.`);
        },

        updateState: function(playerState = null, npcList = null, cityData = null) {
            if (!_internalState.isInitialized) return;

            let playerUpdated = false;
            if (playerState) {
                 if (playerState.name !== undefined && _internalState.player.name !== playerState.name) {
                    _internalState.player.name = playerState.name;
                    playerUpdated = true;
                 }
                 if (typeof playerState.x === 'number' && typeof playerState.y === 'number' &&
                     (_internalState.player.x !== playerState.x || _internalState.player.y !== playerState.y)) {
                    _internalState.player.x = playerState.x;
                    _internalState.player.y = playerState.y;
                    playerUpdated = true;
                 }
                 if (playerState.currentCity !== undefined && _internalState.player.currentCity !== playerState.currentCity) {
                    _internalState.player.currentCity = playerState.currentCity;
                    playerUpdated = true;
                 }
                 if (playerState.currentArea !== undefined && _internalState.player.currentArea !== playerState.currentArea) {
                    _internalState.player.currentArea = playerState.currentArea;
                    playerUpdated = true;
                 }
            }

            let npcsUpdated = false;
            if (npcList && Array.isArray(npcList)) {
                 // Simple check if length differs or first/last element differs (not robust for changes)
                 if (npcList.length !== _internalState.npcs.length ||
                     JSON.stringify(npcList[0]) !== JSON.stringify(_internalState.npcs[0]) ||
                     JSON.stringify(npcList[npcList.length - 1]) !== JSON.stringify(_internalState.npcs[_internalState.npcs.length - 1]))
                 {
                     _internalState.npcs = npcList.map(npc => ({
                        id: npc.id, name: npc.name, x: npc.x, y: npc.y,
                        personality: npc.personality || `You are ${npc.name}.`, // Use provided personality directly
                        currentCity: npc.currentCity, // Expect main app to provide this
                        currentArea: npc.currentArea  // Expect main app to provide this
                     }));
                     npcsUpdated = true;
                 }
            }

            let citiesUpdated = false;
             if (cityData && typeof cityData === 'object') {
                 const newCityStructure = {};
                 Object.keys(cityData).forEach(cityKey => {
                    newCityStructure[cityKey] = {};
                    if (cityData[cityKey]?.areas) {
                        Object.keys(cityData[cityKey].areas).forEach(areaKey => {
                            newCityStructure[cityKey][areaKey] = {};
                        });
                    }
                 });
                 // Simple comparison (could be improved)
                 if (JSON.stringify(newCityStructure) !== JSON.stringify(_internalState.cities)) {
                     _internalState.cities = newCityStructure;
                     citiesUpdated = true;
                 }
            }

            if (playerUpdated || npcsUpdated || citiesUpdated) {
                _log(`State updated. Player: ${playerUpdated}, NPCs: ${npcsUpdated}, Cities: ${citiesUpdated}`);
            }
        },

        getMessagesForScope: function(scope, cityKey = null, areaKey = null) {
            const scopeKey = _getScopeKey(scope, cityKey, areaKey);
            if (!scopeKey) {
                _log(`Cannot get messages: Invalid scope key for ${scope}, City: ${cityKey}, Area: ${areaKey}`, 'warn');
                return [`<SYSTEM> Cannot determine chat scope.`];
            }
            return _internalState.messages[scopeKey] || [];
        },

        // NEW: Method for player to add messages to spatial scopes
        addPlayerMessageToScope: function(scope, playerName, text) {
            const scopeKey = _getScopeKey(scope); // Uses current player location from internal state
            if (scopeKey) {
                const added = _addMessage(scopeKey, playerName || _internalState.player.name, text);
                if (added) {
                    // Optional: Trigger UI update in main script immediately?
                    // Or let the main script re-render on its own schedule.
                }
                return added;
            }
            return false;
        },

        start: function() {
            if (!_internalState.isInitialized || _internalState.isActive) return;
            _log("Starting autonomous chat bot...");
            _internalState.isActive = true;
            clearInterval(_botIntervalId);
            _botIntervalId = setInterval(_botTick, _config.botIntervalMs);
            _botTick(); // Run once immediately
        },

        stop: function() {
            if (!_internalState.isActive) return;
            _log("Stopping autonomous chat bot.");
            _internalState.isActive = false;
            clearInterval(_botIntervalId);
            _botIntervalId = null;
        },

        // Function to manually add a system message
        addSystemMessage: function(scope, cityKey, areaKey, text) {
             const scopeKey = _getScopeKey(scope, cityKey, areaKey);
             if (scopeKey) {
                 _addMessage(scopeKey, 'SYSTEM', text);
             }
        }
    };

    return publicApi;

})();

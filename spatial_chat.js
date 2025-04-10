// spatial_chat.js

const SpatialChat = (function() {

    // --- Private State ---
    let _internalState = {
        player: { x: 0, y: 0, currentCity: null, currentArea: null },
        npcs: [], // Array of { id, name, x, y, personality, currentCity, currentArea }
        cities: {}, // { cityName: { areaName1: {}, areaName2: {} } }
        messages: {}, // { 'scope-key': ['<Author> msg1', '<Author> msg2', ...] }
        isInitialized: false,
        isActive: false,
    };

    let _config = {
        proxyProviderId: 'BIGMODEL_PROXY',
        proxyModelId: 'glm-4-flash',
        botIntervalMs: 20000,
        generalChatRange: 50,
        maxMessagesPerScope: 100,
        maxContextTurns: 5,
        aiSpeakChance: 0.15, // Chance PER eligible AI to speak each tick
    };

    let _botIntervalId = null;
    let _apiProviderFunction = null;

    // --- Private Utility Functions ---

    function _log(message, level = 'log') {
        console[level](`[SpatialChat] ${message}`);
    }

    function _calculateDistance(x1, y1, x2, y2) {
        // Optimized slightly - avoid sqrt if just comparing ranges
        // return Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2));
        return Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2); // Use squared distance
    }

    // --- Scope/Context Key Generation ---
    function _getScopeKey(scope, city = null, area = null) {
        city = city || _internalState.player.currentCity;
        area = area || _internalState.player.currentArea;

        switch (scope) {
            case 'General':
                return city && area ? `general-${city}-${area}` : null;
            case 'Area':
                return city && area ? `area-${city}-${area}` : null;
            case 'City':
                return city ? `city-${city}` : null;
            case 'World':
                return 'world';
            default:
                // _log(`Invalid scope requested: ${scope}`, 'warn'); // Can be noisy
                return null;
        }
    }

    // --- AI Selection Logic ---
    function _getNpcsInScope(scope) {
        const { player, npcs } = _internalState;
        if (!player.currentCity && scope !== 'World') return []; // Need city context for most scopes

        const squaredGeneralRange = _config.generalChatRange * _config.generalChatRange;

        switch (scope) {
            case 'General':
                if (!player.currentArea) return [];
                // NPCs in the player's current city+area AND within range of the player
                return npcs.filter(npc =>
                    npc.currentCity === player.currentCity &&
                    npc.currentArea === player.currentArea &&
                    _calculateDistance(player.x, player.y, npc.x, npc.y) <= squaredGeneralRange
                );
            case 'Area':
                 if (!player.currentArea) return [];
                 // NPCs in the player's current city+area
                return npcs.filter(npc =>
                    npc.currentCity === player.currentCity &&
                    npc.currentArea === player.currentArea
                );
            case 'City':
                // NPCs in the player's current city
                return npcs.filter(npc => npc.currentCity === player.currentCity);
            case 'World':
                // All loaded NPCs (consider performance implications for very large worlds)
                return [...npcs];
            default:
                return [];
        }
    }

     // --- Message Storage ---
     function _addMessage(scopeKey, author, text) {
        if (!scopeKey || !text) return;
        if (!_internalState.messages[scopeKey]) {
            _internalState.messages[scopeKey] = [];
        }
        // Simple format, main script handles styling if needed
        const message = `<${author}> ${text}`;
        _internalState.messages[scopeKey].push(message);

        // Limit history size
        if (_internalState.messages[scopeKey].length > _config.maxMessagesPerScope) {
            _internalState.messages[scopeKey].shift();
        }
        // Note: Persistence (_saveMessages) is removed for simplicity, but could be added back
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
            { role: "system", content: personality || "You are an AI in a simulated world. Keep responses concise and relevant to the chat scope." },
            { role: "user", content: prompt }
        ];

        try {
            // _log(`Calling proxy: ${_config.proxyProviderId}/${_config.proxyModelId}`); // Less verbose logging
            const response = await _apiProviderFunction(
                _config.proxyProviderId,
                _config.proxyModelId,
                messages,
                null, // API Key is null for proxy
                { temperature: 0.8 }
            );
            // _log(`Proxy response received.`);
            return response;
        } catch (error) {
            _log(`Error calling AI proxy: ${error.message}`, 'error');
            console.error(error);
            return null;
        }
    }


    // --- *** CORRECTED Autonomous Bot Logic *** ---
    async function _botTick() {
        if (!_internalState.isActive || !_internalState.isInitialized || !_internalState.player.currentCity) {
            return; // Bot inactive or no player location
        }

        try { // Wrap tick logic in try/catch for safety
            // 1. Choose a Scope
            const availableScopes = ['General', 'Area', 'City', 'World'];
            // TODO: Consider weighting scopes? e.g., higher chance for General/Area
            const chosenScope = availableScopes[Math.floor(Math.random() * availableScopes.length)];

            // 2. Get NPCs relevant to THAT scope
            const potentialSpeakers = _getNpcsInScope(chosenScope);
            if (potentialSpeakers.length === 0) {
                // _log(`No relevant speakers found for scope: ${chosenScope}`, 'debug');
                return; // No one eligible to speak in this scope currently
            }

            // 3. Apply Speak Chance Filter to relevant NPCs
            const speakingNpcs = potentialSpeakers.filter(() => Math.random() < _config.aiSpeakChance);
            if (speakingNpcs.length === 0) {
                // _log(`No NPCs passed speak chance for scope: ${chosenScope}`, 'debug');
                return; // No one decided to speak this tick
            }

            // 4. Pick ONE speaker from the filtered list
            const speaker = speakingNpcs[Math.floor(Math.random() * speakingNpcs.length)];
            if (!speaker || !speaker.name || !speaker.personality) {
                _log(`Invalid speaker selected after filtering: ${JSON.stringify(speaker)}`, 'warn');
                return;
            }

            // 5. Get Scope Key (use player location for context, even if speaker is elsewhere for World/City)
            // This determines *where* the message history is stored and retrieved from.
            const scopeKey = _getScopeKey(chosenScope, _internalState.player.currentCity, _internalState.player.currentArea);
            if (!scopeKey) {
                _log(`Could not determine scope key for chosen scope: ${chosenScope}`, 'warn');
                return;
            }

            _log(`Bot Tick: ${speaker.name} attempts to speak in scope ${chosenScope} (${scopeKey})`);

            // 6. Get Context
            const history = _internalState.messages[scopeKey] || [];
            const context = history.slice(-_config.maxContextTurns).join('\n') || `The #${chosenScope} chat is quiet.`;

            // 7. Generate Prompt
            const prompt = `You are ${speaker.name}, located in ${speaker.currentArea || 'Unknown Area'}, ${speaker.currentCity || 'Unknown City'}. Your personality: "${speaker.personality}".
You are participating in the #${chosenScope} chat scope.
Keep your message concise (1-2 sentences usually) and in character for this scope.
Do not greet or announce yourself unless it fits your personality.
React to the recent conversation or start a relevant topic if it's quiet.

Recent Context (from #${chosenScope} chat):
---
${context}
---

Your short message for #${chosenScope}:`;

            // 8. Call AI Proxy
            const response = await _callAIProxy(prompt, speaker.personality);

            // 9. Add response to the correct scope's history
            if (response) {
                _addMessage(scopeKey, speaker.name, response);
                _log(`Bot Tick: ${speaker.name} spoke in ${chosenScope}: "${response.substring(0,50)}..."`);
            } else {
                 _log(`Bot Tick: ${speaker.name} failed to generate response for ${chosenScope}.`);
            }
        } catch (error) {
            _log(`Error during bot tick: ${error.message}`, 'error');
            console.error(error);
        }
    }
    // --- *** END CORRECTED Bot Logic *** ---

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

             // Initialize state from provided data
            this.updateState(initialState.player, initialState.npcs, initialState.cities);
            _internalState.messages = {}; // Always start with fresh messages
            _internalState.isInitialized = true;
            _internalState.isActive = false;

            _log(`Initialized. Proxy: ${_config.proxyProviderId}/${_config.proxyModelId}. Bot Interval: ${_config.botIntervalMs}ms.`);
        },

        updateState: function(playerState = null, npcList = null, cityData = null) {
            if (!_internalState.isInitialized) {
                _log("Not initialized, cannot update state.", "warn");
                return;
            }

            let needsLog = false;
            if (playerState) {
                 if (typeof playerState.x === 'number') _internalState.player.x = playerState.x;
                 if (typeof playerState.y === 'number') _internalState.player.y = playerState.y;
                 if (playerState.currentCity !== undefined) _internalState.player.currentCity = playerState.currentCity;
                 if (playerState.currentArea !== undefined) _internalState.player.currentArea = playerState.currentArea;
                 needsLog = true;
            }
            if (npcList && Array.isArray(npcList)) {
                 _internalState.npcs = npcList.map(npc => ({
                    id: npc.id,
                    name: npc.name,
                    x: npc.x,
                    y: npc.y,
                    personality: npc.personaPrompt || `You are ${npc.name}.`,
                    currentCity: npc.currentCity, // Expect main app to provide this
                    currentArea: npc.currentArea // Expect main app to provide this
                 }));
                 needsLog = true;
            }
             if (cityData && typeof cityData === 'object') {
                 _internalState.cities = {};
                 Object.keys(cityData).forEach(cityKey => {
                    _internalState.cities[cityKey] = {};
                    if (cityData[cityKey] && typeof cityData[cityKey] === 'object') { // Check if city entry itself exists
                         Object.keys(cityData[cityKey]).forEach(areaKey => {
                             _internalState.cities[cityKey][areaKey] = {}; // Mark area existence
                         });
                    }
                 });
                 needsLog = true;
             }

             // Optional detailed logging
             // if (needsLog) {
             //     _log(`State updated: Player(${_internalState.player.x?.toFixed(0)},${_internalState.player.y?.toFixed(0)}) City:${_internalState.player.currentCity} Area:${_internalState.player.currentArea} NPCs:${_internalState.npcs.length}`);
             // }
        },

        getMessagesForScope: function(scope, cityKey = null, areaKey = null) {
            const scopeKey = _getScopeKey(scope, cityKey, areaKey);
            if (!scopeKey) {
                _log(`Cannot get messages for invalid scope: ${scope} (City: ${cityKey}, Area: ${areaKey})`, 'warn');
                return [];
            }
            return [...(_internalState.messages[scopeKey] || [])]; // Return a copy
        },

        start: function() {
            if (!_internalState.isInitialized || _internalState.isActive) return;
            _log("Starting autonomous chat bot...");
            _internalState.isActive = true;
            clearInterval(_botIntervalId);
            _botIntervalId = setInterval(_botTick, _config.botIntervalMs);
            // Consider an initial tick delay?
            setTimeout(_botTick, 1000); // Run first tick shortly after start
        },

        stop: function() {
            if (!_internalState.isActive) return;
            _log("Stopping autonomous chat bot.");
            _internalState.isActive = false;
            clearInterval(_botIntervalId);
            _botIntervalId = null;
        },

        // No direct message adding from outside needed for spatial chat
        // System messages could be added via an event bus or specific function if required
    };

    return publicApi;

})();

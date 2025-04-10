// spatial_chat.js

const SpatialChat = (function() {

    // --- Private State ---
    let _internalState = {
        player: { x: 0, y: 0, currentCity: null, currentArea: null, name: 'Player' },
        npcs: [], // { id, name, x, y, personality, currentCity, currentArea }
        cities: {}, // { cityName: { areaName1: {}, areaName2: {} } }
        messages: {}, // { 'scope-key': ['<Author> msg1', ...] }
        currentDisplayScope: null,
        isInitialized: false,
        isActive: true,
    };

    let _config = {
        proxyProviderId: 'BIGMODEL_PROXY',
        proxyModelId: 'glm-4-flash',
        botIntervalMs: 2500,
        generalChatRange: 75, // Range for general chat
        maxMessagesPerScope: 50,
        maxContextTurns: 4,
        scopeSpeakChance: 0.6,
        npcSpeakChanceMultiplier: 0.3,
        debugLogging: false, // Keep false unless debugging
    };

    let _botIntervalId = null;
    let _apiProviderFunction = null;
    let _isBotTickRunning = false;

    // --- Private Utility Functions ---

    function _log(message, level = 'log') {
        if (_config.debugLogging || level === 'error' || level === 'warn') {
            console[level](`[SpatialChat] ${message}`);
        }
    }

    function _calculateDistance(x1, y1, x2, y2) {
        if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
            return Infinity;
        }
        return Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2));
    }

    // --- Scope/Context Key Generation ---
    function _getScopeKey(scope, city = null, area = null) {
        city = city || _internalState.player.currentCity;
        // Area is only strictly needed for Area scope key generation now
        area = area || _internalState.player.currentArea;

        switch (scope) {
            case 'General':
                // General chat KEY depends on the player's current city for context separation,
                // but the NPCs considered will be based purely on proximity within that city.
                // We still include area in the key for simplicity of separation, even if logic doesn't use it.
                 if (!city || !area) { // Use area in key for partitioning, even if logic ignores it
                    // _log(`Cannot get General scope key: Missing City (${city}) or Area (${area})`, 'warn');
                    return null;
                 }
                 return `general-${city}-${area}`; // Key still uses area for separation
            case 'Area':
                if (!city || !area) {
                     // _log(`Cannot get Area scope key: Missing City (${city}) or Area (${area})`, 'warn');
                     return null;
                 }
                return `area-${city}-${area}`;
            case 'City':
                if (!city) {
                     // _log(`Cannot get City scope key: Missing City (${city})`, 'warn');
                     return null;
                 }
                return `city-${city}`;
            case 'World':
                return 'world';
            default:
                if (scope !== null) {
                    _log(`Invalid scope requested for key generation: ${scope}`, 'warn');
                }
                return null;
        }
    }

    // --- AI Selection Logic ---
    function _getNpcsInScope(scope) {
        const { player, npcs } = _internalState;
        if (!player.currentCity) {
             _log(`Cannot get NPCs: Player city is null. Scope: ${scope}`, 'warn');
             return [];
        }

        const city = player.currentCity;
        const area = player.currentArea; // Player's current area is still needed for Area scope logic
        let relevantNpcs = [];

        _log(`Getting NPCs for scope: ${scope}. Player Loc: C=${city}, A=${area}, (${player.x?.toFixed(0)}, ${player.y?.toFixed(0)})`, 'info');

        switch (scope) {
            case 'General':
                 // *** General Scope Logic (Requirement Met) ***
                 // Player must be in a city. NPCs must be in the same city and within range.
                 // This logic *does not* require the NPC to be in the same specific *defined* area as the player.
                 // It correctly checks only city and proximity.
                if (!city) { _log("General scope requires player to be in a city.", 'warn'); return []; }
                relevantNpcs = npcs.filter(npc => {
                    const isInCity = npc.currentCity === city;
                    const distance = _calculateDistance(player.x, player.y, npc.x, npc.y);
                    const isInRange = distance <= _config.generalChatRange;
                     if(_config.debugLogging && isInCity){ // Log only relevant NPCs
                         _log(`NPC ${npc.name} (City: ${npc.currentCity}, Area: ${npc.currentArea}). Dist: ${distance?.toFixed(1)}. In Range: ${isInRange}`, 'debug');
                     }
                    return isInCity && isInRange; // Check only city and range
                });
                _log(`Found ${relevantNpcs.length} NPCs in General scope range (${_config.generalChatRange}) within city ${city}.`, 'info');
                break;
                // *** End General Scope Logic ***
            case 'Area':
                 if (!area) { _log("Area scope requires player to be in an area.", 'warn'); return []; }
                relevantNpcs = npcs.filter(npc => npc.currentCity === city && npc.currentArea === area );
                 _log(`Found ${relevantNpcs.length} NPCs in Area scope (${area}).`, 'info');
                 break;
            case 'City':
                relevantNpcs = npcs.filter(npc => npc.currentCity === city);
                 _log(`Found ${relevantNpcs.length} NPCs in City scope (${city}).`, 'info');
                 break;
            case 'World':
                relevantNpcs = [...npcs]; // All loaded NPCs
                 _log(`Found ${relevantNpcs.length} NPCs in World scope.`, 'info');
                 break;
            default:
                 _log(`Invalid scope "${scope}" for NPC selection.`, 'warn');
                 relevantNpcs = [];
        }
        return relevantNpcs;
    }

     // --- Message Storage ---
     function _addMessage(scopeKey, author, text) {
        if (!scopeKey || !text || !author) {
            _log(`Skipped adding message: Key=${scopeKey}, Author=${author}, Text empty=${!text}`, 'warn');
            return false;
        }
        if (!_internalState.messages[scopeKey]) {
            _internalState.messages[scopeKey] = [];
        }
        const cleanText = String(text).trim().substring(0, 500);
        if (!cleanText) return false;

        const message = `<${author}> ${cleanText}`;
        _internalState.messages[scopeKey].push(message);

        if (_internalState.messages[scopeKey].length > _config.maxMessagesPerScope) {
            _internalState.messages[scopeKey].shift();
        }
        _log(`Added to [${scopeKey}]: ${message.substring(0, 60)}...`);
        return true;
    }

    // --- AI Call ---
    async function _callAIProxy(prompt, personality) {
        if (!_apiProviderFunction) { _log("API provider func not available.", 'error'); return null; }
        if (!_config.proxyProviderId || !_config.proxyModelId) { _log("Proxy provider/model ID not configured.", 'error'); return null; }

        const messages = [
            { role: "system", content: personality || "You are an AI in a simulated world. Respond concisely." },
            { role: "user", content: prompt }
        ];

        try {
            _log(`Calling proxy: ${_config.proxyProviderId}/${_config.proxyModelId}`, 'info');
            const response = await _apiProviderFunction( _config.proxyProviderId, _config.proxyModelId, messages, null, { temperature: 0.8 } );
             if (response && typeof response === 'string') {
                _log(`Proxy response received: ${response.substring(0, 60)}...`, 'info');
                return response.trim();
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
        if (_isBotTickRunning) return;
         if (!_internalState.isActive || !_internalState.isInitialized || !_internalState.player.currentCity || !_internalState.currentDisplayScope) {
             return;
         }
         const validSpatialScopes = ['General', 'Area', 'City', 'World'];
         if (!validSpatialScopes.includes(_internalState.currentDisplayScope)) {
             // Only run bot ticks if a spatial scope is actively being displayed
             return;
         }

        _isBotTickRunning = true;

        try {
            const activeScope = _internalState.currentDisplayScope;
            const activeScopeKey = _getScopeKey(activeScope);

            if (!activeScopeKey) {
                 _log(`Bot Tick: Could not get scope key for active scope: ${activeScope}`, 'warn');
                 _isBotTickRunning = false; // Ensure flag is reset
                 return;
            }

            const potentialSpeakers = _getNpcsInScope(activeScope);
            if (potentialSpeakers.length === 0) {
                 _isBotTickRunning = false; // Ensure flag is reset
                 return;
            }

             const collectiveSpeakChance = Math.min(1, _config.scopeSpeakChance * potentialSpeakers.length * _config.npcSpeakChanceMultiplier);

             if (Math.random() > collectiveSpeakChance) {
                 _isBotTickRunning = false; // Ensure flag is reset
                 return;
             }

            const speaker = potentialSpeakers[Math.floor(Math.random() * potentialSpeakers.length)];
             if (!speaker || !speaker.name || !speaker.personality) {
                _log(`Bot Tick: Invalid speaker selected for ${activeScope}.`, 'warn');
                _isBotTickRunning = false; // Ensure flag is reset
                return;
            }

            _log(`Bot Tick: ${speaker.name} selected to speak in active scope ${activeScope} (${activeScopeKey})`);

            const history = _internalState.messages[activeScopeKey] || [];
            const context = history.slice(-_config.maxContextTurns).join('\n') || `The #${activeScope} chat is quiet.`;

            const locationDesc = `${speaker.currentArea || 'Somewhere'}, ${speaker.currentCity || 'Unknown City'}`;
            // Adjusted prompt slightly
            const prompt = `You are ${speaker.name} in ${locationDesc}. Personality: "${speaker.personality}".
You are speaking in the #${activeScope} scope. Keep messages very short (1-2 brief sentences) & in character.
React naturally to the last few messages or make a brief observation about your surroundings or personality if it's quiet. Avoid generic greetings like "Hello".

Recent Context in #${activeScope}:
---
${context}
---

Your short message:`;

            // Use .finally to ensure the flag is always reset
            _callAIProxy(prompt, speaker.personality).then(response => {
                if (response) {
                    const added = _addMessage(activeScopeKey, speaker.name, response);
                     if(added) _log(`Bot Tick SUCCESS: ${speaker.name} spoke in ${activeScope}: "${response.substring(0, 50)}..."`);
                } else {
                    _log(`Bot Tick FAIL: ${speaker.name} failed response for ${activeScope}.`);
                }
            }).catch(err => {
                 _log(`Bot Tick ERROR for ${speaker.name} in ${activeScope}: ${err}`, 'error');
            }).finally(() => {
                 _isBotTickRunning = false; // Reset flag here
            });

        } catch (error) {
            _log(`Error during bot tick: ${error}`, 'error');
            console.error(error);
            _isBotTickRunning = false; // Reset flag in case of synchronous error
        }
        // Removed finally block from here as it's now handled by the promise chain
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
                // maybe throw error or set a flag indicating critical failure
                return;
            }

            const initialPlayer = { ..._internalState.player, ...(initialState.player || {}) };
            this.updateState(initialPlayer, initialState.npcs, initialState.cities, null);

            _internalState.messages = {}; // Clear messages on init
            _internalState.isInitialized = true;
            _internalState.isActive = false; // Start inactive, let main script call start()

            _log(`Initialized. Interval: ${_config.botIntervalMs}ms. General Range: ${_config.generalChatRange}`);
        },

        updateState: function(playerState = null, npcList = null, cityData = null, displayScope = undefined) {
            if (!_internalState.isInitialized) return;
            let stateChanged = false;
            let playerPosChanged = false;

             if (playerState) {
                 if (playerState.name !== undefined && _internalState.player.name !== playerState.name) { _internalState.player.name = playerState.name; stateChanged = true; }
                 if (typeof playerState.x === 'number' && typeof playerState.y === 'number' && (_internalState.player.x !== playerState.x || _internalState.player.y !== playerState.y)) {
                     _internalState.player.x = playerState.x; _internalState.player.y = playerState.y;
                     stateChanged = true; playerPosChanged = true; // Track player position change specifically
                 }
                 if (playerState.currentCity !== undefined && _internalState.player.currentCity !== playerState.currentCity) { _internalState.player.currentCity = playerState.currentCity; stateChanged = true; }
                 if (playerState.currentArea !== undefined && _internalState.player.currentArea !== playerState.currentArea) { _internalState.player.currentArea = playerState.currentArea; stateChanged = true; }
             }
             // Simple check for NPC list changes (more robust check might be needed for deep equality)
             if (npcList && Array.isArray(npcList)) {
                  if (JSON.stringify(npcList.map(n => `${n.id}-${n.x}-${n.y}-${n.currentArea}-${n.personality}`)) !== JSON.stringify(_internalState.npcs.map(n => `${n.id}-${n.x}-${n.y}-${n.currentArea}-${n.personality}`))) {
                    _internalState.npcs = npcList.map(npc => ({
                        id: npc.id, name: npc.name, x: npc.x, y: npc.y,
                        personality: npc.personality, currentCity: npc.currentCity, currentArea: npc.currentArea
                    }));
                     stateChanged = true;
                  }
             }
            // City data update (simplified, assuming structure doesn't change often)
            if (cityData && typeof cityData === 'object') {
                if (JSON.stringify(cityData) !== JSON.stringify(_internalState.cities)) {
                    _internalState.cities = JSON.parse(JSON.stringify(cityData)); // Deep copy
                    stateChanged = true;
                }
            }

             if (displayScope !== undefined && _internalState.currentDisplayScope !== displayScope) {
                _internalState.currentDisplayScope = displayScope;
                 _log(`Display scope updated to: ${displayScope}`);
                stateChanged = true;
             }
             //if (stateChanged) { _log(`State updated. Player pos changed: ${playerPosChanged}`); }
        },

        getMessagesForScope: function(scope, cityKey = null, areaKey = null) {
            const scopeKey = _getScopeKey(scope, cityKey, areaKey);
            if (!scopeKey) {
                // Log less verbosely if it's a common case like player not in an area
                // if (scope !== 'General' && scope !== 'City' && scope !== 'World') {
                //     _log(`Cannot get messages: Invalid scope key for ${scope}, City: ${cityKey}, Area: ${areaKey}`, 'warn');
                // }
                return [`<SYSTEM> Cannot determine chat scope or player location.`];
            }
            // Ensure the key exists before trying to access it
            if (!_internalState.messages[scopeKey]) {
                 _internalState.messages[scopeKey] = []; // Initialize if needed
            }
            return [...(_internalState.messages[scopeKey] || [])]; // Return a copy
        },

        addPlayerMessageToScope: function(scope, playerName, text) {
            const scopeKey = _getScopeKey(scope);
            if (scopeKey) {
                const added = _addMessage(scopeKey, playerName || _internalState.player.name, text);
                // If message added, maybe trigger a faster bot response chance? (optional complexity)
                return added;
            }
            _log(`Could not add player message: Invalid scope key for ${scope}`, 'warn');
            return false;
        },

        start: function() {
            if (!_internalState.isInitialized) { _log("Cannot start: Not initialized.", "warn"); return; }
            if (_internalState.isActive) return; // Already running
            _log("Starting autonomous chat bot...");
            _internalState.isActive = true;
            clearInterval(_botIntervalId); // Clear just in case
            _botIntervalId = setInterval(_botTick, _config.botIntervalMs);
            // Immediately trigger a tick after starting?
            // setTimeout(_botTick, 100);
        },

        stop: function() {
            if (!_internalState.isActive) return; // Already stopped
            _log("Stopping autonomous chat bot.");
            _internalState.isActive = false;
            clearInterval(_botIntervalId);
            _botIntervalId = null;
            _isBotTickRunning = false; // Ensure tick flag is reset on stop
        },

        // Utility to potentially add system messages directly to spatial scopes if needed
        addSystemMessage: function(scope, cityKey, areaKey, text) {
             const scopeKey = _getScopeKey(scope, cityKey, areaKey);
             if (scopeKey) {
                 return _addMessage(scopeKey, 'SYSTEM', text);
             }
             return false;
        }
    };

    return publicApi;

})();

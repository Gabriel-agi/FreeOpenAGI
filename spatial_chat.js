// spatial_chat.js

const SpatialChat = (function() {

    // --- Private State ---
    let _internalState = {
        player: { x: 0, y: 0, currentCity: null, currentArea: null, name: 'Player' },
        npcs: [], // { id, name, x, y, personality, currentCity, currentArea }
        cities: {}, // { cityName: { areaName1: {}, areaName2: {} } }
        messages: {}, // { 'scope-key': ['<Author> msg1', ...] }
        currentDisplayScope: null, // Tracks the scope the user is *viewing* in index.html ('General', 'Area', 'City', 'World', or null if non-spatial tab)
        isInitialized: false,
        isActive: true, // Let's default to active and let index.html stop/start if needed
    };

    let _config = {
        proxyProviderId: 'BIGMODEL_PROXY',
        proxyModelId: 'glm-4-flash',
        botIntervalMs: 2500,              // MUCH Faster interval (2.5 seconds)
        generalChatRange: 50,
        maxMessagesPerScope: 50,          // Reduced history slightly
        maxContextTurns: 4,               // Reduced context slightly
        // Chance per *tick* that *any* relevant NPC might speak in the *active* scope.
        // The actual chance per NPC depends on how many are relevant.
        scopeSpeakChance: 0.6,            // Higher overall chance per tick *if* the scope is active
        npcSpeakChanceMultiplier: 0.3,    // Multiplier per relevant NPC (e.g., 3 NPCs -> 3*0.3 = 0.9 -> likely one speaks)
        debugLogging: true,               // Enable more logging for debugging
    };

    let _botIntervalId = null;
    let _apiProviderFunction = null;
    let _isBotTickRunning = false; // Prevent overlapping ticks

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
        area = area || _internalState.player.currentArea;

        switch (scope) {
            case 'General':
                if (!city || !area) {
                    _log(`Cannot get General scope key: Missing City (${city}) or Area (${area})`, 'warn');
                    return null;
                }
                return `general-${city}-${area}`;
            case 'Area':
                if (!city || !area) {
                     _log(`Cannot get Area scope key: Missing City (${city}) or Area (${area})`, 'warn');
                     return null;
                 }
                return `area-${city}-${area}`;
            case 'City':
                if (!city) {
                     _log(`Cannot get City scope key: Missing City (${city})`, 'warn');
                     return null;
                 }
                return `city-${city}`;
            case 'World':
                return 'world';
            default:
                // Allow null for non-spatial modes being active
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
        const area = player.currentArea;
        let relevantNpcs = [];

        _log(`Getting NPCs for scope: ${scope}. Player Loc: C=${city}, A=${area}, (${player.x?.toFixed(0)}, ${player.y?.toFixed(0)})`, 'info');

        switch (scope) {
            case 'General':
                if (!area) { _log("General scope requires player to be in an area.", 'warn'); return []; }
                relevantNpcs = npcs.filter(npc => {
                     const isInArea = npc.currentCity === city && npc.currentArea === area;
                     const distance = _calculateDistance(player.x, player.y, npc.x, npc.y);
                     const isInRange = distance <= _config.generalChatRange;
                     // if(isInArea) _log(`NPC ${npc.name} in area ${area}. Dist: ${distance?.toFixed(1)}. In Range: ${isInRange}`, 'debug');
                     return isInArea && isInRange;
                 });
                 _log(`Found ${relevantNpcs.length} NPCs in General scope range (${_config.generalChatRange}).`, 'info');
                 break;
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


    // --- Autonomous Bot Logic (Conditional Generation) ---
    async function _botTick() {
        if (_isBotTickRunning) {
            //_log("Bot tick already running, skipping.", 'debug');
            return; // Prevent overlap
        }
         if (!_internalState.isActive || !_internalState.isInitialized || !_internalState.player.currentCity || !_internalState.currentDisplayScope) {
            //_log(`Bot tick skipped: Active=${_internalState.isActive}, Init=${_internalState.isInitialized}, City=${_internalState.player.currentCity}, DisplayScope=${_internalState.currentDisplayScope}`, 'debug');
            return; // Don't run if not active, not init, no city, or no *spatial* scope is being displayed
        }

         // Check if the displayed scope is a valid spatial scope
         const validSpatialScopes = ['General', 'Area', 'City', 'World'];
         if (!validSpatialScopes.includes(_internalState.currentDisplayScope)) {
             //_log(`Bot tick skipped: Current display scope (${_internalState.currentDisplayScope}) is not spatial.`, 'debug');
             return; // Only generate for active spatial scopes
         }

        _isBotTickRunning = true; // Set flag

        try {
            const activeScope = _internalState.currentDisplayScope;
            const activeScopeKey = _getScopeKey(activeScope);

            if (!activeScopeKey) {
                 _log(`Bot Tick: Could not get scope key for active scope: ${activeScope}`, 'warn');
                 return; // Cannot proceed without a valid key for the active scope
            }

            // Get NPCs relevant *only* to the currently displayed scope
            const potentialSpeakers = _getNpcsInScope(activeScope);
            if (potentialSpeakers.length === 0) {
                 //_log(`Bot Tick: No relevant NPCs found for active scope ${activeScope}.`, 'debug');
                 return;
            }

             // Calculate overall chance for *any* NPC in this scope to speak this tick
             const collectiveSpeakChance = Math.min(1, _config.scopeSpeakChance * potentialSpeakers.length * _config.npcSpeakChanceMultiplier);

             if (Math.random() > collectiveSpeakChance) {
                 //_log(`Bot Tick: Rolled below collective chance (${collectiveSpeakChance.toFixed(2)}) for scope ${activeScope}.`, 'debug');
                 return; // No one speaks this tick for this scope
             }

             // If check passes, pick ONE NPC from the relevant list to speak
            const speaker = potentialSpeakers[Math.floor(Math.random() * potentialSpeakers.length)];
             if (!speaker || !speaker.name || !speaker.personality) {
                _log(`Bot Tick: Invalid speaker selected from relevant NPCs for ${activeScope}.`, 'warn');
                return;
            }

            _log(`Bot Tick: ${speaker.name} selected to speak in active scope ${activeScope} (${activeScopeKey})`);

            const history = _internalState.messages[activeScopeKey] || [];
            const context = history.slice(-_config.maxContextTurns).join('\n') || `The #${activeScope} chat is quiet.`;

            const locationDesc = `${speaker.currentArea || 'Unknown Area'}, ${speaker.currentCity || 'Unknown City'}`;
            const prompt = `You are ${speaker.name} in ${locationDesc}. Personality: "${speaker.personality}".
You are speaking in the #${activeScope} scope. Keep messages concise (1-2 sentences) & in character.
React to recent chat or mention something relevant to your location/personality if quiet. Avoid generic greetings.

Recent Context:
---
${context}
---

Your short message:`;

            const response = await _callAIProxy(prompt, speaker.personality);

            if (response) {
                const added = _addMessage(activeScopeKey, speaker.name, response);
                 if(added) _log(`Bot Tick SUCCESS: ${speaker.name} spoke in ${activeScope}: "${response.substring(0, 50)}..."`);
            } else {
                _log(`Bot Tick FAIL: ${speaker.name} failed response for ${activeScope}.`);
            }

        } catch (error) {
            _log(`Error during bot tick: ${error}`, 'error');
            console.error(error);
        } finally {
            _isBotTickRunning = false; // Reset flag
        }
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

            const initialPlayer = { ..._internalState.player, ...(initialState.player || {}) };
            this.updateState(initialPlayer, initialState.npcs, initialState.cities, null); // Initialize scope to null

            _internalState.messages = {};
            _internalState.isInitialized = true;
            _internalState.isActive = false; // Start inactive by default

            _log(`Initialized. Interval: ${_config.botIntervalMs}ms.`);
        },

        // Modified updateState to accept currentDisplayScope
        updateState: function(playerState = null, npcList = null, cityData = null, displayScope = undefined) {
            if (!_internalState.isInitialized) return;

            let stateChanged = false;
            if (playerState) {
                 if (playerState.name !== undefined && _internalState.player.name !== playerState.name) { _internalState.player.name = playerState.name; stateChanged = true; }
                 if (typeof playerState.x === 'number' && typeof playerState.y === 'number' && (_internalState.player.x !== playerState.x || _internalState.player.y !== playerState.y)) { _internalState.player.x = playerState.x; _internalState.player.y = playerState.y; stateChanged = true; }
                 if (playerState.currentCity !== undefined && _internalState.player.currentCity !== playerState.currentCity) { _internalState.player.currentCity = playerState.currentCity; stateChanged = true; }
                 if (playerState.currentArea !== undefined && _internalState.player.currentArea !== playerState.currentArea) { _internalState.player.currentArea = playerState.currentArea; stateChanged = true; }
            }
            if (npcList && Array.isArray(npcList)) {
                 // Basic check for changes - can be improved for performance
                 if (JSON.stringify(npcList.map(n => n.id + n.x + n.y + n.currentArea)) !== JSON.stringify(_internalState.npcs.map(n => n.id + n.x + n.y + n.currentArea))) {
                     _internalState.npcs = npcList.map(npc => ({
                        id: npc.id, name: npc.name, x: npc.x, y: npc.y,
                        personality: npc.personality, // Use already mapped personality
                        currentCity: npc.currentCity,
                        currentArea: npc.currentArea
                     }));
                     stateChanged = true;
                 }
            }
             if (cityData && typeof cityData === 'object') {
                 // Omitted city structure update for brevity, assume it's less frequent
             }
             // Update the currently displayed scope if provided
             if (displayScope !== undefined && _internalState.currentDisplayScope !== displayScope) {
                _internalState.currentDisplayScope = displayScope;
                 _log(`Display scope updated to: ${displayScope}`);
                stateChanged = true;
             }

            // if (stateChanged) { _log(`State updated.`); }
        },

        getMessagesForScope: function(scope, cityKey = null, areaKey = null) {
            const scopeKey = _getScopeKey(scope, cityKey, areaKey);
            if (!scopeKey) {
                _log(`Cannot get messages: Invalid scope key for ${scope}, City: ${cityKey}, Area: ${areaKey}`, 'warn');
                return [`<SYSTEM> Cannot determine chat scope.`];
            }
            return _internalState.messages[scopeKey] || [];
        },

        addPlayerMessageToScope: function(scope, playerName, text) {
            // Use player's current location from internal state to determine the key
            const scopeKey = _getScopeKey(scope);
            if (scopeKey) {
                return _addMessage(scopeKey, playerName || _internalState.player.name, text);
            }
            _log(`Could not add player message: Invalid scope key for ${scope}`, 'warn');
            return false;
        },

        start: function() {
            if (!_internalState.isInitialized || _internalState.isActive) return;
            _log("Starting autonomous chat bot...");
            _internalState.isActive = true;
            clearInterval(_botIntervalId);
            _botIntervalId = setInterval(_botTick, _config.botIntervalMs);
            // Don't run _botTick immediately, let the interval handle it
        },

        stop: function() {
            if (!_internalState.isActive) return;
            _log("Stopping autonomous chat bot.");
            _internalState.isActive = false;
            clearInterval(_botIntervalId);
            _botIntervalId = null;
        },

        addSystemMessage: function(scope, cityKey, areaKey, text) {
             const scopeKey = _getScopeKey(scope, cityKey, areaKey);
             if (scopeKey) { _addMessage(scopeKey, 'SYSTEM', text); }
        }
    };

    return publicApi;

})();

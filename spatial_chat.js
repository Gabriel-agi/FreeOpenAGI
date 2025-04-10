// spatial_chat.js

const SpatialChat = (function() {

    // --- Private State ---
    let _internalState = {
        player: { x: 0, y: 0, currentCity: null, currentArea: null },
        npcs: [], // Array of { id, name, x, y, personality, currentCity, currentArea }
        cities: {}, // Simple structure like { cityName: { areaName1: {}, areaName2: {} } } for existence checks
        messages: {}, // { 'scope-key': ['msg1', 'msg2', ...] } e.g., 'general-GENESIS-START': [...]
        isInitialized: false,
        isActive: false,
    };

    let _config = {
        proxyProviderId: 'BIGMODEL_PROXY', // Default, ensure this matches api_providers.js
        proxyModelId: 'glm-4-flash',       // Default model for the proxy
        botIntervalMs: 20000,             // How often bots try to speak (e.g., 20 seconds)
        generalChatRange: 50,             // Max distance for 'General' chat relevance
        maxMessagesPerScope: 100,         // Limit history size
        maxContextTurns: 5,               // How many recent messages to send as context
        aiSpeakChance: 0.15,              // Chance an AI speaks per tick per AI considered
    };

    let _botIntervalId = null;
    let _apiProviderFunction = null; // Reference to window.getApiResponse

    // --- Private Utility Functions ---

    function _log(message, level = 'log') {
        console[level](`[SpatialChat] ${message}`);
    }

    function _calculateDistance(x1, y1, x2, y2) {
        return Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2));
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
                _log(`Invalid scope requested: ${scope}`, 'warn');
                return null;
        }
    }

    // --- AI Selection Logic ---
    function _getNpcsInScope(scope) {
        const { player, npcs } = _internalState;
        if (!player.currentCity) return [];

        switch (scope) {
            case 'General':
                if (!player.currentArea) return [];
                return npcs.filter(npc =>
                    npc.currentCity === player.currentCity &&
                    npc.currentArea === player.currentArea &&
                    _calculateDistance(player.x, player.y, npc.x, npc.y) <= _config.generalChatRange
                );
            case 'Area':
                 if (!player.currentArea) return [];
                return npcs.filter(npc =>
                    npc.currentCity === player.currentCity &&
                    npc.currentArea === player.currentArea
                );
            case 'City':
                return npcs.filter(npc => npc.currentCity === player.currentCity);
            case 'World':
                return [...npcs]; // All loaded NPCs
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
        const message = `<${author}> ${text}`;
        _internalState.messages[scopeKey].push(message);

        // Limit history size
        if (_internalState.messages[scopeKey].length > _config.maxMessagesPerScope) {
            _internalState.messages[scopeKey].shift();
        }
        // Persist messages (optional, could be done less frequently)
        // _saveMessages(); // Consider if saving spatial chat is desired/needed
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

        // Construct messages for the API call
        const messages = [
            { role: "system", content: personality || "You are an AI in a simulated world." },
            { role: "user", content: prompt }
        ];

        try {
            _log(`Calling proxy: ${_config.proxyProviderId}/${_config.proxyModelId}`);
            // Explicitly pass null for apiKey when using proxy
            const response = await _apiProviderFunction(
                _config.proxyProviderId,
                _config.proxyModelId,
                messages,
                null, // API Key is null for proxy
                { temperature: 0.8 } // Example options
            );
            _log(`Proxy response received.`);
            return response;
        } catch (error) {
            _log(`Error calling AI proxy: ${error.message}`, 'error');
            console.error(error); // Log full error for details
            return null; // Indicate failure
        }
    }


    // --- Autonomous Bot Logic ---
    async function _botTick() {
        if (!_internalState.isActive || !_internalState.isInitialized || !_internalState.player.currentCity) {
            return; // Don't run if not active, not initialized, or player has no location
        }

        // 1. Select a potential speaker AI (e.g., from the current city)
        const potentialSpeakers = _getNpcsInScope('City'); // Consider only NPCs in the current city for simplicity
        if (potentialSpeakers.length === 0) return;

        // Filter out NPCs that might be speaking too often (optional)
        // Simple chance check for each potential speaker
        const speakingNpcs = potentialSpeakers.filter(() => Math.random() < _config.aiSpeakChance);
        if (speakingNpcs.length === 0) return;

        // Pick one AI to speak this tick
        const speaker = speakingNpcs[Math.floor(Math.random() * speakingNpcs.length)];
         if (!speaker || !speaker.name || !speaker.personality) {
            _log(`Invalid speaker selected: ${JSON.stringify(speaker)}`, 'warn');
            return;
        }

        // 2. Select a scope for the AI to speak in (weighted?)
        const availableScopes = ['General', 'Area', 'City', 'World'];
        // Simple: Randomly pick one. Could be weighted later (e.g., higher chance for Area/General)
        const chosenScope = availableScopes[Math.floor(Math.random() * availableScopes.length)];
        const scopeKey = _getScopeKey(chosenScope, speaker.currentCity, speaker.currentArea); // Key based on speaker's location for relevance

        if (!scopeKey) return; // Can't determine scope (e.g., AI has no area for 'General')

        _log(`Bot Tick: ${speaker.name} considers speaking in scope ${chosenScope} (${scopeKey})`);

        // 3. Get context from that scope's history
        const history = _internalState.messages[scopeKey] || [];
        const context = history.slice(-_config.maxContextTurns).join('\n') || `The #${chosenScope} chat is quiet.`;

        // 4. Generate Prompt
        const prompt = `You are ${speaker.name}, located in ${speaker.currentArea}, ${speaker.currentCity}. Your personality: "${speaker.personality}".
You are participating in the #${chosenScope} chat scope.
Keep your message concise (1-2 sentences usually) and in character.
Don't greet or announce yourself unless it fits your personality.
React to the recent conversation or start a relevant topic if it's quiet.

Recent Context:
---
${context}
---

Your short message:`;

        // 5. Call AI Proxy
        const response = await _callAIProxy(prompt, speaker.personality);

        // 6. Add response to the correct scope
        if (response) {
            _addMessage(scopeKey, speaker.name, response);
            _log(`Bot Tick: ${speaker.name} spoke in ${chosenScope}: "${response.substring(0,50)}..."`);
            // Notify main script? For now, main script polls via getMessagesForScope
        } else {
             _log(`Bot Tick: ${speaker.name} failed to generate response for ${chosenScope}.`);
        }
    }

    // --- Public API ---
    const publicApi = {
        init: function(config = {}, initialState = {}) {
            _log("Initializing...");
            _config = { ..._config, ...config }; // Merge config

            // Store reference to the global API function
            if (typeof window.getApiResponse === 'function') {
                _apiProviderFunction = window.getApiResponse;
            } else {
                _log("CRITICAL: window.getApiResponse function not found from api_providers.js.", 'error');
                // Cannot proceed without the API function
                return;
            }

            // Initialize state (only player pos, npcs, cities for now)
             this.updateState(initialState.player, initialState.npcs, initialState.cities);

            _internalState.messages = {}; // Reset messages on init
            _internalState.isInitialized = true;
             _internalState.isActive = false; // Start inactive

            _log(`Initialized. Proxy: ${_config.proxyProviderId}/${_config.proxyModelId}. Bot Interval: ${_config.botIntervalMs}ms.`);
            // Don't start bot automatically, wait for explicit start() call
        },

        updateState: function(playerState = null, npcList = null, cityData = null) {
            if (!_internalState.isInitialized) return;

            let updated = false;
            if (playerState) {
                 // Basic validation
                 if (typeof playerState.x === 'number' && typeof playerState.y === 'number') {
                    _internalState.player.x = playerState.x;
                    _internalState.player.y = playerState.y;
                    updated = true;
                 }
                 if (playerState.currentCity !== undefined) { // Allow null city
                    _internalState.player.currentCity = playerState.currentCity;
                    updated = true;
                 }
                 if (playerState.currentArea !== undefined) { // Allow null area
                    _internalState.player.currentArea = playerState.currentArea;
                    updated = true;
                 }
            }
            if (npcList && Array.isArray(npcList)) {
                 // Store only necessary info for spatial chat
                 _internalState.npcs = npcList.map(npc => ({
                    id: npc.id, // Keep ID if needed later
                    name: npc.name,
                    x: npc.x,
                    y: npc.y,
                    personality: npc.personaPrompt || `You are ${npc.name}.`,
                    currentCity: npc.currentCity || _internalState.player.currentCity, // Assume same city if not specified? Risky.
                    currentArea: npc.currentArea || _internalState.player.currentArea, // Assume same area if not specified? Risky.
                 }));
                 updated = true;
            }
             if (cityData && typeof cityData === 'object') {
                 // Store basic city/area structure for existence checks
                 _internalState.cities = {};
                 Object.keys(cityData).forEach(cityKey => {
                    _internalState.cities[cityKey] = {};
                    if (cityData[cityKey]?.areas) {
                        Object.keys(cityData[cityKey].areas).forEach(areaKey => {
                            _internalState.cities[cityKey][areaKey] = {}; // Just mark existence
                        });
                    }
                 });
                 updated = true;
            }

            // if (updated) {
            //     _log(`State updated: Player(${_internalState.player.x},${_internalState.player.y}) City:${_internalState.player.currentCity} Area:${_internalState.player.currentArea} NPCs:${_internalState.npcs.length}`);
            // }
        },

        getMessagesForScope: function(scope, cityKey = null, areaKey = null) {
            const scopeKey = _getScopeKey(scope, cityKey, areaKey);
            if (!scopeKey) return [];
            return _internalState.messages[scopeKey] || [];
        },

        start: function() {
            if (!_internalState.isInitialized || _internalState.isActive) return;
            _log("Starting autonomous chat bot...");
            _internalState.isActive = true;
            clearInterval(_botIntervalId); // Clear any existing
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

        // Function to manually add a system message (e.g., player entering area)
        addSystemMessage: function(scope, cityKey, areaKey, text) {
             const scopeKey = _getScopeKey(scope, cityKey, areaKey);
             if (scopeKey) {
                 _addMessage(scopeKey, 'SYSTEM', text);
             }
        }
    };

    return publicApi;

})();

// Example of how the main script would use it (DO NOT INCLUDE THIS PART IN spatial_chat.js itself)
/*
// In index.html script, after DOMContentLoaded and after api_providers.js is loaded:

const initialPlayerState = { x: playerData.x, y: playerData.y, currentCity: currentCityKey, currentArea: '...' }; // Get current area somehow
const initialNpcs = npcData.map(npc => ({...})); // Map npcData to required format
const initialCities = { ... }; // Extract city/area structure if needed by spatial chat

SpatialChat.init(
    { // Config
        proxyProviderId: 'BIGMODEL_PROXY',
        proxyModelId: 'glm-4-flash',
        botIntervalMs: 25000,
        generalChatRange: 60
    },
    { // Initial State
        player: initialPlayerState,
        npcs: initialNpcs,
        cities: initialCities
    }
);

SpatialChat.start(); // Start the bot

// When player moves or NPCs change:
function updateSpatialChatModuleState() {
     const currentPlayerState = { x: playerData.x, y: playerData.y, currentCity: currentCityKey, currentArea: '...' };
     const currentNpcs = npcData.map(npc => ({...}));
     // const currentCities = { ... }; // Only needed if cities/areas can be added/removed dynamically by user
     SpatialChat.updateState(currentPlayerState, currentNpcs); // Send updates
}
setInterval(updateSpatialChatModuleState, 5000); // Example update interval


// When user clicks the 'Area' tab:
function displayAreaChat() {
    const messages = SpatialChat.getMessagesForScope('Area', currentCityKey, currentAreaKey);
    // Render messages into the chatMessages div...
    chatMessages.innerHTML = messages.join('\n'); // Simple example
}
areaTabButton.addEventListener('click', displayAreaChat);

// Similarly for General, City, World tabs...

// When changing city in main app:
function handleCityChange(newCityKey) {
    SpatialChat.stop(); // Stop bot for old city
    // ... load new city data ...
    const newPlayerState = { ... };
    const newNpcs = [...];
    const newCities = { ... };
    SpatialChat.updateState(newPlayerState, newNpcs, newCities); // Update with new city data
    SpatialChat.start(); // Start bot for new city
}

*/

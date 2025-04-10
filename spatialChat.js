// spatialChat.js

const SpatialChatModule = (function() {

    // --- Private State ---
    let _config = {
        proxyProviderKey: 'BIGMODEL_PROXY', // The key from PROVIDERS for your proxy
        proxyModelName: 'glm-4-flash',    // The model your proxy uses
        generalChatRange: 50,            // Range for 'General' chat
        autonomousChatIntervalMs: 25000, // How often NPCs might talk on their own (adjust as needed)
        maxHistoryPerScope: 30,          // Max messages stored per scope history
        onEmitMessage: (author, text, type) => { console.warn("SpatialChat: onEmitMessage not configured!") },
        onEmitStatus: (status, message) => { console.warn("SpatialChat: onEmitStatus not configured!") } // For 'typing', 'error' etc.
    };
    let _state = {
        player: { x: 0, y: 0, currentCityKey: null, currentAreaKey: null },
        agents: [], // Array of agent objects { id, name, x, y, cityKey, areaKey, personality }
        areas: [],  // Array of area objects { id, name, x, y, width, height, cityKey }
        activeScope: null, // 'General', 'Area', 'City', 'World', or null
        conversationHistories: {}, // { 'scope-key': [{ author, text, type }], ... }
        isProcessingUserMessage: false,
        isProcessingAutonomousChat: false,
        autonomousChatIntervalId: null,
        currentAutonomousRequestId: 0,
    };

    // --- Private Helpers ---

    // Generates a unique key for storing history based on scope and location
    function _getScopeHistoryKey(scope, cityKey, areaKey) {
        switch (scope) {
            case 'General':
            case 'Area':
                return areaKey ? `area-${cityKey || 'unknown'}-${areaKey}` : null; // Area/General tied to area ID
            case 'City':
                return cityKey ? `city-${cityKey}` : null;
            case 'World':
                return 'world';
            default:
                console.warn(`SpatialChat: Unknown scope for history key: ${scope}`);
                return null;
        }
    }

    // Adds a message to the correct history array
    function _addMessageToHistory(scopeKey, author, text, type = 'text') {
        if (!scopeKey) return;
        if (!_state.conversationHistories[scopeKey]) {
            _state.conversationHistories[scopeKey] = [];
        }
        _state.conversationHistories[scopeKey].push({ author, text, type });

        // Limit history size
        if (_state.conversationHistories[scopeKey].length > _config.maxHistoryPerScope) {
            _state.conversationHistories[scopeKey].shift();
        }
    }

    // Finds the area the player is currently inside
    function _getCurrentArea(playerX, playerY, cityKey, areas) {
        return areas.find(area =>
            area.cityKey === cityKey &&
            playerX >= area.x && playerX < area.x + area.width &&
            playerY >= area.y && playerY < area.y + area.height
        );
    }

    // Calculates distance between two points
    function _calculateDistance(x1, y1, x2, y2) {
        return Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2));
    }

    // Determines which agents participate based on the scope and player position
    function _getAgentsInScope(scope, player, agents, areas) {
        const { x: playerX, y: playerY, currentCityKey, currentAreaKey } = player;
        if (!currentCityKey) return []; // Cannot determine scope without a city

        switch (scope) {
            case 'General': {
                const currentArea = _getCurrentArea(playerX, playerY, currentCityKey, areas);
                if (!currentArea) return []; // Or maybe agents in range regardless of area? For now, require area for General.
                const areaAgents = agents.filter(agent => agent.cityKey === currentCityKey && agent.areaKey === currentArea.id);
                return areaAgents.filter(agent =>
                    _calculateDistance(playerX, playerY, agent.x, agent.y) <= _config.generalChatRange
                );
            }
            case 'Area': {
                 const currentArea = _getCurrentArea(playerX, playerY, currentCityKey, areas);
                 const areaIdToUse = currentArea?.id || currentAreaKey; // Use detected area or the one set externally
                 if (!areaIdToUse) return [];
                return agents.filter(agent => agent.cityKey === currentCityKey && agent.areaKey === areaIdToUse);
            }
            case 'City':
                return agents.filter(agent => agent.cityKey === currentCityKey);
            case 'World':
                return agents; // All known agents
            default:
                return [];
        }
    }

    // Calls the AI using the configured proxy provider
    async function _callProxyAI(prompt, personality = 'You are an AI assistant in a spatial chat.', requestId = null) {
        // Check if a newer request has superseded this one (for autonomous chat)
         if (requestId !== null && requestId !== _state.currentAutonomousRequestId) {
             console.log(`SpatialChat: Cancelling outdated autonomous request ${requestId}`);
             return null; // Don't proceed
         }

        if (typeof window.getApiResponse !== 'function') {
            console.error("SpatialChat: window.getApiResponse is not available!");
            _config.onEmitStatus('error', "Underlying API function not found.");
            return "Error: API function unavailable.";
        }

        const messages = [
            { role: "system", content: personality },
            { role: "user", content: prompt }
        ];

        try {
            // Always use null for apiKey when calling the proxy provider
            const response = await window.getApiResponse(
                _config.proxyProviderKey,
                _config.proxyModelName,
                messages,
                null, // API Key is null for proxy
                { temperature: 0.8 } // Add any specific options your proxy might need
            );
            return response;
        } catch (error) {
            console.error(`SpatialChat: Error calling AI via proxy (${_config.proxyProviderKey}):`, error);
             // Don't emit status here if it's an autonomous chat cancellation
             if (!(requestId !== null && requestId !== _state.currentAutonomousRequestId)) {
                _config.onEmitStatus('error', `AI Error: ${error.message}`);
             }
            return `Error: ${error.message}`;
        }
    }

    // --- Autonomous Chat Logic ---
    function _startAutonomousChatTimer() {
        clearInterval(_state.autonomousChatIntervalId);
        _state.autonomousChatIntervalId = setInterval(_triggerAutonomousChat, _config.autonomousChatIntervalMs);
        console.log(`SpatialChat: Autonomous chat timer started (Interval: ${_config.autonomousChatIntervalMs}ms)`);
    }

    function _stopAutonomousChatTimer() {
        clearInterval(_state.autonomousChatIntervalId);
        _state.autonomousChatIntervalId = null;
         _state.currentAutonomousRequestId++; // Invalidate any pending requests
        console.log("SpatialChat: Autonomous chat timer stopped.");
    }

    async function _triggerAutonomousChat() {
        if (_state.isProcessingAutonomousChat || _state.isProcessingUserMessage || !_state.activeScope || _state.activeScope === 'Message' || _state.activeScope === 'Agent') {
            return; // Don't run if busy, or if not in a spatial scope
        }
         _state.currentAutonomousRequestId++; // Increment for current attempt
         const currentRequestId = _state.currentAutonomousRequestId;


        const agentsInScope = _getAgentsInScope(_state.activeScope, _state.player, _state.agents, _state.areas);
        if (agentsInScope.length === 0) return; // No one to talk

        // Simple: Pick a random agent from the current scope
        const speaker = agentsInScope[Math.floor(Math.random() * agentsInScope.length)];

        const scopeKey = _getScopeHistoryKey(_state.activeScope, _state.player.currentCityKey, _state.player.currentAreaKey);
        if (!scopeKey) return;

        const history = _state.conversationHistories[scopeKey] || [];
        const recentMessages = history.slice(-5).map(m => `<${m.author}> ${m.text}`).join('\n');

        const prompt = `You are ${speaker.name}. Personality: ${speaker.personality || 'Standard Agent'}.
You are in the #${_state.activeScope} chat scope.
The player is at (${_state.player.x.toFixed(0)}, ${_state.player.y.toFixed(0)})${_state.player.currentAreaKey ? ` in area ${_state.player.currentAreaKey}` : ''}.
Other agents possibly in this scope: ${agentsInScope.map(a => a.name).filter(n => n !== speaker.name).join(', ') || 'None'}.
Recent conversation snippet:
---
${recentMessages || '(Silence)'}
---
Based on your personality, the scope, the player's location, and the recent chat, either continue the conversation naturally, start a relevant topic, or remain silent if appropriate. If you speak, keep it brief (1-2 sentences). Do NOT act as a generic assistant unless that IS your personality. Only output your chat message, without your name/prefix.`;

        _state.isProcessingAutonomousChat = true;
        _config.onEmitStatus('typing', `${speaker.name} is thinking...`); // Notify main UI

        try {
            const response = await _callProxyAI(prompt, speaker.personality, currentRequestId);

             // Check if request is still valid before processing response
             if (currentRequestId !== _state.currentAutonomousRequestId) {
                 console.log(`SpatialChat: Ignoring response for cancelled autonomous request ${currentRequestId}`);
                 return;
             }

            if (response && !response.startsWith("Error:")) {
                // Simple check to reduce "..." or similar low-content responses
                if (response.length > 5 && !/^\s*(\.|\*|_)+\s*$/.test(response)) {
                     // Emit message back to main UI
                    _config.onEmitMessage(speaker.name, response, 'ai');
                    // Add to internal history
                    _addMessageToHistory(scopeKey, speaker.name, response);
                } else {
                     console.log(`SpatialChat: Skipping low-content autonomous response from ${speaker.name}: "${response}"`);
                }
            } else if (response) { // Log AI errors but don't necessarily show in chat
                console.error(`SpatialChat: Autonomous AI error for ${speaker.name}: ${response}`);
            }
        } catch (error) {
            console.error("SpatialChat: Uncaught error during autonomous chat trigger:", error);
        } finally {
             if (currentRequestId === _state.currentAutonomousRequestId) { // Only clear status if this was the latest request
                _config.onEmitStatus('idle');
                _state.isProcessingAutonomousChat = false;
            }
        }
    }


    // --- Public API ---
    const publicApi = {
        init: function(config) {
            _config = { ..._config, ...config }; // Merge user config

            // Validate necessary callbacks
            if (typeof _config.onEmitMessage !== 'function') {
                throw new Error("SpatialChatModule requires an 'onEmitMessage' callback function during init.");
            }
            if (typeof _config.onEmitStatus !== 'function') {
                throw new Error("SpatialChatModule requires an 'onEmitStatus' callback function during init.");
            }
             if (!PROVIDERS || !PROVIDERS[_config.proxyProviderKey]) {
                 throw new Error(`SpatialChatModule: Configured proxy provider key "${_config.proxyProviderKey}" not found in api_providers.js.`);
             }
             if (!PROVIDERS[_config.proxyProviderKey].availableModels.includes(_config.proxyModelName)) {
                 console.warn(`SpatialChatModule: Configured proxy model "${_config.proxyModelName}" not listed for provider "${_config.proxyProviderKey}". Using it anyway.`);
             }

            _state.conversationHistories = {}; // Reset histories on init
            console.log("SpatialChatModule initialized with config:", _config);
            // Don't start timer here, wait for scope activation
        },

        // Called by index.html when a spatial tab is clicked
        setActiveScope: function(scope) {
            if (scope === _state.activeScope) return; // No change

            console.log(`SpatialChat: Setting active scope to: ${scope}`);
            _state.activeScope = scope;
            _state.isProcessingUserMessage = false; // Reset processing flags on scope change
            _state.isProcessingAutonomousChat = false;
            _state.currentAutonomousRequestId++; // Invalidate pending autonomous requests

            const scopeKey = _getScopeHistoryKey(scope, _state.player.currentCityKey, _state.player.currentAreaKey);

            // Emit existing history for this scope to the main UI
            const history = scopeKey ? (_state.conversationHistories[scopeKey] || []) : [];
            _config.onEmitMessage(null, null, 'history', history); // Special type 'history'

            // Manage autonomous chat timer
            if (scope && scope !== 'Message' && scope !== 'Agent') {
                _startAutonomousChatTimer();
                // Optionally trigger one immediately if desired
                 // setTimeout(_triggerAutonomousChat, 1000);
            } else {
                _stopAutonomousChatTimer();
            }
        },

        // Called by index.html when player sends message in a spatial scope
        handleUserInput: async function(text) {
            if (!_state.activeScope || _state.activeScope === 'Message' || _state.activeScope === 'Agent' || _state.isProcessingUserMessage) {
                console.warn("SpatialChat: Ignoring user input - inactive scope or already processing.");
                return;
            }

            const scopeKey = _getScopeHistoryKey(_state.activeScope, _state.player.currentCityKey, _state.player.currentAreaKey);
            if (!scopeKey) {
                _config.onEmitMessage("SYSTEM", "Cannot determine chat context.", 'error');
                return;
            }

            _state.isProcessingUserMessage = true;
            _config.onEmitStatus('typing', "Processing message..."); // Generic status

            // 1. Emit and store user message
            _config.onEmitMessage("USER", text, 'user');
            _addMessageToHistory(scopeKey, "USER", text);

            // 2. Determine potential AI responders for this scope
            const agentsInScope = _getAgentsInScope(_state.activeScope, _state.player, _state.agents, _state.areas);

            if (agentsInScope.length === 0 && _state.activeScope !== 'World') { // Allow World chat even with 0 agents locally? Maybe not.
                console.log("SpatialChat: No agents in scope to respond.");
                 _config.onEmitStatus('idle');
                _state.isProcessingUserMessage = false;
                return; // No one to hear/respond
            }

            // 3. Simple approach: Have *one* random agent respond (can be enhanced later)
             const responder = agentsInScope[Math.floor(Math.random() * agentsInScope.length)];

             if (!responder) { // Should only happen if agentsInScope was empty initially
                 console.log("SpatialChat: No responder found.");
                 _config.onEmitStatus('idle');
                 _state.isProcessingUserMessage = false;
                 return;
             }


            // 4. Prepare prompt for the chosen responder
            const history = _state.conversationHistories[scopeKey] || [];
            const recentMessages = history.slice(-6).map(m => `<${m.author}> ${m.text}`).join('\n'); // Include user's latest message

            const prompt = `You are ${responder.name}. Personality: ${responder.personality || 'Standard Agent'}.
You are in the #${_state.activeScope} chat scope.
The player (USER) just said: "${text}".
Recent conversation snippet (including USER's message):
---
${recentMessages}
---
Based on your personality, the scope, and the recent chat, provide a concise, in-character response to the USER. Only output your chat message, without your name/prefix.`;

            _config.onEmitStatus('typing', `${responder.name} is responding...`);

            // 5. Call AI and handle response
            try {
                const response = await _callProxyAI(prompt, responder.personality);
                if (response && !response.startsWith("Error:")) {
                    _config.onEmitMessage(responder.name, response, 'ai');
                    _addMessageToHistory(scopeKey, responder.name, response);
                } else if (response) {
                    _config.onEmitMessage("SYSTEM", `AI error for ${responder.name}: ${response}`, 'error');
                     // Don't add AI error to history
                } else {
                    // No response or cancelled?
                    console.log(`SpatialChat: No valid AI response received for ${responder.name}.`);
                }
            } catch (error) { // Should be caught by _callProxyAI, but as fallback
                console.error("SpatialChat: Error during user input handling:", error);
                _config.onEmitMessage("SYSTEM", `Error processing response: ${error.message}`, 'error');
            } finally {
                _config.onEmitStatus('idle');
                _state.isProcessingUserMessage = false;
            }
        },

        // Called by index.html to update agent data
        updateAgentData: function(newAgentList) {
            // Simple replacement, could be more sophisticated (diffing) if needed
             _state.agents = newAgentList.map(a => ({ // Ensure consistent structure
                 id: a.id,
                 name: a.name,
                 x: a.x,
                 y: a.y,
                 cityKey: a.cityKey, // Assuming main sim provides this
                 areaKey: a.areaKey,   // Assuming main sim provides this
                 personality: a.personaPrompt || `You are ${a.name}.`
             }));
            // console.log("SpatialChat: Updated agent data", _state.agents);
        },

        // Called by index.html to update area data
        updateAreaData: function(newAreaList) {
            _state.areas = newAreaList.map(a => ({ // Ensure consistent structure
                 id: a.id,
                 name: a.name,
                 x: a.x,
                 y: a.y,
                 width: a.width,
                 height: a.height,
                 cityKey: a.cityKey // Assuming main sim provides this
            }));
           // console.log("SpatialChat: Updated area data", _state.areas);
        },

        // Called by index.html to update player data
        updatePlayerData: function(playerData) {
             const oldArea = _getCurrentArea(_state.player.x, _state.player.y, _state.player.currentCityKey, _state.areas);
             const oldAreaKey = oldArea?.id || _state.player.currentAreaKey;

             _state.player = {
                 x: playerData.x,
                 y: playerData.y,
                 currentCityKey: playerData.currentCityKey,
                 currentAreaKey: playerData.currentAreaKey // Store the explicit area key from main sim
             };

             // Check if the derived area from coords differs from the stored areaKey
             const currentDerivedArea = _getCurrentArea(_state.player.x, _state.player.y, _state.player.currentCityKey, _state.areas);
             const currentDerivedAreaKey = currentDerivedArea?.id || null;

             // If player moved between areas, emit system message in the *new* area's chat
             if (currentDerivedAreaKey !== oldAreaKey && _state.activeScope === 'Area') {
                 const newScopeKey = _getScopeHistoryKey('Area', _state.player.currentCityKey, currentDerivedAreaKey);
                 if (newScopeKey) {
                     const message = currentDerivedAreaKey
                        ? `* You entered the ${currentDerivedAreaKey} area. *`
                        : `* You left the ${oldAreaKey} area. *`;
                     _addMessageToHistory(newScopeKey, "SYSTEM", message);
                     // If the scope is active, the main UI should re-request history via setActiveScope potentially,
                     // or we emit this directly. Let's emit directly for simplicity.
                     _config.onEmitMessage("SYSTEM", message, 'system');
                 }
             }
            // console.log("SpatialChat: Updated player data", _state.player);
        },

        // Reset state (e.g., on full reload or major change)
        reset: function() {
            _stopAutonomousChatTimer();
            _state.activeScope = null;
            _state.conversationHistories = {};
            _state.isProcessingUserMessage = false;
            _state.isProcessingAutonomousChat = false;
            _state.currentAutonomousRequestId++; // Invalidate pending requests
            console.log("SpatialChatModule: Reset.");
        }
    };

    return publicApi;

})();

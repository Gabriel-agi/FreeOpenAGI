// spatial_chat_manager.js

const SpatialChatManager = (function() {

    // --- Private State ---
    let _state = {
        messages: {}, // { 'scopeKey': ['msg1', 'msg2'] }
        player: { x: 0, y: 0, currentCity: null, currentArea: null }, // Minimal player info needed
        npcs: [], // Array of { name, x, y, personality, city, area } derived from main sim
        currentScope: 'Area', // Default: General, Area, City, World
        isActive: false // Is a spatial scope currently active?
    };

    let _config = {
        generalChatRange: 35, // How close NPCs need to be for 'General' chat
        botInterval: 20000, // Milliseconds between potential bot messages (20s)
        proxyProviderId: 'BIGMODEL_PROXY', // ID matching api_providers.js
        proxyModel: 'glm-4-flash',       // Model used by the proxy
        maxMessagesPerScope: 100,
        localStorageKey: 'spatialChatManagerState_v1'
    };

    let _callbacks = {
        addMessage: null, // Function from index.html to add message to UI: (text, author, scopeKey, ?isBotOrigin) => {}
        apiCall: null     // Function from api_providers.js: async (provider, model, messages, apiKey) => {}
    };

    let _botTimer = null;
    let _isBotProcessing = false;

    // --- Private Utilities ---

    function _log(message, ...args) {
        console.log('[SpatialChat]', message, ...args);
    }

    function _error(message, ...args) {
        console.error('[SpatialChat]', message, ...args);
    }

    function _calculateDistance(x1, y1, x2, y2) {
        return Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2));
    }

    // --- Private Scope/Message Key Logic ---

    function _getMessageKeyForScope(scope) {
        const { currentCity, currentArea } = _state.player;

        // Need location for local scopes
        if ((scope === 'General' || scope === 'Area') && (!currentCity || !currentArea)) {
            return null;
        }
        if (scope === 'City' && !currentCity) {
            return null;
        }

        switch (scope) {
            case 'General': return `${currentCity}-${currentArea}-general`;
            case 'Area':    return `${currentCity}-${currentArea}-area`;
            case 'City':    return `${currentCity}-city`;
            case 'World':   return 'world-chat';
            default:        return null; // Invalid scope for spatial chat
        }
    }

    function _getCurrentMessageKey() {
        return _getMessageKeyForScope(_state.currentScope);
    }

    // --- Private AI Getters (Using _state.npcs) ---

    function _getNearbyAIs() {
        if (!_state.player.currentCity || !_state.player.currentArea) return [];
        return _state.npcs.filter(npc =>
            npc.city === _state.player.currentCity &&
            npc.area === _state.player.currentArea &&
            _calculateDistance(_state.player.x, _state.player.y, npc.x, npc.y) <= _config.generalChatRange
        );
    }

    function _getAIsInCurrentArea() {
        if (!_state.player.currentCity || !_state.player.currentArea) return [];
        return _state.npcs.filter(npc =>
            npc.city === _state.player.currentCity &&
            npc.area === _state.player.currentArea
        );
    }

    function _getAIsInCurrentCity() {
        if (!_state.player.currentCity) return [];
        return _state.npcs.filter(npc => npc.city === _state.player.currentCity);
    }

    function _getAllAIs() {
        return _state.npcs;
    }

    // --- Private Message Handling ---

    function _addLocalMessage(text, author = 'SYSTEM', scopeKey) {
        if (!scopeKey) {
            _error("Attempted to add message with invalid scopeKey");
            return;
        }
        if (!_callbacks.addMessage) {
             _error("addMessage callback not configured!");
             return;
        }

        const messageText = `<${author}> ${text}`;
        _state.messages[scopeKey] = _state.messages[scopeKey] || [];
        _state.messages[scopeKey].push(messageText);

        // Limit history size
        if (_state.messages[scopeKey].length > _config.maxMessagesPerScope) {
            _state.messages[scopeKey].shift();
        }

        // Only call the UI update if this scope is currently active
        if (scopeKey === _getCurrentMessageKey() && _state.isActive) {
            _callbacks.addMessage(text, author, scopeKey, author !== 'USER'); // Pass true if bot/system origin
        }
    }

    // --- Private AI Interaction (Always uses Proxy) ---
    async function _proxyAiChat(prompt, personality) {
        if (!_callbacks.apiCall) {
            _error("apiCall callback not configured!");
            return "Error: API callback missing.";
        }

        const messages = [
            { role: "system", content: personality || "You are an AI in a simulated world. Keep responses concise and relevant to the chat context." },
            { role: "user", content: prompt }
        ];

        try {
            // Always use the configured proxy provider and model, apiKey is null
            const response = await _callbacks.apiCall(
                _config.proxyProviderId,
                _config.proxyModel,
                messages,
                null // API Key is null for proxy
            );
            return response || " "; // Return empty string if response is null/undefined
        } catch (e) {
            _error("Proxy AI Chat Error:", e);
            return `Error: ${e.message}`;
        }
    }

    // --- Private Bot Logic ---

    function _startBotTimer() {
        clearInterval(_botTimer);
        _botTimer = null;
        if (_state.isActive) { // Only run if a spatial scope is active
            _log("Starting bot timer with interval:", _config.botInterval);
            _botTimer = setInterval(_botAction, _config.botInterval);
        } else {
            _log("Bot timer not started (spatial chat inactive).");
        }
    }

    function _stopBotTimer() {
         _log("Stopping bot timer.");
         clearInterval(_botTimer);
         _botTimer = null;
    }

    async function _botAction() {
        if (_isBotProcessing || !_state.isActive) {
            // _log("Bot skipping cycle (processing or inactive)");
            return; // Don't overlap or run if not active
        }
        if (!_state.player.currentCity || !_state.player.currentArea) {
            // _log("Bot skipping cycle (player location unknown)");
            return; // Need player location for context
        }

        _isBotProcessing = true;
        //_log("Bot considering action for scope:", _state.currentScope);

        let potentialSpeakers = [];
        switch (_state.currentScope) {
            case 'General': potentialSpeakers = _getNearbyAIs(); break;
            case 'Area':    potentialSpeakers = _getAIsInCurrentArea(); break;
            case 'City':    potentialSpeakers = _getAIsInCurrentCity(); break;
            case 'World':   potentialSpeakers = _getAllAIs(); break;
            default:        potentialSpeakers = []; // Should not happen for bot
        }

        // Simple chance for bot to speak
        const speakChance = 0.25; // 25% chance each interval someone *might* speak
        if (potentialSpeakers.length === 0 || Math.random() > speakChance) {
            // _log("Bot skipping (no speakers or chance failed)");
            _isBotProcessing = false;
            return;
        }

        // Select a random speaker from the potential pool
        const speaker = potentialSpeakers[Math.floor(Math.random() * potentialSpeakers.length)];
        const personality = speaker.personality || `You are ${speaker.name}.`;
        const messageKey = _getCurrentMessageKey();

        if (!messageKey) {
            _error("Bot cannot determine message key for scope", _state.currentScope);
            _isBotProcessing = false;
            return;
        }

        const recentMessages = (_state.messages[messageKey] || []).slice(-5).join('\n');
        const contextPrompt = `
Context: You are ${speaker.name} (${personality}).
Current Location: City '${_state.player.currentCity}', Area '${_state.player.currentArea}'.
Chat Scope: #${_state.currentScope}.
Nearby Player Coords: (${_state.player.x.toFixed(0)}, ${_state.player.y.toFixed(0)}).
Your Coords: (${speaker.x.toFixed(0)}, ${speaker.y.toFixed(0)}).
Recent Chat Messages (if any):
${recentMessages || "(The chat is quiet)"}

Task: Based on your personality, location, scope, and recent messages, decide if you want to say something short and in-character. If not, respond with only "[SILENCE]". If you speak, keep it brief (1-2 sentences). Do not greet unless initiating. Avoid directly quoting context.`;

        // _log(`Bot ${speaker.name} generating...`);

        try {
            const response = await _proxyAiChat(contextPrompt, personality);
            if (response && !response.startsWith('Error:') && response.toUpperCase().trim() !== '[SILENCE]') {
                 _log(`Bot ${speaker.name} speaking in #${_state.currentScope}: ${response.substring(0,50)}...`);
                 _addLocalMessage(response, speaker.name, messageKey);
            } else if (response && response.startsWith('Error:')) {
                _log(`Bot ${speaker.name} encountered API error: ${response}`);
            } else {
                //_log(`Bot ${speaker.name} chose silence.`);
            }
        } catch (error) {
            _error(`Bot ${speaker.name} action error:`, error);
        } finally {
            _isBotProcessing = false;
        }
    }

    // --- Private State Load/Save ---
    function _saveStateToLocalStorage() {
        try {
            // Only save messages, not player/npc data which comes from main sim
            const stateToSave = { messages: _state.messages };
            localStorage.setItem(_config.localStorageKey, JSON.stringify(stateToSave));
            // _log("Spatial chat state saved.");
        } catch (e) {
            _error("Failed to save spatial chat state:", e);
        }
    }

    function _loadStateFromLocalStorage() {
        try {
            const savedState = localStorage.getItem(_config.localStorageKey);
            if (savedState) {
                const parsedState = JSON.parse(savedState);
                // Restore only messages
                if (parsedState && typeof parsedState.messages === 'object') {
                    _state.messages = parsedState.messages;
                    _log("Spatial chat state loaded.");
                } else {
                     _log("Invalid saved spatial chat state found.");
                     _state.messages = {};
                }
            } else {
                 _log("No saved spatial chat state found.");
                 _state.messages = {};
            }
        } catch (e) {
            _error("Failed to load spatial chat state:", e);
            _state.messages = {};
        }
    }


    // --- Public API ---
    const publicApi = {
        init: function(config = {}, addMessageCallback, apiCallCallback) {
            if (!addMessageCallback || !apiCallCallback) {
                 throw new Error("[SpatialChat] Initialization requires addMessage and apiCall callbacks.");
            }
            _config = { ..._config, ...config }; // Merge user config
            _callbacks.addMessage = addMessageCallback;
            _callbacks.apiCall = apiCallCallback;

            _loadStateFromLocalStorage(); // Load saved messages
            _log("Initialized.");
            // Note: Bot timer is started/stopped via setActive based on tab changes in index.html
        },

        /**
         * Updates the manager's knowledge of the game world state.
         * Should be called frequently by the main simulation.
         * @param {object} playerData - { x, y, currentCity, currentArea }
         * @param {Array} npcData - Array of { name, x, y, personality, city, area }
         */
        updateSpatialContext: function(playerData, npcData) {
            let playerMoved = false;
            if (playerData) {
                 if (_state.player.x !== playerData.x || _state.player.y !== playerData.y ||
                     _state.player.currentCity !== playerData.currentCity || _state.player.currentArea !== playerData.currentArea) {
                     playerMoved = true;
                 }
                _state.player = { ...playerData }; // Update player state
            }
            if (npcData) {
                // Just store the provided array. Assume it's complete.
                _state.npcs = npcData;
            }

            // If player moved significantly within 'General' scope, maybe add a system message? (Optional)
            // if (playerMoved && _state.isActive && _state.currentScope === 'General') {
                 // _addLocalMessage(`* Player moved to (${_state.player.x.toFixed(0)},${_state.player.y.toFixed(0)}) *`, 'SYSTEM', _getCurrentMessageKey());
            // }
        },

        /**
         * Switches the active spatial chat scope.
         * @param {string} scopeName - 'General', 'Area', 'City', 'World'
         */
        switchScope: function(scopeName) {
            if (!['General', 'Area', 'City', 'World'].includes(scopeName)) {
                _error("Invalid scope name:", scopeName);
                return;
            }
            if (scopeName === _state.currentScope) return; // No change

            _log("Switching scope to:", scopeName);
            _state.currentScope = scopeName;

            // Bot timer control happens via setActive

            // Add a system message indicating the scope change
            const messageKey = _getCurrentMessageKey();
            if (messageKey) {
                 // Ensure message history exists for the new scope
                if (!_state.messages[messageKey]) {
                    _state.messages[messageKey] = [];
                }
                 _addLocalMessage(`Switched to #${scopeName} chat scope.`, 'SYSTEM', messageKey);
                 // Trigger bot check soon after switching to a populated scope
                 if (_state.isActive && _botTimer && _state.messages[messageKey].length > 1) { // >1 to avoid triggering on the switch message itself
                     setTimeout(_botAction, 1000);
                 }
            } else {
                _log("Cannot get message key for new scope - player location might be invalid.");
                 // If the scope becomes invalid (e.g., switch to Area with no Area known),
                 // the main UI should reflect this based on the null key.
            }

            // Tell the main UI to potentially clear/reload messages for the new scope
             if (_callbacks.addMessage) {
                 // Send a special signal or rely on addMessage filtering?
                 // Let's assume index.html clears and re-requests messages for the new scope.
                 // OR, the addMessage callback can handle clearing if the scopeKey changes.
             }
        },

        /**
         * Handles user messages sent specifically to a spatial scope.
         * @param {string} text - The user's message text.
         */
        sendMessage: async function(text) {
            if (!_state.isActive) {
                _log("Ignoring sendMessage, spatial chat is not active.");
                return;
            }
            const messageKey = _getCurrentMessageKey();
            if (!text || !messageKey) {
                 _log("Cannot send message - empty text or invalid scope/key.");
                 return;
            }

            _addLocalMessage(text, 'USER', messageKey); // Add user message locally and trigger UI update

            // Simple logic: Any user message might trigger *a* nearby bot response soon after
            // We don't directly target an AI here, rely on the bot interval or a slightly quicker check.
            if (_botTimer) {
                setTimeout(_botAction, 1500 + Math.random() * 2000); // Trigger a bot check 1.5-3.5s after user message
            }
            _saveStateToLocalStorage(); // Save state after adding user message
        },

        /**
         * Activates or deactivates the spatial chat system (e.g., when switching tabs).
         * @param {boolean} isActive - True to activate, false to deactivate.
         */
        setActive: function(isActive) {
            if (isActive === _state.isActive) return; // No change

            _state.isActive = isActive;
            _log(`Spatial chat ${isActive ? 'activated' : 'deactivated'}.`);

            if (isActive) {
                 _startBotTimer();
                 // Potentially trigger UI refresh or fetch messages for current scope?
                 // This depends on how index.html handles tab switching.
            } else {
                 _stopBotTimer();
            }
        },

        /**
         * Gets the currently active spatial scope.
         * @returns {string} The current scope name ('General', 'Area', 'City', 'World') or null.
         */
        getCurrentScope: function() {
            return _state.isActive ? _state.currentScope : null;
        },

        /**
        * Gets all messages for the currently active spatial scope.
        * @returns {Array<string> | null} Array of formatted messages or null if scope invalid.
        */
        getMessagesForCurrentScope: function() {
            const key = _getCurrentMessageKey();
            return key ? (_state.messages[key] || []) : null;
        },

        /**
         * Forces a save of the current message state to localStorage.
         */
        forceSaveState: function() {
             _saveStateToLocalStorage();
        }

    };

    return publicApi; // Expose only the public methods

})();

// spatialChat.js

const SpatialChat = (function() {
    'use strict';

    // --- Private State ---
    let _state = {
        currentScope: 'Area',       // e.g., 'General', 'Area', 'City', 'World', 'message-<agentId>', 'agent-<agentId>'
        currentTargetAgentId: null, // Stores the agent ID for 'message' or 'agent' scopes
        playerLocation: { city: null, area: null, x: 0, y: 0 },
        generatingFlags: { city: null, area: null }, // Track AI generation status
        isProcessingUserMessage: false,
        botTimerId: null,
        currentRequestId: 0,        // To cancel stale AI requests
        pendingRequests: new Set()  // Store active AI request IDs
    };

    let _config = {
        generalChatRange: 20,       // Units for 'General' chat visibility
        areaSize: 100,              // Reference size for coordinate context (can be visual)
        botInterval: 20000,         // How often autonomous agents might speak (ms)
        maxHistoryPerScope: 50,     // Max messages to keep per chat scope
        autonomousScopeChance: 0.1, // Chance an agent speaks autonomously per interval
        // --- API Config (MUST be provided via init) ---
        proxyProvider: null,        // e.g., 'BIGMODEL_PROXY'
        proxyModel: null,           // e.g., 'glm-4-flash'
        mainAppProvider: null,      // Provider selected in the main app (for Message/Agent scopes)
        mainAppModel: null,         // Model selected in the main app (for Message/Agent scopes)
        // --- Callbacks (MUST be provided via init) ---
        onDisplayMessage: (messageObject, scopeKey, isInitialLoad) => { console.warn("SpatialChat: onDisplayMessage callback not provided."); },
        onClearMessages: (scopeKey) => { console.warn("SpatialChat: onClearMessages callback not provided."); },
        onUpdateScopeInfo: (scopeInfo) => { console.warn("SpatialChat: onUpdateScopeInfo callback not provided."); },
        getApiResponseFunction: async (provider, model, messages, apiKey) => {
            console.error("SpatialChat: getApiResponseFunction not provided during init.");
            throw new Error("API function not available.");
        },
        // Function provided by main app to get the *next* API key for cycling (for non-proxy calls)
        // Should return { key: "...", indexUsed: 0 } or null if no keys/error
        getNextApiKeyFunction: (provider) => {
             console.warn(`SpatialChat: getNextApiKeyFunction not provided. Cannot get key for ${provider}.`);
             return null; // { key: null, indexUsed: -1 };
        },
        // Function provided by main app to advance the key index after a failure
        advanceApiKeyIndexFunction: (provider, indexUsed) => {
             console.warn(`SpatialChat: advanceApiKeyIndexFunction not provided for ${provider}.`);
        }
    };

    // --- Data from Main App (Populated via init/update) ---
    let _data = {
        player: { name: 'Player', id: 'player' }, // Basic player info needed
        agents: [],           // Array of agent objects { id, name, personaPrompt, appearance, pfp, x, y, currentCity, currentArea }
        environments: []      // Array of env objects { id, name, x, y, width, height, currentCity } - Used for Area scope context
    };

    // --- Conversation Histories ---
    // Stores history like: { 'CityA-AreaB-area': [{role, content}, ...], 'message-123': [...] }
    let _histories = {};
    const STORAGE_KEY_HISTORIES = 'spatialChat_histories_v1';
    const STORAGE_KEY_STATE = 'spatialChat_state_v1';

    // --- Private Utility Functions ---

    function _log(level, ...args) {
        const prefix = "[SpatialChat]";
        switch(level) {
            case 'error': console.error(prefix, ...args); break;
            case 'warn': console.warn(prefix, ...args); break;
            case 'info': console.info(prefix, ...args); break;
            case 'debug': console.log(prefix, ...args); break; // Simple log for debug
            default: console.log(prefix, ...args);
        }
    }

    function _saveState() {
        try {
            // Don't save pendingRequests or botTimerId
            const stateToSave = {
                currentScope: _state.currentScope,
                currentTargetAgentId: _state.currentTargetAgentId,
                playerLocation: _state.playerLocation // Save last known location
            };
            localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(stateToSave));
            localStorage.setItem(STORAGE_KEY_HISTORIES, JSON.stringify(_histories));
            // _log('debug', 'State and histories saved.');
        } catch (e) {
            _log('error', 'Failed to save state/histories:', e);
        }
    }

    function _loadState() {
        try {
            const savedState = localStorage.getItem(STORAGE_KEY_STATE);
            if (savedState) {
                const parsed = JSON.parse(savedState);
                _state.currentScope = parsed.currentScope || 'Area';
                _state.currentTargetAgentId = parsed.currentTargetAgentId || null;
                _state.playerLocation = parsed.playerLocation || { city: null, area: null, x: 0, y: 0 };
                 // Ensure scope is valid, default if not
                 const validScopes = ['General', 'Area', 'City', 'World'];
                 if (!validScopes.includes(_state.currentScope) && !_state.currentScope.startsWith('message-') && !_state.currentScope.startsWith('agent-')) {
                     _log('warn', `Loaded invalid scope "${_state.currentScope}", defaulting to Area.`);
                     _state.currentScope = 'Area';
                     _state.currentTargetAgentId = null;
                 }
            }

            const savedHistories = localStorage.getItem(STORAGE_KEY_HISTORIES);
            if (savedHistories) {
                _histories = JSON.parse(savedHistories);
                // Basic validation if needed (e.g., ensure values are arrays)
                 Object.keys(_histories).forEach(key => {
                     if (!Array.isArray(_histories[key])) _histories[key] = [];
                 });
            }
            _log('info', `State loaded. Current scope: ${_state.currentScope}`);
        } catch (e) {
            _log('error', 'Failed to load state/histories:', e);
            _histories = {}; // Reset on error
            // Reset state to defaults on error? Or keep potentially partially loaded state?
            _state.currentScope = 'Area';
            _state.currentTargetAgentId = null;
        }
    }

    function _getUniqueScopeKey() {
        const scope = _state.currentScope;
        const city = _state.playerLocation.city;
        const area = _state.playerLocation.area;
        const targetId = _state.currentTargetAgentId;

        switch (scope) {
            case 'General': return (city && area) ? `${city}-${area}-general` : null;
            case 'Area':    return (city && area) ? `${city}-${area}-area` : null;
            case 'City':    return city ? `${city}-city` : null;
            case 'World':   return 'world-global';
            case 'Message': return targetId !== null ? `message-${targetId}` : null;
            case 'Agent':   return targetId !== null ? `agent-${targetId}` : null;
            default:
                _log('warn', 'Could not determine unique scope key for:', scope);
                return null;
        }
    }

    function _getHistoryForScope(scopeKey) {
        if (!scopeKey) return [];
        return _histories[scopeKey] || [];
    }

    function _addMessageToHistory(messageObject, scopeKey) {
        if (!scopeKey) return;
        if (!_histories[scopeKey]) {
            _histories[scopeKey] = [];
        }
        _histories[scopeKey].push(messageObject);
        // Limit history size
        if (_histories[scopeKey].length > _config.maxHistoryPerScope) {
            _histories[scopeKey] = _histories[scopeKey].slice(-_config.maxHistoryPerScope);
        }
         // Immediately save after adding a message
         _saveState();
    }

    function _calculateDistance(x1, y1, x2, y2) {
        return Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2));
    }

    // --- Agent Selection Logic ---
    function _getAgentsInCurrentArea() {
        const { city, area } = _state.playerLocation;
        if (!city || !area) return [];
        return _data.agents.filter(a => a.currentCity === city && a.currentArea === area);
    }

    function _getAgentsInCurrentCity() {
        const { city } = _state.playerLocation;
        if (!city) return [];
        return _data.agents.filter(a => a.currentCity === city);
    }

    function _getAgentsNearby() {
        const { city, area, x, y } = _state.playerLocation;
        if (!city || !area) return [];
        return _data.agents.filter(a =>
            a.currentCity === city &&
            a.currentArea === area &&
            _calculateDistance(x, y, a.x, a.y) <= _config.generalChatRange
        );
    }

    function _getAllAgents() {
        return _data.agents;
    }

    function _getAgentById(agentId) {
         return _data.agents.find(a => a.id === agentId);
    }

     // --- Get Context / Environment Info ---
     function _getCurrentEnvironmentInfo() {
        const { city, area } = _state.playerLocation;
        if (!city || !area) return null;
        const env = _data.environments.find(e => e.currentCity === city && e.name === area); // Assuming name is unique ID within city for now
         return env || { name: area, description: "An undefined space." }; // Fallback
     }

    // --- Internal AI Call Wrapper ---
    async function _makeApiCall(prompt, personality, provider, model, apiKey, isAutonomous = false) {
        const requestId = ++_state.currentRequestId;
        _state.pendingRequests.add(requestId);
        let responseContent = null;
        let errorOccurred = null;

        try {
            _log('debug', `Making API call. Provider: ${provider}, Model: ${model}, Key: ${apiKey ? maskApiKey(apiKey) : 'N/A'}, Autonomous: ${isAutonomous}`);
            const messages = [
                { role: "system", content: personality || "You are a helpful AI assistant." },
                // Add recent history from the relevant scope? - Keep it simple for now, just the prompt.
                { role: "user", content: prompt }
            ];

            // Use the provided fetch function
            responseContent = await _config.getApiResponseFunction(provider, model, messages, apiKey);

        } catch (error) {
            _log('error', `API call failed for ${provider}/${model}:`, error);
            errorOccurred = error;
        } finally {
            _state.pendingRequests.delete(requestId);
        }

        // Check if request was cancelled while awaiting
        if (!_state.pendingRequests.has(requestId) && !isAutonomous) {
             _log('debug', `API request ${requestId} was cancelled or superseded.`);
             return { content: null, error: new Error("Request cancelled"), keyIndexUsed: -1 }; // Indicate cancellation
        }

        return { content: responseContent, error: errorOccurred };
    }


    // --- Autonomous Agent Logic ---
    function _startBotTimer() {
        clearInterval(_state.botTimerId);
        _state.botTimerId = setInterval(_triggerAutonomousAgent, _config.botInterval);
        _log('debug', `Autonomous agent timer started (Interval: ${_config.botInterval}ms).`);
    }

    function _stopBotTimer() {
        clearInterval(_state.botTimerId);
        _state.botTimerId = null;
        _log('debug', 'Autonomous agent timer stopped.');
    }

    async function _triggerAutonomousAgent() {
        // Only trigger in public scopes and if player is located
        const scope = _state.currentScope;
        if (scope.startsWith('message-') || scope.startsWith('agent-') || !_state.playerLocation.city || !_state.playerLocation.area) {
            return;
        }

        if (Math.random() > _config.autonomousScopeChance) {
            //_log('debug', 'Skipping autonomous agent turn.');
            return;
        }

        let potentialSpeakers = [];
        let relevantScopeKey = _getUniqueScopeKey(); // Get key for current *public* scope
        if (!relevantScopeKey) return;

        switch (scope) {
            case 'General': potentialSpeakers = _getAgentsNearby(); break;
            case 'Area':    potentialSpeakers = _getAgentsInCurrentArea(); break;
            case 'City':    potentialSpeakers = _getAgentsInCurrentCity(); break;
            case 'World':   potentialSpeakers = _getAllAgents(); break;
            default: return; // Should not happen
        }

        // Exclude the player and filter out invalid agents
        potentialSpeakers = potentialSpeakers.filter(a => a && a.id !== 'player');
        if (potentialSpeakers.length === 0) return;

        const speaker = potentialSpeakers[Math.floor(Math.random() * potentialSpeakers.length)];
        const personality = speaker.personaPrompt || `You are ${speaker.name}, an agent in this simulation.`;
        const history = _getHistoryForScope(relevantScopeKey);
        const historyContext = history.slice(-4).map(m => `<${m.role === 'user' ? _data.player.name : m.senderName}> ${m.content}`).join('\n') || "The chat is quiet.";

        const prompt = `You are ${speaker.name}. Personality: ${personality}. You are observing the #${scope} chat scope. Participants include: ${potentialSpeakers.map(p=>p.name).join(', ')}. Player ${_data.player.name} is at (${_state.playerLocation.x.toFixed(0)}, ${_state.playerLocation.y.toFixed(0)}). Briefly say something relevant, in character, continuing the conversation or starting a short topic. Do not greet or announce yourself. Keep it concise (1-2 sentences max). Context of last few messages:\n${historyContext}\nYour brief message:`;

        _log('debug', `Autonomous agent ${speaker.name} triggering in scope ${scope}.`);

        // --- Autonomous calls ALWAYS use the proxy ---
        if (!_config.proxyProvider || !_config.proxyModel) {
             _log('warn', 'Autonomous agent cannot act: Proxy provider/model not configured.');
             return;
        }

        const result = await _makeApiCall(
            prompt,
            personality,
            _config.proxyProvider,
            _config.proxyModel,
            null, // No API key for proxy
            true // Mark as autonomous
        );

        if (result.content && !result.error) {
            const messageObj = {
                role: 'assistant', // Represent autonomous AI as 'assistant' role in history
                senderName: speaker.name, // Store who actually said it
                content: result.content,
                timestamp: Date.now(),
                scopeKey: relevantScopeKey,
                pfp: speaker.pfp // Include PFP info if available
            };
             _addMessageToHistory(messageObj, relevantScopeKey);
             // Only display if the user is currently viewing that scope
             if (relevantScopeKey === _getUniqueScopeKey()) {
                 _config.onDisplayMessage(messageObj, relevantScopeKey, false);
             }
        } else if (result.error) {
            _log('warn', `Autonomous agent ${speaker.name} failed: ${result.error.message}`);
        }
    }


    // --- Public API ---
    const publicApi = {
        init: function(userConfig, initialData) {
            _log('info', 'Initializing SpatialChat...');

            // 1. Merge Config
            _config = { ..._config, ...userConfig };
            if (!_config.proxyProvider || !_config.proxyModel) {
                 _log('warn', 'Proxy Provider/Model not set in config. Autonomous agents disabled.');
             }
             if (typeof _config.onDisplayMessage !== 'function' ||
                 typeof _config.onClearMessages !== 'function' ||
                 typeof _config.onUpdateScopeInfo !== 'function' ||
                 typeof _config.getApiResponseFunction !== 'function' ||
                 typeof _config.getNextApiKeyFunction !== 'function' ||
                 typeof _config.advanceApiKeyIndexFunction !== 'function') {
                _log('error', 'Initialization failed: One or more required callback functions missing in config.');
                return false; // Indicate failure
             }

            // 2. Store Initial Data (DEEP COPIES?) - For now, assume references are okay if main app manages mutation carefully
             _data.player = initialData.playerData || { name: 'Player', id: 'player' };
             _data.agents = initialData.npcData || [];
             _data.environments = initialData.environmentData || [];
             _state.playerLocation = { // Set initial player location from data
                 city: initialData.currentCityKey || null,
                 area: initialData.playerData?.currentArea || null, // Need area info on player data? Or derive it? Let's assume main app provides city key, derive area later.
                 x: initialData.playerData?.x || 0,
                 y: initialData.playerData?.y || 0
             };
             // Find initial area based on position if not explicitly provided
             if (_state.playerLocation.city && !_state.playerLocation.area) {
                 const playerEnv = _data.environments.find(e =>
                     e.currentCity === _state.playerLocation.city &&
                     _state.playerLocation.x >= e.x && _state.playerLocation.x < e.x + e.width &&
                     _state.playerLocation.y >= e.y && _state.playerLocation.y < e.y + e.height
                 );
                 _state.playerLocation.area = playerEnv ? playerEnv.name : null; // Assuming env name is area name
             }


            // 3. Load Persistent State
            _loadState();

             // 4. Update main app's provider/model (sync on init)
             _config.mainAppProvider = initialData.selectedProvider;
             _config.mainAppModel = initialData.selectedModel;


            // 5. Initial UI Update via Callbacks
            const initialScopeKey = _getUniqueScopeKey();
            _config.onClearMessages(initialScopeKey); // Clear just in case
            const initialHistory = _getHistoryForScope(initialScopeKey);
            initialHistory.forEach(msg => _config.onDisplayMessage(msg, initialScopeKey, true)); // Load history without animation
            _config.onUpdateScopeInfo(this.getCurrentScopeInfo()); // Update sidebar/context

            // 6. Start Timers / Reset Flags
            _state.pendingRequests.clear();
            _state.isProcessingUserMessage = false;
            _startBotTimer();

            _log('info', 'SpatialChat Initialized.');
            return true; // Indicate success
        },

        updateData: function(updatedData) {
            _log('debug', 'Updating data from main app...');
            let locationChanged = false;
            let scopeInfoNeedsUpdate = false;

            if (updatedData.playerData) {
                 if (_data.player.name !== updatedData.playerData.name) scopeInfoNeedsUpdate = true;
                 _data.player = { ..._data.player, ...updatedData.playerData }; // Merge updates

                 // Update internal location state
                 const newLoc = {
                     city: updatedData.currentCityKey || _state.playerLocation.city,
                     area: null, // Recalculate area based on new coords/city
                     x: updatedData.playerData.x ?? _state.playerLocation.x,
                     y: updatedData.playerData.y ?? _state.playerLocation.y,
                 };

                 // Find new area based on position
                 if (newLoc.city) {
                     const playerEnv = _data.environments.find(e =>
                         e.currentCity === newLoc.city &&
                         newLoc.x >= e.x && newLoc.x < e.x + e.width &&
                         newLoc.y >= e.y && newLoc.y < e.y + e.height
                     );
                     newLoc.area = playerEnv ? playerEnv.name : null;
                 }

                 if (newLoc.city !== _state.playerLocation.city || newLoc.area !== _state.playerLocation.area) {
                     locationChanged = true; // City or Area change triggers full scope switch logic
                 } else if (newLoc.x !== _state.playerLocation.x || newLoc.y !== _state.playerLocation.y) {
                      // Just coordinate change within the same area
                      _state.playerLocation = newLoc;
                      scopeInfoNeedsUpdate = true; // Need to update player coords display
                      if (_state.currentScope === 'General') { // Re-evaluate nearby agents for General chat
                           scopeInfoNeedsUpdate = true; // Force update of member list
                      }
                 }

            }
            if (updatedData.npcData) {
                _data.agents = updatedData.npcData;
                scopeInfoNeedsUpdate = true; // Agent list might have changed
            }
            if (updatedData.environmentData) {
                _data.environments = updatedData.environmentData;
                // Might need to update player area if current one was deleted/renamed
                if (_state.playerLocation.city && _state.playerLocation.area) {
                    const areaExists = _data.environments.some(e => e.currentCity === _state.playerLocation.city && e.name === _state.playerLocation.area);
                    if (!areaExists) {
                        _log('info', `Player's current area "${_state.playerLocation.area}" no longer exists. Resetting location.`);
                        _state.playerLocation.area = null; // Let it be recalculated or fallback
                        locationChanged = true; // Trigger potential scope change
                    }
                }
                scopeInfoNeedsUpdate = true;
            }
             if (updatedData.selectedProvider && updatedData.selectedProvider !== _config.mainAppProvider) {
                 _config.mainAppProvider = updatedData.selectedProvider;
                 _log('info', 'Main app provider updated to:', _config.mainAppProvider);
             }
             if (updatedData.selectedModel && updatedData.selectedModel !== _config.mainAppModel) {
                 _config.mainAppModel = updatedData.selectedModel;
                 _log('info', 'Main app model updated to:', _config.mainAppModel);
             }


            // Handle significant location changes by switching scope appropriately
             if (locationChanged) {
                 const oldScope = _state.currentScope;
                 _state.playerLocation = { // Update the location fully *before* switching scope
                     city: updatedData.currentCityKey || null,
                     area: _state.playerLocation.area, // Keep old area for a moment
                     x: updatedData.playerData?.x || 0,
                     y: updatedData.playerData?.y || 0,
                 };
                 // Recalculate area based on new city/coords
                 if (_state.playerLocation.city) {
                    const playerEnv = _data.environments.find(e =>
                        e.currentCity === _state.playerLocation.city &&
                        _state.playerLocation.x >= e.x && _state.playerLocation.x < e.x + e.width &&
                        _state.playerLocation.y >= e.y && _state.playerLocation.y < e.y + e.height
                    );
                    _state.playerLocation.area = playerEnv ? playerEnv.name : null;
                 }

                 // If the scope was area-specific, switch to the new area's scope
                 if (oldScope === 'Area' || oldScope === 'General') {
                      this.switchScope('Area', null); // Default to new Area scope
                 } else if (oldScope === 'City' && _state.playerLocation.city !== updatedData.currentCityKey) {
                      this.switchScope('City', null); // Update City scope if city changed
                 } else {
                     // If in World, Message, Agent, or failed to find new area, just update info
                     _config.onUpdateScopeInfo(this.getCurrentScopeInfo());
                 }
                 _saveState(); // Save the new location state

             } else if (scopeInfoNeedsUpdate) {
                 _config.onUpdateScopeInfo(this.getCurrentScopeInfo());
             }
        },

        switchScope: function(newScope, targetAgentId = null) {
            if (newScope === _state.currentScope && targetAgentId === _state.currentTargetAgentId) {
                return; // No change
            }

             // Validate targetAgentId if scope requires it
             if ((newScope === 'Message' || newScope === 'Agent') && targetAgentId === null) {
                 _log('warn', `Cannot switch to ${newScope} scope without a targetAgentId.`);
                 // Optionally switch to a default scope like 'Area'
                 // For now, just ignore the invalid switch
                 return;
             }
             // Validate player location for spatial scopes
             if ((newScope === 'General' || newScope === 'Area') && (!_state.playerLocation.city || !_state.playerLocation.area)) {
                  _log('warn', `Cannot switch to ${newScope} scope without player being in a city and area.`);
                  return; // Ignore invalid switch
             }
              if (newScope === 'City' && !_state.playerLocation.city) {
                  _log('warn', `Cannot switch to ${newScope} scope without player being in a city.`);
                  return; // Ignore invalid switch
             }


            _log('info', `Switching scope from ${_state.currentScope} to ${newScope}${targetAgentId ? ` (Target: ${targetAgentId})` : ''}`);

            // --- Stop/Cancel Pending ---
            _state.pendingRequests.clear(); // Cancel pending AI requests for the old scope
            _state.currentRequestId++;      // Ensure subsequent responses from old requests are ignored
            _state.isProcessingUserMessage = false; // Ensure user can type again
            _stopBotTimer();                // Stop autonomous bot

            // --- Update State ---
            const oldScopeKey = _getUniqueScopeKey();
            _state.currentScope = newScope;
            _state.currentTargetAgentId = (newScope === 'Message' || newScope === 'Agent') ? targetAgentId : null;
            const newScopeKey = _getUniqueScopeKey();

             if (!newScopeKey) {
                  _log('error', `Failed to switch scope: Could not generate a valid key for ${newScope}.`);
                  // Revert state? Or leave in limbo? For now, log error and maybe clear UI.
                  _config.onClearMessages(null); // Clear display
                  _config.onUpdateScopeInfo({ scope: 'Error', name: 'Invalid Context', members: [] });
                  return;
             }

            // --- Update UI (via Callbacks) ---
            _config.onClearMessages(oldScopeKey); // Clear display for the new scope
            const history = _getHistoryForScope(newScopeKey);
            if (history.length === 0 && newScopeKey) {
                 // Add a system message indicating the scope change if history is empty
                 let enterMsg = `Entered #${newScope} scope`;
                 if (newScope === 'Message' || newScope === 'Agent') {
                     const agent = _getAgentById(targetAgentId);
                     enterMsg = `Entered ${newScope} scope with ${agent?.name || `Agent ${targetAgentId}`}`;
                 } else if (newScope === 'Area') {
                    enterMsg = `Entered Area: ${_state.playerLocation.area || 'Unknown'}`;
                 } else if (newScope === 'City') {
                     enterMsg = `Entered City: ${_state.playerLocation.city || 'Unknown'}`;
                 }
                 const systemMessage = { role: 'system', content: enterMsg, timestamp: Date.now(), scopeKey: newScopeKey, senderName:'System' };
                 _addMessageToHistory(systemMessage, newScopeKey); // Add to history (no need to save state yet)
                 _config.onDisplayMessage(systemMessage, newScopeKey, true); // Display immediately
            } else {
                // Load existing history
                history.forEach(msg => _config.onDisplayMessage(msg, newScopeKey, true)); // isInitialLoad = true
            }
            _config.onUpdateScopeInfo(this.getCurrentScopeInfo()); // Update sidebar, etc.


            // --- Restart Bot? ---
            if (newScope !== 'Message' && newScope !== 'Agent' && _state.playerLocation.city && _state.playerLocation.area) {
                _startBotTimer(); // Restart bot only for public scopes if player is located
            }

            _saveState(); // Save the new scope state
        },

        sendMessage: async function(userText) {
            const scope = _state.currentScope;
            const scopeKey = _getUniqueScopeKey();
            const targetAgentId = _state.currentTargetAgentId;

            if (!userText || !scopeKey || _state.isProcessingUserMessage) {
                _log('warn', 'Cannot send message. Invalid state or processing.', { userText, scopeKey, processing: _state.isProcessingUserMessage });
                return;
            }

            _state.isProcessingUserMessage = true;
            _config.onUpdateScopeInfo(this.getCurrentScopeInfo()); // Reflect processing state

            const userMessage = {
                role: 'user',
                senderName: _data.player.name, // Add sender name
                content: userText,
                timestamp: Date.now(),
                scopeKey: scopeKey,
                pfp: _data.player.pfp // Include PFP info
            };
            _addMessageToHistory(userMessage, scopeKey);
            _config.onDisplayMessage(userMessage, scopeKey, false); // Display user message immediately

            let providerToUse, modelToUse, apiKeyToUse, keyIndexUsed = -1;
            let prompt = '';
            let personality = '';
            let responderName = 'AI'; // Default responder name

            try {
                // --- Determine API config and Prompt based on Scope ---
                if (scope === 'General' || scope === 'Area' || scope === 'City' || scope === 'World') {
                    // Use Proxy for public scopes
                    providerToUse = _config.proxyProvider;
                    modelToUse = _config.proxyModel;
                    apiKeyToUse = null; // No key needed for proxy

                    if (!providerToUse || !modelToUse) throw new Error("Proxy provider/model not configured for autonomous/public chat.");

                    // Select a random relevant agent to respond (or maybe blend personas?)
                    let potentialResponders = [];
                    if (scope === 'General') potentialResponders = _getAgentsNearby();
                    else if (scope === 'Area') potentialResponders = _getAgentsInCurrentArea();
                    else if (scope === 'City') potentialResponders = _getAgentsInCurrentCity();
                    else if (scope === 'World') potentialResponders = _getAllAgents();

                    potentialResponders = potentialResponders.filter(a => a && a.id !== 'player'); // Exclude player

                    if (potentialResponders.length > 0) {
                         const responder = potentialResponders[Math.floor(Math.random() * potentialResponders.length)];
                         responderName = responder.name;
                         personality = responder.personaPrompt || `You are ${responder.name}.`;
                         const history = _getHistoryForScope(scopeKey);
                         const historyContext = history.slice(-5).map(m => `<${m.senderName}> ${m.content}`).join('\n');
                         prompt = `You are ${responderName}. Personality: ${personality}. You are in the #${scope} chat. Player ${_data.player.name} is at (${_state.playerLocation.x.toFixed(0)}, ${_state.playerLocation.y.toFixed(0)}). Respond to their last message concisely, considering recent chat context. Context:\n${historyContext}\nYour response to '${userText}':`;
                    } else {
                         // No agents to respond in this public scope
                         throw new Error(`No agents available to respond in the #${scope} scope.`);
                    }

                } else if (scope === 'Message' || scope === 'Agent') {
                    // Use Main App's Provider/Model/Key Cycling for direct interaction
                    providerToUse = _config.mainAppProvider;
                    modelToUse = _config.mainAppModel;

                    if (!providerToUse || !modelToUse) throw new Error("Main application provider/model not selected/available.");

                    const targetAgent = _getAgentById(targetAgentId);
                    if (!targetAgent) throw new Error(`Target agent ${targetAgentId} not found for ${scope} scope.`);

                    responderName = targetAgent.name;
                    personality = targetAgent.personaPrompt || `You are ${targetAgent.name}.`;

                    // --- Get API Key using Cycling Function ---
                    let keyAttempt = 1;
                    const MAX_KEY_ATTEMPTS = 5; // Limit retry attempts
                    let keyInfo = null;
                    let callError = null;
                    let responseContent = null;

                    while (keyAttempt <= MAX_KEY_ATTEMPTS) {
                        keyInfo = _config.getNextApiKeyFunction(providerToUse); // Get the *next* key to try
                        apiKeyToUse = keyInfo?.key;
                        keyIndexUsed = keyInfo?.indexUsed ?? -1;

                        if (!apiKeyToUse) {
                            callError = new Error(`No valid API keys available for ${providerToUse} after ${keyAttempt-1} attempts.`);
                            break; // Exit loop if no more keys
                        }

                        _log('debug', `Attempt ${keyAttempt}: Using key index ${keyIndexUsed} for ${providerToUse}`);

                        const history = _getHistoryForScope(scopeKey);
                        const historyContext = history.slice(scope === 'Message' ? -MAX_HISTORY_PER_SCOPE*2 : -5); // Longer history for direct messages

                        if (scope === 'Message') { // Persona mode
                            prompt = userText; // Simple prompt for persona mode
                            // The system prompt (personality) is sent as the first message in history for 'getApiResponseFunction'
                             historyContext.unshift({ role: 'system', content: personality });
                        } else { // Agent mode
                            const gameState = `[Player(${_data.player.name}):Pos(${_state.playerLocation.x.toFixed(0)},${_state.playerLocation.y.toFixed(0)})] [Agent(${targetAgent.name}):Pos(${targetAgent.x.toFixed(0)},${targetAgent.y.toFixed(0)})]`;
                             const recentChat = historyContext.slice(-3).map(m => `<${m.senderName}> ${m.content}`).join('\n');
                            prompt = `SYSTEM: You are ${targetAgent.name}. Personality: ${personality}. ${gameState}. Respond to the last message from ${_data.player.name} based on your personality, the game state, and recent chat. ACTIONS: <Walk X,Y>, <Follow>. Keep responses concise.\n${recentChat}\n<${_data.player.name}> ${userText}\n<${targetAgent.name}>`;
                             // Agent mode prompt includes state, personality sent separately if API supports it
                             // Need to adapt how personality is passed based on getApiResponseFunction's needs
                             historyContext.unshift({ role: 'system', content: personality }); // Assume API function handles system prompt
                        }


                        // Make the actual API call attempt
                        try {
                            responseContent = await _config.getApiResponseFunction(providerToUse, modelToUse, historyContext, apiKeyToUse);
                             callError = null; // Reset error on success
                            _log('debug', `Key index ${keyIndexUsed} successful for ${providerToUse}.`);
                            // Success! Exit the loop.
                            break;
                        } catch (error) {
                            _log('warn', `Key index ${keyIndexUsed} failed for ${providerToUse}:`, error.message);
                            callError = error; // Store the error
                            // Check if it's a key-related error (401, 429, etc.)
                             const isKeyError = error.message.includes("401") || error.message.includes("429") || error.message.includes("Invalid API Key") || error.message.includes("authentication failed");

                             if (isKeyError) {
                                 _config.advanceApiKeyIndexFunction(providerToUse, keyIndexUsed); // Tell main app this key failed
                                 keyAttempt++; // Prepare for next attempt
                                 await new Promise(resolve => setTimeout(resolve, 200)); // Small delay before retry
                             } else {
                                 // Not a key error, break the loop and report this error
                                 break;
                             }
                        }
                    } // End while loop

                    // After the loop, check if we succeeded or failed
                    if (responseContent !== null && callError === null) {
                        // Process the successful response (done outside the try-catch)
                         const responseMessage = {
                             role: 'assistant', senderName: responderName, content: responseContent,
                             timestamp: Date.now(), scopeKey: scopeKey, pfp: targetAgent.pfp
                         };
                         _addMessageToHistory(responseMessage, scopeKey);
                         _config.onDisplayMessage(responseMessage, scopeKey, false);
                         // If agent mode, maybe parse actions from responseContent here?
                         // ... (action parsing logic would go here if needed) ...
                    } else {
                         // Handle final failure after retries or non-key error
                        const finalErrorMsg = callError?.message || "Unknown API error after retries.";
                        _log('error', `Final API failure for ${scope} with ${responderName}: ${finalErrorMsg}`);
                        const errorMessage = {
                            role: 'system', senderName: 'System', content: `Error interacting with ${responderName}: ${finalErrorMsg}`,
                            timestamp: Date.now(), scopeKey: scopeKey
                        };
                        _addMessageToHistory(errorMessage, scopeKey);
                        _config.onDisplayMessage(errorMessage, scopeKey, false);
                    }

                     _state.isProcessingUserMessage = false;
                     _config.onUpdateScopeInfo(this.getCurrentScopeInfo());
                     _saveState(); // Save state after interaction attempt
                     return; // Exit sendMessage as direct interaction is handled


                } else {
                    // Should not happen if scope logic is correct
                    throw new Error(`Unhandled chat scope: ${scope}`);
                }

                // --- API Call for Public Scopes (Proxy) ---
                if (responderName && prompt) {
                    const result = await _makeApiCall(prompt, personality, providerToUse, modelToUse, apiKeyToUse);
                    if (result.content && !result.error) {
                         const responseMessage = {
                             role: 'assistant', senderName: responderName, content: result.content,
                             timestamp: Date.now(), scopeKey: scopeKey, pfp: _getAgentById(targetAgentId)?.pfp // Get PFP if possible
                         };
                         _addMessageToHistory(responseMessage, scopeKey);
                         _config.onDisplayMessage(responseMessage, scopeKey, false);
                    } else {
                        const errorMsg = result.error?.message || 'Unknown API error.';
                        _log('error', `API failure for ${scope} (Proxy): ${errorMsg}`);
                        const errorMessage = {
                            role: 'system', senderName: 'System', content: `Error getting response in #${scope}: ${errorMsg}`,
                            timestamp: Date.now(), scopeKey: scopeKey
                        };
                        _addMessageToHistory(errorMessage, scopeKey);
                        _config.onDisplayMessage(errorMessage, scopeKey, false);
                    }
                }
                // If no responder was found for public scope (handled earlier by throwing error)

            } catch (error) {
                _log('error', 'Error in sendMessage:', error);
                 const errorScopeKey = _getUniqueScopeKey() || 'world-global'; // Fallback key
                const errorMessage = {
                    role: 'system', senderName: 'System', content: `Error: ${error.message}`,
                    timestamp: Date.now(), scopeKey: errorScopeKey
                };
                 _addMessageToHistory(errorMessage, errorScopeKey);
                 _config.onDisplayMessage(errorMessage, errorScopeKey, false);
            } finally {
                _state.isProcessingUserMessage = false;
                _config.onUpdateScopeInfo(this.getCurrentScopeInfo()); // Update UI state (remove processing indicator)
                _saveState(); // Ensure state is saved after processing
            }
        },

        getCurrentScopeInfo: function() {
            const scope = _state.currentScope;
            const { city, area, x, y } = _state.playerLocation;
            let name = scope; // Default name
            let members = [];
            let description = `Chatting in ${scope}`;

            try {
                switch (scope) {
                    case 'General':
                        name = `General (${area || 'Unknown Area'})`;
                        members = _getAgentsNearby().map(a => ({ id: a.id, name: a.name, x:a.x, y:a.y }));
                        description = `Nearby chat in ${area || 'Unknown Area'}, ${city || 'Unknown City'}`;
                        break;
                    case 'Area':
                        name = `Area: ${area || 'Unknown'}`;
                        members = _getAgentsInCurrentArea().map(a => ({ id: a.id, name: a.name, x:a.x, y:a.y }));
                         const env = _getCurrentEnvironmentInfo();
                         description = env?.description || `Chat within ${area || 'Unknown Area'}, ${city || 'Unknown City'}`;
                        break;
                    case 'City':
                        name = `City: ${city || 'Unknown'}`;
                        members = _getAgentsInCurrentCity().map(a => ({ id: a.id, name: a.name })); // No coords needed for city wide
                        description = `City-wide chat for ${city || 'Unknown City'}`;
                        break;
                    case 'World':
                        name = 'World';
                        members = _getAllAgents().map(a => ({ id: a.id, name: a.name })); // No coords needed
                        description = 'Global chat across all cities and areas.';
                        break;
                    case 'Message':
                    case 'Agent':
                        const agent = _getAgentById(_state.currentTargetAgentId);
                        name = `${scope} with ${agent?.name || 'Unknown'}`;
                        members = agent ? [{ id: agent.id, name: agent.name }] : [];
                        description = `Direct interaction: ${scope} with ${agent?.name || 'Unknown Agent'}.`;
                        break;
                }
            } catch (e) {
                 _log('error', "Error getting scope info:", e);
                 description = "Error retrieving scope details.";
            }


            return {
                scope: scope,
                name: name,
                description: description,
                player: { name: _data.player.name, x: x, y: y, city: city, area: area },
                members: members, // List of relevant agents for the scope
                isProcessing: _state.isProcessingUserMessage,
                targetAgentId: _state.currentTargetAgentId // Pass target agent ID
            };
        },

        // Add method to clear history (maybe called from main app settings?)
         clearHistoryForScope: function(scopeKeyToClear = null) {
             const key = scopeKeyToClear || _getUniqueScopeKey();
             if (key && _histories[key]) {
                 _log('info', `Clearing history for scope: ${key}`);
                 _histories[key] = []; // Clear the array
                 // Add a system message indicating clearance?
                 const systemMessage = { role: 'system', content: `Chat history for this scope cleared.`, timestamp: Date.now(), scopeKey: key, senderName:'System' };
                 _addMessageToHistory(systemMessage, key); // Adds to history *and* saves state

                 // If clearing the *current* scope, update the display
                 if (key === _getUniqueScopeKey()) {
                     _config.onClearMessages(key);
                     _config.onDisplayMessage(systemMessage, key, false);
                 }
                 return true;
             }
             _log('warn', `Could not clear history for scope key: ${key}`);
             return false;
         },

         // Allow external components (like the main app's context menu) to trigger a scope switch
         requestScopeSwitch: function(scope, targetId = null) {
              // Add validation if needed
              this.switchScope(scope, targetId);
         }

    };

    return publicApi; // Expose only the public methods

})();

// Example Usage (Remove or comment out when integrating)
/*
document.addEventListener('DOMContentLoaded', () => {
    const mockNpcData = [
        { id: 1, name: 'Guard', personaPrompt: 'You are a stern guard.', currentCity: 'CityA', currentArea: 'Gate', x: 10, y: 10, pfp: '...' },
        { id: 2, name: 'Merchant', personaPrompt: 'You are a friendly merchant.', currentCity: 'CityA', currentArea: 'Market', x: 50, y: 50, pfp: '...' },
        { id: 3, name: 'Old Man', personaPrompt: 'You are a wise old man.', currentCity: 'CityA', currentArea: 'Market', x: 55, y: 52, pfp: '...' },
        { id: 4, name: 'Ghost', personaPrompt: 'WoooOOOooo!', currentCity: 'CityB', currentArea: 'Ruins', x: 80, y: 80, pfp: '...' },
    ];
    const mockPlayerData = { name: 'Hero', id: 'player', x: 51, y: 51, pfp: '...' };
    const mockEnvData = [
        { id: 'env1', name: 'Gate', currentCity: 'CityA', x: 0, y: 0, width: 30, height: 30, description: 'The main gate.' },
        { id: 'env2', name: 'Market', currentCity: 'CityA', x: 30, y: 30, width: 40, height: 40, description: 'A bustling market square.' },
        { id: 'env3', name: 'Ruins', currentCity: 'CityB', x: 60, y: 60, width: 40, height: 40, description: 'Ancient, crumbling ruins.' },
    ];
    const mockCurrentCityKey = 'CityA';

    SpatialChat.init(
        { // Config
            proxyProvider: 'BIGMODEL_PROXY', // Use the key from api_providers.js
            proxyModel: 'glm-4-flash',      // Use the model from api_providers.js
            botInterval: 30000,             // 30 seconds for testing
            // --- Mock Callbacks (Replace with real main app functions) ---
            onDisplayMessage: (msg, key, isLoad) => {
                console.log(`[Display CB] Scope: ${key} | Load: ${isLoad} | <${msg.senderName}> ${msg.content}`);
                // In real app: Find the chat display area and append/update
            },
            onClearMessages: (key) => {
                 console.log(`[Clear CB] Scope: ${key}`);
                 // In real app: Find chat display and clear it
            },
            onUpdateScopeInfo: (info) => {
                 console.log('[Scope Info CB]', info);
                 // In real app: Update sidebar, context panel, etc.
            },
            getApiResponseFunction: window.getApiResponse, // Use the function from api_providers.js
            // Mock Key Cycling (Replace with real main app functions)
            getNextApiKeyFunction: (provider) => { console.warn('Using MOCK getNextApiKey'); return { key: 'MOCK_KEY_123', indexUsed: 0 }; },
            advanceApiKeyIndexFunction: (provider, indexUsed) => { console.warn(`Using MOCK advanceApiKeyIndex (Provider: ${provider}, Index: ${indexUsed})`); }
        },
        { // Initial Data
            playerData: mockPlayerData,
            npcData: mockNpcData,
            environmentData: mockEnvData,
            currentCityKey: mockCurrentCityKey,
            selectedProvider: 'SAMBANOVA', // Example main provider
            selectedModel: 'DeepSeek-V3-0324' // Example main model
        }
    );

     // Example external interaction
     // setTimeout(() => SpatialChat.switchScope('City'), 5000);
     // setTimeout(() => SpatialChat.sendMessage("Hello City!"), 6000);
     // setTimeout(() => SpatialChat.requestScopeSwitch('Message', 2), 10000); // PM Merchant
     // setTimeout(() => SpatialChat.sendMessage("Got any good deals?"), 11000);

});
*/

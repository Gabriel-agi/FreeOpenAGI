/**
 * spatial_chat_manager.js
 *
 * Manages different chat scopes (General, Area, City, World, Message, Agent),
 * their conversation histories, participants, and interaction logic.
 */

const SpatialChatManager = (function() {

    // --- Private State ---
    let _state = {
        activeScope: 'Agent', // Default to Agent mode initially
        currentCityKey: null,
        currentAreaId: null, // ID of the environment zone the player is primarily in
        currentAgentTarget: null, // Reference to the specific NPC for Message/Agent scopes
        conversationHistories: {}, // { scopeKey: [{role, content}, ...] }
        // References to main application state (set during init)
        playerDataRef: null,
        npcDataRef: null,
        environmentDataRef: null,
        apiProviderConfigRef: null,
        apiKeyManagementRef: null,
        // References to main application functions (set during init)
        getApiResponseFunctionRef: null,
        addMessageFunctionRef: null,
        findClosestNpcFunctionRef: null, // Need this reference
        findClosestEnvironmentZoneFunctionRef: null, // Need this reference

        isProcessing: false, // Flag to prevent concurrent sends within this manager
        // Bot related state (optional, can be expanded)
        // botTimer: null,
    };

    // --- Private Configuration ---
    let _config = {
        generalChatRange: 50, // Example range for General chat
        proxyProviderId: 'BIGMODEL_PROXY', // ID of the provider designated for proxy use
        maxHistoryPerScope: 50, // Max messages to keep per scope history
        // botInterval: 30000, // Example interval for autonomous chat
    };

    // --- Private Helper Functions ---

    /**
     * Calculates the unique key for storing conversation history based on the current scope and context.
     * @returns {string | null} The key for the history object, or null if context is invalid.
     */
    function _getScopeKey() {
        const { activeScope, currentCityKey, currentAreaId, currentAgentTarget } = _state;

        switch (activeScope) {
            case 'Message':
            case 'Agent':
                // History is tied to the specific agent being interacted with
                return currentAgentTarget ? `${activeScope}-${currentAgentTarget.id}` : null;
            case 'World':
                return 'World';
            case 'City':
                return currentCityKey ? `City-${currentCityKey}` : null;
            case 'Area':
                 // Determine current area based on player position if not explicitly set
                const area = _determineCurrentArea();
                const areaIdToUse = area ? area.id : null; // Use determined area ID
                return currentCityKey && areaIdToUse ? `Area-${currentCityKey}-${areaIdToUse}` : null;
            case 'General':
                 // General chat is also tied to the specific area
                 const generalArea = _determineCurrentArea();
                 const generalAreaIdToUse = generalArea ? generalArea.id : null;
                 return currentCityKey && generalAreaIdToUse ? `General-${currentCityKey}-${generalAreaIdToUse}` : null;

            default:
                console.warn("Unknown chat scope:", activeScope);
                return null;
        }
    }

     /**
      * Determines the primary environment zone the player is currently in.
      * Uses the findClosestEnvironmentZone function provided by the main app.
      * @returns {object | null} The environment data object or null.
      */
     function _determineCurrentArea() {
         if (!_state.findClosestEnvironmentZoneFunctionRef || !_state.playerDataRef) {
             return null;
         }
          // Find the closest zone overall
         const closestZone = _state.findClosestEnvironmentZoneFunctionRef();
         if (!closestZone) return null;

         // Check if player is actually inside the bounds of the closest zone
         const playerX = _state.playerDataRef.x;
         const playerY = _state.playerDataRef.y;
         if (playerX >= closestZone.x && playerX <= (closestZone.x + closestZone.width) &&
             playerY >= closestZone.y && playerY <= (closestZone.y + closestZone.height))
         {
             return closestZone; // Player is inside the closest zone
         }

         return null; // Player is not inside the closest zone's bounds
     }


    /**
     * Calculates the Euclidean distance between two points.
     * @param {number} x1
     * @param {number} y1
     * @param {number} x2
     * @param {number} y2
     * @returns {number}
     */
    function _calculateDistance(x1, y1, x2, y2) {
        if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return Infinity;
        return Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2));
    }

    /**
     * Gets the list of NPCs relevant to the current chat scope.
     * @returns {Array<object>} List of NPC data objects.
     */
    function _getParticipantsForScope() {
        const { activeScope, currentCityKey, currentAreaId, currentAgentTarget, npcDataRef, playerDataRef } = _state;

        if (!npcDataRef || !playerDataRef) return [];

        switch (activeScope) {
            case 'Message':
            case 'Agent':
                return currentAgentTarget ? [currentAgentTarget] : []; // Only the specific agent
            case 'World':
                return npcDataRef.filter(n => n?.element?.style.display !== 'none'); // All active NPCs
            case 'City':
                if (!currentCityKey) return [];
                 // Assumes NPCs have a property indicating their city or are filtered based on currentCityKey context
                 // This depends on how your main npcDataRef is structured or filtered.
                 // For simplicity, assuming all NPCs in npcDataRef belong to the current city FOR NOW.
                 // A more robust solution would involve tagging NPCs with their city.
                return npcDataRef.filter(n => n?.element?.style.display !== 'none');
            case 'Area':
                const area = _determineCurrentArea();
                if (!currentCityKey || !area) return [];
                // Filter NPCs within the bounds of the current area
                 return npcDataRef.filter(n =>
                     n?.element?.style.display !== 'none' &&
                     n.x >= area.x && n.x <= (area.x + area.width) &&
                     n.y >= area.y && n.y <= (area.y + area.height)
                 );
            case 'General':
                 const generalArea = _determineCurrentArea();
                 if (!currentCityKey || !generalArea || playerDataRef.x === undefined) return [];
                 // Filter NPCs within the general chat range *within the same area*
                 return npcDataRef.filter(n =>
                     n?.element?.style.display !== 'none' &&
                     n.x >= generalArea.x && n.x <= (generalArea.x + generalArea.width) && // Must be in the same area
                     n.y >= generalArea.y && n.y <= (generalArea.y + generalArea.height) &&
                     _calculateDistance(playerDataRef.x, playerDataRef.y, n.x, n.y) <= _config.generalChatRange
                 );
            default:
                return [];
        }
    }

    /**
     * Adds a message to the internal history for a given scope key.
     * @param {string} text - The message content.
     * @param {string} role - 'user', 'assistant', 'system'.
     * @param {string} scopeKey - The key for the conversation history.
     */
    function _addLocalMessage(text, role, scopeKey) {
        if (!scopeKey) {
            console.warn("Cannot add message: Invalid scope key.");
            return;
        }
        if (!_state.conversationHistories[scopeKey]) {
            _state.conversationHistories[scopeKey] = [];
        }
        _state.conversationHistories[scopeKey].push({ role, content: text });

        // Limit history size
        if (_state.conversationHistories[scopeKey].length > _config.maxHistoryPerScope) {
            // Keep system prompt if it exists as the first message
            const hasSystem = _state.conversationHistories[scopeKey][0]?.role === 'system';
            const startIndex = hasSystem ? 1 : 0;
            const excess = _state.conversationHistories[scopeKey].length - _config.maxHistoryPerScope;
            if (hasSystem) {
                _state.conversationHistories[scopeKey].splice(startIndex, excess);
            } else {
                 _state.conversationHistories[scopeKey] = _state.conversationHistories[scopeKey].slice(excess);
            }
        }
         // console.log(`[SCM] Added message to ${scopeKey}. History length: ${_state.conversationHistories[scopeKey].length}`);
    }

     /**
      * Prepares the prompt and context for an API call based on the current scope.
      * @param {string} userInput - The raw user input text.
      * @returns {object | null} An object { systemPrompt, userPromptContent, historyToSend } or null if invalid.
      */
     function _prepareApiCallData(userInput) {
         const { activeScope, currentAgentTarget, playerDataRef, npcDataRef } = _state;
         const scopeKey = _getScopeKey();
         if (!scopeKey) return null;

         let systemPrompt = "You are a helpful assistant.";
         let userPromptContent = userInput;
         const historyToSend = [...(_state.conversationHistories[scopeKey] || [])]; // Use copy

         if (activeScope === 'Agent' || activeScope === 'Message') {
             if (!currentAgentTarget) return null; // Cannot proceed without target
             // Use the persona/agent prompt generation logic (similar to main app's previous logic)
             const isAgentMode = activeScope === 'Agent';
             const basePersona = currentAgentTarget.personaPrompt || `You are ${currentAgentTarget.name}.`;
             systemPrompt = isAgentMode ? `${basePersona} ${BASE_ACTION_RULES}` : basePersona; // Assuming BASE_ACTION_RULES is globally accessible or passed in config

             if (isAgentMode && playerDataRef && npcDataRef) {
                 // Construct game state context for Agent mode
                 let gameState = `[P(${playerDataRef.name}):Pos(${Math.round(playerDataRef.x)},${Math.round(playerDataRef.y)})]`;
                 npcDataRef.forEach(n => { // Use the full npc list for context
                      if (n?.element?.style.display !== 'none' && typeof n.x === 'number') {
                          gameState += ` [${n.name}(${n.id}):Pos(${Math.round(n.x)},${Math.round(n.y)})${n.followingTargetId !== null ? ` F(${n.followingTargetId === 'player' ? 'P' : n.followingTargetId})` : ''}]`;
                      }
                 });
                 // Add relevant environment info if needed
                 const context = `(You are ${currentAgentTarget.name}. Player ${playerDataRef.name} is interacting with you).`;
                 userPromptContent = `${gameState} ${context} ${playerDataRef.name} says: ${userInput}`.trim();
             } else {
                 // Persona mode (or Message scope) - simpler prompt
                  userPromptContent = `${playerDataRef?.name || 'User'} says: ${userInput}`.trim();
             }
              // Add system prompt to the start of history ONLY if not already there
              if (historyToSend.length === 0 || historyToSend[0].role !== 'system') {
                  historyToSend.unshift({ role: 'system', content: systemPrompt });
              } else if (historyToSend[0].content !== systemPrompt) {
                  // Update system prompt if it changed
                  historyToSend[0].content = systemPrompt;
              }


         } else {
             // Spatial Scopes (General, Area, City, World) - Use Proxy/BigModel
             // The prompt needs to instruct the AI to act as *one* of the participants.
             // This part requires careful design. Let's make a generic "ambient chat" prompt for now.
             const participants = _getParticipantsForScope();
             const participantNames = participants.map(p => p.name).join(', ');
             systemPrompt = `You are simulating ambient chat in a virtual world. The current scope is #${activeScope}. Participants possibly present: ${participantNames || 'None'}. Keep messages very short, reflecting potential background chatter or brief observations relevant to the scope. Do NOT act as the user ('Player').`;

             userPromptContent = `Current conversation snippet in #${activeScope}:\n${historyToSend.slice(-3).map(m => `<${m.role}> ${m.content}`).join('\n')}\n\nUSER has just said: "${userInput}".\n\nGenerate a *single*, short, ambient chat message from one of the participants (or just background noise description) that fits the context. Format: <Participant Name> message`;

             // For spatial scopes, we often don't want the AI to see the *explicit* user message in its history,
             // but rather the *result* of that message (other people potentially responding).
             // So, we might modify `historyToSend` here or how the final prompt is structured.
             // For now, let's keep it simple and send the history as is, with the special userPromptContent.
             if (historyToSend.length === 0 || historyToSend[0].role !== 'system') {
                 historyToSend.unshift({ role: 'system', content: systemPrompt });
             } else {
                 historyToSend[0].content = systemPrompt; // Update system prompt
             }
             // Add the user input as a "user" message for the API, but the system prompt guides the AI on how to respond
              historyToSend.push({ role: 'user', content: userPromptContent });
         }


         return { systemPrompt, userPromptContent, historyToSend };
    }


    // --- Public API ---
    const publicApi = {
        /**
         * Initializes the Spatial Chat Manager.
         * @param {object} config - Configuration object.
         * @param {object} config.playerDataRef - Reference to the main app's player data object.
         * @param {Array<object>} config.npcDataRef - Reference to the main app's NPC data array.
         * @param {Array<object>} config.environmentDataRef - Reference to the main app's environment data array.
         * @param {object} config.apiProviderConfigRef - Reference to the PROVIDERS config object.
         * @param {object} config.apiKeyManagementRef - Reference to the main app's apiKeyManagement object.
         * @param {function} config.getApiResponseFunctionRef - Reference to the main app's function that handles the actual API fetch and key cycling. Signature: (providerId, modelId, messages, apiKey, options) => Promise<string>
         * @param {function} config.addMessageFunctionRef - Reference to the main app's function to display a message in the UI. Signature: (text, senderName, type, speakerData) => void
         * @param {function} config.findClosestNpcFunctionRef - Reference to main app's function.
         * @param {function} config.findClosestEnvironmentZoneFunctionRef - Reference to main app's function.
         * @param {string} [config.initialScope='Agent'] - The scope to activate on initialization.
         * @param {object} [config.initialHistories={}] - Pre-loaded conversation histories { scopeKey: [...] }.
         */
        init: function(config) {
            console.log("[SCM] Initializing...");
            if (!config || !config.playerDataRef || !config.npcDataRef || !config.environmentDataRef ||
                !config.apiProviderConfigRef || !config.apiKeyManagementRef ||
                !config.getApiResponseFunctionRef || !config.addMessageFunctionRef ||
                !config.findClosestNpcFunctionRef || !config.findClosestEnvironmentZoneFunctionRef) {
                console.error("[SCM] Initialization failed: Missing required configuration references.");
                alert("Spatial Chat Manager Init Failed: Missing references. Check console.");
                return;
            }

            // Store references
            _state.playerDataRef = config.playerDataRef;
            _state.npcDataRef = config.npcDataRef;
            _state.environmentDataRef = config.environmentDataRef;
            _state.apiProviderConfigRef = config.apiProviderConfigRef;
            _state.apiKeyManagementRef = config.apiKeyManagementRef;
            _state.getApiResponseFunctionRef = config.getApiResponseFunctionRef;
            _state.addMessageFunctionRef = config.addMessageFunctionRef;
            _state.findClosestNpcFunctionRef = config.findClosestNpcFunctionRef;
            _state.findClosestEnvironmentZoneFunctionRef = config.findClosestEnvironmentZoneFunctionRef;


            // Apply specific config overrides if provided
            _config = { ..._config, ...(config.managerConfig || {}) };

             // Set initial state (must happen after references are stored)
             _state.activeScope = config.initialScope || 'Agent';
             _state.conversationHistories = config.initialHistories || {};
             _state.currentCityKey = config.playerDataRef.currentCityKey; // Initial sync
             // Determine initial area based on player position
             const initialArea = _determineCurrentArea();
             _state.currentAreaId = initialArea ? initialArea.id : null;

              // Find initial agent target for Agent/Message modes
             if (_state.activeScope === 'Agent' || _state.activeScope === 'Message') {
                _state.currentAgentTarget = _state.findClosestNpcFunctionRef ? _state.findClosestNpcFunctionRef(false) : null;
             } else {
                 _state.currentAgentTarget = null;
             }


            console.log(`[SCM] Initialized. Active Scope: ${_state.activeScope}, City: ${_state.currentCityKey}, Area: ${_state.currentAreaId}`);
            // _startBotTimer(); // Optional: Start autonomous chat if needed
        },

        /**
         * Switches the active chat scope.
         * @param {string} newScope - The scope name ('General', 'Area', 'City', 'World', 'Message', 'Agent').
         * @param {object | null} [agentTarget=null] - The specific NPC target if switching to 'Message' or 'Agent'.
         */
        switchScope: function(newScope, agentTarget = null) {
            if (newScope === _state.activeScope && newScope !== 'Message' && newScope !== 'Agent') {
                 // No change needed unless it's Message/Agent where target might change
                 return;
             }

            console.log(`[SCM] Switching scope to: ${newScope}`, agentTarget ? `(Target: ${agentTarget.name})` : '');
            _state.activeScope = newScope;
            _state.isProcessing = false; // Cancel any ongoing processing for the old scope

            // Update target agent for direct interaction scopes
            if (newScope === 'Message' || newScope === 'Agent') {
                if (!agentTarget) {
                     // Try to find closest if no specific target provided
                     _state.currentAgentTarget = _state.findClosestNpcFunctionRef ? _state.findClosestNpcFunctionRef(false) : null;
                     console.log(`[SCM] Switched to ${newScope}, closest target: ${_state.currentAgentTarget?.name}`);
                } else {
                    _state.currentAgentTarget = agentTarget;
                }
            } else {
                _state.currentAgentTarget = null; // Clear target for spatial scopes
            }

             // Ensure history exists for the new scope
             const scopeKey = _getScopeKey();
             if (scopeKey && !_state.conversationHistories[scopeKey]) {
                 _state.conversationHistories[scopeKey] = [];
                 // Optionally add a system message indicating the switch
                 // _addLocalMessage(`Entered #${newScope} chat.`, 'system', scopeKey);
             }


            // Stop/Start bot timer based on scope
            // if (_state.botTimer) clearInterval(_state.botTimer);
            // if (!['Message', 'Agent'].includes(newScope)) {
            //     _startBotTimer();
            // }

            // Notify the main application that the scope changed so it can update the UI
            // (This part depends on how the main app listens - e.g., return value, callback)
            return {
                newScope: _state.activeScope,
                history: this.getCurrentHistory(), // Provide history for the new scope
                participants: _getParticipantsForScope() // Provide relevant participants
            };
        },

        /**
         * Updates the manager's context based on the main application's state.
         * Should be called whenever player moves significantly or NPCs/Environments change.
         * @param {string} cityKey - The player's current city key.
         */
        updateContext: function(cityKey) {
             let contextChanged = false;
             if (cityKey !== _state.currentCityKey) {
                 console.log(`[SCM] City context updated to: ${cityKey}`);
                 _state.currentCityKey = cityKey;
                 // Switching city likely resets area and scope in main app logic
                 contextChanged = true;
             }

             // Re-determine current area based on potentially updated player position
             const newlyDeterminedArea = _determineCurrentArea();
             const newAreaId = newlyDeterminedArea ? newlyDeterminedArea.id : null;
             if (newAreaId !== _state.currentAreaId) {
                  console.log(`[SCM] Area context updated to: ${newAreaId}`);
                  _state.currentAreaId = newAreaId;
                  contextChanged = true;
             }

             // Update target agent if in direct mode
             if (_state.activeScope === 'Agent' || _state.activeScope === 'Message') {
                  const closestNpc = _state.findClosestNpcFunctionRef ? _state.findClosestNpcFunctionRef(false) : null;
                  // Update target only if the closest NPC *changes* to avoid unnecessary updates
                  if (closestNpc?.id !== _state.currentAgentTarget?.id) {
                       _state.currentAgentTarget = closestNpc;
                       console.log(`[SCM] Agent/Message target updated to: ${closestNpc?.name}`);
                       contextChanged = true; // History key might change if target is null/non-null
                  }
             }


             return contextChanged; // Indicate if the main app might need to refresh UI
        },

        /**
         * Updates the API configuration used by the manager.
         * @param {string} providerId
         * @param {string} modelId
         */
        updateApiConfig: function(providerId, modelId) {
            // These are stored directly in _state if needed, but primarily used during handleUserInput
            // For now, we assume the main app holds the "true" selection and passes it when calling handleUserInput
             console.log(`[SCM] API config updated - Provider: ${providerId}, Model: ${modelId}`);
        },

        /**
         * Processes user input from the main chat input field.
         * Determines the correct context, prepares data, and triggers the API call via the main app.
         * @param {string} text - The user's typed message.
         */
        handleUserInput: async function(text) {
            if (!text || _state.isProcessing) return;

            const scopeKey = _getScopeKey();
            if (!scopeKey) {
                console.warn("[SCM] Cannot handle input: Invalid scope key.");
                 _state.addMessageFunctionRef("Cannot send message: Invalid location or target.", "SYSTEM", "error", null);
                return;
            }

            _state.isProcessing = true;
            const playerName = _state.playerDataRef?.name || 'USER';

            // 1. Add user message locally and display it immediately
            _addLocalMessage(text, 'user', scopeKey);
            _state.addMessageFunctionRef(text, playerName, 'user', _state.playerDataRef); // Display in UI

            // 2. Prepare API call data based on scope
            const callData = _prepareApiCallData(text);
            if (!callData) {
                console.error("[SCM] Failed to prepare API call data.");
                 _state.addMessageFunctionRef("Error preparing message context.", "SYSTEM", "error", null);
                _state.isProcessing = false;
                return;
            }

            // 3. Determine Provider and Model based on scope
            let providerToUse = _state.apiProviderConfigRef ? Object.keys(_state.apiProviderConfigRef)[0] : null; // Fallback
            let modelToUse = null;
            let apiKeyToUse = null; // Let main app's function determine the key based on provider

            if (['General', 'Area', 'City', 'World'].includes(_state.activeScope)) {
                // Force proxy provider for spatial/ambient chat
                providerToUse = _config.proxyProviderId;
                modelToUse = _state.apiProviderConfigRef[providerToUse]?.defaultModel || _state.apiProviderConfigRef[providerToUse]?.availableModels[0];
                apiKeyToUse = null; // Proxy handles keys
                console.log(`[SCM] Using Proxy Provider (${providerToUse}) for ${_state.activeScope} scope.`);
            } else {
                // Use user-selected provider/model for Message/Agent
                 const mainAppProvider = localStorage.getItem(LS_KEYS.selectedProvider); // Get current selection from main app's storage
                 const mainAppModel = localStorage.getItem(LS_KEYS.selectedModel);

                 if (mainAppProvider && _state.apiProviderConfigRef[mainAppProvider]) {
                     providerToUse = mainAppProvider;
                     const providerConf = _state.apiProviderConfigRef[providerToUse];
                     if (mainAppModel && providerConf.availableModels?.includes(mainAppModel)) {
                         modelToUse = mainAppModel;
                     } else {
                         modelToUse = providerConf.defaultModel || providerConf.availableModels[0];
                     }
                 } else {
                     // Fallback if main app provider not found
                     console.warn("[SCM] Main app's selected provider not found, using fallback.");
                      providerToUse = Object.keys(_state.apiProviderConfigRef)[0];
                      const fallbackConf = _state.apiProviderConfigRef[providerToUse];
                      modelToUse = fallbackConf?.defaultModel || fallbackConf?.availableModels[0];
                 }
                 // apiKeyToUse will be determined by getApiResponseFunctionRef using cycling logic
                 apiKeyToUse = undefined; // Signal main function to use its logic
                console.log(`[SCM] Using User Provider (${providerToUse} / ${modelToUse}) for ${_state.activeScope} scope.`);
            }

            if (!providerToUse || !modelToUse) {
                 console.error("[SCM] Could not determine a valid provider/model for API call.");
                 _state.addMessageFunctionRef("Configuration error: Could not find a valid API model.", "SYSTEM", "error", null);
                 _state.isProcessing = false;
                 return;
            }

            // 4. Call the main app's API function (which handles key cycling, fetch, and adding the response message)
            try {
                // The main function `getApiResponseFromProvider` needs to:
                // - Accept providerId, modelId, messages list.
                // - Internally handle key cycling *if* apiKeyToUse is undefined/null and provider needs keys.
                // - Make the actual fetch call using api_providers.js's getApiResponse.
                // - Call _state.addMessageFunctionRef on success/error.
                // - Return the raw response text or throw an error.

                // We pass the history *prepared* by _prepareApiCallData
                await _state.getApiResponseFunctionRef(providerToUse, modelToUse, callData.historyToSend);

                // Since getApiResponseFunctionRef now handles adding the message, we don't do it here.
                // If the spatial proxy returns structured data like "<NPC Name> Message",
                // the main `addMessageFunctionRef` might need logic to parse it.

                // Add response locally IF the main app doesn't handle it (depends on main app implementation)
                // This assumes getApiResponseFunctionRef *also* calls addMessageFunctionRef
                // If not, we'd need to capture the response here:
                // const responseText = await _state.getApiResponseFunctionRef(...);
                // let senderName = 'Spirit'; // Default
                // Parse responseText if needed for spatial scopes
                // _addLocalMessage(responseText, 'assistant', scopeKey);

            } catch (error) {
                // Error display should be handled by getApiResponseFunctionRef
                console.error(`[SCM] Error received from API call trigger: ${error.message}`);
            } finally {
                _state.isProcessing = false;
                // Re-enable input in main app (should be handled by getApiResponseFunctionRef ideally)
            }
        },

        /**
         * Gets the conversation history for the currently active scope.
         * @returns {Array<object>}
         */
        getCurrentHistory: function() {
            const scopeKey = _getScopeKey();
            return scopeKey ? (_state.conversationHistories[scopeKey] || []) : [];
        },

        /**
         * Gets the name of the currently active scope.
         * @returns {string}
         */
        getCurrentScope: function() {
            return _state.activeScope;
        },

        /**
         * Gets the list of participants relevant to the current scope.
         * @returns {Array<object>}
         */
        getActiveParticipants: function() {
            return _getParticipantsForScope();
        },

        /**
        * Gets the current target agent for direct interaction scopes.
        * @returns {object | null}
        */
        getCurrentAgentTarget: function() {
           return _state.currentAgentTarget;
       },


        /**
         * Gets the current determined Area ID based on player position.
         * @returns {string | null}
         */
        getCurrentAreaId: function() {
            return _state.currentAreaId;
        },

         // --- Optional: Bot Control ---
        // startBot: function() { _startBotTimer(); },
        // stopBot: function() { if (_state.botTimer) clearInterval(_state.botTimer); },
    };

    return publicApi; // Expose only the public methods

})();

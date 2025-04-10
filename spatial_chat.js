// spatial_chat.js

const ChatSystem = (function() {
    'use strict';

    // --- Constants for Scopes ---
    const SCOPES = {
        GENERAL: 'General', // Nearby players/NPCs based on range
        AREA: 'Area',       // Everyone within the current Environment Zone
        CITY: 'City',       // Everyone within the current City
        WORLD: 'World',     // Everyone across all cities (potentially filtered later)
        MESSAGE: 'Message', // Direct message/Persona mode with closest/selected NPC
        AGENT: 'Agent',     // Action/Command mode with closest/selected NPC
    };

    const PUBLIC_SCOPES = [SCOPES.GENERAL, SCOPES.AREA, SCOPES.CITY, SCOPES.WORLD];
    const PROXY_SCOPES = [SCOPES.GENERAL, SCOPES.AREA, SCOPES.CITY, SCOPES.WORLD]; // Scopes using the proxy
    const DIRECT_SCOPES = [SCOPES.MESSAGE, SCOPES.AGENT]; // Scopes using selected provider/cycling

    const PROXY_PROVIDER_ID = 'BIGMODEL_PROXY'; // Matches api_providers.js
    const PROXY_MODEL = 'glm-4-flash';          // Matches api_providers.js

    // --- Internal State ---
    let _currentScope = SCOPES.GENERAL; // Default scope
    let _messagesByScope = {}; // { "scopeKey": [{role: 'user'|'assistant'|'system', content: ''}, ...], ... }
    let _isProcessing = false;
    let _botTimer = null;
    let _currentRequestId = 0; // To cancel stale AI requests
    let _pendingRequests = new Set();

    // --- Configuration & Callbacks (Set during init) ---
    let _config = {
        generalChatRange: 300, // Example range for 'General' chat
        botInterval: 25000,    // How often bots might talk (ms)
        maxHistoryPerScope: 50,// Max messages stored per scope history
        maxTurnsForContext: 5, // Max conversation turns (user+ai) sent to AI
    };
    let _getExternalState = () => ({ // Default getter, expects to be replaced
        player: null, npcs: [], environments: [], selectedProvider: null, selectedModel: null, apiKeyManagement: { providerKeys: {}, activeKeyIndices: {} }, currentAiNpcData: null
    });
    let _addMessageToUICallback = (scope, role, name, text, pfp) => { console.warn("ChatSystem: _addMessageToUICallback not set!"); };
    let _clearUIChatCallback = () => { console.warn("ChatSystem: _clearUIChatCallback not set!"); };
    let _showTypingCallback = () => {};
    let _hideTypingCallback = () => {};
    let _saveApiKeyManagementCallback = () => {}; // Callback to trigger saving API key state in main script

    // --- Private Utility Functions ---

    function _loadState() {
        console.log("[ChatSystem] Loading state...");
        try {
            const storedMessages = localStorage.getItem('chatSystem_messagesByScope');
            if (storedMessages) {
                _messagesByScope = JSON.parse(storedMessages);
                // Basic validation
                if (typeof _messagesByScope !== 'object' || _messagesByScope === null) {
                    _messagesByScope = {};
                }
                 // Clean up old/excessive history
                 Object.keys(_messagesByScope).forEach(key => {
                    if (!Array.isArray(_messagesByScope[key])) {
                         _messagesByScope[key] = [];
                    } else if (_messagesByScope[key].length > _config.maxHistoryPerScope) {
                         _messagesByScope[key] = _messagesByScope[key].slice(-_config.maxHistoryPerScope);
                    }
                 });

            } else {
                _messagesByScope = {};
            }
            const storedScope = localStorage.getItem('chatSystem_currentScope');
             // Validate scope on load
             if (storedScope && Object.values(SCOPES).includes(storedScope)) {
                 _currentScope = storedScope;
             } else {
                 _currentScope = SCOPES.GENERAL; // Default if invalid or not found
                 localStorage.setItem('chatSystem_currentScope', _currentScope);
             }

        } catch (e) {
            console.error("[ChatSystem] Error loading state:", e);
            _messagesByScope = {};
            _currentScope = SCOPES.GENERAL;
            // Clear potentially corrupted storage
            localStorage.removeItem('chatSystem_messagesByScope');
            localStorage.removeItem('chatSystem_currentScope');
        }
         console.log(`[ChatSystem] Loaded. Current scope: ${_currentScope}`);
    }

    function _saveState() {
        try {
            // Prune histories before saving
            Object.keys(_messagesByScope).forEach(key => {
                if (_messagesByScope[key].length > _config.maxHistoryPerScope) {
                    _messagesByScope[key] = _messagesByScope[key].slice(-_config.maxHistoryPerScope);
                }
            });
            localStorage.setItem('chatSystem_messagesByScope', JSON.stringify(_messagesByScope));
            localStorage.setItem('chatSystem_currentScope', _currentScope);
        } catch (e) {
            console.error("[ChatSystem] Error saving state:", e);
        }
    }

    // Gets a unique key for storing/retrieving messages for the current scope
    function _getMessageScopeKey(scope = _currentScope, externalState = null) {
         const state = externalState || _getExternalState();
         const { player } = state;
         if (!player || !player.currentCity) {
             // Allow World scope even without city/area? Maybe.
             if (scope === SCOPES.WORLD) return 'world-global';
             // Allow Message/Agent if target is set externally? Risky.
             // For now, require location for most scopes.
             console.warn(`[ChatSystem] Cannot get message key for scope "${scope}" without player location.`);
             return null;
         }
         const { currentCity, currentArea } = player;

         switch (scope) {
             case SCOPES.GENERAL: return currentArea ? `${currentCity}-${currentArea}-general` : null;
             case SCOPES.AREA:    return currentArea ? `${currentCity}-${currentArea}-area` : null;
             case SCOPES.CITY:    return `${currentCity}-city`;
             case SCOPES.WORLD:   return 'world-global';
             case SCOPES.MESSAGE:
             case SCOPES.AGENT:
                 // Persona/Agent messages could be stored per-NPC? Or just use one temporary context?
                 // Let's keep it simple: use a single key for these modes, context resets often.
                 // Alternatively, key could be `message-${state.currentAiNpcData?.id}`
                 return scope.toLowerCase(); // Just 'message' or 'agent'
             default:
                 console.warn(`[ChatSystem] Unknown scope "${scope}" for message key.`);
                 return null;
         }
    }

    // Retrieves the relevant message history for context
    function _getContextHistory(scopeKey) {
        const history = _messagesByScope[scopeKey] || [];
        const limit = _config.maxTurnsForContext * 2; // *2 for user + assistant turns
        return history.slice(-limit);
    }

    // Adds a message to the internal state and triggers UI update
    function _addMessageInternal(scopeKey, role, name, text, pfp = null) {
        if (!scopeKey) return;
        if (!_messagesByScope[scopeKey]) {
            _messagesByScope[scopeKey] = [];
        }
        const message = { role, content: text }; // Store standard format internally
        _messagesByScope[scopeKey].push(message);
        // Prune if exceeds max length
        if (_messagesByScope[scopeKey].length > _config.maxHistoryPerScope) {
            _messagesByScope[scopeKey].shift();
        }
        _saveState(); // Save after adding

        // If this message belongs to the currently viewed scope, display it
        if (scopeKey === _getMessageScopeKey(_currentScope)) {
            _addMessageToUICallback(role, name, text, pfp);
        }
    }

    // --- AI Interaction Logic ---

    // Helper to get relevant NPCs based on scope
    function _getRelevantNpcs(scope, externalState) {
         const { player, npcs, environments } = externalState;
         if (!player || !npcs || npcs.length === 0) return [];

         const { x: px, y: py, currentCity, currentArea } = player;
         if (!currentCity) return []; // Need city context

         switch (scope) {
             case SCOPES.GENERAL:
                 if (!currentArea) return [];
                 return npcs.filter(n =>
                     n.currentCity === currentCity && // Ensure NPC is in the same city (if we add multi-city state later)
                     n.currentArea === currentArea && // Ensure NPC is in the same area
                     _calculateDistance(px, py, n.x, n.y) <= _config.generalChatRange
                 );
             case SCOPES.AREA:
                 if (!currentArea) return [];
                 return npcs.filter(n => n.currentCity === currentCity && n.currentArea === currentArea);
             case SCOPES.CITY:
                 return npcs.filter(n => n.currentCity === currentCity);
             case SCOPES.WORLD:
                 return npcs; // All NPCs for now
             case SCOPES.MESSAGE:
             case SCOPES.AGENT:
                 // These modes typically target one specific NPC
                 return externalState.currentAiNpcData ? [externalState.currentAiNpcData] : [];
             default:
                 return [];
         }
     }
    function _calculateDistance(x1, y1, x2, y2) {
         return Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2));
     }

    // Builds the prompt for the AI
    function _buildPrompt(scope, userInput, history, externalState) {
         const { player, npcs, currentAiNpcData } = externalState;
         const relevantNpcs = _getRelevantNpcs(scope, externalState);
         const historyText = history.map(msg => `<${msg.role}> ${msg.content}`).join('\n');
         let context = `Current scope: #${scope}. Player: ${player?.name} (${player?.x}, ${player?.y}). `;

         if (PUBLIC_SCOPES.includes(scope)) {
             context += `Visible NPCs: ${relevantNpcs.length > 0 ? relevantNpcs.map(n => `${n.name}(${n.x}, ${n.y})`).join(', ') : 'None'}. `;
             const persona = "You are an AI observing or participating in this chat scope. Respond naturally based on the context and who might be speaking.";
             // For bot responses, a specific NPC persona will be added later
             return `${persona} ${context}\nConversation History:\n${historyText}\n<user> ${userInput}\n<assistant>`;
         }
         else if (scope === SCOPES.MESSAGE || scope === SCOPES.AGENT) {
             if (!currentAiNpcData) return null; // Cannot build prompt without target
             const npc = currentAiNpcData;
             const persona = npc.personaPrompt || `You are ${npc.name}.`;
             let modeInstructions = '';
             if (scope === SCOPES.AGENT) {
                 // Add action rules from main script if needed (passed via externalState?)
                 // For now, keep it simple
                 modeInstructions = ` Respond to the user's command or query, considering your capabilities and environment. Available actions: <Walk X,Y>, <Follow>. Your Pos=(${npc.x}, ${npc.y}). Player Pos=(${player?.x}, ${player?.y}).`;
             } else { // Message mode
                 modeInstructions = ` Respond naturally to the user as ${npc.name}, staying in character.`;
             }
             return `${persona}${modeInstructions}\nConversation History:\n${historyText}\n<user> ${userInput}\n<assistant>`;
         }
         return null; // Invalid scope
    }

    // Determines API config (provider, model, key) based on scope
    function _determineApiConfig(scope, externalState) {
         if (PROXY_SCOPES.includes(scope)) {
             return {
                 provider: PROXY_PROVIDER_ID,
                 model: PROXY_MODEL,
                 apiKey: null, // Proxy handles auth
                 needsCycling: false
             };
         } else if (DIRECT_SCOPES.includes(scope)) {
             // Use the main script's selected provider/model/keys
             return {
                 provider: externalState.selectedProvider,
                 model: externalState.selectedModel,
                 apiKeyManagement: externalState.apiKeyManagement, // Pass the whole object for cycling
                 needsCycling: true
             };
         } else {
             return null; // Invalid scope
         }
     }

    // Handles the actual API call, including cycling for direct scopes
    async function _callApi(scope, prompt, historyForApi, requestId, attempt = 1) {
         if (!_pendingRequests.has(requestId)) {
             console.log(`[ChatSystem] Request ${requestId} cancelled before API call.`);
             return null; // Request was cancelled
         }

         const externalState = _getExternalState();
         const apiConfig = _determineApiConfig(scope, externalState);

         if (!apiConfig || !apiConfig.provider || !apiConfig.model) {
             throw new Error(`Invalid API configuration for scope ${scope}. Provider/Model missing.`);
         }
         if (typeof window.getApiResponse !== 'function') {
             throw new Error("External function window.getApiResponse not found.");
         }

         let apiKeyToUse = null;
         let totalKeys = 0;
         let currentKeyIndex = -1; // For logging/tracking

         if (apiConfig.needsCycling) {
             const mgmt = apiConfig.apiKeyManagement;
             const keys = mgmt.providerKeys[apiConfig.provider] || [];
             totalKeys = keys.length;

             if (totalKeys === 0) {
                 throw new Error(`No API keys available for provider ${apiConfig.provider}.`);
             }
             if (attempt > totalKeys) {
                 throw new Error(`All ${totalKeys} keys failed for provider ${apiConfig.provider}.`);
             }

             const startIndex = mgmt.activeKeyIndices[apiConfig.provider] ?? 0;
             currentKeyIndex = (startIndex + attempt - 1) % totalKeys;
             apiKeyToUse = keys[currentKeyIndex];
             console.log(`[ChatSystem] API Call Attempt ${attempt}/${totalKeys} for ${apiConfig.provider}. Using key index: ${currentKeyIndex}`);
         } else {
             // Proxy scope
             apiKeyToUse = null; // Explicitly null
             console.log(`[ChatSystem] API Call for ${apiConfig.provider} (Proxy).`);
         }

         // --- Call the external fetch function ---
         try {
             const response = await window.getApiResponse(
                 apiConfig.provider,
                 apiConfig.model,
                 historyForApi, // Pass the prepared history
                 apiKeyToUse,
                 {} // Options if needed
             );

             // SUCCESS!
             if (!_pendingRequests.has(requestId)) {
                 console.log(`[ChatSystem] Request ${requestId} cancelled after successful API call.`);
                 return null;
             }

             // If cycling was used and successful, update the next index in the *external* state
             if (apiConfig.needsCycling && totalKeys > 0) {
                 externalState.apiKeyManagement.activeKeyIndices[apiConfig.provider] = (currentKeyIndex + 1) % totalKeys;
                 _saveApiKeyManagementCallback(); // Tell main script to save the updated indices
                 // Consider updating the UI display for "next key" via another callback if needed
             }

             return response; // Return the successful response content

         } catch (error) {
             console.error(`[ChatSystem] API Error (Attempt ${attempt}) for ${scope}:`, error);

              // Check if we should cycle keys
             const shouldCycle = apiConfig.needsCycling && totalKeys > 0 && (
                 error.message.includes("401") || error.message.includes("403") ||
                 error.message.includes("429") || error.message.includes("Invalid API Key") ||
                 error.message.includes("authentication failed") || error.message.includes("permission denied")
             );

             if (shouldCycle && attempt < totalKeys) {
                 console.log(`[ChatSystem] Key error, trying next key (Attempt ${attempt + 1}).`);
                 // Pause slightly before retrying
                 await new Promise(resolve => setTimeout(resolve, 500));
                 // Recursive call for the next attempt
                 return _callApi(scope, prompt, historyForApi, requestId, attempt + 1);
             } else {
                 // Don't retry (final attempt failed, non-key error, or no cycling needed)
                 throw error; // Re-throw the error to be caught by the calling function
             }
         }
     }


    // --- Bot Logic ---
    function _startBotTimer() {
        clearInterval(_botTimer);
        if (PUBLIC_SCOPES.includes(_currentScope)) {
             // Only start if player is in a valid city/area? Check external state?
             const { player } = _getExternalState();
             if (player?.currentCity && player?.currentArea) {
                  console.log(`[ChatSystem] Starting bot timer for scope ${_currentScope}. Interval: ${_config.botInterval}ms`);
                 _botTimer = setInterval(_triggerBotAction, _config.botInterval);
             } else {
                 console.log(`[ChatSystem] Bot timer not started (player location unknown).`);
             }
        } else {
            console.log(`[ChatSystem] Bot timer not started (scope ${_currentScope} is not public).`);
        }
    }

    async function _triggerBotAction() {
        if (_isProcessing || !PUBLIC_SCOPES.includes(_currentScope)) {
            // console.log("[ChatSystem] Bot skipping turn (busy or wrong scope).");
            return;
        }

        const requestId = ++_currentRequestId;
        _pendingRequests.add(requestId);
        _isProcessing = true; // Mark busy for bot action

        try {
            const externalState = _getExternalState();
            const scopeKey = _getMessageScopeKey(_currentScope, externalState);
            if (!scopeKey) { throw new Error("Cannot determine scope key for bot."); }

            const relevantNpcs = _getRelevantNpcs(_currentScope, externalState).filter(n => n && n.name && n.personaPrompt); // Filter for bots with persona
            if (relevantNpcs.length === 0) {
                 // console.log("[ChatSystem] Bot: No relevant NPCs to speak.");
                 _isProcessing = false; _pendingRequests.delete(requestId); return;
            }

            // Simple logic: Randomly pick one NPC
            const speaker = relevantNpcs[Math.floor(Math.random() * relevantNpcs.length)];
            const history = _getContextHistory(scopeKey);
            const historyText = history.map(msg => `<${msg.role}> ${msg.content}`).join('\n');

            let prompt = `You are ${speaker.name}. ${speaker.personaPrompt}. You are in the #${_currentScope} chat scope. `;
            prompt += `Player ${externalState.player.name} is at (${externalState.player.x}, ${externalState.player.y}). Your position is (${speaker.x}, ${speaker.y}). `;
            const otherNpcs = relevantNpcs.filter(n => n !== speaker);
             if (otherNpcs.length > 0) {
                 prompt += `Other nearby NPCs: ${otherNpcs.map(n => `${n.name}(${n.x}, ${n.y})`).join(', ')}. `;
             }
             prompt += `Consider the conversation history. Either continue the topic, start a new related one, react to movement, or make an observation. Keep responses concise and in character. If the chat is quiet, you might initiate a topic.\nHistory:\n${historyText}\nYour short message (<assistant>):`;

             // Use the proxy config for bot messages in public scopes
             const apiConfig = _determineApiConfig(_currentScope, externalState); // Should return proxy config
             if (!apiConfig || apiConfig.provider !== PROXY_PROVIDER_ID) {
                 throw new Error("Bot requires proxy configuration for public scopes.");
             }

             const historyForApi = [{ role: 'system', content: prompt }]; // Simple system prompt approach for bot

             console.log(`[ChatSystem] Bot action: ${speaker.name} in scope ${_currentScope}`);

             const response = await _callApi(_currentScope, prompt, historyForApi, requestId); // Call API (will use proxy)

             if (response) { // callApi returns null if cancelled
                _addMessageInternal(scopeKey, 'assistant', speaker.name, response, speaker.pfp);
             }

        } catch (error) {
            console.error("[ChatSystem] Bot action error:", error);
            // Optionally add a system message about the bot error
            // const scopeKey = _getMessageScopeKey(_currentScope);
            // if (scopeKey) _addMessageInternal(scopeKey, 'system', 'SYSTEM', `Bot error: ${error.message}`);
        } finally {
            _pendingRequests.delete(requestId);
            _isProcessing = false; // Release lock
        }
    }


    // --- Public API ---
    const publicApi = {
        init: function(config) {
            console.log("[ChatSystem] Initializing...");
            // Store callbacks and external state getter
            if (!config || typeof config.getExternalState !== 'function' || typeof config.addMessageToUI !== 'function') {
                throw new Error("ChatSystem init requires config object with 'getExternalState' and 'addMessageToUI' functions.");
            }
            _getExternalState = config.getExternalState;
            _addMessageToUICallback = config.addMessageToUI;
            _clearUIChatCallback = config.clearUIChat || _clearUIChatCallback;
            _showTypingCallback = config.showTypingIndicator || _showTypingCallback;
            _hideTypingCallback = config.hideTypingIndicator || _hideTypingCallback;
            _saveApiKeyManagementCallback = config.saveApiKeyManagement || _saveApiKeyManagementCallback;


            // Merge user config with defaults (optional settings)
             _config = {
                 ..._config, // Start with internal defaults
                 ...(config.settings || {}) // Override with user-provided settings
             };

            _loadState(); // Load messages and current scope
            _startBotTimer(); // Start bot based on loaded scope
            console.log("[ChatSystem] Initialized successfully.");
        },

        sendMessage: async function(userInput) {
            const scopeKey = _getMessageScopeKey(_currentScope);
            if (!userInput || !scopeKey || _isProcessing) {
                 console.log(`[ChatSystem] Send cancelled (input: ${!!userInput}, scopeKey: ${!!scopeKey}, processing: ${_isProcessing})`);
                 return;
            }

            _isProcessing = true;
            _showTypingCallback();
            const requestId = ++_currentRequestId;
            _pendingRequests.add(requestId);

            const externalState = _getExternalState();
            const playerPfp = externalState.player?.pfp;

            // Add user message immediately
            _addMessageInternal(scopeKey, 'user', externalState.player?.name || 'Player', userInput, playerPfp);

            try {
                const history = _getContextHistory(scopeKey);
                // Remove the user message we just added for the prompt context
                const historyForPrompt = history.slice(0, -1);
                const prompt = _buildPrompt(_currentScope, userInput, historyForPrompt, externalState);

                if (!prompt) {
                    throw new Error("Could not build prompt for the current scope.");
                }

                // Prepare history for the API call (needs system prompt handling based on provider)
                 const apiConfig = _determineApiConfig(_currentScope, externalState);
                 let historyForApi;
                 let systemPromptForApi = prompt; // Use the whole generated prompt as system for simplicity here, or refine

                 // Example refinement: Extract just the persona/rules part for system role if provider supports it
                  if (window.PROVIDERS && apiConfig?.provider && window.PROVIDERS[apiConfig.provider]?.supportsSystemPromptInMessages) {
                      const systemMatch = prompt.match(/^.*?(?=\nConversation History:)/s); // Extract everything before history
                      if (systemMatch) {
                          systemPromptForApi = systemMatch[0].trim();
                          historyForApi = [{ role: 'system', content: systemPromptForApi }, ...history]; // History includes user's latest message
                      } else {
                           historyForApi = [{ role: 'system', content: "You are a helpful assistant." }, ...history]; // Fallback system
                      }
                  } else {
                      // If provider doesn't support system message or not OpenAI format, prepend system info to first user message (or handle as per provider needs)
                      // For simplicity now, we just won't use a separate system message for non-supporting providers.
                      // The _callApi will use the history directly. The prompt info is mainly for context.
                       historyForApi = [...history]; // Pass full history including user input
                       // If needed, modify the first user message here based on 'prompt' content for providers like Gemini
                       // if (historyForApi[0]?.role === 'user') { historyForApi[0].content = systemPromptForApi + "\n" + historyForApi[0].content }
                       console.warn(`[ChatSystem] Provider ${apiConfig?.provider} might not support system prompts well. Passing full history.`);
                  }


                const response = await _callApi(_currentScope, prompt, historyForApi, requestId);

                if (response) { // callApi returns null if cancelled
                    let responderName = 'Bot'; // Default for proxy
                    let responderPfp = null;
                    if (DIRECT_SCOPES.includes(_currentScope) && externalState.currentAiNpcData) {
                        responderName = externalState.currentAiNpcData.name;
                        responderPfp = externalState.currentAiNpcData.pfp;
                    } else if (PUBLIC_SCOPES.includes(_currentScope)) {
                        // We need to determine *which* bot responded if using proxy.
                        // The current proxy logic might not return this info easily.
                        // For now, attribute to a generic "Bot" or try to infer.
                        // This part needs refinement based on how the proxy works or if we adapt bot logic.
                         responderName = "Agent"; // Generic for now
                    }
                    _addMessageInternal(scopeKey, 'assistant', responderName, response, responderPfp);
                }
            } catch (error) {
                console.error(`[ChatSystem] Error sending message in scope ${_currentScope}:`, error);
                _addMessageInternal(scopeKey, 'system', 'SYSTEM', `Error: ${error.message}`);
            } finally {
                _pendingRequests.delete(requestId);
                _isProcessing = false;
                _hideTypingCallback();
            }
        },

        switchScope: function(newScope) {
            if (!newScope || !Object.values(SCOPES).includes(newScope) || newScope === _currentScope) {
                return;
            }

            console.log(`[ChatSystem] Switching scope from ${_currentScope} to ${newScope}`);
            // Cancel any ongoing AI requests for the old scope
            _pendingRequests.clear();
            _currentRequestId++;
            if (_isProcessing) {
                _isProcessing = false;
                _hideTypingCallback();
            }

            _currentScope = newScope;
            _saveState(); // Save the new scope immediately

            // Clear and reload UI messages for the new scope
            _clearUIChatCallback();
            const scopeKey = _getMessageScopeKey(_currentScope);
            const history = scopeKey ? (_messagesByScope[scopeKey] || []) : [];
             history.forEach(msg => {
                 // Need to determine name/pfp based on role and potentially history context (difficult)
                 // For simplicity, use role or generic names for history reload
                 let name = msg.role === 'user' ? (_getExternalState().player?.name || 'Player') : 'Agent'; // Generic names for reload
                 let pfp = msg.role === 'user' ? (_getExternalState().player?.pfp) : null; // Need a default bot PFP?
                  _addMessageToUICallback(msg.role, name, msg.content, pfp);
             });
             if (history.length === 0 && scopeKey) {
                 _addMessageInternal(scopeKey, 'system', 'SYSTEM', `Entered #${newScope} chat.`);
             }


            _startBotTimer(); // Restart bot timer (will stop if scope is not public)
        },

        getCurrentScope: function() {
            return _currentScope;
        },

        clearScopeHistory: function(scope = _currentScope) {
            const scopeKey = _getMessageScopeKey(scope);
            if (scopeKey && _messagesByScope[scopeKey]) {
                console.log(`[ChatSystem] Clearing history for scope: ${scopeKey}`);
                _messagesByScope[scopeKey] = [];
                _saveState();
                if (scope === _currentScope) {
                    _clearUIChatCallback();
                     _addMessageInternal(scopeKey, 'system', 'SYSTEM', `History for #${scope} cleared.`);
                }
            }
        },

         // Allow external trigger for bot (e.g., after player moves significantly)
         triggerBotAction: function() {
             if (PUBLIC_SCOPES.includes(_currentScope)) {
                 _triggerBotAction();
             }
         },
    };

    return publicApi; // Expose only the public methods

})();

// Example Usage (if running this file directly for testing):
/*
document.addEventListener('DOMContentLoaded', () => {
    const mockExternalState = {
        player: { name: 'Tester', x: 50, y: 50, currentCity: 'GENESIS', currentArea: 'STARTING_POINT', pfp: 'path/to/player.png' },
        npcs: [
            { name: 'Guide', x: 55, y: 55, currentCity: 'GENESIS', currentArea: 'STARTING_POINT', personaPrompt: 'Helpful guide.', pfp: 'path/to/guide.png'},
            { name: 'Pixel', x: 45, y: 45, currentCity: 'GENESIS', currentArea: 'STARTING_POINT', personaPrompt: 'Tech talker.', pfp: 'path/to/pixel.png'},
        ],
        environments: [{ id: 'area1', name: 'STARTING_POINT', x: 0, y: 0, width: 100, height: 100, city: 'GENESIS' }],
        selectedProvider: 'SAMBANOVA', // Example direct provider
        selectedModel: 'Llama-3-70b-Instruct',
        apiKeyManagement: {
            providerKeys: { 'SAMBANOVA': ['dummy-key-123'] },
            activeKeyIndices: { 'SAMBANOVA': 0 }
        },
        currentAiNpcData: null // Set when interacting directly
    };

    // Mock the global getApiResponse if not present
    if (typeof window.getApiResponse === 'undefined') {
        window.getApiResponse = async (provider, model, messages, apiKey, options) => {
            console.log(`Mock API Call: ${provider}/${model}`, messages, apiKey ? 'Key Used' : 'No Key');
            await new Promise(r => setTimeout(r, 800)); // Simulate delay
            if (apiKey === 'dummy-key-fail') throw new Error("401 Invalid API Key");
            const lastUserMsg = messages[messages.length - 1]?.content || '';
            return `Mock response to "${lastUserMsg.substring(0, 30)}..." from ${provider}`;
        };
    }

     ChatSystem.init({
         getExternalState: () => mockExternalState,
         addMessageToUI: (role, name, text, pfp) => {
             console.log(`UI Add Msg [${role}] <${name}>: ${text}`);
             const chatBox = document.getElementById('chat-display-area'); // Assume a div exists for testing
             if(chatBox) chatBox.innerHTML += `<div>[${role}] <strong>${name}:</strong> ${text.replace(/</g, '<')}</div>`;
         },
         clearUIChat: () => {
             console.log("UI Clear Chat");
              const chatBox = document.getElementById('chat-display-area');
              if(chatBox) chatBox.innerHTML = '';
         },
         showTypingIndicator: () => console.log("UI Show Typing..."),
         hideTypingIndicator: () => console.log("UI Hide Typing"),
         saveApiKeyManagement: () => console.log("External Save API Keys Triggered"),
         settings: { botInterval: 5000 } // Faster bot for testing
     });

     // Simulate user input
     // setTimeout(() => ChatSystem.sendMessage("Hello nearby!"), 2000);
     // setTimeout(() => ChatSystem.switchScope('City'), 8000);
     // setTimeout(() => ChatSystem.sendMessage("Hello City!"), 10000);
});
*/

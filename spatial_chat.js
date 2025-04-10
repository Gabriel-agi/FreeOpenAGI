<!DOCTYPE html>
<!-- ... (head and style remain the same) ... -->
<body>
    <div id="ui-container">
        <!-- ... (game-world div remains the same) ... -->
        <div id="chat-area">
             <!-- Chat Tabs Container (MODIFIED) -->
             <div id="chat-tabs-container">
                 <button id="local-tab" data-mode="spatial" data-scope="Local">LOCAL</button> <!-- Changed ID, Scope, Text -->
                 <button id="area-tab" data-mode="spatial" data-scope="Area">AREA</button>
                 <button id="city-tab" data-mode="spatial" data-scope="City">CITY</button>
                 <button id="world-tab" data-mode="spatial" data-scope="World">WORLD</button>
                 <button id="message-tab" data-mode="message">MESSAGE</button>
                 <button id="agent-tab" data-mode="agent">AGENT</button>
             </div>
             <div class="chat-messages" id="chatMessages"></div>
             <div class="input-container">
                <textarea class="message-input" id="userInput" placeholder="Consult the spirit..." rows="1"></textarea>
                 <button class="send-button" id="sendButton" title="Send Message"><span>Send</span><span style="font-size: 1.2em;">→</span></button>
            </div>
        </div>
    </div>

    <!-- ... (Modals, Context Menus, PFP upload remain the same) ... -->

    <!-- Load API Providers Script -->
    <script src="api_providers.js"></script>

    <!-- Embed Modified Spatial Chat Logic -->
    <script>
        // PASTE THE MODIFIED spatial_chat.js CODE FROM ABOVE HERE
        // spatial_chat.js (Modified Version)
        const SpatialChat = (function() {
            // ... (Full modified SpatialChat code) ...
        })();
    </script>

    <!-- Load Main Simulation Logic (MODIFIED - Inline Script) -->
    <script>
        // ... (marked setup, utility functions like darkenHexColor, maskApiKey) ...

        function runSimulation() {
            // --- Element Refs ---
            // ... (unchanged refs) ...
            const chatTabsContainer = document.getElementById('chat-tabs-container');
            const allChatTabs = chatTabsContainer.querySelectorAll('button'); // Ensure this is captured

            // --- Game State & Config ---
            // ... (unchanged state variables like MAP_WIDTH, npcData, etc.) ...
            const NPC_FOLLOW_SPEED = 3.5; // Speed was already increased
            // ... (rest of state) ...
            let currentSpatialScope = 'Local'; // Default spatial scope is now Local

            // ... (BASE_ACTION_RULES, LS_KEYS etc. - unchanged) ...

            // --- CORE FUNCTIONS ---
            // ... (updateNameplate, renderConversationHistory, addMessage etc. - mostly unchanged, check addMessage notes) ...

            // Modified: addMessage might need slight adjustment for senderName in system messages
            function addMessage(text, senderName, type, speakerData = null) {
                 if (hideSystemMessages && ['debug', 'system', 'error'].includes(type)) return;

                 const isDirectMode = currentChatDisplayMode === 'message' || currentChatDisplayMode === 'agent';
                 const isSpatialMode = currentChatDisplayMode === 'spatial';

                 // Only render styled messages if NOT in spatial mode.
                 if (isSpatialMode) return; // Skip rendering for spatial mode

                 // ...(rest of addMessage logic - check avatar generation for system/debug/error using senderName)
                 const wasScrolledToBottom = chatMessages.scrollHeight - chatMessages.clientHeight <= chatMessages.scrollTop + 1;

                 const messageDiv = document.createElement('div'); messageDiv.classList.add('message');
                 let senderTypeClass = '', avatarClass = '', pfpSrc = '', isMarkdown = false, displayName = senderName || 'Unknown';

                 if (type === 'user') {
                     senderTypeClass = 'message-user'; avatarClass = 'user-avatar';
                     pfpSrc = playerData.pfp || DEFAULT_PLAYER_PFP;
                     displayName = playerData.name || 'Player';
                     isMarkdown = false;
                 } else if (type === 'assistant') {
                     senderTypeClass = 'message-spirit'; avatarClass = 'spirit-avatar';
                     const actualSpeaker = speakerData || npcData.find(n => n.name === senderName) || { pfp: DEFAULT_NPC_PFP, name: senderName };
                     pfpSrc = actualSpeaker.pfp || DEFAULT_NPC_PFP;
                     displayName = actualSpeaker.name || senderName;
                     isMarkdown = true;
                 } else { // system, debug, error
                     senderTypeClass = type === 'error' ? 'message-debug' : `message-${type}`;
                     avatarClass = type === 'error' ? 'debug-avatar' : `${type}-avatar`;
                     const systemBgColor = getComputedStyle(document.documentElement).getPropertyValue('--amethyst').trim() || '#6b21a8';
                     const defaultBgColor = getComputedStyle(document.documentElement).getPropertyValue('--ink-light').trim() || '#5a4e42';
                     const avatarBg = (type === 'system') ? systemBgColor : defaultBgColor;
                     // Use first letter of sender name for system/debug avatars, fallback to 'S'
                     const avatarLetter = (senderName || 'S').substring(0,1).toUpperCase();
                     pfpSrc = `https://ui-avatars.com/api/?name=${encodeURIComponent(avatarLetter)}&background=${avatarBg.substring(1)}&color=fff&size=64`;
                     displayName = senderName || 'System'; // Use senderName if provided, else 'System'
                     isMarkdown = false;
                 }
                 // ... (rest of element creation, markdown parsing, appending - unchanged) ...
                  messageDiv.classList.add(senderTypeClass);
                 const avatarImg = document.createElement('img');
                 avatarImg.className = `avatar ${avatarClass}`; avatarImg.src = pfpSrc; avatarImg.alt = `${displayName} avatar`; avatarImg.title = displayName;
                 if (type === 'assistant' || type === 'system' || type === 'debug' || type === 'error') { avatarImg.addEventListener('click', openSettingsModal); } else if (type === 'user') { avatarImg.addEventListener('click', showPfpContextMenu); }
                 const contentDiv = document.createElement('div'); contentDiv.className = `message-content ${senderTypeClass.replace('message-', '')}-message`;
                 if (isMarkdown) { /* ... markdown handling ... */ }
                 else { if (['system', 'debug', 'error'].includes(type)) { const nameSpan = document.createElement('span'); nameSpan.className = 'message-name'; nameSpan.textContent = `${displayName}: `; contentDiv.appendChild(nameSpan); contentDiv.appendChild(document.createTextNode(text)); } else { contentDiv.textContent = text; } }
                 if (type === 'user') { messageDiv.appendChild(contentDiv); messageDiv.appendChild(avatarImg); } else { messageDiv.appendChild(avatarImg); messageDiv.appendChild(contentDiv); }
                 chatMessages.appendChild(messageDiv);
                 if(wasScrolledToBottom) { chatMessages.scrollTop = chatMessages.scrollHeight; }

                 // --- History Storage --- (ensure SYSTEM messages from AGENT mode are added if desired)
                 if (isDirectMode && (type === 'user' || type === 'assistant' || (type === 'system' && senderName !== 'Agent Command'))) { // Store user, assistant, non-agent-command system msgs
                     conversationHistory.push({ role: type, content: text, senderName: senderName });
                     if (conversationHistory.length > (MAX_HISTORY_TURNS * 2 + 10)) { conversationHistory = conversationHistory.slice(-(MAX_HISTORY_TURNS * 2 + 10)); }
                     saveConversationHistory();
                 } else if (type === 'system' && senderName === 'Agent Command') { // Store agent commands in history too? Optionally.
                      conversationHistory.push({ role: type, content: text, senderName: senderName });
                      if (conversationHistory.length > (MAX_HISTORY_TURNS * 2 + 10)) { conversationHistory = conversationHistory.slice(-(MAX_HISTORY_TURNS * 2 + 10)); }
                      saveConversationHistory();
                 }
                 if (type === 'system') { // Track recent game events separately
                     recentEvents.push(`Event: ${text.replace('[SYSTEM] ', '')}`); if(recentEvents.length > 5) recentEvents.shift();
                 }
            }


            // ... (Context Menu Handlers - unchanged logic, but will use updated menu items) ...
            // ... (findCurrentAreaName, showSpeechBubble, updateCharacterPosition etc. - unchanged) ...

            // --- generateSystemPrompt, processNpcActions, handleWalkAction, findClosestCharacter ---
            // --- handleFollowAction, handleUnfollowAction, updateFollowingNpcs ---
            // --- displayTypingIndicator, removeTypingIndicator ---
            // --- API Key Handling ---
            // --- getApiResponseFromProvider ---
            // --- disableInput, enableInput ---
            // --- handlePlayerSend ---
            // --- Settings & Appearance Modals (open, close, save, populate, etc.) ---
            // (These functions were already modified in the previous step and remain correct)

            // --- Spatial Chat Update Function (unchanged from previous step) ---
             function updateSpatialChatModuleState() {
                 if (typeof SpatialChat === 'undefined' || !SpatialChat.updateState) { return; }
                 if (!currentCityKey) { SpatialChat.updateState({ currentCity: null, currentArea: null }, [], {}, null); return; }
                 const currentPlayerArea = findCurrentAreaName(playerData.x, playerData.y, environmentData);
                 const currentPlayerState = { x: playerData.x, y: playerData.y, currentCity: currentCityKey, currentArea: currentPlayerArea, name: playerData.name };
                 const currentNpcs = npcData.map(npc => ({ id: npc.id, name: npc.name, x: npc.x, y: npc.y, personality: npc.personaPrompt || `You are ${npc.name}.`, currentCity: currentCityKey, currentArea: findCurrentAreaName(npc.x, npc.y, environmentData) }));
                 const currentCities = {}; if (currentCityKey) { currentCities[currentCityKey] = {}; }
                 const currentDisplay = currentChatDisplayMode === 'spatial' ? currentSpatialScope : null;
                 SpatialChat.updateState(currentPlayerState, currentNpcs, currentCities, currentDisplay);
            }

            // --- Tab Switching Logic (MODIFIED for 'Local') ---
            function setActiveTab(clickedButton) {
                 allChatTabs.forEach(btn => btn.classList.remove('active-tab'));
                 clickedButton.classList.add('active-tab');

                 const newMode = clickedButton.dataset.mode;
                 const newScope = clickedButton.dataset.scope; // e.g., 'Local', 'Area', 'City', 'World'

                 const previousMode = currentChatDisplayMode;

                 currentChatDisplayMode = newMode;
                 localStorage.setItem(LS_KEYS.currentChatDisplayMode, currentChatDisplayMode);

                 chatMessages.innerHTML = ''; // Clear messages on tab switch

                 if (newMode === 'spatial') {
                     currentSpatialScope = newScope || 'Local'; // Default to Local if scope missing
                     console.log(`Switching to Spatial Mode, Scope: ${currentSpatialScope}`);
                     if (typeof SpatialChat !== 'undefined' && SpatialChat.start) {
                         SpatialChat.start();
                         updateSpatialChatModuleState(); // Update state including the new display scope
                         displaySpatialChat(currentSpatialScope); // Display initial messages
                     } else { console.warn("SpatialChat module not fully available for starting."); }
                     clearInterval(spatialChatRenderIntervalId);
                     spatialChatRenderIntervalId = setInterval(() => {
                         if (currentChatDisplayMode === 'spatial') { displaySpatialChat(currentSpatialScope); }
                     }, 3000);
                     currentAiNpcData = null; // Clear direct chat target
                     enableInput(); // Spatial input always enabled (for now)

                 } else { // Message or Agent mode
                     console.log(`Switching to ${newMode} Mode`);
                     if (typeof SpatialChat !== 'undefined' && SpatialChat.stop) SpatialChat.stop();
                     clearInterval(spatialChatRenderIntervalId);
                     spatialChatRenderIntervalId = null;

                     // Smartly set target NPC
                     if (previousMode === 'spatial' || !currentAiNpcData) { // If coming from spatial OR no target exists
                        currentAiNpcData = findClosestNpc(false) || initialSpeakerData;
                        if(newMode === 'message' && !currentAiNpcData) { // Fallback for message mode
                            currentAiNpcData = { name: "Spirit", personaPrompt: "You are a helpful, disembodied spirit.", pfp: DEFAULT_NPC_PFP };
                        }
                     } // else, keep existing currentAiNpcData when switching between message/agent

                     renderConversationHistory();
                     enableInput(); // Enable or keep disabled based on isWaitingForApiResponse
                     userInput.focus(); // Focus input for direct modes
                 }
                 updateInputPlaceholder();
            }

             // --- Display Spatial Chat Function (MODIFIED for 'Local') ---
            function displaySpatialChat(scope) {
                 if (typeof SpatialChat === 'undefined' || !SpatialChat.getMessagesForScope) {
                    chatMessages.innerHTML = '<p style="color:red; text-align:center; padding: 20px;">Error: SpatialChat module not loaded or incomplete.</p>';
                    return;
                 }
                 const playerArea = findCurrentAreaName(playerData.x, playerData.y, environmentData);
                 // Pass the correct scope ('Local', 'Area', etc.)
                 const messages = SpatialChat.getMessagesForScope(scope, currentCityKey, playerArea);
                 renderSpatialChatMessages(messages);
            }

            // --- Initialization (Ensure SpatialChat.init is called correctly) ---
            function initializeSimulation(cityKey) {
                 // ... (Setup before SpatialChat init - same as previous step) ...
                 console.log(`Initializing simulation for city: ${cityKey}`);
                 // ... clear intervals, load history/keys, select provider/model ...
                 loadApiKeyManagement();
                 loadConversationHistory();
                 // ... select provider/model ...
                 console.log(`API Initialized: Provider=${selectedProvider || 'None'}, Model=${selectedModel || 'None'}`);
                 // ... clear map, setup cityDefinition, MAP_WIDTH/HEIGHT ...
                 // ... load UI state (tabs, chat height, hide messages) ...
                 // ... setup player data (pos, appearance, name, persona) ...
                 // ... setup environmentData ...
                 // ... setup npcData ...
                 // ... update camera, set initialSpeakerData ...
                 currentAiNpcData = null; // Clear initially

                 // --- Initialize SpatialChat Module ---
                 if (typeof SpatialChat !== 'undefined' && SpatialChat.init) {
                     const initialPlayerState = { x: playerData.x, y: playerData.y, currentCity: currentCityKey, currentArea: findCurrentAreaName(playerData.x, playerData.y, environmentData), name: playerData.name };
                     const initialNpcs = npcData.map(npc => ({ id: npc.id, name: npc.name, x: npc.x, y: npc.y, personality: npc.personaPrompt || `You are ${npc.name}.`, currentCity: currentCityKey, currentArea: findCurrentAreaName(npc.x, npc.y, environmentData) }));
                     const initialCities = {}; if (currentCityKey) { initialCities[currentCityKey] = {}; }
                     // Pass the config with potentially renamed localChatRange
                     SpatialChat.init( { debugLogging: false, localChatRange: 75 /* or read from config */ },
                                         { player: initialPlayerState, npcs: initialNpcs, cities: initialCities } );
                 } else {
                     console.error("SpatialChat module is not loaded or init function is missing!");
                     addMessage("Error: Spatial Chat features are unavailable.", "SYSTEM", "error");
                 }

                 // --- Set Initial Tab ---
                 const savedMode = localStorage.getItem(LS_KEYS.currentChatDisplayMode) || 'agent';
                 // IMPORTANT: Ensure the initial tab selector matches the NEW 'local-tab' ID if 'spatial' was saved with 'Local' scope intended
                 let initialTabSelector = `#chat-tabs-container button[data-mode="${savedMode}"]`;
                 if (savedMode === 'spatial') {
                     initialTabSelector = '#local-tab'; // Default spatial view to Local
                 }
                 let initialTabButton = document.querySelector(initialTabSelector);
                 if (!initialTabButton) { // Fallback if specific tab not found
                    initialTabButton = document.getElementById('local-tab') || document.getElementById('agent-tab') || document.getElementById('message-tab') || allChatTabs[0];
                 }
                 setActiveTab(initialTabButton);

                 // ... (Welcome messages, start intervals) ...
                 const welcomeMsg = `Welcome to ${cityDefinition.meta?.cityName||'the Simulation'}.`;
                 addMessage(welcomeMsg, "Tome", 'system');
                 // ...
                 npcFollowInterval=setInterval(updateFollowingNpcs, 200);
                 spatialChatUpdateIntervalId = setInterval(updateSpatialChatModuleState, 1000);
                 console.log(`Initialization complete. Initial Tab: ${currentChatDisplayMode}.`);
            }

            function enterNoCityState() {
                // ... (Same as previous, ensures SpatialChat is initialized minimally and stopped) ...
                console.log("Entering No City state.");
                 if(npcFollowInterval) clearInterval(npcFollowInterval); if(spatialChatUpdateIntervalId) clearInterval(spatialChatUpdateIntervalId); if(spatialChatRenderIntervalId) clearInterval(spatialChatRenderIntervalId);
                 if (typeof SpatialChat !== 'undefined' && SpatialChat.stop) SpatialChat.stop();
                 currentCityKey=null; chatMessages.innerHTML=''; mapContent.innerHTML=''; mapContent.appendChild(playerElement); playerElement.style.display='none'; playerData.x=undefined; playerData.y=undefined; npcData.length=0; environmentData.length=0; mapContent.style.width='100%'; mapContent.style.height='100%'; mapContent.style.transform='translate3d(0,0,0)'; gameWorld.style.display='none';
                 loadConversationHistory();
                 // ... Load API keys/models ...
                 hideSystemMessages=localStorage.getItem(LS_KEYS.hideSystemMessages)==='true'; setChatTabsVisibility(false); // Hide tabs in no-city state
                 if (typeof SpatialChat !== 'undefined' && SpatialChat.init) { SpatialChat.init({}, { player: { name: playerData.name || 'Player', currentCity: null }, npcs: [], cities: {} }); SpatialChat.stop(); }
                 addMessage("Welcome! No cities created yet. Open Settings (click this sigil) to add your first city.", "SYSTEM", "system");
                 currentChatDisplayMode = 'message'; currentAiNpcData = { name: "Spirit", personaPrompt: "You are a helpful, disembodied spirit.", pfp: DEFAULT_NPC_PFP };
                 setActiveTab(document.getElementById('message-tab'));
                 openSettingsModal();
            }
            // ... (doChatResize, saveChatHeight, toggleFullscreenChat - unchanged) ...

            // --- Event Listeners (Ensure tab listener uses updated IDs/scopes) ---
            // ... (keydown, input, sendButton, modals, resize, etc. - unchanged) ...

            // Modified Tab Listener Setup
             allChatTabs.forEach(tab => {
                tab.addEventListener('click', () => {
                    // Pass the actual button element to setActiveTab
                    setActiveTab(tab);
                });
             });

            // ... (beforeunload, message receiver - unchanged) ...

            // --- Initial Execution ---
            // ... (unchanged logic to find or create initial city key) ...
            let cityKeyToLoad=localStorage.getItem(LS_KEYS.selectedCity); if(!cityKeyToLoad||!cityKeyToLoad.startsWith(USER_CITY_PREFIX)||!localStorage.getItem(cityKeyToLoad)){ const userCityKeys=[]; Object.keys(localStorage).forEach(key => { if (key.startsWith(USER_CITY_PREFIX)) userCityKeys.push(key); }); userCityKeys.sort(); cityKeyToLoad=userCityKeys[0]||null; if(cityKeyToLoad){ localStorage.setItem(LS_KEYS.selectedCity, cityKeyToLoad); } }
            if (cityKeyToLoad) { initializeSimulation(cityKeyToLoad); } else { enterNoCityState(); }


        } // End runSimulation

        document.addEventListener('DOMContentLoaded', runSimulation);
    </script>

</body>
</html>

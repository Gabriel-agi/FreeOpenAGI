// ------------ ai-world.js ------------
// (This file contains the main simulation logic)

// Make sure Marked library is loaded before this script runs in the HTML
marked.setOptions({ breaks: true, gfm: true, smartypants: true });

// Utility functions (keep them here as they are used by runSimulation)
function darkenHexColor(h, p) { if (!h || typeof h !== 'string') return '#000'; h = h.replace(/^#/, ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); if (h.length !== 6) return '#000'; let r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16); r = Math.max(0, Math.floor(r * (1 - p))); g = Math.max(0, Math.floor(g * (1 - p))); b = Math.max(0, Math.floor(b * (1 - p))); return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`; }
function maskApiKey(key) { if (!key || typeof key !== 'string') return "INVALID"; return key.length > 8 ? `${key.substring(0, 4)}...${key.substring(key.length - 4)}` : key; }

function runSimulation() {
    // --- Element Refs ---
    const gameWorld = document.getElementById('game-world'); const mapContent = document.getElementById('map-content');
    const chatArea = document.getElementById('chat-area'); const chatMessages = document.getElementById('chatMessages');
    const userInput = document.getElementById('userInput'); const sendButton = document.getElementById('sendButton');
    const playerElement = document.getElementById('player');
    const settingsOverlay = document.getElementById('settings-overlay'); const settingsBodyContainer = document.getElementById('settings-body-container');
    const settingsPaginationControls = document.getElementById('settings-pagination-controls'); const settingsPrevBtn = document.getElementById('settings-prev-btn');
    const settingsNextBtn = document.getElementById('settings-next-btn'); const settingsPageIndicator = document.getElementById('settings-page-indicator');
    const modalCloseBtn = document.getElementById('modal-close-btn'); const modalCancelBtn = document.getElementById('modal-cancel-btn');
    const modalSaveBtn = document.getElementById('modal-save-btn');
    const npcContextMenu = document.getElementById('npc-context-menu');
    const playerContextMenu = document.getElementById('player-context-menu');
    const pfpContextMenu = document.getElementById('pfp-context-menu');
    const appearanceEditorOverlay = document.getElementById('appearance-editor-overlay');
    const appearanceEditorTitle = document.getElementById('appearance-editor-title'); const appearanceEditorCloseBtn = document.getElementById('appearance-editor-close-btn');
    const appearanceEditorCancelBtn = document.getElementById('appearance-editor-cancel-btn'); const appearanceEditorSaveBtn = document.getElementById('appearance-editor-save-btn');
    const characterCreatorFrame = document.getElementById('characterCreatorFrame'); const appearanceEditorNameInput = document.getElementById('appearance-editor-name');
    const appearanceEditorPersonaInput = document.getElementById('appearance-editor-persona'); const pfpUploadInput = document.getElementById('pfp-upload');
    const appearancePfpPreview = document.getElementById('appearance-pfp-preview'); const appearancePfpChangeBtn = document.getElementById('appearance-pfp-change-btn');
    const chatTabsContainer = document.getElementById('chat-tabs-container');
    const allChatTabs = chatTabsContainer.querySelectorAll('button');

    // --- Game State & Config ---
    let MAP_WIDTH = 3000; let MAP_HEIGHT = 2000; let viewportWidth, viewportHeight;
    const npcData = []; const environmentData = []; const playerData = { appearance: null, isPlayer: true, pfp: null, name: 'Player' };
    const playerStepDistance = 16; const globalSpeechDuration = 4500;
    let currentChatDisplayMode = 'agent'; // Default mode
    let currentSpatialScope = 'Area'; // Default spatial scope (Adjust if needed based on your tabs)
    let currentAiNpcData = null; // Stores the NPC data object for current Chat/Agent interaction
    let initialSpeakerData = null; // NPC closest at load time
    let currentCityKey = null;
    let isPlayerMoving = false; let playerMoveTimeout = null; let contextMenuTargetNpcId = null;
    let contextMenuTargetIsPlayer = false; let appearanceEditorTarget = null; let temporaryAppearanceData = null;
    let temporaryPfpData = null; let isWaitingForApiResponse = false; let hideSystemMessages = false;
    let npcFollowInterval = null;
    const FOLLOW_DISTANCE = 50;
    const NPC_FOLLOW_SPEED = 3.5; // Speed was already increased
    let currentSettingsPage = 1; const TOTAL_SETTINGS_PAGES = 4;
    let chatHeightBeforeFullscreen = null;
    let chatTabsVisible = true;
    let spatialChatUpdateIntervalId = null;
    let spatialChatRenderIntervalId = null; // Interval for rendering spatial chat

    // --- API Provider State ---
    let selectedProvider = null;
    let selectedModel = null;
    let apiKeyManagement = { providerKeys: {}, activeKeyIndices: {} };

    const defaultNpcAppearance = { outfit: 'citizen', gender: 'female', colors: { hair: '#e4b881', primary: '#a34444', secondary: '#fbe5d6', detail1: '#7a2a2a', legs: '#693434', feet: '#2a2a30' } };
    const defaultPlayerAppearance = { outfit: 'citizen', gender: 'male', colors: { hair: '#4a3021', primary: '#5d7a8a', secondary: '#d1c6b0', detail1: '#8b4513', legs: '#444450', feet: '#2a2a30' } };
    const DEFAULT_PLAYER_PFP = 'https://ui-avatars.com/api/?name=Player&background=1e3a8a&color=fff&size=64';
    const DEFAULT_NPC_PFP = 'https://ui-avatars.com/api/?name=Agent&background=6b21a8&color=fff&size=64';

    let conversationHistory = []; // Only for Chat/Agent modes
    const MAX_HISTORY_TURNS = 6; let recentEvents = [];
    // MODIFIED BASE_ACTION_RULES - Expecting *only* actions in agent mode now
    const BASE_ACTION_RULES = `ACTIONS: <Walk X,Y>, <Follow>, <Unfollow>. Respond with ONLY the chosen action tag, nothing else. Pos=(X,Y).`;
    const USER_CITY_PREFIX = "userCity_";
    const LS_KEYS = {
        selectedCity: 'selectedCityKey',
        providerApiKeysStorage: 'providerApiKeys_v2',
        chatAreaHeight: 'chatAreaHeight', hideSystemMessages: 'hideSystemMessages',
        playerAppearance: 'global-player-appearance', playerName: 'global-player-name',
        playerPersona: 'global-player-persona', playerPfp: 'global-player-pfp',
        playerPositionX: (cityKey) => `player-${cityKey}-x`, playerPositionY: (cityKey) => `player-${cityKey}-y`,
        npcName: (cityKey, npcId) => `npc-${cityKey}-${npcId}-name`, npcPersona: (cityKey, npcId) => `npc-${cityKey}-${npcId}-persona`,
        npcAppearance: (cityKey, npcId) => `npc-${cityKey}-${npcId}-appearance`, npcPfp: (cityKey, npcId) => `npc-${cityKey}-${npcId}-pfp`,
        npcPositionX: (cityKey, npcId) => `npc-${cityKey}-${npcId}-x`, npcPositionY: (cityKey, npcId) => `npc-${cityKey}-${npcId}-y`,
        envName: (cityKey, envId) => `env-${cityKey}-${envId}-name`,
        chatTabsVisible: 'chatTabsVisible',
        selectedProvider: 'selectedApiKeyProvider',
        selectedModel: 'selectedApiModel',
        currentChatDisplayMode: 'currentChatDisplayMode_v2', // Incremented version due to rename
        conversationHistory: 'directConversationHistory'
    };

    // --- CORE FUNCTIONS ---
    function updateNameplate(c){if(c&&c.nameplateElement)c.nameplateElement.textContent=c.name;}

     function renderConversationHistory() {
         chatMessages.innerHTML = '';
         // Filter history to only show user/assistant messages relevant to chat/agent mode
         conversationHistory.forEach(msg => {
             if (!msg || !msg.role || msg.content === undefined) return; // Basic validation
             // Only render roles relevant to direct chat
             if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'system' && msg.role !== 'debug' && msg.role !== 'error') return;

             let speakerData = null;
             let senderName = msg.senderName || 'Unknown'; // Use stored senderName
             if (msg.role === 'user') {
                 speakerData = playerData; senderName = playerData.name;
                 addMessage(msg.content, senderName, msg.role, speakerData);
             } else if (msg.role === 'assistant') {
                  // Try to find NPC data by the stored name for PFP etc.
                  speakerData = npcData.find(n => n.name === senderName) || { pfp: DEFAULT_NPC_PFP, name: senderName };
                  addMessage(msg.content, senderName, msg.role, speakerData);
             } else if (msg.role === 'system' || msg.role === 'debug' || msg.role === 'error') {
                 // Directly add system/debug/error messages stored in history
                 addMessage(msg.content, senderName, msg.role);
             }
         });
         chatMessages.scrollTop = chatMessages.scrollHeight;
     }

    function renderSpatialChatMessages(messages) {
         const wasScrolledToBottom = chatMessages.scrollHeight - chatMessages.clientHeight <= chatMessages.scrollTop + 1;
         chatMessages.innerHTML = '';
         if (!messages || messages.length === 0) {
             const p = document.createElement('p');
             // Update placeholder text if scope is missing (shouldn't happen often now)
             p.textContent = currentSpatialScope ? `The #${currentSpatialScope} scope is quiet...` : "Select a spatial scope...";
             p.style.fontStyle = 'italic'; p.style.color = 'var(--ink-light)'; p.style.textAlign = 'center';
             chatMessages.appendChild(p);
         } else {
             messages.forEach(msgString => {
                 const msgEl = document.createElement('div'); msgEl.className = 'spatial-message';
                 msgEl.textContent = msgString; chatMessages.appendChild(msgEl);
             });
         }
         if (wasScrolledToBottom) {
             chatMessages.scrollTop = chatMessages.scrollHeight;
         }
    }

    function addMessage(text, senderName, type, speakerData = null) {
         if (hideSystemMessages && ['debug', 'system', 'error'].includes(type)) return;

         const isDirectMode = currentChatDisplayMode === 'message' || currentChatDisplayMode === 'agent';
         const isSpatialMode = currentChatDisplayMode === 'spatial';

         // Only render styled messages (user/assistant/system/debug/error) if NOT in spatial mode.
         // Spatial messages are handled by renderSpatialChatMessages.
         if (isSpatialMode) return;

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
              // Use provided speakerData or fallback based on senderName
             const actualSpeaker = speakerData || npcData.find(n => n.name === senderName) || { pfp: DEFAULT_NPC_PFP, name: senderName };
             pfpSrc = actualSpeaker.pfp || DEFAULT_NPC_PFP;
             displayName = actualSpeaker.name || senderName;
             isMarkdown = true;
         } else { // system, debug, error
             senderTypeClass = type === 'error' ? 'message-debug' : `message-${type}`; // Group error with debug styling
             avatarClass = type === 'error' ? 'debug-avatar' : `${type}-avatar`;
             const systemBgColor = getComputedStyle(document.documentElement).getPropertyValue('--amethyst').trim() || '#6b21a8';
             const defaultBgColor = getComputedStyle(document.documentElement).getPropertyValue('--ink-light').trim() || '#5a4e42';
             const avatarBg = (type === 'system') ? systemBgColor : defaultBgColor;
             // Use first letter of sender name for system/debug avatars
             const avatarLetter = (senderName || 'S').substring(0,1).toUpperCase();
             pfpSrc = `https://ui-avatars.com/api/?name=${encodeURIComponent(avatarLetter)}&background=${avatarBg.substring(1)}&color=fff&size=64`;
             displayName = senderName || 'System'; // Default to 'System' if no name provided
             isMarkdown = false;
         }

         messageDiv.classList.add(senderTypeClass);
         const avatarImg = document.createElement('img');
         avatarImg.className = `avatar ${avatarClass}`; avatarImg.src = pfpSrc; avatarImg.alt = `${displayName} avatar`; avatarImg.title = displayName;

         if (type === 'assistant' || type === 'system' || type === 'debug' || type === 'error') {
             // Click system/spirit avatar to open settings
             avatarImg.addEventListener('click', openSettingsModal);
         } else if (type === 'user') {
             avatarImg.addEventListener('click', showPfpContextMenu);
         }

         const contentDiv = document.createElement('div');
         contentDiv.className = `message-content ${senderTypeClass.replace('message-', '')}-message`;

         if (isMarkdown) {
             try {
                 contentDiv.innerHTML = marked.parse(text);
                 // Add copy buttons to code blocks (run slightly deferred)
                 setTimeout(() => { const pre = contentDiv.querySelectorAll('pre'); pre.forEach(p => { const cC = p.querySelector('code')?.textContent || p.textContent; if (!cC || cC.trim() === '') return; const b = document.createElement('button'); b.className = 'copy-code-btn'; b.textContent = 'Copy'; b.title = 'Copy'; b.addEventListener('click', (e) => { e.stopPropagation(); const c = p.querySelector('code') || p; navigator.clipboard.writeText(c.textContent).then(() => { b.textContent = 'Copied!'; b.classList.add('copied'); setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('copied'); }, 2000); }).catch(err => console.error("Copy failed: ", err)); }); p.style.position = 'relative'; p.appendChild(b); }); }, 0);
             } catch (e) { console.error("Markdown err:", e); contentDiv.textContent = text; }
         } else {
             // Display sender name for system/debug/error
             if (['system', 'debug', 'error'].includes(type)) {
                 const nameSpan = document.createElement('span');
                 nameSpan.className = 'message-name';
                 nameSpan.textContent = `${displayName}: `;
                 contentDiv.appendChild(nameSpan);
                 // Append the actual message text
                 contentDiv.appendChild(document.createTextNode(text));
             } else {
                 // For user messages, just the text
                 contentDiv.textContent = text;
             }
         }
         if (type === 'user') { messageDiv.appendChild(contentDiv); messageDiv.appendChild(avatarImg); } else { messageDiv.appendChild(avatarImg); messageDiv.appendChild(contentDiv); }

         chatMessages.appendChild(messageDiv);
         if(wasScrolledToBottom) {
             chatMessages.scrollTop = chatMessages.scrollHeight;
         }


         // --- History Storage ---
         // Only store user, assistant, and SYSTEM messages relevant to direct chat in history
         if (isDirectMode && (type === 'user' || type === 'assistant' || type === 'system')) {
             conversationHistory.push({ role: type, content: text, senderName: senderName }); // Store sender name too
             if (conversationHistory.length > (MAX_HISTORY_TURNS * 2 + 10)) { // Allow slightly more history
                 conversationHistory = conversationHistory.slice(-(MAX_HISTORY_TURNS * 2 + 10));
             }
             saveConversationHistory();
         } else if (type === 'system' && !text.includes("Settings saved")) {
             // Track recent game events (like follow/unfollow) separately
             recentEvents.push(`Event: ${text.replace('[SYSTEM] ', '')}`);
             if(recentEvents.length > 5) recentEvents.shift();
         }
    }

    function saveConversationHistory() { try { localStorage.setItem(LS_KEYS.conversationHistory, JSON.stringify(conversationHistory)); } catch (e) { console.error("Error saving conversation history:", e); } }
    function loadConversationHistory() { const saved = localStorage.getItem(LS_KEYS.conversationHistory); if (saved) { try { const parsed = JSON.parse(saved); if (Array.isArray(parsed)) { conversationHistory = parsed; console.log(`Loaded ${conversationHistory.length} direct messages.`); } } catch (e) { console.error("Error parsing saved conversation history:", e); conversationHistory = []; localStorage.removeItem(LS_KEYS.conversationHistory); } } else { conversationHistory = []; } }

    function setChatTabsVisibility(isVisible) { chatTabsVisible = isVisible; chatTabsContainer.classList.toggle('hidden', !isVisible); try { localStorage.setItem(LS_KEYS.chatTabsVisible, isVisible ? 'true' : 'false'); } catch (e) { console.error("Failed to save chat tab visibility state:", e); } }
    function toggleChatTabsVisibility() { setChatTabsVisibility(!chatTabsVisible); }

    // (Context Menu Functions - Modified for Renamed Tab)
    function handleGenericContextMenu(event, menuElement) {
        event.preventDefault(); closeAllContextMenus();
        const t = event.currentTarget;
        contextMenuTargetNpcId = null; contextMenuTargetIsPlayer = false;

        if (menuElement.id === 'player-context-menu') {
            if (!currentCityKey || playerData.element.style.display === 'none') return;
            contextMenuTargetIsPlayer = true;
        } else if (menuElement.id === 'npc-context-menu') {
            if (!currentCityKey) return;
            contextMenuTargetNpcId = parseInt(t.dataset.npcId, 10);
            if (isNaN(contextMenuTargetNpcId)) { console.error("No NPC ID:", t); return; }
            const n = npcData.find(npc => npc.id === contextMenuTargetNpcId);
            if (!n) return;

            // Dynamically update follow/unfollow text
            const toggleFollowItem = npcContextMenu.querySelector('[data-action="toggleFollow"]');
            if (toggleFollowItem) {
                toggleFollowItem.textContent = n.followingTargetId !== null ? 'Unfollow' : 'Follow';
                 toggleFollowItem.style.opacity = '1'; // Reset opacity
            }

        } else if (menuElement.id === 'pfp-context-menu') {
             const toggleTabsItem = pfpContextMenu.querySelector('[data-action="toggle-tabs"]'); if (toggleTabsItem) { toggleTabsItem.textContent = chatTabsVisible ? "Hide Tabs" : "Show Tabs"; }
             const toggleFullscreenItem = pfpContextMenu.querySelector('[data-action="toggle-fullscreen"]'); if (toggleFullscreenItem) { const isCurrentlyFullscreen = chatArea.offsetHeight >= (window.innerHeight - 10); toggleFullscreenItem.textContent = isCurrentlyFullscreen ? "Minimize Chat" : "Fullscreen Chat"; }
        } else { return; }

        const mW = menuElement.offsetWidth; const mH = menuElement.offsetHeight;
        let x = event.clientX; let y = event.clientY;
        if (x + mW > window.innerWidth) x -= mW; if (y + mH > window.innerHeight) y -= mH;
        menuElement.style.left = `${x}px`; menuElement.style.top = `${y}px`;
        menuElement.style.display = 'block';
        document.addEventListener('click', closeContextMenuOnClickOutside, { capture: true, once: true });
        document.addEventListener('contextmenu', closeContextMenuOnClickOutside, { capture: true, once: true });
    }
    function handleNpcContextMenu(event) { handleGenericContextMenu(event, npcContextMenu); }
    function handlePlayerContextMenu(event) { handleGenericContextMenu(event, playerContextMenu); }
    function showPfpContextMenu(event) { handleGenericContextMenu(event, pfpContextMenu); }
    function closeAllContextMenus() { npcContextMenu.style.display = 'none'; playerContextMenu.style.display = 'none'; pfpContextMenu.style.display = 'none'; contextMenuTargetNpcId = null; contextMenuTargetIsPlayer = false; }
    function closeContextMenuOnClickOutside(event) { const activeMenu = [npcContextMenu, playerContextMenu, pfpContextMenu].find(menu => menu.style.display === 'block'); if (activeMenu && !activeMenu.contains(event.target)){ closeAllContextMenus(); } else if (activeMenu) { document.addEventListener('click', closeContextMenuOnClickOutside, { capture: true, once: true }); document.addEventListener('contextmenu', closeContextMenuOnClickOutside, { capture: true, once: true }); } }

    function findCurrentAreaName(x, y, envList) { if (x === undefined || y === undefined || !envList) return null; for (const env of envList) { if (x >= env.x && x < env.x + env.width && y >= env.y && y < env.y + env.height) { return env.name; } } return null; }

    // --- Other Core Functions (some modified) ---
    function getRandomHexColor(){ const l='0123456789ABCDEF';let c='#';for(let i=0;i<6;i++)c+=l[Math.floor(Math.random()*16)];const r=parseInt(c.substring(1,3),16),g=parseInt(c.substring(3,5),16),b=parseInt(c.substring(5,7),16);return(r<50&&g<50&&b<50)?getRandomHexColor():c; }
    function showSpeechBubble(c,m){ if(!c||!c.speechElement)return;if(c.speechTimeout)clearTimeout(c.speechTimeout);c.speechElement.textContent=m;c.speechElement.style.display='block';c.isTalking=true;c.speechTimeout=setTimeout(()=>{if(c.speechElement)c.speechElement.style.display='none';c.isTalking=false;c.speechTimeout=null;},globalSpeechDuration); }
    function updateCharacterPosition(c){ if(c&&c.element){c.element.style.left=`${c.x}px`;c.element.style.top=`${c.y}px`;} }
    function updateEnvironmentVisuals(e){ if(!e||!e.element)return;e.element.style.left=`${e.x}px`;e.element.style.top=`${e.y}px`;e.element.style.width=`${e.width}px`;e.element.style.height=`${e.height}px`;if(e.nameElement)e.nameElement.textContent=e.name; }
    function updateCameraPosition(){ if(playerData.x===undefined||playerData.y===undefined||!playerData.element||playerData.element.style.display==='none') return; viewportWidth=gameWorld.offsetWidth;viewportHeight=gameWorld.offsetHeight;let tx=playerData.x-viewportWidth/2+(playerData.width/2);let ty=playerData.y-viewportHeight/2+(playerData.height/2);const cx=Math.max(0,Math.min(MAP_WIDTH-viewportWidth,tx));const cy=Math.max(0,Math.min(MAP_HEIGHT-viewportHeight,ty));mapContent.style.transform=`translate3d(${-cx}px,${-cy}px,0)`; }
    function applyPlayerAppearance(styleData) { if (!playerData.element||!styleData||!styleData.colors) return; applyAppearanceToElement(playerData.element, styleData); }
    function applyNpcAppearance(npc) { if (!npc||!npc.element||!npc.appearance||!npc.appearance.colors) return; applyAppearanceToElement(npc.element, npc.appearance); }
    function applyAppearanceToElement(element, styleData) { // Full implementation unchanged
         if (!element || !styleData || !styleData.colors) return; const { outfit, gender, colors } = styleData; let baseClasses = "character"; if (element.id === 'player') baseClasses += ""; else baseClasses += " npc"; if (element.classList.contains('is-walking')) baseClasses += ' is-walking'; element.className = `${baseClasses} gender-${gender} outfit-${outfit}`; const parts = { head: element.querySelector('.part.head'), torso: element.querySelector('.part.torso'), legs: element.querySelector('.part.legs'), armLeft: element.querySelector('.part.arm-left'), armRight: element.querySelector('.part.arm-right'), detail1: element.querySelector('.part.detail1'), detail2: element.querySelector('.part.detail2'), detail3: element.querySelector('.part.detail3'), detail4: element.querySelector('.part.detail4'), detail5: element.querySelector('.part.detail5') }; if (!parts.head) { console.error("Cannot find .part.head in:", element); return; } const FIXED_SKIN_TONE = getComputedStyle(document.documentElement).getPropertyValue('--skin-tone').trim() || '#fbe5d6'; const DEFAULT_OUTLINE = getComputedStyle(document.documentElement).getPropertyValue('--default-outline').trim() || '#222'; Object.entries(parts).forEach(([key, p]) => { if(p) { p.style.backgroundColor=''; p.style.borderColor=DEFAULT_OUTLINE; p.style.borderTopColor=''; p.style.borderBottomColor=''; p.style.borderLeftColor=''; p.style.borderRightColor=''; p.style.outlineColor=''; p.style.clipPath = ''; p.style.borderStyle = 'solid'; p.style.borderWidth = '1px'; if (key === 'detail3' || key === 'detail4' || key === 'detail5') p.style.borderColor = 'transparent'; if (key === 'detail2' && gender === 'female') { p.style.borderColor = 'transparent'; p.style.borderBottomColor = darkenHexColor(colors.hair, 0.2); } else if (key === 'detail2') p.style.borderBottomColor = ''; if((key === 'detail2' || key === 'detail3') && gender === 'male' && outfit === 'mage') p.style.borderColor = DEFAULT_OUTLINE; } }); if(parts.head) { parts.head.style.backgroundColor = FIXED_SKIN_TONE; parts.head.style.borderColor = darkenHexColor(FIXED_SKIN_TONE, 0.2); } if(parts.legs) parts.legs.style.borderBottomColor = colors.feet; if (gender === 'male') { if (outfit !== 'mage') { if(parts.detail2){parts.detail2.style.backgroundColor=colors.hair;parts.detail2.style.borderColor=darkenHexColor(colors.hair,0.3);} if(parts.detail3){parts.detail3.style.backgroundColor=colors.hair;parts.detail3.style.borderColor=darkenHexColor(colors.hair,0.3);} } else { if(parts.detail2){parts.detail2.style.backgroundColor='';parts.detail2.style.borderColor=DEFAULT_OUTLINE;} if(parts.detail3){parts.detail3.style.backgroundColor='';parts.detail3.style.borderColor=DEFAULT_OUTLINE;} } switch(outfit){ case 'citizen': if(parts.torso){parts.torso.style.backgroundColor=colors.primary;parts.torso.style.borderTopColor=colors.secondary;parts.torso.style.borderTopWidth='2px';parts.torso.style.borderBottomStyle='none';} if(parts.legs){parts.legs.style.backgroundColor=colors.legs;parts.legs.style.borderBottomWidth='3px';parts.legs.style.borderTopStyle='none';} if(parts.armLeft)parts.armLeft.style.backgroundColor=FIXED_SKIN_TONE; if(parts.armRight)parts.armRight.style.backgroundColor=FIXED_SKIN_TONE; break; case 'mage': if(parts.torso)parts.torso.style.backgroundColor=colors.primary; if(parts.armLeft)parts.armLeft.style.backgroundColor=colors.primary; if(parts.armRight)parts.armRight.style.backgroundColor=colors.primary; if(parts.detail1){parts.detail1.style.backgroundColor=colors.detail1;parts.detail1.style.borderColor=darkenHexColor(colors.detail1,0.3);} if(parts.detail4){parts.detail4.style.backgroundColor=colors.hair;parts.detail4.style.borderColor=darkenHexColor(colors.hair,0.3);parts.detail4.style.borderBottomStyle='none';} if(parts.legs){parts.legs.style.backgroundColor=darkenHexColor(colors.primary,0.1);parts.legs.style.borderBottomWidth='3px';parts.legs.style.borderTopStyle='none';} break; case 'warrior': if(parts.torso){parts.torso.style.backgroundColor=colors.primary;parts.torso.style.borderColor=colors.secondary;parts.torso.style.borderStyle='outset';parts.torso.style.borderWidth='2px';} if(parts.legs){parts.legs.style.backgroundColor=colors.legs;parts.legs.style.borderColor=colors.secondary;parts.legs.style.borderBottomColor=colors.feet;parts.legs.style.borderStyle='outset';parts.legs.style.borderBottomWidth='4px';parts.legs.style.borderTopStyle='none';} if(parts.detail1){parts.detail1.style.backgroundColor=colors.detail1;parts.detail1.style.borderColor=darkenHexColor(colors.detail1,0.3);} if(parts.detail4){parts.detail4.style.backgroundColor=colors.secondary;parts.detail4.style.borderColor=darkenHexColor(colors.secondary,0.3);parts.detail4.style.borderStyle='outset';parts.detail4.style.borderWidth='1px';} if(parts.detail5){parts.detail5.style.backgroundColor=colors.secondary;parts.detail5.style.borderColor=darkenHexColor(colors.secondary,0.3);parts.detail5.style.borderStyle='outset';parts.detail5.style.borderWidth='1px';} if(parts.armLeft){parts.armLeft.style.backgroundColor=colors.secondary;parts.armLeft.style.borderColor=darkenHexColor(colors.secondary,0.3);} if(parts.armRight){parts.armRight.style.backgroundColor=colors.secondary;parts.armRight.style.borderColor=darkenHexColor(colors.secondary,0.3);} break; case 'scifi': if(parts.torso){parts.torso.style.backgroundColor=colors.primary;parts.torso.style.borderColor=colors.secondary;parts.torso.style.borderStyle='solid';parts.torso.style.borderWidth='1px 2px';} if(parts.legs){parts.legs.style.backgroundColor=colors.legs;parts.legs.style.borderColor=colors.secondary;parts.legs.style.borderBottomColor=colors.feet;parts.legs.style.borderStyle='solid';parts.legs.style.borderWidth='1px 2px';parts.legs.style.borderBottomWidth='3px';} if(parts.armLeft)parts.armLeft.style.backgroundColor=colors.primary; if(parts.armRight)parts.armRight.style.backgroundColor=colors.primary; if(parts.detail1){parts.detail1.style.backgroundColor=colors.detail1;parts.detail1.style.borderColor=darkenHexColor(colors.detail1,0.3);} break; case 'ranger': if(parts.torso)parts.torso.style.backgroundColor=colors.primary; if(parts.armLeft)parts.armLeft.style.backgroundColor=colors.primary; if(parts.armRight)parts.armRight.style.backgroundColor=colors.primary; if(parts.detail1){parts.detail1.style.backgroundColor=colors.detail1;parts.detail1.style.borderColor=darkenHexColor(colors.detail1,0.3);} if(parts.legs){parts.legs.style.backgroundColor=colors.legs;parts.legs.style.borderBottomWidth='3px';} break; case 'kimono': if(parts.torso){parts.torso.style.backgroundColor=colors.primary;parts.torso.style.borderColor=colors.secondary;parts.torso.style.borderLeftWidth='2px';parts.torso.style.borderRightWidth='2px';} if(parts.armLeft)parts.armLeft.style.backgroundColor=colors.primary; if(parts.armRight)parts.armRight.style.backgroundColor=colors.primary; if(parts.detail1){parts.detail1.style.backgroundColor=colors.detail1;parts.detail1.style.borderColor=darkenHexColor(colors.detail1,0.3);} if(parts.legs){parts.legs.style.backgroundColor=darkenHexColor(colors.primary,0.1);parts.legs.style.borderBottomWidth='3px';parts.legs.style.borderTopStyle='none';} break; } } else { if(parts.detail2){parts.detail2.style.backgroundColor=colors.hair;parts.detail2.style.border='none';parts.detail2.style.borderBottom=`1px solid ${darkenHexColor(colors.hair, 0.2)}`;} if(parts.detail3){parts.detail3.style.backgroundColor=colors.hair;parts.detail3.style.border='none';} switch(outfit){ case 'citizen': if(parts.torso){parts.torso.style.backgroundColor=colors.primary;parts.torso.style.borderTopColor=colors.secondary;parts.torso.style.borderBottomColor=colors.secondary;} if(parts.legs){parts.legs.style.backgroundColor=colors.legs;parts.legs.style.borderLeftColor=colors.secondary;parts.legs.style.borderRightColor=colors.secondary;parts.legs.style.borderBottomWidth='3px';parts.legs.style.borderTopStyle='none';} if(parts.detail1){parts.detail1.style.backgroundColor=colors.detail1;parts.detail1.style.borderColor=darkenHexColor(colors.detail1,0.3);} if(parts.armLeft)parts.armLeft.style.backgroundColor=colors.primary; if(parts.armRight)parts.armRight.style.backgroundColor=colors.primary; break; case 'mage': if(parts.torso)parts.torso.style.backgroundColor=colors.primary; if(parts.armLeft)parts.armLeft.style.backgroundColor=colors.primary; if(parts.armRight)parts.armRight.style.backgroundColor=colors.primary; if(parts.detail1){parts.detail1.style.backgroundColor=colors.detail1;parts.detail1.style.borderColor=colors.secondary;} if(parts.legs){parts.legs.style.backgroundColor=darkenHexColor(colors.primary,0.1);parts.legs.style.borderBottomWidth='2px';parts.legs.style.borderTopStyle='none';} break; case 'warrior': if(parts.torso){parts.torso.style.backgroundColor=colors.primary;parts.torso.style.borderColor=colors.secondary;parts.torso.style.borderStyle='solid';parts.torso.style.borderWidth='1px';} if(parts.legs){parts.legs.style.backgroundColor=colors.legs;parts.legs.style.borderColor=colors.secondary;parts.legs.style.borderBottomColor=colors.feet;parts.legs.style.borderBottomWidth='3px';parts.legs.style.borderTopStyle='none';} if(parts.detail1){parts.detail1.style.backgroundColor=colors.detail1;parts.detail1.style.borderColor=darkenHexColor(colors.detail1,0.3);parts.detail1.style.borderStyle='outset';} if(parts.armLeft){parts.armLeft.style.backgroundColor=colors.secondary;parts.armLeft.style.borderColor=darkenHexColor(colors.secondary,0.3);parts.armLeft.style.borderStyle='outset';parts.armLeft.style.borderWidth='1px';} if(parts.armRight){parts.armRight.style.backgroundColor=colors.secondary;parts.armRight.style.borderColor=darkenHexColor(colors.secondary,0.3);parts.armRight.style.borderStyle='outset';parts.armRight.style.borderWidth='1px';} break; case 'scifi': if(parts.torso){parts.torso.style.backgroundColor=colors.primary;parts.torso.style.borderColor=colors.secondary;parts.torso.style.borderStyle='solid';parts.torso.style.borderWidth='1px';} if(parts.legs){parts.legs.style.backgroundColor=colors.legs;parts.legs.style.borderColor=colors.secondary;parts.legs.style.borderBottomColor=colors.feet;parts.legs.style.borderBottomWidth='3px';parts.legs.style.borderStyle='solid';parts.legs.style.borderWidth='1px';} if(parts.armLeft){parts.armLeft.style.backgroundColor=colors.primary;parts.armLeft.style.borderColor=colors.secondary;} if(parts.armRight){parts.armRight.style.backgroundColor=colors.primary;parts.armRight.style.borderColor=colors.secondary;} if(parts.detail1){parts.detail1.style.backgroundColor=colors.detail1;parts.detail1.style.borderColor=darkenHexColor(colors.detail1,0.3);} break; case 'ranger': if(parts.torso)parts.torso.style.backgroundColor=colors.primary; if(parts.armLeft)parts.armLeft.style.backgroundColor=colors.primary; if(parts.armRight)parts.armRight.style.backgroundColor=colors.primary; if(parts.detail1){parts.detail1.style.backgroundColor=colors.detail1;parts.detail1.style.borderColor=darkenHexColor(colors.detail1,0.3);} if(parts.legs){parts.legs.style.backgroundColor=colors.legs;parts.legs.style.borderBottomWidth='3px';} break; case 'kimono': if(parts.torso){parts.torso.style.backgroundColor=colors.primary;parts.torso.style.borderColor=colors.secondary;parts.torso.style.borderLeftWidth='2px';parts.torso.style.borderRightWidth='2px';parts.torso.style.borderStyle='solid';} if(parts.armLeft)parts.armLeft.style.backgroundColor=colors.primary; if(parts.armRight)parts.armRight.style.backgroundColor=colors.primary; if(parts.detail1){parts.detail1.style.backgroundColor=colors.detail1;parts.detail1.style.borderColor=colors.secondary;} if(parts.legs){parts.legs.style.backgroundColor=darkenHexColor(colors.primary,0.1);parts.legs.style.borderBottomWidth='2px';parts.legs.style.borderTopStyle='none';} break; } }
    }
    function movePlayer(dx, dy) {
         if (!playerData.element||!currentCityKey||playerData.element.style.display==='none') return;
         const tX=playerData.x+dx*playerStepDistance;
         const tY=playerData.y+dy*playerStepDistance;
         playerData.x=Math.max(0,Math.min(MAP_WIDTH-playerData.width,tX));
         playerData.y=Math.max(0,Math.min(MAP_HEIGHT-playerData.height,tY));
         updateCharacterPosition(playerData);
         updateCameraPosition();
         updateSpatialChatModuleState(); // Update spatial chat state immediately

         if (!isPlayerMoving) { playerElement.classList.add('is-walking'); isPlayerMoving=true; }
         clearTimeout(playerMoveTimeout); playerMoveTimeout=setTimeout(() => {
            playerElement.classList.remove('is-walking'); isPlayerMoving=false;
            const pR=playerElement.querySelectorAll('.part.arm-left,.part.arm-right,.part.legs');
            pR.forEach(p=>{p.style.animation='none';p.offsetHeight;p.style.animation='';p.style.transform='';});
            playerElement.style.animation='none';playerElement.offsetHeight;playerElement.style.animation='';playerElement.style.transform='';
            updateInputPlaceholder(); // Update placeholder after stopping
         }, 550);
    }
    function updateInputPlaceholder(){
         if (!currentCityKey && currentChatDisplayMode !== 'message') { userInput.placeholder = "Open Settings (Click Spirit Sigil)..."; return; }
         if (isWaitingForApiResponse && (currentChatDisplayMode === 'message' || currentChatDisplayMode === 'agent')) {
             userInput.placeholder = "Waiting for response...";
             return; // Don't override if waiting for direct API
         }
         if (currentChatDisplayMode === 'spatial') {
             // Updated placeholder for spatial modes
             userInput.placeholder = currentSpatialScope ? `Shout into #${currentSpatialScope}...` : 'Select a spatial scope...';
         } else if (currentChatDisplayMode === 'message') { // 'message' is the data-mode for the "Chat" tab
             const targetNpc = currentAiNpcData || { name: "Spirit" }; // Use current or fallback
             userInput.placeholder = `Chat with ${targetNpc.name}...`; // Renamed
         } else if (currentChatDisplayMode === 'agent') {
             const targetNpc = currentAiNpcData || findClosestNpc(false);
             if (targetNpc) userInput.placeholder = `Command ${targetNpc.name} (Agent Mode)...`;
             else userInput.placeholder = 'Walk near an agent (Agent Mode)...';
         } else {
              userInput.placeholder = 'Select a chat mode...';
         }
    }
    function findClosestNpc(log=true){ let clNpc=null;let minDist=Infinity;if(playerData.x===undefined||playerData.y===undefined||!currentCityKey||playerData.element.style.display==='none') return null; npcData.forEach(n=>{ if(typeof n.x!=='number'||typeof n.y !=='number')return;const d=Math.hypot(playerData.x-n.x,playerData.y-n.y);if(d<minDist){minDist=d;clNpc=n;}});if(log&&clNpc)console.log("Closest NPC:",clNpc.name);return clNpc;}
    function getGameStateString(){ let s=`[P(${playerData.name}):Pos(${Math.round(playerData.x)},${Math.round(playerData.y)})]`;npcData.forEach(n=>{s+=` [${n.name}(${n.id}):Pos(${Math.round(n.x)},${Math.round(n.y)})${n.followingTargetId !== null ? ` F(${n.followingTargetId === 'player' ? 'P' : n.followingTargetId})` : ''}]`;});environmentData.forEach(e=>{s+=` [Env(${e.name}):Pos(${Math.round(e.x)},${Math.round(e.y)})W(${e.width})H(${e.height})]`;}); return s;}

    function generateSystemPrompt(npc) {
        const persona = npc.personaPrompt || `You are ${npc.name}.`;
        const interactionMode = currentChatDisplayMode; // 'message' or 'agent'

        if (interactionMode === 'agent') {
            // Agent mode: Provide action rules and expect only actions
            return `${persona} ${BASE_ACTION_RULES}`;
        } else {
            // Message mode (now "Chat"): Standard persona prompt
            return persona;
        }
    }

    // MODIFIED: processNpcActions now also adds UI messages
    function processNpcActions(r, n) {
        if (!n) return r; // Should not happen if called correctly
        let commandText = r; // Start with the full response
        const actionRegex = /<(\w+)(?:\s+([^>]*?))?\s*>/g;
        let match;
        const actions = [];

        // Extract all action tags
        while ((match = actionRegex.exec(r)) !== null) {
            actions.push({
                name: match[1]?.toLowerCase(),
                params: match[2] || "",
                tag: match[0]
            });
            // Remove the processed tag from the commandText (though ideally it's the only thing)
            commandText = commandText.replace(match[0], '').trim();
        }

        // Process the first valid action found (or could process all)
        if (actions.length > 0) {
            const action = actions[0]; // Process the first one for now
            console.log(`Processing Action: ${action.name}(${action.params}) for ${n.name}`);
            switch (action.name) {
                case 'walk':
                    handleWalkAction(n, action.params);
                    const coords = action.params.split(',');
                    if (coords.length === 2) {
                        addMessage(`${n.name} walks towards ${coords[0].trim()}, ${coords[1].trim()}.`, 'Agent Command', 'system');
                    } else {
                        addMessage(`${n.name} attempts to walk (invalid coords: ${action.params}).`, 'Agent Command', 'warn');
                    }
                    break;
                case 'follow':
                    handleFollowAction(n); // Adds its own message
                    break;
                case 'unfollow':
                    handleUnfollowAction(n); // Adds its own message
                    break;
                default:
                    console.warn(`Unknown action tag: ${action.name}`);
                    addMessage(`${n.name} considered an unknown action: ${action.tag}.`, 'Agent Command', 'warn');
            }
            // Since we expect *only* the action tag, return null to signify no text reply expected
            return null;
        } else {
             if (r && r.trim()) { // Check if there was actually non-action text
                 console.warn(`Agent ${n.name} responded with text instead of an action: "${r}"`);
                 addMessage(`(${n.name} did not provide a valid action: "${r.substring(0,50)}...")`, 'Agent Command', 'warn');
             }
            return null; // No valid action found
        }
    }

    function handleWalkAction(n,p){ if (!n||!n.element) return; n.followingTargetId=null; const c=p.split(',');if(c.length===2){const x=parseInt(c[0].trim(),10),y=parseInt(c[1].trim(),10);if(!isNaN(x)&&!isNaN(y)){n.x=Math.max(0,Math.min(MAP_WIDTH-n.width,x));n.y=Math.max(0,Math.min(MAP_HEIGHT-n.height,y));updateCharacterPosition(n);}else console.warn(`Inv Walk Coords:${p}`);}else console.warn(`Inv Walk Params:${p}`);}
    function findClosestCharacter(s, includeSelf = false, onlyPlayer = false){ let t=null,minD=Infinity; let pots=[playerData]; if (!onlyPlayer) { pots=pots.concat(npcData); } pots=pots.filter(tg => tg && tg.element?.style.display !== 'none' && (includeSelf || tg !== s) && (typeof s.x === 'number' && typeof tg.x === 'number' && s.y !== undefined && tg.y !== undefined) ); pots.forEach(tg=>{ const d=Math.hypot(s.x-tg.x,s.y-tg.y); if(d<minD){minD=d;t=tg;} }); console.log(`${s.name} target (${onlyPlayer ? 'Player' : 'Any'}): ${t?t.name:"None"}`); return t;}

    function handleFollowAction(n) {
        if (!n || !n.element) return;
        const target = playerData;
         if (target && target.element?.style.display !== 'none') {
            n.followingTargetId = 'player';
            console.log(`${n.name} starts following ${target.name}`);
            addMessage(`${n.name} starts following ${target.name}.`, 'SYSTEM', 'system');
         } else {
             n.followingTargetId = null;
             console.log(`${n.name} cannot find the player to follow.`);
             addMessage(`${n.name} cannot find the player to follow.`, 'SYSTEM', 'warn');
         }
    }

    // NEW: Unfollow action handler
    function handleUnfollowAction(n) {
        if (!n || !n.element) return;
        if (n.followingTargetId !== null) {
            const targetName = n.followingTargetId === 'player' ? playerData.name : `Agent ${n.followingTargetId}`;
            console.log(`${n.name} stops following ${targetName}.`);
            addMessage(`${n.name} stops following.`, 'SYSTEM', 'system');
            n.followingTargetId = null;
        }
    }

    function updateFollowingNpcs() {
         if (!currentCityKey) return;
         let positionChanged = false;
         npcData.forEach(npc => {
             if (!npc.followingTargetId || !npc.element) return;
             let target = null;
             if (npc.followingTargetId === 'player') {
                 target = playerData;
             } else if (typeof npc.followingTargetId === 'number') {
                 target = npcData.find(n => n.id === npc.followingTargetId);
             }
             if (!target || target.element?.style.display === 'none' || typeof target.x !== 'number' || typeof target.y !== 'number' ) {
                 if (npc.followingTargetId !== null) {
                     console.log(`${npc.name} lost target, stopping follow.`);
                     addMessage(`${npc.name} lost their target and stops following.`, 'SYSTEM', 'system');
                     npc.followingTargetId = null;
                 }
                 return;
             }
             const dx = target.x - npc.x;
             const dy = target.y - npc.y;
             const distance = Math.hypot(dx, dy);
             if (distance > FOLLOW_DISTANCE) {
                 const normDx = distance === 0 ? 0 : dx / distance;
                 const normDy = distance === 0 ? 0 : dy / distance;
                 const moveX = normDx * NPC_FOLLOW_SPEED;
                 const moveY = normDy * NPC_FOLLOW_SPEED;
                 let newX = npc.x + moveX;
                 let newY = npc.y + moveY;
                 newX = Math.max(0, Math.min(MAP_WIDTH - npc.width, newX));
                 newY = Math.max(0, Math.min(MAP_HEIGHT - npc.height, newY));
                 if (npc.x !== newX || npc.y !== newY) {
                     npc.x = newX; npc.y = newY;
                     updateCharacterPosition(npc);
                     positionChanged = true;
                 }
             }
         });
         if (positionChanged) {
             updateSpatialChatModuleState(); // Update spatial state if NPCs moved
         }
    }
    function displayTypingIndicator() { if (currentChatDisplayMode === 'spatial') return; removeTypingIndicator(); const t=document.createElement('div'); t.className='typing-indicator'; t.id='typing-indicator'; t.innerHTML=`<span>The spirit is responding</span><span class="rune">✧</span><span class="rune">✦</span><span class="rune">✧</span>`; chatMessages.appendChild(t); chatMessages.scrollTop=chatMessages.scrollHeight; }
    function removeTypingIndicator() { const t=document.getElementById('typing-indicator'); if(t) t.remove(); }

    // --- API Key Handling (Unchanged) ---
    function loadApiKeyManagement() { console.log("Loading API key management state..."); const storedData = localStorage.getItem(LS_KEYS.providerApiKeysStorage); if (storedData) { try { const parsedData = JSON.parse(storedData); if (parsedData && typeof parsedData.providerKeys === 'object' && typeof parsedData.activeKeyIndices === 'object') { apiKeyManagement = parsedData; Object.keys(apiKeyManagement.providerKeys).forEach(prov => { if (!Array.isArray(apiKeyManagement.providerKeys[prov])) { apiKeyManagement.providerKeys[prov] = []; } if (typeof apiKeyManagement.activeKeyIndices[prov] !== 'number') { apiKeyManagement.activeKeyIndices[prov] = 0; } apiKeyManagement.activeKeyIndices[prov] = Math.max(0, Math.min(apiKeyManagement.activeKeyIndices[prov], apiKeyManagement.providerKeys[prov].length -1)); if(apiKeyManagement.providerKeys[prov].length === 0) { apiKeyManagement.activeKeyIndices[prov] = 0; } }); console.log(`Loaded ${Object.keys(apiKeyManagement.providerKeys).length} providers' keys.`); } else { console.warn("Invalid structure in stored API key data. Resetting."); apiKeyManagement = { providerKeys: {}, activeKeyIndices: {} }; } } catch (e) { console.error("Error parsing stored API key data. Resetting.", e); apiKeyManagement = { providerKeys: {}, activeKeyIndices: {} }; localStorage.removeItem(LS_KEYS.providerApiKeysStorage); } } else { apiKeyManagement = { providerKeys: {}, activeKeyIndices: {} }; console.log("No stored API key data found."); } }
    function saveApiKeyManagement() { try { localStorage.setItem(LS_KEYS.providerApiKeysStorage, JSON.stringify(apiKeyManagement)); } catch (e) { console.error("Failed to save API key management state:", e); addMessage("Error saving API key configuration.", "SYSTEM", "error"); } }
    function handleAddApiKey() { const providerSelect = document.getElementById('apiProviderSelect'); const newApiKeyInput = document.getElementById('newApiKeyInput'); const currentSelectedProviderKey = providerSelect ? providerSelect.value : null; if (!newApiKeyInput || !currentSelectedProviderKey) { addMessage("Error: Cannot add key - UI elements missing or no provider selected.", "SYSTEM", "error"); return; } const providerConfig = PROVIDERS[currentSelectedProviderKey]; if (!providerConfig) { addMessage(`Error: Invalid provider selected (${currentSelectedProviderKey}).`, "SYSTEM", "error"); return; } if (providerConfig.format === 'proxy_compatible' || providerConfig.apiKeyLocation === 'none') { addMessage(`API Keys are not managed by the client for ${providerConfig.name}.`, "SYSTEM", "info"); newApiKeyInput.value = ''; return; } const newKey = newApiKeyInput.value.trim(); if (!newKey) { addMessage("Please enter an API key to add.", "SYSTEM", "info"); return; } if (!apiKeyManagement.providerKeys[currentSelectedProviderKey]) { apiKeyManagement.providerKeys[currentSelectedProviderKey] = []; apiKeyManagement.activeKeyIndices[currentSelectedProviderKey] = 0; } const keysForProvider = apiKeyManagement.providerKeys[currentSelectedProviderKey]; if (keysForProvider.includes(newKey)) { addMessage(`Key already exists for ${providerConfig.name}.`, "SYSTEM", "info"); } else { keysForProvider.push(newKey); addMessage(`Added key for ${providerConfig.name}.`, "SYSTEM", "system"); saveApiKeyManagement(); renderApiKeysForProvider(currentSelectedProviderKey); } newApiKeyInput.value = ''; }
    function handleDeleteApiKey(providerKey, keyToDelete) { if (!providerKey || !keyToDelete) return; const providerConfig = PROVIDERS[providerKey]; if (!providerConfig) return; if (providerConfig.format === 'proxy_compatible' || providerConfig.apiKeyLocation === 'none') return; const keys = apiKeyManagement.providerKeys[providerKey]; if (!keys || !keys.includes(keyToDelete)) return; const currentActiveIndex = apiKeyManagement.activeKeyIndices[providerKey] ?? 0; const keyIndexToDelete = keys.indexOf(keyToDelete); if (confirm(`Are you sure you want to remove the key "${maskApiKey(keyToDelete)}"?`)) { apiKeyManagement.providerKeys[providerKey] = keys.filter(k => k !== keyToDelete); const newKeys = apiKeyManagement.providerKeys[providerKey]; if (newKeys.length === 0) { delete apiKeyManagement.providerKeys[providerKey]; delete apiKeyManagement.activeKeyIndices[providerKey]; addMessage(`Removed last key for ${providerConfig.name}.`, "SYSTEM", "system"); } else { if (keyIndexToDelete < currentActiveIndex) { apiKeyManagement.activeKeyIndices[providerKey] = Math.max(0, currentActiveIndex - 1); } else if (keyIndexToDelete === currentActiveIndex) { apiKeyManagement.activeKeyIndices[providerKey] = currentActiveIndex % newKeys.length; } addMessage(`Removed key for ${providerConfig.name}.`, "SYSTEM", "system"); } saveApiKeyManagement(); renderApiKeysForProvider(providerKey); } }
    function renderApiKeysForProvider(providerKey) { const apiKeyListDiv = document.getElementById('apiKeyListDiv'); const activeApiKeyDisplay = document.getElementById('activeApiKeyDisplay'); const newApiKeyInput = document.getElementById('newApiKeyInput'); const addApiKeyBtn = document.getElementById('addApiKeyBtn'); if (!apiKeyListDiv || !activeApiKeyDisplay || !newApiKeyInput || !addApiKeyBtn) return; apiKeyListDiv.innerHTML = ''; activeApiKeyDisplay.textContent = 'None'; if (!providerKey || !PROVIDERS[providerKey]) { apiKeyListDiv.innerHTML = '<p class="key-list-message">Select a provider.</p>'; newApiKeyInput.disabled = true; addApiKeyBtn.disabled = true; return; } const providerConfig = PROVIDERS[providerKey]; const keys = apiKeyManagement.providerKeys[providerKey] || []; const activeIndex = apiKeyManagement.activeKeyIndices[providerKey] ?? 0; if (providerConfig.format === 'proxy_compatible' || providerConfig.apiKeyLocation === 'none') { apiKeyListDiv.innerHTML = `<p class="key-list-message">API Key managed by proxy/server for ${providerConfig.name}.</p>`; activeApiKeyDisplay.innerHTML = `Key Location: <strong>${providerConfig.apiKeyLocation}</strong>`; newApiKeyInput.disabled = true; newApiKeyInput.placeholder = "Key handled by proxy"; addApiKeyBtn.disabled = true; return; } newApiKeyInput.disabled = false; newApiKeyInput.placeholder = `Add API Key for ${providerConfig.name}`; addApiKeyBtn.disabled = false; if (keys.length === 0) { apiKeyListDiv.innerHTML = '<p class="key-list-message">No keys added for this provider.</p>'; activeApiKeyDisplay.textContent = 'None'; } else { keys.forEach((key, index) => { const itemDiv = document.createElement('div'); itemDiv.className = 'api-key-item'; const keySpan = document.createElement('span'); keySpan.textContent = maskApiKey(key); keySpan.title = key; const controlsDiv = document.createElement('div'); controlsDiv.className = 'api-key-item-controls'; const deleteBtn = document.createElement('button'); deleteBtn.textContent = 'Del'; deleteBtn.title = `Delete key ${maskApiKey(key)}`; deleteBtn.className = 'api-key-item-delete-btn'; deleteBtn.onclick = () => handleDeleteApiKey(providerKey, key); controlsDiv.appendChild(deleteBtn); itemDiv.appendChild(keySpan); itemDiv.appendChild(controlsDiv); apiKeyListDiv.appendChild(itemDiv); if (index === activeIndex) { itemDiv.style.backgroundColor = 'var(--amethyst-light, rgba(107, 33, 168, 0.1))'; activeApiKeyDisplay.innerHTML = `Next key to try: <strong>${maskApiKey(key)}</strong>`; } }); if (!activeApiKeyDisplay.innerHTML.includes('Next key')) { activeApiKeyDisplay.innerHTML = `Next key to try: <strong>${maskApiKey(keys[0])}</strong>`; } } }

    // --- API Call Logic (MODIFIED - Checks for 'message' mode) ---
    async function getApiResponseFromProvider(userMessage, attempt = 1) {
         if (!currentCityKey && (currentChatDisplayMode === 'message' || currentChatDisplayMode === 'agent')) { // Check for 'message'
            console.log("Direct chat initiated without a loaded city.");
         } else if (!currentCityKey && currentChatDisplayMode !== 'message') { // Check for 'message'
             addMessage("No city loaded.", "SYSTEM", "system");
             enableInput(); return;
         }
         // Check if PROVIDERS and SpatialChat are loaded (they should be if HTML is set up correctly)
         if (typeof PROVIDERS === 'undefined' || Object.keys(PROVIDERS).length === 0) {
             addMessage("API Provider configuration (api_providers.js) not loaded or empty. Cannot send message.", "SYSTEM", "error"); enableInput(); return;
         }
         if (typeof SpatialChat === 'undefined') {
             addMessage("Spatial Chat module (spatial_chat.js) not loaded. Some features may fail.", "SYSTEM", "warn"); // Warn instead of error?
         }
         if (typeof window.getApiResponse !== 'function') { // This comes from api_providers.js
             addMessage("API Provider script function (window.getApiResponse) not found. Cannot send message.", "SYSTEM", "error"); enableInput(); return;
         }


         if (!selectedProvider || !selectedModel) {
             addMessage("No API Provider or Model selected. Please configure in Settings (Page 2).", "SYSTEM", "error");
             enableInput(); return;
         }

         const providerConfig = PROVIDERS[selectedProvider];
         if (!providerConfig) {
             addMessage(`Configuration error: Provider "${selectedProvider}" not found.`, "SYSTEM", "error");
             enableInput(); return;
         }

        const isDirectChat = (currentChatDisplayMode === 'message' || currentChatDisplayMode === 'agent'); // Check for 'message'

        // Determine target NPC for direct chat
        if (isDirectChat && !currentAiNpcData) {
             const closeNpc = findClosestNpc(true);
             if (closeNpc) { currentAiNpcData = closeNpc; }
             else if (initialSpeakerData) { currentAiNpcData = initialSpeakerData; }

             if (currentChatDisplayMode === 'agent' && !currentAiNpcData) { addMessage("No agent close enough to command. Walk closer.", "SYSTEM", "system"); enableInput(); return; }
             // Ensure fallback for Chat ('message') mode always has data
             if (currentChatDisplayMode === 'message' && !currentAiNpcData) { // Check for 'message'
                currentAiNpcData = { name: "Spirit", personaPrompt: "You are a helpful, disembodied spirit.", pfp: DEFAULT_NPC_PFP };
             }
         }
         if(!isDirectChat) {
             console.error("getApiResponseFromProvider called outside of Chat/Agent mode.");
             enableInput();
             return;
         }

         // Display typing indicator
         if (attempt === 1) { displayTypingIndicator(); }

         // API Key selection logic (unchanged)
         let apiKeyToUse = null; let keysForProvider = []; let totalKeysForProvider = 0; let currentKeyIndex = 0;
         const needsClientKey = providerConfig.format !== 'proxy_compatible' && providerConfig.apiKeyLocation !== 'none';
         if (needsClientKey) {
             keysForProvider = apiKeyManagement.providerKeys[selectedProvider] || [];
             totalKeysForProvider = keysForProvider.length;
             if (totalKeysForProvider === 0) { removeTypingIndicator(); addMessage(`No API keys found for ${providerConfig.name}. Please add one in Settings (Page 2).`, "SYSTEM", "error"); enableInput(); return; }
             if (attempt > totalKeysForProvider) { removeTypingIndicator(); addMessage(`All ${totalKeysForProvider} API keys for ${providerConfig.name} failed. Please check them in Settings or add a new one.`, "SYSTEM", "error"); enableInput(); return; }
             const startIndex = apiKeyManagement.activeKeyIndices[selectedProvider] ?? 0;
             currentKeyIndex = (startIndex + attempt - 1) % totalKeysForProvider;
             apiKeyToUse = keysForProvider[currentKeyIndex];
             if (!apiKeyToUse) { removeTypingIndicator(); addMessage(`Internal error retrieving key at index ${currentKeyIndex} for ${providerConfig.name}.`, "SYSTEM", "error"); enableInput(); return; }
             console.log(`API Call Attempt ${attempt}/${totalKeysForProvider} for ${selectedProvider}. Using key index: ${currentKeyIndex} (${maskApiKey(apiKeyToUse)})`);
         } else {
             apiKeyToUse = null;
             console.log(`API Call for ${selectedProvider} (${providerConfig.name}). Key handled by proxy/server or not required.`);
         }

         const interactionMode = currentChatDisplayMode; // 'message' or 'agent'
         const targetNpc = currentAiNpcData;

         if (!targetNpc) {
             console.error("API Call Error: Target NPC not defined for direct chat.");
             removeTypingIndicator(); addMessage("Internal error: Cannot determine chat target.", "SYSTEM", "error"); enableInput(); return;
         }

         const sysPrompt = generateSystemPrompt(targetNpc);
         let userContent = "";

         if (interactionMode === 'agent' && currentCityKey) {
             const gameState = getGameStateString();
             const events = recentEvents.length > 0 ? ` RecentEvents:[${recentEvents.join('; ')}]` : '';
             const context = `(You are ${targetNpc.name}. Player ${playerData.name} is near you).`;
             userContent = `${gameState}${events} ${context} Player command: ${userMessage}`.trim();
             if (attempt === 1) { recentEvents = []; } // Clear events only on first attempt
         } else { // Message ('message') mode
             userContent = `${playerData.name || 'User'} says: ${userMessage}`.trim();
         }

         // Construct message history
         const messagesForApi = [{ role: 'system', content: sysPrompt }];
         if (interactionMode === 'message') { // Check for 'message'
            // Include relevant conversation history for Chat ('message') mode
            messagesForApi.push(...conversationHistory.filter(m => m.role === 'user' || m.role === 'assistant'));
         }
         messagesForApi.push({ role: 'user', content: userContent });

         const limitedApiMsgs = messagesForApi.length > (MAX_HISTORY_TURNS * 2 + 2) ?
              [messagesForApi[0], ...messagesForApi.slice(-(MAX_HISTORY_TURNS * 2 + 1))] : messagesForApi;

         if (attempt === 1) {
             addMessage(`(${interactionMode.toUpperCase()}) -> ${targetNpc.name} (${providerConfig.name}): ${userMessage.substring(0, 100)}...`, 'DEBUG', 'debug');
         }

         try {
             const rawReply = await window.getApiResponse(selectedProvider, selectedModel, limitedApiMsgs, apiKeyToUse, {});
             removeTypingIndicator();
             addMessage(`(${interactionMode.toUpperCase()}) Raw <- ${targetNpc.name}: ${rawReply.substring(0, 100)}...`, 'DEBUG', 'debug');

             // API Key index update (unchanged)
             if (needsClientKey) {
                 apiKeyManagement.activeKeyIndices[selectedProvider] = (currentKeyIndex + 1) % totalKeysForProvider;
                 saveApiKeyManagement();
                 if (settingsOverlay.classList.contains('active')) { renderApiKeysForProvider(selectedProvider); }
             }

             // --- MODIFIED RESPONSE HANDLING ---
             if (interactionMode === 'agent') {
                 processNpcActions(rawReply, targetNpc);
             } else { // Chat ('message') mode
                 if (rawReply && rawReply.trim()) {
                     addMessage(rawReply, targetNpc.name, 'assistant', targetNpc);
                 } else {
                     addMessage("...", targetNpc.name, 'assistant', targetNpc);
                 }
             }
             // --- END MODIFIED RESPONSE HANDLING ---

             enableInput();

         } catch (error) {
              console.error(`Error during API call attempt ${attempt} for ${selectedProvider} (Index ${currentKeyIndex}):`, error);
              const shouldCycle = needsClientKey && (
                  error.message.includes("401") || error.message.includes("403") || error.message.includes("429") ||
                  error.message.toLowerCase().includes("invalid api key") ||
                  error.message.toLowerCase().includes("authentication failed") ||
                  error.message.toLowerCase().includes("permission denied")
              );
              if (shouldCycle) {
                  addMessage(`API key issue for ${providerConfig.name} (${error.message.substring(0, 50)}...). Trying next key...`, 'SYSTEM', 'debug');
                  setTimeout(() => getApiResponseFromProvider(userMessage, attempt + 1), 500); // Try next key after delay
              } else {
                  removeTypingIndicator();
                  let errorMessage = `Error contacting the spirit via ${providerConfig.name}: ${error.message}`;
                  if (error.message.includes("blocked")) {
                      errorMessage = `Message blocked by ${providerConfig.name} content filters. Try rephrasing. (${error.message})`;
                  }
                  addMessage(errorMessage, 'SYSTEM', 'error');
                  enableInput();
              }
         }
    }


    // --- Input Enable/Disable ---
    function disableInput(){
        userInput.disabled=true;
        sendButton.disabled=true;
        isWaitingForApiResponse = true;
        updateInputPlaceholder();
    }
    function enableInput(){
         userInput.disabled = false;
         sendButton.disabled = false;
         isWaitingForApiResponse = false;
         updateInputPlaceholder();
    }

    // --- Player Send Logic (Checks for 'message' mode) ---
    function handlePlayerSend() {
        const msg = userInput.value.trim();
        if (!msg || sendButton.disabled) return;

        userInput.value = ''; userInput.style.height='auto';userInput.style.height=(userInput.scrollHeight)+'px';

        if (currentChatDisplayMode === 'spatial') {
             if (typeof SpatialChat !== 'undefined' && SpatialChat.addPlayerMessageToScope) {
                console.log(`Sending to spatial scope: ${currentSpatialScope}`);
                const added = SpatialChat.addPlayerMessageToScope(currentSpatialScope, playerData.name, msg);
                 if (added) {
                     displaySpatialChat(currentSpatialScope);
                 } else {
                     addMessage("Could not send message to spatial scope.", "SYSTEM", "error");
                 }
             } else {
                addMessage("Spatial Chat module not available.", "SYSTEM", "error");
             }
             userInput.focus();

        } else { // Chat ('message') or Agent mode
             if (!currentAiNpcData) {
                 const closeNpc = findClosestNpc(false);
                 if (closeNpc) { currentAiNpcData = closeNpc; }
                 else if (initialSpeakerData) { currentAiNpcData = initialSpeakerData; }

                 if (currentChatDisplayMode === 'message' && !currentAiNpcData) { // Check for 'message'
                     currentAiNpcData = { name: "Spirit", personaPrompt: "You are a helpful, disembodied spirit.", pfp: DEFAULT_NPC_PFP };
                 }
                 if (currentChatDisplayMode === 'agent' && !currentAiNpcData) {
                     addMessage("No agent close enough to command.", "SYSTEM", "error");
                     return;
                 }
                 if (!currentAiNpcData){
                      addMessage("Cannot determine chat target.", "SYSTEM", "error");
                      return;
                 }
                 updateInputPlaceholder();
             }

             disableInput(); // Disable input *only* for direct API calls
             addMessage(msg, playerData.name, 'user'); // Add user message to direct history/UI
             getApiResponseFromProvider(msg, 1); // Start direct API call
        }
    }

    // --- Settings & Appearance Modals (Unchanged) ---
    function openSettingsModal() { populateSettingsModal(); settingsOverlay.classList.add('active'); }
    function closeSettingsModal() { settingsOverlay.classList.remove('active'); }
    function openAppearanceEditorModal(target = 'player') {
        appearanceEditorTarget = target; temporaryAppearanceData = null; temporaryPfpData = null; let tA, tN, tP, tPf;
        appearanceEditorNameInput.value = ''; appearanceEditorPersonaInput.value = ''; appearancePfpPreview.src = '';
        if (target === 'player') { tA = playerData.appearance || JSON.parse(JSON.stringify(defaultPlayerAppearance)); tN = playerData.name || 'Player'; tP = playerData.personaPrompt || "You are the Player."; tPf = playerData.pfp || DEFAULT_PLAYER_PFP; }
        else { const n = npcData.find(n => n.id === target); if (!n) { console.error(`NPC ${target} not found for appearance editor`); return; } tA = n.appearance || JSON.parse(JSON.stringify(defaultNpcAppearance)); tN = n.name || `Agent ${target + 1}`; tP = n.personaPrompt || `You are ${tN}.`; tPf = n.pfp || DEFAULT_NPC_PFP; }
        appearanceEditorTitle.textContent = `Set Details for ${tN}`; appearanceEditorNameInput.value = tN; appearanceEditorPersonaInput.value = tP; appearancePfpPreview.src = tPf;
        if (characterCreatorFrame?.contentWindow) { setTimeout(() => { try { characterCreatorFrame.contentWindow.postMessage({ type: 'INIT_STYLE', payload: tA }, '*'); console.log(`Sent initial style to creator for ${tN}`); } catch (err) { console.error("Error sending message to character creator iframe:", err); } }, 200); } else { console.error("Character creator iframe or its content window is not accessible."); }
        appearanceEditorOverlay.classList.add('active');
    }
    function closeAppearanceEditorModal() {
        appearanceEditorOverlay.classList.remove('active'); if (temporaryAppearanceData) { if (appearanceEditorTarget === 'player') { applyPlayerAppearance(playerData.appearance); } else { const n = npcData.find(n => n.id === appearanceEditorTarget); if (n?.appearance) applyNpcAppearance(n); } }
        appearanceEditorTarget = null; temporaryAppearanceData = null; temporaryPfpData = null; pfpUploadInput.value = '';
    }
    function saveAppearanceFromEditor() {
        let styleSaved=false, detailsSaved=false; const newName=appearanceEditorNameInput.value.trim(); const newPersona=appearanceEditorPersonaInput.value.trim();
        if (appearanceEditorTarget === 'player') { if (newName && playerData.name !== newName) { playerData.name=newName; localStorage.setItem(LS_KEYS.playerName, playerData.name); updateNameplate(playerData); detailsSaved=true; updateSpatialChatModuleState(); } if (playerData.personaPrompt !== newPersona) { playerData.personaPrompt=newPersona; localStorage.setItem(LS_KEYS.playerPersona, playerData.personaPrompt); detailsSaved=true; } if (temporaryAppearanceData) { playerData.appearance = JSON.parse(JSON.stringify(temporaryAppearanceData)); localStorage.setItem(LS_KEYS.playerAppearance, JSON.stringify(playerData.appearance)); styleSaved=true; } if (temporaryPfpData) { playerData.pfp = temporaryPfpData; localStorage.setItem(LS_KEYS.playerPfp, playerData.pfp); detailsSaved=true; } if (styleSaved || detailsSaved) addMessage(`Details${styleSaved?'/style':''}${temporaryPfpData?'/sigil':''} saved for Player.`, "SYSTEM", "system"); }
        else { const npc = npcData.find(n => n.id === appearanceEditorTarget); if (npc && currentCityKey) { const defaultNpcName = `Agent ${npc.id + 1}`; if (npc.name !== (newName || defaultNpcName)) { npc.name = newName || defaultNpcName; localStorage.setItem(LS_KEYS.npcName(currentCityKey, npc.id), npc.name); updateNameplate(npc); detailsSaved=true; updateSpatialChatModuleState(); } if (npc.personaPrompt !== newPersona) { npc.personaPrompt = newPersona; localStorage.setItem(LS_KEYS.npcPersona(currentCityKey, npc.id), newPersona); detailsSaved=true; updateSpatialChatModuleState(); } if (temporaryAppearanceData) { npc.appearance = JSON.parse(JSON.stringify(temporaryAppearanceData)); localStorage.setItem(LS_KEYS.npcAppearance(currentCityKey, npc.id), JSON.stringify(npc.appearance)); styleSaved=true; } if (temporaryPfpData) { npc.pfp = temporaryPfpData; localStorage.setItem(LS_KEYS.npcPfp(currentCityKey, npc.id), npc.pfp); detailsSaved=true; } if (styleSaved || detailsSaved) addMessage(`Details${styleSaved?'/style':''}${temporaryPfpData?'/sigil':''} saved for ${npc.name}.`, "SYSTEM", "system"); } else { console.error(`Failed to save appearance: NPC ${appearanceEditorTarget} not found or no city loaded.`); addMessage(`Error: Cannot find agent ${appearanceEditorTarget} to save details.`, "SYSTEM", "error"); } }
        closeAppearanceEditorModal();
    }
    function handlePfpUpload(event) {
         const f = event.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = (e) => { const u = e.target.result; temporaryPfpData = u; appearancePfpPreview.src = u; console.log("PFP Preview updated."); }; r.onerror = (e) => { console.error("FileReader err:", e); addMessage("Error reading sigil file.", "SYSTEM", "error"); temporaryPfpData = null; }; if (f.size > 2*1024*1024) { addMessage("Sigil file too large (max 2MB). Please choose a smaller image.", "SYSTEM", "error"); pfpUploadInput.value = ''; return; } r.readAsDataURL(f);
     }
    function showSettingsPage(pageNum) { currentSettingsPage = pageNum; const p = settingsBodyContainer.querySelectorAll('.settings-page'); p.forEach((pg, idx) => { pg.classList.toggle('active', (idx + 1) === pageNum); }); updatePaginationControls(); }
    function updatePaginationControls() { settingsPageIndicator.textContent=`Page ${currentSettingsPage} / ${TOTAL_SETTINGS_PAGES}`; settingsPrevBtn.disabled = currentSettingsPage === 1; settingsNextBtn.disabled = currentSettingsPage === TOTAL_SETTINGS_PAGES; }

    // --- Settings Modal Population (Unchanged) ---
    function populateSettingsModal(){ settingsBodyContainer.innerHTML = ''; for (let i=1; i<=TOTAL_SETTINGS_PAGES; i++) { const p=document.createElement('div'); p.className='settings-page'; p.id=`settings-page-${i}`; settingsBodyContainer.appendChild(p); } const p1 = document.getElementById('settings-page-1'); const p2 = document.getElementById('settings-page-2'); const p3 = document.getElementById('settings-page-3'); const p4 = document.getElementById('settings-page-4'); const citySec = document.createElement('div'); citySec.className = 'settings-section'; citySec.innerHTML = `<h3 class="settings-section-title">City Management</h3>`; const cityControlsDiv = document.createElement('div'); cityControlsDiv.className = 'settings-city-controls'; const cityLabel = document.createElement('label'); cityLabel.htmlFor = 'settingsCitySelector'; cityLabel.textContent = 'City:'; const citySelect = document.createElement('select'); citySelect.id = 'settingsCitySelector'; citySelect.className = 'settings-city-selector settings-select'; const addBtn = document.createElement('button'); addBtn.id = 'settingsAddCityBtn'; addBtn.className = 'settings-city-edit-btn settings-city-add-btn'; addBtn.title = 'Add New City'; addBtn.textContent = '+'; const delBtn = document.createElement('button'); delBtn.id = 'settingsDeleteCityBtn'; delBtn.className = 'settings-city-edit-btn settings-city-delete-btn'; delBtn.title = 'Delete Current City'; delBtn.textContent = '-'; cityControlsDiv.appendChild(cityLabel); cityControlsDiv.appendChild(citySelect); cityControlsDiv.appendChild(addBtn); cityControlsDiv.appendChild(delBtn); citySec.appendChild(cityControlsDiv); p1.appendChild(citySec); populateCitySelectorInModal(citySelect); citySelect.addEventListener('change', (event) => { const nk=event.target.value; if (nk && nk !== currentCityKey) { localStorage.setItem(LS_KEYS.selectedCity, nk); addMessage(`Switching to ${citySelect.options[citySelect.selectedIndex].text}. Reloading...`, "SYSTEM", "system"); savePlayerPosition(); saveNpcPositions(); closeSettingsModal(); setTimeout(() => window.location.reload(), 300); } }); addBtn.addEventListener('click', addCity); delBtn.addEventListener('click', deleteCity); delBtn.disabled = !currentCityKey || !currentCityKey.startsWith(USER_CITY_PREFIX); const mapSizeSec=document.createElement('div');mapSizeSec.className='settings-section';mapSizeSec.innerHTML=`<h3 class="settings-section-title">Map Dimensions</h3>`;const iDiv=document.createElement('div');iDiv.className='map-size-inputs';const wI=document.createElement('input');wI.type='number';wI.id='mapWidthInput';wI.value=MAP_WIDTH;wI.min=500;wI.step=100;const hI=document.createElement('input');hI.type='number';hI.id='mapHeightInput';hI.value=MAP_HEIGHT;hI.min=500;hI.step=100;const wL=document.createElement('label');wL.htmlFor='mapWidthInput';wL.textContent='Width:';const hL=document.createElement('label');hL.htmlFor='mapHeightInput';hL.textContent='Height:';iDiv.appendChild(wL);iDiv.appendChild(wI);iDiv.appendChild(hL);iDiv.appendChild(hI);mapSizeSec.appendChild(iDiv); p1.appendChild(mapSizeSec); const uiSec = document.createElement('div'); uiSec.className = 'settings-section'; uiSec.innerHTML = `<h3 class="settings-section-title">UI Settings</h3>`; const hDiv = document.createElement('div'); hDiv.className = 'settings-checkbox-item'; const hCb = document.createElement('input'); hCb.type = 'checkbox'; hCb.id = 'hideSystemMessagesCheckbox'; hCb.checked = hideSystemMessages; const hL2 = document.createElement('label'); hL2.htmlFor = 'hideSystemMessagesCheckbox'; hL2.textContent = 'Hide System/Debug/Error Messages'; hDiv.appendChild(hCb); hDiv.appendChild(hL2); uiSec.appendChild(hDiv); p1.appendChild(uiSec); const apiSec=document.createElement('div');apiSec.className='settings-section';apiSec.innerHTML=`<h3 class="settings-section-title">API Configuration</h3>`; const apiConfigDiv = document.createElement('div'); apiConfigDiv.className = 'settings-api-config'; const providerDiv = document.createElement('div'); providerDiv.innerHTML = `<label class="settings-label" for="apiProviderSelect">API Provider:</label>`; const providerSelect = document.createElement('select'); providerSelect.id = 'apiProviderSelect'; providerSelect.className = 'settings-select'; providerDiv.appendChild(providerSelect); apiConfigDiv.appendChild(providerDiv); const modelDiv = document.createElement('div'); modelDiv.innerHTML = `<label class="settings-label" for="apiModelSelect">Model:</label>`; const modelSelect = document.createElement('select'); modelSelect.id = 'apiModelSelect'; modelSelect.className = 'settings-select'; modelDiv.appendChild(modelSelect); apiConfigDiv.appendChild(modelDiv); apiSec.appendChild(apiConfigDiv); const apiKeyMgmtDiv = document.createElement('div'); apiKeyMgmtDiv.className = 'api-key-management'; apiKeyMgmtDiv.innerHTML = `<label class="settings-label">API Keys (for selected provider):</label>`; const apiKeyListContainer = document.createElement('div'); apiKeyListContainer.className = 'api-key-list-container'; apiKeyListContainer.id = 'apiKeyListDiv'; apiKeyMgmtDiv.appendChild(apiKeyListContainer); const apiKeyAddControls = document.createElement('div'); apiKeyAddControls.className = 'api-key-add-controls'; const newApiKeyInput = document.createElement('input'); newApiKeyInput.type = "password"; newApiKeyInput.id = 'newApiKeyInput'; newApiKeyInput.placeholder = 'Add API Key...'; const addApiKeyBtn = document.createElement('button'); addApiKeyBtn.textContent = 'Add Key'; addApiKeyBtn.id = 'addApiKeyBtn'; addApiKeyBtn.addEventListener('click', handleAddApiKey); apiKeyAddControls.appendChild(newApiKeyInput); apiKeyAddControls.appendChild(addApiKeyBtn); apiKeyMgmtDiv.appendChild(apiKeyAddControls); const activeKeyDisplay = document.createElement('div'); activeKeyDisplay.className = 'active-key-display'; activeKeyDisplay.id = 'activeApiKeyDisplay'; activeKeyDisplay.textContent = 'Next key to try: None'; apiKeyMgmtDiv.appendChild(activeKeyDisplay); apiSec.appendChild(apiKeyMgmtDiv); p2.appendChild(apiSec); if (typeof PROVIDERS !== 'undefined') { Object.keys(PROVIDERS).sort((a, b) => PROVIDERS[a].name.localeCompare(PROVIDERS[b].name)).forEach(key => { const option = document.createElement('option'); option.value = key; option.textContent = PROVIDERS[key].name; providerSelect.appendChild(option); }); providerSelect.value = selectedProvider || Object.keys(PROVIDERS)[0]; } else { const option = document.createElement('option'); option.textContent = "Error: Providers not loaded"; option.disabled = true; providerSelect.appendChild(option); console.error("PROVIDERS object is not defined when populating settings."); } const updateProviderSelectionUI = (providerKey) => { modelSelect.innerHTML = ''; const providerConfig = PROVIDERS[providerKey]; if (providerConfig && providerConfig.availableModels && providerConfig.availableModels.length > 0) { modelSelect.disabled = false; providerConfig.availableModels.forEach(model => { const option = document.createElement('option'); option.value = model; option.textContent = model; modelSelect.appendChild(option); }); const targetModel = (selectedProvider === providerKey && selectedModel && providerConfig.availableModels.includes(selectedModel)) ? selectedModel : (providerConfig.defaultModel || providerConfig.availableModels[0]); modelSelect.value = targetModel; if (selectedModel !== targetModel && selectedProvider === providerKey) { selectedModel = targetModel; localStorage.setItem(LS_KEYS.selectedModel, selectedModel); } } else { const option = document.createElement('option'); option.textContent = "N/A"; option.disabled = true; modelSelect.appendChild(option); modelSelect.disabled = true; if (selectedProvider === providerKey) selectedModel = null; } renderApiKeysForProvider(providerKey); }; providerSelect.addEventListener('change', () => { const newProviderKey = providerSelect.value; if (newProviderKey !== selectedProvider) { selectedProvider = newProviderKey; localStorage.setItem(LS_KEYS.selectedProvider, selectedProvider); } updateProviderSelectionUI(newProviderKey); }); modelSelect.addEventListener('change', () => { if (modelSelect.value !== selectedModel) { selectedModel = modelSelect.value; localStorage.setItem(LS_KEYS.selectedModel, selectedModel); } }); updateProviderSelectionUI(providerSelect.value); const npcSec=document.createElement('div');npcSec.className='settings-section';npcSec.innerHTML=`<h3 class="settings-section-title">Agents</h3>`;const npcGrid=document.createElement('div');npcGrid.className='settings-grid';npcData.forEach(n=>{const item=document.createElement('div');item.className='settings-item';item.dataset.npcId=n.id;item.innerHTML=`<button class="settings-delete-btn" data-npc-id="${n.id}" title="Delete ${n.name}">X</button> <label class="settings-label" for="npc-name-${n.id}">Name (${n.id+1}):</label><input type="text" id="npc-name-${n.id}" class="settings-input" data-field="npcName" value="${n.name}"> <label class="settings-label" for="npc-persona-${n.id}">Persona:</label><textarea id="npc-persona-${n.id}" class="settings-textarea" data-field="npcPersona">${n.personaPrompt}</textarea><p><small>Edit Appearance/Sigil/Follow via right-click.</small></p>`; npcGrid.appendChild(item);});npcSec.appendChild(npcGrid); p3.appendChild(npcSec); npcGrid.querySelectorAll('.settings-delete-btn').forEach(btn => { btn.addEventListener('click', handleDeleteNpcFromSettings); }); const envSec=document.createElement('div');envSec.className='settings-section';envSec.innerHTML=`<h3 class="settings-section-title">Environments</h3>`;environmentData.forEach((e, idx)=>{const item=document.createElement('div');item.className='settings-env-item';item.dataset.envId=e.id; item.innerHTML=`<label class="settings-env-label" for="env-name-${e.id}">Area ${idx + 1}:</label><input type="text" id="env-name-${e.id}" class="settings-input settings-env-input" data-field="envName" value="${e.name}"> <button class="settings-delete-btn" data-env-id="${e.id}" title="Delete ${e.name}">X</button>`; envSec.appendChild(item);}); p4.appendChild(envSec); envSec.querySelectorAll('.settings-delete-btn').forEach(btn => { btn.addEventListener('click', handleDeleteEnvFromSettings); }); if (!currentCityKey) { p1.querySelectorAll('input, textarea, button:not(#settingsAddCityBtn), select').forEach(el => { if (el.id !== 'hideSystemMessagesCheckbox' && !el.closest('.settings-city-controls')) el.disabled = true; }); p3.querySelectorAll('input, textarea, button').forEach(el => el.disabled = true); p3.querySelectorAll('.settings-delete-btn').forEach(btn => btn.style.display = 'none'); p4.querySelectorAll('input, textarea, button').forEach(el => el.disabled = true); p4.querySelectorAll('.settings-delete-btn').forEach(btn => btn.style.display = 'none'); if(citySelect) citySelect.disabled = false; } showSettingsPage(1); }
    // --- Save Settings (Unchanged) ---
     function saveSettings() { console.log("Saving settings..."); let changed = false, requiresReload = false, cityDefinition = null; const hideSysMsgCb = document.getElementById('hideSystemMessagesCheckbox'); if (hideSysMsgCb) { const shouldHide = hideSysMsgCb.checked; if (hideSystemMessages !== shouldHide) { hideSystemMessages = shouldHide; localStorage.setItem(LS_KEYS.hideSystemMessages, hideSystemMessages ? 'true' : 'false'); changed = true; addMessage(`System messages will now be ${hideSystemMessages ? 'hidden' : 'shown'}.`, "SYSTEM", "system"); } } if (currentCityKey) { const cityDataString = localStorage.getItem(currentCityKey); if (cityDataString) { try { cityDefinition = JSON.parse(cityDataString); } catch (e) { console.error("Parse cityDef fail", e); addMessage("Error: Corrupt city data. Cannot save map/agent/env changes.", "SYSTEM", "error"); cityDefinition = null; } } else { console.error("Save fail: city data missing:", currentCityKey); addMessage("Error: Cannot find city data for saving.", "SYSTEM", "error"); cityDefinition = null; } if(cityDefinition) { const widthInput = document.getElementById('mapWidthInput'); const heightInput = document.getElementById('mapHeightInput'); if (widthInput && heightInput && cityDefinition.map) { const newWidth = parseInt(widthInput.value, 10) || MAP_WIDTH; const newHeight = parseInt(heightInput.value, 10) || MAP_HEIGHT; if (cityDefinition.map.width !== newWidth || cityDefinition.map.height !== newHeight) { cityDefinition.map.width = newWidth; cityDefinition.map.height = newHeight; changed = true; requiresReload = true; addMessage(`Map size changed to ${newWidth}x${newHeight}. Reload needed to apply.`, 'SYSTEM', 'system'); } } document.querySelectorAll('#settings-page-3 .settings-item[data-npc-id]').forEach(item => { const id = parseInt(item.dataset.npcId, 10); const npc = npcData.find(n => n.id === id); if (!npc) return; const nameInput = item.querySelector('[data-field="npcName"]'); const personaInput = item.querySelector('[data-field="npcPersona"]'); const newName = nameInput ? (nameInput.value.trim() || `Agent ${id + 1}`) : npc.name; const newPersona = personaInput ? personaInput.value.trim() : npc.personaPrompt; if (npc.name !== newName) { npc.name = newName; localStorage.setItem(LS_KEYS.npcName(currentCityKey, id), newName); updateNameplate(npc); changed = true; updateSpatialChatModuleState(); } if (npc.personaPrompt !== newPersona) { npc.personaPrompt = newPersona; localStorage.setItem(LS_KEYS.npcPersona(currentCityKey, id), newPersona); changed = true; updateSpatialChatModuleState(); } }); document.querySelectorAll('#settings-page-4 .settings-env-item[data-env-id]').forEach(item => { const id = item.dataset.envId; const env = environmentData.find(e => e.id == id); if (!env) return; const nameInput = item.querySelector('[data-field="envName"]'); if (nameInput && env.name !== nameInput.value.trim()) { const envIndex = environmentData.findIndex(e => e.id == id); env.name = nameInput.value.trim() || `Area ${envIndex + 1}`; localStorage.setItem(LS_KEYS.envName(currentCityKey, id), env.name); if (env.nameElement) env.nameElement.textContent = env.name; changed = true; updateSpatialChatModuleState(); } }); if (changed || requiresReload) { localStorage.setItem(currentCityKey, JSON.stringify(cityDefinition)); console.log("Saved updated city definition."); } saveNpcPositions(); savePlayerPosition(); } } else if (!changed) { if(!changed) { addMessage("No changes detected.", "SYSTEM", "debug"); closeSettingsModal(); return; } } closeSettingsModal(); addMessage(changed ? "Settings saved." : "No changes made.", "SYSTEM", changed ? "system" : "debug"); if (requiresReload) { addMessage("Map changes require reload. Reloading...", "SYSTEM", "system"); setTimeout(() => window.location.reload(), 1000); } }

    function saveNpcPositions(){ if (!currentCityKey) return; npcData.forEach(n=>{localStorage.setItem(LS_KEYS.npcPositionX(currentCityKey, n.id), String(n.x)); localStorage.setItem(LS_KEYS.npcPositionY(currentCityKey, n.id), String(n.y));}); }
    function savePlayerPosition(){ if (!currentCityKey) return; localStorage.setItem(LS_KEYS.playerPositionX(currentCityKey), String(playerData.x)); localStorage.setItem(LS_KEYS.playerPositionY(currentCityKey), String(playerData.y)); }
    function addCity(){ const n=prompt("Enter new city name:","My City");if(!n||!n.trim())return;const cN=n.trim();const nK=USER_CITY_PREFIX+cN.replace(/\s+/g,'_')+'_'+Date.now();if(localStorage.getItem(nK)){alert("A city with a similar name might already exist.");return;} const dC={meta:{cityName:cN},map:{width:2000,height:1500},player:{startX:1000,startY:750},environments:[{id:"start_"+Date.now(),name:"Start Zone",x:800,y:600,width:400,height:300}],npcSpawns:[{spawnId:"agent1_"+Date.now(),x:900,y:700,defaultName:"Agent 1",defaultPersona:"You are Agent 1."}]};localStorage.setItem(nK,JSON.stringify(dC));localStorage.setItem(LS_KEYS.selectedCity,nK);addMessage(`Created new city: ${cN}. Reloading environment...`,"SYSTEM","system"); closeSettingsModal(); setTimeout(() => window.location.reload(), 300);}
    function deleteCity(){ if(!currentCityKey||!currentCityKey.startsWith(USER_CITY_PREFIX)){alert("Only user-created cities (marked with *) can be deleted. Please select one from the list.");return;}const s=document.getElementById('settingsCitySelector'); const cN=s?s.options[s.selectedIndex].text:currentCityKey; if(!confirm(`Are you absolutely sure you want to DELETE the city "${cN}"? This action is IRREVERSIBLE and will remove all associated data (agents, areas, positions, etc.).`))return;const nm=currentCityKey.substring(USER_CITY_PREFIX.length).split('_')[0];localStorage.removeItem(currentCityKey);Object.keys(localStorage).forEach(k=>{if(k.includes(`-${currentCityKey}-`))localStorage.removeItem(k);}); localStorage.removeItem(LS_KEYS.playerPositionX(currentCityKey)); localStorage.removeItem(LS_KEYS.playerPositionY(currentCityKey)); let nK=null;const rK=[]; Object.keys(localStorage).forEach(key=>{ if(key.startsWith(USER_CITY_PREFIX))rK.push(key); }); rK.sort(); nK=rK[0]||null; localStorage.setItem(LS_KEYS.selectedCity,nK||"");addMessage(`Deleted city: ${nm}. Reloading environment...`,"SYSTEM","system"); closeSettingsModal(); setTimeout(() => window.location.reload(), 300);}
    function modifyCurrentCityDefinition(cb){ if(!currentCityKey) return false; const s=localStorage.getItem(currentCityKey);if(!s){addMessage("Error: Current city data not found in storage.","SYSTEM","error");return false;}try{let cD=JSON.parse(s);cb(cD);localStorage.setItem(currentCityKey,JSON.stringify(cD));return true;}catch(e){addMessage("Error modifying city definition: "+e.message,"SYSTEM","error");console.error("Error modifying city definition:",e);return false;}}
    function addNpcAtPlayer(){ if (!currentCityKey||playerData.element.style.display==='none'){addMessage("Cannot add agent: No city loaded or player position unknown.", "SYSTEM", "error"); return;} const iN=prompt("Enter name for the new agent:","New Agent"); if (!iN||!iN.trim()) return; const ok=modifyCurrentCityDefinition(def=>{const id=`uNPC_${Date.now()}`; def.npcSpawns=def.npcSpawns||[]; def.npcSpawns.push({ spawnId: id, x: Math.round(playerData.x), y: Math.round(playerData.y), defaultName: iN.trim(), defaultPersona:`You are ${iN.trim()}.` }); }); if(ok){ addMessage(`Added definition for agent '${iN.trim()}'. Map reload needed to see the new agent.`,"SYSTEM","system"); savePlayerPosition(); saveNpcPositions(); closeSettingsModal(); if(confirm("Agent definition added. Reload map now?")) { setTimeout(() => window.location.reload(), 300); } else { addMessage("Remember to reload the map later to see the new agent.", "SYSTEM", "info"); if(settingsOverlay.classList.contains('active')) populateSettingsModal(); } } }
    function handleDeleteNpcFromSettings(event, npcIdToDelete = null) { if (!currentCityKey) { addMessage("Cannot remove agent: No city loaded.", "SYSTEM", "error"); return; } const id=npcIdToDelete !== null ? npcIdToDelete : parseInt(event?.target?.dataset?.npcId, 10); if (isNaN(id)) { console.error("Invalid NPC ID for deletion"); return; } const n=npcData.find(n => n.id === id); const nN=n?n.name:`Agent ${id+1}`; if (!confirm(`Remove agent "${nN}" (ID:${id}) from the city definition? This is irreversible.`)) return; let dM=false; const ok=modifyCurrentCityDefinition(def => { const iL=def.npcSpawns?.length||0; const sId=n?n.spawnId:null; if(sId){ def.npcSpawns=def.npcSpawns?.filter(s => s.spawnId !== sId)||[]; } else { console.warn("Cannot remove NPC definition reliably without a unique spawnId."); } dM=(def.npcSpawns?.length||0)<iL; }); if (ok&&dM) { localStorage.removeItem(LS_KEYS.npcName(currentCityKey,id)); localStorage.removeItem(LS_KEYS.npcPersona(currentCityKey,id)); localStorage.removeItem(LS_KEYS.npcAppearance(currentCityKey,id)); localStorage.removeItem(LS_KEYS.npcPfp(currentCityKey,id)); localStorage.removeItem(LS_KEYS.npcPositionX(currentCityKey,id)); localStorage.removeItem(LS_KEYS.npcPositionY(currentCityKey,id)); const iR=npcData.findIndex(n => n.id === id); if (iR > -1) { if(npcData[iR].element) { npcData[iR].element.remove(); } npcData.splice(iR, 1); addMessage(`Removed agent from session: ${nN}. Definition updated.`, "SYSTEM", "system"); } else { addMessage(`Removed definition for: ${nN}. Was not currently in session.`, "SYSTEM", "system"); } updateInputPlaceholder(); updateSpatialChatModuleState(); if(settingsOverlay.classList.contains('active')) populateSettingsModal(); } else { if(!ok) addMessage(`Failed to save definition changes while removing ${nN}.`, "SYSTEM", "error"); else if (!dM) addMessage(`Failed to remove ${nN}: Definition not found or couldn't be removed.`, "SYSTEM", "warn"); } }
    function addEnvAtPlayer(){ if (!currentCityKey||playerData.element.style.display==='none'){addMessage("Cannot add area: No city loaded or player position unknown.", "SYSTEM", "error"); return;} const n=prompt("Enter name for the new area:","My Area");if(!n||!n.trim())return;const w=parseInt(prompt("Enter width for the area:","300"),10)||300;const h=parseInt(prompt("Enter height for the area:","200"),10)||200;const ok=modifyCurrentCityDefinition(def=>{const id=`uEnv_${Date.now()}`;def.environments=def.environments||[];def.environments.push({id:id,name:n.trim(),x:Math.round(playerData.x-w/2),y:Math.round(playerData.y-h/2),width:w,height:h});}); if(ok){ addMessage(`Added area definition: '${n}'. Reload map to see the new area.`,"SYSTEM","system"); if(settingsOverlay.classList.contains('active')) populateSettingsModal(); if(confirm("Area definition added. Reload map now?")) { savePlayerPosition(); saveNpcPositions(); setTimeout(() => window.location.reload(), 300); } else { addMessage("Remember to reload the map later to see the new area.", "SYSTEM", "info"); } } else { addMessage("Failed to add area definition.", "SYSTEM", "error"); } }
    function findClosestEnvironmentZone() { let cZ=null; let mDS=Infinity; if(playerData.x===undefined||playerData.y===undefined||!currentCityKey||playerData.element.style.display==='none') return null; environmentData.forEach(z => { const zCX=z.x+z.width/2; const zCY=z.y+z.height/2; const dS=Math.pow(playerData.x-zCX,2)+Math.pow(playerData.y-zCY,2); if(dS<mDS){mDS=dS;cZ=z;} }); console.log("Closest Zone:", cZ?cZ.name:"None"); return cZ; }
    function handleDeleteEnvFromSettings(event, envIdToDelete = null) { if (!currentCityKey) { addMessage("Cannot remove area: No city loaded.", "SYSTEM", "error"); return; } const id=envIdToDelete !== null ? envIdToDelete : event?.target?.dataset?.envId; if (!id) { console.error("Invalid Environment ID for deletion"); return; } const e=environmentData.find(e => e.id === id); const eN=e?e.name:`Area ${id}`; const cM=`Remove area "${eN}" from the city definition? This is irreversible.`; if (!confirm(cM)) return; let dM=false; const ok=modifyCurrentCityDefinition(def => { const iL=def.environments?.length||0; def.environments=def.environments?.filter(e => e.id !== id)||[]; dM=(def.environments?.length||0)<iL; }); if (ok&&dM) { localStorage.removeItem(LS_KEYS.envName(currentCityKey,id)); const iR=environmentData.findIndex(e => e.id === id); if (iR > -1) { if(environmentData[iR].element){ environmentData[iR].element.remove(); } environmentData.splice(iR, 1); } addMessage(`Removed area definition: ${eN}.`, "SYSTEM", "system"); updateSpatialChatModuleState(); if(settingsOverlay.classList.contains('active')) populateSettingsModal(); } else { if (!ok) addMessage(`Failed to save definition changes while removing ${eN}.`, "SYSTEM", "error"); else if (!dM) addMessage(`Failed to remove ${eN}: Definition not found.`, "SYSTEM", "error"); } }

     // --- Spatial Chat Update Function (Unchanged) ---
     function updateSpatialChatModuleState() {
         // Ensure SpatialChat is loaded before calling its functions
         if (typeof SpatialChat === 'undefined' || !SpatialChat.updateState) {
             // console.warn("SpatialChat not ready for state update."); // Optional warning
             return;
         }
         if (!currentCityKey) {
             SpatialChat.updateState({ currentCity: null, currentArea: null }, [], {}, null);
             return;
         }

         const currentPlayerArea = findCurrentAreaName(playerData.x, playerData.y, environmentData);
         const currentPlayerState = {
             x: playerData.x, y: playerData.y, currentCity: currentCityKey,
             currentArea: currentPlayerArea, name: playerData.name
         };
         const currentNpcs = npcData.map(npc => ({
             id: npc.id, name: npc.name, x: npc.x, y: npc.y,
             personality: npc.personaPrompt || `You are ${npc.name}.`,
             currentCity: currentCityKey,
             currentArea: findCurrentAreaName(npc.x, npc.y, environmentData)
         }));
         const currentCities = {};
         if (currentCityKey) {
             currentCities[currentCityKey] = { /* areas: {} */ };
         }
         const currentDisplay = currentChatDisplayMode === 'spatial' ? currentSpatialScope : null;
         SpatialChat.updateState(currentPlayerState, currentNpcs, currentCities, currentDisplay);
    }

    // --- Tab Switching Logic (MODIFIED - Ensure it handles the correct scopes/IDs) ---
    function setActiveTab(clickedButton) {
         allChatTabs.forEach(btn => btn.classList.remove('active-tab'));
         clickedButton.classList.add('active-tab');

         const newMode = clickedButton.dataset.mode;
         const newScope = clickedButton.dataset.scope; // Only for spatial tabs ('Area', 'City', 'World', maybe 'Local' if you add it)

         const previousMode = currentChatDisplayMode;

         currentChatDisplayMode = newMode;
         localStorage.setItem(LS_KEYS.currentChatDisplayMode, currentChatDisplayMode);

         chatMessages.innerHTML = '';

         if (newMode === 'spatial') {
             // Default to 'Area' or your first spatial tab if scope is missing/invalid
             currentSpatialScope = newScope && ['Area', 'City', 'World'].includes(newScope) ? newScope : 'Area'; // Adjust valid scopes if needed
             console.log(`Switching to Spatial Mode, Scope: ${currentSpatialScope}`);
             if (typeof SpatialChat !== 'undefined' && SpatialChat.start) {
                 SpatialChat.start();
                 updateSpatialChatModuleState();
                 displaySpatialChat(currentSpatialScope);
             } else {
                console.warn("SpatialChat module not fully available for starting.");
             }
             clearInterval(spatialChatRenderIntervalId);
             spatialChatRenderIntervalId = setInterval(() => {
                 if (currentChatDisplayMode === 'spatial') { displaySpatialChat(currentSpatialScope); }
             }, 3000);
             currentAiNpcData = null;
             enableInput();

         } else { // Chat ('message') or Agent mode
             console.log(`Switching to ${newMode} Mode`);
             if (typeof SpatialChat !== 'undefined' && SpatialChat.stop) SpatialChat.stop();
             clearInterval(spatialChatRenderIntervalId);
             spatialChatRenderIntervalId = null;

             if (previousMode === 'spatial' || !currentAiNpcData) {
                currentAiNpcData = findClosestNpc(false) || initialSpeakerData;
                if(newMode === 'message' && !currentAiNpcData) { // Check for 'message' mode
                    currentAiNpcData = { name: "Spirit", personaPrompt: "You are a helpful, disembodied spirit.", pfp: DEFAULT_NPC_PFP };
                }
             }

             renderConversationHistory();
             enableInput(); // Re-enable based on whether API is waiting
             userInput.focus(); // Set focus for direct modes
         }

         updateInputPlaceholder();
    }

     // --- Display Spatial Chat Function (Unchanged) ---
    function displaySpatialChat(scope) {
         // Ensure SpatialChat is loaded
         if (typeof SpatialChat === 'undefined' || !SpatialChat.getMessagesForScope) {
            chatMessages.innerHTML = '<p style="color:red; text-align:center; padding: 20px;">Error: SpatialChat module not loaded or incomplete.</p>';
            return;
         }
         const playerArea = findCurrentAreaName(playerData.x, playerData.y, environmentData);
         const messages = SpatialChat.getMessagesForScope(scope, currentCityKey, playerArea);
         renderSpatialChatMessages(messages);
    }

    // --- Initialization (MODIFIED - Call SpatialChat.init correctly) ---
    function initializeSimulation(cityKey) {
        console.log(`Initializing simulation for city: ${cityKey}`);
        if(npcFollowInterval) clearInterval(npcFollowInterval);
        if(spatialChatUpdateIntervalId) clearInterval(spatialChatUpdateIntervalId);
        if(spatialChatRenderIntervalId) clearInterval(spatialChatRenderIntervalId);

         // Check required variables/modules are loaded
         if (typeof PROVIDERS === 'undefined' || typeof SpatialChat === 'undefined' || typeof marked === 'undefined') {
             const missing = [
                 (typeof PROVIDERS === 'undefined' ? "api_providers.js" : ""),
                 (typeof SpatialChat === 'undefined' ? "spatial_chat.js" : ""),
                 (typeof marked === 'undefined' ? "Marked library" : "")
             ].filter(Boolean).join(", ");
             document.body.innerHTML = `<div style="padding: 20px; font-family: Georgia, serif; color: #8b0000; background: #f5e7d0; border: 2px solid #3a3129;">FATAL ERROR: Script(s) failed to load: ${missing}. Check file paths and browser console.</div>`;
             console.error(`FATAL: Required script(s) not loaded: ${missing}`); return;
         }
         loadApiKeyManagement();
         loadConversationHistory();

         selectedProvider = localStorage.getItem(LS_KEYS.selectedProvider);
         if (!selectedProvider || !PROVIDERS[selectedProvider]) {
             selectedProvider = Object.keys(PROVIDERS)[0] || null;
             if(selectedProvider) localStorage.setItem(LS_KEYS.selectedProvider, selectedProvider);
         }
         const providerConfig = selectedProvider ? PROVIDERS[selectedProvider] : null;
         const savedModel = localStorage.getItem(LS_KEYS.selectedModel);
         if (providerConfig && providerConfig.availableModels && providerConfig.availableModels.includes(savedModel)) {
            selectedModel = savedModel;
         } else if (providerConfig && providerConfig.availableModels && providerConfig.availableModels.length > 0) {
            selectedModel = providerConfig.defaultModel || providerConfig.availableModels[0];
            localStorage.setItem(LS_KEYS.selectedModel, selectedModel);
         } else {
            selectedModel = null;
            localStorage.removeItem(LS_KEYS.selectedModel);
         }
         console.log(`API Initialized: Provider=${selectedProvider || 'None'}, Model=${selectedModel || 'None'}`);

        chatMessages.innerHTML=''; mapContent.innerHTML=''; mapContent.appendChild(playerElement);
        playerElement.style.display='block'; gameWorld.style.display='block';
        currentCityKey=cityKey;
        const cityDataString=localStorage.getItem(cityKey); let cityDefinition=null;
        if(cityDataString){try{cityDefinition=JSON.parse(cityDataString);}catch(e){console.error(`Failed to parse city data for "${cityKey}":`,e);}}
        if(!cityDefinition){ addMessage(`FATAL ERROR: Could not load or parse city data for key "${cityKey}". Cannot initialize simulation.`, "SYSTEM","error"); disableInput(); currentCityKey=null; return; }

        console.log(`Using city: ${cityDefinition.meta?.cityName||cityKey}`);
        MAP_WIDTH=cityDefinition.map?.width??2000; MAP_HEIGHT=cityDefinition.map?.height??1500;
        mapContent.style.width=`${MAP_WIDTH}px`; mapContent.style.height=`${MAP_HEIGHT}px`;

         // Default spatial scope depends on your first spatial tab
         currentSpatialScope = 'Area'; // Or 'Local' if that's your first one
         // Load saved mode or default
         currentChatDisplayMode = localStorage.getItem(LS_KEYS.currentChatDisplayMode) || 'agent';

        hideSystemMessages=localStorage.getItem(LS_KEYS.hideSystemMessages)==='true';
        recentEvents=[];

        const savedTabsVisibility = localStorage.getItem(LS_KEYS.chatTabsVisible);
        setChatTabsVisibility(savedTabsVisibility === null || savedTabsVisibility === 'true');
        const savedChatHeight=localStorage.getItem(LS_KEYS.chatAreaHeight);
        if(savedChatHeight){ chatArea.style.flexBasis=`${Math.max(parseInt(savedChatHeight,10),parseInt(getComputedStyle(document.documentElement).getPropertyValue('--chat-min-height'))||150)}px`; } else { chatArea.style.flexBasis = '300px'; }
        doChatResize();

        playerData.element=playerElement; playerData.speechElement=playerElement.querySelector('.speech'); playerData.nameplateElement=playerElement.querySelector('.character-name-plate');
        playerData.name=localStorage.getItem(LS_KEYS.playerName)||'Player'; playerData.personaPrompt=localStorage.getItem(LS_KEYS.playerPersona)||"You are the Player.";
        playerData.pfp=localStorage.getItem(LS_KEYS.playerPfp)||DEFAULT_PLAYER_PFP;
        const savedPlayerX=localStorage.getItem(LS_KEYS.playerPositionX(cityKey)); const savedPlayerY=localStorage.getItem(LS_KEYS.playerPositionY(cityKey));
        playerData.x=savedPlayerX!==null?parseFloat(savedPlayerX):(cityDefinition.player?.startX??MAP_WIDTH/2);
        playerData.y=savedPlayerY!==null?parseFloat(savedPlayerY):(cityDefinition.player?.startY??MAP_HEIGHT/2);
        playerData.width=playerElement.offsetWidth||24; playerData.height=playerElement.offsetHeight||36;
        playerData.isTalking=false; playerData.speechTimeout=null;
        const savedPlayerAppearance=localStorage.getItem(LS_KEYS.playerAppearance);
        if(savedPlayerAppearance){try{playerData.appearance=JSON.parse(savedPlayerAppearance);}catch(e){console.error("Player appearance parse error:",e);localStorage.removeItem(LS_KEYS.playerAppearance);playerData.appearance=JSON.parse(JSON.stringify(defaultPlayerAppearance));}} else {playerData.appearance=JSON.parse(JSON.stringify(defaultPlayerAppearance));}
        applyPlayerAppearance(playerData.appearance); updateNameplate(playerData); updateCharacterPosition(playerData);
        playerElement.removeEventListener('contextmenu', handlePlayerContextMenu); playerElement.addEventListener('contextmenu', handlePlayerContextMenu);

        environmentData.length=0; (cityDefinition.environments||[]).forEach((envDef,idx)=>{ const id=envDef.id||`env_${idx}_${Date.now()}`; const zoneElement=document.createElement('div'); zoneElement.className='environment-zone'; zoneElement.id=`env-${id}`; const nameElement=document.createElement('span'); nameElement.className='environment-name-plate'; const savedName=localStorage.getItem(LS_KEYS.envName(cityKey,id)); const currentName=savedName||envDef.name||`Area ${idx+1}`; nameElement.textContent=currentName; zoneElement.appendChild(nameElement); mapContent.appendChild(zoneElement); const envRuntimeData={ id:id, name: currentName, x:envDef.x, y:envDef.y, width:envDef.width, height:envDef.height, element:zoneElement, nameElement:nameElement }; environmentData.push(envRuntimeData); updateEnvironmentVisuals(envRuntimeData); if (savedName === null || savedName !== envRuntimeData.name) { localStorage.setItem(LS_KEYS.envName(cityKey,id),envRuntimeData.name); } }); console.log(`Created ${environmentData.length} environment zones.`);
        npcData.length=0; (cityDefinition.npcSpawns||[]).forEach((spawnDef,idx)=>{ const id=idx; const npcElement=document.createElement('div'); npcElement.className='character npc'; npcElement.id=`npc-${id}`; npcElement.dataset.npcId=id; npcElement.innerHTML=`<div class="part detail5"></div> <div class="part detail4"></div> <div class="part detail3"></div> <div class="part legs"></div> <div class="part arm-left"></div> <div class="part arm-right"></div> <div class="part torso"></div> <div class="part detail1"></div> <div class="part detail2"></div> <div class="part head"></div> <span class="character-name-plate"></span> <span class="speech"></span>`; mapContent.appendChild(npcElement); const namePlate=npcElement.querySelector('.character-name-plate'); const speechBubble=npcElement.querySelector('.speech'); const npcWidth=npcElement.offsetWidth||24; const npcHeight=npcElement.offsetHeight||36; const savedName=localStorage.getItem(LS_KEYS.npcName(cityKey,id)); const savedPersona=localStorage.getItem(LS_KEYS.npcPersona(cityKey,id)); const savedX=localStorage.getItem(LS_KEYS.npcPositionX(cityKey,id)); const savedY=localStorage.getItem(LS_KEYS.npcPositionY(cityKey,id)); const savedPfp=localStorage.getItem(LS_KEYS.npcPfp(cityKey,id)); const defaultName=spawnDef.defaultName||`Agent ${id+1}`; const npc={ id:id, element:npcElement, name:savedName||defaultName, speechElement:speechBubble, nameplateElement:namePlate, personaPrompt:savedPersona||spawnDef.defaultPersona||`You are ${savedName||defaultName}.`, width:npcWidth, height:npcHeight, x:savedX!==null?parseFloat(savedX):spawnDef.x, y:savedY!==null?parseFloat(savedY):spawnDef.y, isTalking:false, speechTimeout:null, appearance:null, pfp: savedPfp||DEFAULT_NPC_PFP, spawnId: spawnDef.spawnId, followingTargetId: null }; if (savedName===null&&npc.name!==defaultName) localStorage.setItem(LS_KEYS.npcName(cityKey,id),npc.name); if (savedPersona===null&&npc.personaPrompt!==(spawnDef.defaultPersona||`You are ${defaultName}.`)) localStorage.setItem(LS_KEYS.npcPersona(cityKey,id),npc.personaPrompt); const savedAppearance=localStorage.getItem(LS_KEYS.npcAppearance(cityKey,id)); if(savedAppearance){try{npc.appearance=JSON.parse(savedAppearance);}catch(e){console.error(`NPC ${id} appearance parse error:`,e);localStorage.removeItem(LS_KEYS.npcAppearance(cityKey,id));npc.appearance=JSON.parse(JSON.stringify(defaultNpcAppearance));}} else {npc.appearance=JSON.parse(JSON.stringify(defaultNpcAppearance));} npcData.push(npc); updateNameplate(npc); applyNpcAppearance(npc); updateCharacterPosition(npc); npcElement.removeEventListener('contextmenu', handleNpcContextMenu); npcElement.addEventListener('contextmenu', handleNpcContextMenu); }); console.log(`Created ${npcData.length} NPCs.`);

        viewportWidth=gameWorld.offsetWidth; viewportHeight=gameWorld.offsetHeight; updateCameraPosition(); initialSpeakerData=findClosestNpc(true);
        currentAiNpcData = null; // Let setActiveTab handle this

         // --- Initialize SpatialChat Module ---
         // This assumes SpatialChat is now globally available via spatial_chat.js
         const initialPlayerState = { x: playerData.x, y: playerData.y, currentCity: currentCityKey, currentArea: findCurrentAreaName(playerData.x, playerData.y, environmentData), name: playerData.name };
         const initialNpcs = npcData.map(npc => ({
             id: npc.id, name: npc.name, x: npc.x, y: npc.y,
             personality: npc.personaPrompt || `You are ${npc.name}.`,
             currentCity: currentCityKey,
             currentArea: findCurrentAreaName(npc.x, npc.y, environmentData)
         }));
         const initialCities = {};
         if (currentCityKey) {
             initialCities[currentCityKey] = { /* areas: {} */ };
         }
         // Initialize with appropriate config (e.g., debug setting)
         SpatialChat.init( { debugLogging: false }, { player: initialPlayerState, npcs: initialNpcs, cities: initialCities } );


         // --- Set Initial Tab ---
         const savedMode = localStorage.getItem(LS_KEYS.currentChatDisplayMode) || 'agent'; // Default to agent
         let initialTabSelector = `#chat-tabs-container button[data-mode="${savedMode}"]`;
         // If saved mode was 'spatial', default spatial view based on your first spatial tab's ID
         if (savedMode === 'spatial') {
             // *** IMPORTANT: Update this ID to match your first spatial tab (e.g., '#area-tab' or '#local-tab') ***
             initialTabSelector = '#area-tab';
         }
         let initialTabButton = document.querySelector(initialTabSelector);
         // Fallback: Try specific IDs, then first button
         if (!initialTabButton) {
            // *** IMPORTANT: Update these fallback IDs to match your actual tab IDs ***
            initialTabButton = document.getElementById('chat-tab') || document.getElementById('agent-tab') || document.getElementById('area-tab') || allChatTabs[0];
         }
         setActiveTab(initialTabButton);

        const welcomeMsg = `Welcome to ${cityDefinition.meta?.cityName||'the Simulation'}.`;
        const systemSpeakerName = "Tome";
        const providerNameForMsg = (providerConfig && providerConfig.name) ? providerConfig.name : (selectedProvider || 'None');
        addMessage(welcomeMsg, systemSpeakerName, 'system');
        addMessage(`API Provider: ${providerNameForMsg}. Model: ${selectedModel || 'N/A'}.`, systemSpeakerName, 'system');


        // Start intervals
        npcFollowInterval=setInterval(updateFollowingNpcs, 200);
        spatialChatUpdateIntervalId = setInterval(updateSpatialChatModuleState, 1000);

        console.log(`Initialization complete for: ${cityDefinition.meta?.cityName}. Initial Tab: ${currentChatDisplayMode}.`);
    }

    function populateCitySelectorInModal(selectElement){ if (!selectElement) return false; selectElement.innerHTML = ''; let uCE=false; const cK=[]; Object.keys(localStorage).forEach(key => { if (key.startsWith(USER_CITY_PREFIX)) { cK.push(key); uCE=true; } }); cK.sort(); if (!uCE) { const o=document.createElement('option'); o.value=""; o.textContent="No cities created"; o.disabled=true; selectElement.appendChild(o); } else { const dO=document.createElement('option'); dO.value=""; dO.textContent="-- Select a City --"; dO.disabled=!currentCityKey; selectElement.appendChild(dO); cK.forEach(key => { const o=document.createElement('option'); o.value=key; let dN=key.substring(USER_CITY_PREFIX.length).split('_')[0]; try{ const cd=JSON.parse(localStorage.getItem(key)); dN=cd?.meta?.cityName||dN; }catch(e){} o.textContent=`* ${dN}`; selectElement.appendChild(o); }); if(currentCityKey){ selectElement.value=currentCityKey; } else { selectElement.value=""; } } return uCE; }
    function enterNoCityState() {
        console.log("Entering No City state.");
        if(npcFollowInterval) clearInterval(npcFollowInterval);
        if(spatialChatUpdateIntervalId) clearInterval(spatialChatUpdateIntervalId);
        if(spatialChatRenderIntervalId) clearInterval(spatialChatRenderIntervalId);
        if (typeof SpatialChat !== 'undefined' && SpatialChat.stop) SpatialChat.stop(); // Ensure SpatialChat is stopped

        currentCityKey=null; chatMessages.innerHTML=''; mapContent.innerHTML=''; mapContent.appendChild(playerElement);
        playerElement.style.display='none'; playerData.x=undefined; playerData.y=undefined;
        npcData.length=0; environmentData.length=0;
        mapContent.style.width='100%'; mapContent.style.height='100%'; mapContent.style.transform='translate3d(0,0,0)';
        gameWorld.style.display='none';

        loadConversationHistory();

         if (typeof PROVIDERS !== 'undefined') {
             loadApiKeyManagement();
             selectedProvider = localStorage.getItem(LS_KEYS.selectedProvider);
             if (!selectedProvider || !PROVIDERS[selectedProvider]) {
                 selectedProvider = Object.keys(PROVIDERS)[0] || null; if(selectedProvider) localStorage.setItem(LS_KEYS.selectedProvider, selectedProvider);
             }
             const providerConfig = selectedProvider ? PROVIDERS[selectedProvider] : null;
             const savedModel = localStorage.getItem(LS_KEYS.selectedModel);
             if (providerConfig && providerConfig.availableModels && providerConfig.availableModels.includes(savedModel)) { selectedModel = savedModel; }
             else if (providerConfig && providerConfig.availableModels && providerConfig.availableModels.length > 0) { selectedModel = providerConfig.defaultModel || providerConfig.availableModels[0]; localStorage.setItem(LS_KEYS.selectedModel, selectedModel); }
             else { selectedModel = null; }
         } else { console.error("PROVIDERS object not defined during no-city state setup."); }
         hideSystemMessages=localStorage.getItem(LS_KEYS.hideSystemMessages)==='true';
         const savedTabsVisibility = localStorage.getItem(LS_KEYS.chatTabsVisible);
         setChatTabsVisibility(savedTabsVisibility === null || savedTabsVisibility === 'true');

         // Minimal SpatialChat init for no-city state
         if (typeof SpatialChat !== 'undefined' && SpatialChat.init) {
            SpatialChat.init({}, { player: { name: playerData.name || 'Player', currentCity: null }, npcs: [], cities: {} });
            SpatialChat.stop();
         }

        addMessage("Welcome! No cities created yet. Open Settings (click this sigil) to add your first city.", "SYSTEM", "system");

         // Default to Chat ('message') mode when no city exists
         currentChatDisplayMode = 'message';
         currentAiNpcData = { name: "Spirit", personaPrompt: "You are a helpful, disembodied spirit.", pfp: DEFAULT_NPC_PFP };
         // *** IMPORTANT: Update this ID to match your 'Chat' tab ID ***
         setActiveTab(document.getElementById('chat-tab'));

        chatTabsContainer.classList.add('hidden');
        openSettingsModal();
    }
    function doChatResize() { const chatHeight = chatArea.offsetHeight; const windowHeight = window.innerHeight; const isEffectivelyFullscreen = chatHeight >= (windowHeight - 10); gameWorld.style.display = isEffectivelyFullscreen ? 'none' : (currentCityKey ? 'block' : 'none'); if(!isEffectivelyFullscreen && currentCityKey){ updateCameraPosition(); } }
    function saveChatHeight() { const chatHeight = chatArea.offsetHeight; const windowHeight = window.innerHeight; if (chatHeight < (windowHeight - 10)) { localStorage.setItem(LS_KEYS.chatAreaHeight, chatHeight.toString()); console.log("Saved chat height:", chatHeight); } else { console.log("Chat is fullscreen, not saving height."); } }
    function toggleFullscreenChat() { const currentHeight = chatArea.offsetHeight; const windowHeight = window.innerHeight; const minChatHeight = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--chat-min-height')) || 150; const isFullscreen = currentHeight >= (windowHeight - 10); if (isFullscreen) { const savedHeight = chatHeightBeforeFullscreen || localStorage.getItem(LS_KEYS.chatAreaHeight); let restoreHeightPx = parseInt(savedHeight, 10); if (isNaN(restoreHeightPx) || restoreHeightPx < minChatHeight || restoreHeightPx >= (windowHeight - 10)) { restoreHeightPx = 300; } chatArea.style.flexBasis = `${restoreHeightPx}px`; console.log("Exiting fullscreen, restored height:", restoreHeightPx); localStorage.setItem(LS_KEYS.chatAreaHeight, `${restoreHeightPx}`); chatHeightBeforeFullscreen = null; setTimeout(() => { chatMessages.scrollTop = chatMessages.scrollHeight; }, 350); } else { chatHeightBeforeFullscreen = `${currentHeight}px`; chatArea.style.flexBasis = '100vh'; console.log("Entering fullscreen, stored height:", chatHeightBeforeFullscreen); setTimeout(() => { chatMessages.scrollTop = chatMessages.scrollHeight; }, 50); } setTimeout(doChatResize, 50); }

    // --- Event Listeners (MODIFIED for Context Menu & Tab IDs) ---
    document.addEventListener('keydown',(e)=>{ if(settingsOverlay.classList.contains('active')||appearanceEditorOverlay.classList.contains('active')||document.activeElement===userInput||!currentCityKey) return; let m=false; switch(e.key.toLowerCase()){case'arrowup':case'w':movePlayer(0,-1);m=true;break;case'arrowdown':case's':movePlayer(0,1);m=true;break;case'arrowleft':case'a':movePlayer(-1,0);m=true;break;case'arrowright':case'd':movePlayer(1,0);m=true;break;}if(m)e.preventDefault();});
    userInput.addEventListener('keypress',(e)=>{if(e.key==='Enter'&&!sendButton.disabled&&!e.shiftKey){e.preventDefault();handlePlayerSend();}});
    userInput.addEventListener('input',()=>{userInput.style.height='auto';userInput.style.height=(userInput.scrollHeight)+'px';});
    sendButton.addEventListener('click',()=>{if(!sendButton.disabled)handlePlayerSend();});
    modalCloseBtn.addEventListener('click',closeSettingsModal); modalCancelBtn.addEventListener('click',closeSettingsModal); modalSaveBtn.addEventListener('click',saveSettings);
    settingsOverlay.addEventListener('click',(e)=>{if(e.target===settingsOverlay)closeSettingsModal();});
    settingsPrevBtn.addEventListener('click',()=>{if(currentSettingsPage>1)showSettingsPage(currentSettingsPage-1);}); settingsNextBtn.addEventListener('click',()=>{if(currentSettingsPage<TOTAL_SETTINGS_PAGES)showSettingsPage(currentSettingsPage+1);});
    appearanceEditorCloseBtn.addEventListener('click', closeAppearanceEditorModal); appearanceEditorCancelBtn.addEventListener('click', closeAppearanceEditorModal); appearanceEditorSaveBtn.addEventListener('click', saveAppearanceFromEditor);
    appearanceEditorOverlay.addEventListener('click',(e)=>{if(e.target===appearanceEditorOverlay)closeAppearanceEditorModal();});
    appearancePfpPreview.addEventListener('click',()=>pfpUploadInput.click()); appearancePfpChangeBtn.addEventListener('click',()=>pfpUploadInput.click());
    pfpUploadInput.addEventListener('change', handlePfpUpload);
    window.addEventListener('resize',()=>{if(currentCityKey){viewportWidth=gameWorld.offsetWidth;viewportHeight=gameWorld.offsetHeight;doChatResize();updateInputPlaceholder();}});

    // MODIFIED Context Menu Listener (Uses new 'chat-tab' ID)
    npcContextMenu.addEventListener('click', (e) => {
         if (e.target.classList.contains('context-menu-item')) {
             const action = e.target.dataset.action;
             const targetNpc = npcData.find(n => n.id === contextMenuTargetNpcId);

             if (!targetNpc) {
                 console.error(`NPC ${contextMenuTargetNpcId} not found.`);
                 closeAllContextMenus(); return;
             }
             console.log(`Action: ${action} on ${targetNpc.name} (ID: ${targetNpc.id})`);

             switch (action) {
                 case 'talk': // Switch to CHAT ('message') mode
                     currentAiNpcData = targetNpc;
                     // *** IMPORTANT: Update this ID to match your 'Chat' tab ID ***
                     setActiveTab(document.getElementById('chat-tab'));
                     addMessage(`Switched to Chat Mode with ${targetNpc.name}.`, 'SYSTEM', 'system');
                     break;
                 case 'command': // Switch to AGENT mode
                     currentAiNpcData = targetNpc;
                     // *** IMPORTANT: Update this ID to match your 'Agent' tab ID ***
                     setActiveTab(document.getElementById('agent-tab'));
                     addMessage(`Switched to Agent Mode with ${targetNpc.name}.`, 'SYSTEM', 'system');
                     break;
                 case 'toggleFollow':
                     if (targetNpc.followingTargetId !== null) {
                         handleUnfollowAction(targetNpc);
                     } else {
                         handleFollowAction(targetNpc);
                     }
                     break;
                 case 'appearance':
                     openAppearanceEditorModal(targetNpc.id);
                     break;
                 case 'cancel':
                     break;
             }
             closeAllContextMenus();
         }
     });

    playerContextMenu.addEventListener('click',(e)=>{ if(e.target.classList.contains('context-menu-item')){const a=e.target.dataset.action; console.log(`Action: ${a} on Player`); switch(a){case 'appearance': openAppearanceEditorModal('player'); break; case 'add_area': addEnvAtPlayer(); break; case 'add_agent': addNpcAtPlayer(); break; case 'remove_closest_agent': const cN=findClosestNpc(false); if(cN){handleDeleteNpcFromSettings(null,cN.id);} else {addMessage("No agent nearby to remove.","SYSTEM","system");} break; case 'remove_closest_area': const cZ=findClosestEnvironmentZone(); if(cZ){handleDeleteEnvFromSettings(null,cZ.id);} else {addMessage("No area nearby to remove.","SYSTEM","system");} break; case 'cancel': break;} closeAllContextMenus(); }});
    pfpContextMenu.addEventListener('click', (e) => { if (e.target.classList.contains('context-menu-item')) { const action = e.target.dataset.action; switch(action) { case 'toggle-tabs': toggleChatTabsVisibility(); break; case 'toggle-fullscreen': toggleFullscreenChat(); break; case 'cancel': break; } closeAllContextMenus(); } });
    allChatTabs.forEach(tab => { tab.addEventListener('click', () => setActiveTab(tab)); });
    window.addEventListener('beforeunload',(e)=>{ if(currentCityKey){saveNpcPositions();savePlayerPosition(); saveChatHeight();} if(npcFollowInterval) clearInterval(npcFollowInterval); if(spatialChatUpdateIntervalId) clearInterval(spatialChatUpdateIntervalId); if(spatialChatRenderIntervalId) clearInterval(spatialChatRenderIntervalId); if (typeof SpatialChat !== 'undefined' && SpatialChat.stop) SpatialChat.stop(); localStorage.setItem(LS_KEYS.currentChatDisplayMode, currentChatDisplayMode); saveConversationHistory(); });
    window.addEventListener('message', receiveCreatorData);
    function receiveCreatorData(event) { if(event.data?.type==='CHARACTER_STYLE_UPDATE'){const rS=event.data.payload;if(typeof rS==='object'&&rS!==null&&rS.colors){temporaryAppearanceData=JSON.parse(JSON.stringify(rS));if(appearanceEditorTarget==='player'){applyAppearanceToElement(playerData.element,rS);}else if(appearanceEditorTarget!==null){const tN=npcData.find(n=>n.id===appearanceEditorTarget);if(tN){applyAppearanceToElement(tN.element,rS);}else{console.error(`Target NPC ${appearanceEditorTarget} not found for style update!`);}}else{console.warn("Received style update from creator, but no target is set.");}}else{console.warn("Received invalid style data from creator:", rS);}}}

    // --- Initial Execution ---
    let cityKeyToLoad=localStorage.getItem(LS_KEYS.selectedCity); if(!cityKeyToLoad||!cityKeyToLoad.startsWith(USER_CITY_PREFIX)||!localStorage.getItem(cityKeyToLoad)){ const userCityKeys=[]; Object.keys(localStorage).forEach(key => { if (key.startsWith(USER_CITY_PREFIX)) userCityKeys.push(key); }); userCityKeys.sort(); cityKeyToLoad=userCityKeys[0]||null; if(cityKeyToLoad){ localStorage.setItem(LS_KEYS.selectedCity, cityKeyToLoad); } }
    if (cityKeyToLoad) {
        initializeSimulation(cityKeyToLoad);
    } else {
        enterNoCityState();
    }

} // End runSimulation

// Add the DOMContentLoaded listener to ensure the simulation runs after the DOM is ready
document.addEventListener('DOMContentLoaded', runSimulation);

// ------------ End of ai-world.js ------------
```

**2. Modify your main HTML file (e.g., `index.html`):**

Take your original HTML file and make the following changes:

*   **Remove** the entire first `<script>` block that *contained* the embedded `SpatialChat` code (lines 701 to 936).
*   **Remove** the entire *content* of the second `<script>` block (lines 940 to 1846). Keep the opening and closing `<script>` tags (lines 939 and 1847).
*   Add `<script>` tags near the *end* of the `<body>` to load the necessary JavaScript files *in the correct order*.

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Agent Sim - Arcane Tome UI</title>
    <!-- External Libraries/Fonts -->
    <!-- Load Marked library EARLY -->
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Cinzel+Decorative:wght@400;700&family=Georgia&family=Uncial+Antiqua&display=swap" rel="stylesheet">

    <style>
        /* --- Base Styles & Variables --- */
        :root {
            --parchment: #f5e7d0; --parchment-dark: #e3d5b8; --ink: #3a3129;
            --ink-light: #5a4e42; --gold: #c9a227; --crimson: #8b0000;
            --sapphire: #1e3a8a; --amethyst: #6b21a8; --shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
            --glow: 0 0 10px rgba(201, 162, 39, 0.7); --fade: all 0.5s ease;
            --skin-tone: #fbe5d6; --default-outline: #222; --swatch-size: 20px;
            --danger-color: var(--crimson); --danger-hover: #6b0000;
            --modal-scrollbar-track: var(--parchment-dark); --modal-scrollbar-thumb: var(--ink-light);
            --modal-scrollbar-thumb-hover: var(--ink); --chat-min-height: 150px;
            --tibia-like-font: 'Uncial Antiqua', cursive;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { height: 100%; width: 100%; overflow: hidden; background-color: var(--parchment); font-family: Georgia, 'Times New Roman', Times, serif; font-size: 1.1rem; line-height: 1.6; color: var(--ink); }
        #ui-container { display: flex; flex-direction: column; width: 100vw; height: 100vh; background-color: transparent; box-sizing: border-box; position: relative; }
        #ui-container::before { content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: url('https://www.transparenttextures.com/patterns/old-map.png'); opacity: 0.15; pointer-events: none; z-index: -1; }

        /* --- Game World & Map --- */
        #game-world { flex-grow: 1; background-color: #333; position: relative; overflow: hidden; image-rendering: pixelated; image-rendering: crisp-edges; min-height: 0; }
        #map-content { position: absolute; top: 0; left: 0; width: 3000px; height: 2000px; background-color: #4a7c2d; background-image: linear-gradient(45deg, rgba(0,0,0,0.04) 25%, transparent 25%, transparent 75%, rgba(0,0,0,0.04) 75%, rgba(0,0,0,0.04)), linear-gradient(45deg, rgba(0,0,0,0.04) 25%, transparent 25%, transparent 75%, rgba(0,0,0,0.04) 75%, rgba(0,0,0,0.04)); background-size: 12px 12px; background-position: 0 0, 6px 6px; transform: translate3d(0, 0, 0); transition: transform 0.3s linear; }

        /* --- Character Styling --- */
        .character { width: 24px; height: 36px; position: absolute; cursor: pointer; z-index: 5; background-color: transparent; border: none; margin-top: 0; transition: top 0.2s linear, left 0.2s linear, opacity 0.5s ease; transform-origin: center bottom; }
        #player { z-index: 6; }
        .character .part { position: absolute; box-sizing: border-box; transition: background-color 0.1s ease, border-color 0.1s ease; display: none; background-color: transparent; image-rendering: pixelated; image-rendering: crisp-edges; }
        .character .part.head, .character .part.torso, .character .part.legs, .character .part.arm-left, .character .part.arm-right, .character .part.detail1 { border: 1px solid var(--default-outline); }
        .character .part.head { z-index: 10; background-color: var(--skin-tone); } .character .part.torso { z-index: 5; } .character .part.legs { z-index: 4; }
        .character .part.arm-left { z-index: 6; transform-origin: 2px 1px; } .character .part.arm-right { z-index: 6; transform-origin: 1px 1px; }
        .character .part.detail1 { z-index: 7; } .character .part.detail2 { z-index: 11; } .character .part.detail3 { z-index: 3; }
        .character .part.detail4 { z-index: 12; border: none; } .character .part.detail5 { z-index: 12; border: none; }
        /* ... All other CSS rules (lines 39 to 574) remain here ... */
        .api-key-item span { max-width: 60%; }
        }
    </style>
</head>
<body>
    <!-- Your Original HTML Structure -->
    <div id="ui-container">
        <div id="game-world">
            <div id="map-content">
                 <div class="character" id="player" data-name="Player">
                    <div class="part detail5"></div> <div class="part detail4"></div>
                    <div class="part detail3"></div> <div class="part legs"></div>
                    <div class="part arm-left"></div> <div class="part arm-right"></div>
                    <div class="part torso"></div> <div class="part detail1"></div>
                    <div class="part detail2"></div> <div class="part head"></div>
                    <span class="character-name-plate">Player</span>
                    <span class="speech"></span>
                </div>
                 <!-- NPCs added by JS -->
            </div>
        </div>
        <div id="chat-area">
             <!-- Chat Tabs Container (Make sure IDs match ai-world.js expectations) -->
             <div id="chat-tabs-container">
                 <!-- *** Example Tabs - Make sure these match your desired setup *** -->
                 <button id="chat-tab" data-mode="message">CHAT</button> <!-- Example Chat Tab -->
                 <button id="area-tab" data-mode="spatial" data-scope="Area">AREA</button> <!-- Example Spatial Tab 1 -->
                 <button id="city-tab" data-mode="spatial" data-scope="City">CITY</button> <!-- Example Spatial Tab 2 -->
                 <button id="world-tab" data-mode="spatial" data-scope="World">WORLD</button> <!-- Example Spatial Tab 3 -->
                 <button id="agent-tab" data-mode="agent">AGENT</button> <!-- Example Agent Tab -->
             </div>
             <div class="chat-messages" id="chatMessages"></div>
             <div class="input-container">
                <textarea class="message-input" id="userInput" placeholder="Consult the spirit..." rows="1"></textarea>
                 <button class="send-button" id="sendButton" title="Send Message"><span>Send</span><span style="font-size: 1.2em;">→</span></button>
            </div>
        </div>
    </div>

    <!-- Settings Modal -->
    <div class="modal-overlay" id="settings-overlay">
        <div class="modal-content">
            <div class="modal-header">
                <h3 class="modal-title">Tome Configuration</h3>
                <button class="modal-close-btn" id="modal-close-btn">×</button>
             </div>
            <div class="modal-body" id="settings-body-container">
                <!-- Pages populated by JS -->
            </div>
             <div class="settings-pagination" id="settings-pagination-controls">
                 <button class="pagination-btn" id="settings-prev-btn">« Previous</button>
                 <span class="page-indicator" id="settings-page-indicator">Page 1 / 4</span>
                 <button class="pagination-btn" id="settings-next-btn">Next »</button>
             </div>
            <div class="modal-footer">
                <button class="modal-btn modal-btn-secondary" id="modal-cancel-btn">Cancel</button>
                <button class="modal-btn modal-btn-primary" id="modal-save-btn">Save Changes</button>
            </div>
        </div>
    </div>

    <!-- Appearance Editor Modal -->
     <div class="modal-overlay" id="appearance-editor-overlay">
         <div class="modal-content">
             <div class="modal-header">
                 <h3 class="modal-title" id="appearance-editor-title">Set Appearance & Details</h3>
                 <button class="modal-close-btn" id="appearance-editor-close-btn">×</button>
             </div>
             <div class="modal-body">
                 <div class="appearance-editor-details">
                     <label for="appearance-editor-name">Name:</label>
                     <input type="text" id="appearance-editor-name" class="settings-input">
                     <label for="appearance-editor-persona">Persona:</label>
                     <textarea id="appearance-editor-persona" class="settings-textarea"></textarea>
                     <label>Sigil:</label>
                     <div class="appearance-pfp-section">
                         <img src="" alt="Sigil Preview" class="appearance-pfp-preview" id="appearance-pfp-preview" title="Click to change sigil">
                         <button class="appearance-pfp-change-btn" id="appearance-pfp-change-btn">Change Sigil</button>
                     </div>
                 </div>
                 <div class="appearance-iframe-container">
                      <!-- Ensure this path is correct relative to index.html -->
                     <iframe id="characterCreatorFrame" src="character_creator.html"></iframe>
                 </div>
             </div>
             <div class="modal-footer">
                 <button class="modal-btn modal-btn-secondary" id="appearance-editor-cancel-btn">Cancel</button>
                 <button class="modal-btn modal-btn-primary" id="appearance-editor-save-btn">Save Appearance & Details</button>
             </div>
         </div>
     </div>

    <!-- Context Menus -->
    <div id="npc-context-menu" class="context-menu" style="display: none;">
        <!-- *** Make sure data-action attributes match ai-world.js expectations *** -->
        <div class="context-menu-item" data-action="talk">Talk (Chat Mode)</div>
        <div class="context-menu-item" data-action="command">Command (Agent Mode)</div>
        <div class="context-menu-item" data-action="toggleFollow">Toggle Follow/Unfollow</div>
        <div class="context-menu-item" data-action="appearance">Set Appearance, Details & Sigil</div>
        <hr class="context-menu-divider">
        <div class="context-menu-item" data-action="cancel">Cancel</div>
    </div>
    <div id="player-context-menu" class="context-menu" style="display: none;">
        <div class="context-menu-item" data-action="appearance">Set Appearance, Details & Sigil</div> <hr class="context-menu-divider">
        <div class="context-menu-item" data-action="add_area">Add Area Here</div> <div class="context-menu-item" data-action="add_agent">Add Agent Here</div> <hr class="context-menu-divider">
        <div class="context-menu-item" data-action="remove_closest_agent">Remove Closest Agent</div> <div class="context-menu-item" data-action="remove_closest_area">Remove Closest Area</div> <hr class="context-menu-divider">
        <div class="context-menu-item" data-action="cancel">Cancel</div>
    </div>
    <div id="pfp-context-menu" class="context-menu" style="display: none;">
        <div class="context-menu-item" data-action="toggle-tabs">Show/Hide Chat Tabs</div>
        <div class="context-menu-item" data-action="toggle-fullscreen">Toggle Fullscreen Chat</div>
        <hr class="context-menu-divider">
        <div class="context-menu-item" data-action="cancel">Cancel</div>
    </div>

    <input type="file" class="pfp-upload" id="pfp-upload" accept="image/*">

    <!-- Load Scripts - ORDER MATTERS! -->
    <!-- Assumes api_providers.js defines the PROVIDERS object and window.getApiResponse -->
    <script src="api_providers.js"></script>
    <!-- Assumes spatial_chat.js defines the SpatialChat object -->
    <script src="spatial_chat.js"></script>
    <!-- Loads the main simulation logic which depends on the above -->
    <script src="ai-world.js"></script>

</body>
</html>

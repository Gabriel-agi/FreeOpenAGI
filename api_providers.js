// api_providers.js

// Define known providers and their configurations
const PROVIDERS = {
    // --- BigModel Proxy (Unchanged from your last version) ---
    BIGMODEL_PROXY: {
        name: "BigModel (via Proxy)",
        format: "proxy_compatible",
        baseURL: "/api/proxy",
        availableModels: ["glm-4.5-flash"],
        defaultModel: "glm-4.5-flash",
        apiKeyLocation: "none",
        supportsSystemPromptInMessages: true,
        supportsImages: false, // Explicitly mark as not supporting images via proxy
    },
    // --- SambaNova (Unchanged) ---
    SAMBANOVA: {
        name: "SambaNova",
        format: "openai_compatible",
        baseURL: "https://api.sambanova.ai/v1/chat/completions",
        availableModels: ["DeepSeek-V3-0324"],
        defaultModel: "DeepSeek-V3-0324",
        apiKeyLocation: "header",
        authHeaderPrefix: "Bearer ",
        supportsSystemPromptInMessages: true,
        supportsImages: false, // Assume no image support
    },
    // --- GEMINI (MODIFIED to support images without changing models) ---
    GEMINI: {
        name: "Gemini",
        format: "gemini_generateContent",
        baseURL: "https://generativelanguage.googleapis.com/v1beta/models/",
        // --- NO CHANGE TO MODELS ---
        availableModels: ["gemini-2.5-pro-exp-03-25"],
        defaultModel: "gemini-2.5-pro-exp-03-25",
        // --- END NO CHANGE ---
        apiKeyLocation: "query",
        apiKeyQueryParam: "key",
        supportsSystemPromptInMessages: false,
        systemInstructionKey: "system_instruction",
        supportsImages: true, // *** ADDED: Mark as supporting images ***
    },
    // --- DeepSeek (Unchanged) ---
    DEEPSEEK: {
        name: "DeepSeek",
        format: "openai_compatible",
        baseURL: "https://api.deepseek.com/v1/chat/completions",
        availableModels: ["deepseek-chat", "deepseek-reasoner"],
        defaultModel: "deepseek-chat",
        apiKeyLocation: "header",
        authHeaderPrefix: "Bearer ",
        supportsSystemPromptInMessages: true,
        supportsImages: false, // Assume no image support
    },
    // --- Qwen (Unchanged from your last version) ---
    QWEN: {
        name: "Model Studio", // Renamed back from "Model Studio (Qwen)"? Kept your last version's name.
        format: "openai_compatible",
        baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
        availableModels: ["qwen-max"], // Kept as per your original list for this provider
        defaultModel: "qwen-max",
        apiKeyLocation: "header",
        authHeaderPrefix: "Bearer ",
        supportsSystemPromptInMessages: true,
        supportsImages: false, // Assume no image support unless Qwen API changes
    },
    // OPENAI: { /* ... */ },
};


// --- Helper: Transform History & Extract System Prompt (for Gemini) ---
// *** MODIFIED to handle images in user messages if present ***
function transformHistoryForGemini(conversationHistory) {
    const contents = [];
    let systemInstruction = null;

    // Extract system prompt if present
    if (conversationHistory.length > 0 && conversationHistory[0].role === 'system') {
        systemInstruction = conversationHistory[0].content;
        // Optional: Limit logging length if needed
        // console.log("[API Provider] Found system instruction for Gemini:", systemInstruction ? systemInstruction.substring(0, 50) + "..." : "None");
    }

    // Process the rest of the history
    const historyToProcess = conversationHistory.slice(systemInstruction ? 1 : 0);

    historyToProcess.forEach(msg => {
        if (!msg || !msg.role) {
            console.warn("[API Provider] Skipping invalid message in history:", msg);
            return;
        }

        let role = msg.role === 'assistant' ? 'model' : msg.role; // Gemini uses 'model' for assistant
        let parts = [];

        // --- IMAGE HANDLING ---
        // Check specifically for USER messages and the presence of an 'images' array
        if (msg.role === 'user') {
            // Add text part first, only if it's a non-empty string
            if (msg.content && typeof msg.content === 'string' && msg.content.trim() !== '') {
                parts.push({ text: msg.content });
            }

            // Add image parts if the 'images' array exists and has valid entries
            if (Array.isArray(msg.images) && msg.images.length > 0) {
                msg.images.forEach(img => {
                    // Ensure the image object has the required fields
                    if (img && img.mimeType && img.data) {
                        parts.push({
                            inlineData: {
                                mimeType: img.mimeType,
                                data: img.data // Expecting BASE64 data *without* the prefix
                            }
                        });
                    } else {
                         console.warn("[API Provider] Skipping invalid image data found in user message:", img);
                    }
                });
                // Optional logging
                 console.log(`[API Provider] Added ${parts.length - (parts[0]?.text ? 1:0)} images to parts for user message.`);
            }
            // If only text was present, 'parts' will just contain the text part.
            // If only image(s) were present, 'parts' will just contain image part(s).
            // If both were present, 'parts' will contain text then image(s).

        } else if (msg.role === 'assistant') {
             // Assistant messages are expected to only contain text from the API response
             const assistantContent = msg.content || msg.variants?.[msg.selectedIndex ?? 0];
             if (assistantContent && typeof assistantContent === 'string') {
                 // Even empty strings from assistant are valid text parts
                 parts.push({ text: assistantContent });
             }
        }
        // --- END IMAGE HANDLING ---

        // Only add the message to contents if it resulted in at least one valid part
        if (parts.length > 0) {
            contents.push({ role: role, parts: parts });
        } else {
            // This might happen if a user message had neither text nor valid images,
            // or an assistant message had no content.
            console.warn(`[API Provider] Skipping message with no valid parts generated (role: ${msg.role}):`, msg);
        }
    });

    // Gemini specific check: last message shouldn't be 'model' if we expect a response
    if (contents.length > 0 && contents[contents.length - 1].role === 'model') {
        console.warn("[API Provider] Gemini history transformation ended with 'model'. This might prevent the API from responding if it was the last message before a user query.");
    }

    return { contents, systemInstruction };
}


// --- Core API Call Function ---
// *** MODIFIED to check provider image support before sending ***
async function getApiResponse(providerName, modelName, conversationHistory, apiKey, options = {}) {
    console.log(`[API Provider] Requesting completion from ${providerName} using model ${modelName}.`);
    const providerConfig = PROVIDERS[providerName];

    if (!providerConfig) throw new Error(`Configuration for provider "${providerName}" not found.`);

    // Check API Key requirement (excluding proxy)
    const requiresApiKey = providerConfig.format !== 'proxy_compatible' && providerConfig.apiKeyLocation !== 'none';
    if (requiresApiKey && !apiKey) {
        throw new Error(`API Key is missing for provider "${providerName}".`);
    }

    // *** ADDED: Check for images + provider support ***
    // Check if any message in the *original* history contains images
    const historyHasImages = conversationHistory.some(msg => msg.role === 'user' && Array.isArray(msg.images) && msg.images.length > 0);
    if (historyHasImages && !providerConfig.supportsImages) {
        // If images are present but the provider doesn't support them, throw an error immediately.
        console.error(`[API Provider] Attempted to send images to provider "${providerName}" which does not support them.`);
        throw new Error(`Provider "${providerName}" does not support image input, but images were included in the request.`);
    }
    // *** END ADDED CHECK ***

    let requestURL;
    const headers = { 'Content-Type': 'application/json' };
    let requestBody;

    try {
        // Prepare history based on provider format.
        // NOTE: `processedHistory` will hold different structures depending on the format.
        let processedHistory;
        if (providerConfig.format === "gemini_generateContent") {
            // For Gemini, call the transformation function which handles images internally.
            // The result is an object { contents, systemInstruction }.
            processedHistory = transformHistoryForGemini(conversationHistory);
        } else {
            // For other formats (OpenAI compatible, Proxy assumed OpenAI compatible):
            // 1. Filter out system prompt if not supported.
            // 2. Map to keep only { role, content }. This implicitly drops the 'images' field
            //    as these formats don't support images in this standard message structure.
            processedHistory = conversationHistory
                .filter(msg => msg && msg.role && (typeof msg.content === 'string' || msg.role === 'system')) // Ensure basic message validity
                .filter(msg => providerConfig.supportsSystemPromptInMessages || msg.role !== 'system') // Handle system prompt
                .map(msg => ({ role: msg.role, content: msg.content })); // Keep only role/content
        }

        // --- Format Specific Request Building ---
        if (providerConfig.format === "proxy_compatible") {
            requestURL = providerConfig.baseURL;
            requestBody = {
                model: modelName,
                messages: processedHistory, // Use the role/content only history
                temperature: options.temperature ?? 0.7,
                stream: options.stream ?? false,
            };
            console.log("[API Provider] Using proxy_compatible format.");

        } else if (providerConfig.format === "openai_compatible") {
            requestURL = providerConfig.baseURL;
            if (providerConfig.apiKeyLocation === "header") {
                headers['Authorization'] = `${providerConfig.authHeaderPrefix || ''}${apiKey}`;
            }
            requestBody = {
                model: modelName,
                messages: processedHistory, // Use the role/content only history
                stream: options.stream ?? false,
                temperature: options.temperature ?? 0.7,
                top_p: options.top_p ?? 0.9
            };

        } else if (providerConfig.format === "gemini_generateContent") {
            requestURL = `${providerConfig.baseURL}${modelName}:generateContent`;
            if (providerConfig.apiKeyLocation === "query") {
                requestURL += `?${providerConfig.apiKeyQueryParam}=${apiKey}`;
            }

            // Destructure the result from transformHistoryForGemini
            const { contents, systemInstruction } = processedHistory;
            if (contents.length === 0) {
                // This check is important, especially if image-only messages were skipped during transformation
                throw new Error("Cannot send empty history (no valid parts) to Gemini.");
            }
            requestBody = {
                contents: contents, // Use the 'contents' array which might include inlineData parts
                generationConfig: {
                    temperature: options.temperature ?? 0.7,
                    topP: options.top_p ?? 0.9,
                }
            };
            if (systemInstruction && providerConfig.systemInstructionKey) {
                requestBody[providerConfig.systemInstructionKey] = { parts: [{ text: systemInstruction }] };
                // console.log(`[API Provider] Including '${providerConfig.systemInstructionKey}' for Gemini.`);
            }
             else if (systemInstruction) {
                 console.warn(`[API Provider] System instruction found but no 'systemInstructionKey' configured for Gemini provider.`);
             }
        } else {
            throw new Error(`Unsupported provider format: ${providerConfig.format}`);
        }
    } catch (error) {
        console.error(`[API Provider] Error preparing request for ${providerName}:`, error);
        throw error; // Re-throw preparation errors
    }

    console.log(`[API Provider] Calling URL: ${requestURL}`);
    // console.log('[API Provider] Request Body:', JSON.stringify(requestBody, null, 2)); // DEBUG: Log body

    // --- Fetch and Response Handling (Unchanged from previous version) ---
    try {
        const response = await fetch(requestURL, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            let errorData;
            let errorMessage = `API Error ${response.status}: ${response.statusText}`;
            try {
                errorData = await response.json();
                console.error(`[API Provider] ${providerName} Error Response Body:`, errorData);
                errorMessage = errorData.error?.message
                              || errorData.message
                              || errorData.details?.[0]?.message
                              || errorData.detail
                              || (typeof errorData === 'string' ? errorData : JSON.stringify(errorData))
                              || errorMessage;
            } catch (jsonError) {
                 console.warn(`[API Provider] Could not parse ${providerName} error response as JSON.`);
                 try { const textError = await response.text(); if (textError) errorMessage = textError; } catch(textErr) { /* Ignore */ }
            }
            console.error(`[API Provider] Fetch failed for ${providerName}: Status ${response.status}, Message: ${errorMessage}`);
            throw new Error(errorMessage);
        }

        const data = await response.json();
        let messageContent = null;

        // Extract response based on format
        if (providerConfig.format === "openai_compatible" || providerConfig.format === "proxy_compatible") {
            messageContent = data.choices?.[0]?.message?.content;
        } else if (providerConfig.format === "gemini_generateContent") {
            if (data.promptFeedback?.blockReason) {
                 console.warn(`[API Provider] Gemini request blocked: ${data.promptFeedback.blockReason}`, data.promptFeedback);
                 throw new Error(`Content blocked by API safety filters: ${data.promptFeedback.blockReason}`);
            }
            if (!data.candidates || data.candidates.length === 0) {
                 console.warn(`[API Provider] Gemini response missing candidates. Data:`, data);
                 const candidateBlockReason = data.candidates?.[0]?.promptFeedback?.blockReason; // Check anyway
                 if(candidateBlockReason) { throw new Error(`Content blocked by API safety filters: ${candidateBlockReason}`); }
                 throw new Error(`Invalid API response from ${providerName}: No candidates returned.`);
            }
            messageContent = data.candidates[0]?.content?.parts?.[0]?.text;
            const finishReason = data.candidates[0]?.finishReason;
             if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
                 console.warn(`[API Provider] Gemini generation finished unexpectedly: ${finishReason}`);
                 if (messageContent != null) { messageContent += `\n\n(Note: Generation finished due to ${finishReason})`; }
                 else { throw new Error(`Generation failed or stopped due to: ${finishReason}`); }
             }
        }

        // Allow empty string, but handle null/undefined as error
        if (messageContent === null || messageContent === undefined) {
            console.error(`[API Provider] Invalid response structure from ${providerName}: Could not extract message content. Data:`, data);
            throw new Error(`Invalid API response from ${providerName}: Could not find message content.`);
        }
        if (messageContent === "") {
             console.warn(`[API Provider] Received empty string message content from ${providerName}.`);
        }


        console.log(`[API Provider] Received successful response from ${providerName}.`);
        return messageContent; // Return string (could be empty)

    } catch (error) {
        console.error(`[API Provider] Error during API call to ${providerName}:`, error);
        if (error instanceof Error) { throw error; }
        else { throw new Error(String(error)); }
    }
}

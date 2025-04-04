// api_providers.js

// Define known providers and their configurations
const PROVIDERS = {
    // --- NEW PROVIDER ---
    BIGMODEL_PROXY: {
        name: "BigModel (via Proxy)",
        // Use a new format to signal special handling in getApiResponse
        format: "proxy_compatible",
        // Relative URL to your Cloudflare Pages Function or similar proxy
        baseURL: "/api/proxy",
        // Model used by the minimal chatbot example
        availableModels: ["glm-4-flash"],
        defaultModel: "glm-4-flash",
        // API Key is handled by the proxy, not sent from client
        apiKeyLocation: "none", // Indicate key is not handled here
        // Assume system prompt is handled like OpenAI by the proxy/underlying API
        supportsSystemPromptInMessages: true,
    },
    // --- Existing Providers (Unchanged) ---
    SAMBANOVA: {
        name: "SambaNova",
        format: "openai_compatible",
        baseURL: "https://api.sambanova.ai/v1/chat/completions",
        availableModels: ["DeepSeek-V3-0324"],
        defaultModel: "DeepSeek-V3-0324",
        apiKeyLocation: "header",
        authHeaderPrefix: "Bearer ",
        supportsSystemPromptInMessages: true,
    },
    GEMINI: {
        name: "Gemini",
        format: "gemini_generateContent",
        baseURL: "https://generativelanguage.googleapis.com/v1beta/models/",
        availableModels: ["gemini-2.5-pro-exp-03-25"],
        defaultModel: "gemini-2.5-pro-exp-03-25",
        apiKeyLocation: "query",
        apiKeyQueryParam: "key",
        supportsSystemPromptInMessages: false,
        systemInstructionKey: "system_instruction",
    },
    DEEPSEEK: {
        name: "DeepSeek",
        format: "openai_compatible",
        baseURL: "https://api.deepseek.com/v1/chat/completions",
        availableModels: ["deepseek-chat", "deepseek-reasoner"],
        defaultModel: "deepseek-chat",
        apiKeyLocation: "header",
        authHeaderPrefix: "Bearer ",
        supportsSystemPromptInMessages: true,
    },
    QWEN: {
        name: "Model Studio",
        format: "openai_compatible",
        baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
        availableModels: ["qwen-max"],
        defaultModel: "qwen-max",
        apiKeyLocation: "header",
        authHeaderPrefix: "Bearer ",
        supportsSystemPromptInMessages: true,
    },
    // OPENAI: { /* ... */ },
};

// --- Helper: Transform History & Extract System Prompt (for Gemini) ---
// Unchanged from your original file
function transformHistoryForGemini(conversationHistory) {
    const contents = [];
    let systemInstruction = null;
    if (conversationHistory.length > 0 && conversationHistory[0].role === 'system') {
        systemInstruction = conversationHistory[0].content;
        console.log("[API Provider] Found system instruction for Gemini:", systemInstruction ? systemInstruction.substring(0, 50) + "..." : "None");
    }
    const historyWithoutSystem = conversationHistory.slice(systemInstruction ? 1 : 0);
    historyWithoutSystem.forEach(msg => {
        let role = msg.role === 'assistant' ? 'model' : msg.role;
        if (msg.content != null) {
            contents.push({ role: role, parts: [{ text: msg.content }] });
        } else {
            console.warn("[API Provider] Skipping message with null/undefined content:", msg);
        }
    });
    if (contents.length > 0 && contents[contents.length - 1].role === 'model') {
        console.warn("Gemini history transformation ended with 'model', check logic.");
    }
    return { contents, systemInstruction };
}


// --- Core API Call Function (Modified to handle 'proxy_compatible') ---
async function getApiResponse(providerName, modelName, conversationHistory, apiKey, options = {}) {
    console.log(`[API Provider] Requesting completion from ${providerName} using model ${modelName}.`);
    const providerConfig = PROVIDERS[providerName];

    if (!providerConfig) throw new Error(`Configuration for provider "${providerName}" not found.`);

    // --- MODIFIED: Check if API key is required based on format ---
    const requiresApiKey = providerConfig.format !== 'proxy_compatible' && providerConfig.apiKeyLocation !== 'none';
    if (requiresApiKey && !apiKey) {
        // This check remains, but won't trigger for proxy_compatible
        throw new Error(`API Key is missing for provider "${providerName}".`);
    }
    // --- END MODIFICATION ---

    let requestURL;
    // Default headers
    const headers = { 'Content-Type': 'application/json' };
    let requestBody;

    try {
        // Ensure history contains valid messages
        const validHistory = conversationHistory.filter(msg => msg && msg.role && typeof msg.content === 'string');

        // --- ADDED: Handle the new 'proxy_compatible' format ---
        if (providerConfig.format === "proxy_compatible") {
            requestURL = providerConfig.baseURL; // Use the proxy URL directly
            // NO Authorization header is added here
            const messagesToSend = providerConfig.supportsSystemPromptInMessages
                ? validHistory
                : validHistory.filter(msg => msg.role !== 'system');
            requestBody = {
                model: modelName,
                messages: messagesToSend,
                // Add other parameters the minimal chatbot used/proxy expects
                temperature: options.temperature ?? 0.7,
                // max_tokens: options.max_tokens ?? 1024 // Uncomment if your proxy uses this
                stream: options.stream ?? false, // Assuming proxy doesn't support streaming unless explicitly coded
            };
            console.log("[API Provider] Using proxy_compatible format. API key NOT sent by client.");
        }
        // --- END ADDITION ---
        else if (providerConfig.format === "openai_compatible") {
            requestURL = providerConfig.baseURL;
            // Add API key if required by this format
            if (providerConfig.apiKeyLocation === "header") {
                headers['Authorization'] = `${providerConfig.authHeaderPrefix || ''}${apiKey}`;
            }
            // else if (providerConfig.apiKeyLocation === "query") { /* Handle if needed */ }

            const messagesToSend = providerConfig.supportsSystemPromptInMessages
                ? validHistory
                : validHistory.filter(msg => msg.role !== 'system');
            requestBody = {
                model: modelName,
                messages: messagesToSend,
                stream: options.stream ?? false,
                temperature: options.temperature ?? 0.7,
                top_p: options.top_p ?? 0.9
            };
        } else if (providerConfig.format === "gemini_generateContent") {
            requestURL = `${providerConfig.baseURL}${modelName}:generateContent`;
             // Add API key if required by this format
            if (providerConfig.apiKeyLocation === "query") {
                requestURL += `?${providerConfig.apiKeyQueryParam}=${apiKey}`;
            }
            // else if (providerConfig.apiKeyLocation === "header") { /* Handle if needed */ }

            const { contents, systemInstruction } = transformHistoryForGemini(validHistory);
            if (contents.length === 0) {
                throw new Error("Cannot send empty history to Gemini.");
            }
            requestBody = {
                contents: contents,
                generationConfig: {
                    temperature: options.temperature ?? 0.7,
                    topP: options.top_p ?? 0.9
                }
            };
            if (systemInstruction && providerConfig.systemInstructionKey) {
                requestBody[providerConfig.systemInstructionKey] = { parts: [{ text: systemInstruction }] };
                console.log(`[API Provider] Including '${providerConfig.systemInstructionKey}' for Gemini.`);
            } else if (systemInstruction) {
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
    // console.log('[API Provider] Request Body:', JSON.stringify(requestBody, null, 2)); // DEBUG: Log body if needed

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
                // Try to get more specific error from response body
                errorData = await response.json();
                console.error(`[API Provider] ${providerName} Error Response Body:`, errorData);
                // Adapt to common error structures, including the one likely from OpenAI format
                errorMessage = errorData.error?.message
                              || errorData.message // Generic message field
                              || errorData.details?.[0]?.message // Gemini-like detail
                              || errorData.detail // FastAPI/other frameworks
                              || (typeof errorData === 'string' ? errorData : JSON.stringify(errorData)) // Fallback
                              || errorMessage; // Original status text
            } catch (jsonError) {
                console.warn(`[API Provider] Could not parse ${providerName} error response as JSON.`);
                 try { const textError = await response.text(); if (textError) errorMessage = textError; } catch(textErr) { /* Ignore */ }
            }
            console.error(`[API Provider] Fetch failed for ${providerName}: Status ${response.status}, Message: ${errorMessage}`);
            throw new Error(errorMessage); // Throw the extracted/constructed error message
        }

        const data = await response.json();
        let messageContent = null;

        // --- MODIFIED: Extract response based on format (proxy likely uses openai structure) ---
        if (providerConfig.format === "openai_compatible" || providerConfig.format === "proxy_compatible") {
             // Assume proxy returns OpenAI compatible structure based on minimal chat example
            messageContent = data.choices?.[0]?.message?.content;
        } else if (providerConfig.format === "gemini_generateContent") {
            if (data.promptFeedback?.blockReason) {
                 console.warn(`[API Provider] Gemini request blocked: ${data.promptFeedback.blockReason}`, data.promptFeedback);
                 throw new Error(`Content blocked by API safety filters: ${data.promptFeedback.blockReason}`);
            }
            messageContent = data.candidates?.[0]?.content?.parts?.[0]?.text;
             const finishReason = data.candidates?.[0]?.finishReason;
             if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
                 console.warn(`[API Provider] Gemini generation finished unexpectedly: ${finishReason}`);
                 if (!messageContent) { throw new Error(`Generation failed or stopped due to: ${finishReason}`); }
                 else { messageContent += `\n\n(Note: Generation finished due to ${finishReason})`; }
             }
        }
        // --- END MODIFICATION ---

        if (typeof messageContent !== 'string') {
            console.error(`[API Provider] Invalid response structure from ${providerName}:`, data);
            throw new Error(`Invalid API response from ${providerName}: Could not find message content.`);
        }

        // Allow empty responses, maybe log a warning unless it's Gemini (which can genuinely return empty if blocked/filtered)
        if (!messageContent.trim() && providerConfig.format !== 'gemini_generateContent') {
             console.warn(`[API Provider] Received empty message content from ${providerName}.`);
        }

        console.log(`[API Provider] Received successful response from ${providerName}.`);
        return messageContent;

    } catch (error) {
        console.error(`[API Provider] Error during API call to ${providerName}:`, error);
        // Re-throw the error so the main script can catch it
        if (error instanceof Error) {
            throw error;
        } else {
            // Ensure it's always an Error object being thrown
            throw new Error(String(error));
        }
    }
}

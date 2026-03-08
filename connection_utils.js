
// Don't import - use global SillyTavern object instead
// import { getContext } from '../../../extensions.js';

const extensionName = "Extension-DiscordChat";

function debugLog(...args) {
    console.log(`[${extensionName}]`, ...args);
}

function debugWarn(...args) {
    console.warn(`[${extensionName}]`, ...args);
}

/**
 * Wait for the connection manager to be available
 */
async function waitForConnectionManager(maxAttempts = 10, delayMs = 200) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const context = SillyTavern.getContext();
        if (context?.extensionSettings?.connectionManager) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    debugWarn(`Connection manager not available after ${maxAttempts} attempts`);
    return false;
}

/**
 * Get profile object by name
 */
window.getProfileByName = async function getProfileByName(profileName) {
    try {
        const isAvailable = await waitForConnectionManager();
        if (!isAvailable) return null;

        const context = SillyTavern.getContext();
        const { profiles } = context.extensionSettings.connectionManager;
        return profiles.find(p => p.name === profileName) || null;
    } catch {
        return null;
    }
}

/**
 * Generate using a connection profile WITHOUT changing global settings
 * This uses the profile's settings to make a direct API call via ConnectionManagerRequestService
 */
window.generateWithProfile = async function generateWithProfile(profileName, prompt, systemPrompt = '', abortController = null) {
    try {
        const profile = await getProfileByName(profileName);
        if (!profile) {
            if (typeof toastr !== 'undefined') toastr.error(`Profile '${profileName}' not found in Connection Manager`, 'EC Utils: Profile Missing');
            throw new Error(`Connection profile not found: ${profileName}`);
        }

        debugLog(`Generating with profile: ${profileName} (isolated, no global state change)`);

        const context = SillyTavern.getContext();

        // Build the messages array
        const messages = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });

        // ── Validate ConnectionManagerRequestService ──
        const cmrs = context.ConnectionManagerRequestService;
        debugLog('ConnectionManagerRequestService:', !!cmrs);
        debugLog('sendRequest type:', typeof cmrs?.sendRequest);
        debugLog('Profile ID:', profile.id);

        let response;

        if (cmrs && typeof cmrs.sendRequest === 'function') {
            // ── Primary path: use sendRequest ──
            debugLog('Using sendRequest (primary path)');
            try {
                response = await cmrs.sendRequest(
                    profile.id,
                    messages,
                    context.main?.max_length || 500,
                    {
                        stream: false,
                        signal: abortController?.signal || null,
                        extractData: true,
                        includePreset: true,
                        includeInstruct: true
                    }
                );
                debugLog('sendRequest returned:', typeof response, response ? Object.keys(response) : 'null');
            } catch (apiError) {
                debugWarn('sendRequest threw:', apiError.name, apiError.message);
                if (typeof toastr !== 'undefined') toastr.error(`sendRequest failed: [${apiError.name}] ${apiError.message}`, 'EC Utils: API Error');
                throw apiError;
            }
        }

        // ── Fallback: direct fetch if sendRequest unavailable or returned nothing ──
        if (!response) {
            const apiEndpoint = profile.apiEndpoint || profile.endpoint || profile.url || profile.api_url;
            const apiKey = profile.apiKey || profile.key || profile.api_key;
            const model = profile.model || profile.modelId;

            debugLog('Direct fetch fallback, endpoint:', apiEndpoint ? 'found' : 'NOT FOUND');
            debugLog('Profile keys:', Object.keys(profile).join(', '));

            if (!apiEndpoint) {
                const keys = Object.keys(profile).join(', ');
                if (typeof toastr !== 'undefined') toastr.error(`No API endpoint in profile. Keys: ${keys}`, 'EC Utils: No Endpoint');
                throw new Error(
                    'sendRequest returned nothing and no API endpoint in profile. Keys: ' + keys
                );
            }

            const fetchResponse = await fetch(apiEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
                },
                body: JSON.stringify({
                    model: model || 'default',
                    messages: messages,
                    max_tokens: context.main?.max_length || 500,
                    temperature: 0.7,
                    stream: false
                }),
                signal: abortController?.signal || null
            });

            if (!fetchResponse.ok) {
                const errorText = await fetchResponse.text();
                if (typeof toastr !== 'undefined') toastr.error(`Direct fetch HTTP ${fetchResponse.status}: ${errorText.substring(0, 150)}`, 'EC Utils: Fetch Failed');
                throw new Error(`Direct API Error ${fetchResponse.status}: ${errorText}`);
            }

            response = await fetchResponse.json();
            debugLog('Direct fetch response keys:', Object.keys(response));
        }

        // Extract text from response - handle all possible API formats
        function extractText(resp) {
            if (!resp) return null;
            if (typeof resp === 'string') return resp;

            // Response itself is an array of content blocks
            if (Array.isArray(resp)) {
                const texts = resp
                    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
                    .map(b => b.text);
                if (texts.length > 0) return texts.join('\n');
            }

            // response.content (string or array)
            if (resp.content !== undefined && resp.content !== null) {
                if (typeof resp.content === 'string') return resp.content;
                if (Array.isArray(resp.content)) {
                    const texts = resp.content
                        .filter(b => b && b.type === 'text' && typeof b.text === 'string')
                        .map(b => b.text);
                    if (texts.length > 0) return texts.join('\n');
                }
            }

            // OpenAI choices format
            if (resp.choices?.[0]?.message?.content) {
                const c = resp.choices[0].message.content;
                if (typeof c === 'string') return c;
                if (Array.isArray(c)) {
                    const texts = c
                        .filter(b => b && b.type === 'text' && typeof b.text === 'string')
                        .map(b => b.text);
                    if (texts.length > 0) return texts.join('\n');
                }
            }

            // Other common fields
            if (typeof resp.text === 'string') return resp.text;
            if (typeof resp.message === 'string') return resp.message;
            if (resp.message?.content && typeof resp.message.content === 'string') return resp.message.content;

            // Unusual/nested formats
            if (resp.data?.text) return resp.data.text;
            if (resp.result?.text) return resp.result.text;
            if (resp.output?.text) return resp.output.text;

            // Error responses
            if (resp.error) return `[Error: ${typeof resp.error === 'string' ? resp.error : JSON.stringify(resp.error)}]`;

            return null;
        }

        const extracted = extractText(response);
        if (extracted !== null) {
            debugLog('Extracted text from response, length:', extracted.length);
            return extracted;
        }

        const respKeys = Object.keys(response).join(', ');
        debugWarn('Unexpected response format, could not extract text. Keys:', respKeys);
        debugWarn('Full response:', JSON.stringify(response, null, 2));
        if (typeof toastr !== 'undefined') toastr.error(`Could not extract text. Response keys: ${respKeys}`, 'EC Utils: Bad Format');
        throw new Error('Invalid response format from API. Response keys: ' + respKeys);

    } catch (error) {
        debugWarn('Error generating with profile:', error);
        if (typeof toastr !== 'undefined') toastr.error(`[${error.name}] ${(error.message || '').substring(0, 200)}`, 'EC Utils: Generation Failed', { timeOut: 15000 });
        throw error;
    }
}

// functions/api/proxy.js

/**
 * Cloudflare Pages Function to proxy requests to the BigModel API.
 * Handles requests made to /api/proxy
 */
export async function onRequestPost(context) {
  // context contains request, env (for secrets), etc.
  const { request, env } = context;

  try {
    // 1. Ensure it's a valid JSON request
    if (!request.headers.get('content-type')?.includes('application/json')) {
       return new Response('Invalid Content-Type, expected application/json', { status: 415 });
    }
    const requestBody = await request.json();

    // 2. Define the target API endpoint
    const bigModelUrl = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

    // 3. Get the API key from environment variables (secrets)
    const apiKey = env.BIGMODEL_API_KEY; // This name MUST match the secret you set in Cloudflare
    if (!apiKey) {
      console.error("ERROR: BIGMODEL_API_KEY secret not set in Cloudflare Pages environment!");
      return new Response('API key configuration error on server', { status: 500 });
    }

    // 4. Forward the request to the BigModel API, adding the API key
    const response = await fetch(bigModelUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey, // Add the secret API key
      },
      body: JSON.stringify(requestBody), // Pass through the body from the client
    });

    // 5. Return the response from BigModel directly back to the client
    // No need for CORS headers here because it's the same origin!
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers // Pass through headers like Content-Type from BigModel
    });

  } catch (error) {
    console.error('Error in API proxy function:', error);
    return new Response('Internal Server Error processing your request', { status: 500 });
  }
}

// Optional: Handle methods other than POST for the /api/proxy route
export async function onRequest(context) {
   if (context.request.method !== 'POST') {
     return new Response(`Method ${context.request.method} Not Allowed`, { status: 405, headers: { 'Allow': 'POST' } });
   }
   // If it's POST, Cloudflare automatically routes it to onRequestPost
   // This function might not even be strictly needed if you only care about POST
   // but provides explicit handling for other methods.
   return new Response('Not Found?', { status: 404 }); // Should not be hit for POST
}

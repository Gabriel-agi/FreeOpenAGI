/**
 * Cloudflare Pages Function to proxy requests to the BigModel API.
 * Handles requests made to /api/proxy
 */
export async function onRequest(context) {
  // context contains request, env (for secrets), etc.
  const { request, env } = context;

  // --- 1. Handle CORS Preflight Request ---
  // Browsers send an OPTIONS request first to check permissions.
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*', // Allows any domain
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      }
    });
  }

  // --- 2. Handle the Actual POST Request ---
  if (request.method === 'POST') {
    try {
      // Ensure it's a valid JSON request
      if (!request.headers.get('content-type')?.includes('application/json')) {
        return new Response('Invalid Content-Type, expected application/json', { status: 415 });
      }
      const requestBody = await request.json();

      // Define the target API endpoint
      const bigModelUrl = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

      // Get the API key from environment variables (secrets)
      const apiKey = env.BIGMODEL_API_KEY; // This name MUST match the secret you set in Cloudflare
      if (!apiKey) {
        console.error("ERROR: BIGMODEL_API_KEY secret not set in Cloudflare Pages environment!");
        // Return an error, but still add CORS headers so the client can read it.
        return new Response('API key configuration error on server', { 
          status: 500,
          headers: {
            'Access-Control-Allow-Origin': '*',
          }
        });
      }

      // Forward the request to the BigModel API, adding the API key
      const response = await fetch(bigModelUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': apiKey, // Add the secret API key
        },
        body: JSON.stringify(requestBody), // Pass through the body from the client
      });

      // --- 3. Return the response from BigModel with CORS Headers ---
      // Create a new response object to add our CORS headers
      const responseBody = await response.text();
      return new Response(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          // Copy original headers from the BigModel response
          ...response.headers,
          // Add our crucial CORS headers
          'Access-Control-Allow-Origin': '*',
        }
      });

    } catch (error) {
      console.error('Error in API proxy function:', error);
      // Return an error, but still add CORS headers so the client can read it.
      return new Response('Internal Server Error processing your request', { 
        status: 500,
        headers: {
          'Access-Control-Allow-Origin': '*',
        }
      });
    }
  }

  // --- 4. Handle any other methods ---
  return new Response('Method Not Allowed', { status: 405, headers: { 'Allow': 'POST, OPTIONS' } });
}

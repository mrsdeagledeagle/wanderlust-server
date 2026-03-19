const https = require('https');
const http = require('http');
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Wanderlust server running', time: new Date().toISOString() }));
    return;
  }

  if (req.method === 'POST' && req.url === '/search') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const params = JSON.parse(body);
        const { dest, origin, guests, checkin, checkout, budget, destIATA, originIATA } = params;
        if (!ANTHROPIC_API_KEY) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing ANTHROPIC_API_KEY on server' })); return;
        }
        const starsFilter = budget === 'budget' ? '3' : budget === 'luxury' ? '4,5' : '3,4';
        const nightsCount = Math.round((new Date(checkout) - new Date(checkin)) / 86400000);

        const hotelPrompt = `Use the lastminute.com MCP tool search_flight_and_hotel_package with EXACTLY these parameters:
- origin: "${originIATA || 'SAT'}"
- destination: "${destIATA || dest}"
- date_from: "${checkin}"
- date_to: "${checkout}"
- adults: "${guests}"
- sort: "price"
- max_results: 5
- hotel_stars: "${starsFilter}"

After getting results return ONLY raw JSON no markdown:
{"hotels":[{"id":0,"search_id":0,"name":"","stars":0,"rating":0,"reviews":0,"dist":0,"price_total":0,"price_per_night":0,"currency":"GBP","amenities":[],"img":"","cancellable":false,"carrier":"","direct":true}],"search_id":0,"dest":"${dest}"}`;

        const hotelResult = await callClaudeWithMCP(hotelPrompt, [
          { type: 'url', url: 'https://mcp.lastminute.com/mcp', name: 'lastminute' }
        ]);

        const depKiwi = checkin.split('-').reverse().join('/');
        const retKiwi = checkout.split('-').reverse().join('/');
        const flightPrompt = `Use the kiwi.com MCP tool search-flight with:
- flyFrom: "${origin}"
- flyTo: "${dest}"
- departureDate: "${depKiwi}"
- returnDate: "${retKiwi}"
- passengers: {"adults": ${guests}}
- curr: "USD"
- sort: "price"

Return ONLY raw JSON no markdown:
{"flights":[{"route":"","depart":"","arrive":"","returnDepart":"","airline":"","stops":"","price":0,"currency":"USD","bookUrl":""}]}`;

        let flightResult = { flights: [] };
        try {
          flightResult = await callClaudeWithMCP(flightPrompt, [
            { type: 'url', url: 'https://mcp.kiwi.com', name: 'kiwi' }
          ]);
        } catch(e) { console.log('Flight search failed:', e.message); }

        const finalResult = {
          hotels: hotelResult.hotels || [],
          flights: flightResult.flights || [],
          search_id: hotelResult.search_id,
          dest
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(finalResult));
      } catch (err) {
        console.error('Search error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/rooms') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { hotelId, searchId, checkin, checkout } = JSON.parse(body);
        const prompt = `Call lastminute.com select_hotel_options: search_id=${searchId}, hotel_internal_id=${hotelId}, date_from="${checkin}", date_to="${checkout}". Return ONLY raw JSON: {"rooms":[{"name":"","price_total":0,"currency":"GBP","cancellation":"","deeplink":""}]}`;
        const result = await callClaudeWithMCP(prompt, [
          { type: 'url', url: 'https://mcp.lastminute.com/mcp', name: 'lastminute' }
        ]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

async function callClaudeWithMCP(userMessage, mcpServers) {
  const messages = [{ role: 'user', content: userMessage }];
  let finalText = '';

  for (let turn = 0; turn < 6; turn++) {
    const requestBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: 'You are a travel search assistant. Call the MCP tools to get live data. After getting tool results, return ONLY raw JSON with no markdown, no explanation.',
      messages,
      mcp_servers: mcpServers
    });

    const apiResponse = await callAnthropic(requestBody);
    if (apiResponse.error) throw new Error(apiResponse.error.message || JSON.stringify(apiResponse.error));

    const content = apiResponse.content || [];
    const textBlocks = content.filter(b => b.type === 'text').map(b => b.text).join('');
    if (textBlocks.trim()) finalText = textBlocks.trim();

    console.log(`Turn ${turn + 1}: stop_reason=${apiResponse.stop_reason}, text=${textBlocks.substring(0,100)}`);

    if (apiResponse.stop_reason === 'end_turn') break;

    if (apiResponse.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: 'Please now return the final JSON result based on the tool results above. Return ONLY raw JSON, no markdown.' });
      continue;
    }
    break;
  }

  if (!finalText) throw new Error('No text response from AI');

  const cleaned = finalText.replace(/```json|```/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response: ' + cleaned.substring(0, 300));
  return JSON.parse(jsonMatch[0]);
}

function callAnthropic(body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'mcp-client-2025-04-04',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse response: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

server.listen(PORT, () => {
  console.log('Wanderlust server on port ' + PORT);
  console.log('API key: ' + (ANTHROPIC_API_KEY ? 'SET' : 'MISSING'));
});

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
    res.end(JSON.stringify({ status: 'Wanderlust server v2 running', time: new Date().toISOString() }));
    return;
  }
  if (req.method === 'POST' && req.url === '/search') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { dest, origin, guests, checkin, checkout, budget, destIATA, originIATA } = JSON.parse(body);
        if (!ANTHROPIC_API_KEY) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing ANTHROPIC_API_KEY' })); return; }
        const starsFilter = budget === 'budget' ? '3' : budget === 'luxury' ? '4,5' : '3,4';
        const fromCode = originIATA || 'SAT';
        const toCode = destIATA || dest;
        console.log(`Searching: ${fromCode} -> ${toCode} | ${checkin} - ${checkout} | ${guests} adults`);
        const hotelMessages = [{ role: 'user', content: `Call the lastminute.com search_flight_and_hotel_package MCP tool with these parameters:\n- origin: "${fromCode}"\n- destination: "${toCode}"\n- date_from: "${checkin}"\n- date_to: "${checkout}"\n- adults: "${guests}"\n- sort: "price"\n- max_results: 5\n- hotel_stars: "${starsFilter}"\n\nAfter the tool returns results, respond with ONLY this JSON (no markdown):\n{"hotels":[{"id":0,"search_id":0,"name":"","stars":0,"rating":0,"reviews":0,"dist":0,"price_total":0,"price_per_night":0,"currency":"GBP","amenities":[],"img":"","cancellable":false,"carrier":"","direct":true}],"search_id":0}` }];
        const hotelResponse = await callAnthropicMCP(hotelMessages, [{ type: 'url', url: 'https://mcp.lastminute.com/mcp', name: 'lastminute' }]);
        let hotels = [], searchId = null;
        try { const p = extractJSON(hotelResponse); hotels = p.hotels || []; searchId = p.search_id; console.log(`Got ${hotels.length} hotels`); } catch(e) { console.error('Hotel parse error:', e.message); }
        const depKiwi = checkin.split('-').reverse().join('/');
        const retKiwi = checkout.split('-').reverse().join('/');
        let flights = [];
        try {
          const flightMessages = [{ role: 'user', content: `Call the kiwi.com search-flight MCP tool with:\n- flyFrom: "${origin}"\n- flyTo: "${dest}"\n- departureDate: "${depKiwi}"\n- returnDate: "${retKiwi}"\n- passengers: {"adults": ${guests}}\n- curr: "USD"\n- sort: "price"\n\nAfter results return ONLY this JSON (no markdown):\n{"flights":[{"route":"","depart":"","arrive":"","returnDepart":"","airline":"","stops":"","price":0,"currency":"USD","bookUrl":""}]}` }];
          const flightResponse = await callAnthropicMCP(flightMessages, [{ type: 'url', url: 'https://mcp.kiwi.com', name: 'kiwi' }]);
          const p = extractJSON(flightResponse); flights = p.flights || []; console.log(`Got ${flights.length} flights`);
        } catch(e) { console.log('Flight search non-fatal:', e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hotels, flights, search_id: searchId, dest }));
      } catch (err) { console.error('Search error:', err.message); res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/rooms') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { hotelId, searchId, checkin, checkout } = JSON.parse(body);
        const messages = [{ role: 'user', content: `Call lastminute.com select_hotel_options: search_id=${searchId}, hotel_internal_id=${hotelId}, date_from="${checkin}", date_to="${checkout}". Return ONLY JSON: {"rooms":[{"name":"","price_total":0,"currency":"GBP","cancellation":"","deeplink":""}]}` }];
        const response = await callAnthropicMCP(messages, [{ type: 'url', url: 'https://mcp.lastminute.com/mcp', name: 'lastminute' }]);
        const result = extractJSON(response);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); }
    });
    return;
  }
  res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

async function callAnthropicMCP(messages, mcpServers) {
  const msgHistory = [...messages];
  let finalText = '';
  for (let turn = 0; turn < 8; turn++) {
    const body = JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 4000, system: 'You are a travel data assistant. Call MCP tools when asked. After receiving tool results, respond with ONLY the raw JSON requested. No markdown fences, no explanation.', messages: msgHistory, mcp_servers: mcpServers });
    const response = await callAnthropic(body);
    if (response.error) throw new Error(`API error: ${response.error.message || JSON.stringify(response.error)}`);
    const content = response.content || [];
    const stopReason = response.stop_reason;
    const textContent = content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    console.log(`Turn ${turn+1}: stop=${stopReason} text_len=${textContent.length}`);
    if (textContent) finalText = textContent;
    if (stopReason === 'end_turn') break;
    if (stopReason === 'tool_use') { msgHistory.push({ role: 'assistant', content }); msgHistory.push({ role: 'user', content: 'Now return the final JSON result. Return ONLY the raw JSON object, no markdown.' }); continue; }
    break;
  }
  if (!finalText) throw new Error('No text response received from AI');
  return finalText;
}

function extractJSON(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found: ' + cleaned.substring(0, 200));
  return JSON.parse(match[0]);
}

function callAnthropic(body) {
  return new Promise((resolve, reject) => {
    const options = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'mcp-client-2025-04-04', 'Content-Length': Buffer.byteLength(body) } };
    const req = https.request(options, apiRes => { let data = ''; apiRes.on('data', chunk => data += chunk); apiRes.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('Parse error: ' + data.substring(0, 200))); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

server.listen(PORT, () => { console.log(`Wanderlust server v2 on port ${PORT}`); console.log(`API key: ${ANTHROPIC_API_KEY ? 'SET' : 'MISSING'}`); });
ENDOFFILE
echo "Written. Now restarting..."
pkill node; sleep 2; node server.js &
echo "Done! Check https://wanderlust-server-fogz.onrender.com"

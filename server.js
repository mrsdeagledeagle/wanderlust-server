const https = require('https');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── Simple HTTP server (no dependencies needed) ──
const http = require('http');

const server = http.createServer(async (req, res) => {
  // CORS headers — allow your Netlify app to call this server
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Wanderlust server running', time: new Date().toISOString() }));
    return;
  }

  // Main search endpoint
  if (req.method === 'POST' && req.url === '/search') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const params = JSON.parse(body);
        const { dest, origin, guests, checkin, checkout, budget, destIATA, originIATA } = params;

        if (!dest || !checkin || !checkout) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required fields: dest, checkin, checkout' }));
          return;
        }

        if (!ANTHROPIC_API_KEY) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Server missing ANTHROPIC_API_KEY environment variable' }));
          return;
        }

        const budgetNote = budget === 'budget' ? 'budget, under $150/night'
          : budget === 'luxury' ? 'luxury, over $300/night' : 'mid-range';
        const starsFilter = budget === 'budget' ? '"3"' : budget === 'luxury' ? '"4,5"' : '"3,4"';
        const depDateKiwi = checkin.split('-').reverse().join('/');
        const retDateKiwi = checkout.split('-').reverse().join('/');

        const prompt = `You are a travel search assistant. Call the lastminute.com and kiwi.com MCP tools to get LIVE pricing.

SEARCH:
- Origin: ${origin} (IATA: ${originIATA})
- Destination: ${dest}${destIATA ? ' (IATA: ' + destIATA + ')' : ''}
- Check-in: ${checkin}
- Check-out: ${checkout}
- Adults: ${guests}
- Budget: ${budgetNote}

STEPS:
1. Call lastminute.com search_flight_and_hotel_package with: origin="${originIATA}", destination="${destIATA || dest}", date_from="${checkin}", date_to="${checkout}", adults="${guests}", sort="price", max_results=5, hotel_stars=${starsFilter}
2. Call kiwi.com search-flight with: flyFrom="${origin}", flyTo="${dest}", departureDate="${depDateKiwi}", returnDate="${retDateKiwi}", passengers={"adults":${guests}}, curr="USD", sort="price"
3. Return ONLY this JSON (no markdown, no extra text):
{"hotels":[{"id":123,"search_id":456,"name":"Hotel Name","stars":3,"rating":8.5,"reviews":500,"dist":1.2,"price_total":450.00,"price_per_night":90,"currency":"GBP","amenities":["WiFi","Pool"],"img":"https://...","cancellable":true,"carrier":"Spirit Airlines","direct":true}],"flights":[{"route":"${originIATA}->${destIATA || dest}","depart":"Jun 1 8:00 AM","arrive":"Jun 1 12:00 PM","returnDepart":"Jun 6 3:00 PM","airline":"Southwest","stops":"Direct","price":298,"currency":"USD","bookUrl":"https://on.kiwi.com/..."}],"search_id":456,"dest":"${dest}"}`;

        const requestBody = JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4000,
          system: 'You are a travel search assistant. Call the MCP tools to get live data. Return ONLY raw JSON, no markdown.',
          messages: [{ role: 'user', content: prompt }],
          mcp_servers: [
            { type: 'url', url: 'https://mcp.lastminute.com/mcp', name: 'lastminute' },
            { type: 'url', url: 'https://mcp.kiwi.com', name: 'kiwi' }
          ]
        });

        // Call Anthropic API from the server (no CORS issues here!)
        const apiResponse = await callAnthropic(requestBody);

        // Extract text from response
        const textBlocks = apiResponse.content
          ? apiResponse.content.filter(b => b.type === 'text').map(b => b.text).join('')
          : '';

        const cleaned = textBlocks.replace(/```json|```/g, '').trim();

        let parsed;
        try {
          parsed = JSON.parse(cleaned);
        } catch (e) {
          // If Claude returned something but couldn't be parsed, send error with raw
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Could not parse AI response', raw: cleaned.substring(0, 300) }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(parsed));

      } catch (err) {
        console.error('Search error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Room options endpoint
  if (req.method === 'POST' && req.url === '/rooms') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { hotelId, searchId, checkin, checkout } = JSON.parse(body);

        const prompt = `Call lastminute.com select_hotel_options: search_id=${searchId}, hotel_internal_id=${hotelId}, date_from="${checkin}", date_to="${checkout}". Return ONLY JSON: {"rooms":[{"name":"Room type","price_total":450,"currency":"GBP","cancellation":"Free cancellation until X","deeplink":"https://..."}]}`;

        const requestBody = JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2000,
          system: 'Call lastminute.com select_hotel_options. Return ONLY raw JSON.',
          messages: [{ role: 'user', content: prompt }],
          mcp_servers: [
            { type: 'url', url: 'https://mcp.lastminute.com/mcp', name: 'lastminute' }
          ]
        });

        const apiResponse = await callAnthropic(requestBody);
        const textBlocks = apiResponse.content
          ? apiResponse.content.filter(b => b.type === 'text').map(b => b.text).join('')
          : '';
        const cleaned = textBlocks.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(cleaned);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(parsed));

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ── Call Anthropic API using Node's built-in https ──
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

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse Anthropic response'));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

server.listen(PORT, () => {
  console.log(`Wanderlust server running on port ${PORT}`);
  console.log(`API key configured: ${ANTHROPIC_API_KEY ? 'YES' : 'NO - set ANTHROPIC_API_KEY env var!'}`);
});

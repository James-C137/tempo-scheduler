import Anthropic from '@anthropic-ai/sdk';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import * as path from 'path';
import * as readline from 'readline';
import * as yaml from 'yaml';

dotenv.config();

// Move function declarations to the top
async function getAuthenticatedClient(): Promise<OAuth2Client> {
  // Load client credentials
  const credPath = path.join(process.cwd(), 'credentials.json');
  if (!fs.existsSync(credPath)) {
    throw new Error('credentials.json not found in project root');
  }
  
  const credentials = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const { client_id, client_secret, redirect_uris } = credentials.installed;
  
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  // Check for existing token
  const tokenPath = path.join(process.cwd(), 'token.json');
  if (fs.existsSync(tokenPath)) {
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }

  // If no token, get new one via user authorization
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
  });
  
  console.log('Authorize this app by visiting this url:', authUrl);
  
  const code = await new Promise<string>((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('Enter the code from that page here: ', (code) => {
      rl.close();
      resolve(code);
    });
  });

  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  
  // Save token for future use
  fs.writeFileSync(tokenPath, JSON.stringify(tokens));
  
  return oAuth2Client;
}

async function getCalendarEvents(auth: OAuth2Client) {
  const calendar = google.calendar({ version: 'v3', auth });
  
  try {
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      timeMax: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // Next 7 days
      singleEvents: true,
      orderBy: 'startTime',
    });

    return response.data.items;
  } catch (error) {
    console.error('Error fetching calendar events:', error);
    throw error;
  }
}

async function getSchedulingSuggestions(
  strategy: any,
  events: any[],
  anthropicKey: string
) {
  if (!anthropicKey) {
    throw new Error('ANTHROPIC_API_KEY not found in environment variables');
  }

  const anthropic = new Anthropic({
    apiKey: anthropicKey,
  });

  const formattedEvents = events.map(event => ({
    summary: event.summary,
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
  }));

  const context = `
You are a scheduling assistant helping to optimize my calendar based on my preferences and existing commitments.

My scheduling strategy:
${yaml.stringify(strategy)}

My current calendar events for the next 7 days:
${JSON.stringify(formattedEvents, null, 2)}

Please analyze my calendar and strategy to provide recommendations. Format your response as a JSON array of recommendations, where each recommendation has the following structure:

{
  "recommendations": [
    {
      "type": "conflict" | "optimization" | "pattern" | "protection",
      "priority": 1-5 (1 being highest priority),
      "recommendation": "Human readable description of what should be done",
      "reason": "Clear explanation of why this change is recommended",
      "action": {
        "type": "create_block" | "move_event" | "add_buffer" | "protect_time" | "split_event" | "delete_event",
        "details": {
          // Specific details needed to implement the action, such as:
          "start": "ISO datetime",
          "end": "ISO datetime",
          "title": "string",
          "description": "string",
          // Additional parameters based on action type
        }
      }
    }
  ]
}

Focus on practical, actionable suggestions that can be implemented programmatically. Ensure all datetime values are in ISO format and aligned with the strategy's time blocks and energy patterns. Consider both immediate fixes and strategic optimizations.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-3-sonnet-20240229",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: context
      }],
      temperature: 0.2, // Lower temperature for more consistent structured output
    });

    if (response.content[0].type !== 'text') {
      throw new Error('Response type is not text');
    }

    // Parse and validate the response
    try {
      const suggestions = JSON.parse(response.content[0].text);
      // Basic validation of structure
      if (!suggestions.recommendations || !Array.isArray(suggestions.recommendations)) {
        throw new Error('Invalid response structure');
      }
      return suggestions;
    } catch (parseError) {
      console.error('Failed to parse Claude response:', parseError);
      console.log('Raw response:', response.content[0].text);
      throw new Error('Failed to parse scheduling suggestions');
    }
  } catch (error) {
    console.error('Error getting suggestions from Claude:', error);
    throw error;
  }
}

async function main() {
  try {
    console.log('Starting time management system...');
    
    const strategy = yaml.parse(
      fs.readFileSync(path.join(__dirname, 'strategy.yaml'), 'utf8')
    );
    console.log('Strategy loaded');
    
    const auth = await getAuthenticatedClient();
    
    const events = await getCalendarEvents(auth);
    console.log(`Found ${events?.length || 0} events for the next 7 days`);
    
    console.log('\nGetting scheduling suggestions...');
    const suggestions = await getSchedulingSuggestions(
      strategy,
      events ?? [],
      process.env.ANTHROPIC_API_KEY!
    );
    
    // Pretty print the structured suggestions
    console.log('\nScheduling Suggestions:');
    suggestions.recommendations.forEach((rec: { type: string; priority: any; recommendation: any; reason: any; action: any; }, index: number) => {
      console.log(`\n[${index + 1}] ${rec.type.toUpperCase()} (Priority: ${rec.priority})`);
      console.log(`Recommendation: ${rec.recommendation}`);
      console.log(`Reason: ${rec.reason}`);
      console.log('Action:', JSON.stringify(rec.action, null, 2));
    });
    
  } catch (error) {
    console.error('Error:', error);
  }
}

if (require.main === module) {
  main().catch(console.error);
}
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
      timeMin: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),  // Last 30 days
      timeMax: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),  // Next 7 days
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
You are a scheduling assistant responsible for maintaining my calendar according to my strategy. Your primary tasks are:
1. Generate calendar events for ALL recurring activities
2. Handle any adhoc requests
3. Optimize existing calendar events

The current time:
${new Date().toISOString()}

My scheduling strategy:
${yaml.stringify(strategy)}

My current calendar events for the next 7 days:
${JSON.stringify(formattedEvents, null, 2)}

IMPORTANT INSTRUCTIONS:
1. For EACH recurring event in the strategy:
   - Create a separate recommendation
   - Schedule it for the next appropriate time slot
   - Follow user rules about timing (e.g., work hours, day start/end times)
   - Consider frequency specified (daily, weekly, etc.)
   - Account for existing calendar events to avoid conflicts

2. For EACH adhoc request:
   - Create a recommendation that fits within the specified timeframe
   - Follow prioritization rules from the strategy

3. Generate recommendations for AT LEAST:
   - All daily recurring events for the next 7 days
   - All weekly recurring events for next occurrence
   - All adhoc requests within their specified timeframes

Format your response as a JSON array of recommendations with this structure:
{
  "recommendations": [
    {
      "priority": "HIGH" | "MEDIUM" | "LOW",
      "recommendation": "Human readable description of what should be done",
      "reason": "Clear explanation of why this scheduling choice was made",
      "calendarAction": {
        "type": "CREATE" | "MOVE" | "DELETE",
        "details": {
          "title": "string",
          "description": "string",
          "startTime": "ISO datetime",
          "endTime": "ISO datetime"
        }
      }
    }
  ]
}

CRITICAL: Ensure you create recommendations for EVERY recurring event and adhoc request, even if you have to make reasonable assumptions about timing and duration. If a recurring event is specified as daily, create 7 instances for the next 7 days.`;
  console.log(context);

  try {
    const response = await anthropic.messages.create({
      model: "claude-3-sonnet-20240229",
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: context
      }, {
        role: 'assistant',
        content: '{'
      }],
      temperature: 0.8, // Lower temperature for more consistent structured output
    });

    if (response.content[0].type !== 'text') {
      throw new Error('Response type is not text');
    }

    // Parse and validate the response
    try {
      const suggestions = JSON.parse('{' + response.content[0].text);
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

interface CalendarRecommendation {
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  recommendation: string;
  reason: string;
  calendarAction: {
    type: 'CREATE' | 'MOVE' | 'DELETE';
    details: {
      title: string;
      description: string;
      startTime: string;
      endTime: string;
    };
  };
}

interface SchedulingSuggestions {
  recommendations: CalendarRecommendation[];
}

async function executeCalendarActions(
  auth: OAuth2Client,
  suggestions: SchedulingSuggestions
): Promise<void> {
  const calendar = google.calendar({ version: 'v3', auth });
  
  console.log(`Processing ${suggestions.recommendations.length} calendar actions...`);

  for (const recommendation of suggestions.recommendations) {
    try {
      const { calendarAction } = recommendation;
      
      switch (calendarAction.type) {
        case 'CREATE': {
          console.log(`Creating event: ${calendarAction.details.title}`);
          
          const event = {
            summary: calendarAction.details.title,
            description: `${calendarAction.details.description}`,
            start: {
              dateTime: calendarAction.details.startTime,
              timeZone: 'America/Los_Angeles', // Consider making this configurable
            },
            end: {
              dateTime: calendarAction.details.endTime,
              timeZone: 'America/Los_Angeles',
            },
            // Add optional metadata to track automated creation
            extendedProperties: {
              private: {
                createdBy: 'time-management-system',
                priority: recommendation.priority,
                timestamp: new Date().toISOString(),
              },
            },
          };

          await calendar.events.insert({
            calendarId: 'primary',
            requestBody: event,
          });
          
          console.log(`✓ Created: ${calendarAction.details.title}`);
          break;
        }

        case 'MOVE': {
          // Implementation for moving events would go here
          console.log('Move event functionality not implemented yet');
          break;
        }

        case 'DELETE': {
          // Implementation for deleting events would go here
          console.log('Delete event functionality not implemented yet');
          break;
        }

        default:
          console.warn(`Unknown action type: ${calendarAction.type}`);
      }
    } catch (error) {
      console.error(`Failed to process recommendation: ${recommendation.title}`, error);
      // Continue processing other recommendations even if one fails
    }
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
    console.log(`Found ${events?.length || 0} events from the past 30 days to the next 7 days`);
    
    console.log('\nGetting scheduling suggestions...');
    const suggestions = await getSchedulingSuggestions(
      strategy,
      events ?? [],
      process.env.ANTHROPIC_API_KEY!
    );
    
    // Pretty print the structured suggestions
    console.log('\nScheduling Suggestions:');
    suggestions.recommendations.forEach((rec: any, index: number) => {
      console.log(`Recommendation ${index + 1}: ${JSON.stringify(rec, null, 2)}`);
    });
    
    // Add a confirmation prompt
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const proceed = await new Promise<boolean>((resolve) => {
      readline.question('\nDo you want to execute these calendar actions? (y/n) ', (answer: string) => {
        readline.close();
        resolve(answer.toLowerCase() === 'y');
      });
    });

    if (proceed) {
      console.log('\nExecuting calendar actions...');
      await executeCalendarActions(auth, suggestions);
      console.log('Calendar updates complete!');
    } else {
      console.log('Calendar actions cancelled.');
    }
  } catch (error) {
    console.error('Error:', error);
  }
}



if (require.main === module) {
  main().catch(console.error);
}
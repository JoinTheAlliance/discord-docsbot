/**
 * The core server that runs on a Cloudflare worker.
 */

import { SupabaseClient, createClient } from '@supabase/supabase-js';
import { BgentRuntime, type Content, type Message } from 'bgent';
import { UUID } from 'crypto';
import {
  InteractionResponseType,
  InteractionType,
  verifyKey,
} from 'discord-interactions';
import { Router } from 'itty-router';
import getUuid from 'uuid-by-string';

// Add this function to fetch the bot's name
async function fetchBotName(botToken: string) {
  const url = 'https://discord.com/api/v9/users/@me';

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bot ${botToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Error fetching bot details: ${response.statusText}`);
  }

  const data = await response.json();
  return data.username; // Or data.tag for username#discriminator
}

// Modify this function to include fetching the bot's name if the user is an agent
async function ensureUserExists(supabase: SupabaseClient, userId: UUID, userName: string | null, botToken?: string) {
  let { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', userId)
    .single();

  if (!data) {
    // If userName is not provided and botToken is, fetch the bot's name
    if (!userName && botToken) {
      try {
        userName = await fetchBotName(botToken);
      } catch (err) {
        console.error('Error fetching bot name:', err);
        return;
      }
    }

    // User does not exist, so create them
    const { error } = await supabase
      .from('accounts')
      .insert([{ id: userId, name: userName, email: userName + '@discord', register_complete: true }]);

    if (error) {
      console.error('Error creating user:', error);
    } else {
      console.log(`User ${userName} created successfully.`);
    }
  }
}


// Function to ensure a room exists
async function ensureRoomExists(supabase: SupabaseClient, roomId: UUID) {
  let { data, error } = await supabase
    .from('rooms') // Replace 'rooms' with your actual rooms table name
    .select('*')
    .eq('id', roomId)
    .single();

  if (!data) {
    // Room does not exist, so create it
    const { error } = await supabase
      .from('rooms') // Replace 'rooms' with your actual rooms table name
      .insert([{ id: roomId }]);

    if (error) {
      console.error('Error creating room:', error);
    } else {
      console.log(`Room ${roomId} created successfully.`);
    }
  }
}

// Function to ensure a participant is linked to a room
async function ensureParticipantInRoom(supabase: SupabaseClient, userId: UUID, roomId: UUID) {
  let { data, error } = await supabase
    .from('participants') // Replace 'participants' with your actual participants table name
    .select('*')
    .eq('user_id', userId)
    .eq('room_id', roomId)
    .single();

  if (!data) {
    // Participant does not exist, so link user to room
    const { error } = await supabase
      .from('participants') // Replace 'participants' with your actual participants table name
      .insert([{ user_id: userId, room_id: roomId }]);

    if (error) {
      console.error('Error linking user to room:', error);
    } else {
      console.log(`User ${userId} linked to room ${roomId} successfully.`);
    }
  }
}

/**
 * Share command metadata from a common spot to be used for both runtime
 * and registration.
 */

const TEST_COMMAND = {
  name: 'help',
  description: 'Ask a question about A-Frame.',
  options: [
    {
      name: 'question',
      description: 'The question to ask.',
      type: 3,
      required: false,
    },
  ],
};

class JsonResponse extends Response {
  constructor(body: BodyInit | unknown, init: ResponseInit) {
    const jsonBody = JSON.stringify(body);
    init = init || {
      headers: {
        'content-type': 'application/json;charset=UTF-8',
      },
    };
    super(jsonBody, init);
  }
}

const router = Router();

/**
 * A simple :wave: hello page to verify the worker is working.
 */
router.get('/', (_request, env) => {
  return new Response(`👋 ${env.DISCORD_APPLICATION_ID}`);
});

/**
 * Refresh the commands
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
router.get('/commands', async (_request, env) => {
  const token = env.DISCORD_TOKEN;
  const applicationId = env.DISCORD_APPLICATION_ID;

  if (!token) {
    throw new Error('The DISCORD_TOKEN environment variable is required.');
  }
  if (!applicationId) {
    throw new Error(
      'The DISCORD_APPLICATION_ID environment variable is required.',
    );
  }

  /**
   * Register all commands globally.  This can take o(minutes), so wait until
   * you're sure these are the commands you want.
   */
  const url = `https://discord.com/api/v10/applications/${applicationId}/commands`;

  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${token}`,
    },
    method: 'PUT',
    body: JSON.stringify([TEST_COMMAND]),
  });

  if (response.ok) {
    console.log('Registered all commands');
    const data = await response.json();
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.error('Error registering commands');
    let errorText = `Error registering commands \n ${response.url}: ${response.status} ${response.statusText}`;
    try {
      const error = await response.text();
      if (error) {
        errorText = `${errorText} \n\n ${error}`;
      }
    } catch (err) {
      console.error('Error reading body from request:', err);
    }
    console.error(errorText);
  }
  return new Response('Commands refreshed');
});

/**
 * Main route for all requests sent from Discord.  All incoming messages will
 * include a JSON payload described here:
 * https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object
 */
router.post('/', async (request, env) => {
  const { isValid, interaction } = await server.verifyDiscordRequest(
    request,
    env,
  );
  console.log('interaction', interaction);
  if (!isValid || !interaction) {
    return new Response('Bad request signature.', { status: 401 });
  }

  if (interaction.type === InteractionType.PING) {
    // The `PING` message is used during the initial webhook handshake, and is
    // required to configure the webhook in the developer portal.
    // @ts-expect-error this is what was in the example
    return new JsonResponse({
      type: InteractionResponseType.PONG,
    });
  }

  console.log('interaction', interaction);

  // handle on TEST_COMMAND
  // TODO: also handle if user pings the agent
  if (
    interaction.type === InteractionType.APPLICATION_COMMAND &&
    interaction.data.name === TEST_COMMAND.name
  ) {
    const supabase = createClient(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_API_KEY,
      {
        auth: { persistSession: false },
      },
    );

    // Extract the user's Discord ID and convert it into a UUID
    const userId = getUuid(interaction.member.user.id) as UUID;

    const runtime = new BgentRuntime({
      debugMode: false,
      serverUrl: 'https://api.openai.com/v1',
      supabase: supabase,
      token: env.OPENAI_API_KEY,
    });

    let responseContent;

    // Check if there's additional text with the /help command
    if (!interaction.data.options || interaction.data.options.length === 0) {
      // No additional text provided, respond with a generic message
      responseContent =
        'Sure, what do you want me to help you with? Ask me a question!';
    } else {
      // Additional text provided, process it with Bgent runtime
      const messageContent = interaction.data.options[0].value; // Assuming the first option contains the text
      const agentId = getUuid(env.DISCORD_APPLICATION_ID) as UUID;
      const room_id = getUuid(interaction.channel_id) as UUID;
      const message = {
        content: { content: messageContent },
        senderId: userId,
        agentId,
        userIds: [userId, agentId],
        room_id,
      } as unknown as Message;

      const userName = interaction.member.user.username; // Assuming this is how you get the user's Discord username

      // TODO: This could probably be done more efficiently, 5 database calls for every message is a lot...
      await Promise.all([
        ensureUserExists(supabase, userId, userName),
        ensureUserExists(supabase, agentId, null, env.DISCORD_TOKEN),
        ensureRoomExists(supabase, room_id),
        ensureParticipantInRoom(supabase, userId, room_id),
        ensureParticipantInRoom(supabase, agentId, room_id)
      ]);

      const data = (await runtime.handleRequest(message)) as Content;
      responseContent = `You asked: \`\`\`\n${messageContent}\`\`\`\n${data.content}`; // Assuming 'data.content' contains the response text from Bgent
    }
    // @ts-expect-error this is what was in the example
    return new JsonResponse({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: responseContent },
    });
  }

  // Fallback for unknown types or commands
  return new JsonResponse({ error: 'Unknown Type' }, { status: 400 });
});

router.all('*', () => new Response('Not Found.', { status: 404 }));

async function verifyDiscordRequest(
  request: Request,
  env: { [key: string]: string },
) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();
  const isValidRequest =
    signature &&
    timestamp &&
    verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);
  if (!isValidRequest) {
    return { isValid: false };
  }

  return { interaction: JSON.parse(body), isValid: true };
}

const server = {
  verifyDiscordRequest: verifyDiscordRequest,
  fetch: async function (request: Request, env: { [key: string]: string }) {
    return router.handle(request, env);
  },
};

export default server;

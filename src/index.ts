/**
 * The core server that runs on a Cloudflare worker.
 */

import { createClient } from '@supabase/supabase-js';
import { BgentRuntime, type Content, type Message } from 'bgent';
import { type UUID } from 'crypto';
import {
  InteractionResponseType,
  InteractionType,
  verifyKey,
} from 'discord-interactions';
import { Router } from 'itty-router';
import getUuid from 'uuid-by-string';

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
    const userId = interaction.member.user.id;

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

      const message = {
        content: { content: messageContent },
        senderId: getUuid(userId),
        agentId: getUuid(env.DISCORD_APPLICATION_ID),
        userIds: [getUuid(userId), getUuid(env.DISCORD_APPLICATION_ID)],
      } as unknown as Message;

      const data = (await runtime.handleRequest(message)) as Content;
      responseContent = data.content; // Assuming 'data.content' contains the response text from Bgent
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

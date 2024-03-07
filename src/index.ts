/**
 * The core server that runs on a Cloudflare worker.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import {
  BgentRuntime,
  wait,
  type Message,
  type Content,
  embeddingZeroVector,
  State,
  parseJSONObjectFromText,
  composeContext,
  messageHandlerTemplate,
} from 'bgent';
import { UUID } from 'crypto';
import {
  InteractionResponseType,
  InteractionType,
  verifyKey,
} from 'discord-interactions';
import { Router } from 'itty-router';
import {
  ProcessDocsParams,
  vectorizeDocuments,
  fetchLatestPullRequest,
} from './docs';
import getUuid from 'uuid-by-string';
import { Octokit } from 'octokit';
import { OpenAI } from 'openai';
import { searchSimilarMessages } from './searchForSimilarVectorizedDocs';
import { updateMessageContent } from './updatePromptToBgentWithDocs';
import { initializeOpenAi } from './openAiHelperFunctions';
import { initializeSupabase } from './supabaseHelperFunctions';
import { BodyInit } from 'openai/_shims';

let openai: OpenAI;
let supabase: SupabaseClient;
let processDocsParams: ProcessDocsParams;
let resetProcessDocsParams = true;

/**
 * Handle an incoming message, processing it and returning a response.
 * @param message The message to handle.
 * @param state The state of the agent.
 * @returns The response to the message.
 */
async function handleMessage(
  runtime: BgentRuntime,
  message: Message,
  state?: State,
) {
  const _saveRequestMessage = async (message: Message, state: State) => {
    const { content: senderContent /* senderId, userIds, room_id */ } = message;

    // we run evaluation here since some evals could be modulo based, and we should run on every message
    if ((senderContent as Content).content) {
      const { data: data2, error } = await runtime.supabase
        .from('messages')
        .select('*')
        .eq('user_id', message.senderId)
        .eq('room_id', room_id)
        .order('created_at', { ascending: false });

      if (error) {
        console.log('error', error);
        // TODO: dont need this recall
      } else if (data2.length > 0 && data2[0].content === message.content) {
        console.log('already saved', data2);
      } else {
        await runtime.messageManager.createMemory({
          user_ids: [message.senderId, message.agentId, ...message.userIds],
          user_id: senderId!,
          content: senderContent,
          room_id,
          embedding: embeddingZeroVector,
        });
      }
      await runtime.evaluate(message, state);
    }
  };

  await _saveRequestMessage(message, state as State);
  // if (!state) {
  state = (await runtime.composeState(message)) as State;
  // }

  const context = composeContext({
    state,
    template: messageHandlerTemplate,
  });

  if (runtime.debugMode) {
    console.log(context, 'Response Context');
  }

  let responseContent: Content | null = null;
  const { senderId, room_id, userIds: user_ids, agentId } = message;

  for (let triesLeft = 3; triesLeft > 0; triesLeft--) {
    console.log(context);
    const response = await runtime.completion({
      context,
      stop: [],
    });

    runtime.supabase
      .from('logs')
      .insert({
        body: { message, context, response },
        user_id: senderId,
        room_id,
        user_ids: user_ids!,
        agent_id: agentId!,
        type: 'main_completion',
      })
      .then(({ error }) => {
        if (error) {
          console.error('error', error);
        }
      });

    const parsedResponse = parseJSONObjectFromText(
      response,
    ) as unknown as Content;

    if (
      (parsedResponse.user as string)?.includes(
        (state as State).agentName as string,
      )
    ) {
      responseContent = {
        content: parsedResponse.content,
        action: parsedResponse.action,
      };
      break;
    }
  }

  if (!responseContent) {
    responseContent = {
      content: '',
      action: 'IGNORE',
    };
  }

  const _saveResponseMessage = async (
    message: Message,
    state: State,
    responseContent: Content,
  ) => {
    const { agentId, userIds, room_id } = message;

    responseContent.content = responseContent.content?.trim();

    if (responseContent.content) {
      await runtime.messageManager.createMemory({
        user_ids: userIds!,
        user_id: agentId!,
        content: responseContent,
        room_id,
        embedding: embeddingZeroVector,
      });
      await runtime.evaluate(message, { ...state, responseContent });
    } else {
      console.warn('Empty response, skipping');
    }
  };

  await _saveResponseMessage(message, state, responseContent);
  await runtime.processActions(message, responseContent);

  return responseContent;
}

// Add this function to fetch the bot's name
async function fetchBotName(botToken: string) {
  const url = 'https://discord.com/api/v10/users/@me';

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bot ${botToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Error fetching bot details: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    username: string;
    discriminator: string;
  };
  return data.username; // Or data.tag for username#discriminator
}

// Modify this function to include fetching the bot's name if the user is an agent
async function ensureUserExists(
  supabase: SupabaseClient,
  userId: UUID,
  userName: string | null,
  botToken?: string,
) {
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) {
    console.error('Error fetching user:', error);
  }

  if (data) {
    console.log('User exists:', data);
  }

  if (!data) {
    // If userName is not provided and botToken is, fetch the bot's name
    if (!userName && botToken) {
      userName = await fetchBotName(botToken);
    }

    // User does not exist, so create them
    const { error } = await supabase.from('accounts').insert([
      {
        id: userId,
        name: userName,
        email: userName + '@discord',
        register_complete: true,
      },
    ]);

    if (error) {
      console.error('Error creating user:', error);
    } else {
      console.log(`User ${userName} created successfully.`);
    }
  }
}

// Function to ensure a room exists
async function ensureRoomExists(supabase: SupabaseClient, roomId: UUID) {
  const { data, error } = await supabase
    .from('rooms') // Replace 'rooms' with your actual rooms table name
    .select('*')
    .eq('id', roomId)
    .single();

  if (error) {
    console.error('Error fetching room:', error);
  }

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
async function ensureParticipantInRoom(
  supabase: SupabaseClient,
  userId: UUID,
  roomId: UUID,
) {
  const { data, error } = await supabase
    .from('participants') // Replace 'participants' with your actual participants table name
    .select('*')
    .eq('user_id', userId)
    .eq('room_id', roomId)
    .single();

  if (error) {
    console.error('Error fetching participant:', error);
  }

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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
router.get('/refresh-docs', async (request, _env) => {
  const pullRequestNumber: string = request.query.pr_number?.toString() ?? '';
  if (!pullRequestNumber) {
    return new Response('Pull request number is required.', { status: 400 });
  }

  await initializeSupabaseAndOpenAIVariable(_env);
  await fetchLatestPullRequest(processDocsParams, pullRequestNumber);
  resetProcessDocsParams = true;

  return new Response(
    `Docs from pull request #${pullRequestNumber} refreshed.`,
  );
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
router.get('/refresh-all-docs', async (_request, _env) => {
  await initializeSupabaseAndOpenAIVariable(_env);
  await vectorizeDocuments(processDocsParams);

  return new Response('All docs refreshed.');
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
    const error = await response.text();
    if (error) {
      errorText = `${errorText} \n\n ${error}`;
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
router.post('/', async (request, env, event) => {
  const { isValid, interaction } = await server.verifyDiscordRequest(
    request,
    env,
  );

  if (!isValid || !interaction) {
    return new Response('Bad request signature.', { status: 401 });
  }

  if (interaction.type === InteractionType.PING) {
    // @ts-expect-error - This is a valid response type
    return new JsonResponse({ type: InteractionResponseType.PONG });
  }

  if (
    interaction.type === InteractionType.APPLICATION_COMMAND &&
    interaction.data.name === TEST_COMMAND.name
  ) {
    const userId = getUuid(interaction?.member?.user?.id) as UUID;
    const userName = interaction?.member?.user?.username;
    const agentId = getUuid(env.DISCORD_APPLICATION_ID) as UUID;
    const room_id = getUuid(interaction.channel_id) as UUID;

    console.log('User info: ', interaction?.member?.user);
    console.log('got ids');

    // // Ensure all necessary records exist in Supabase
    await initializeSupabaseAndOpenAIVariable(env);
    await ensureUserExists(supabase, agentId, null, env.DISCORD_TOKEN);
    console.log('ensured user exists');
    await ensureUserExists(supabase, userId, userName);
    await ensureRoomExists(supabase, room_id);
    await ensureParticipantInRoom(supabase, userId, room_id);
    await ensureParticipantInRoom(supabase, agentId, room_id);

    const messageContent = interaction.data.options[0].value;
    console.log('interaction.data', interaction.data);

    // Searches the database for the top5 similar documents relating to the message with a similarity of a certain threshold
    const priorPromptKnowledgeFromDocs = await searchSimilarMessages(
      messageContent,
      supabase,
      openai,
    );

    const newContent = await updateMessageContent(
      priorPromptKnowledgeFromDocs,
      messageContent,
    );

    const message = {
      content: { content: newContent?.promptHeader },
      senderId: userId,
      agentId,
      userIds: [userId, agentId],
      room_id,
    } as unknown as Message;

    console.log('final message: ', message);

    const runtime = new BgentRuntime({
      debugMode: true,
      serverUrl: 'https://api.openai.com/v1',
      supabase: supabase,
      token: env.OPENAI_API_KEY,
      evaluators: [],
      actions: [wait],
    });

    // Immediately acknowledge the interaction with a deferred response
    // @ts-expect-error - This is a valid response type
    const deferredResponse = new JsonResponse({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    });

    event.waitUntil(
      (async () => {
        let responseContent = 'How can I assist you with A-Frame?'; // Default response
        try {
          const data = (await handleMessage(runtime, message)) as Content;

          responseContent = `> ${messageContent}\n\n**<@${interaction?.member?.user?.id}> ${data.content}**`;

          const newContentLength = newContent?.sourceUrls?.length ?? 0;
          if (newContentLength > 0) {
            responseContent += '\n\nRelated documentation links:\n';
            for (let i = 0; i < newContentLength; i++) {
              const htmlLink = newContent?.sourceUrls[i].replace(
                /\.md/g,
                '.html',
              );
              responseContent += `- <${htmlLink}>\n`;
            }
          }

          const followUpUrl = `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`;

          // Send the follow-up message with the actual response
          console.log('followUpUrl', followUpUrl);
          const followUpResponse = await fetch(followUpUrl, {
            method: 'PATCH', // Use PATCH to edit the original deferred message
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bot ${env.DISCORD_TOKEN}`,
            },
            body: JSON.stringify({ content: responseContent }),
          });

          console.log('Follow-up response status:', followUpResponse);
          const followUpData = (await followUpResponse.json()) as {
            errors: { content: string };
          };
          console.log(
            'Follow-up response data:',
            followUpData?.errors?.content,
          );
        } catch (error) {
          console.error('Error processing command:', error);
        }
      })(),
    );

    // Return the deferred response to Discord immediately
    return deferredResponse;
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
  fetch: async function (
    request: Request,
    env: { [key: string]: string },
    // @ts-expect-error - This is a valid event type
    event,
  ) {
    return router.handle(request, env, event);
  },
};

async function initializeSupabaseAndOpenAIVariable(env: {
  [key: string]: string;
}) {
  if (!openai) {
    openai = initializeOpenAi(env.OPENAI_API_KEY);
  }

  if (!supabase) {
    // Initialize Supabase
    supabase = initializeSupabase(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_API_KEY,
    );
  }

  // Establish parameters for processing documentation.
  if (resetProcessDocsParams) {
    processDocsParams = {
      supabase: supabase,
      openai: openai,
      octokit: new Octokit({ auth: env.GITHUB_AUTH_TOKEN }),
      repoOwner: process.env.REPO_OWNER ?? 'aframevr',
      repoName: process.env.REPO_NAME ?? 'aframe',
      pathToRepoDocuments: 'docs',
      documentationFileExt: 'md',
      sectionDelimiter: '#',
      sourceDocumentationUrl:
        process.env.DOCUMENTATION_URL ?? 'https://aframe.io/docs/master/',
    };

    resetProcessDocsParams = false;
  }
}

export default server;

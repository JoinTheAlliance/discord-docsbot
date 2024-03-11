/**
 * The core server that runs on a Cloudflare worker.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import {
  BgentRuntime,
  State,
  addLore,
  composeContext,
  embeddingZeroVector,
  messageHandlerTemplate,
  parseJSONObjectFromText,
  wait,
  type Content,
  type Message,
  SupabaseDatabaseAdapter,
} from 'bgent';
import { UUID } from 'crypto';
import {
  InteractionResponseType,
  InteractionType,
  verifyKey,
} from 'discord-interactions';
import { Router } from 'itty-router';
import { Octokit } from 'octokit';
import getUuid from 'uuid-by-string';
import { searchSimilarMessages } from './searchForSimilarVectorizedDocs';
import { initializeSupabase } from './supabaseHelperFunctions';
import { updateMessageContent } from './updatePromptToBgentWithDocs';

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
      const { data: data2, error } = await supabase
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

    supabase
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
  constructor(
    body: { type?: InteractionResponseType; error?: string },
    init: ResponseInit,
  ) {
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
router.get('/refresh-docs', async (request, env) => {
  const pullRequestNumber: string = request.query.pr_number?.toString() ?? '';
  if (!pullRequestNumber) {
    return new Response('Pull request number is required.', { status: 400 });
  }

  await initializeSupabaseAndOpenAIVariable(env);

  // Fetch the files modified in the specified pull request
  const response = await processDocsParams.octokit.request(
    'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
    {
      owner: processDocsParams.repoOwner,
      repo: processDocsParams.repoName,
      pull_number: parseInt(pullRequestNumber),
      per_page: 100,
    },
  );

  // Filter the modified files to only include documentation files
  const modifiedDocuments = response.data.filter((file: { filename: string }) =>
    file.filename.startsWith(processDocsParams.pathToRepoDocuments),
  );

  // Queue the modified documents with their source URL and callback URL
  const queuedDocuments = modifiedDocuments.map(
    (doc: { filename: string }) => ({
      sourceUrl: doc.filename,
      callbackUrl: env.CALLBACK_URL,
    }),
  );

  const { error: insertError } = await supabase
    .from('documents')
    .insert(queuedDocuments);

  if (insertError) {
    console.error('Error queueing documents:', insertError);
    return new Response('Failed to queue documents', { status: 500 });
  }

  resetProcessDocsParams = true;

  return new Response(
    `Docs from pull request #${pullRequestNumber} queued for vectorization.`,
  );
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
router.get('/refresh-all-docs', async (_request, env) => {
  await initializeSupabaseAndOpenAIVariable(env);

  // Get all document names and queue them
  const { data: documents, error } = await supabase
    .from('documents')
    .select('sourceUrl');

  if (error) {
    console.error('Error fetching documents:', error);
    return new Response('Failed to fetch documents', { status: 500 });
  }

  // Queue the documents with their source URL and callback URL
  const queuedDocuments = documents.map((doc: { sourceUrl: string }) => ({
    sourceUrl: doc.sourceUrl,
    callbackUrl: env.CALLBACK_URL,
  }));

  const { error: insertError } = await supabase
    .from('documents')
    .insert(queuedDocuments);

  if (insertError) {
    console.error('Error queueing documents:', insertError);
    return new Response('Failed to queue documents', { status: 500 });
  }

  return new Response('Documents queued for vectorization');
});

router.post('/vectorize-document', async (request, _env) => {
  const { id, sourceUrl } = (await request.json()) as {
    id: string;
    sourceUrl: string;
  };

  await initializeSupabaseAndOpenAIVariable(_env);

  try {
    // Fetch the document content from GitHub
    const response = await processDocsParams.octokit.request(
      'GET /repos/{owner}/{repo}/contents/{path}',
      {
        owner: processDocsParams.repoOwner,
        repo: processDocsParams.repoName,
        path: sourceUrl,
      },
    );

    const decodedContent = Buffer.from(
      (response.data as { content: string }).content,
      'base64',
    ).toString('utf-8');

    // Vectorize the document and save it to the 'lore' table
    const { sections } = sectionizeDocument(
      decodedContent,
      processDocsParams.sectionDelimiter,
    );
    const updatedPath = sourceUrl.replace('docs/', '');
    const runtime = new BgentRuntime({
      debugMode: true,
      serverUrl: 'https://api.openai.com/v1',
      databaseAdapter: new SupabaseDatabaseAdapter(
        processDocsParams.env.SUPABASE_URL,
        processDocsParams.env.SUPABASE_SERVICE_API_KEY,
      ),
      token: processDocsParams.env.OPENAI_API_KEY,
      evaluators: [],
      actions: [wait],
    });

    for (const section of sections) {
      await addLore({
        runtime,
        content: { content: section },
        source: processDocsParams.sourceDocumentationUrl + updatedPath,
      });
    }

    // Delete the document from the 'documents' table after vectorization
    const { error } = await supabase.from('documents').delete().eq('id', id);

    if (error) {
      console.error('Error deleting document:', error);
      return new Response('Failed to delete document', { status: 500 });
    }

    return new Response('Document vectorized successfully');
  } catch (error) {
    console.error('Error vectorizing document:', error);
    return new Response('Failed to vectorize document', { status: 500 });
  }
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
  const { isValid, interaction } = await verifyDiscordRequest(request, env);

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

    const runtime = new BgentRuntime({
      debugMode: true,
      serverUrl: 'https://api.openai.com/v1',
      databaseAdapter: new SupabaseDatabaseAdapter(
        env.SUPABASE_URL,
        env.SUPABASE_SERVICE_API_KEY,
      ),
      token: env.OPENAI_API_KEY,
      evaluators: [],
      actions: [wait],
    });

    // Searches the database for the top5 similar documents relating to the message with a similarity of a certain threshold
    const priorPromptKnowledgeFromDocs = await searchSimilarMessages(
      messageContent,
      supabase,
      runtime,
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

async function initializeSupabaseAndOpenAIVariable(env: {
  [key: string]: string;
}) {
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
      octokit: new Octokit({ auth: env.GITHUB_AUTH_TOKEN }),
      repoOwner: process.env.REPO_OWNER ?? 'aframevr',
      repoName: process.env.REPO_NAME ?? 'aframe',
      pathToRepoDocuments: 'docs',
      documentationFileExt: 'md',
      sectionDelimiter: '#',
      env: env,
      sourceDocumentationUrl:
        process.env.DOCUMENTATION_URL ?? 'https://aframe.io/docs/master/',
    };

    resetProcessDocsParams = false;
  }
}

export default {
  fetch: async function (
    request: Request,
    env: { [key: string]: string },
    // @ts-expect-error - This is a valid event type
    event,
  ) {
    return router.handle(request, env, event);
  },
};

export interface ProcessDocsParams {
  supabase: SupabaseClient;
  octokit: Octokit;
  repoOwner: string;
  repoName: string;
  pathToRepoDocuments: string;
  documentationFileExt: string;
  sectionDelimiter: string;
  sourceDocumentationUrl: string;
  env: { [key: string]: string };
}

/**
 * Splits a document into logical sections by a delimiter.
 * Currently only works for Markdown (.MD) files.
 * @param {string} documentContent - The content of the file.
 * @param {string} sectionDelimiter - Character sequence to sectionize the file content.
 * @returns {object} - The document sections (`sections`) and documentation URL (`url`).
 */
function sectionizeDocument(documentContent: string, sectionDelimiter: string) {
  // Retrieve YAML header and extract out documentation url path.
  const yamlHeader = documentContent.match(/---\n([\s\S]+?)\n---/);

  // Split the remaining content into sections based on the YAML header and delimiter.
  const delim = new RegExp(`\\n+${sectionDelimiter}+\\s+`);
  const sections = documentContent
    .replace(yamlHeader ? yamlHeader[0] : '', '')
    .split(delim);

  // Debug
  //printSectionizedDocument(sections);

  return { sections: sections };
}

/**
 * Retrieves, processes, and stores all documents on a GitHub repository to a
 * pgvector in Supabase. Currently only supports Markdown (.MD) files.
 * @param {ProcessDocsParams} params - An object that conforms to the ProcessDocsParams interface.
 */
async function makeRequest(
  octokit: Octokit,
  requestOptions: {
    method: string;
    url: string;
    owner: string;
    repo: string;
    path?: string;
    headers:
      | { 'X-GitHub-Api-Version': string }
      | { 'X-GitHub-Api-Version': string }
      | { 'X-GitHub-Api-Version': string }
      | { 'X-GitHub-Api-Version': string };
    pull_number?: number;
    per_page?: number;
    page?: number;
  },
) {
  try {
    const response = await octokit.request(requestOptions);
    return response;
    // @ts-expect-error - weird error
  } catch (error: { status: number; headers: { [x: string]: string } }) {
    if (
      error.status === 403 &&
      error.headers['x-ratelimit-remaining'] === '0'
    ) {
      const retryAfter =
        parseInt(error.headers['x-ratelimit-reset'], 10) -
        Math.floor(Date.now() / 1000);
      console.log(`Rate limited. Retrying in ${retryAfter} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      return makeRequest(octokit, requestOptions);
    } else {
      throw error;
    }
  }
}

export async function vectorizeDocuments(params: ProcessDocsParams) {
  try {
    const {
      octokit,
      repoOwner,
      repoName,
      pathToRepoDocuments,
      documentationFileExt,
      sectionDelimiter,
      sourceDocumentationUrl,
      env,
    } = params;

    // Fetch the documentation directories or files.
    let response = await makeRequest(octokit, {
      method: 'GET',
      url: '/repos/{owner}/{repo}/contents/{path}',
      owner: repoOwner,
      repo: repoName,
      path: pathToRepoDocuments,
      headers: {
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    response.data = Array.isArray(response.data)
      ? response.data
      : [response.data];

    // Process documents in each directory.
    for (const resData of response.data) {
      let dirDocuments = [];
      if (resData.type == 'dir') {
        console.log('requesting dir: ', resData.name);
        // Fetch all files from the directory.
        response = await makeRequest(octokit, {
          method: 'GET',
          url: '/repos/{owner}/{repo}/contents/{path}',
          owner: repoOwner,
          repo: repoName,
          path: pathToRepoDocuments + '/' + resData.name,
          headers: {
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });

        const documentsArray = response.data as {
          name: string;
          path: string;
        }[];
        dirDocuments = documentsArray.filter((document) =>
          document.name.endsWith(`.${documentationFileExt}`),
        );
      } else if (resData.type == 'file') {
        dirDocuments = [resData];
      } else {
        throw new Error('Repository URL does not exist!');
      }

      // Retrieve and process document data for each document sequentially.
      for (const document of dirDocuments) {
        console.log('requesting doc: ', document.path);
        const contentResponse = await makeRequest(octokit, {
          method: 'GET',
          url: '/repos/{owner}/{repo}/contents/{path}',
          owner: repoOwner,
          repo: repoName,
          path: document.path,
          headers: {
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });

        const decodedContent = Buffer.from(
          (contentResponse.data as { content: string }).content,
          'base64',
        ).toString('utf-8');
        const { sections } = sectionizeDocument(
          decodedContent,
          sectionDelimiter,
        );
        const updatedPath = document.path.replace('docs/', '');
        const runtime = new BgentRuntime({
          debugMode: true,
          serverUrl: 'https://api.openai.com/v1',
          databaseAdapter: new SupabaseDatabaseAdapter(
            env.SUPABASE_URL,
            env.SUPABASE_SERVICE_API_KEY,
          ),
          token: env.OPENAI_API_KEY,
          evaluators: [],
          actions: [wait],
        });
        for (const document of sections) {
          await addLore({
            runtime,
            content: { content: document },
            source: sourceDocumentationUrl + updatedPath,
          });
        }
      }
      // wait 200 ms
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } catch (error) {
    console.error('Error fetching data from GitHub API:', error);
  }
}

export async function fetchLatestPullRequest(
  params: ProcessDocsParams,
  pullRequestNum: string,
) {
  try {
    const { octokit, repoOwner, repoName, pathToRepoDocuments } = params;

    const page = 1;

    const response = await makeRequest(octokit, {
      method: 'GET',
      url: '/repos/{owner}/{repo}/pulls/{pull_number}/files',
      owner: repoOwner,
      repo: repoName,
      pull_number: parseInt(pullRequestNum),
      per_page: 100,
      page: page,
      headers: {
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    // Iterate over each file path sequentially
    for (const filePath of response.data) {
      if (filePath.filename.includes(`${pathToRepoDocuments}/`)) {
        params.pathToRepoDocuments = filePath.filename as string;
        await vectorizeDocuments(params); // Process each document one by one
        // wait 200 ms
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    // wait 200 ms
    await new Promise((resolve) => setTimeout(resolve, 200));
  } catch (error) {
    console.error('Error fetching data from GitHub API:', error);
  }
}

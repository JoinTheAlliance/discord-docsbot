import { Octokit } from 'octokit';
import openai from 'openai';
import { SupabaseClient } from '@supabase/supabase-js';
import { generateEmbeddings } from './embeddingCreation/createSectionEmbeddings';

export interface ProcessDocsParams {
  supabase: SupabaseClient;
  openai: openai;
  octokit: Octokit;
  repoOwner: string;
  repoName: string;
  pathToRepoDocuments: string;
  documentationFileExt: string;
  sectionDelimiter: string;
  sourceDocumentationUrl: string;
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
      supabase,
      openai,
      octokit,
      repoOwner,
      repoName,
      pathToRepoDocuments,
      documentationFileExt,
      sectionDelimiter,
      sourceDocumentationUrl,
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

        // Type assertion for response.data
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

      // Retrieve document data for all docs to process.
      await Promise.all(
        dirDocuments.map(async (document) => {
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
          await generateEmbeddings(
            sections,
            sourceDocumentationUrl + updatedPath,
            supabase,
            openai,
          );
        }),
      );
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

    await Promise.all(
      response.data.map(async (filePath: { filename: string | string[] }) => {
        if (filePath.filename.includes(`${pathToRepoDocuments}/`)) {
          params.pathToRepoDocuments = filePath.filename as string;
          await vectorizeDocuments(params);
        }
      }),
    );
  } catch (error) {
    console.error('Error fetching data from GitHub API:', error);
  }
}

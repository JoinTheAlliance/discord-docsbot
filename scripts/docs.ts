import { Octokit } from "octokit";
import openai from 'openai';
import { SupabaseClient } from '@supabase/supabase-js';
import { generateEmbeddings } from '../scripts/embeddingCreation/createSectionEmbeddings';

export interface ProcessDocsParams {
  supabase: SupabaseClient;
  openai: openai;
  octokit: Octokit
  repoOwner: string;
  repoName: string;
  pathToRepoDocuments: string;
  documentationFileExt: string;
  sectionDelimiter: string;
  sourceDocumentationUrl: string;
}

/**
 * Prints the documentation URL and sections for a document. Used for testing.
 *
 * @param {string[]} sections - All the sections from a document.
 * @param {string} docURL - The URL where the documentation is located.
 */
function printSectionizedDocument(
  sections: string[],
  docURL: string
): void {
  console.log(`https://aframe.io/docs/master/${docURL}\n`);
  sections.forEach((section, index) => {
    console.log(`Section ${index + 1}:`);
    console.log(section.trim() + '\n');
  });
}
  
/**
 * Splits a document into logical sections by a delimiter.
 * Currently only works for Markdown (.MD) files.
 *
 * @param {string} documentContent - The content of the file.
 * @param {string} sectionDelimiter - Character sequence to sectionize the file content.
 * @returns {object} - The document sections (`sections`) and documentation URL (`url`).
 */
function sectionizeDocument(
  documentContent: string,
  sectionDelimiter: string
): { sections: string[]; urlPath: string } {
  // Retrieve YAML header and extract out documentation url path.
  const yamlHeader = documentContent.match(/---\n([\s\S]+?)\n---/);
  let documentationUrl: string = ""
  if (yamlHeader) {
      let section = yamlHeader[1].trim();
      const matchResult = section.match(/source_code:\s*src\/(.+)/);

      if (matchResult && matchResult[1]) {
        documentationUrl = matchResult[1].trim().replace(/\.js$/, '');
      } else {
          // Handle the case where the match or the group [1] is null or undefined.
          console.error('Unable to extract source code URL from YAML header:', section);
      }
  } 

  // Split the remaining content into sections based on the YAML header and delimiter.
  const delim = new RegExp(`\\n+${sectionDelimiter}+\\s+`);
  const sections = documentContent
      .replace(yamlHeader ? yamlHeader[0] : '', '')
      .split(delim);

  // Debug
  printSectionizedDocument(sections, documentationUrl);

  return { sections: sections, urlPath: documentationUrl };
}

async function getAFrameRepo(octokit: any) {
  try {
    const response = octokit.request('GET /repos/:owner/:repo', {
      owner: 'aframevr',
      repo: 'aframe'
    });

    return response
  } catch (error) {
    console.error("Error:", error);
  }
}
  
/**
 * Retrieves, processes, and stores all documents on a GitHub repository to a
 * pgvector in Supabase. Currently only supports Markdown (.MD) files.
 *
 * @param {string} params - 
 */
export async function vectorizeDocuments(
  params: ProcessDocsParams
): Promise<void> {
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
      sourceDocumentationUrl
    } = params
    console.log('test1', repoOwner, repoName, pathToRepoDocuments)
    // Fetch the documentation directories or files.
    // let response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
    //   owner: repoOwner,
    //   repo: repoName,
    //   path: pathToRepoDocuments,
    //   headers: {
    //     'X-GitHub-Api-Version': '2022-11-28'
    //   }
    // });
    let response = await getAFrameRepo(octokit)
    console.log('response')

    response.data = Array.isArray(response.data) ? response.data : [response.data];
    console.log('test2')
    // Process documents in each directory.
    for (const resData of response.data) {
      let dirDocuments: any[] = [];
      if (resData.type == 'dir') {
        // Fetch all files from the directory.
        response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
          owner: repoOwner,
          repo: repoName,
          path: pathToRepoDocuments + "/" + resData.name,
          headers: {
            'X-GitHub-Api-Version': '2022-11-28'
          }
        })

      // Type assertion for response.data
      const documentsArray = response.data as any[];

      dirDocuments = documentsArray.filter((document) => 
        document.name.endsWith(`.${documentationFileExt}`)
      );
      } else if (resData.type == 'file') {
        dirDocuments = [resData];
      } else {
        throw new Error('Repository URL does not exist!');
      }
      console.log('test3')
      // Retrieve document data for all docs to process.
      await Promise.all(
        dirDocuments.map(async (document) => {
          const contentResponse = await octokit.request('GET {downloadUrl}', {
            downloadUrl: document.download_url,
            headers: {
              'X-GitHub-Api-Version': '2022-11-28' 
            }
          })

          const { sections, urlPath } = sectionizeDocument(
            contentResponse.data,
            sectionDelimiter
          );
          console.log('test4')
          generateEmbeddings(sections, sourceDocumentationUrl + urlPath, supabase, openai);
        })
      );
    }
  } catch (error) {
    console.log('Hit error: ', error)
    console.error('Error fetching data from GitHub API:', error);
  }
}
  
/**
 * Retrieves and processes a list of all documentation documents modified from a pull request.
 * 
 * @param {string} params - 
 * @param {string} pullRequestNum - 
 */
export async function fetchLatestPullRequest(
  params: ProcessDocsParams,
  pullRequestNum: string
): Promise<void> {
  try {
    const {
      octokit,
      repoOwner,
      repoName,
      pathToRepoDocuments
    } = params

    let page = 1;

    while (true) {
      const response = await octokit.request('GET repos/{owner}/{repo}/pulls', {
        owner: repoOwner,
        repo: repoName,
        pull_number: parseInt(pullRequestNum),
        per_page: 100,
        page: page,
        headers: {
          'X-GitHub-Api-Version': '2022-11-28'
        }
      })

      if (response.data.length > 0) {
        await Promise.all(response.data.map(async (filePath: any) => {
          if (filePath.filename.includes(`${pathToRepoDocuments}/`)) {
            await vectorizeDocuments(params);
          }
        }));
        page++;
      } else {
        // No more files, exit the loop
        break;
      }
    }
  } catch (error) {
    console.error('Error fetching data from GitHub API:', error);
  }
}
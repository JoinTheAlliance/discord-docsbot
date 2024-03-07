import { PostgrestSingleResponse } from '@supabase/supabase-js';

/**
 * @description Updates the message content based on prior prompt knowledge from documents.
 * @param priorPromptKnowledgeFromDocs The prior knowledge obtained from documents.
 * @param message The message content to be updated.
 * @returns The updated message content with a prompt header if prior knowledge exists, otherwise null.
 */
export async function updateMessageContent(
  priorPromptKnowledgeFromDocs: PostgrestSingleResponse<unknown> | null,
  message: string | unknown[],
) {
  try {
    console.log('Message coming into updateMessageContent: ', message);
    const uniqueUrls: Set<string> = new Set();

    console.log('priorPromptKnowledgeFromDocs: ', priorPromptKnowledgeFromDocs);
    let promptHeader = '';

    promptHeader +=
      'From now on, you are an assistant that is only knowledgeable on the A-Frame web framework (https://aframe.io/). If any question is not related to A-Frame, give me a standardized response that tells me you only assist with A-Frame related questions.';

    // Add users question
    promptHeader += `Question: ${message}`;

    // if (priorPromptKnowledgeFromDocs?.data?.length > 0) {
    //promptHeader += 'Information to help answer question: ';
    if (priorPromptKnowledgeFromDocs?.data) {
      for (const obj of priorPromptKnowledgeFromDocs.data as unknown as Array<{
        content: string;
        sourceurl: string;
      }>) {
        const documentWithoutNewlines = obj.content.replace(/\n/g, ' ');
        promptHeader += documentWithoutNewlines;
        // console.log('URLS: ', obj.sourceurl);
        uniqueUrls.add(obj.sourceurl);
      }
    }

    // }
    // const userQuestionLength = message.length;
    const remainingLength = 2000 - message.length;
    //promptHeader = promptHeader.substring(0, remainingLength);

    console.log('Message Content Original: ', message);
    console.log('Message Content New: ', promptHeader);
    const sourceUrls: string[] = Array.from(uniqueUrls);
    const trimmedPromptHeader = promptHeader.substring(0, remainingLength);

    return { promptHeader: trimmedPromptHeader, sourceUrls: sourceUrls };
  } catch (error) {
    console.error('Error updating message content:', error);
    return null;
  }
}

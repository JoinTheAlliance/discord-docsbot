/**
 * @description Updates the message content based on prior prompt knowledge from documents.
 * @param priorPromptKnowledgeFromDocs The prior knowledge obtained from documents.
 * @param message The message content to be updated.
 * @returns The updated message content with a prompt header if prior knowledge exists, otherwise null.
 */
export async function updateMessageContent(
  priorPromptKnowledgeFromDocs: any,
  message: any,
) {
  try {
    let sourceUrls: Array<string> = [];
    console.log('priorPromptKnowledgeFromDocs: ', priorPromptKnowledgeFromDocs)
    let promptHeader =
      '\nPlease use the following content to help answer the questions the user has: ';
    if (priorPromptKnowledgeFromDocs?.data?.length > 0) {
      for (const obj of priorPromptKnowledgeFromDocs.data) {
        const documentWithoutNewlines = obj.content.replace(/\n/g, ' ');
        promptHeader += documentWithoutNewlines;
        console.log('URLS: ', obj.sourceurl)
        sourceUrls.push(obj.sourceurl)
      }
    }
    const userQuestionLength = message.length;
    const remainingLength = 2000 - userQuestionLength;
    promptHeader = promptHeader.substring(0, remainingLength);
    promptHeader += '\nThe users question is: ' + message;

    console.log('Message Content Original: ', message)
    console.log('Message Content New: ', promptHeader)

    return {promptHeader: promptHeader, sourceUrls: sourceUrls};
  } catch (error) {
    console.error('Error updating message content:', error);
    return null;
  }
}

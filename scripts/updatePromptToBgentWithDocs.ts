/**
 * @description Updates the message content based on prior prompt knowledge from documents.
 * @param priorPromptKnowledgeFromDocs The prior knowledge obtained from documents.
 * @param message The message content to be updated.
 * @returns The updated message content with a prompt header if prior knowledge exists, otherwise null.
 */
export async function updateMessageContent(priorPromptKnowledgeFromDocs: any, message: any) {
    try {
      let promptHeader = "Please use the following content to help answer the questions the user has: ";
      if (priorPromptKnowledgeFromDocs?.data?.length > 0) {
        for (const obj of priorPromptKnowledgeFromDocs.data) {
          const documentWithoutNewlines = obj.content.replace(/\n/g, " ");
          promptHeader += documentWithoutNewlines;
        }
        promptHeader += "\nThe user's question is: " + message;
      }
    
      return promptHeader
    } catch (error: any) {
        console.error('Error updating messge content:', error.message);
      return null;
    }
}